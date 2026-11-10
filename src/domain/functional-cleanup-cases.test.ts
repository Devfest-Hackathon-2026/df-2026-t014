import { describe, expect, it, vi } from "vitest";
import { issued, qrPage, record, testActor } from "./functional-fixtures";
import {
  archiveCollections,
  unarchiveCollections,
  planCollectionCleanup,
  prepareCollectionCleanup,
  runCollectionCleanup,
  withSchoolYear,
  assertCollectionWritable,
} from "./lifecycle";
import { prepareAdditionalIssue } from "./additionalIssue";
import {
  createRevision,
  setCollectionStatus,
  setRecipientRequirement,
} from "./workflows";
import { recordBatch } from "./logic";
import { sanitizeStateForStorage } from "./persistence";
import { switchClassWorkspace } from "./workspaces";
import { reviseReviewedPage } from "./corrections";
import type { AppState, DriveArtifact } from "./types";
function life() {
  const f = issued(),
    other = issued({ title: "別の配布物" }).collection;
  let s = record(
    f.state,
    f.collection,
    [qrPage(f.collection, "S01", 1, 1), qrPage(f.collection, "S01", 2, 2)],
    "B",
    "HASH",
    2,
  );
  s.collections.push(other);
  const c = s.collections[0];
  c.sourceDriveFileId = "O";
  c.printDriveFileId = "P";
  c.sourceDocumentId = "D";
  s.batches[0].sourceDriveFileId = "R";
  s.settings = {
    ...s.settings,
    ledgerId: "T",
    folderId: "F",
    schoolYear: "2026",
  };
  const artifact = (
    file: string,
    kind: DriveArtifact["kind"] = "student",
  ): DriveArtifact => ({
    id: "artifact-" + file,
    kind,
    collectionId: c.id,
    versionId: c.versionId,
    studentId: kind === "student" ? "S01" : undefined,
    driveFileId: file,
    name: file + ".pdf",
    createdAt: c.createdAt,
    receiptIds: kind === "student" ? s.receipts.map((r) => r.id) : [],
  });
  s.artifacts = [
    artifact("O", "original"),
    artifact("P", "print"),
    artifact("R", "source-scan"),
    artifact("S"),
    artifact("A", "additional-print"),
  ];
  s.artifacts[2].batchId = "B";
  s.operations = [
    {
      id: "save-op",
      collectionId: c.id,
      kind: "archive",
      storageMode: "drive",
      recordStatus: "recorded",
      archiveStatus: "failed",
      receiptIds: s.receipts.map((r) => r.id),
      createdAt: c.createdAt,
      updatedAt: c.createdAt,
      plannedFileIds: { "source:B": "R", pending: "U" },
    },
  ];
  return { s, c, other, artifact };
}
const prep = (s: AppState, id: string) =>
  prepareCollectionCleanup(s, planCollectionCleanup(s, [id]), testActor);
