import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { createInitialState } from "./seed";
import { createCollection } from "./logic";
import type { AppState, Collection, DriveArtifact } from "./types";
import {
  archiveCollections,
  unarchiveCollections,
  planCollectionCleanup,
  prepareCollectionCleanup,
  runCollectionCleanup,
  withSchoolYear,
  isCollectionDeleting,
  assertCollectionWritable,
} from "./lifecycle";
import { sanitizeStateForStorage } from "./persistence";
import ArchivePanel from "../ArchivePanel";

const context = {
  actor: "teacher@school.example",
  reason: "年度末の保管期間終了",
};
function fixture() {
  const state = createInitialState();
  state.students = state.students.slice(0, 2);
  const collection = (title: string): Collection => ({
    ...createCollection(
      {
        title,
        className: state.className,
        pageCount: 1,
        requiredPages: [1],
        qrCorner: "top-right",
        duplex: false,
        order: "number",
        reverse: false,
      },
      state.students,
    ),
    status: "ready",
  });
  const first = collection("同意書"),
    second = collection("連絡票");
  const artifact = (
    id: string,
    fileId: string,
    collectionId = first.id,
  ): DriveArtifact => ({
    id,
    kind: "print",
    collectionId,
    driveFileId: fileId,
    name: `${id}.pdf`,
    receiptIds: [],
    createdAt: first.createdAt,
  });
  state.classId = "class-one";
  state.collections = [first, second];
  return { state, first, second, artifact };
}

