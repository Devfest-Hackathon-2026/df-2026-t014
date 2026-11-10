import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";
import { createCollection } from "../domain/logic";
import type { Student } from "../domain/types";
import { A4, qrBox, reservedArea } from "./geometry";
import {
  generatePrintPdf,
  generatePrintPreview,
  generateSourcePdf,
} from "./generate";

const students: Student[] = [
  { id: "one", name: "山田太郎", number: 1, seat: { row: 0, col: 0 } },
  { id: "two", name: "森七海", number: 2, seat: { row: 0, col: 1 } },
];
function collection() {
  return createCollection(
    {
      title: "参加同意書",
      className: "2年A組",
      pageCount: 3,
      requiredPages: [2, 3],
      qrCorner: "top-right",
      duplex: true,
      order: "number",
      reverse: false,
      layoutMode: "reserved-corner",
      versionLabel: "第2版",
    },
    students,
  );
}
async function source() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let page = 1; page <= 3; page++)
    doc
      .addPage([595.28, 841.89])
      .drawText(`Original page ${page}`, { x: 50, y: 550, font });
  return doc.save();
}
async function texts(bytes: Uint8Array) {
  const task = getDocument({ data: bytes.slice(), useSystemFonts: false });
  try {
    const pdf = await task.promise;
    const result: string[] = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      result.push(
        (await page.getTextContent()).items
          .map((item) => ("str" in item ? item.str : ""))
          .join(""),
      );
    }
    return result;
  } finally {
    await task.destroy();
  }
}

async function renderedInk(
  bytes: Uint8Array,
  boxes: { x: number; y: number; width: number; height: number }[],
) {
  const task = getDocument({ data: bytes.slice(), useSystemFonts: false });
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = createCanvas(
      Math.ceil(viewport.width),
      Math.ceil(viewport.height),
    );
    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      viewport,
    }).promise;
    const context = canvas.getContext("2d");
    return boxes.map((box) => {
      const pixels = context.getImageData(
        Math.round(box.x * 2),
        Math.round(box.y * 2),
        Math.round(box.width * 2),
        Math.round(box.height * 2),
      ).data;
      let ink = 0;
      for (let index = 0; index < pixels.length; index += 4)
        if (
          pixels[index] < 180 &&
          pixels[index + 1] < 180 &&
          pixels[index + 2] < 180
        )
          ink++;
      return ink;
    });
  } finally {
    await task.destroy();
  }
}

beforeAll(async () => {
  const bytes = await readFile(
    new URL("./assets/BIZUDGothic-Regular.ttf", import.meta.url),
  );
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(bytes)));
});
afterAll(() => vi.unstubAllGlobals());

describe("actual print PDF generation", () => {
  it("renders every Japanese title and student-name glyph, not just its extractable text", async () => {
    const c = {
      ...collection(),
      title: "修学旅行参加同意書",
      pageCount: 1,
      requiredPages: [1],
      duplex: false,
    };
    // Regenerate valid per-page tokens for this one-page visual fixture.
    c.tokens = c.tokens
      .filter((token) => token.pageNumber === 1)
      .map((token) => ({ ...token, required: true }));
    const sourceBytes = await generateSourcePdf(c);
    const preview = await generatePrintPreview({
      collection: c,
      students,
      sourcePdf: sourceBytes,
    });
    const titleBoxes = [...c.title].map((_, index) => ({
      x: 48 + 24 * index,
      y: A4.height - 664,
      width: 24,
      height: 28,
    }));
    const sourceInk = await renderedInk(sourceBytes, titleBoxes);
    const area = reservedArea(A4.width, A4.height, c.qrCorner),
      qr = qrBox(A4.width, A4.height, c.qrCorner);
    const nameBoxes = [...students[0].name].map((_, index) => ({
      x: area.x + 15 * index,
      y: A4.height - (qr.y + qr.height - 20),
      width: 15,
      height: 18,
    }));
    const printInk = await renderedInk(preview.bytes, [
      ...titleBoxes,
      ...nameBoxes,
    ]);
    // subset:true previously passed getTextContent while 7 of 9 title glyphs had zero ink.
    expect(
      sourceInk.every((value) => value > 50),
      JSON.stringify(sourceInk),
    ).toBe(true);
    expect(
      printInk.every((value) => value > 35),
      JSON.stringify(printInk),
    ).toBe(true);
  });
  it("exports a stable standalone sample original with every logical page", async () => {
    const c = collection();
    const first = await generateSourcePdf(c);
    const second = await generateSourcePdf(c);
    expect(first).toEqual(second);
    const pages = await texts(first);
    expect(pages).toHaveLength(3);
    expect(pages[0]).toContain("架空");
    expect(pages[2]).toContain("3 / 3");
  });
  it("preserves every original page, embeds Japanese text and prints the version", async () => {
    const result = await generatePrintPdf({
      collection: collection(),
      students,
      sourcePdf: await source(),
    });
    const pages = await texts(result.bytes);
    expect(pages).toHaveLength(8);
    for (let student = 0; student < 2; student++) {
      for (let page = 0; page < 3; page++) {
        expect(pages[student * 4 + page]).toContain(
          `Original page ${page + 1}`,
        );
        expect(pages[student * 4 + page]).toContain(students[student].name);
        expect(pages[student * 4 + page]).toContain("第2版");
      }
      expect(pages[student * 4 + 3]).toContain("印刷調整用");
    }
  });
  it("reprints a selected student with unchanged tokens and can omit names", async () => {
    const c = { ...collection(), showNames: false };
    const before = JSON.stringify(c.tokens);
    const result = await generatePrintPdf({
      collection: c,
      students,
      studentIds: ["two"],
      sourcePdf: await source(),
    });
    const pages = await texts(result.bytes);
    expect(pages).toHaveLength(4);
    expect(pages.join("")).not.toContain("森七海");
    expect(pages.join("")).not.toContain("山田太郎");
    expect(pages[0]).toContain("2番");
    expect(JSON.stringify(c.tokens)).toBe(before);
  });
  it("previews the selected real source page and responds to cancellation", async () => {
    const options = {
      collection: collection(),
      students,
      sourcePdf: await source(),
    };
    const result = await generatePrintPreview(options, 3);
    const pages = await texts(result.bytes);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain("Original page 3");
    const controller = new AbortController();
    controller.abort();
    await expect(
      generatePrintPdf({ ...options, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("recreates byte-identical PDFs for a saved print job", async () => {
    const c = collection();
    c.createdAt = "2026-11-09T09:00:00.000Z";
    const options = { collection: c, students, sourcePdf: await source() };
    const first = await generatePrintPdf(options);
    const second = await generatePrintPdf(options);
    expect(second.bytes).toEqual(first.bytes);
    expect(
      (await PDFDocument.load(second.bytes)).getCreationDate()?.toISOString(),
    ).toBe(c.createdAt);
  });
});
