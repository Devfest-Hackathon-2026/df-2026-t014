import type {
  AppState,
  Collection,
  DriveArtifact,
  Receipt,
  SaveOperation,
} from "./domain/types";
import type { GoogleLedger, GoogleWorkspaceClient } from "./google/client";
import {
  beginSaveOperation,
  registerDriveArtifact,
  reserveOperationFile,
  updateSaveOperation,
  receiptSetKey,
} from "./domain/operations";
import { setCollectionStatus } from "./domain/workflows";
import { assertCollectionWritable } from "./domain/lifecycle";
import { sharedScanViews } from "./domain/sharedScan";
import { GoogleApiError } from "./google/errors";
import { extractStudentPdf } from "./pdfClient";

export const driveLink = (id: string) =>
  `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`;
export async function hashPdf(bytes: Uint8Array): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
export interface CloudContext {
  client: GoogleWorkspaceClient;
  ledger: GoogleLedger | null;
  onLedger: (ledger: GoogleLedger) => void;
  onState: (state: AppState, committed?: boolean) => void;
  onMessage?: (message: string) => void;
  scanCache: Map<string, Uint8Array>;
}

/** One teacher/session owns a ledger. A changed remote revision stops the write. */
export async function persistCloudState(
  ctx: CloudContext,
  input: AppState,
  operationId: string = crypto.randomUUID(),
  retryCommitId?: string,
): Promise<AppState> {
  const identity = ctx.client.getIdentity();
  if (!identity) throw new Error("Googleに再接続して保存を続けてください。");
  if (
    input.settings?.googleAccountId &&
    input.settings.googleAccountId !== identity.id
  )
    throw new Error(
      "このクラスの台帳とGoogleアカウントが異なります。元のアカウントで接続してください。",
    );
  let state = input;
  if (!ctx.ledger) {
    if (input.settings?.ledgerId) {
      const loaded = await ctx.client.readLedger(input.settings.ledgerId);
      if (
        !input.settings.ledgerRevision ||
        loaded.revisionHash !== input.settings.ledgerRevision
      )
        throw new Error(
          "台帳を別のセッションで更新した可能性があります。既存の台帳を開き直してから保存してください。",
        );
      ctx.ledger = loaded.ledger;
    } else {
      const classId = state.classId ?? crypto.randomUUID();
      state = { ...state, classId };
      ctx.ledger = await ctx.client.createLedger(
        `PaperFlow_${state.className}`,
        {
          idempotencyKey: `ledger:${classId}`,
          parentId: state.settings?.folderId,
        },
      );
    }
    ctx.onLedger(ctx.ledger);
  }
  state = {
    ...state,
    settings: {
      ...state.settings,
      ledgerId: ctx.ledger.spreadsheetId,
      googleAccountId: identity.id,
    },
  };
  const result = await ctx.client.writeLedger(ctx.ledger, state, {
    expectedRevisionHash: ctx.ledger.revisionHash,
    operationId: retryCommitId ?? `${operationId}:${crypto.randomUUID()}`,
  });
  ctx.ledger = { ...ctx.ledger, revisionHash: result.revisionHash };
  ctx.onLedger(ctx.ledger);
  state = {
    ...state,
    settings: { ...state.settings, ledgerRevision: result.revisionHash },
  };
  ctx.onState(state, true);
  return state;
}

async function collectionFolder(
  ctx: CloudContext,
  input: AppState,
  collectionId: string,
): Promise<AppState> {
  let state = input;
  if (!state.settings?.folderId) {
    const id = state.classId ?? crypto.randomUUID();
    const root = await ctx.client.createFolder(
      `PaperFlow_${state.settings?.schoolYear ?? new Date().getFullYear()}_${state.className}`,
      { idempotencyKey: `class-folder:${id}` },
    );
    state = {
      ...state,
      classId: id,
      settings: { ...state.settings, folderId: root.id },
    };
  }
  const collection = state.collections.find((c) => c.id === collectionId)!;
  if (!collection.folderId) {
    const folder = await ctx.client.createFolder(
      `${collection.title}_${collection.id.slice(0, 8)}`,
      {
        parentId: state.settings!.folderId,
        idempotencyKey: `collection-folder:${collection.id}`,
      },
    );
    state = {
      ...state,
      collections: state.collections.map((c) =>
        c.id === collectionId ? { ...c, folderId: folder.id } : c,
      ),
    };
  }
  return state;
}

