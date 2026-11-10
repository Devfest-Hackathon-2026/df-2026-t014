import { webcrypto } from "node:crypto";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { hashPdf } from "./cloudWorkflow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueAdditionalRecipients } from "./additionalIssueCloud";
import { createInitialState } from "./domain/seed";
import { createCollection } from "./domain/logic";
import { sanitizeStateForStorage } from "./domain/persistence";
import type { AppState } from "./domain/types";
import type { GoogleWorkspaceClient } from "./google/client";
import { generatePrintPdf } from "./pdfClient";
import {
  planCollectionCleanup,
  prepareCollectionCleanup,
} from "./domain/lifecycle";
vi.mock("./pdfClient", () => ({
  generatePrintPdf: vi.fn(async ({ collection }) => ({
    collection,
    bytes: new TextEncoder().encode("%PDF-partial"),
  })),
  generateSourcePdf: vi.fn(async () => new TextEncoder().encode("%PDF-source")),
}));
const source = new TextEncoder().encode("%PDF-source");
function fixture() {
  const initial = createInitialState();
  const students = initial.students.slice(0, 3);
  const collection = {
    ...createCollection(
      {
        title: "同意書",
        className: initial.className,
        pageCount: 1,
        requiredPages: [1],
        qrCorner: "top-right",
        duplex: false,
        order: "row",
        reverse: false,
        sourceName: "original.pdf",
      },
      students.slice(0, 2),
    ),
    folderId: "collection-folder",
    sourceDriveFileId: "original-file",
    printDriveFileId: "full-class-file",
  };
  return {
    state: { ...initial, students, collections: [collection] } as AppState,
    collection,
    studentIds: [students[2].id],
  };
}
function clientMock() {
  return {
    isConnected: vi.fn(() => true),
    getIdentity: vi.fn(() => ({
      id: "account",
      email: "teacher@example.test",
    })),
    generateFileId: vi.fn(async () => "partial-file"),
    downloadPdf: vi.fn(async () => source),
    createFolder: vi.fn(async () => ({ id: "additional-folder" })),
    uploadPdf: vi.fn(async (_input: { fileId?: string }) => ({
      id: "partial-file",
    })),
  };
}
beforeEach(() => vi.clearAllMocks());
describe("additional issue durable workflow", () => {
  it("stops an interrupted additional issue before any Google call once deletion starts", async () => {
    const { state, collection, studentIds } = fixture();
    const client = clientMock();
    client.uploadPdf.mockRejectedValueOnce(new Error("upload interrupted"));
    let latest = state;
    const onCommit = vi.fn(async (next: AppState) => {
      latest = structuredClone(next);
    });
    const input = {
      collectionId: collection.id,
      studentIds,
      actor: "teacher",
      reason: "転入",
      sample: false,
      client: client as unknown as GoogleWorkspaceClient,
      sourcePdf: source,
      onCommit,
    };
    await expect(
      issueAdditionalRecipients({ ...input, state }),
    ).rejects.toThrow("upload interrupted");
    const operationId = latest.operations![0].id;
    latest = prepareCollectionCleanup(
      latest,
      planCollectionCleanup(latest, [collection.id]),
      {
        actor: "teacher",
        reason: "保管期限終了",
      },
    ).state;
    vi.clearAllMocks();
    await expect(
      issueAdditionalRecipients({
        ...input,
        state: latest,
        operationId,
        studentIds: [],
      }),
    ).rejects.toThrow(/削除/);
    for (const method of Object.values(client))
      expect(method).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    expect(generatePrintPdf).not.toHaveBeenCalled();
    expect(
      latest.collections[0].tokens.every((token) => token.active === false),
    ).toBe(true);
  });

  it("commits inactive token/file plans before uploading and preserves original/full-print links", async () => {
    const { state, collection, studentIds } = fixture();
    const client = clientMock();
    const committed: AppState[] = [];
    client.uploadPdf.mockImplementation(async () => {
      expect(committed).toHaveLength(1);
      const planned = committed[0];
      expect(planned.collections[0].pendingRecipientIds).toEqual(studentIds);
      expect(planned.operations![0].plannedFileIds?.["additional-print"]).toBe(
        "partial-file",
      );
      expect(
        planned.collections[0].tokens.find(
          (token) => token.studentId === studentIds[0],
        )!.active,
      ).toBe(false);
      return { id: "partial-file" };
    });
    const result = await issueAdditionalRecipients({
      state,
      collectionId: collection.id,
      studentIds,
      actor: "teacher",
      reason: "転入",
      sample: false,
      client: client as unknown as GoogleWorkspaceClient,
      sourcePdf: source,
      onCommit: async (next) => {
        expect(sanitizeStateForStorage(next)).not.toBeNull();
        committed.push(structuredClone(next));
      },
    });
    expect(committed).toHaveLength(2);
    expect(result.state.collections[0].pendingRecipientIds).toEqual([]);
    expect(result.state.collections[0].printDriveFileId).toBe(
      "full-class-file",
    );
    expect(result.state.collections[0].sourceDriveFileId).toBe("original-file");
    expect(result.state.artifacts?.[0]).toMatchObject({
      kind: "additional-print",
      driveFileId: "partial-file",
    });
    expect(vi.mocked(generatePrintPdf).mock.calls[0][0].studentIds).toEqual(
      studentIds,
    );
  });
  it("retries an interrupted upload with the same operation, token and file ID", async () => {
    const { state, collection, studentIds } = fixture();
    const client = clientMock();
    client.uploadPdf.mockRejectedValueOnce(new Error("network interrupted"));
    let latest = state;
    const onCommit = async (next: AppState) => {
      latest = structuredClone(next);
    };
    await expect(
      issueAdditionalRecipients({
        state,
        collectionId: collection.id,
        studentIds,
        actor: "teacher",
        reason: "転入",
        sample: false,
        client: client as unknown as GoogleWorkspaceClient,
        sourcePdf: source,
        onCommit,
      }),
    ).rejects.toThrow("network interrupted");
    expect(latest.operations![0].archiveStatus).toBe("failed");
    const token = latest.collections[0].tokens.find(
      (token) => token.studentId === studentIds[0],
    )!.token;
    const operationId = latest.operations![0].id;
    const result = await issueAdditionalRecipients({
      state: latest,
      collectionId: collection.id,
      studentIds: [],
      operationId,
      actor: "teacher",
      reason: "保存を再試行",
      sample: false,
      client: client as unknown as GoogleWorkspaceClient,
      sourcePdf: source,
      onCommit,
    });
    expect(client.generateFileId).toHaveBeenCalledTimes(1);
    expect(client.uploadPdf.mock.calls.map(([input]) => input.fileId)).toEqual([
      "partial-file",
      "partial-file",
    ]);
    expect(result.state.operations).toHaveLength(1);
    expect(
      result.state.collections[0].tokens.find(
        (item) => item.studentId === studentIds[0],
      )!.token,
    ).toBe(token);
    expect(sanitizeStateForStorage(result.state)).not.toBeNull();
  });
  it("does not upload or activate tokens when the plan could not be committed", async () => {
    const { state, collection, studentIds } = fixture();
    const client = clientMock();
    await expect(
      issueAdditionalRecipients({
        state,
        collectionId: collection.id,
        studentIds,
        actor: "teacher",
        reason: "転入",
        sample: false,
        client: client as unknown as GoogleWorkspaceClient,
        sourcePdf: source,
        onCommit: async () => {
          throw new Error("ledger conflict");
        },
      }),
    ).rejects.toThrow("ledger conflict");
    expect(client.uploadPdf).not.toHaveBeenCalled();
    expect(generatePrintPdf).not.toHaveBeenCalled();
    expect(state.collections[0].recipients).toHaveLength(2);
  });
  it("keeps sample additions local and refuses a missing non-sample original", async () => {
    const { state, collection, studentIds } = fixture();
    const result = await issueAdditionalRecipients({
      state,
      collectionId: collection.id,
      studentIds,
      actor: "sample-teacher",
      reason: "サンプル追加",
      sample: true,
      sourcePdf: source,
      onCommit: async () => {},
    });
    expect(result.state.operations![0].storageMode).toBe("record-only");
    expect(result.state.artifacts).toBeUndefined();
    expect(result.state.collections[0].pendingRecipientIds).toEqual([]);
    const missing = {
      ...state,
      collections: [{ ...collection, sourceDriveFileId: undefined }],
    };
    await expect(
      issueAdditionalRecipients({
        state: missing,
        collectionId: collection.id,
        studentIds,
        actor: "teacher",
        reason: "転入",
        sample: true,
        onCommit: async () => {},
      }),
    ).rejects.toThrow(/原稿PDF/);
  });
});

