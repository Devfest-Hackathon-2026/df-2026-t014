import type { AppState, ChangeContext, Receipt, ScanPage } from "./types";
import { changeEvent, requireChangeContext } from "./workflows";
import { sharedPageOwners } from "./sharedScan";
import { assertCollectionWritable } from "./lifecycle";

export type PageRevisionAction =
  | { kind: "reassign"; studentId: string; pageNumber: number }
  | { kind: "ignore" }
  | { kind: "reopen" };

/** Explicitly retracts the old source-page receipt before correcting it; never overwrites another source. */
export function reviseReviewedPage(
  state: AppState,
  batchId: string,
  sourcePage: number,
  action: PageRevisionAction,
  context: ChangeContext,
): AppState {
  requireChangeContext(context);
  const batch = state.batches.find((item) => item.id === batchId);
  const previous = batch?.pages.find((page) => page.sourcePage === sourcePage);
  const collection = state.collections.find(
    (item) => item.id === batch?.collectionId,
  );
  if (!batch || !previous || !collection)
    throw new Error("訂正する回収ページが見つかりません。");
  assertCollectionWritable(state, collection.id);
  const owner = sharedPageOwners(state, batch.hash, batch.pageCount).find(
    (owner) => owner.sourcePage === sourcePage,
  );
  if (owner && owner.batchId !== batch.id)
    throw new Error(
      "この元PDFページは別の配布物で処理済みです。元の配布物で理由を記録して再確認へ戻してください。",
    );
  const oldReceipts = state.receipts.filter(
    (receipt) =>
      receipt.batchId === batchId && receipt.sourcePage === sourcePage,
  );
  let receipts = state.receipts.filter(
    (receipt) => !oldReceipts.some((old) => old.id === receipt.id),
  );
  const { thumbnail: _thumbnail, ...before } = previous;
  let next: ScanPage = {
    id: previous.id,
    sourcePage,
    status: "unreadable",
    resolution: action.kind === "ignore" ? "ignored" : "pending",
    reason: context.reason,
    reviewReason: context.reason,
    reviewedBy: context.actor,
    ...(action.kind === "ignore" ? { exclusionScope: "source" as const } : {}),
  };
  if (action.kind === "reassign") {
    if (collection.status === "closed")
      throw new Error("終了した配布物を再開してから訂正してください。");
    if (collection.status === "draft" || collection.status === "generating")
      throw new Error("発行が完了してから訂正してください。");
    const token = collection.tokens.find(
      (item) =>
        item.studentId === action.studentId &&
        item.pageNumber === action.pageNumber &&
        item.kind === "content" &&
        item.active !== false,
    );
    if (
      !token ||
      !collection.recipients.some((student) => student.id === action.studentId)
    )
      throw new Error("訂正先の生徒・ページが発行されていません。");
    if (collection.recipientStates?.[action.studentId] === "superseded")
      throw new Error("旧版です。受理する版を変更してから訂正してください。");
    if (
      receipts.some(
        (receipt) =>
          receipt.collectionId === collection.id &&
          receipt.versionId === collection.versionId &&
          receipt.studentId === action.studentId &&
          receipt.pageNumber === action.pageNumber,
      )
    )
      throw new Error(
        "訂正先は別の画像で記録済みです。先にその記録を確認してください。",
      );
    const receipt: Receipt = {
      id: crypto.randomUUID(),
      collectionId: collection.id,
      versionId: collection.versionId,
      studentId: action.studentId,
      pageNumber: action.pageNumber,
      token: token.token,
      batchId,
      sourcePage,
      recordedAt: new Date().toISOString(),
      method: "manual",
      actor: context.actor,
    };
    receipts = [...receipts, receipt];
    next = {
      ...next,
      ...token,
      id: previous.id,
      sourcePage,
      status: "matched",
      resolution: "accepted",
      manual: true,
    };
  }
  const event = changeEvent(
    `page_${action.kind}`,
    `${batchId}:${sourcePage}`,
    context,
    { page: before, receipts: oldReceipts },
    {
      page: next,
      receipts: receipts.filter(
        (receipt) =>
          receipt.batchId === batchId && receipt.sourcePage === sourcePage,
      ),
    },
  );
  return {
    ...state,
    receipts,
    batches: state.batches.map((item) =>
      item.id === batchId
        ? {
            ...item,
            recordedAt: new Date().toISOString(),
            pages: item.pages.map((page) =>
              page.sourcePage === sourcePage ? next : page,
            ),
          }
        : item,
    ),
    events: [...state.events, event],
  };
}
