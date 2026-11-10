import { describe, expect, it } from "vitest";
import { createCollection, getStudentStatus, recordBatch } from "./logic";
import { createInitialState } from "./seed";
import { sanitizeStateForStorage } from "./persistence";
import { reviseReviewedPage } from "./corrections";
import {
  createRevision,
  restoreSeatLayout,
  saveSeatLayout,
  setCollectionStatus,
  setRecipientRequirement,
} from "./workflows";
import {
  beginSaveOperation,
  getStudentArchiveSummary,
  markDriveArtifactMissing,
  registerDriveArtifact,
  reserveOperationFile,
  updateSaveOperation,
} from "./operations";
import { switchClassWorkspace, syncClassRoster } from "./workspaces";
import type { ScanBatch, ScanPage } from "./types";

const context = {
  actor: "teacher@example.test",
  reason: "紙と名簿を確認して訂正",
};
function fixture() {
  const base = createInitialState();
  const students = base.students.slice(0, 2);
  const collection = createCollection(
    {
      title: "確認票",
      className: base.className,
      pageCount: 2,
      requiredPages: [1, 2],
      qrCorner: "top-right",
      order: "row",
      reverse: false,
      duplex: false,
    },
    students,
  );
  const token = collection.tokens.find(
    (token) => token.studentId === students[0].id && token.pageNumber === 1,
  )!;
  const page: ScanPage = {
    ...token,
    id: "page-1",
    sourcePage: 1,
    status: "matched",
    resolution: "accepted",
  };
  const batch: ScanBatch = {
    id: "batch-1",
    hash: "hash-1",
    fileName: "scan.pdf",
    pageCount: 1,
    createdAt: "2026-11-09T00:00:00Z",
    collectionId: collection.id,
    pages: [page],
  };
  const state = recordBatch(
    { ...base, students, collections: [collection] },
    batch,
    [page],
    context,
  );
  return { state, collection: state.collections[0], students, batch, page };
}

describe("strict metadata reference recovery", () => {
  it("keeps a valid old-style snapshot and all added workflow metadata", () => {
    let { state, collection } = fixture();
    expect(sanitizeStateForStorage(state)).not.toBeNull();
    state = saveSeatLayout(
      state,
      { rows: 2, cols: 5, blockedCells: [{ row: 1, col: 4 }] },
      context,
    );
    state = beginSaveOperation(state, {
      collectionId: collection.id,
      batchId: "batch-1",
      storageMode: "drive",
    }).state;
    state = switchClassWorkspace(state, {
      id: "class-b",
      className: "2年B組",
      students: [],
    });
    const restored = sanitizeStateForStorage(state)!;
    expect(restored.savedClasses![0].seatLayouts).toHaveLength(1);
    expect(restored.savedClasses![0].operations).toHaveLength(1);
    expect(restored.savedClasses![0].collections[0].layoutMode).toBe(
      "reserved-corner",
    );
    expect(restored.savedClasses![0].receipts).toHaveLength(1);
  });
  it("rejects orphan sources, out-of-range pages, wrong token assignments and duplicate receipt IDs", () => {
    const { state, collection, students } = fixture();
    expect(sanitizeStateForStorage({ ...state, batches: [] })).toBeNull();
    expect(
      sanitizeStateForStorage({
        ...state,
        receipts: [{ ...state.receipts[0], sourcePage: 2 }],
      }),
    ).toBeNull();
    const otherToken = collection.tokens.find(
      (token) => token.studentId === students[1].id,
    )!.token;
    expect(
      sanitizeStateForStorage({
        ...state,
        receipts: [{ ...state.receipts[0], token: otherToken }],
      }),
    ).toBeNull();
    expect(
      sanitizeStateForStorage({
        ...state,
        receipts: [...state.receipts, state.receipts[0]],
      }),
    ).toBeNull();
    expect(
      sanitizeStateForStorage({
        ...state,
        collections: [{ ...collection, tokens: collection.tokens.slice(1) }],
      }),
    ).toBeNull();
  });
  it("rejects missing accepted receipts and a mismatched manual/QR history", () => {
    const { state } = fixture();
    expect(sanitizeStateForStorage({ ...state, receipts: [] })).toBeNull();
    expect(
      sanitizeStateForStorage({
        ...state,
        receipts: [{ ...state.receipts[0], method: "manual" }],
      }),
    ).toBeNull();
  });
  it("rejects orphan operation/artifact receipts while keeping auditable retired receipts", () => {
    const { state, collection, students } = fixture();
    const operation = beginSaveOperation(state, {
      collectionId: collection.id,
      storageMode: "drive",
      id: "audit-op",
    }).state;
    expect(
      sanitizeStateForStorage({
        ...operation,
        operations: operation.operations!.map((op) => ({
          ...op,
          receiptIds: ["not-a-receipt"],
        })),
      }),
    ).toBeNull();
    const archived = registerDriveArtifact(operation, {
      kind: "student",
      collectionId: collection.id,
      studentId: students[0].id,
      operationId: "audit-op",
      driveFileId: "stored-id",
      name: "a.pdf",
      receiptIds: state.receipts.map((receipt) => receipt.id),
    });
    const corrected = reviseReviewedPage(
      archived,
      "batch-1",
      1,
      { kind: "ignore" },
      context,
    );
    expect(sanitizeStateForStorage(corrected)).not.toBeNull();
    expect(
      sanitizeStateForStorage({
        ...corrected,
        events: corrected.events.filter(
          (event) => !event.action.startsWith("page_"),
        ),
      }),
    ).toBeNull();
    expect(
      sanitizeStateForStorage({
        ...archived,
        artifacts: archived.artifacts!.map((artifact) => ({
          ...artifact,
          studentId: students[1].id,
        })),
      }),
    ).toBeNull();
  });
});