describe("archive and explicit cleanup", () => {
  it("archives without closing the collection or altering its tokens", () => {
    const { state, first } = fixture();
    const next = archiveCollections(state, [first.id], context);
    expect(next.collections[0].archivedAt).toBeTruthy();
    expect(next.collections[0].status).toBe("ready");
    expect(next.collections[0].tokens).toEqual(first.tokens);
    expect(isCollectionDeleting(next, first.id)).toBe(false);
    expect(() => assertCollectionWritable(next, first.id)).not.toThrow();
    expect(() => assertCollectionWritable(next, "missing")).toThrow(
      /見つかりません/,
    );
    expect(
      unarchiveCollections(next, [first.id], context).collections[0].archivedAt,
    ).toBeUndefined();
    expect(state.collections[0].archivedAt).toBeUndefined();
    expect(withSchoolYear(state, "2026").settings?.schoolYear).toBe("2026");
    expect(() => withSchoolYear(state, "年度末")).toThrow();
  });

  it("deduplicates artifact, original, print and reserved references while preserving shared files", () => {
    const { state, first, second, artifact } = fixture();
    first.sourceDriveFileId = "shared-source";
    second.sourceDriveFileId = "shared-source";
    first.printDriveFileId = "print-pdf";
    first.sourceDocumentId = "original-google-doc";
    state.artifacts = [
      artifact("a", "shared-source"),
      artifact("b", "print-pdf"),
      artifact("c", "print-pdf"),
      artifact("protected-doc", "original-google-doc"),
    ];
    state.operations = [
      {
        id: "operation-one",
        collectionId: first.id,
        kind: "print",
        storageMode: "drive",
        recordStatus: "recorded",
        archiveStatus: "failed",
        receiptIds: [],
        createdAt: first.createdAt,
        updatedAt: first.createdAt,
        plannedFileIds: { print: "print-pdf", extra: "uploaded-before-link" },
      },
    ];
    const plan = planCollectionCleanup(state, [first.id]);
    expect(plan.files).toHaveLength(4);
    expect(
      plan.files.find((file) => file.fileId === "shared-source")?.status,
    ).toBe("protected");
    expect(
      plan.files.find((file) => file.fileId === "original-google-doc")?.status,
    ).toBe("protected");
    expect(
      plan.files
        .filter((file) => file.status === "pending")
        .map((file) => file.fileId),
    ).toEqual(["print-pdf", "uploaded-before-link"]);
  });

  it("protects a source referenced by another saved class", () => {
    const { state, first, second } = fixture();
    first.sourceDriveFileId = "shared-across-classes";
    second.sourceDriveFileId = "shared-across-classes";
    state.collections = [first];
    state.savedClasses = [
      {
        id: "other-class",
        className: "別クラス",
        students: state.students,
        collections: [second],
        receipts: [],
        batches: [],
        events: [],
      },
    ];
    expect(planCollectionCleanup(state, [first.id]).files[0].status).toBe(
      "protected",
    );
  });

  it("stops stale plans and never mutates Drive before durable intent is saved", async () => {
    const { state, first, artifact } = fixture();
    state.artifacts = [artifact("a", "file-a")];
    const plan = planCollectionCleanup(state, [first.id]);
    expect(() =>
      prepareCollectionCleanup(
        {
          ...state,
          artifacts: [...(state.artifacts ?? []), artifact("b", "file-b")],
        },
        plan,
        context,
      ),
    ).toThrow("変更");
    const started = prepareCollectionCleanup(state, plan, context);
    const trashFile = vi.fn();
    await expect(
      runCollectionCleanup(started.state, started.operation.id, {
        trashFile,
        onCommit: async () => {
          throw new Error("Sheets unavailable");
        },
      }),
    ).rejects.toThrow("Sheets unavailable");
    expect(trashFile).not.toHaveBeenCalled();
    expect(
      started.state.collections[0].tokens.every(
        (token) => token.active === false,
      ),
    ).toBe(true);
  });

  it("persists partial failure, resumes only failed files and retains tombstone evidence", async () => {
    const { state, first, second, artifact } = fixture();
    state.artifacts = [artifact("a", "file-a"), artifact("b", "file-b")];
    const started = prepareCollectionCleanup(
      state,
      planCollectionCleanup(state, [first.id]),
      context,
    );
    const commits: AppState[] = [];
    const trash = vi.fn(async (id: string) => {
      if (id === "file-b") throw new Error("permission denied");
    });
    const partial = await runCollectionCleanup(
      started.state,
      started.operation.id,
      {
        trashFile: trash,
        onCommit: async (next) => {
          commits.push(next);
        },
      },
    );
    expect(partial.cleanupOperations![0].status).toBe("failed");
    expect(partial.collections[0].deletedAt).toBeUndefined();
    expect(partial.artifacts![0].deleted).toBe(true);
    expect(commits.length).toBe(4);
    const retry = vi.fn(async () => undefined);
    const complete = await runCollectionCleanup(partial, started.operation.id, {
      trashFile: retry,
      onCommit: async () => undefined,
    });
    expect(retry.mock.calls).toEqual([["file-b"]]);
    expect(complete.collections[0].deletedAt).toBeTruthy();
    expect(complete.collections[0].tokens).toHaveLength(first.tokens.length);
    expect(complete.collections[1]).toEqual(second);
    expect(complete.cleanupOperations![0].status).toBe("complete");
    expect(
      sanitizeStateForStorage(complete)?.cleanupOperations?.[0].status,
    ).toBe("complete");
  });

  it("protects newly shared files when resuming a saved plan", async () => {
    const { state, first, second, artifact } = fixture();
    state.artifacts = [artifact("a", "file-a")];
    const started = prepareCollectionCleanup(
      state,
      planCollectionCleanup(state, [first.id]),
      context,
    );
    const changed = {
      ...started.state,
      collections: started.state.collections.map((collection) =>
        collection.id === second.id
          ? { ...collection, sourceDriveFileId: "file-a" }
          : collection,
      ),
    };
    const trashFile = vi.fn();
    const complete = await runCollectionCleanup(changed, started.operation.id, {
      trashFile,
      onCommit: async () => undefined,
    });
    expect(trashFile).not.toHaveBeenCalled();
    expect(complete.cleanupOperations![0].files[0].status).toBe("protected");
  });

  it("does not re-trash after a final ledger write failure", async () => {
    const { state, first, artifact } = fixture();
    state.artifacts = [artifact("a", "file-a")];
    const started = prepareCollectionCleanup(
      state,
      planCollectionCleanup(state, [first.id]),
      context,
    );
    let persisted = started.state;
    const trashFile = vi.fn(async () => undefined);
    await expect(
      runCollectionCleanup(started.state, started.operation.id, {
        trashFile,
        onCommit: async (next) => {
          if (next.cleanupOperations![0].status === "complete")
            throw new Error("final write lost");
          persisted = next;
        },
      }),
    ).rejects.toThrow("final write lost");
    expect(persisted.collections[0].deletedAt).toBeUndefined();
    expect(persisted.cleanupOperations![0].files[0].status).toBe("trashed");
    const result = await runCollectionCleanup(persisted, started.operation.id, {
      trashFile,
      onCommit: async () => undefined,
    });
    expect(trashFile).toHaveBeenCalledTimes(1);
    expect(result.collections[0].deletedAt).toBeTruthy();
  });

  it("renders a review-only panel without triggering commit or trash", () => {
    const { state, first, artifact } = fixture();
    state.artifacts = [artifact("a", "file-a", first.id)];
    const onCommit = vi.fn();
    const markup = renderToStaticMarkup(
      createElement(ArchivePanel, {
        state,
        busy: false,
        onCommit,
        onError: vi.fn(),
      }),
    );
    expect(markup).toContain("対象の配布物・件数・残すファイルを確認しました");
    expect(markup).toContain("現在のクラス全体");
    expect(onCommit).not.toHaveBeenCalled();
  });
  it("protects a shared scan original before another view has copied its file ID", () => {
    const { state, first, second } = fixture();
    state.scanSources = [
      {
        id: "source-one",
        hash: "same-hash",
        pageCount: 2,
        fileName: "mixed.pdf",
        createdAt: first.createdAt,
      },
    ];
    const common = {
      sourceId: "source-one",
      hash: "same-hash",
      pageCount: 2,
      fileName: "mixed.pdf",
      createdAt: first.createdAt,
      pages: [],
    };
    state.batches = [
      {
        ...common,
        id: "view-a",
        collectionId: first.id,
        sourceDriveFileId: "shared-original",
      },
      { ...common, id: "view-b", collectionId: second.id },
    ];
    expect(planCollectionCleanup(state, [first.id]).files).toEqual([
      expect.objectContaining({
        fileId: "shared-original",
        status: "protected",
      }),
    ]);
    state.collections = state.collections.map((c) =>
      c.id === first.id ? { ...c, deletedAt: first.createdAt } : c,
    );
    expect(planCollectionCleanup(state, [second.id]).files).toEqual([
      expect.objectContaining({ fileId: "shared-original", status: "pending" }),
    ]);
  });
});
