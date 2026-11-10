import { describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { GoogleApiError } from "./google/errors";
import {
  persistCloudState,
  saveCollectionRecord,
  saveIssuedPdf,
  addArchive,
  resumeArchive,
  sourceForBatch,
  hashPdf,
  type CloudContext,
} from "./cloudWorkflow";
import type { AppState, Collection, Receipt } from "./domain/types";
import type { GoogleLedger, GoogleWorkspaceClient } from "./google/client";
import { LEDGER_TABS } from "./google/client";
import { beginSaveOperation, reserveOperationFile } from "./domain/operations";
import {
  planCollectionCleanup,
  prepareCollectionCleanup,
} from "./domain/lifecycle";

async function fixture() {
  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]);
  const bytes = await pdf.save();
  const person = { id: "student", name: "架空生徒", number: 1, seat: null };
  const collection: Collection = {
    id: "collection",
    versionId: "version",
    title: "架空配布物",
    className: "架空クラス",
    dueDate: "",
    createdAt: "2026-11-09T00:00:00Z",
    pageCount: 1,
    requiredPages: [1],
    qrCorner: "top-right",
    duplex: false,
    order: "number",
    reverse: false,
    sourceName: "source.pdf",
    tokens: [
      {
        token: "token",
        collectionId: "collection",
        versionId: "version",
        studentId: "student",
        pageNumber: 1,
        kind: "content",
        required: true,
      },
    ],
    recipients: [person],
    status: "collecting",
    folderId: "collection-folder",
  };
  const receipt: Receipt = {
    id: "receipt",
    collectionId: "collection",
    versionId: "version",
    studentId: "student",
    pageNumber: 1,
    token: "token",
    batchId: "batch",
    sourcePage: 1,
    recordedAt: collection.createdAt,
    method: "qr",
  };
  const state: AppState = {
    schemaVersion: 1,
    classId: "class",
    className: "架空クラス",
    students: [person],
    collections: [collection],
    receipts: [receipt],
    batches: [
      {
        id: "batch",
        hash: await hashPdf(bytes),
        fileName: "scan.pdf",
        pageCount: 1,
        createdAt: collection.createdAt,
        collectionId: "collection",
        pages: [
          {
            id: "page",
            sourcePage: 1,
            status: "matched",
            resolution: "accepted",
            studentId: "student",
            collectionId: "collection",
            versionId: "version",
            pageNumber: 1,
            token: "token",
          },
        ],
      },
    ],
    events: [],
    settings: { googleAccountId: "teacher", folderId: "class-folder" },
  };
  return { state, bytes };
}
function context(bytes: Uint8Array) {
  let serial = 0;
  const writes: AppState[] = [];
  const handle: GoogleLedger = {
    spreadsheetId: "ledger",
    spreadsheetUrl: "https://docs.google.com/spreadsheets/d/ledger/edit",
    schemaVersion: 1,
    accountId: "teacher",
    revisionHash: "old",
    sheets: Object.fromEntries(
      LEDGER_TABS.map((name, index) => [name, index]),
    ) as GoogleLedger["sheets"],
  };
  const client = {
    getIdentity: vi.fn(() => ({
      id: "teacher",
      email: "teacher@example.test",
      name: "Teacher",
    })),
    createFolder: vi.fn(async (name: string) => ({
      id: `folder:${name}`,
      name,
      webViewLink: "https://drive.google.com/",
    })),
    generateFileId: vi.fn(async () => `file-${++serial}`),
    writeLedger: vi.fn(async (_ledger: GoogleLedger, state: AppState) => {
      writes.push(structuredClone(state));
      return {
        revisionHash: `revision-${writes.length}`,
        operationId: "commit",
        recovered: false,
      };
    }),
    uploadPdf: vi.fn(async (options: { fileId?: string; name: string }) => ({
      id: options.fileId!,
      name: options.name,
      webViewLink: "https://drive.google.com/",
    })),
    readLedger: vi.fn(),
    createLedger: vi.fn(),
    downloadPdf: vi.fn(async () => bytes),
  };
  const onState = vi.fn();
  const ctx: CloudContext = {
    client: client as unknown as GoogleWorkspaceClient,
    ledger: handle,
    onLedger: vi.fn(),
    onState,
    scanCache: new Map([["batch", bytes]]),
  };
  return { ctx, client, writes, onState };
}

