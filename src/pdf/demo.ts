import { PDFDocument, degrees } from "pdf-lib";
import type { Collection, ProgressCallback } from "../domain/types";
import { printManifest, qrBox } from "./geometry";
import { loadPdf, renderPageCanvas } from "./renderer";
import { setStablePdfDates } from "./documents";

/** Creates a synthetic, rasterized return bundle from a real generated print PDF.
 * It deliberately contains missing, duplicated and obscured pages. This is not
 * evidence of performance on a physical scanner.
 */
export async function createDemoScan(
  collection: Collection,
  printBytes: Uint8Array,
  onProgress?: ProgressCallback,
): Promise<Uint8Array> {
  const manifest = printManifest(collection);
  const { document: printDoc, destroy } = await loadPdf(printBytes);
  const out = await PDFDocument.create();
  setStablePdfDates(out, collection.createdAt);
  const studentIds = [...new Set(manifest.map((item) => item.student.id))];
  const missing = new Set(
    studentIds.slice(-Math.min(3, Math.max(0, studentIds.length - 3))),
  );
  const partialStudent = studentIds[Math.max(0, studentIds.length - 4)];
  const damagedStudent = studentIds[1];
  const required = [...collection.requiredPages].sort((a, b) => a - b);
  const retained = manifest
    .map((item, index) => ({ ...item, index }))
    .filter(
      (item) =>
        item.token.kind === "content" &&
        item.token.required &&
        !missing.has(item.student.id) &&
        !(
          required.length > 1 &&
          item.student.id === partialStudent &&
          item.token.pageNumber === required.at(-1)
        ),
    );
  // Fixed ordering makes the sample reproducible, while never grouping by person.
  retained.sort(
    (a, b) =>
      ((a.index * 17 + 7) % (manifest.length + 1)) -
      ((b.index * 17 + 7) % (manifest.length + 1)),
  );
  if (retained.length) retained.push(retained[0]);
  try {
    for (let index = 0; index < retained.length; index++) {
      const item = retained[index];
      const canvas = await renderPageCanvas(printDoc, item.index + 1, 1.8);
      const original = await printDoc.getPage(item.index + 1);
      const viewport = original.getViewport({ scale: 1 });
      const context = canvas.getContext("2d")!;
      if (
        item.student.id === damagedStudent &&
        item.token.pageNumber === required[0]
      ) {
        const box = qrBox(viewport.width, viewport.height, collection.qrCorner);
        const scaleX = canvas.width / viewport.width;
        const scaleY = canvas.height / viewport.height;
        context.fillStyle = "#ededeb";
        context.fillRect(
          (box.x - 2) * scaleX,
          (viewport.height - box.y - box.height - 2) * scaleY,
          (box.width + 4) * scaleX,
          (box.height + 4) * scaleY,
        );
      }
      context.fillStyle = "#234c78";
      context.font = `${Math.round(canvas.width / 48)}px "Hiragino Sans", sans-serif`;
      context.fillText(
        "記入例（架空）",
        canvas.width * 0.34,
        canvas.height * 0.72,
      );
      const image = await out.embedJpg(canvas.toDataURL("image/jpeg", 0.87));
      const page = out.addPage([viewport.width, viewport.height]);
      page.drawImage(image, {
        x: 0,
        y: 0,
        width: viewport.width,
        height: viewport.height,
      });
      if (index % 11 === 4) page.setRotation(degrees(180));
      canvas.width = canvas.height = 1;
      onProgress?.({
        current: index + 1,
        total: retained.length,
        message: `${index + 1} / ${retained.length}ページの模擬スキャンを準備`,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    out.setTitle("PaperFlow / 架空の回収サンプル");
    out.setProducer(
      "PaperFlow synthetic raster sample; not a physical scanner",
    );
    return out.save();
  } finally {
    await destroy();
  }
}