describe("audited corrections", () => {
  it("moves a mistaken source-page receipt to the correct student and preserves before/after evidence", () => {
    const { state, collection, students } = fixture();
    const corrected = reviseReviewedPage(
      state,
      "batch-1",
      1,
      { kind: "reassign", studentId: students[1].id, pageNumber: 2 },
      context,
    );
    expect(corrected.receipts).toHaveLength(1);
    expect(corrected.receipts[0]).toMatchObject({
      studentId: students[1].id,
      pageNumber: 2,
      method: "manual",
      actor: context.actor,
    });
    expect(
      getStudentStatus(collection, students[0].id, corrected.receipts)
        .receivedCount,
    ).toBe(0);
    const event = corrected.events.at(-1)!;
    expect(event).toMatchObject({
      actor: context.actor,
      reason: context.reason,
      action: "page_reassign",
    });
    expect(JSON.parse(event.before!).receipts[0].id).toBe(state.receipts[0].id);
    expect(sanitizeStateForStorage(corrected)).not.toBeNull();
    expect(state.receipts[0].studentId).toBe(students[0].id);
  });
  it("withdraws an accepted receipt on ignore, and reopens an ignored page without reactivating it", () => {
    const { state } = fixture();
    const ignored = reviseReviewedPage(
      state,
      "batch-1",
      1,
      { kind: "ignore" },
      context,
    );
    expect(ignored.receipts).toEqual([]);
    expect(ignored.batches[0].pages[0].resolution).toBe("ignored");
    const reopened = reviseReviewedPage(
      ignored,
      "batch-1",
      1,
      { kind: "reopen" },
      context,
    );
    expect(reopened.receipts).toEqual([]);
    expect(reopened.batches[0].pages[0].resolution).toBe("pending");
    expect(sanitizeStateForStorage(reopened)).not.toBeNull();
    expect(() =>
      reviseReviewedPage(
        state,
        "batch-1",
        1,
        { kind: "ignore" },
        { ...context, reason: " " },
      ),
    ).toThrow();
  });
  it("rejects assignment to an already occupied issued page without deleting either receipt", () => {
    const { state, collection, students } = fixture();
    const token = collection.tokens.find(
      (token) => token.studentId === students[1].id && token.pageNumber === 2,
    )!;
    const page: ScanPage = {
      ...token,
      id: "p2",
      sourcePage: 1,
      status: "matched",
      resolution: "accepted",
    };
    const two = recordBatch(
      state,
      {
        id: "batch-2",
        hash: "h2",
        fileName: "b.pdf",
        pageCount: 1,
        createdAt: "now",
        collectionId: collection.id,
        pages: [page],
      },
      [page],
    );
    expect(() =>
      reviseReviewedPage(
        two,
        "batch-1",
        1,
        { kind: "reassign", studentId: students[1].id, pageNumber: 2 },
        context,
      ),
    ).toThrow(/記録済み/);
    expect(two.receipts).toHaveLength(2);
  });
});