/** Original and print PDF IDs are fixed in Sheets before any binary upload. */
export async function saveIssuedPdf(
  ctx: CloudContext,
  input: AppState,
  collection: Collection,
  print: Uint8Array,
  source?: Uint8Array,
): Promise<AppState> {
  assertCollectionWritable(input, collection.id);
  let state = await collectionFolder(ctx, input, collection.id);
  const existing = state.operations?.find(
    (op) => op.collectionId === collection.id && op.kind === "print",
  );
  const started = beginSaveOperation(state, {
    id: existing?.id,
    collectionId: collection.id,
    kind: "print",
    storageMode: "drive",
  });
  state = started.state;
  const opId = started.operation.id;
  for (const key of source ? ["original", "print"] : ["print"]) {
    if (!state.operations!.find((op) => op.id === opId)!.plannedFileIds?.[key])
      state = reserveOperationFile(
        state,
        opId,
        key,
        await ctx.client.generateFileId(),
      );
  }
  state = updateSaveOperation(state, opId, {
    recordStatus: "recorded",
    archiveStatus: "saving",
    error: undefined,
  });
  state = await persistCloudState(ctx, state, `${opId}:plan`);
  try {
    const folder = await ctx.client.createFolder("原稿・印刷", {
      parentId: state.collections.find((c) => c.id === collection.id)!.folderId,
      idempotencyKey: `print-folder:${collection.id}`,
    });
    for (const kind of (source ? ["original", "print"] : ["print"]) as Array<
      "original" | "print"
    >) {
      const fileId = state.operations!.find((op) => op.id === opId)!
        .plannedFileIds![kind];
      if (state.artifacts?.some((a) => a.driveFileId === fileId && !a.deleted))
        continue;
      ctx.onMessage?.(
        kind === "original"
          ? "原稿をDriveに保存しています"
          : "印刷PDFをDriveに保存しています",
      );
      const name = `${kind === "original" ? "原稿" : "印刷用"}_${collection.versionLabel ?? "v1"}_${collection.id.slice(0, 8)}.pdf`;
      await ctx.client.uploadPdf({
        name,
        bytes: kind === "original" ? source! : print,
        parentId: folder.id,
        fileId,
        idempotencyKey: `${opId}:${kind}`,
      });
      state = registerDriveArtifact(state, {
        kind,
        collectionId: collection.id,
        operationId: opId,
        driveFileId: fileId,
        name,
        receiptIds: [],
      });
    }
    state = updateSaveOperation(state, opId, {
      archiveStatus: "saved",
      error: undefined,
    });
    state = setCollectionStatus(state, collection.id, "ready", {
      actor: ctx.client.getIdentity()!.email,
      reason: "印刷PDFと対応台帳の保存を確認",
    });
    return await persistCloudState(ctx, state, `${opId}:complete`);
  } catch (error) {
    state = updateSaveOperation(state, opId, {
      archiveStatus: "failed",
      error: "原稿・印刷PDFの保存を再試行してください。",
    });
    ctx.onState(state);
    try {
      await persistCloudState(ctx, state, `${opId}:failed`);
    } catch {
      /* The durable plan remains in Sheets. */
    }
    throw error;
  }
}

export async function sourceForBatch(
  ctx: CloudContext,
  state: AppState,
  batchId: string,
): Promise<Uint8Array> {
  const batch = state.batches.find((b) => b.id === batchId);
  if (!batch) throw new Error("回収元の記録が見つかりません。");
  const views = [
    batch,
    ...sharedScanViews(state, batch).filter((view) => view.id !== batch.id),
  ];
  let bytes = views
    .map((view) => ctx.scanCache.get(view.id))
    .find((value) => !!value);
  if (!bytes) {
    const fileIds = [
      ...new Set(
        views.flatMap((view) =>
          view.sourceDriveFileId ? [view.sourceDriveFileId] : [],
        ),
      ),
    ];
    if (fileIds.length && !ctx.client?.getIdentity())
      throw new Error(
        "Googleに再接続して共通スキャンの保存済み原本を読み込んでください。",
      );
    for (const fileId of fileIds) {
      try {
        bytes = await ctx.client.downloadPdf(fileId);
        break;
      } catch (error) {
        // A missing original may have another saved copy. Auth/permission failures must stop.
        if (!(error instanceof GoogleApiError && error.status === 404))
          throw error;
      }
    }
  }
  if (!bytes)
    throw new Error(
      `原本再選択待ち: ${batch.fileName} を回収画面から選び直してください。`,
    );
  if ((await hashPdf(bytes)) !== batch.hash)
    throw new Error("選択した回収PDFが記録した原本と一致しません。");
  ctx.scanCache.set(batchId, bytes);
  return bytes;
}

