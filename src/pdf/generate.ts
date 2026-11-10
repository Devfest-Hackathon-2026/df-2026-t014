import { PDFDocument, degrees, rgb } from "pdf-lib";
import QRCode from "qrcode";
import type { Collection, PrintOptions, PrintResult } from "../domain/types";
import {
  A4,
  MANAGEMENT_BAND,
  PAGE_MARGIN,
  printManifest,
  qrBox,
  normalizedSourcePlacement,
  reservedArea,
} from "./geometry";
import {
  embedAllPdfPages,
  inspectSourcePdf,
  MAX_PRINT_PAGES,
  MAX_SOURCE_PAGES,
  setStablePdfDates,
} from "./documents";
import { drawJapanese } from "./font";

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new DOMException("PDF生成を中止しました。", "AbortError");
}

async function createTemplate(collection: Collection): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  setStablePdfDates(doc, collection.createdAt);
  for (let n = 1; n <= collection.pageCount; n++) {
    const page = doc.addPage([A4.width, A4.height]);
    await drawJapanese(doc, page, "SAMPLE  /  架空の配布物", {
      x: 48,
      y: 710,
      size: 10,
      color: "#647570",
    });
    await drawJapanese(doc, page, collection.title, {
      x: 48,
      y: 664,
      size: 24,
      width: 490,
      weight: 700,
    });
    await drawJapanese(doc, page, `${collection.className}　保護者の皆さま`, {
      x: 48,
      y: 620,
      size: 13,
    });
    page.drawLine({
      start: { x: 48, y: 594 },
      end: { x: 547, y: 594 },
      thickness: 1,
      color: rgb(0.72, 0.78, 0.75),
    });
    const lines = [
      "日頃より本校の教育活動にご理解とご協力をいただき、",
      "ありがとうございます。内容をご確認のうえ、必要事項をご記入ください。",
      "この書類はPaperFlowの動作確認用の架空サンプルです。",
      "",
      "【確認事項】",
      "・集合時刻、持ち物、当日の連絡方法をご確認ください。",
      "・変更がある場合は、担任の先生へお知らせください。",
      "",
      "【回答欄】",
      "□ 内容を確認し、参加に同意します。",
      "□ 担任への相談を希望します。",
    ];
    for (let index = 0; index < lines.length; index++) {
      await drawJapanese(doc, page, lines[index], {
        x: 48,
        y: 560 - index * 24,
        size: 12,
        width: 500,
      });
    }
    await drawJapanese(doc, page, "保護者氏名：", { x: 48, y: 258, size: 13 });
    page.drawLine({
      start: { x: 133, y: 236 },
      end: { x: 510, y: 236 },
      thickness: 0.8,
      color: rgb(0.62, 0.7, 0.66),
    });
    await drawJapanese(doc, page, "記入日：　　　　年　　　　月　　　　日", {
      x: 48,
      y: 204,
      size: 13,
    });
    await drawJapanese(
      doc,
      page,
      `提出期限：${collection.dueDate || "未設定"}　　原稿 ${n} / ${collection.pageCount}`,
      { x: 48, y: 130, size: 10, color: "#647570" },
    );
  }
  return doc;
}

/** A real, immutable sample source PDF for local or teacher-owned Drive snapshots. */
export async function generateSourcePdf(
  collection: Collection,
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(collection.pageCount) ||
    collection.pageCount < 1 ||
    collection.pageCount > MAX_SOURCE_PAGES
  )
    throw new Error("原稿は1〜10ページのPDFにしてください。");
  return (await createTemplate(collection)).save();
}