function attachSharedOriginal(state: AppState) {
  const batch = state.batches[0];
  state.scanSources = [
    {
      id: "shared",
      hash: batch.hash,
      pageCount: batch.pageCount,
      fileName: batch.fileName,
      createdAt: batch.createdAt,
    },
  ];
  batch.sourceId = "shared";
  state.collections.push({
    ...state.collections[0],
    id: "other-collection",
    versionId: "other-version",
    tokens: [],
  });
  state.batches.push({
    ...batch,
    id: "other-view",
    collectionId: "other-collection",
    pages: [],
    sourceDriveFileId: "shared-original",
  });
}

describe("cloud save ordering and interruption", () => {
  it.each(["planned", "running", "failed", "deleted"] as const)(
    "refuses every save entrypoint before Google calls when cleanup is %s",
    async (status) => {
      const { state, bytes } = await fixture();
      const { ctx, client, onState } = context(bytes);
      const started = beginSaveOperation(state, {
        collectionId: "collection",
        batchId: "batch",
        storageMode: "drive",
        kind: "record",
      });
      let blocked = reserveOperationFile(
        started.state,
        started.operation.id,
        "student:student",
        "not-yet-uploaded",
      );
      if (status === "deleted") {
        blocked = {
          ...blocked,
          collections: blocked.collections.map((c) => ({
            ...c,
            deletedAt: c.createdAt,
          })),
        };
      } else {
        blocked = prepareCollectionCleanup(
          blocked,
          planCollectionCleanup(blocked, ["collection"]),
          {
            actor: "teacher",
            reason: "保管期限終了",
          },
        ).state;
        blocked = {
          ...blocked,
          cleanupOperations: blocked.cleanupOperations!.map((op) => ({
            ...op,
            status,
          })),
        };
      }
      await expect(
        saveIssuedPdf(ctx, blocked, blocked.collections[0], bytes, bytes),
      ).rejects.toThrow(/削除/);
      await expect(
        saveCollectionRecord(ctx, blocked, "collection", "batch", true),
      ).rejects.toThrow(/削除/);
      await expect(
        addArchive(ctx, blocked, "collection", "batch"),
      ).rejects.toThrow(/削除/);
      await expect(
        resumeArchive(ctx, blocked, started.operation.id),
      ).rejects.toThrow(/削除/);
      for (const method of Object.values(client))
        expect(method).not.toHaveBeenCalled();
      expect(onState).not.toHaveBeenCalled();
    },
  );

  it("commits record-only mode without generating or uploading any PDF", async () => {
    const { state, bytes } = await fixture(),
      { ctx, client, writes } = context(bytes);
    const result = await saveCollectionRecord(
      ctx,
      state,
      "collection",
      "batch",
      false,
    );
    expect(result.operations?.[0]).toMatchObject({
      recordStatus: "recorded",
      storageMode: "record-only",
      archiveStatus: "not-requested",
    });
    expect(writes).toHaveLength(1);
    expect(client.uploadPdf).not.toHaveBeenCalled();
    expect(client.generateFileId).not.toHaveBeenCalled();
    expect(client.createFolder).not.toHaveBeenCalled();
  });

  it("does not start binary upload if the initial Sheets commit fails", async () => {
    const { state, bytes } = await fixture(),
      { ctx, client } = context(bytes);
    client.writeLedger.mockRejectedValueOnce(new Error("Sheets offline"));
    await expect(
      saveCollectionRecord(ctx, state, "collection", "batch", true),
    ).rejects.toThrow("Sheets offline");
    expect(client.uploadPdf).not.toHaveBeenCalled();
    expect(client.generateFileId).toHaveBeenCalledTimes(2);
  });

  it("preserves committed receipts and resumes only the failed PDF using the planned file ID", async () => {
    const { state, bytes } = await fixture(),
      { ctx, client, writes, onState } = context(bytes);
    client.uploadPdf
      .mockResolvedValueOnce({
        id: "file-1",
        name: "source.pdf",
        webViewLink: "https://drive.google.com/",
      })
      .mockRejectedValueOnce(new Error("upload interrupted"));
    await expect(
      saveCollectionRecord(ctx, state, "collection", "batch", true),
    ).rejects.toThrow("upload interrupted");
    const failed = onState.mock.calls.at(-1)![0] as AppState;
    expect(failed.receipts).toEqual(state.receipts);
    expect(failed.operations?.[0]).toMatchObject({
      recordStatus: "recorded",
      archiveStatus: "failed",
    });
    expect(writes[0].operations?.[0].plannedFileIds).toEqual({
      "source:batch": "file-1",
      "student:student": "file-2",
    });
    const result = await resumeArchive(ctx, failed, failed.operations![0].id);
    expect(result.operations?.[0].archiveStatus).toBe("saved");
    expect(client.uploadPdf.mock.calls.map((call) => call[0].fileId)).toEqual([
      "file-1",
      "file-2",
      "file-2",
    ]);
    expect(client.generateFileId).toHaveBeenCalledTimes(2);
  });

  it("stops before uploading a stale operation whose receipt was withdrawn", async () => {
    const { state, bytes } = await fixture(),
      { ctx, client, onState } = context(bytes);
    client.uploadPdf.mockRejectedValueOnce(new Error("interrupted"));
    await expect(
      saveCollectionRecord(ctx, state, "collection", "batch", true),
    ).rejects.toThrow();
    const failed = onState.mock.calls.at(-1)![0] as AppState;
    const calls = client.uploadPdf.mock.calls.length;
    await expect(
      resumeArchive(ctx, { ...failed, receipts: [] }, failed.operations![0].id),
    ).rejects.toThrow("採用ページが変更");
    expect(client.uploadPdf).toHaveBeenCalledTimes(calls);
  });

  it("requires the exact original scan when restarting a record-only batch", async () => {
    const { state, bytes } = await fixture(),
      { ctx } = context(bytes);
    ctx.scanCache.clear();
    await expect(sourceForBatch(ctx, state, "batch")).rejects.toThrow(
      "原本再選択待ち",
    );
    ctx.scanCache.set("batch", new TextEncoder().encode("different PDF"));
    await expect(sourceForBatch(ctx, state, "batch")).rejects.toThrow(
      "原本と一致しません",
    );
  });

  it("does not adopt a newly read remote revision to overwrite stale local state", async () => {
    const { state, bytes } = await fixture(),
      { ctx, client } = context(bytes);
    state.settings = { ...state.settings, ledgerId: "ledger" };
    const handle = { ...ctx.ledger!, revisionHash: "remote-newer" };
    ctx.ledger = null;
    client.readLedger.mockResolvedValue({
      ledger: handle,
      state: { ...state, className: "remote edit" },
      revisionHash: "remote-newer",
      operationId: "remote",
    });
    await expect(persistCloudState(ctx, state)).rejects.toThrow();
    expect(client.writeLedger).not.toHaveBeenCalled();
  });
  it("reuses a registered same-class original across collection views, including 404 fallback", async () => {
    const { state, bytes } = await fixture();
    const { ctx, client } = context(bytes);
    ctx.scanCache.clear();
    const original = state.batches[0];
    state.scanSources = [
      {
        id: "shared",
        hash: original.hash,
        pageCount: original.pageCount,
        fileName: original.fileName,
        createdAt: original.createdAt,
      },
    ];
    original.sourceId = "shared";
    original.sourceDriveFileId = "missing-copy";
    state.batches.push({
      ...original,
      id: "other-view",
      collectionId: "other-collection",
      sourceDriveFileId: "existing-copy",
    });
    client.downloadPdf
      .mockRejectedValueOnce(new GoogleApiError("API", "missing", 404))
      .mockResolvedValueOnce(bytes);
    expect(await sourceForBatch(ctx, state, original.id)).toEqual(bytes);
    expect(
      client.downloadPdf.mock.calls.map((call) => (call as unknown[])[0]),
    ).toEqual(["missing-copy", "existing-copy"]);
    expect(ctx.scanCache.get(original.id)).toEqual(bytes);
  });
  it.each([401, 403])(
    "stops a shared-original read on %s and rejects bytes with a different hash",
    async (status) => {
      const { state, bytes } = await fixture();
      const { ctx, client } = context(bytes);
      ctx.scanCache.clear();
      const original = state.batches[0];
      state.scanSources = [
        {
          id: "shared",
          hash: original.hash,
          pageCount: original.pageCount,
          fileName: original.fileName,
          createdAt: original.createdAt,
        },
      ];
      original.sourceId = "shared";
      original.sourceDriveFileId = "first-copy";
      state.batches.push({
        ...original,
        id: "other-view",
        collectionId: "other-collection",
        sourceDriveFileId: "second-copy",
      });
      client.downloadPdf.mockRejectedValueOnce(
        new GoogleApiError(
          status === 401 ? "AUTH_EXPIRED" : "API",
          "authorization failure",
          status,
        ),
      );
      await expect(
        sourceForBatch(ctx, state, original.id),
      ).rejects.toMatchObject({ status });
      expect(client.downloadPdf).toHaveBeenCalledTimes(1);
      client.downloadPdf.mockResolvedValueOnce(new Uint8Array([1, 2, 3]));
      await expect(sourceForBatch(ctx, state, original.id)).rejects.toThrow(
        /原本と一致/,
      );
      expect(ctx.scanCache.has(original.id)).toBe(false);
    },
  );

  it("commits a verified shared-original link before allocating a new archive plan", async () => {
    const { state, bytes } = await fixture();
    const { ctx, client, writes } = context(bytes);
    attachSharedOriginal(state);
    const result = await addArchive(ctx, state, "collection", "batch");
    expect(client.downloadPdf).toHaveBeenCalledWith("shared-original");
    expect(writes[0].batches[0].sourceDriveFileId).toBe("shared-original");
    expect(writes[0].operations![0].plannedFileIds).toEqual({});
    expect(client.writeLedger.mock.invocationCallOrder[0]).toBeLessThan(
      client.generateFileId.mock.invocationCallOrder[0],
    );
    expect(result.operations![0].plannedFileIds).toEqual({
      "student:student": "file-1",
    });
    expect(client.uploadPdf).toHaveBeenCalledTimes(1);
    expect(result.operations![0].archiveStatus).toBe("saved");
  });

  it("does not allocate or upload when the shared-source link commit fails", async () => {
    const { state, bytes } = await fixture();
    const { ctx, client } = context(bytes);
    attachSharedOriginal(state);
    client.writeLedger.mockRejectedValueOnce(new Error("Sheets offline"));
    await expect(addArchive(ctx, state, "collection", "batch")).rejects.toThrow(
      "Sheets offline",
    );
    expect(client.generateFileId).not.toHaveBeenCalled();
    expect(client.uploadPdf).not.toHaveBeenCalled();
  });

  it("completes a source-only archive using the verified link without generating a duplicate", async () => {
    const { state, bytes } = await fixture();
    const { ctx, client } = context(bytes);
    attachSharedOriginal(state);
    state.receipts = [];
    state.batches[0].pages = state.batches[0].pages.map((page) => ({
      ...page,
      resolution: "ignored",
    }));
    const result = await addArchive(ctx, state, "collection", "batch");
    expect(result.batches[0].sourceDriveFileId).toBe("shared-original");
    expect(result.operations![0].archiveStatus).toBe("saved");
    expect(client.generateFileId).not.toHaveBeenCalled();
    expect(client.uploadPdf).not.toHaveBeenCalled();
  });

  it("resumes a durable source reservation instead of rewriting it to a later shared original", async () => {
    const { state, bytes } = await fixture();
    const { ctx, client } = context(bytes);
    const started = beginSaveOperation(state, {
      collectionId: "collection",
      batchId: "batch",
      storageMode: "drive",
      kind: "archive",
    });
    const reserved = reserveOperationFile(
      reserveOperationFile(
        started.state,
        started.operation.id,
        "source:batch",
        "durable-source",
      ),
      started.operation.id,
      "student:student",
      "durable-student",
    );
    attachSharedOriginal(reserved);
    const result = await resumeArchive(ctx, reserved, started.operation.id);
    expect(client.downloadPdf).not.toHaveBeenCalled();
    expect(client.generateFileId).not.toHaveBeenCalled();
    expect(client.uploadPdf.mock.calls[0][0].fileId).toBe("durable-source");
    expect(result.operations![0].plannedFileIds).toEqual({
      "source:batch": "durable-source",
      "student:student": "durable-student",
    });
    expect(result.batches[0].sourceDriveFileId).toBe("durable-source");
  });

  it("rejects a shared source if the Google account changes during its verification", async () => {
    const { state, bytes } = await fixture();
    const { ctx, client } = context(bytes);
    attachSharedOriginal(state);
    client.downloadPdf.mockImplementationOnce(async () => {
      client.getIdentity.mockReturnValue({
        id: "other-teacher",
        email: "other@example.test",
        name: "Other",
      });
      return bytes;
    });
    await expect(addArchive(ctx, state, "collection", "batch")).rejects.toThrow(
      "アカウントが変更",
    );
    expect(client.writeLedger).not.toHaveBeenCalled();
    expect(client.generateFileId).not.toHaveBeenCalled();
    expect(client.uploadPdf).not.toHaveBeenCalled();
  });
});

