import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { assertPdfInput } from "./documents";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export async function loadPdf(
  bytes: Uint8Array,
): Promise<{ document: PDFDocumentProxy; destroy: () => Promise<void> }> {
  assertPdfInput(bytes);
  // PDF.js 6 exposes teardown on its loading task, not on PDFDocumentProxy.
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    useSystemFonts: true,
    enableXfa: false,
  });
  try {
    return { document: await task.promise, destroy: () => task.destroy() };
  } catch {
    await task.destroy().catch(() => undefined);
    throw new Error(
      "PDFを描画できませんでした。パスワードを解除したPDFを選択してください。",
    );
  }
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new DOMException("解析を中止しました。", "AbortError");
}

export async function renderPageCanvas(
  doc: PDFDocumentProxy,
  pageNumber: number,
  scale = 1.8,
  signal?: AbortSignal,
) {
  throwIfAborted(signal);
  const page = await doc.getPage(pageNumber);
  const initialViewport = page.getViewport({ scale });
  const pixelArea = initialViewport.width * initialViewport.height;
  // Keep unusual large pages from exhausting the browser's memory.
  const limitedScale =
    pixelArea > 12_000_000 ? scale * Math.sqrt(12_000_000 / pixelArea) : scale;
  const viewport = page.getViewport({ scale: limitedScale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const task = page.render({
    canvas,
    viewport,
    background: "rgb(255,255,255)",
  });
  const abort = () => task.cancel();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await task.promise;
    throwIfAborted(signal);
    return canvas;
  } catch (error) {
    canvas.width = canvas.height = 1;
    throwIfAborted(signal);
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    page.cleanup();
  }
}

export function thumbnailOf(canvas: HTMLCanvasElement, maxWidth = 360) {
  const thumbnail = document.createElement("canvas");
  const scale = Math.min(maxWidth / canvas.width, 1);
  thumbnail.width = Math.round(canvas.width * scale);
  thumbnail.height = Math.round(canvas.height * scale);
  thumbnail
    .getContext("2d")!
    .drawImage(canvas, 0, 0, thumbnail.width, thumbnail.height);
  const url = thumbnail.toDataURL("image/jpeg", 0.72);
  thumbnail.width = thumbnail.height = 1;
  return url;
}

export async function renderPdfPage(
  bytes: Uint8Array,
  pageNumber = 1,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  const { document: doc, destroy } = await loadPdf(bytes);
  try {
    if (pageNumber < 1 || pageNumber > doc.numPages)
      throw new Error("ページが見つかりません。");
    const canvas = await renderPageCanvas(doc, pageNumber, 1.25, signal);
    const image = canvas.toDataURL("image/jpeg", 0.85);
    canvas.width = canvas.height = 1;
    return image;
  } finally {
    await destroy();
  }
}