export async function mergeReceipts(
  ctx: CloudContext,
  state: AppState,
  receipts: Receipt[],
  createdAt = "2026-01-01T00:00:00.000Z",
): Promise<Uint8Array> {
  const { PDFDocument } = await import("pdf-lib");
  const result = await PDFDocument.create();
  result.setCreationDate(new Date(createdAt));
  result.setModificationDate(new Date(createdAt));
  const sources = new Map<
    string,
    Awaited<ReturnType<typeof PDFDocument.load>>
  >();
  for (const receipt of [...receipts].sort(
    (a, b) => a.pageNumber - b.pageNumber,
  )) {
    let pdf = sources.get(receipt.batchId);
    if (!pdf) {
      pdf = await PDFDocument.load(
        await sourceForBatch(ctx, state, receipt.batchId),
      );
      sources.set(receipt.batchId, pdf);
    }
    const [page] = await result.copyPages(pdf, [receipt.sourcePage - 1]);
    result.addPage(page);
  }
  return result.save();
}

/** Recording commits first; an optional archive failure never rolls receipts back. */
export async function saveCollectionRecord(
  ctx: CloudContext,
  input: AppState,
  collectionId: string,
  batchId: string,
  withArchive: boolean,
  attempt?: {
    operationId?: string;
    commitId: string;
    onPrepared(state: AppState, operationId: string): void;
  },
): Promise<AppState> {
  assertCollectionWritable(input, collectionId);
  const started = beginSaveOperation(input, {
    id: attempt?.operationId,
    collectionId,
    batchId,
    storageMode: withArchive ? "drive" : "record-only",
    kind: "record",
  });
  // Keep the exact timestamped snapshot on retries so an ambiguous prior
  // commit can be recognized by its unchanged operation ID and state hash.
  let state =
    started.operation.recordStatus === "recorded"
      ? started.state
      : updateSaveOperation(started.state, started.operation.id, {
          recordStatus: "recorded",
        });
  const prepared = (next: AppState) =>
    attempt?.onPrepared(next, started.operation.id);
  prepared(state);
  if (withArchive)
    state = await prepareArchive(ctx, state, started.operation.id, prepared);
  prepared(state);
  state = await persistCloudState(
    ctx,
    state,
    `${started.operation.id}:record`,
    attempt?.commitId,
  );
  return withArchive ? resumeArchive(ctx, state, started.operation.id) : state;
}