describe("prepared record retry and interrupted shared plan", () => {
  it("PF-G057 retains operation and partial file reservations after allocation fails", async () => {
    const { state, bytes } = await fixture();
    const { ctx, client } = context(bytes);
    let pending = state,
      operationId: string | undefined;
    const commitId = "fixed-commit";
    const onPrepared = (next: AppState, id: string) => {
      pending = next;
      operationId = id;
    };
    client.generateFileId
      .mockResolvedValueOnce("reserved-original")
      .mockRejectedValueOnce(new Error("ID allocation offline"));
    await expect(
      saveCollectionRecord(ctx, state, "collection", "batch", true, {
        commitId,
        onPrepared,
      }),
    ).rejects.toThrow("allocation offline");
    expect(pending.operations![0].plannedFileIds).toEqual({
      "source:batch": "reserved-original",
    });
    const firstOperation = operationId;
    await saveCollectionRecord(ctx, pending, "collection", "batch", true, {
      operationId,
      commitId,
      onPrepared,
    });
    expect(operationId).toBe(firstOperation);
    expect(client.uploadPdf.mock.calls[0][0].fileId).toBe("reserved-original");
  });
  it("resumes an interrupted shared-source plan by committing missing student reservations first", async () => {
    const { state, bytes } = await fixture();
    const { ctx, client, writes } = context(bytes);
    state.batches[0].sourceDriveFileId = "shared-original";
    const started = beginSaveOperation(state, {
      collectionId: "collection",
      batchId: "batch",
      kind: "archive",
      storageMode: "drive",
    });
    const result = await resumeArchive(
      ctx,
      started.state,
      started.operation.id,
    );
    expect(writes[0].operations![0].plannedFileIds).toEqual({
      "student:student": "file-1",
    });
    expect(client.uploadPdf).toHaveBeenCalledOnce();
    expect(client.writeLedger.mock.invocationCallOrder[0]).toBeLessThan(
      client.uploadPdf.mock.invocationCallOrder[0],
    );
    expect(result.operations![0].archiveStatus).toBe("saved");
  });
});

