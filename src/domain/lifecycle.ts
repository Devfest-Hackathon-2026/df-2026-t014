import type {
  AppState,
  ChangeContext,
  CleanupFile,
  CleanupOperation,
} from "./types";
import { changeEvent, requireChangeContext } from "./workflows";
import { sharedScanViews } from "./sharedScan";

/** Cleanup retains ledger rows, but its targets must never receive new files. */
export function isCollectionDeleting(
  state: AppState,
  collectionId: string,
): boolean {
  return Boolean(
    state.collections.find((collection) => collection.id === collectionId)
      ?.deletedAt ||
    state.cleanupOperations?.some(
      (operation) =>
        operation.status !== "complete" &&
        operation.collectionIds.includes(collectionId),
    ),
  );
}

export function assertCollectionWritable(
  state: AppState,
  collectionId: string,
): void {
  if (!state.collections.some((collection) => collection.id === collectionId))
    throw new Error("保存対象の配布物が見つかりません。");
  if (isCollectionDeleting(state, collectionId))
    throw new Error(
      "削除中・削除済みの配布物には保存できません。整理・削除の履歴を確認してください。",
    );
}

export interface CleanupPlan {
  collectionIds: string[];
  titles: string[];
  counts: {
    collections: number;
    tokens: number;
    recipients: number;
    receipts: number;
    batches: number;
    pages: number;
    artifacts: number;
    operations: number;
  };
  files: CleanupFile[];
  fingerprint: string;
}

type Workspace = Pick<
  AppState,
  | "collections"
  | "batches"
  | "scanSources"
  | "artifacts"
  | "operations"
  | "settings"
>;
interface FileReference {
  fileId: string;
  name: string;
  collectionId: string;
  workspace: string;
}

function references(workspace: Workspace, key: string): FileReference[] {
  const active = new Set(
    workspace.collections
      .filter((collection) => !collection.deletedAt)
      .map((collection) => collection.id),
  );
  const result: FileReference[] = [];
  const add = (
    fileId: string | undefined,
    collectionId: string,
    name: string,
  ) => {
    if (fileId && active.has(collectionId))
      result.push({ fileId, collectionId, name, workspace: key });
  };
  for (const collection of workspace.collections) {
    add(
      collection.sourceDriveFileId,
      collection.id,
      `${collection.title} / 原稿スナップショット`,
    );
    add(
      collection.printDriveFileId,
      collection.id,
      `${collection.title} / 印刷用PDF`,
    );
  }
  for (const artifact of workspace.artifacts ?? [])
    if (!artifact.deleted)
      add(artifact.driveFileId, artifact.collectionId, artifact.name);
  for (const batch of workspace.batches)
    add(
      batch.sourceDriveFileId,
      batch.collectionId,
      `${batch.fileName} / 回収元`,
    );
  // A shared original remains in use even before a consumer has downloaded it or
  // copied a file ID into its own view. Retained deleted views can still locate it.
  for (const consumer of workspace.batches) {
    if (!active.has(consumer.collectionId)) continue;
    for (const sourceView of sharedScanViews(workspace, consumer))
      add(
        sourceView.sourceDriveFileId,
        consumer.collectionId,
        `${consumer.fileName} / 共通の回収元`,
      );
  }
  // An upload may have succeeded before its artifact link was saved. Its reserved
  // file ID remains in scope and must not disappear from the cleanup plan.
  for (const operation of workspace.operations ?? [])
    for (const [kind, fileId] of Object.entries(operation.plannedFileIds ?? {}))
      add(
        fileId,
        operation.collectionId,
        `保存計画 ${kind}（未作成の可能性あり）`,
      );
  return result;
}

function systemFiles(workspace: Workspace): string[] {
  return [
    workspace.settings?.ledgerId,
    workspace.settings?.folderId,
    ...workspace.collections.flatMap((collection) => [
      collection.sourceDocumentId,
      collection.folderId,
    ]),
  ].filter((value): value is string => Boolean(value));
}

