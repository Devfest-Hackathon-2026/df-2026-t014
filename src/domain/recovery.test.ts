import { describe, expect, it } from "vitest";
import { restoreReviewedPages } from "./recovery";
import type { ReviewRecoveryContext } from "./recovery";
import type { Receipt, ScanBatch, ScanPage } from "./types";

const context: ReviewRecoveryContext = {
  hash: "a".repeat(64),
  collectionId: "collection-a",
  versionId: "version-a",
};

function fixture(manual = false) {
  const saved: ScanPage = {
    id: "old-page-id",
    sourcePage: 1,
    status: "matched",
    resolution: "accepted",
    studentId: "student-a",
    pageNumber: 2,
    collectionId: context.collectionId,
    versionId: context.versionId,
    thumbnail: "old-image",
    ...(manual
      ? { manual: true, reason: "手動で照合しました" }
      : { token: "registered-token" }),
  };
  const fresh: ScanPage = {
    id: "fresh-page-id",
    sourcePage: 1,
    status: manual ? "unreadable" : "duplicate",
    resolution: "pending",
    thumbnail: "fresh-image",
    ...(manual ? {} : { token: "registered-token" }),
  };
  const batch: ScanBatch = {
    id: "old-batch",
    hash: context.hash,
    fileName: "same-file.pdf",
    pageCount: 1,
    createdAt: "2026-11-09T01:00:00Z",
    collectionId: context.collectionId,
    pages: [saved],
  };
  const receipt: Receipt = {
    id: "current-receipt",
    batchId: batch.id,
    sourcePage: 1,
    studentId: "student-a",
    pageNumber: 2,
    collectionId: context.collectionId,
    versionId: context.versionId,
    method: manual ? "manual" : "qr",
    recordedAt: "2026-11-09T01:01:00Z",
    ...(manual ? {} : { token: "registered-token" }),
  };
  return { saved, fresh, batch, receipt };
}