describe("PF-G063 later archive idempotence", () => {
  it("PF-G063 reuses the same source-required plan after selecting the original again", async () => {
    const { state, bytes } = await fixture();
    const { ctx, client, onState } = context(bytes);
    ctx.scanCache.clear();
    await expect(addArchive(ctx, state, "collection", "batch")).rejects.toThrow(
      "原本再選択",
    );
    const failed = onState.mock.calls.at(-1)![0] as AppState;
    const operation = failed.operations![0];
    expect(operation.archiveStatus).toBe("source-required");
    const generated = client.generateFileId.mock.calls.length;
    ctx.scanCache.set("batch", bytes);
    const result = await addArchive(ctx, failed, "collection", "batch");
    expect(result.operations).toHaveLength(1);
    expect(result.operations![0].id).toBe(operation.id);
    expect(result.operations![0].plannedFileIds).toEqual(
      operation.plannedFileIds,
    );
    expect(result.operations![0].archiveStatus).toBe("saved");
    expect(client.generateFileId).toHaveBeenCalledTimes(generated);
    const uploads = client.uploadPdf.mock.calls.length;
    const again = await addArchive(ctx, result, "collection", "batch");
    expect(again).toBe(result);
    expect(client.uploadPdf).toHaveBeenCalledTimes(uploads);
  });
  it("PF-G063 a legacy abandoned plan cannot duplicate another completed archive of the same receipts", async () => {
    const { state, bytes } = await fixture();
    const { ctx, client } = context(bytes);
    const completed = await addArchive(ctx, state, "collection", "batch");
    const obsolete = beginSaveOperation(completed, {
      collectionId: "collection",
      batchId: "batch",
      kind: "archive",
      storageMode: "drive",
    });
    const old = reserveOperationFile(
      obsolete.state,
      obsolete.operation.id,
      "source:batch",
      "obsolete-file",
    );
    const calls = client.uploadPdf.mock.calls.length;
    await expect(
      resumeArchive(ctx, old, obsolete.operation.id),
    ).rejects.toThrow("別の保管操作で保存済み");
    expect(client.uploadPdf).toHaveBeenCalledTimes(calls);
    expect(
      (await addArchive(ctx, old, "collection", "batch")).operations,
    ).toHaveLength(2);
    expect(client.uploadPdf).toHaveBeenCalledTimes(calls);
  });
});