describe("issuance and recipient requirements", () => {
  it("prevents a deleting old edition from superseding the live edition's recipient requirements", () => {
    const { state, collection, students } = fixture();
    const revised = createRevision(state, collection.id, {}, context);
    const issued = setCollectionStatus(
      setCollectionStatus(
        revised.state,
        revised.collection.id,
        "generating",
        context,
      ),
      revised.collection.id,
      "ready",
      context,
    );
    const cases = [
      {
        ...issued,
        cleanupOperations: [
          {
            id: "cleanup",
            collectionIds: [collection.id],
            actor: "teacher",
            reason: "古い版を整理",
            createdAt: "now",
            status: "failed" as const,
            files: [],
          },
        ],
      },
      {
        ...issued,
        collections: issued.collections.map((item) =>
          item.id === collection.id ? { ...item, deletedAt: "now" } : item,
        ),
      },
      {
        ...issued,
        collections: issued.collections.map((item) =>
          item.id === collection.id ? { ...item, archivedAt: "now" } : item,
        ),
      },
    ];
    for (const blocked of cases) {
      const before = structuredClone(blocked);
      expect(() =>
        setRecipientRequirement(
          blocked,
          collection.id,
          students[0].id,
          "required",
          context,
        ),
      ).toThrow(/整理・削除/);
      expect(() =>
        setRecipientRequirement(
          blocked,
          collection.id,
          students[0].id,
          "exempt",
          context,
        ),
      ).toThrow(/整理・削除/);
      expect(blocked).toEqual(before);
      expect(
        blocked.collections.find((item) => item.id === revised.collection.id)!
          .recipientStates![students[0].id],
      ).toBe("required");
    }
  });
  it("disables tokens until issue completion and reactivates the same tokens when ready", () => {
    const { state, collection, batch, page } = fixture();
    const ready = {
      ...state,
      collections: [{ ...collection, status: "ready" as const }],
    };
    const generating = setCollectionStatus(
      ready,
      collection.id,
      "generating",
      context,
    );
    expect(
      generating.collections[0].tokens.every((token) => token.active === false),
    ).toBe(true);
    expect(() => recordBatch(generating, batch, [page])).toThrow(/回収受付/);
    expect(() =>
      reviseReviewedPage(
        generating,
        batch.id,
        1,
        { kind: "reassign", studentId: page.studentId!, pageNumber: 1 },
        context,
      ),
    ).toThrow(/発行/);
    const published = setCollectionStatus(
      generating,
      collection.id,
      "ready",
      context,
    );
    expect(
      published.collections[0].tokens.every((token) => token.active === true),
    ).toBe(true);
    expect(published.collections[0].tokens.map((token) => token.token)).toEqual(
      collection.tokens.map((token) => token.token),
    );
    const closed = setCollectionStatus(
      published,
      collection.id,
      "closed",
      context,
    );
    expect(
      closed.collections[0].tokens.every((token) => token.active === true),
    ).toBe(true);
    expect(() => recordBatch(closed, batch, [page])).toThrow(/回収受付/);
  });
  it("keeps a document origin unless a revision explicitly replaces or clears it", () => {
    const original = fixture();
    const state = {
      ...original.state,
      collections: [{ ...original.collection, sourceDocumentId: "old-doc" }],
    };
    expect(
      createRevision(state, original.collection.id, {}, context).collection
        .sourceDocumentId,
    ).toBe("old-doc");
    expect(
      createRevision(
        state,
        original.collection.id,
        { sourceDocumentId: "new-doc" },
        context,
      ).collection.sourceDocumentId,
    ).toBe("new-doc");
    expect(
      createRevision(
        state,
        original.collection.id,
        { sourceDocumentId: undefined },
        context,
      ).collection.sourceDocumentId,
    ).toBeUndefined();
  });
  it("isolates revised paper, keeps historic evidence, and lets a teacher explicitly accept the old version", () => {
    const { state, collection, students } = fixture();
    const revised = createRevision(
      state,
      collection.id,
      { title: "訂正版" },
      context,
    );
    expect(revised.collection.versionId).not.toBe(collection.versionId);
    expect(revised.collection.logicalCollectionId).toBe(collection.id);
    expect(revised.collection.revision).toBe(2);
    expect(revised.collection.status).toBe("draft");
    expect(
      getStudentStatus(
        revised.state.collections.find((c) => c.id === collection.id)!,
        students[0].id,
        revised.state.receipts,
      ).status,
    ).toBe("partial");
    expect(
      revised.collection.tokens.every((token) => token.active === false),
    ).toBe(true);
    expect(sanitizeStateForStorage(revised.state)).not.toBeNull();
    const generating = setCollectionStatus(
      revised.state,
      revised.collection.id,
      "generating",
      context,
    );
    expect(
      getStudentStatus(
        generating.collections.find((c) => c.id === collection.id)!,
        students[0].id,
        generating.receipts,
      ).status,
    ).toBe("partial");
    const issued = setCollectionStatus(
      generating,
      revised.collection.id,
      "ready",
      context,
    );
    expect(
      getStudentStatus(
        issued.collections.find((c) => c.id === collection.id)!,
        students[0].id,
        issued.receipts,
      ).status,
    ).toBe("superseded");
    expect(
      getStudentStatus(
        issued.collections.find((c) => c.id === revised.collection.id)!,
        students[0].id,
        issued.receipts,
      ).status,
    ).toBe("uncollected");
    expect(issued.collections[0].pendingRevision).toBe(false);
    expect(sanitizeStateForStorage(issued)).not.toBeNull();
    const acceptedOld = setRecipientRequirement(
      issued,
      collection.id,
      students[0].id,
      "required",
      context,
    );
    expect(
      acceptedOld.collections.find((c) => c.id === revised.collection.id)!
        .recipientStates![students[0].id],
    ).toBe("superseded");
    expect(acceptedOld.receipts).toEqual(state.receipts);
    const reprinted = setCollectionStatus(
      setCollectionStatus(
        acceptedOld,
        revised.collection.id,
        "generating",
        context,
      ),
      revised.collection.id,
      "ready",
      context,
    );
    expect(
      reprinted.collections.find((c) => c.id === collection.id)!
        .recipientStates![students[0].id],
    ).toBe("required");
    expect(sanitizeStateForStorage(acceptedOld)).not.toBeNull();
  });
  it("shows an exemption without deleting received evidence, and can require the same recipient again", () => {
    const { state, collection, students } = fixture();
    const exempt = setRecipientRequirement(
      state,
      collection.id,
      students[0].id,
      "exempt",
      context,
    );
    expect(
      getStudentStatus(exempt.collections[0], students[0].id, exempt.receipts),
    ).toMatchObject({ status: "exempt", missingPages: [] });
    const required = setRecipientRequirement(
      exempt,
      collection.id,
      students[0].id,
      "required",
      context,
    );
    expect(
      getStudentStatus(
        required.collections[0],
        students[0].id,
        required.receipts,
      ).status,
    ).toBe("partial");
  });
  it("enforces status transitions and refuses recording to a closed collection", () => {
    const { state, collection, batch, page } = fixture();
    const closed = setCollectionStatus(state, collection.id, "closed", context);
    expect(() => recordBatch(closed, batch, [page])).toThrow(/回収受付/);
    expect(() =>
      setCollectionStatus(closed, collection.id, "draft", context),
    ).toThrow();
    expect(
      setCollectionStatus(closed, collection.id, "collecting", context)
        .collections[0].status,
    ).toBe("collecting");
  });
});

