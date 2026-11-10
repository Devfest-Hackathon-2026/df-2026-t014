import type { AppState, ScanBatch, ScanPage, ScanSource } from "./types";

export interface SharedScanContext {
  hash: string;
  pageCount: number;
  collectionId: string;
}
export interface SharedPageOwner {
  sourcePage: number;
  batchId: string;
  collectionId: string;
  resolution: "accepted" | "ignored";
}

/** Only a registered source identity in this workspace permits another view's original PDF. */
export function sharedScanViews(
  state: Pick<AppState, "batches" | "scanSources">,
  batch: ScanBatch,
): ScanBatch[] {
  if (!batch.sourceId) return [batch]; // Legacy views keep their own access path until linked.
  const source = state.scanSources?.find(
    (item) =>
      item.id === batch.sourceId &&
      item.hash === batch.hash &&
      item.pageCount === batch.pageCount,
  );
  if (!source)
    throw new Error("元スキャンID・hash・ページ数の対応を確認できません。");
  return state.batches.filter(
    (view) =>
      view.sourceId === source.id &&
      view.hash === source.hash &&
      view.pageCount === source.pageCount,
  );
}

function matchingViews(
  state: AppState,
  hash: string,
  pageCount: number,
): ScanBatch[] {
  if (!hash || !Number.isSafeInteger(pageCount) || pageCount < 1)
    throw new Error("元スキャンのhashとページ数を確認してください。");
  const views = state.batches.filter((batch) => batch.hash === hash);
  if (
    views.some((batch) => batch.pageCount !== pageCount) ||
    state.scanSources?.some(
      (source) => source.hash === hash && source.pageCount !== pageCount,
    )
  )
    throw new Error(
      "同じ元スキャンのページ数が一致しません。台帳を確認してください。",
    );
  return views;
}

/** Automatic spacer/foreign exclusions are view-local. Only an explicit teacher exclusion owns the source page. */
function isGlobalExclusion(
  state: AppState,
  batch: ScanBatch,
  page: ScanPage,
): boolean {
  if (
    page.resolution !== "ignored" ||
    page.handledBy ||
    page.exclusionScope === "collection"
  )
    return false;
  if (page.exclusionScope === "source") return true;
  // Legacy explicit reviews have audit evidence; never infer a global exclusion from decoder output alone.
  return (
    !["spacer", "foreign"].includes(page.status) &&
    Boolean(
      page.reviewedBy ||
      page.reviewReason ||
      state.events.some((event) => {
        if (
          event.action === "ignore_page" &&
          event.targetId === `${batch.id}:${page.sourcePage}`
        )
          return true;
        if (event.action !== "replace_receipt") return false;
        try {
          const detail = JSON.parse(event.detail) as {
            previous?: { batchId?: string; sourcePage?: number };
          };
          return (
            detail.previous?.batchId === batch.id &&
            detail.previous.sourcePage === page.sourcePage
          );
        } catch {
          return false;
        }
      }),
    )
  );
}

export function sharedPageOwners(
  state: AppState,
  hash: string,
  pageCount: number,
): SharedPageOwner[] {
  const views = matchingViews(state, hash, pageCount);
  const byId = new Map(views.map((batch) => [batch.id, batch]));
  const owners = new Map<number, SharedPageOwner>();
  for (const receipt of state.receipts) {
    const batch = byId.get(receipt.batchId);
    if (!batch) continue;
    if (owners.has(receipt.sourcePage))
      throw new Error(
        "同じ元PDFページが複数の受領記録に使われています。元の記録を確認してください。",
      );
    owners.set(receipt.sourcePage, {
      sourcePage: receipt.sourcePage,
      batchId: batch.id,
      collectionId: batch.collectionId,
      resolution: "accepted",
    });
  }
  for (const batch of [...views].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  ))
    for (const page of batch.pages) {
      if (!owners.has(page.sourcePage) && isGlobalExclusion(state, batch, page))
        owners.set(page.sourcePage, {
          sourcePage: page.sourcePage,
          batchId: batch.id,
          collectionId: batch.collectionId,
          resolution: "ignored",
        });
    }
  return [...owners.values()].sort((a, b) => a.sourcePage - b.sourcePage);
}

