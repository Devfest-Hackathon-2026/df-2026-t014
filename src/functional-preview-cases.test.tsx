// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import CreateDialog from "./CreateDialog";
import { testDom } from "./testDom";
import { r6 } from "./domain/functional-fixtures";
const renderer = vi.hoisted(() => ({
  calls: [] as Array<{ source: number; page: number }>,
}));
vi.mock("./pdfClient", () => ({
  inspectSourcePdf: vi.fn(async () => ({ pageCount: 3 })),
  generatePrintPreview: vi.fn(async () => ({
    bytes: new Uint8Array([20, 21, 22]),
  })),
}));
// Actual PdfPreview is mounted. Only PDF raster API is an adapter; page and tab state remain production code.
vi.mock("./pdf", () => ({
  getPdfPageCount: vi.fn(async () => 3),
  renderPdfPage: vi.fn(async (bytes: Uint8Array, page: number) => {
    renderer.calls.push({ source: bytes[0], page });
    return `data:image/png;base64,${bytes[0]}PAGE${page}`;
  }),
}));
let dom: ReturnType<typeof testDom>;
afterEach(async () => {
  await dom?.close();
  vi.clearAllMocks();
});
it("PF-F120 original and composed tabs keep selected page2 through real PdfPreview navigation", async () => {
  dom = testDom();
  renderer.calls = [];
  const source = new Uint8Array([10, 11, 12]),
    before = source.slice();
  await dom.render(
    <CreateDialog
      className="架空"
      count={6}
      source={{ name: "three.pdf", bytes: source }}
      students={r6()}
      busy={false}
      progress={null}
      error=""
      onClose={() => {}}
      onCreate={async () => {}}
    />,
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
  await dom.click(dom.container.querySelector('[aria-label="次のページ"]')!);
  expect(dom.container.querySelector(".paperflow-pdf-page")?.textContent).toBe(
    "2 / 3 ページ",
  );
  expect(
    dom.container.querySelector(".paperflow-pdf-image")?.getAttribute("src"),
  ).toContain("20PAGE2");
  await dom.click(dom.button("元の原稿"));
  expect(dom.container.querySelector(".paperflow-pdf-page")?.textContent).toBe(
    "2 / 3 ページ",
  );
  expect(
    dom.container.querySelector(".paperflow-pdf-image")?.getAttribute("src"),
  ).toContain("10PAGE2");
  await dom.click(dom.button("QRを重ねた原稿"));
  expect(dom.container.querySelector(".paperflow-pdf-page")?.textContent).toBe(
    "2 / 3 ページ",
  );
  expect(
    dom.container.querySelector(".paperflow-pdf-image")?.getAttribute("src"),
  ).toContain("20PAGE2");
  expect(source).toEqual(before);
});
it("PF-F120 actual rendered P2 source and composed tabs retain original body pixels and differ only outside body region", async () => {
  const { readFile } = await import("node:fs/promises");
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const { createCanvas } = await import("@napi-rs/canvas");
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const client = await import("./pdfClient");
  const rendererApi = await import("./pdf");
  const { inspectSourcePdf } = await import("./pdf/documents");
  const { generatePrintPreview } = await import("./pdf/generate");
  dom = testDom();
  window.requestAnimationFrame = (f) =>
    setTimeout(() => f(performance.now()), 0) as unknown as number;
  window.cancelAnimationFrame = (n) => clearTimeout(n);
  const font = await readFile("src/pdf/assets/BIZUDGothic-Regular.ttf");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(font)),
  );
  const source = await PDFDocument.create(),
    standard = await source.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= 3; n++) {
    const p = source.addPage([595.28, 841.89]);
    p.drawText("ORIGINAL-P" + n, { x: 150, y: 500, font: standard, size: 20 });
    p.drawRectangle({
      x: 150,
      y: 400,
      width: 100,
      height: 50,
      color: rgb(n / 4, 0.3, 0.5),
    });
  }
  const bytes = await source.save(),
    unchanged = bytes.slice();
  vi.mocked(client.inspectSourcePdf).mockImplementation(inspectSourcePdf);
  vi.mocked(client.generatePrintPreview).mockImplementation(
    generatePrintPreview,
  );
  vi.mocked(rendererApi.getPdfPageCount).mockImplementation(async (b) =>
    (await PDFDocument.load(b)).getPageCount(),
  );
  const captured: Array<{ page: number; image: string; body: number[] }> = [];
  vi.mocked(rendererApi.renderPdfPage).mockImplementation(
    async (b, page = 1) => {
      const task = getDocument({ data: b.slice(), useSystemFonts: false }),
        pdf = await task.promise;
      try {
        const p = await pdf.getPage(page),
          viewport = p.getViewport({ scale: 1 }),
          canvas = createCanvas(
            Math.ceil(viewport.width),
            Math.ceil(viewport.height),
          );
        await p.render({
          canvas: canvas as unknown as HTMLCanvasElement,
          viewport,
        }).promise;
        const image = canvas.toDataURL("image/png");
        captured.push({
          page,
          image,
          body: [
            ...canvas.getContext("2d").getImageData(100, 300, 400, 250).data,
          ],
        });
        return image;
      } finally {
        await task.destroy();
      }
    },
  );
  await dom.render(
    <CreateDialog
      className="架空"
      count={2}
      source={{ name: "P3.pdf", bytes }}
      students={r6().slice(0, 2)}
      busy={false}
      progress={null}
      error=""
      onClose={() => {}}
      onCreate={async () => {}}
    />,
  );
  const settle = async () => {
    for (let i = 0; i < 60; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });
      if (dom.container.querySelector(".paperflow-pdf-image")) return;
    }
    throw new Error("Preview did not render");
  };
  await settle();
  await dom.click(dom.container.querySelector('[aria-label="次のページ"]')!);
  await settle();
  const composed = captured.at(-1)!;
  expect(composed.page).toBe(2);
  expect(dom.container.querySelector(".paperflow-pdf-page")?.textContent).toBe(
    "2 / 3 ページ",
  );
  await dom.click(dom.button("元の原稿"));
  await settle();
  const original = captured.at(-1)!;
  expect(original.page).toBe(2);
  expect(original.image).not.toBe(composed.image);
  expect(original.body).toEqual(composed.body);
  expect(
    dom.container.querySelector(".paperflow-pdf-image")?.getAttribute("src"),
  ).toBe(original.image);
  await dom.click(dom.button("QRを重ねた原稿"));
  await settle();
  expect(captured.at(-1)?.page).toBe(2);
  expect(captured.at(-1)?.body).toEqual(original.body);
  expect(bytes).toEqual(unchanged);
}, 20000);
