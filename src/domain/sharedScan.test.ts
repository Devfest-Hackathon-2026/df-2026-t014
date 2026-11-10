import { describe, expect, it } from "vitest";
import { createInitialState } from "./seed";
import { createCollection, recordBatch } from "./logic";
import { prepareSharedScanReview, sharedPageOwners } from "./sharedScan";
import { reviseReviewedPage } from "./corrections";
import { restoreReviewedPages } from "./recovery";
import { sanitizeStateForStorage } from "./persistence";
import { switchClassWorkspace } from "./workspaces";
import type { AppState, Collection, ScanBatch, ScanPage } from "./types";

const context = { actor: "teacher", reason: "元の紙を確認して対象を訂正" };
function fixture() {
  const initial = createInitialState();
  const students = initial.students.slice(0, 2);
  const settings = {
    className: initial.className,
    pageCount: 1,
    requiredPages: [1],
    qrCorner: "top-right" as const,
    duplex: true,
    order: "row" as const,
    reverse: false,
  };
  const a = createCollection({ ...settings, title: "配布物A" }, students);
  const b = createCollection({ ...settings, title: "配布物B" }, students);
  const state: AppState = { ...initial, students, collections: [a, b] };
  return { state, a, b, students };
}
function page(
  collection: Collection,
  sourcePage: number,
  studentIndex = 0,
): ScanPage {
  const token = collection.tokens.find(
    (token) =>
      token.kind === "content" &&
      token.studentId === collection.recipients[studentIndex].id,
  )!;
  return {
    ...token,
    id: `page-${sourcePage}`,
    sourcePage,
    status: "matched",
    resolution: "accepted",
  };
}
function batch(
  collection: Collection,
  pages: ScanPage[],
  id = "batch-a",
  hash = "same-original",
): ScanBatch {
  return {
    id,
    hash,
    fileName: "scan.pdf",
    pageCount: 3,
    createdAt: "2026-11-10T00:00:00Z",
    collectionId: collection.id,
    pages,
  };
}