/** Pure preview. Never calls Drive and never drops ledger evidence. */
export function planCollectionCleanup(
  state: AppState,
  ids: string[],
): CleanupPlan {
  const collectionIds = [...new Set(ids)].sort();
  if (!collectionIds.length)
    throw new Error("整理する配布物を選択してください。");
  const selected = new Set(collectionIds);
  const collections = collectionIds.map((id) => {
    const collection = state.collections.find((item) => item.id === id);
    if (!collection || collection.deletedAt)
      throw new Error(
        "対象の配布物が見つからないか、既に論理削除されています。",
      );
    return collection;
  });
  const currentKey = state.classId ?? "current";
  const saved = (state.savedClasses ?? []).filter(
    (workspace) => workspace.id !== currentKey,
  );
  const currentRefs = references(state, currentKey);
  const allRefs = [
    ...currentRefs,
    ...saved.flatMap((workspace) => references(workspace, workspace.id)),
  ];
  const protectedIds = new Set([
    ...systemFiles(state),
    ...saved.flatMap(systemFiles),
  ]);
  const idsToInspect = [
    ...new Set(
      currentRefs
        .filter((ref) => selected.has(ref.collectionId))
        .map((ref) => ref.fileId),
    ),
  ].sort();
  const files = idsToInspect.map<CleanupFile>((fileId) => {
    const owned = currentRefs.filter(
      (ref) => ref.fileId === fileId && selected.has(ref.collectionId),
    );
    const others = allRefs.filter(
      (ref) =>
        ref.fileId === fileId &&
        (ref.workspace !== currentKey || !selected.has(ref.collectionId)),
    );
    const protectedReason = protectedIds.has(fileId)
      ? "元のGoogle Docs・台帳・保存先フォルダは削除しません。"
      : others.length
        ? "別の配布物または保存クラスでも使っているため残します。"
        : undefined;
    return {
      fileId,
      name:
        owned.find((ref) => !ref.name.startsWith("保存計画 "))?.name ??
        owned[0].name,
      collectionIds: [...new Set(owned.map((ref) => ref.collectionId))].sort(),
      status: protectedReason ? "protected" : "pending",
      ...(protectedReason ? { error: protectedReason } : {}),
    };
  });
  const receipts = state.receipts.filter((item) =>
    selected.has(item.collectionId),
  );
  const batches = state.batches.filter((item) =>
    selected.has(item.collectionId),
  );
  const artifacts = (state.artifacts ?? []).filter((item) =>
    selected.has(item.collectionId),
  );
  const operations = (state.operations ?? []).filter((item) =>
    selected.has(item.collectionId),
  );
  const counts = {
    collections: collections.length,
    tokens: collections.reduce(
      (sum, collection) => sum + collection.tokens.length,
      0,
    ),
    recipients: collections.reduce(
      (sum, collection) => sum + collection.recipients.length,
      0,
    ),
    receipts: receipts.length,
    batches: batches.length,
    pages: batches.reduce((sum, batch) => sum + batch.pages.length, 0),
    artifacts: artifacts.length,
    operations: operations.length,
  };
  return {
    collectionIds,
    titles: collections.map((collection) => collection.title),
    counts,
    files,
    fingerprint: JSON.stringify({
      collectionIds,
      files,
      tokens: collections.flatMap((collection) =>
        collection.tokens.map((token) => token.token),
      ),
      receipts: receipts.map((item) => item.id).sort(),
      batches: batches.map((item) => [
        item.id,
        item.pages.map((page) => page.id),
      ]),
      artifacts: artifacts.map((item) => item.id).sort(),
      operations: operations.map((item) => item.id).sort(),
    }),
  };
}

export function archiveCollections(
  state: AppState,
  ids: string[],
  context: ChangeContext,
): AppState {
  requireChangeContext(context);
  const plan = planCollectionCleanup(state, ids);
  const selected = new Set(plan.collectionIds);
  const now = new Date().toISOString();
  return {
    ...state,
    collections: state.collections.map((collection) =>
      selected.has(collection.id)
        ? { ...collection, archivedAt: collection.archivedAt ?? now }
        : collection,
    ),
    events: [
      ...state.events,
      changeEvent(
        "archive_collections",
        state.classId ?? "local-class",
        context,
        { collectionIds: plan.collectionIds },
        { archivedAt: now, count: selected.size },
      ),
    ],
  };
}

export function unarchiveCollections(
  state: AppState,
  ids: string[],
  context: ChangeContext,
): AppState {
  requireChangeContext(context);
  const plan = planCollectionCleanup(state, ids);
  const selected = new Set(plan.collectionIds);
  if (
    state.cleanupOperations?.some(
      (operation) =>
        operation.status !== "complete" &&
        operation.collectionIds.some((id) => selected.has(id)),
    )
  )
    throw new Error(
      "削除が未完了の配布物は、アーカイブを解除できません。保存した削除計画を確認してください。",
    );
  return {
    ...state,
    collections: state.collections.map((collection) =>
      selected.has(collection.id)
        ? { ...collection, archivedAt: undefined }
        : collection,
    ),
    events: [
      ...state.events,
      changeEvent(
        "unarchive_collections",
        state.classId ?? "local-class",
        context,
        { collectionIds: plan.collectionIds },
        { archived: false },
      ),
    ],
  };
}

export function prepareCollectionCleanup(
  state: AppState,
  reviewed: CleanupPlan,
  context: ChangeContext,
): { state: AppState; operation: CleanupOperation } {
  requireChangeContext(context);
  const latest = planCollectionCleanup(state, reviewed.collectionIds);
  if (latest.fingerprint !== reviewed.fingerprint)
    throw new Error(
      "確認後に対象が変更されています。件数とファイル一覧を確認し直してください。",
    );
  const active = state.cleanupOperations?.find(
    (operation) =>
      operation.status !== "complete" &&
      operation.collectionIds.some((id) => reviewed.collectionIds.includes(id)),
  );
  if (active)
    throw new Error(
      "この配布物には未完了の削除があります。新しい操作を作らず、保存した計画から再開してください。",
    );
  const operation: CleanupOperation = {
    id: crypto.randomUUID(),
    collectionIds: reviewed.collectionIds,
    actor: context.actor.trim(),
    reason: context.reason.trim(),
    createdAt: new Date().toISOString(),
    status: "planned",
    files: structuredClone(reviewed.files),
  };
  return {
    operation,
    state: {
      ...state,
      collections: state.collections.map((collection) =>
        reviewed.collectionIds.includes(collection.id)
          ? {
              ...collection,
              tokens: collection.tokens.map((token) => ({
                ...token,
                active: false,
              })),
            }
          : collection,
      ),
      cleanupOperations: [...(state.cleanupOperations ?? []), operation],
      events: [
        ...state.events,
        changeEvent("plan_collection_cleanup", operation.id, context, null, {
          collectionIds: operation.collectionIds,
          files: operation.files.map((file) => ({
            id: file.fileId,
            status: file.status,
          })),
        }),
      ],
    },
  };
}