describe("PF-G067 multiple original reconstruction", () => {
  it("PF-G067 missing second day is named and merge waits for both exact originals in logical order", async () => {
    const { state, bytes } = await fixture();
    const { ctx } = context(bytes);
    const first = await PDFDocument.create();
    first.addPage([100, 200]);
    const a = await first.save();
    const second = await PDFDocument.create();
    second.addPage([300, 400]);
    const b = await second.save();
    state.batches[0].hash = await hashPdf(a);
    state.batches[0].fileName = "A.pdf";
    state.batches.push({
      ...state.batches[0],
      id: "batch-B",
      hash: await hashPdf(b),
      fileName: "B.pdf",
    });
    const r1 = {
        ...state.receipts[0],
        id: "r1",
        pageNumber: 1,
        batchId: "batch",
      },
      r2 = {
        ...state.receipts[0],
        id: "r2",
        pageNumber: 2,
        batchId: "batch-B",
      };
    state.receipts = [r1, r2];
    ctx.scanCache.set("batch", a);
    const { mergeReceipts } = await import("./cloudWorkflow");
    await expect(mergeReceipts(ctx, state, [r2, r1])).rejects.toThrow("B.pdf");
    ctx.scanCache.set("batch-B", new Uint8Array([1, 2]));
    await expect(mergeReceipts(ctx, state, [r2, r1])).rejects.toThrow(
      "原本と一致",
    );
    ctx.scanCache.set("batch-B", b);
    const merged = await PDFDocument.load(
      await mergeReceipts(ctx, state, [r2, r1]),
    );
    expect(merged.getPages().map((p) => p.getWidth())).toEqual([100, 300]);
  });
});