describe("class-scoped original scan handoff", () => {
  it("links collection review views to one source and permits only another collection’s unprocessed source pages", () => {
    const { state, a, b } = fixture();
    const first = recordBatch(state, batch(a, [page(a, 1)]), [page(a, 1)]);
    const other = [{ ...page(b, 1), manual: true }, page(b, 2)];
    const prepared = prepareSharedScanReview(first, other, {
      hash: "same-original",
      pageCount: 3,
      collectionId: b.id,
    });
    expect(prepared.sourceId).toBe(first.scanSources![0].id);
    expect(prepared.pages[0]).toMatchObject({
      sourcePage: 1,
      resolution: "ignored",
      handledBy: {
        batchId: "batch-a",
        collectionId: a.id,
        resolution: "accepted",
      },
    });
    expect(prepared.pages[1].resolution).toBe("accepted");
    const second = recordBatch(first, batch(b, other, "batch-b"), other);
    expect(second.scanSources).toHaveLength(1);
    expect(new Set(second.batches.map((batch) => batch.sourceId)).size).toBe(1);
    expect(second.receipts.map((receipt) => receipt.sourcePage).sort()).toEqual(
      [1, 2],
    );
    expect(
      second.receipts.find((receipt) => receipt.sourcePage === 1)!.collectionId,
    ).toBe(a.id);
    expect(sanitizeStateForStorage(second)).not.toBeNull();
    expect(() =>
      reviseReviewedPage(
        second,
        "batch-b",
        1,
        { kind: "reassign", studentId: b.recipients[1].id, pageNumber: 1 },
        context,
      ),
    ).toThrow(/別の配布物/);
  });
  it("preserves explicit global exclusions until the owning review is reopened, without making an alias a new exclusion", () => {
    const { state, a, b } = fixture();
    const excluded: ScanPage = {
      id: "p3",
      sourcePage: 3,
      status: "unknown",
      resolution: "ignored",
      exclusionScope: "source",
      reviewedBy: "teacher",
      reviewReason: "不要な添付紙",
    };
    const first = recordBatch(state, batch(a, [excluded]), [excluded]);
    const incoming = [page(b, 3)];
    const second = recordBatch(first, batch(b, incoming, "batch-b"), incoming);
    expect(second.receipts).toHaveLength(0);
    expect(
      second.batches.find((batch) => batch.id === "batch-b")!.pages[0].handledBy
        ?.resolution,
    ).toBe("ignored");
    const reopened = reviseReviewedPage(
      second,
      "batch-a",
      3,
      { kind: "reopen" },
      context,
    );
    expect(sharedPageOwners(reopened, "same-original", 3)).toEqual([]);
    const fresh = prepareSharedScanReview(reopened, incoming, {
      hash: "same-original",
      pageCount: 3,
      collectionId: b.id,
    });
    expect(fresh.pages[0].resolution).toBe("accepted");
    const completed = recordBatch(
      reopened,
      batch(b, fresh.pages, "batch-b"),
      fresh.pages,
    );
    expect(completed.receipts).toHaveLength(1);
    expect(completed.receipts[0]).toMatchObject({
      collectionId: b.id,
      sourcePage: 3,
    });
    expect(sanitizeStateForStorage(completed)).not.toBeNull();
  });
  it("does not turn automatic foreign/spacer exclusions into class-wide exclusion", () => {
    const { state, a, b } = fixture();
    const automatic: ScanPage[] = [
      { ...page(b, 1), status: "foreign", resolution: "ignored" },
      { id: "spacer", sourcePage: 2, status: "spacer", resolution: "ignored" },
    ];
    const first = recordBatch(state, batch(a, automatic), automatic);
    expect(sharedPageOwners(first, "same-original", 3)).toEqual([]);
    expect(
      prepareSharedScanReview(first, [page(b, 1)], {
        hash: "same-original",
        pageCount: 3,
        collectionId: b.id,
      }).pages[0].resolution,
    ).toBe("accepted");
  });
  it("keeps exact hashes and class workspaces separate and rejects conflicting source metadata", () => {
    const { state, a, b, students } = fixture();
    const first = recordBatch(state, batch(a, [page(a, 1)]), [page(a, 1)]);
    expect(
      prepareSharedScanReview(first, [page(b, 1)], {
        hash: "different-original",
        pageCount: 3,
        collectionId: b.id,
      }).handledPages,
    ).toEqual([]);
    expect(() =>
      prepareSharedScanReview(first, [page(b, 1)], {
        hash: "same-original",
        pageCount: 2,
        collectionId: b.id,
      }),
    ).toThrow(/ページ数/);
    const other = switchClassWorkspace(first, {
      id: "other-class",
      className: "別の組",
      students,
    });
    expect(sharedPageOwners(other, "same-original", 3)).toEqual([]);
    expect(other.savedClasses![0].scanSources).toEqual(first.scanSources);
    expect(
      sanitizeStateForStorage({
        ...first,
        batches: first.batches.map((batch) => ({
          ...batch,
          sourceId: "missing-source",
        })),
      }),
    ).toBeNull();
  });
  it("recognizes legacy per-collection views without erasing their batch or receipt IDs", () => {
    const { state, a, b } = fixture();
    const recorded = recordBatch(state, batch(a, [page(a, 1)]), [page(a, 1)]);
    const legacy = {
      ...recorded,
      scanSources: undefined,
      batches: recorded.batches.map(({ sourceId: _source, ...batch }) => batch),
    };
    const result = recordBatch(legacy, batch(b, [page(b, 2)], "batch-b"), [
      page(b, 2),
    ]);
    expect(result.batches.some((batch) => batch.id === "batch-a")).toBe(true);
    expect(
      result.receipts.find((receipt) => receipt.collectionId === a.id)!.id,
    ).toBe(recorded.receipts[0].id);
    expect(result.scanSources).toHaveLength(1);
    expect(
      result.batches.every(
        (batch) => batch.sourceId === result.scanSources![0].id,
      ),
    ).toBe(true);
  });
  it("does not restore an ignored alias as if it were a teacher decision after the owner releases it", () => {
    const { state, b } = fixture();
    const fresh = [
      page(b, 1),
      page(b, 2, 1),
      {
        id: "p3",
        sourcePage: 3,
        status: "unknown" as const,
        resolution: "pending" as const,
      },
    ];
    const saved = batch(
      b,
      [
        {
          ...fresh[0],
          resolution: "ignored",
          handledBy: {
            batchId: "owner",
            collectionId: "other",
            resolution: "ignored",
          },
        },
        fresh[1],
        fresh[2],
      ],
      "batch-b",
    );
    const restored = restoreReviewedPages(fresh, saved, state.receipts, {
      hash: saved.hash,
      collectionId: b.id,
      versionId: b.versionId,
    });
    expect(restored[0]).toEqual(fresh[0]);
    expect(restored[0].handledBy).toBeUndefined();
  });
  it("blocks correction during deletion while allowing a closed owner to release a page", () => {
    const { state, a } = fixture();
    const recorded = recordBatch(state, batch(a, [page(a, 1)]), [page(a, 1)]);
    const closed = {
      ...recorded,
      collections: recorded.collections.map((c) =>
        c.id === a.id ? { ...c, status: "closed" as const } : c,
      ),
    };
    expect(
      reviseReviewedPage(closed, "batch-a", 1, { kind: "reopen" }, context)
        .receipts,
    ).toHaveLength(0);
    const deleting = {
      ...closed,
      cleanupOperations: [
        {
          id: "cleanup",
          collectionIds: [a.id],
          actor: "teacher",
          reason: "年度整理",
          createdAt: a.createdAt,
          status: "failed" as const,
          files: [],
        },
      ],
    };
    expect(() =>
      reviseReviewedPage(deleting, "batch-a", 1, { kind: "reopen" }, context),
    ).toThrow(/削除中/);
    expect(() =>
      reviseReviewedPage(deleting, "batch-a", 1, { kind: "ignore" }, context),
    ).toThrow(/削除中/);
  });
});
