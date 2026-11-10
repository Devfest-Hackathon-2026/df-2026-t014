import type { AppState, ProgressCallback } from "./domain/types";
import type { GoogleWorkspaceClient } from "./google/client";
import {
  completeAdditionalIssue,
  prepareAdditionalIssue,
} from "./domain/additionalIssue";
import {
  beginSaveOperation,
  registerDriveArtifact,
  reserveOperationFile,
  updateSaveOperation,
} from "./domain/operations";
import { generatePrintPdf, generateSourcePdf } from "./pdfClient";
import { hashPdf } from "./cloudWorkflow";
import { assertCollectionWritable } from "./domain/lifecycle";

export interface AdditionalIssueInput {
  state: AppState;
  collectionId: string;
  studentIds: string[];
  actor: string;
  reason: string;
  sample: boolean;
  client?: GoogleWorkspaceClient;
  sourcePdf?: Uint8Array;
  operationId?: string;
  onCommit(next: AppState): Promise<void>;
  onProgress?: ProgressCallback;
}

/** A separate operation/file for the new packet keeps original and whole-class print links intact. */
export async function issueAdditionalRecipients(
  input: AdditionalIssueInput,
): Promise<{ state: AppState; bytes: Uint8Array; title: string }> {
  assertCollectionWritable(input.state, input.collectionId);
  let state = input.state;
  let collection = state.collections.find(
    (collection) => collection.id === input.collectionId,
  );
  if (!collection) throw new Error("追加発行する配布物が見つかりません。");
  const client = input.client;
  if (!input.sample && !client?.isConnected())
    throw new Error("Googleに接続して追加発行を保存してください。");
  const context = { actor: input.actor, reason: input.reason };
  let source = input.sourcePdf;
  if (!source && collection.sourceDriveFileId && client)
    source = await client.downloadPdf(
      collection.sourceDriveFileId,
      collection.sourceHash,
    );
  if (
    !source &&
    input.sample &&
    ["サンプル原稿", "PaperFlowサンプル原稿"].includes(collection.sourceName)
  )
    source = await generateSourcePdf(collection);
  if (!source)
    throw new Error(
      "追加発行には同じ原稿PDFが必要です。保存済み原稿に接続するか、原稿PDFを選び直してください。",
    );
  if (
    collection.sourceHash &&
    (await hashPdf(source)) !== collection.sourceHash
  )
    throw new Error(
      "原稿PDFが発行時の原稿と一致しません。同じ原稿を選び直してください。",
    );
  let studentIds = input.studentIds;
  let operation = state.operations?.find(
    (operation) => operation.id === input.operationId,
  );
  if (input.operationId) {
    if (
      !operation ||
      operation.collectionId !== collection.id ||
      operation.kind !== "print" ||
      !operation.studentIds?.length
    )
      throw new Error("再開する追加発行操作が見つかりません。");
    if (operation.storageMode !== (input.sample ? "record-only" : "drive"))
      throw new Error("サンプルとGoogle保存の処理を切り替えて再開できません。");
    studentIds = operation.studentIds;
    if (studentIds.some((id) => !collection!.pendingRecipientIds?.includes(id)))
      throw new Error(
        "この追加発行は既に完了しているか、対象が変更されています。",
      );
  } else {
    const prepared = prepareAdditionalIssue(
      state,
      collection.id,
      studentIds,
      context,
    );
    state = prepared.state;
    collection = prepared.collection;
    studentIds = prepared.addedStudentIds;
    const started = beginSaveOperation(state, {
      collectionId: collection.id,
      kind: "print",
      storageMode: input.sample ? "record-only" : "drive",
    });
    operation = { ...started.operation, studentIds };
    state = {
      ...started.state,
      operations: started.state.operations!.map((item) =>
        item.id === operation!.id ? operation! : item,
      ),
    };
  }
  const operationId = operation!.id;
  if (!input.sample && !operation!.plannedFileIds?.["additional-print"])
    state = reserveOperationFile(
      state,
      operationId,
      "additional-print",
      await client!.generateFileId(),
    );
  state = updateSaveOperation(state, operationId, {
    recordStatus: "recorded",
    ...(input.sample ? {} : { archiveStatus: "saving" as const }),
    error: undefined,
  });
  await input.onCommit(state);
  let retryState = state;
  try {
    const result = await generatePrintPdf({
      collection,
      students: collection.recipients,
      studentIds,
      sourcePdf: source,
      onProgress: input.onProgress,
    });
    const title = `${collection.title} — 追加発行 ${studentIds.length}人`;
    if (!input.sample) {
      const fileId = state.operations!.find(
        (operation) => operation.id === operationId,
      )!.plannedFileIds!["additional-print"];
      const existing = state.artifacts?.find(
        (artifact) => artifact.driveFileId === fileId && !artifact.deleted,
      );
      if (!existing) {
        if (!collection.folderId)
          throw new Error(
            "配布物の保存先フォルダがありません。保存先を設定してから再試行してください。",
          );
        const folder = await client!.createFolder("追加発行", {
          parentId: collection.folderId,
          idempotencyKey: `additional-folder:${collection.id}`,
        });
        const name = `追加発行_${collection.versionLabel ?? "v1"}_${operationId.slice(0, 8)}.pdf`;
        await client!.uploadPdf({
          name,
          bytes: result.bytes,
          parentId: folder.id,
          fileId,
          idempotencyKey: `${operationId}:additional-print`,
        });
        state = registerDriveArtifact(state, {
          kind: "additional-print",
          collectionId: collection.id,
          operationId,
          driveFileId: fileId,
          name,
          receiptIds: [],
        });
      }
      state = updateSaveOperation(state, operationId, {
        archiveStatus: "saved",
        error: undefined,
      });
    }
    retryState = state;
    state = completeAdditionalIssue(state, collection.id, studentIds, context);
    await input.onCommit(state);
    return { state, bytes: result.bytes, title };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "追加発行を完了できませんでした。";
    const failed = updateSaveOperation(retryState, operationId, {
      ...(input.sample ? {} : { archiveStatus: "failed" as const }),
      error: message,
    });
    try {
      await input.onCommit(failed);
    } catch {
      /* The already committed plan retains fixed file IDs and inactive tokens. */
    }
    throw error;
  }
}