async function prepareArchive(
  ctx: CloudContext,
  input: AppState,
  operationId: string,
  onPrepared?: (state: AppState) => void,
): Promise<AppState> {
  const operation = input.operations!.find((op) => op.id === operationId)!;
  let state = input;
  const receipts = state.receipts.filter((r) =>
    operation.receiptIds.includes(r.id),
  );
  const batchIds = new Set([
    ...receipts.map((r) => r.batchId),
    ...(operation.batchId ? [operation.batchId] : []),
  ]);
  // Only a new, unallocated plan may adopt another view's verified original.
  // A durable reservation may already have uploaded after a lost response;
  // keeping that ID is more important than deduplicating a later retry.
  if (
    operation.archiveStatus === "pending" &&
    !Object.keys(operation.plannedFileIds ?? {}).length
  ) {
    let linked = false;
    for (const id of batchIds) {
      const batch = state.batches.find((item) => item.id === id)!;
      if (
        batch.sourceDriveFileId ||
        state.operations?.some((item) => item.plannedFileIds?.[`source:${id}`])
      )
        continue;
      const fileIds = [
        ...new Set(
          sharedScanViews(state, batch).flatMap((view) =>
            view.id !== id && view.sourceDriveFileId
              ? [view.sourceDriveFileId]
              : [],
          ),
        ),
      ];
      if (!fileIds.length) continue;
      const account = ctx.client.getIdentity();
      if (!account)
        throw new Error(
          "Googleに再接続して共通スキャンの原本を確認してください。",
        );
      if (
        (state.settings?.googleAccountId &&
          state.settings.googleAccountId !== account.id) ||
        (ctx.ledger?.accountId && ctx.ledger.accountId !== account.id)
      )
        throw new Error("このクラスの台帳とGoogleアカウントが異なります。");
      for (const fileId of fileIds) {
        let bytes: Uint8Array;
        try {
          bytes = await ctx.client.downloadPdf(fileId);
        } catch (error) {
          if (error instanceof GoogleApiError && error.status === 404) continue;
          throw error;
        }
        if ((await hashPdf(bytes)) !== batch.hash)
          throw new Error(
            "保存済みの共通スキャンが記録した原本と一致しません。",
          );
        if (ctx.client.getIdentity()?.id !== account.id)
          throw new Error(
            "確認中にGoogleアカウントが変更されました。再接続してください。",
          );
        state = {
          ...state,
          batches: state.batches.map((item) =>
            item.id === id ? { ...item, sourceDriveFileId: fileId } : item,
          ),
        };
        ctx.scanCache.set(id, bytes);
        linked = true;
        break;
      }
    }
    // Persist the reference before allocating/uploading any new outputs.
    if (linked)
      state = await persistCloudState(
        ctx,
        state,
        `${operationId}:shared-source`,
      );
  }
  state = await collectionFolder(ctx, state, operation.collectionId);
  onPrepared?.(state);
  const keys: string[] = [];
  for (const id of batchIds)
    if (!state.batches.find((b) => b.id === id)?.sourceDriveFileId)
      keys.push(`source:${id}`);
  for (const id of new Set(receipts.map((r) => r.studentId)))
    keys.push(`student:${id}`);
  const pending = state.batches
    .find((b) => b.id === operation.batchId)
    ?.pages.some((p) => p.resolution === "pending");
  if (pending) keys.push(`unresolved:${operation.batchId}`);
  for (const key of keys)
    if (
      !state.operations!.find((op) => op.id === operationId)!.plannedFileIds?.[
        key
      ]
    ) {
      state = reserveOperationFile(
        state,
        operationId,
        key,
        await ctx.client.generateFileId(),
      );
      onPrepared?.(state);
    }
  return state;
}

function unresolvedPlanKey(
  state: AppState,
  operation: SaveOperation,
): string | null {
  if (operation.unresolvedPages !== undefined)
    return JSON.stringify([...operation.unresolvedPages].sort((a, b) => a - b));
  // A legacy unresolved reservation may have uploaded after a lost response.
  // Its original page set cannot be inferred from today's corrected review.
  if (
    Object.keys(operation.plannedFileIds ?? {}).some((key) =>
      key.startsWith("unresolved:"),
    ) ||
    state.artifacts?.some(
      (artifact) =>
        artifact.operationId === operation.id && artifact.kind === "unresolved",
    )
  )
    return null;
  return "[]";
}
function currentUnresolvedKey(state: AppState, batchId?: string): string {
  return JSON.stringify(
    (state.batches.find((batch) => batch.id === batchId)?.pages ?? [])
      .filter((page) => page.resolution === "pending")
      .map((page) => page.sourcePage)
      .sort((a, b) => a - b),
  );
}