function setOperation(state: AppState, operation: CleanupOperation): AppState {
  return {
    ...state,
    cleanupOperations: state.cleanupOperations!.map((item) =>
      item.id === operation.id ? operation : item,
    ),
  };
}

export interface CleanupExecutor {
  /** Must be idempotent and soft-trash only; an already trashed file is success. */
  trashFile: (fileId: string) => Promise<void>;
  /** Persists each stage. Failure stops before another external action. */
  onCommit: (next: AppState) => Promise<void>;
}

/** Only call in response to the teacher's explicit reviewed cleanup command. */
export async function runCollectionCleanup(
  input: AppState,
  operationId: string,
  executor: CleanupExecutor,
): Promise<AppState> {
  let state = input;
  let operation = state.cleanupOperations?.find(
    (item) => item.id === operationId,
  );
  if (!operation) throw new Error("削除の保存計画が見つかりません。");
  if (operation.status === "complete") return state;
  const currentPlan = planCollectionCleanup(state, operation.collectionIds);
  const plannedIds = new Set(operation.files.map((file) => file.fileId));
  if (currentPlan.files.some((file) => !plannedIds.has(file.fileId)))
    throw new Error(
      "計画後に保存ファイルが追加されています。削除を停止しました。台帳と対象を確認してください。",
    );
  operation = {
    ...operation,
    status: "running",
    files: operation.files.map((file) => {
      const current = currentPlan.files.find(
        (item) => item.fileId === file.fileId,
      );
      // Shared files become more protected, never less protected during a retry.
      return current?.status === "protected"
        ? { ...file, status: "protected", error: current.error }
        : file;
    }),
  };
  state = setOperation(state, operation);
  await executor.onCommit(state); // Durable intent before any Drive mutation.
  for (let index = 0; index < operation.files.length; index++) {
    const file = operation.files[index];
    if (file.status === "protected" || file.status === "trashed") continue;
    let updated: CleanupFile;
    try {
      await executor.trashFile(file.fileId);
      updated = { ...file, status: "trashed", error: undefined };
    } catch (error) {
      updated = {
        ...file,
        status: "failed",
        error:
          error instanceof Error
            ? error.message.slice(0, 500)
            : "Driveのファイルをゴミ箱へ移動できませんでした。",
      };
    }
    operation = {
      ...operation,
      files: operation.files.map((item, position) =>
        position === index ? updated : item,
      ),
    };
    state = setOperation(state, operation);
    // Preserve all mappings; mark only files actually moved to trash.
    if (updated.status === "trashed")
      state = {
        ...state,
        artifacts: state.artifacts?.map((artifact) =>
          artifact.driveFileId === file.fileId
            ? { ...artifact, deleted: true }
            : artifact,
        ),
      };
    await executor.onCommit(state);
  }
  const complete = operation.files.every(
    (file) => file.status === "trashed" || file.status === "protected",
  );
  const now = new Date().toISOString();
  operation = {
    ...operation,
    status: complete ? "complete" : "failed",
    ...(complete ? { completedAt: now } : {}),
  };
  state = setOperation(state, operation);
  if (complete) {
    const selected = new Set(operation.collectionIds);
    state = {
      ...state,
      collections: state.collections.map((collection) =>
        selected.has(collection.id)
          ? {
              ...collection,
              archivedAt: collection.archivedAt ?? now,
              deletedAt: now,
              tokens: collection.tokens.map((token) => ({
                ...token,
                active: false,
              })),
            }
          : collection,
      ),
    };
  }
  state = {
    ...state,
    events: [
      ...state.events,
      changeEvent(
        complete ? "complete_collection_cleanup" : "partial_collection_cleanup",
        operation.id,
        { actor: operation.actor, reason: operation.reason },
        null,
        {
          files: operation.files.map((file) => ({
            id: file.fileId,
            status: file.status,
          })),
          logicalDeletionComplete: complete,
        },
      ),
    ],
  };
  await executor.onCommit(state);
  return state;
}

export function withSchoolYear(state: AppState, value: string): AppState {
  const schoolYear = value.trim();
  if (schoolYear && !/^(19|20|21)\d{2}$/.test(schoolYear))
    throw new Error("年度は西暦4桁で入力してください。");
  return {
    ...state,
    settings: { ...state.settings, schoolYear: schoolYear || undefined },
  };
}
