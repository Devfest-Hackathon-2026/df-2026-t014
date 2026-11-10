import type { ScanOptions, ScanPage, PageToken } from "../domain/types";
import { MAX_SCAN_PAGES } from "./documents";
import { findQrValues, isOpaqueToken, isBlankCandidate } from "./decode";
import {
  loadPdf,
  renderPageCanvas,
  thumbnailOf,
  throwIfAborted,
} from "./renderer";

const pageKey = (
  token: Pick<PageToken, "versionId" | "studentId" | "pageNumber">,
) => `${token.versionId}:${token.studentId}:${token.pageNumber}`;

export async function scanPdf(options: ScanOptions): Promise<ScanPage[]> {
  const { bytes, collectionId, onProgress, signal } = options;
  const known = new Map<string, PageToken>();
  for (const token of options.tokens) {
    const previous = known.get(token.token);
    if (
      previous &&
      (pageKey(previous) !== pageKey(token) ||
        previous.collectionId !== token.collectionId ||
        previous.kind !== token.kind)
    ) {
      throw new Error(
        "QR対応表に重複した識別子があります。台帳を確認してください。",
      );
    }
    known.set(token.token, token);
  }
  const { document: doc, destroy } = await loadPdf(bytes);
  const seen = new Set(
    options.existingReceipts.map((receipt) => pageKey(receipt)),
  );
  const results: ScanPage[] = [];
  try {
    if (doc.numPages > MAX_SCAN_PAGES)
      throw new Error("回収PDFは200ページ以内に分けて選択してください。");
    for (let number = 1; number <= doc.numPages; number++) {
      throwIfAborted(signal);
      onProgress?.({
        current: number - 1,
        total: doc.numPages,
        message: `${number} / ${doc.numPages}ページのQRを解析`,
      });
      let canvas = await renderPageCanvas(doc, number, 1.8, signal);
      let values = findQrValues(canvas, options.qrCorner);
      if (!values.some((value) => known.has(value))) {
        canvas.width = canvas.height = 1;
        canvas = await renderPageCanvas(doc, number, 2.8, signal);
        values = findQrValues(canvas, options.qrCorner);
      }
      const thumbnail = thumbnailOf(canvas);
      const blank =
        !values.length &&
        isBlankCandidate(
          canvas
            .getContext("2d")!
            .getImageData(0, 0, canvas.width, canvas.height).data,
        );
      canvas.width = canvas.height = 1;
      const matches = values
        .map((value) => known.get(value))
        .filter((value): value is PageToken => Boolean(value));
      const item: ScanPage = {
        id: crypto.randomUUID(),
        sourcePage: number,
        status: "unreadable",
        resolution: "pending",
        thumbnail,
      };
      if (matches.length > 1) {
        item.reason =
          "複数の管理QRが見つかりました。元の紙を確認してください。";
      } else if (matches.length === 1) {
        const token = matches[0];
        Object.assign(item, {
          token: token.token,
          studentId: token.studentId,
          pageNumber: token.pageNumber,
          collectionId: token.collectionId,
          versionId: token.versionId,
        });
        if (token.active === false) {
          item.status = "unknown";
          item.reason =
            "このQRは未発行または失効しています。発行状態を確認してください。";
        } else if (token.collectionId !== collectionId) {
          item.status = "foreign";
          item.reason =
            "別の配布物のQRです。対象を切り替えて取り込んでください。";
        } else if (token.kind === "spacer") {
          item.status = "spacer";
          item.resolution = "ignored";
          item.reason = "両面印刷の調整ページ（返却不要）";
        } else if (seen.has(pageKey(token))) {
          item.status = "duplicate";
          item.reason =
            "同じ生徒・版・ページの記録が存在します。自動で上書きしません。";
        } else {
          item.status = "matched";
          item.resolution = "accepted";
          seen.add(pageKey(token));
        }
      } else {
        const unknown = values.find(isOpaqueToken);
        if (unknown) {
          item.status = "unknown";
          item.token = unknown;
          item.reason = "この端末の台帳に登録されていないQRです。";
        } else if (blank) {
          item.status = "blank";
          item.reason =
            "空白の可能性があります。薄い記入を含めて画像を確認し、対象外にするか判断してください。";
        } else {
          item.reason = values.length
            ? "管理用QRが見つかりません。他用途のQRは照合に使用しません。"
            : "QRを読み取れませんでした。再スキャンまたは手動で割り当ててください。";
        }
      }
      results.push(item);
      onProgress?.({
        current: number,
        total: doc.numPages,
        message: `${number} / ${doc.numPages}ページを解析しました`,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    // Cancellation can arrive from the final progress callback or during the
    // last yield. Do not return a completed result after the user cancelled.
    throwIfAborted(signal);
    return results;
  } finally {
    await destroy();
  }
}
