import type { Receipt, ScanBatch, ScanPage } from "./types";

export interface ReviewRecoveryContext {
  hash: string;
  collectionId: string;
  versionId: string;
}

function sameIssuedPage(a: Receipt, b: Receipt): boolean {
  return (
    a.collectionId === b.collectionId &&
    a.versionId === b.versionId &&
    a.studentId === b.studentId &&
    a.pageNumber === b.pageNumber
  );
}

/**
 * Reuses review decisions only for the exact same input and target collection.
 * Receipts are the current authority; a saved review is not proof of an active receipt.
 * The caller supplies the freshly computed SHA-256 hash, never a cached filename match.
 */
export function restoreReviewedPages(
  pages: ScanPage[],
  oldBatch: ScanBatch | undefined,
  receipts: Receipt[],
  context: ReviewRecoveryContext,
): ScanPage[] {
  if (
    !oldBatch ||
    !context.hash ||
    !context.collectionId ||
    !context.versionId ||
    oldBatch.hash !== context.hash ||
    oldBatch.collectionId !== context.collectionId ||
    oldBatch.pageCount !== pages.length ||
    oldBatch.pageCount < 1
  )
    return pages;

  const currentPositions = new Set<number>();
  for (const page of pages) {
    if (
      !Number.isSafeInteger(page.sourcePage) ||
      page.sourcePage < 1 ||
      page.sourcePage > oldBatch.pageCount ||
      currentPositions.has(page.sourcePage)
    )
      return pages;
    currentPositions.add(page.sourcePage);
  }

  return pages.map((page) => {
    const savedMatches = oldBatch.pages.filter(
      (saved) => saved.sourcePage === page.sourcePage,
    );
    if (savedMatches.length !== 1) return page;
    const saved = savedMatches[0];
    // A cross-collection marker is a live reference, not an exclusion decision in this view.
    if (saved.handledBy) return page;
    if (saved.resolution === "ignored") {
      // Preserve exclusion, but retain the new decoder's metadata and the new image.
      return {
        ...page,
        resolution: "ignored",
        reason: saved.reason ?? page.reason,
        ...(saved.exclusionScope
          ? { exclusionScope: saved.exclusionScope }
          : {}),
        ...(saved.reviewReason ? { reviewReason: saved.reviewReason } : {}),
        ...(saved.reviewedBy ? { reviewedBy: saved.reviewedBy } : {}),
      };
    }
    if (
      saved.resolution === "pending" &&
      saved.reviewReason?.trim() &&
      saved.reviewedBy?.trim() &&
      !receipts.some(
        (receipt) =>
          receipt.batchId === oldBatch.id &&
          receipt.sourcePage === page.sourcePage,
      )
    ) {
      // An explicit hold survives a handoff and reanalysis of the same PDF.
      // Keep current decoding/image metadata; an unreviewed pending page stays fresh.
      return {
        ...page,
        resolution: "pending",
        reviewReason: saved.reviewReason,
        reviewedBy: saved.reviewedBy,
        reason: saved.reviewReason,
      };
    }
    if (
      saved.resolution !== "accepted" ||
      saved.status !== "matched" ||
      saved.collectionId !== context.collectionId ||
      saved.versionId !== context.versionId ||
      !saved.studentId ||
      !Number.isSafeInteger(saved.pageNumber) ||
      (saved.pageNumber ?? 0) < 1
    )
      return page;

    const sourceReceipts = receipts.filter(
      (receipt) =>
        receipt.batchId === oldBatch.id &&
        receipt.sourcePage === page.sourcePage,
    );
    if (sourceReceipts.length !== 1) return page;
    const receipt = sourceReceipts[0];
    if (
      receipt.collectionId !== context.collectionId ||
      receipt.versionId !== context.versionId ||
      receipt.studentId !== saved.studentId ||
      receipt.pageNumber !== saved.pageNumber ||
      (saved.manual === true) !== (receipt.method === "manual")
    )
      return page;

    // Even inconsistent imported state must not reactivate evidence superseded by another batch.
    const activeForIssuedPage = receipts.filter((candidate) =>
      sameIssuedPage(candidate, receipt),
    );
    if (
      activeForIssuedPage.length !== 1 ||
      activeForIssuedPage[0].id !== receipt.id
    )
      return page;

    if (receipt.method === "qr") {
      if (!receipt.token || saved.token !== receipt.token) return page;
      // A newly decoded conflicting token deserves review, rather than a silent history override.
      if (page.token !== undefined && page.token !== receipt.token) return page;
    } else if (receipt.token !== undefined && saved.token !== receipt.token) {
      return page;
    }

    // Manual matches without a readable QR are restored only after the checks above prove
    // that this exact source page already has the same current, explicitly reviewed receipt.
    return {
      ...saved,
      id: page.id,
      sourcePage: page.sourcePage,
      thumbnail: page.thumbnail,
    };
  });
}