export async function generatePrintPdf(
  options: PrintOptions,
): Promise<PrintResult> {
  const { collection, onProgress } = options;
  throwIfAborted(options.signal);
  if (collection.pageCount < 1 || collection.pageCount > MAX_SOURCE_PAGES)
    throw new Error("原稿は1〜10ページのPDFにしてください。");
  if (options.sourcePdf) await inspectSourcePdf(options.sourcePdf);
  const source = options.sourcePdf
    ? await PDFDocument.load(options.sourcePdf, { updateMetadata: false })
    : await createTemplate(collection);
  if (source.getPageCount() !== collection.pageCount) {
    throw new Error(
      `原稿は${source.getPageCount()}ページです。配布物のページ数と合わせてください。`,
    );
  }
  let manifest = printManifest(collection, options.students);
  if (options.studentIds) {
    const selected = new Set(options.studentIds);
    if (
      !selected.size ||
      options.studentIds.some(
        (id) => !collection.recipients.some((student) => student.id === id),
      )
    )
      throw new Error("再印刷する生徒を発行時の対象者から選んでください。");
    manifest = manifest.filter(({ student }) => selected.has(student.id));
  }
  if (options.pageNumbers) {
    if (
      !options.pageNumbers.length ||
      options.pageNumbers.some(
        (page) =>
          !Number.isInteger(page) || page < 1 || page > collection.pageCount,
      )
    )
      throw new Error("プレビューする原稿ページが範囲外です。");
    const selected = new Set(options.pageNumbers);
    manifest = manifest.filter(
      ({ token }) => token.kind === "content" && selected.has(token.pageNumber),
    );
  }
  if (manifest.length > MAX_PRINT_PAGES)
    throw new Error("印刷用PDFは400ページ以内で作成してください。");
  const out = await PDFDocument.create();
  setStablePdfDates(out, collection.createdAt);
  const embedded = await embedAllPdfPages(out, source);
  for (let index = 0; index < manifest.length; index++) {
    throwIfAborted(options.signal);
    const { token, student } = manifest[index];
    const sourcePage = source.getPage(
      Math.min(token.pageNumber, collection.pageCount) - 1,
    );
    const dimensions = sourcePage.getSize();
    const position = normalizedSourcePlacement(
      dimensions.width,
      dimensions.height,
      sourcePage.getRotation().angle,
      collection.qrCorner,
      collection.layoutMode ?? "management-band",
    );
    const { pageWidth: width, pageHeight: height } = position;
    const page = out.addPage([width, height]);
    if (token.kind === "content") {
      page.drawPage(embedded[token.pageNumber - 1], {
        x: position.x,
        y: position.y,
        xScale: position.scale,
        yScale: position.scale,
        rotate: degrees(position.rotation),
      });
    } else {
      await drawJapanese(out, page, "印刷調整用 / 返却不要", {
        x: PAGE_MARGIN + 36,
        y: height / 2 + 18,
        size: 22,
        width: width - PAGE_MARGIN * 2 - 72,
        color: "#86958f",
        weight: 600,
      });
    }
    const box = qrBox(width, height, collection.qrCorner);
    const qr = await QRCode.toDataURL(token.token, {
      errorCorrectionLevel: "Q",
      margin: 4,
      width: 300,
      // Keep the original visible even if the teacher has not yet cleared the
      // reserved corner. White QR cells must never paint over source content.
      color: { dark: "#000000ff", light: "#ffffff00" },
    });
    page.drawImage(await out.embedPng(qr), box);
    const onRight = collection.qrCorner.endsWith("right");
    const area = reservedArea(width, height, collection.qrCorner);
    const reserved = collection.layoutMode === "reserved-corner";
    const labelX = onRight
      ? reserved
        ? area.x
        : PAGE_MARGIN
      : box.x + box.width + 14;
    const labelWidth =
      (reserved ? area.width : width - PAGE_MARGIN * 2) - box.width - 14;
    await drawJapanese(
      out,
      page,
      `${collection.className}　 ${student.number}番`,
      { x: labelX, y: box.y + box.height - 1, size: 10, width: labelWidth },
    );
    if (collection.showNames !== false)
      await drawJapanese(out, page, student.name, {
        x: labelX,
        y: box.y + box.height - 20,
        size: 15,
        weight: 700,
        width: labelWidth,
      });
    await drawJapanese(out, page, collection.title, {
      x: labelX,
      y: box.y + 27,
      size: 9,
      width: labelWidth,
      color: "#647570",
    });
    await drawJapanese(
      out,
      page,
      `${collection.versionLabel || (collection.revision ? `v${collection.revision}` : collection.versionId.slice(0, 8))} · ${token.kind === "spacer" ? "調整用" : `${token.pageNumber}/${collection.pageCount}`} · ${token.required ? "返却必要" : "返却不要"}`,
      {
        x: labelX,
        y: box.y + 12,
        size: 8,
        width: labelWidth,
        color: "#647570",
      },
    );
    const separatorY = collection.qrCorner.startsWith("top")
      ? height - MANAGEMENT_BAND + 6
      : MANAGEMENT_BAND - 6;
    if (!reserved)
      page.drawLine({
        start: { x: PAGE_MARGIN, y: separatorY },
        end: { x: width - PAGE_MARGIN, y: separatorY },
        thickness: 0.6,
        color: rgb(0.79, 0.84, 0.82),
      });
    onProgress?.({
      current: index + 1,
      total: manifest.length,
      message: `${index + 1} / ${manifest.length}ページを生成`,
    });
    if (index % 4 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  out.setTitle(collection.title);
  out.setProducer("PaperFlow / browser-only PDF generation");
  out.setCreator("PaperFlow");
  throwIfAborted(options.signal);
  return { bytes: await out.save(), collection };
}

/** Generate one actual source page with the selected teacher-visible print settings. */
export async function generatePrintPreview(
  options: PrintOptions,
  sourcePage: number | "all" = 1,
): Promise<PrintResult> {
  const first = printManifest(options.collection, options.students)[0]?.student;
  if (!first) throw new Error("プレビュー対象の生徒がいません。");
  return generatePrintPdf({
    ...options,
    studentIds: [first.id],
    pageNumbers:
      sourcePage === "all"
        ? Array.from(
            { length: options.collection.pageCount },
            (_, index) => index + 1,
          )
        : [sourcePage],
  });
}