describe("Excel functional cleanup durable plan and safeguards", () => {
  it("PF-F199 archiving changes no lifecycle, tokens, receipts or external files", () => {
    const { s, c } = life(),
      n = archiveCollections(s, [c.id], testActor);
    expect(n.collections[0].archivedAt).toBeTruthy();
    expect(n.collections[0].status).toBe("collecting");
    expect(n.collections[0].tokens).toEqual(c.tokens);
    expect(n.receipts).toEqual(s.receipts);
    expect(n.artifacts).toEqual(s.artifacts);
    expect(n.events.at(-1)?.action).toBe("archive_collections");
  });
  it("PF-F200 unarchive preserves original status and issued IDs", () => {
    const { s, c } = life(),
      a = archiveCollections(s, [c.id], testActor),
      n = unarchiveCollections(a, [c.id], testActor);
    expect(n.collections[0]).toMatchObject({
      id: c.id,
      versionId: c.versionId,
      status: "collecting",
    });
    expect(n.collections[0].archivedAt).toBeUndefined();
    expect(n.collections[0].tokens).toEqual(c.tokens);
    expect(n.receipts).toEqual(s.receipts);
  });
  it("PF-F201 whole-class cleanup scope excludes saved other classes and is not filtered by created year", () => {
    const { s, c, other } = life();
    c.createdAt = "2024-01-01T00:00:00Z";
    const withOther = switchClassWorkspace(s, {
      id: "other-class",
      className: "別組",
      students: s.students,
    });
    withOther.collections = [issued().collection];
    const n = switchClassWorkspace(withOther, {
      id: s.classId!,
      className: s.className,
    });
    const before = structuredClone(n.savedClasses);
    const plan = planCollectionCleanup(
      n,
      n.collections.map((c) => c.id),
    );
    expect(plan.collectionIds.sort()).toEqual([c.id, other.id].sort());
    const archived = archiveCollections(n, plan.collectionIds, testActor);
    expect(archived.savedClasses).toEqual(before);
    expect(archived.collections.every((c) => c.archivedAt)).toBe(true);
  });
  it("PF-F202 year1900/2199 and empty accepted;1899/2200/text/fullwidth rejected", () => {
    const { s } = life();
    for (const year of ["1900", "2199"])
      expect(withSchoolYear(s, year).settings?.schoolYear).toBe(year);
    expect(withSchoolYear(s, "").settings?.schoolYear).toBeUndefined();
    for (const year of ["1899", "2200", "今年", "２０２６"])
      expect(() => withSchoolYear(s, year)).toThrow();
  });
  it("PF-F204 six unique LIFE6 files deduplicate original print raw student unfinished and additional print references", () => {
    const { s, c } = life(),
      plan = planCollectionCleanup(s, [c.id]);
    expect(plan.files.map((f) => f.fileId)).toEqual([
      "A",
      "O",
      "P",
      "R",
      "S",
      "U",
    ]);
    expect(plan.counts).toEqual({
      collections: 1,
      tokens: 12,
      recipients: 6,
      receipts: 2,
      batches: 1,
      pages: 2,
      artifacts: 5,
      operations: 1,
    });
    expect(plan.files.every((f) => f.status === "pending")).toBe(true);
  });
  it("PF-F205 sourceDocs ledger and folder are protected despite accidental PDF artifact aliases", () => {
    const { s, c, artifact } = life();
    s.artifacts!.push(...["D", "T", "F"].map((id) => artifact(id, "print")));
    const plan = planCollectionCleanup(s, [c.id]);
    for (const id of ["D", "T", "F"])
      expect(plan.files.find((f) => f.fileId === id)?.status).toBe("protected");
    expect(plan.files.filter((f) => f.status === "pending")).toHaveLength(6);
  });
  it("PF-F206 original file shared with another live collection is protected", () => {
    const { s, c, other } = life();
    other.sourceDriveFileId = "O";
    expect(
      planCollectionCleanup(s, [c.id]).files.find((f) => f.fileId === "O")
        ?.status,
    ).toBe("protected");
  });
  it("PF-F207 shared original with no direct fileID on second consumer protected until last consumer cleanup", async () => {
    const { s, c, other } = life();
    const secondPage = qrPage(other, "S01", 1, 2);
    s.receipts = s.receipts.filter((r) => r.sourcePage !== 2);
    s.batches[0].pages = s.batches[0].pages.filter((p) => p.sourcePage !== 2);
    const shared = recordBatch(
      s,
      {
        id: "B2",
        collectionId: other.id,
        hash: "HASH",
        pageCount: 2,
        fileName: "mixed.pdf",
        createdAt: c.createdAt,
        pages: [secondPage],
      },
      [secondPage],
      testActor,
    );
    expect(shared.batches[1].sourceDriveFileId).toBeUndefined();
    expect(
      planCollectionCleanup(shared, [c.id]).files.find((f) => f.fileId === "R")
        ?.status,
    ).toBe("protected");
    const p = prep(shared, c.id),
      n = await runCollectionCleanup(p.state, p.operation.id, {
        trashFile: async () => {},
        onCommit: async () => {},
      });
    expect(
      planCollectionCleanup(n, [other.id]).files.find((f) => f.fileId === "R")
        ?.status,
    ).toBe("pending");
  });
  it("PF-F208 saved class reference protects shared file and saved metadata stays unchanged", () => {
    const { s, c, other } = life();
    other.sourceDriveFileId = "O";
    s.collections = [c];
    s.savedClasses = [
      {
        id: "saved-other",
        className: "別組",
        students: s.students,
        collections: [other],
        receipts: [],
        batches: [],
        events: [],
      },
    ];
    const before = structuredClone(s.savedClasses);
    expect(
      planCollectionCleanup(s, [c.id]).files.find((f) => f.fileId === "O")
        ?.status,
    ).toBe("protected");
    expect(s.savedClasses).toEqual(before);
  });
  it("PF-F209 changing files or target tokens after plan invalidates reviewed fingerprint before execution", () => {
    const { s, c, artifact } = life(),
      plan = planCollectionCleanup(s, [c.id]);
    for (const change of [
      (n: AppState) => n.artifacts!.push(artifact("NEW")),
      (n: AppState) => {
        n.collections[0].tokens[0].token = "new-token";
      },
    ]) {
      const n = structuredClone(s);
      change(n);
      expect(() => prepareCollectionCleanup(n, plan, testActor)).toThrow(
        /変更/,
      );
    }
    expect(s.cleanupOperations ?? []).toHaveLength(0);
  });
  it("PF-F210 no trash before durable commit; saved intent disables all tokens before first external action", async () => {
    const { s, c } = life(),
      p = prep(s, c.id),
      trash = vi.fn(async () => {});
    await expect(
      runCollectionCleanup(p.state, p.operation.id, {
        trashFile: trash,
        onCommit: async () => {
          throw Error("commit denied");
        },
      }),
    ).rejects.toThrow("commit denied");
    expect(trash).not.toHaveBeenCalled();
    const order: string[] = [];
    await runCollectionCleanup(p.state, p.operation.id, {
      onCommit: async (n) => {
        order.push("commit");
        expect(n.collections[0].tokens.every((t) => t.active === false)).toBe(
          true,
        );
      },
      trashFile: async (id) => {
        expect(order[0]).toBe("commit");
        order.push(id);
      },
    });
    expect(order[0]).toBe("commit");
    expect(order.filter((x) => x !== "commit")).toHaveLength(6);
  });
  it("PF-F211 planned running failed and deleted targets block all domain write entry points atomically", () => {
    const { s, c } = life(),
      p = prep(s, c.id);
    for (const status of ["planned", "running", "failed", "deleted"] as const) {
      const n = structuredClone(p.state);
      if (status === "deleted")
        n.collections[0].deletedAt = "2026-11-10T01:00:00Z";
      else n.cleanupOperations![0].status = status;
      const before = structuredClone(n);
      expect(() => assertCollectionWritable(n, c.id)).toThrow();
      expect(() => createRevision(n, c.id, {}, testActor)).toThrow();
      expect(() =>
        prepareAdditionalIssue(n, c.id, ["new"], testActor),
      ).toThrow();
      expect(() =>
        setRecipientRequirement(n, c.id, "S01", "required", testActor),
      ).toThrow();
      expect(() => setCollectionStatus(n, c.id, "ready", testActor)).toThrow();
      expect(() =>
        reviseReviewedPage(n, "B", 1, { kind: "ignore" }, testActor),
      ).toThrow();
      expect(() =>
        record(
          n,
          n.collections[0],
          [qrPage(n.collections[0], "S02", 1, 1)],
          "NEW",
          "NEWHASH",
          1,
        ),
      ).toThrow();
      expect(n).toEqual(before);
    }
  });
  it("PF-F212 zero-file cleanup completes logical deletion and tokens disabled without trash call", async () => {
    const f = issued(),
      p = prep(f.state, f.collection.id),
      trash = vi.fn(async () => {}),
      n = await runCollectionCleanup(p.state, p.operation.id, {
        trashFile: trash,
        onCommit: async () => {},
      });
    expect(trash).not.toHaveBeenCalled();
    expect(n.cleanupOperations![0].status).toBe("complete");
    expect(n.collections[0].deletedAt).toBeTruthy();
    expect(n.collections[0].tokens.every((t) => t.active === false)).toBe(true);
    expect(n.events.at(-1)?.action).toBe("complete_collection_cleanup");
  });
  it("PF-F214 failed R retained with successful file states; retry touches only failed file", async () => {
    const { s, c } = life(),
      p = prep(s, c.id),
      calls: string[] = [];
    const first = await runCollectionCleanup(p.state, p.operation.id, {
      onCommit: async () => {},
      trashFile: async (id) => {
        calls.push(id);
        if (id === "R") throw Error("403");
      },
    });
    expect(calls).toEqual(["A", "O", "P", "R", "S", "U"]);
    expect(first.cleanupOperations![0].status).toBe("failed");
    expect(first.collections[0].deletedAt).toBeUndefined();
    expect(
      first.cleanupOperations![0].files.filter((f) => f.status === "trashed"),
    ).toHaveLength(5);
    const retry: string[] = [],
      last = await runCollectionCleanup(first, p.operation.id, {
        onCommit: async () => {},
        trashFile: async (id) => {
          retry.push(id);
        },
      });
    expect(retry).toEqual(["R"]);
    expect(last.cleanupOperations![0].status).toBe("complete");
  });
  it("PF-F215 per-file commit failure stops later files and idempotent retry avoids retranshing already external-trashed file", async () => {
    const { s, c } = life(),
      p = prep(s, c.id),
      actualTrashed = new Set<string>(),
      requests: string[] = [],
      mutations: string[] = [];
    let durable = p.state,
      commits = 0;
    const trash = async (id: string) => {
      requests.push(id);
      if (!actualTrashed.has(id)) {
        actualTrashed.add(id);
        mutations.push(id);
      }
    };
    await expect(
      runCollectionCleanup(p.state, p.operation.id, {
        trashFile: trash,
        onCommit: async (n) => {
          if (++commits === 2)
            throw Error("commit after external action failed");
          durable = structuredClone(n);
        },
      }),
    ).rejects.toThrow(/commit after/);
    expect(requests).toEqual(["A"]);
    expect(durable.cleanupOperations![0].files[0].status).toBe("pending");
    const n = await runCollectionCleanup(durable, p.operation.id, {
      trashFile: trash,
      onCommit: async () => {},
    });
    expect(requests.filter((x) => x === "A")).toHaveLength(2);
    expect(mutations.filter((x) => x === "A")).toHaveLength(1);
    expect(n.cleanupOperations![0].status).toBe("complete");
  });
  it("PF-F216 logical deletion retains receipts batches token mappings and audit in JSON roundtrip", async () => {
    const { s, c } = life(),
      p = prep(s, c.id),
      n = await runCollectionCleanup(p.state, p.operation.id, {
        onCommit: async () => {},
        trashFile: async () => {},
      });
    expect(n.collections[0].deletedAt).toBeTruthy();
    expect(n.receipts).toEqual(s.receipts);
    expect(n.batches).toEqual(s.batches);
    expect(n.collections[0].tokens.map((t) => t.token)).toEqual(
      c.tokens.map((t) => t.token),
    );
    const restored = sanitizeStateForStorage(JSON.parse(JSON.stringify(n)));
    expect(restored).not.toBeNull();
    expect(restored?.collections[0].deletedAt).toBe(n.collections[0].deletedAt);
    expect(restored?.receipts).toEqual(n.receipts);
    expect(restored?.cleanupOperations).toEqual(n.cleanupOperations);
  });
  it("PF-F217 retry upgrades newly shared file to protected and never downgrades old protected file", async () => {
    const { s, c, other } = life();
    other.sourceDriveFileId = "O";
    const p = prep(s, c.id);
    p.state.collections[1].sourceDriveFileId = undefined;
    p.state.collections[1].printDriveFileId = "P";
    const calls: string[] = [],
      n = await runCollectionCleanup(p.state, p.operation.id, {
        onCommit: async () => {},
        trashFile: async (id) => {
          calls.push(id);
        },
      });
    expect(
      n.cleanupOperations![0].files.find((f) => f.fileId === "O")?.status,
    ).toBe("protected");
    expect(
      n.cleanupOperations![0].files.find((f) => f.fileId === "P")?.status,
    ).toBe("protected");
    expect(calls).not.toContain("O");
    expect(calls).not.toContain("P");
  });
  it("PF-F218 completed operation reexecution has no commits/trash/events and pending cleanup cannot unarchive", async () => {
    const { s, c } = life(),
      p = prep(s, c.id);
    expect(() => unarchiveCollections(p.state, [c.id], testActor)).toThrow(
      /未完了/,
    );
    const done = await runCollectionCleanup(p.state, p.operation.id, {
        onCommit: async () => {},
        trashFile: async () => {},
      }),
      commit = vi.fn(async () => {}),
      trash = vi.fn(async () => {});
    expect(
      await runCollectionCleanup(done, p.operation.id, {
        onCommit: commit,
        trashFile: trash,
      }),
    ).toBe(done);
    expect(commit).not.toHaveBeenCalled();
    expect(trash).not.toHaveBeenCalled();
  });
});
