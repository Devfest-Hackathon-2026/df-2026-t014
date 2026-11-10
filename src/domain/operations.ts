import type {
  AppState,
  DriveArtifact,
  SaveOperation,
  StorageMode,
} from "./types";

export function receiptSetKey(receiptIds: readonly string[]): string {
  return JSON.stringify([...new Set(receiptIds)].sort());
}

export interface BeginSaveInput {
  collectionId: string;
  batchId?: string;
  storageMode: StorageMode;
  kind?: SaveOperation["kind"];
  id?: string;
}
export function beginSaveOperation(
  state: AppState,
  input: BeginSaveInput,
): { state: AppState; operation: SaveOperation } {
  const collection = state.collections.find(
    (item) => item.id === input.collectionId,
  );
  if (!collection) throw new Error("保存対象の配布物が見つかりません。");
  if (
    input.batchId &&
    !state.batches.some(
      (batch) =>
        batch.id === input.batchId && batch.collectionId === input.collectionId,
    )
  )
    throw new Error("保存対象の回収記録が一致しません。");
  const existing = input.id
    ? state.operations?.find((item) => item.id === input.id)
    : undefined;
  if (existing) {
    if (
      existing.collectionId !== input.collectionId ||
      existing.batchId !== input.batchId ||
      existing.storageMode !== input.storageMode ||
      existing.kind !== (input.kind ?? "archive")
    )
      throw new Error("同じ操作IDを別の保存処理には使用できません。");
    return { state, operation: existing };
  }
  const now = new Date().toISOString();
  const operation: SaveOperation = {
    id: input.id ?? crypto.randomUUID(),
    collectionId: input.collectionId,
    ...(input.batchId ? { batchId: input.batchId } : {}),
    kind: input.kind ?? "archive",
    storageMode: input.storageMode,
    recordStatus: "prepared",
    archiveStatus: input.storageMode === "drive" ? "pending" : "not-requested",
    receiptIds: state.receipts
      .filter(
        (receipt) =>
          receipt.collectionId === collection.id &&
          receipt.versionId === collection.versionId,
      )
      .map((receipt) => receipt.id)
      .sort(),
    createdAt: now,
    updatedAt: now,
    plannedFileIds: {},
    ...(input.batchId
      ? {
          unresolvedPages: state.batches
            .find((batch) => batch.id === input.batchId)!
            .pages.filter((page) => page.resolution === "pending")
            .map((page) => page.sourcePage)
            .sort((a, b) => a - b),
        }
      : {}),
  };
  return {
    operation,
    state: {
      ...state,
      operations: [...(state.operations ?? []), operation],
      batches: state.batches.map((batch) =>
        batch.id === input.batchId && !batch.storageMode
          ? { ...batch, storageMode: input.storageMode }
          : batch,
      ),
    },
  };
}

export function updateSaveOperation(
  state: AppState,
  id: string,
  patch: Partial<
    Pick<SaveOperation, "recordStatus" | "archiveStatus" | "error">
  >,
): AppState {
  const operation = state.operations?.find((item) => item.id === id);
  if (!operation) throw new Error("再試行する保存操作が見つかりません。");
  if (
    operation.recordStatus === "recorded" &&
    patch.recordStatus &&
    patch.recordStatus !== "recorded"
  )
    throw new Error("確定済みの回収記録を未記録へ戻せません。");
  if (
    operation.storageMode === "record-only" &&
    patch.archiveStatus &&
    patch.archiveStatus !== "not-requested"
  )
    throw new Error(
      "記録のみの操作ではPDFを保管しません。別の保管操作を作成してください。",
    );
  if (patch.archiveStatus === "saved") {
    const artifacts = (state.artifacts ?? []).filter(
      (item) => item.operationId === id && !item.deleted,
    );
    const plannedIds = Object.values(operation.plannedFileIds ?? {});
    const linkedOriginalOnly =
      operation.kind !== "print" &&
      !operation.receiptIds.length &&
      !plannedIds.length &&
      !!state.batches.find(
        (batch) =>
          batch.id === operation.batchId &&
          batch.collectionId === operation.collectionId &&
          batch.sourceDriveFileId,
      );
    if (
      (!artifacts.length && !linkedOriginalOnly) ||
      plannedIds.some(
        (fileId) => !artifacts.some((item) => item.driveFileId === fileId),
      )
    )
      throw new Error("予定したPDFの保管完了をまだ確認できません。");
  }
  return {
    ...state,
    operations: state.operations!.map((item) =>
      item.id === id
        ? { ...item, ...patch, updatedAt: new Date().toISOString() }
        : item,
    ),
  };
}

export function reserveOperationFile(
  state: AppState,
  operationId: string,
  key: string,
  driveFileId: string,
): AppState {
  const operation = state.operations?.find((item) => item.id === operationId);
  if (
    !operation ||
    operation.storageMode !== "drive" ||
    !key.trim() ||
    !driveFileId.trim()
  )
    throw new Error("保管計画またはファイルIDが不正です。");
  const previous = operation.plannedFileIds?.[key];
  if (previous && previous !== driveFileId)
    throw new Error(
      "再試行では事前に発行した同じファイルIDを使用してください。",
    );
  if (
    Object.entries(operation.plannedFileIds ?? {}).some(
      ([existingKey, id]) => existingKey !== key && id === driveFileId,
    )
  )
    throw new Error("異なるPDFには別のファイルIDを発行してください。");
  return {
    ...state,
    operations: state.operations!.map((item) =>
      item.id === operationId
        ? {
            ...item,
            plannedFileIds: { ...item.plannedFileIds, [key]: driveFileId },
            updatedAt: new Date().toISOString(),
          }
        : item,
    ),
  };
}