describe("restoring review decisions for the exact same PDF", () => {
  it("restores an accepted QR receipt using the new UI identity and thumbnail", () => {
    const { saved, fresh, batch, receipt } = fixture();
    const originals = structuredClone({ saved, fresh, batch, receipt });
    const result = restoreReviewedPages([fresh], batch, [receipt], context);
    expect(result[0]).toMatchObject({
      id: "fresh-page-id",
      thumbnail: "fresh-image",
      status: "matched",
      resolution: "accepted",
      studentId: "student-a",
      pageNumber: 2,
      collectionId: context.collectionId,
      versionId: context.versionId,
    });
    expect({ saved, fresh, batch, receipt }).toEqual(originals);
  });

  it("does not restore decisions across different bytes, collections or PDF page counts", () => {
    const { fresh, batch, receipt } = fixture();
    const pages = [fresh];
    expect(
      restoreReviewedPages(pages, batch, [receipt], {
        ...context,
        hash: "b".repeat(64),
      }),
    ).toBe(pages);
    expect(
      restoreReviewedPages(pages, batch, [receipt], {
        ...context,
        collectionId: "other-collection",
      }),
    ).toBe(pages);
    expect(
      restoreReviewedPages(
        pages,
        { ...batch, pageCount: 2 },
        [receipt],
        context,
      ),
    ).toBe(pages);
    expect(
      restoreReviewedPages(pages, batch, [receipt], { ...context, hash: "" }),
    ).toBe(pages);
    expect(restoreReviewedPages(pages, undefined, [receipt], context)).toBe(
      pages,
    );
  });

  it("requires exact collection, version, student and logical-page agreement with the current receipt", () => {
    const { fresh, batch, receipt } = fixture();
    for (const patch of [
      { collectionId: "other" },
      { versionId: "other" },
      { studentId: "other" },
      { pageNumber: 1 },
      { sourcePage: 2 },
      { batchId: "other" },
    ]) {
      expect(
        restoreReviewedPages(
          [fresh],
          batch,
          [{ ...receipt, ...patch }],
          context,
        )[0],
      ).toBe(fresh);
    }
    expect(
      restoreReviewedPages([fresh], batch, [receipt], {
        ...context,
        versionId: "new-version",
      })[0],
    ).toBe(fresh);
  });

  it("preserves an explicit ignore while retaining current image and decoder metadata", () => {
    const { fresh, batch } = fixture();
    batch.pages[0] = {
      ...batch.pages[0],
      resolution: "ignored",
      reason: "差し替え済みのため除外",
    };
    const result = restoreReviewedPages([fresh], batch, [], context)[0];
    expect(result).toMatchObject({
      id: fresh.id,
      status: fresh.status,
      thumbnail: fresh.thumbnail,
      resolution: "ignored",
      reason: "差し替え済みのため除外",
    });
    expect(result.studentId).toBeUndefined();
  });

  it("does not resurrect a receipt superseded by another scan, even if the saved page still says accepted", () => {
    const { fresh, batch, receipt } = fixture();
    const replacement = {
      ...receipt,
      id: "replacement",
      batchId: "newer-batch",
    };
    expect(
      restoreReviewedPages([fresh], batch, [replacement], context)[0],
    ).toBe(fresh);
    // A corrupt imported state containing both histories must also fail closed.
    expect(
      restoreReviewedPages([fresh], batch, [receipt, replacement], context)[0],
    ).toBe(fresh);
    expect(restoreReviewedPages([fresh], batch, [], context)[0]).toBe(fresh);
  });

  it("restores an earlier manual match without QR only when that exact manual receipt remains current", () => {
    const { fresh, batch, receipt } = fixture(true);
    expect(
      restoreReviewedPages([fresh], batch, [receipt], context)[0],
    ).toMatchObject({
      resolution: "accepted",
      manual: true,
      studentId: "student-a",
      pageNumber: 2,
      thumbnail: "fresh-image",
    });
    expect(restoreReviewedPages([fresh], batch, [], context)[0]).toBe(fresh);
    expect(
      restoreReviewedPages(
        [fresh],
        batch,
        [{ ...receipt, method: "qr", token: "invented-token" }],
        context,
      )[0],
    ).toBe(fresh);
    batch.pages[0] = { ...batch.pages[0], resolution: "pending" };
    expect(restoreReviewedPages([fresh], batch, [receipt], context)[0]).toBe(
      fresh,
    );
  });

  it("does not mask a newly decoded conflicting QR or inconsistent saved token", () => {
    const { fresh, batch, receipt } = fixture();
    const conflict = { ...fresh, token: "different-token" };
    expect(restoreReviewedPages([conflict], batch, [receipt], context)[0]).toBe(
      conflict,
    );
    batch.pages[0] = { ...batch.pages[0], token: "tampered-token" };
    expect(restoreReviewedPages([fresh], batch, [receipt], context)[0]).toBe(
      fresh,
    );
  });

  it("can restore an authoritative prior QR receipt when the new decoder did not read the QR", () => {
    const { batch, receipt } = fixture();
    const unreadable: ScanPage = {
      id: "new-page",
      sourcePage: 1,
      status: "unreadable",
      resolution: "pending",
    };
    const restored = restoreReviewedPages(
      [unreadable],
      batch,
      [receipt],
      context,
    )[0];
    expect(restored).toMatchObject({
      token: receipt.token,
      resolution: "accepted",
    });
    expect(restored.thumbnail).toBeUndefined();
  });

  it("does not match by array order, page ID or filename when source positions are ambiguous", () => {
    const { fresh, batch, receipt } = fixture();
    batch.pages.push({ ...batch.pages[0], id: "duplicate-saved-source" });
    expect(restoreReviewedPages([fresh], batch, [receipt], context)[0]).toBe(
      fresh,
    );
    const invalidPages = [{ ...fresh, sourcePage: 0 }];
    expect(restoreReviewedPages(invalidPages, batch, [receipt], context)).toBe(
      invalidPages,
    );
    const duplicateSources = [fresh, { ...fresh, id: "another-current-id" }];
    expect(
      restoreReviewedPages(
        duplicateSources,
        { ...batch, pageCount: 2 },
        [receipt],
        context,
      ),
    ).toBe(duplicateSources);
  });
  it("keeps a reasoned pending hold across same-PDF handoff, using the fresh image", () => {
    const { batch, fresh } = fixture();
    batch.pages[0] = {
      ...batch.pages[0],
      status: "unreadable",
      resolution: "pending",
      reviewReason: "薄いため再スキャン待ち",
      reviewedBy: "teacher",
    };
    const result = restoreReviewedPages([fresh], batch, [], context)[0];
    expect(result).toMatchObject({
      id: fresh.id,
      thumbnail: fresh.thumbnail,
      resolution: "pending",
      reason: "薄いため再スキャン待ち",
      reviewReason: "薄いため再スキャン待ち",
      reviewedBy: "teacher",
    });
  });
  it("does not restore an automatic pending diagnosis or override a current receipt with a hold", () => {
    const { batch, fresh, receipt } = fixture();
    batch.pages[0] = {
      ...batch.pages[0],
      status: "unknown",
      resolution: "pending",
      reason: "古い自動判定",
    };
    expect(restoreReviewedPages([fresh], batch, [], context)[0]).toBe(fresh);
    batch.pages[0] = {
      ...batch.pages[0],
      reviewReason: "過去の保留",
      reviewedBy: "teacher",
    };
    expect(restoreReviewedPages([fresh], batch, [receipt], context)[0]).toBe(
      fresh,
    );
  });
});