describe("durable save operations and artifact freshness", () => {
  it("preserves one operation and preallocated file ID on retry; record-only never becomes archive", () => {
    const { state, collection } = fixture();
    const started = beginSaveOperation(state, {
      collectionId: collection.id,
      batchId: "batch-1",
      storageMode: "drive",
      id: "op",
    });
    const planned = reserveOperationFile(
      started.state,
      "op",
      "student-a",
      "file-id",
    );
    expect(
      beginSaveOperation(planned, {
        collectionId: collection.id,
        batchId: "batch-1",
        storageMode: "drive",
        id: "op",
      }).state,
    ).toBe(planned);
    expect(() =>
      reserveOperationFile(planned, "op", "student-a", "different"),
    ).toThrow();
    expect(() =>
      reserveOperationFile(planned, "op", "student-b", "file-id"),
    ).toThrow();
    const recordOnly = beginSaveOperation(state, {
      collectionId: collection.id,
      storageMode: "record-only",
      id: "record",
    });
    expect(() =>
      updateSaveOperation(recordOnly.state, "record", {
        archiveStatus: "saving",
      }),
    ).toThrow();
    expect(() =>
      updateSaveOperation(planned, "op", { archiveStatus: "saved" }),
    ).toThrow();
  });
  it("keeps records committed on archive failure and uses exact adopted receipt IDs for current PDF status", () => {
    const { state, collection, students } = fixture();
    let saved = beginSaveOperation(state, {
      collectionId: collection.id,
      batchId: "batch-1",
      storageMode: "drive",
      id: "op",
    }).state;
    saved = updateSaveOperation(saved, "op", { recordStatus: "recorded" });
    saved = updateSaveOperation(saved, "op", {
      archiveStatus: "failed",
      error: "通信切断",
    });
    expect(saved.receipts).toEqual(state.receipts);
    expect(() =>
      updateSaveOperation(saved, "op", { recordStatus: "failed" }),
    ).toThrow();
    saved = registerDriveArtifact(saved, {
      kind: "student",
      collectionId: collection.id,
      studentId: students[0].id,
      operationId: "op",
      driveFileId: "pdf-old",
      name: "a.pdf",
      receiptIds: state.receipts.map((r) => r.id),
    });
    expect(
      getStudentArchiveSummary(saved, collection.id, students[0].id).status,
    ).toBe("current");
    const corrected = reviseReviewedPage(
      saved,
      "batch-1",
      1,
      { kind: "reassign", studentId: students[0].id, pageNumber: 1 },
      context,
    );
    expect(
      getStudentArchiveSummary(corrected, collection.id, students[0].id).status,
    ).toBe("stale");
    expect(sanitizeStateForStorage(corrected)).not.toBeNull();
    const delayed = registerDriveArtifact(corrected, {
      kind: "student",
      collectionId: collection.id,
      studentId: students[0].id,
      operationId: "op",
      driveFileId: "pdf-late",
      name: "late.pdf",
      receiptIds: state.receipts.map((r) => r.id),
    });
    expect(
      getStudentArchiveSummary(delayed, collection.id, students[0].id).status,
    ).toBe("stale");
    const current = registerDriveArtifact(delayed, {
      kind: "student",
      collectionId: collection.id,
      studentId: students[0].id,
      driveFileId: "pdf-current",
      name: "new.pdf",
      receiptIds: corrected.receipts.map((r) => r.id),
    });
    expect(
      getStudentArchiveSummary(current, collection.id, students[0].id).artifact
        ?.driveFileId,
    ).toBe("pdf-current");
    expect(
      getStudentArchiveSummary(
        markDriveArtifactMissing(current, "pdf-current"),
        collection.id,
        students[0].id,
      ).status,
    ).toBe("stale");
  });
});

