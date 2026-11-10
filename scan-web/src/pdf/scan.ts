import type { ScanOptions, ScanPage } from "../domain/types";
import { MAX_SCAN_PAGES } from "./documents";
import { findQrValues, isOpaqueToken, isBlankCandidate } from "./decode";
import {
  loadPdf,
  renderPageCanvas,
  thumbnailOf,
  throwIfAborted,
} from "./renderer";

/**
 * Read the QR on every page without consulting any ledger. A readable page
 * carries the QR string as-is; duplicate detection happens later, when the CSV
 * is produced, so that exclusions can change the outcome.
 */
export async function scanPdf(options: ScanOptions): Promise<ScanPage[]> {
  const { bytes, onProgress, signal } = options;
  const { document: doc, destroy } = await loadPdf(bytes);
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
      let values = findQrValues(canvas);
      if (!values.some(isOpaqueToken)) {
        canvas.width = canvas.height = 1;
        canvas = await renderPageCanvas(doc, number, 2.8, signal);
        values = findQrValues(canvas);
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
      const tokens = [...new Set(values.filter(isOpaqueToken))];
      const item: ScanPage = { sourcePage: number, thumbnail };
      if (tokens.length === 1) {
        item.token = tokens[0];
      } else if (tokens.length > 1) {
        item.reason =
          "1ページに複数の管理QRが見つかりました。元の紙を確認してください。";
      } else if (values.length) {
        item.reason =
          "管理用QRが見つかりません。他用途のQRは読み取り結果に使用しません。";
      } else if (blank) {
        item.reason =
          "空白の可能性があります。薄い記入を含めて画像を確認し、対象外にするか判断してください。";
      } else {
        item.reason =
          "QRを読み取れませんでした。再スキャンするか、対象外にするか判断してください。";
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