export async function addArchive(
  ctx: CloudContext,
  state: AppState,
  collectionId: string,
  batchId: string,
): Promise<AppState> {
  assertCollectionWritable(state, collectionId);
  const collection = state.collections.find(
    (item) => item.id === collectionId,
  )!;
  const receipts = state.receipts.filter(
    (r) =>
      r.collectionId === collectionId && r.versionId === collection.versionId,
  );
  const key = receiptSetKey(receipts.map((r) => r.id));
  const matching = (state.operations ?? []).filter(
    (op) =>
      op.collectionId === collectionId &&
      op.batchId === batchId &&
      op.storageMode === "drive" &&
      op.kind !== "print" &&
      receiptSetKey(op.receiptIds) === key &&
      unresolvedPlanKey(state, op) === currentUnresolvedKey(state, batchId),
  );
  if (matching.some((op) => archiveIsComplete(state, op))) return state;
  const pending = [...matching]
    .reverse()
    .find((op) => op.archiveStatus !== "saved");
  if (pending) return resumeArchive(ctx, state, pending.id);
  const started = beginSaveOperation(state, {
    collectionId,
    batchId,
    storageMode: "drive",
    kind: "archive",
  });
  let next = updateSaveOperation(started.state, started.operation.id, {
    recordStatus: "recorded",
  });
  next = await prepareArchive(ctx, next, started.operation.id);
  next = await persistCloudState(ctx, next, `${started.operation.id}:plan`);
  return resumeArchive(ctx, next, started.operation.id);
}

function archiveIsComplete(state: AppState, operation: SaveOperation): boolean {
  if (operation.archiveStatus !== "saved") return false;
  const planned = Object.values(operation.plannedFileIds ?? {});
  return planned.length > 0
    ? planned.every((id) =>
        state.artifacts?.some(
          (artifact) => artifact.driveFileId === id && !artifact.deleted,
        ),
      )
    : !operation.receiptIds.length &&
        !!state.batches.find((b) => b.id === operation.batchId)
          ?.sourceDriveFileId;
}

