import { PDFDocument } from "pdf-lib";

const A4 = { width: 595.28, height: 841.89 };

export const MAX_PDF_BYTES = 100 * 1024 * 1024;
export const MAX_SCAN_PAGES = 200;
export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
export const MAX_SOURCE_PAGES = 10;
export const MAX_PRINT_PAGES = 400;

/** Stable metadata is part of the idempotent upload contract. */
export function setStablePdfDates(doc: PDFDocument, createdAt?: string | Date) {
  const date = createdAt
    ? new Date(createdAt)
    : new Date("2000-01-01T00:00:00.000Z");
  if (!Number.isFinite(date.getTime()))
    throw new Error("PDFの保存日時が正しくありません。");
  doc.setCreationDate(date);
  doc.setModificationDate(date);
}

export interface SourcePdfInfo {
  pageCount: number;
  byteLength: number;
  paper: "A4-portrait";
  pages: { width: number; height: number; rotation: number }[];
}

/** Enforce the declared source guarantee before any issuance is created. */
export async function inspectSourcePdf(
  bytes: Uint8Array,
): Promise<SourcePdfInfo> {
  assertPdfInput(bytes);
  if (bytes.length > MAX_SOURCE_BYTES)
    throw new Error("原稿PDFは20MiB以下にしてください。");
  let source: PDFDocument;
  let sourcePages: ReturnType<PDFDocument["getPages"]>;
  try {
    source = await PDFDocument.load(bytes, { updateMetadata: false });
    // Parsing may succeed while the page tree is corrupt. Resolve it inside
    // the same user-facing error boundary as the file parser.
    sourcePages = source.getPages();
  } catch {
    throw new Error(
      "原稿PDFを開けませんでした。パスワードを解除した通常のPDFを選んでください。",
    );
  }
  if (sourcePages.length < 1 || sourcePages.length > MAX_SOURCE_PAGES)
    throw new Error("原稿は1〜10ページのPDFにしてください。");
  const pages = sourcePages.map((page, index) => {
    const rotation = ((page.getRotation().angle % 360) + 360) % 360;
    if (![0, 90, 180, 270].includes(rotation))
      throw new Error(`${index + 1}ページ目の回転角度に対応していません。`);
    const rotated = rotation === 90 || rotation === 270;
    const width = rotated ? page.getHeight() : page.getWidth();
    const height = rotated ? page.getWidth() : page.getHeight();
    if (Math.abs(width - A4.width) > 2 || Math.abs(height - A4.height) > 2)
      throw new Error(
        `${index + 1}ページ目がA4縦ではありません。すべてのページをA4縦に統一してください。`,
      );
    const crop = page.getCropBox();
    const media = page.getMediaBox();
    if (
      Math.abs(media.x) > 0.01 ||
      Math.abs(media.y) > 0.01 ||
      ["x", "y", "width", "height"].some(
        (key) =>
          Math.abs(
            crop[key as keyof typeof crop] - media[key as keyof typeof media],
          ) > 0.01,
      )
    )
      throw new Error(
        `${index + 1}ページ目に切り抜き領域があります。A4縦の通常PDFとして書き出し直してください。`,
      );
    return { width, height, rotation };
  });
  return {
    pageCount: pages.length,
    byteLength: bytes.length,
    paper: "A4-portrait",
    pages,
  };
}

/** pdf-lib embeds only the first page when pageIndices is omitted. Always
 * supply the complete list so multi-page issuances retain every source page. */
export async function embedAllPdfPages(
  target: PDFDocument,
  source: PDFDocument,
) {
  return target.embedPdf(await source.save(), source.getPageIndices());
}

export function assertPdfInput(bytes: Uint8Array) {
  if (!bytes.length || bytes.length > MAX_PDF_BYTES)
    throw new Error("PDFは100MiB以下のファイルを選択してください。");
  const header = new TextDecoder("ascii").decode(
    bytes.subarray(0, Math.min(bytes.length, 1024)),
  );
  if (!header.includes("%PDF-"))
    throw new Error("PDF形式のファイルを選択してください。");
}

export async function getPdfPageCount(bytes: Uint8Array): Promise<number> {
  assertPdfInput(bytes);
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    return doc.getPageCount();
  } catch {
    throw new Error(
      "PDFを開けませんでした。パスワードを解除し、通常のPDFとして保存し直してください。",
    );
  }
}

/** sourcePages are 1-based and retain the supplied logical order. */
export async function extractStudentPdf(
  bytes: Uint8Array,
  sourcePages: number[],
  createdAt?: string | Date,
): Promise<Uint8Array> {
  assertPdfInput(bytes);
  if (!sourcePages.length) throw new Error("保存するページがありません。");
  const source = await PDFDocument.load(bytes, { updateMetadata: false });
  if (
    sourcePages.some(
      (page) =>
        !Number.isInteger(page) || page < 1 || page > source.getPageCount(),
    )
  ) {
    throw new Error("元PDFに存在しないページが指定されています。");
  }
  const result = await PDFDocument.create();
  setStablePdfDates(result, createdAt);
  const pages = await result.copyPages(
    source,
    sourcePages.map((page) => page - 1),
  );
  pages.forEach((page) => result.addPage(page));
  result.setProducer("TABANE / local document processing");
  return result.save();
}