describe("seat history and classroom continuity", () => {
  it("rejects duplicate Classroom identities even when display names and local IDs differ", () => {
    const { state, students } = fixture();
    expect(() =>
      syncClassRoster(
        state,
        [
          { ...students[0], classroomUserId: "same-google-id" },
          { ...students[1], classroomUserId: "same-google-id" },
        ],
        context,
      ),
    ).toThrow(/名簿/);
  });
  it("migrates a legacy Classroom identifier and uses the stable Google ID on subsequent refreshes", () => {
    const { state, students } = fixture();
    const legacy = {
      ...state,
      students: [{ ...students[0], id: "classroom:google-123" }],
    };
    const incoming = {
      id: "new-internal-id",
      classroomUserId: "google-123",
      name: "更新した名前",
      number: 1,
      seat: null,
    };
    const synced = syncClassRoster(legacy, [incoming], context);
    expect(synced.students).toHaveLength(1);
    expect(synced.students[0]).toMatchObject({
      id: "classroom:google-123",
      classroomUserId: "google-123",
      name: "更新した名前",
      number: students[0].number,
      seat: students[0].seat,
    });
    expect(
      syncClassRoster(
        synced,
        [{ ...incoming, id: "another-internal-id" }],
        context,
      ).students,
    ).toEqual(synced.students);
  });
  it("stores immutable layouts and restores positions without reverting edited names or numbers", () => {
    const { state } = fixture();
    const saved = saveSeatLayout(
      state,
      { rows: 2, cols: 5, blockedCells: [{ row: 1, col: 4 }] },
      context,
    );
    const layoutId = saved.seatLayouts![0].id;
    const edited = {
      ...saved,
      students: saved.students.map((s, i) => ({
        ...s,
        name: `改姓${i}`,
        seat: { row: 1, col: i },
      })),
    };
    const restored = restoreSeatLayout(edited, layoutId, context);
    expect(restored.students[0].name).toBe("改姓0");
    expect(restored.students[0].seat).toEqual(state.students[0].seat);
    expect(restored.seatLayouts).toHaveLength(2);
    expect(() =>
      saveSeatLayout(
        state,
        { rows: 1, cols: 5, blockedCells: [{ row: 0, col: 0 }] },
        context,
      ),
    ).toThrow(/通路/);
  });
  it("switches between class snapshots without discarding receipts or settings", () => {
    const { state } = fixture();
    const a = { ...state, classId: "a", settings: { ledgerId: "ledger-a" } };
    const b = switchClassWorkspace(a, {
      id: "b",
      className: "2年B組",
      students: [],
    });
    expect(b.receipts).toEqual([]);
    const back = switchClassWorkspace(b, { id: "a", className: "2年A組" });
    expect(back.receipts).toEqual(a.receipts);
    expect(back.settings?.ledgerId).toBe("ledger-a");
    expect(back.savedClasses?.[0].id).toBe("b");
    expect(sanitizeStateForStorage(back)).not.toBeNull();
  });
  it("syncs by stable IDs, retains withdrawn history, and never merges equal names", () => {
    const { state, students } = fixture();
    const newStudent = {
      id: "new-id",
      name: students[0].name,
      number: 2,
      seat: null,
    };
    const synced = syncClassRoster(
      state,
      [{ ...students[0], name: "改姓した氏名", number: 1 }, newStudent],
      context,
    );
    expect(synced.students.find((s) => s.id === students[0].id)?.number).toBe(
      students[0].number,
    );
    expect(
      synced.students.find((s) => s.id === students[1].id)?.enrollment,
    ).toBe("withdrawn");
    expect(synced.students.find((s) => s.id === "new-id")?.seat).toBeNull();
    expect(synced.collections[0].recipients).toEqual(
      state.collections[0].recipients,
    );
    expect(synced.receipts).toEqual(state.receipts);
  });
});