export function prepareSharedScanReview(
  state: AppState,
  pages: ScanPage[],
  context: SharedScanContext,
): {
  pages: ScanPage[];
  sourceId?: string;
  handledPages: SharedPageOwner[];
  unprocessedCount: number;
} {
  const owners = sharedPageOwners(state, context.hash, context.pageCount);
  const handledPages = owners.filter(
    (owner) => owner.collectionId !== context.collectionId,
  );
  const positions = new Set<number>();
  const normalized = pages.map((page) => {
    if (
      !Number.isSafeInteger(page.sourcePage) ||
      page.sourcePage < 1 ||
      page.sourcePage > context.pageCount ||
      positions.has(page.sourcePage)
    )
      throw new Error("元PDFのページ位置が不正です。");
    positions.add(page.sourcePage);
    const owner = handledPages.find(
      (owner) => owner.sourcePage === page.sourcePage,
    );
    if (owner) {
      const title =
        state.collections.find(
          (collection) => collection.id === owner.collectionId,
        )?.title ?? "別の配布物";
      return {
        ...page,
        status: "foreign" as const,
        resolution: "ignored" as const,
        exclusionScope: "collection" as const,
        handledBy: {
          batchId: owner.batchId,
          collectionId: owner.collectionId,
          resolution: owner.resolution,
        },
        reason: `「${title}」で${owner.resolution === "accepted" ? "記録済み" : "元PDF全体から除外済み"}です。変更は元の配布物で行ってください。`,
      };
    }
    if (page.handledBy) {
      const { handledBy: _handled, exclusionScope: _scope, ...fresh } = page;
      return {
        ...fresh,
        status: "unreadable" as const,
        resolution: "pending" as const,
        reason:
          "元の処理が取り消されました。同じPDFを再解析するか、紙を確認して割り当ててください。",
      };
    }
    return page;
  });
  return {
    pages: normalized,
    sourceId: state.scanSources?.find((source) => source.hash === context.hash)
      ?.id,
    handledPages,
    unprocessedCount: Math.max(0, context.pageCount - owners.length),
  };
}

/** Creates the fixed class/hash source identity on first commit and links legacy collection views lazily. */
export function linkSharedScanSource(
  state: AppState,
  batch: ScanBatch,
): { state: AppState; batch: ScanBatch; source: ScanSource } {
  const views = matchingViews(state, batch.hash, batch.pageCount);
  const known = state.scanSources?.find((source) => source.hash === batch.hash);
  if (batch.sourceId && known && batch.sourceId !== known.id)
    throw new Error("元スキャンIDが台帳と一致しません。");
  const first = [...views, batch].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  )[0];
  const source = known ?? {
    id: batch.sourceId ?? `scan-source:${first.id}`,
    hash: batch.hash,
    pageCount: batch.pageCount,
    fileName: first.fileName,
    createdAt: first.createdAt,
  };
  if (
    state.scanSources?.some(
      (item) => item.id === source.id && item.hash !== source.hash,
    )
  )
    throw new Error("元スキャンIDが別のPDFと重複しています。");
  const changed = !known || views.some((view) => view.sourceId !== source.id);
  const next = changed
    ? {
        ...state,
        scanSources: known
          ? state.scanSources
          : [...(state.scanSources ?? []), source],
        batches: state.batches.map((view) =>
          view.hash === batch.hash ? { ...view, sourceId: source.id } : view,
        ),
      }
    : state;
  return { state: next, batch: { ...batch, sourceId: source.id }, source };
}

export function validateSharedScanReferences(state: AppState): void {
  const sources = state.scanSources ?? [];
  if (
    new Set(sources.map((source) => source.id)).size !== sources.length ||
    new Set(sources.map((source) => source.hash)).size !== sources.length
  )
    throw new Error("元スキャンID/hashが重複しています。");
  for (const batch of state.batches) {
    if (
      batch.sourceId &&
      !sources.some(
        (source) =>
          source.id === batch.sourceId &&
          source.hash === batch.hash &&
          source.pageCount === batch.pageCount,
      )
    )
      throw new Error("元スキャン参照が一致しません。");
    for (const page of batch.pages) {
      if (!page.handledBy) continue;
      const owner = state.batches.find(
        (candidate) => candidate.id === page.handledBy!.batchId,
      );
      if (
        page.resolution !== "ignored" ||
        !owner ||
        owner.collectionId !== page.handledBy.collectionId ||
        owner.collectionId === batch.collectionId ||
        owner.hash !== batch.hash ||
        owner.pageCount !== batch.pageCount ||
        !owner.pages.some(
          (candidate) => candidate.sourcePage === page.sourcePage,
        )
      )
        throw new Error("処理済みページの元記録を確認できません。");
    }
  }
  for (const batch of new Map(
    state.batches.map((batch) => [batch.hash, batch]),
  ).values())
    sharedPageOwners(state, batch.hash, batch.pageCount);
}
