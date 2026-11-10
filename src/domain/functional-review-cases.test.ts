import { describe, expect, it } from "vitest";
import {
  issued,
  qrPage,
  r6,
  scanBatch,
  testActor,
} from "./functional-fixtures";
import { recordBatch, getStudentStatus } from "./logic";
import { prepareSharedScanReview, sharedPageOwners } from "./sharedScan";
import { restoreReviewedPages } from "./recovery";
import { reviseReviewedPage } from "./corrections";
import { sanitizeStateForStorage } from "./persistence";
import { switchClassWorkspace } from "./workspaces";
import { registerDriveArtifact, getStudentArchiveSummary } from "./operations";
import type { AppState, Collection, ScanPage } from "./types";
const pending = (
  sourcePage: number,
  extra: Partial<ScanPage> = {},
): ScanPage => ({
  id: "p" + sourcePage,
  sourcePage,
  status: "unreadable",
  resolution: "pending",
  ...extra,
});
function mixed() {
  const a = issued(),
    b = issued({ title: "別配布物" }).collection;
  return {
    state: { ...a.state, collections: [a.collection, b] },
    a: a.collection,
    b,
  };
}
function collect(
  s: AppState,
  c: Collection,
  pages: ScanPage[],
  id = "A",
  hash = "MIX",
  count = 3,
) {
  return recordBatch(s, scanBatch(c, pages, id, hash, count), pages, testActor);
}
describe("Excel functional receipt review and class-common original", () => {
  it("PF-F170 one mixed PDF shares source identity while each collection accepts different original pages only", () => {
    const f = mixed();
    let s = collect(f.state, f.a, [
      qrPage(f.a, "S01", 1, 1),
      pending(2),
      pending(3),
    ]);
    const pages = [
      qrPage(f.b, "S02", 1, 1),
      qrPage(f.b, "S02", 1, 2),
      pending(3),
    ];
    s = collect(s, f.b, pages, "B");
    expect(s.scanSources).toHaveLength(1);
    expect(new Set(s.batches.map((b) => b.sourceId)).size).toBe(1);
    expect(s.batches).toHaveLength(2);
    expect(s.receipts.map((r) => [r.collectionId, r.sourcePage])).toEqual([
      [f.a.id, 1],
      [f.b.id, 2],
    ]);
    expect(
      s.batches.find((b) => b.id === "B")?.pages[0].handledBy,
    ).toMatchObject({ batchId: "A", collectionId: f.a.id });
    expect(s.batches.find((b) => b.id === "B")?.pages[2].resolution).toBe(
      "pending",
    );
  });
  it("PF-F171 same bytes restore QR-less manual acceptance only with live same-source receipt; replay idempotent", () => {
    const f = issued(),
      pages = [
        pending(1, {
          status: "matched",
          resolution: "accepted",
          manual: true,
          studentId: "S03",
          pageNumber: 1,
          collectionId: f.collection.id,
          versionId: f.collection.versionId,
          reviewReason: testActor.reason,
          reviewedBy: testActor.actor,
        }),
      ];
    const s = collect(f.state, f.collection, pages, "A", "M", 1),
      fresh = [pending(1, { thumbnail: "new-image" })],
      restored = restoreReviewedPages(fresh, s.batches[0], s.receipts, {
        hash: "M",
        collectionId: f.collection.id,
        versionId: f.collection.versionId,
      });
    expect(restored[0]).toMatchObject({
      manual: true,
      studentId: "S03",
      resolution: "accepted",
      thumbnail: "new-image",
    });
    const n = collect(s, f.collection, restored, "new-id", "M", 1);
    expect(n.batches[0].id).toBe("A");
    expect(n.receipts).toEqual(s.receipts);
    expect(
      restoreReviewedPages(fresh, s.batches[0], [], {
        hash: "M",
        collectionId: f.collection.id,
        versionId: f.collection.versionId,
      }),
    ).toEqual(fresh);
  });
  it("PF-F172 same filename different hash creates separate original and does not restore manual history", () => {
    const f = issued(),
      s = collect(
        f.state,
        f.collection,
        [qrPage(f.collection, "S01", 1, 1)],
        "A",
        "H1",
        1,
      ),
      fresh = [pending(1)];
    expect(
      restoreReviewedPages(fresh, s.batches[0], s.receipts, {
        hash: "H2",
        collectionId: f.collection.id,
        versionId: f.collection.versionId,
      }),
    ).toEqual(fresh);
    const batch = {
      ...scanBatch(
        f.collection,
        [qrPage(f.collection, "S01", 1, 1)],
        "B",
        "H2",
        1,
      ),
      fileName: s.batches[0].fileName,
    };
    const n = recordBatch(s, batch, batch.pages, testActor);
    expect(n.scanSources).toHaveLength(2);
    expect(n.batches).toHaveLength(2);
    expect(n.batches[1].pages[0]).toMatchObject({
      status: "duplicate",
      resolution: "pending",
    });
    expect(n.receipts).toEqual(s.receipts);
  });
  it("PF-F173 same-hash page count mismatch rejects without modifying existing source", () => {
    const f = issued(),
      s = collect(f.state, f.collection, [qrPage(f.collection, "S01", 1, 1)]),
      before = structuredClone(s);
    expect(() => collect(s, f.collection, [pending(1)], "B", "MIX", 4)).toThrow(
      /ページ数/,
    );
    expect(s).toEqual(before);
  });
  it("PF-F174 QR-less cross-collection assignment cannot reuse an owned original page and returns owner route", () => {
    const f = mixed(),
      s = collect(f.state, f.a, [qrPage(f.a, "S01", 1, 1)]),
      p = pending(1, {
        status: "matched",
        resolution: "accepted",
        manual: true,
        studentId: "S02",
        pageNumber: 1,
        collectionId: f.b.id,
        versionId: f.b.versionId,
      }),
      n = collect(s, f.b, [p], "B");
    expect(n.receipts).toEqual(s.receipts);
    expect(n.batches.find((b) => b.id === "B")?.pages[0]).toMatchObject({
      resolution: "ignored",
      handledBy: { batchId: "A", collectionId: f.a.id },
    });
    expect(() =>
      reviseReviewedPage(
        n,
        "B",
        1,
        { kind: "reassign", studentId: "S02", pageNumber: 1 },
        testActor,
      ),
    ).toThrow(/元の配布物/);
  });
  it("PF-F175 automatic foreign/spacer exclusion is local; explicit teacher exclusion owns source across collections", () => {
    for (const status of ["foreign", "spacer"] as const) {
      const f = mixed(),
        s = collect(f.state, f.a, [
          pending(1, { status, resolution: "ignored" }),
        ]),
        n = collect(s, f.b, [qrPage(f.b, "S01", 1, 1)], "B");
      expect(n.receipts).toHaveLength(1);
    }
    const f = mixed(),
      s = collect(f.state, f.a, [
        pending(1, {
          resolution: "ignored",
          exclusionScope: "source",
          reviewReason: "不要な紙",
          reviewedBy: testActor.actor,
        }),
      ]),
      n = collect(s, f.b, [qrPage(f.b, "S01", 1, 1)], "B");
    expect(n.receipts).toHaveLength(0);
    expect(
      n.batches.find((b) => b.id === "B")?.pages[0].handledBy?.resolution,
    ).toBe("ignored");
  });
  it("PF-F176 reopening owning exclusion releases dependent aliases and allows legitimate new acceptance", () => {
    const f = mixed();
    let s = collect(f.state, f.a, [
      pending(1, {
        resolution: "ignored",
        exclusionScope: "source",
        reviewReason: "対象外",
        reviewedBy: testActor.actor,
      }),
    ]);
    s = collect(s, f.b, [qrPage(f.b, "S01", 1, 1)], "B");
    s = reviseReviewedPage(s, "A", 1, { kind: "reopen" }, testActor);
    expect(sharedPageOwners(s, "MIX", 3)).toEqual([]);
    const prepared = prepareSharedScanReview(s, [qrPage(f.b, "S01", 1, 1)], {
      hash: "MIX",
      pageCount: 3,
      collectionId: f.b.id,
    });
    expect(prepared.pages[0].resolution).toBe("accepted");
    s = collect(s, f.b, prepared.pages, "B");
    expect(s.receipts).toHaveLength(1);
    expect(s.receipts[0].collectionId).toBe(f.b.id);
  });
  it("PF-F177 identical bytes in another class have separate original identity and receipts", () => {
    const f = issued(),
      first = collect(f.state, f.collection, [
        qrPage(f.collection, "S01", 1, 1),
      ]);
    let second = switchClassWorkspace(first, {
      id: "other-class",
      className: "架空 別組",
      students: r6(),
    });
    const other = issued().collection;
    second = { ...second, collections: [other] };
    second = collect(second, other, [qrPage(other, "S01", 1, 1)], "B");
    expect(second.receipts).toHaveLength(1);
    expect(second.scanSources?.[0].id).not.toBe(first.scanSources?.[0].id);
    const back = switchClassWorkspace(second, {
      id: first.classId!,
      className: first.className,
    });
    expect(back.receipts).toEqual(first.receipts);
    expect(back.scanSources).toEqual(first.scanSources);
  });
  it("PF-F179 explicit QR-less manual assignment records targeted logical page and audit; other same-name stays untouched", () => {
    const f = issued(),
      p = pending(1, {
        status: "matched",
        resolution: "accepted",
        manual: true,
        studentId: "S03",
        pageNumber: 1,
        collectionId: f.collection.id,
        versionId: f.collection.versionId,
        reviewReason: "紙の氏名と番号で確認",
        reviewedBy: testActor.actor,
      }),
      s = collect(f.state, f.collection, [p], "A", "MAN", 1);
    expect(s.receipts[0]).toMatchObject({
      method: "manual",
      studentId: "S03",
      pageNumber: 1,
      actor: testActor.actor,
    });
    expect(
      s.events.find((e) => e.action === "manual_assignment"),
    ).toMatchObject({ reason: "紙の氏名と番号で確認", actor: testActor.actor });
    expect(getStudentStatus(f.collection, "S03", s.receipts).status).toBe(
      "partial",
    );
    expect(getStudentStatus(f.collection, "S04", s.receipts).status).toBe(
      "uncollected",
    );
  });
  it("PF-F180 invalid manual page numbers remain pending without changing count", () => {
    for (const pageNumber of [0, 3, 1.5]) {
      const f = issued(),
        p = pending(1, {
          status: "matched",
          resolution: "accepted",
          manual: true,
          studentId: "S01",
          pageNumber,
        }),
        s = collect(f.state, f.collection, [p]);
      expect(s.receipts).toHaveLength(0);
      expect(s.batches[0].pages[0].resolution).toBe("pending");
    }
  });
  it("PF-F181 current roster student absent from issuance cannot create token or manual receipt", () => {
    const f = issued({}, r6().slice(0, 2));
    f.state.students = r6();
    const before = structuredClone(f.collection.tokens),
      s = collect(f.state, f.collection, [
        pending(1, {
          status: "matched",
          resolution: "accepted",
          manual: true,
          studentId: "S03",
          pageNumber: 1,
        }),
      ]);
    expect(s.receipts).toHaveLength(0);
    expect(s.collections[0].tokens).toEqual(before);
    expect(s.batches[0].pages[0].resolution).toBe("pending");
  });
  it("PF-F183 explicit pending hold survives exact-hash reanalysis with new image and reviewer metadata", () => {
    const f = issued(),
      page = pending(1, {
        reviewReason: "再スキャン待ち",
        reviewedBy: testActor.actor,
      }),
      s = collect(f.state, f.collection, [page], "A", "H", 1),
      fresh = [pending(1, { thumbnail: "fresh" })];
    const n = restoreReviewedPages(fresh, s.batches[0], s.receipts, {
      hash: "H",
      collectionId: f.collection.id,
      versionId: f.collection.versionId,
    });
    expect(n[0]).toMatchObject({
      resolution: "pending",
      reviewReason: "再スキャン待ち",
      reviewedBy: testActor.actor,
      reason: "再スキャン待ち",
      thumbnail: "fresh",
    });
    expect(s.receipts).toHaveLength(0);
  });
  it("PF-F184 domain rejects new manual matches and replacements without actor or reason atomically", () => {
    const f = issued(),
      p = pending(1, {
        status: "matched",
        resolution: "accepted",
        manual: true,
        studentId: "S01",
        pageNumber: 1,
      }),
      b = scanBatch(f.collection, [p], "MAN", "M", 1);
    for (const context of [
      { actor: "", reason: "理由" },
      { actor: "先生", reason: "" },
    ]) {
      const before = structuredClone(f.state);
      expect(() => recordBatch(f.state, b, [p], context)).toThrow(/理由|操作/);
      expect(f.state).toEqual(before);
    }
    const old = collect(
        f.state,
        f.collection,
        [qrPage(f.collection, "S01", 1, 1)],
        "OLD",
        "OLD",
        1,
      ),
      newPage = qrPage(f.collection, "S01", 1, 1),
      newBatch = scanBatch(f.collection, [newPage], "NEW", "NEW", 1);
    expect(() =>
      recordBatch(old, newBatch, [newPage], {
        replaceReceiptIds: [old.receipts[0].id],
        actor: "先生",
        reason: "",
      }),
    ).toThrow(/理由/);
    expect(old.receipts).toHaveLength(1);
  });
  it("PF-F185 pending reason does not invent a student receipt or missing-person identity", () => {
    const f = issued(),
      s = collect(f.state, f.collection, [
        pending(1, {
          reviewReason: "画像が不鮮明、再スキャン依頼",
          reviewedBy: testActor.actor,
        }),
      ]);
    expect(s.batches[0].pages[0]).toMatchObject({
      sourcePage: 1,
      resolution: "pending",
      reviewReason: "画像が不鮮明、再スキャン依頼",
    });
    expect(s.receipts).toHaveLength(0);
    expect(s.batches[0].pages[0].studentId).toBeUndefined();
  });
  it("PF-F186 exclusion cancellation adds history and releases common original ownership", () => {
    const f = issued(),
      s = collect(f.state, f.collection, [
        pending(1, {
          resolution: "ignored",
          exclusionScope: "source",
          reviewReason: "除外",
          reviewedBy: testActor.actor,
        }),
      ]),
      n = reviseReviewedPage(
        s,
        "A",
        1,
        { kind: "reopen" },
        { ...testActor, reason: "除外を取消" },
      );
    expect(n.events.length).toBeGreaterThan(s.events.length);
    expect(n.events.slice(0, s.events.length)).toEqual(s.events);
    expect(n.batches[0].pages[0]).toMatchObject({
      resolution: "pending",
      reviewReason: "除外を取消",
    });
    expect(sharedPageOwners(n, "MIX", 3)).toHaveLength(0);
  });
  it("PF-F187 reopening accepted p1 withdraws only that receipt and retains p2 with partial status and old receipt audit", () => {
    const f = issued(),
      s = collect(f.state, f.collection, [
        qrPage(f.collection, "S01", 1, 1),
        qrPage(f.collection, "S01", 2, 2),
      ]),
      old1 = s.receipts.find((r) => r.pageNumber === 1)!,
      old2 = s.receipts.find((r) => r.pageNumber === 2)!,
      n = reviseReviewedPage(s, "A", 1, { kind: "reopen" }, testActor);
    expect(n.receipts).toEqual([old2]);
    expect(getStudentStatus(f.collection, "S01", n.receipts)).toMatchObject({
      status: "partial",
      receivedCount: 1,
      missingPages: [1],
    });
    expect(n.events.at(-1)?.before).toContain(old1.id);
  });
  it("PF-F188 reassign to empty target retracts old owner and records new manual receipt at same original page", () => {
    const f = issued(),
      s = collect(f.state, f.collection, [qrPage(f.collection, "S01", 1, 1)]),
      old = s.receipts[0],
      n = reviseReviewedPage(
        s,
        "A",
        1,
        { kind: "reassign", studentId: "S02", pageNumber: 1 },
        testActor,
      );
    expect(n.receipts).toHaveLength(1);
    expect(n.receipts[0]).toMatchObject({
      studentId: "S02",
      method: "manual",
      batchId: "A",
      sourcePage: 1,
    });
    expect(n.receipts[0].id).not.toBe(old.id);
    expect(n.events.at(-1)?.before).toContain(old.id);
    expect(
      getStudentStatus(f.collection, "S01", n.receipts).receivedCount,
    ).toBe(0);
  });
  it("PF-F189 reassignment to occupied logical target rejects atomically", () => {
    const f = issued(),
      s = collect(f.state, f.collection, [
        qrPage(f.collection, "S01", 1, 1),
        qrPage(f.collection, "S02", 1, 2),
      ]),
      before = structuredClone(s);
    expect(() =>
      reviseReviewedPage(
        s,
        "A",
        1,
        { kind: "reassign", studentId: "S02", pageNumber: 1 },
        testActor,
      ),
    ).toThrow(/別の画像/);
    expect(s).toEqual(before);
  });
  it("PF-F190 excluding accepted p1 marks former two-page student PDF stale while retaining artifact and p2", () => {
    const f = issued();
    let s = collect(f.state, f.collection, [
      qrPage(f.collection, "S01", 1, 1),
      qrPage(f.collection, "S01", 2, 2),
    ]);
    s = registerDriveArtifact(s, {
      kind: "student",
      collectionId: f.collection.id,
      studentId: "S01",
      driveFileId: "student-old",
      name: "架空.pdf",
      receiptIds: s.receipts.map((r) => r.id),
    });
    expect(getStudentArchiveSummary(s, f.collection.id, "S01").status).toBe(
      "current",
    );
    const n = reviseReviewedPage(s, "A", 1, { kind: "ignore" }, testActor);
    expect(getStudentArchiveSummary(n, f.collection.id, "S01").status).toBe(
      "stale",
    );
    expect(n.artifacts).toEqual(s.artifacts);
    expect(n.receipts.map((r) => r.pageNumber)).toEqual([2]);
  });
  it("PF-F193 keeping old duplicate excludes new source with reason while preserving old receipt ID", () => {
    const f = issued();
    let s = collect(
      f.state,
      f.collection,
      [qrPage(f.collection, "S01", 1, 1)],
      "A",
      "OLD",
      1,
    );
    const old = s.receipts[0];
    s = collect(
      s,
      f.collection,
      [qrPage(f.collection, "S01", 1, 1)],
      "B",
      "NEW",
      1,
    );
    s = reviseReviewedPage(
      s,
      "B",
      1,
      { kind: "ignore" },
      { ...testActor, reason: "旧記録を採用" },
    );
    expect(s.receipts).toEqual([old]);
    expect(s.batches.find((b) => b.id === "B")?.pages[0]).toMatchObject({
      resolution: "ignored",
      reviewReason: "旧記録を採用",
    });
  });
  it("PF-F194 explicit replacement from another batch preserves historical original and only one current receipt", () => {
    const f = issued(),
      s = collect(
        f.state,
        f.collection,
        [qrPage(f.collection, "S01", 1, 1)],
        "A",
        "OLD",
        1,
      ),
      p = qrPage(f.collection, "S01", 1, 1),
      b = scanBatch(f.collection, [p], "B", "NEW", 1),
      n = recordBatch(s, b, [p], {
        ...testActor,
        replaceReceiptIds: [s.receipts[0].id],
      });
    expect(n.receipts).toHaveLength(1);
    expect(n.receipts[0]).toMatchObject({ batchId: "B", sourcePage: 1 });
    expect(n.batches.find((b) => b.id === "A")?.pages[0].resolution).toBe(
      "ignored",
    );
    const event = n.events.find((e) => e.action === "replace_receipt")!;
    expect(JSON.parse(event.detail).previous.id).toBe(s.receipts[0].id);
    expect(JSON.parse(event.detail).next.id).toBe(n.receipts[0].id);
  });
  it("PF-F195 replacement within same original marks oldsource1 historical and newsource3 current", () => {
    const f = issued(),
      s = collect(f.state, f.collection, [
        qrPage(f.collection, "S01", 1, 1),
        pending(2),
        pending(3),
      ]),
      p = qrPage(f.collection, "S01", 1, 3),
      n = recordBatch(s, s.batches[0], [p], {
        ...testActor,
        replaceReceiptIds: [s.receipts[0].id],
      });
    expect(n.receipts).toHaveLength(1);
    expect(n.receipts[0].sourcePage).toBe(3);
    expect(n.batches[0].pages.find((p) => p.sourcePage === 1)?.resolution).toBe(
      "ignored",
    );
    expect(n.batches[0].pages.find((p) => p.sourcePage === 3)?.resolution).toBe(
      "accepted",
    );
  });
  it("PF-F196 stale replacement receipt ID rejects without overwriting new current evidence", () => {
    const f = issued(),
      s = collect(f.state, f.collection, [qrPage(f.collection, "S01", 1, 1)]),
      before = structuredClone(s),
      p = qrPage(f.collection, "S01", 1, 2);
    expect(() =>
      recordBatch(s, s.batches[0], [p], {
        replaceReceiptIds: ["stale-receipt"],
      }),
    ).toThrow(/見つかりません/);
    expect(s).toEqual(before);
  });
  it("PF-F197 mismatched replacement version, student and page reject atomically", () => {
    for (const patch of [
      { versionId: "other-version" },
      { studentId: "S02" },
      { pageNumber: 2 },
    ]) {
      const f = issued(),
        s = collect(f.state, f.collection, [qrPage(f.collection, "S01", 1, 1)]),
        before = structuredClone(s),
        p = { ...qrPage(f.collection, "S01", 1, 2), ...patch };
      expect(() =>
        recordBatch(s, s.batches[0], [p], {
          replaceReceiptIds: [s.receipts[0].id],
        }),
      ).toThrow(/一致/);
      expect(s).toEqual(before);
    }
  });
  it("PF-F198 recordBatch cannot silently ignore or reassign already accepted source; audited correction required", () => {
    const f = issued(),
      s = collect(f.state, f.collection, [qrPage(f.collection, "S01", 1, 1)]);
    for (const p of [
      pending(1, { resolution: "ignored" }),
      qrPage(f.collection, "S02", 1, 1),
    ]) {
      const n = recordBatch(s, s.batches[0], [p], testActor);
      expect(n.receipts).toEqual(s.receipts);
      expect(n.batches[0].pages[0]).toEqual(s.batches[0].pages[0]);
    }
    expect(
      reviseReviewedPage(s, "A", 1, { kind: "ignore" }, testActor).receipts,
    ).toHaveLength(0);
  });
  it("PF-F219 legacy per-collection views migrate to one source without ID changes or duplicate ownership", () => {
    const f = mixed();
    let s = collect(f.state, f.a, [qrPage(f.a, "S01", 1, 1)]);
    s = collect(s, f.b, [qrPage(f.b, "S02", 1, 2)], "B");
    const ids = s.batches.map((b) => b.id);
    s.scanSources = undefined;
    s.batches = s.batches.map(({ sourceId: _s, ...b }) => b);
    const n = collect(s, f.b, [qrPage(f.b, "S02", 1, 2)], "NEW");
    expect(n.batches.map((b) => b.id).sort()).toEqual(ids.sort());
    expect(n.scanSources).toHaveLength(1);
    expect(new Set(n.batches.map((b) => b.sourceId)).size).toBe(1);
    const replay = collect(n, f.b, [qrPage(f.b, "S02", 1, 2)], "NEWER");
    expect(replay.receipts).toEqual(n.receipts);
    expect(replay.scanSources).toEqual(n.scanSources);
    expect(
      collect(replay, f.b, [qrPage(f.b, "S03", 1, 1)], "NEWEST").receipts,
    ).toHaveLength(2);
  });
  it("PF-F226 restore rejects invalid source hash, source reference and handledBy route rather than accepting damaged backup", () => {
    const f = mixed();
    let s = collect(f.state, f.a, [qrPage(f.a, "S01", 1, 1)]);
    s = collect(s, f.b, [qrPage(f.b, "S02", 1, 1)], "B");
    expect(sanitizeStateForStorage(s)).not.toBeNull();
    for (const mutate of [
      (n: AppState) => {
        n.batches[0].sourceId = "missing";
      },
      (n: AppState) => {
        n.scanSources![0].hash = "other";
      },
      (n: AppState) => {
        n.batches[1].pages[0].handledBy!.batchId = "missing";
      },
      (n: AppState) => {
        n.batches[1].pages[0].handledBy!.collectionId = f.b.id;
      },
    ]) {
      const n = structuredClone(s);
      mutate(n);
      expect(sanitizeStateForStorage(n)).toBeNull();
    }
    expect(s.receipts).toHaveLength(1);
  });
});