describe("archive review snapshot regression", () => {
  async function unresolvedFixture() {
    const { state } = await fixture(),
      pdf = await PDFDocument.create();
    for (let n = 0; n < 3; n++) pdf.addPage([595, 842]);
    const bytes = await pdf.save();
    state.batches[0].hash = await hashPdf(bytes);
    state.batches[0].pageCount = 3;
    state.batches[0].pages.push(
      ...[2, 3].map((sourcePage) => ({
        id: `unknown-${sourcePage}`,
        sourcePage,
        status: "unreadable" as const,
        resolution: "pending" as const,
      })),
    );
    return { state, bytes };
  }
  it.each([[[]], [[3]]])(
    "pending pages changed to %j start a new archive without changing old planned IDs",
    async (pending) => {
      const { state, bytes } = await unresolvedFixture(),
        { ctx, client, onState } = context(bytes);
      client.uploadPdf.mockImplementation(async (options) => {
        if (options.name.includes("未照合"))
          throw new GoogleApiError("NETWORK", "upload response lost");
        return {
          id: options.fileId!,
          name: options.name,
          webViewLink: "https://drive.google.com/",
        };
      });
      await expect(
        addArchive(ctx, state, "collection", "batch"),
      ).rejects.toThrow("upload response lost");
      const failed = structuredClone(onState.mock.calls.at(-1)![0] as AppState),
        old = structuredClone(failed.operations![0]);
      failed.batches[0].pages = failed.batches[0].pages.map((page) =>
        page.sourcePage === 1
          ? page
          : {
              ...page,
              resolution: pending.includes(page.sourcePage)
                ? "pending"
                : "ignored",
              reviewReason: "別書類と確認",
              reviewedBy: "teacher",
              exclusionScope: "source",
            },
      );
      client.uploadPdf.mockImplementation(async (options) => ({
        id: options.fileId!,
        name: options.name,
        webViewLink: "https://drive.google.com/",
      }));
      const calls = client.uploadPdf.mock.calls.length;
      await expect(resumeArchive(ctx, failed, old.id)).rejects.toThrow(
        "未照合ページ",
      );
      expect(client.uploadPdf).toHaveBeenCalledTimes(calls);
      const current = await addArchive(ctx, failed, "collection", "batch");
      expect(current.operations).toHaveLength(2);
      expect(current.operations![0].plannedFileIds).toEqual(old.plannedFileIds);
      expect(current.operations![1].archiveStatus).toBe("saved");
      expect(current.operations![1].id).not.toBe(old.id);
      expect(current.receipts).toEqual(state.receipts);
      expect(
        client.uploadPdf.mock.calls.filter(([o]) => o.name.includes("回収元")),
      ).toHaveLength(1);
      if (pending.length)
        expect(
          current.operations![1].plannedFileIds!["unresolved:batch"],
        ).not.toBe(old.plannedFileIds!["unresolved:batch"]);
      else
        expect(
          current.operations![1].plannedFileIds!["unresolved:batch"],
        ).toBeUndefined();
    },
  );
  it("unchanged unresolved page snapshot retries identical reservation IDs", async () => {
    const { state, bytes } = await unresolvedFixture(),
      { ctx, client, onState } = context(bytes);
    client.uploadPdf.mockRejectedValueOnce(
      new GoogleApiError("NETWORK", "offline"),
    );
    await expect(addArchive(ctx, state, "collection", "batch")).rejects.toThrow(
      "offline",
    );
    const failed = onState.mock.calls.at(-1)![0] as AppState,
      old = structuredClone(failed.operations![0]);
    expect(old.unresolvedPages).toEqual([2, 3]);
    const result = await addArchive(ctx, failed, "collection", "batch");
    expect(result.operations).toHaveLength(1);
    expect(result.operations![0].plannedFileIds).toEqual(old.plannedFileIds);
    expect(result.operations![0].archiveStatus).toBe("saved");
  });
  it("completed unresolved snapshot is historical when current pending pages change", async () => {
    const { state, bytes } = await unresolvedFixture(),
      { ctx } = context(bytes);
    const completed = await addArchive(ctx, state, "collection", "batch");
    const old = structuredClone(completed.operations![0]);
    completed.batches[0].pages[1] = {
      ...completed.batches[0].pages[1],
      resolution: "ignored",
      reviewReason: "別書類",
      reviewedBy: "teacher",
      exclusionScope: "source",
    };
    const result = await addArchive(ctx, completed, "collection", "batch");
    expect(result.operations).toHaveLength(2);
    expect(result.operations![0]).toEqual(old);
    expect(result.operations![1].unresolvedPages).toEqual([3]);
    expect(result.operations![1].archiveStatus).toBe("saved");
    expect(result.operations![1].plannedFileIds!["unresolved:batch"]).not.toBe(
      old.plannedFileIds!["unresolved:batch"],
    );
  });
  it("legacy unresolved reservation is never reinterpreted and explicit current archive starts a new plan", async () => {
    const { state, bytes } = await unresolvedFixture(),
      { ctx, client, onState } = context(bytes);
    client.uploadPdf.mockRejectedValueOnce(
      new GoogleApiError("NETWORK", "offline"),
    );
    await expect(addArchive(ctx, state, "collection", "batch")).rejects.toThrow(
      "offline",
    );
    const legacy = structuredClone(onState.mock.calls.at(-1)![0] as AppState);
    delete legacy.operations![0].unresolvedPages;
    const old = structuredClone(legacy.operations![0]);
    const calls = client.uploadPdf.mock.calls.length;
    await expect(resumeArchive(ctx, legacy, old.id)).rejects.toThrow(
      "旧保存計画には未照合ページの固定情報がありません",
    );
    expect(client.uploadPdf).toHaveBeenCalledTimes(calls);
    const result = await addArchive(ctx, legacy, "collection", "batch");
    expect(result.operations).toHaveLength(2);
    expect(result.operations![0].plannedFileIds).toEqual(old.plannedFileIds);
    expect(result.operations![1].archiveStatus).toBe("saved");
    expect(result.operations![1].unresolvedPages).toEqual([2, 3]);
  });
  it("legacy plan without unresolved reservation retains its planned file IDs", async () => {
    const { state, bytes } = await fixture(),
      { ctx, client, onState } = context(bytes);
    client.uploadPdf.mockRejectedValueOnce(
      new GoogleApiError("NETWORK", "offline"),
    );
    await expect(addArchive(ctx, state, "collection", "batch")).rejects.toThrow(
      "offline",
    );
    const legacy = structuredClone(onState.mock.calls.at(-1)![0] as AppState);
    delete legacy.operations![0].unresolvedPages;
    const old = structuredClone(legacy.operations![0]);
    const result = await addArchive(ctx, legacy, "collection", "batch");
    expect(result.operations).toHaveLength(1);
    expect(result.operations![0].id).toBe(old.id);
    expect(result.operations![0].plannedFileIds).toEqual(old.plannedFileIds);
  });
  it("storage keeps historical unresolved snapshot and rejects impossible duplicate or noninteger pages", async () => {
    const { sanitizeStateForStorage } = await import("./domain/persistence");
    const { state } = await unresolvedFixture();
    const planned = beginSaveOperation(state, {
      collectionId: "collection",
      batchId: "batch",
      storageMode: "drive",
    }).state;
    expect(
      sanitizeStateForStorage(planned)?.operations?.[0].unresolvedPages,
    ).toEqual([2, 3]);
    planned.batches[0].pages[1].resolution = "ignored";
    expect(
      sanitizeStateForStorage(planned)?.operations?.[0].unresolvedPages,
    ).toEqual([2, 3]);
    for (const invalid of [[0], [4], [2, 2], [1.5], ["2"], null]) {
      const candidate = structuredClone(planned);
      (
        candidate.operations![0] as unknown as Record<string, unknown>
      ).unresolvedPages = invalid;
      expect(sanitizeStateForStorage(candidate)).toBeNull();
    }
    delete planned.operations![0].unresolvedPages;
    expect(
      sanitizeStateForStorage(planned)?.operations?.[0].unresolvedPages,
    ).toBeUndefined();
  });
});
