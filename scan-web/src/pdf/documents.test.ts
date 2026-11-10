import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import {
  assertPdfInput,
  embedAllPdfPages,
  extractStudentPdf,
  getPdfPageCount,
  inspectSourcePdf,
} from "./documents";

describe("PDF page extraction", () => {
  it.each([2, 3])(
    "embeds all %s source pages for a multi-page print job",
    async (count) => {
      const source = await PDFDocument.create();
      for (let index = 0; index < count; index++) {
        const page = source.addPage([200 + index * 10, 300 + index * 10]);
        page.drawRectangle({ x: 10, y: 10, width: 30, height: 30 });
      }
      const target = await PDFDocument.create();
      const embedded = await embedAllPdfPages(target, source);
      expect(embedded).toHaveLength(count);
      for (let index = 0; index < count; index++) {
        const page = target.addPage([200 + index * 10, 300 + index * 10]);
        page.drawPage(embedded[index]);
      }
      const reloaded = await PDFDocument.load(await target.save());
      expect(reloaded.getPageCount()).toBe(count);
      expect(embedded.map((page) => page.width)).toEqual(
        source.getPages().map((page) => page.getWidth()),
      );
    },
  );

  it("preserves supplied logical ordering instead of scan ordering", async () => {
    const source = await PDFDocument.create();
    source.addPage([200, 300]);
    source.addPage([210, 310]);
    source.addPage([220, 320]);
    const bytes = await source.save();
    const result = await PDFDocument.load(
      await extractStudentPdf(bytes, [3, 1]),
    );
    expect(result.getPages().map((page) => page.getWidth())).toEqual([
      220, 200,
    ]);
    expect(await getPdfPageCount(bytes)).toBe(3);
  });

  it("rejects non-PDF inputs and invalid page references", async () => {
    expect(() =>
      assertPdfInput(new TextEncoder().encode("<script>alert(1)</script>")),
    ).toThrow();
    const doc = await PDFDocument.create();
    doc.addPage();
    const bytes = await doc.save();
    await expect(extractStudentPdf(bytes, [0])).rejects.toThrow();
    await expect(extractStudentPdf(bytes, [2])).rejects.toThrow();
  });

  it("recreates identical bytes for the same extraction operation", async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    const bytes = await doc.save();
    const createdAt = "2026-11-09T09:00:00.000Z";
    const first = await extractStudentPdf(bytes, [1], createdAt);
    const second = await extractStudentPdf(bytes, [1], createdAt);
    expect(second).toEqual(first);
    expect(
      (await PDFDocument.load(second)).getCreationDate()?.toISOString(),
    ).toBe(createdAt);
  });
});

describe("source PDF guarantee", () => {
  it("accepts normal A4 portrait and rejects mixed paper sizes before generation", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([595.28, 841.89]);
    expect((await inspectSourcePdf(await doc.save())).pageCount).toBe(1);
    doc.addPage([612, 792]);
    await expect(inspectSourcePdf(await doc.save())).rejects.toThrow(
      "2ページ目がA4縦",
    );
  });
  it("rejects oversized, cropped and over-ten-page originals", async () => {
    const large = new Uint8Array(20 * 1024 * 1024 + 1);
    large.set(new TextEncoder().encode("%PDF-1.7"));
    await expect(inspectSourcePdf(large)).rejects.toThrow("20MiB");
    const doc = await PDFDocument.create();
    const first = doc.addPage([595.28, 841.89]);
    first.setCropBox(10, 10, 570, 820);
    await expect(inspectSourcePdf(await doc.save())).rejects.toThrow(
      "切り抜き",
    );
    first.setCropBox(0, 0, 595.28, 841.89);
    for (let n = 0; n < 10; n++) doc.addPage([595.28, 841.89]);
    await expect(inspectSourcePdf(await doc.save())).rejects.toThrow("1〜10");
  });
});