it("PF-F086 different real source B is rejected before plan or print; exact source A reuses original version and existing tokens", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const make = async (text: string) => {
    const doc = await PDFDocument.create(),
      font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([595.28, 841.89]).drawText(text, { x: 100, y: 400, font });
    return doc.save();
  };
  const A = await make("Content A"),
    B = await make("Content B");
  const { state, collection, studentIds } = fixture();
  collection.sourceHash = await hashPdf(A);
  const original = structuredClone(collection);
  const commit = vi.fn();
  const input = {
    state,
    collectionId: collection.id,
    studentIds,
    actor: "teacher",
    reason: "同じ原稿で追加",
    sample: true,
    onCommit: commit,
  };
  await expect(
    issueAdditionalRecipients({ ...input, sourcePdf: B }),
  ).rejects.toThrow("一致しません");
  expect(commit).not.toHaveBeenCalled();
  expect(generatePrintPdf).not.toHaveBeenCalled();
  expect(collection).toEqual(original);
  const out = await issueAdditionalRecipients({ ...input, sourcePdf: A });
  expect(out.state.collections[0].id).toBe(original.id);
  expect(out.state.collections[0].versionId).toBe(original.versionId);
  expect(
    out.state.collections[0].tokens.slice(0, original.tokens.length),
  ).toEqual(original.tokens);
  expect(vi.mocked(generatePrintPdf).mock.calls[0][0].sourcePdf).toEqual(A);
  expect(out.state.collections[0].sourceHash).toBe(original.sourceHash);
  vi.unstubAllGlobals();
});