export type DriveArtifactInput = Omit<DriveArtifact, "id" | "createdAt"> & {
  id?: string;
  createdAt?: string;
};
export function registerDriveArtifact(
  state: AppState,
  input: DriveArtifactInput,
): AppState {
  const collection = state.collections.find(
    (item) => item.id === input.collectionId,
  );
  if (!collection || !input.driveFileId.trim())
    throw new Error("保管したファイルと配布物が一致しません。");
  if (input.versionId && input.versionId !== collection.versionId)
    throw new Error("保管したPDFの版が一致しません。");
  const operation = input.operationId
    ? state.operations?.find((item) => item.id === input.operationId)
    : undefined;
  if (
    input.operationId &&
    (!operation ||
      operation.collectionId !== collection.id ||
      operation.storageMode !== "drive")
  )
    throw new Error("保管操作が見つからないか、対象が一致しません。");
  if (
    input.batchId &&
    !state.batches.some(
      (batch) =>
        batch.id === input.batchId && batch.collectionId === collection.id,
    )
  )
    throw new Error("保管元のスキャンが見つからないか、配布物が一致しません。");
  if (
    input.kind === "student" &&
    (!input.studentId ||
      !collection.recipients.some((student) => student.id === input.studentId))
  )
    throw new Error("保管する生徒が発行対象に含まれていません。");
  if (
    input.receiptIds.some((id) => {
      const receipt = state.receipts.find((item) => item.id === id);
      return receipt
        ? receipt.collectionId !== collection.id ||
            (input.studentId !== undefined &&
              receipt.studentId !== input.studentId)
        : !operation?.receiptIds.includes(id);
    })
  )
    throw new Error("PDFが含む受領記録を確認できません。");
  const artifact: DriveArtifact = {
    ...input,
    id: input.id ?? crypto.randomUUID(),
    createdAt: input.createdAt ?? new Date().toISOString(),
    versionId: input.versionId ?? collection.versionId,
    receiptIds: [...new Set(input.receiptIds)].sort(),
  };
  const existing = state.artifacts?.find(
    (item) => item.driveFileId === artifact.driveFileId,
  );
  if (existing) {
    if (
      existing.kind !== artifact.kind ||
      existing.collectionId !== artifact.collectionId ||
      existing.studentId !== artifact.studentId ||
      existing.batchId !== artifact.batchId ||
      receiptSetKey(existing.receiptIds) !== receiptSetKey(artifact.receiptIds)
    )
      throw new Error("このDriveファイルIDは異なる成果物に使われています。");
    return state;
  }
  return {
    ...state,
    artifacts: [...(state.artifacts ?? []), artifact],
    collections: state.collections.map((item) =>
      item.id !== collection.id
        ? item
        : input.kind === "print"
          ? { ...item, printDriveFileId: input.driveFileId }
          : input.kind === "original"
            ? { ...item, sourceDriveFileId: input.driveFileId }
            : item,
    ),
    batches: state.batches.map((batch) =>
      input.kind === "source-scan" && batch.id === input.batchId
        ? { ...batch, sourceDriveFileId: input.driveFileId }
        : batch,
    ),
  };
}

export interface StudentArchiveSummary {
  status: "not_saved" | "current" | "stale";
  artifact?: DriveArtifact;
  missingBatchIds: string[];
}
export function getStudentArchiveSummary(
  state: AppState,
  collectionId: string,
  studentId: string,
): StudentArchiveSummary {
  const collection = state.collections.find((item) => item.id === collectionId);
  const receipts = state.receipts.filter(
    (receipt) =>
      receipt.collectionId === collectionId &&
      receipt.studentId === studentId &&
      receipt.versionId === collection?.versionId,
  );
  const key = receiptSetKey(receipts.map((receipt) => receipt.id));
  const artifacts = (state.artifacts ?? [])
    .filter(
      (item) =>
        item.kind === "student" &&
        item.collectionId === collectionId &&
        item.studentId === studentId &&
        item.versionId === collection?.versionId &&
        !item.deleted,
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const current = receipts.length
    ? artifacts.find((item) => receiptSetKey(item.receiptIds) === key)
    : undefined;
  const artifact = current ?? artifacts[0];
  const missingBatchIds = [
    ...new Set(
      receipts
        .filter(
          (receipt) =>
            !state.batches.find((batch) => batch.id === receipt.batchId)
              ?.sourceDriveFileId,
        )
        .map((receipt) => receipt.batchId),
    ),
  ];
  return {
    status: current ? "current" : artifact ? "stale" : "not_saved",
    ...(artifact ? { artifact } : {}),
    missingBatchIds,
  };
}

export function markDriveArtifactMissing(
  state: AppState,
  driveFileId: string,
): AppState {
  return {
    ...state,
    artifacts: state.artifacts?.map((item) =>
      item.driveFileId === driveFileId ? { ...item, deleted: true } : item,
    ),
    batches: state.batches.map((batch) =>
      batch.sourceDriveFileId === driveFileId
        ? { ...batch, sourceDriveFileId: undefined }
        : batch,
    ),
    collections: state.collections.map((collection) => ({
      ...collection,
      ...(collection.sourceDriveFileId === driveFileId
        ? { sourceDriveFileId: undefined }
        : {}),
      ...(collection.printDriveFileId === driveFileId
        ? { printDriveFileId: undefined }
        : {}),
    })),
  };
}