export async function resumeArchive(
  ctx: CloudContext,
  input: AppState,
  operationId: string,
): Promise<AppState> {
  let state = input;
  let operation = state.operations?.find((op) => op.id === operationId);
  if (
    !operation ||
    operation.storageMode !== "drive" ||
    operation.kind === "print"
  )
    throw new Error("再試行する保管操作が見つかりません。");
  assertCollectionWritable(state, operation.collectionId);
  if (
    state.operations?.some(
      (other) =>
        other.id !== operation!.id &&
        other.kind !== "print" &&
        other.storageMode === "drive" &&
        other.collectionId === operation!.collectionId &&
        other.batchId === operation!.batchId &&
        receiptSetKey(other.receiptIds) ===
          receiptSetKey(operation!.receiptIds) &&
        unresolvedPlanKey(state, operation!) !== null &&
        unresolvedPlanKey(state, other) ===
          unresolvedPlanKey(state, operation!) &&
        archiveIsComplete(state, other),
    )
  )
    throw new Error(
      "同じ回収内容は別の保管操作で保存済みです。最新のPDFリンクを利用してください。古い計画の重複保存は停止しました。",
    );
  const collection = state.collections.find(
    (c) => c.id === operation!.collectionId,
  )!;
  try {
    const unresolvedKey = unresolvedPlanKey(state, operation);
    if (unresolvedKey === null)
      throw new Error(
        "この旧保存計画には未照合ページの固定情報がありません。回収画面の「現在の回収内容をDriveに保管」から新しい計画を開始してください。旧予定IDは変更しません。",
      );
    if (unresolvedKey !== currentUnresolvedKey(state, operation.batchId))
      throw new Error(
        "未照合ページの確認状態が変わっています。回収画面の「現在の回収内容をDriveに保管」から新しい計画を開始してください。旧予定IDは変更しません。",
      );
    if (
      operation.receiptIds.some(
        (id) => !state.receipts.some((r) => r.id === id),
      )
    )
      throw new Error(
        "採用ページが変更されています。現在の記録から新しい保管操作を開始してください。",
      );
    // A shared-source reference can commit before output allocation finishes.
    // Complete the plan first while retaining every previously reserved ID.
    const receipts = state.receipts.filter((r) =>
      operation!.receiptIds.includes(r.id),
    );
    const batchIds = new Set([
      ...receipts.map((r) => r.batchId),
      ...(operation.batchId ? [operation.batchId] : []),
    ]);
    const requiredKeys = [
      ...[...batchIds]
        .filter(
          (id) => !state.batches.find((b) => b.id === id)?.sourceDriveFileId,
        )
        .map((id) => `source:${id}`),
      ...[...new Set(receipts.map((r) => r.studentId))].map(
        (id) => `student:${id}`,
      ),
      ...(state.batches
        .find((b) => b.id === operation!.batchId)
        ?.pages.some((p) => p.resolution === "pending")
        ? [`unresolved:${operation.batchId}`]
        : []),
    ];
    if (requiredKeys.some((key) => !operation!.plannedFileIds?.[key])) {
      state = await prepareArchive(ctx, state, operationId);
      state = await persistCloudState(ctx, state, `${operationId}:plan`);
      operation = state.operations!.find((op) => op.id === operationId)!;
    }
    state = updateSaveOperation(state, operationId, {
      archiveStatus: "saving",
      error: undefined,
    });
    const parents = new Map<string, string>();
    for (const [key, fileId] of Object.entries(
      operation.plannedFileIds ?? {},
    )) {
      if (state.artifacts?.some((a) => a.driveFileId === fileId && !a.deleted))
        continue;
      const [kind, ...parts] = key.split(":");
      const id = parts.join(":");
      const folderName =
        kind === "source" ? "回収元" : kind === "student" ? "生徒別" : "未照合";
      let parentId = parents.get(folderName);
      if (!parentId) {
        parentId = (
          await ctx.client.createFolder(folderName, {
            parentId: collection.folderId,
            idempotencyKey: `${collection.id}:${folderName}`,
          })
        ).id;
        parents.set(folderName, parentId);
      }
      let bytes: Uint8Array;
      let artifact: Omit<DriveArtifact, "id" | "createdAt">;
      if (kind === "student") {
        const student = collection.recipients.find((s) => s.id === id)!;
        const receipts = state.receipts.filter(
          (r) => operation!.receiptIds.includes(r.id) && r.studentId === id,
        );
        if (
          receipts.length !==
            operation.receiptIds.filter(
              (rid) =>
                state.receipts.find((r) => r.id === rid)?.studentId === id,
            ).length ||
          !receipts.length
        )
          throw new Error(
            "採用ページが変更されています。現在の回収状態から新しい保管操作を開始してください。",
          );
        bytes = await mergeReceipts(ctx, state, receipts, operation.createdAt);
        artifact = {
          kind: "student",
          collectionId: collection.id,
          studentId: id,
          operationId,
          driveFileId: fileId,
          name: `${String(student.number).padStart(2, "0")}_${student.name}_${collection.versionLabel ?? "v1"}_${id.slice(-8)}_${operationId.slice(0, 8)}.pdf`,
          receiptIds: receipts.map((r) => r.id),
        };
      } else {
        const source = await sourceForBatch(ctx, state, id);
        const pages = operation.unresolvedPages ?? [];
        bytes =
          kind === "source" ? source : await extractStudentPdf(source, pages);
        artifact = {
          kind: kind === "source" ? "source-scan" : "unresolved",
          collectionId: collection.id,
          batchId: id,
          operationId,
          driveFileId: fileId,
          name: `${id}_${kind === "source" ? "回収元" : "未照合"}.pdf`,
          receiptIds: [],
        };
      }
      ctx.onMessage?.(`${folderName}のPDFを保存しています`);
      await ctx.client.uploadPdf({
        name: artifact.name,
        bytes,
        parentId,
        fileId,
        idempotencyKey: `${operationId}:${key}`,
      });
      state = registerDriveArtifact(state, artifact);
      state = await persistCloudState(ctx, state, `${operationId}:${key}:link`);
    }
    state = updateSaveOperation(state, operationId, {
      archiveStatus: "saved",
      error: undefined,
    });
    return await persistCloudState(ctx, state, `${operationId}:complete`);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "書類保管に失敗しました。";
    state = updateSaveOperation(state, operationId, {
      archiveStatus: message.startsWith("原本再選択")
        ? "source-required"
        : "failed",
      error: message,
    });
    ctx.onState(state);
    try {
      await persistCloudState(ctx, state, `${operationId}:failed`);
    } catch {
      /* Keep the committed record and resumable plan. */
    }
    throw error;
  }
}

export function operationLabel(op: SaveOperation): string {
  if (op.recordStatus !== "recorded") return "台帳の記録を再試行";
  return (
    {
      "not-requested": "記録のみ",
      pending: "保管待ち",
      saving: "保管中",
      saved: "保管済み",
      partial: "一部未保管",
      failed: "保管を再試行",
      "source-required": "原本再選択待ち",
    } as const
  )[op.archiveStatus];
}
