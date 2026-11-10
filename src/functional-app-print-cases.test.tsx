// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { webcrypto } from "node:crypto";
import App from "./App";
import QRCode from "qrcode";
import { scanPdf as actualScan } from "./pdf/scan";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  generatePrintPdf as actualPrint,
  generateSourcePdf as actualSource,
} from "./pdf/generate";
import { createDemoScan as actualDemo } from "./pdf/demo";
import {
  scanPdf,
  generatePrintPdf,
  generateSourcePdf,
  createDemoScan,
} from "./pdfClient";
import { r6 } from "./domain/functional-fixtures";
vi.mock("./pdf/renderer", async () => {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { createCanvas } = await import("@napi-rs/canvas");
  return {
    throwIfAborted: (signal?: AbortSignal) => {
      if (signal?.aborted)
        throw new DOMException("解析を中止しました。", "AbortError");
    },
    thumbnailOf: (canvas: ReturnType<typeof createCanvas>) => {
      const thumb = createCanvas(
        360,
        Math.round((canvas.height * 360) / canvas.width),
      );
      thumb.getContext("2d").drawImage(canvas, 0, 0, thumb.width, thumb.height);
      return thumb.toDataURL("image/jpeg", 0.72);
    },
    loadPdf: async (bytes: Uint8Array) => {
      const task = getDocument({ data: bytes.slice(), useSystemFonts: false });
      return { document: await task.promise, destroy: () => task.destroy() };
    },
    renderPageCanvas: async (
      doc: { getPage(n: number): Promise<any> },
      n: number,
      scale: number,
    ) => {
      const page = await doc.getPage(n),
        viewport = page.getViewport({ scale }),
        canvas = createCanvas(
          Math.ceil(viewport.width),
          Math.ceil(viewport.height),
        );
      await page.render({ canvas, viewport }).promise;
      return canvas;
    },
  };
});
import { testDom } from "./testDom";
import { issued, record, qrPage } from "./domain/functional-fixtures";
import type { AppState, ScanPage } from "./domain/types";
const fixture = vi.hoisted(() => ({
  initial: null as unknown,
  latest: null as unknown,
  pages: [] as unknown[],
  scanCalls: 0,
}));
vi.mock("./domain/persistence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./domain/persistence")>();
  return {
    ...actual,
    readState: () => structuredClone(fixture.initial),
    writeState: (s: unknown) => {
      fixture.latest = structuredClone(s);
      return true;
    },
  };
});
vi.mock("./pdfClient", () => ({
  scanPdf: vi.fn(
    async (options: {
      collectionId: string;
      existingReceipts: AppState["receipts"];
    }) => {
      fixture.scanCalls++;
      return (structuredClone(fixture.pages) as ScanPage[]).map((p) =>
        p.collectionId && p.collectionId !== options.collectionId
          ? { ...p, status: "foreign", resolution: "pending" }
          : options.existingReceipts.some((r) => r.token && r.token === p.token)
            ? { ...p, status: "duplicate", resolution: "pending" }
            : p,
      );
    },
  ),
  generatePrintPdf: vi.fn(),
  generateSourcePdf: vi.fn(),
  createDemoScan: vi.fn(),
  extractStudentPdf: vi.fn(async (bytes: Uint8Array) => bytes),
  inspectSourcePdf: vi.fn(),
  generatePrintPreview: vi.fn(),
}));
vi.mock("./PdfPreview", () => ({
  default: ({ bytes, title }: { bytes: Uint8Array; title?: string }) => (
    <div data-preview-bytes={Array.from(bytes).join(",")}>{title}</div>
  ),
  PdfPreview: () => null,
}));
vi.mock("./useConcurrentSessionWarning", () => ({
  useConcurrentSessionWarning: () => false,
}));
let dom: ReturnType<typeof testDom>;
afterEach(async () => {
  await dom?.close();
  vi.clearAllMocks();
  vi.useRealTimers();
});
async function mount(state: AppState, pages: ScanPage[]) {
  fixture.initial = state;
  fixture.latest = state;
  fixture.pages = pages;
  fixture.scanCalls = 0;
  dom = testDom();
  vi.stubGlobal("crypto", webcrypto);
  await dom.render(<App />);
  await dom.click(dom.button("回収・照合"));
}
const latest = () => fixture.latest as AppState;
async function textarea(value: string) {
  await act(async () => {
    const el = dom.container.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(
      dom.dom.window.HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(el, value);
    el.dispatchEvent(new dom.dom.window.Event("input", { bubbles: true }));
  });
}

it("PF-F085 populated App cache is invalidated after four additional recipients; current full12-page PDF and real demo use updated manifest while original link remains", async () => {
  const f = issued({}, r6().slice(0, 2));
  f.state.students = r6();
  f.collection.printDriveFileId = "initial-full-print";
  await mount(f.state, []);
  window.requestAnimationFrame = (callback) =>
    setTimeout(() => callback(performance.now()), 0) as unknown as number;
  window.cancelAnimationFrame = (id) => clearTimeout(id);
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: () => "blob:test",
      revokeObjectURL: () => {},
    }),
  );
  const font = await readFile("src/pdf/assets/BIZUDGothic-Regular.ttf");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(font)),
  );
  vi.mocked(generatePrintPdf).mockImplementation(actualPrint);
  vi.mocked(generateSourcePdf).mockImplementation(actualSource);
  vi.mocked(createDemoScan).mockImplementation(actualDemo);
  await dom.click(dom.button("配布物・回収状況"));
  await dom.click(dom.button("印刷PDF"));
  expect(
    vi.mocked(generatePrintPdf).mock.calls[0][0].collection.recipients,
  ).toHaveLength(2);
  let result = await vi.mocked(generatePrintPdf).mock.results[0].value;
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  expect((await PDFDocument.load(result.bytes)).getPageCount()).toBe(4);
  await dom.click(dom.container.querySelector('[aria-label="閉じる"]')!);
  for (const n of [3, 4, 5, 6]) await dom.click(dom.input(n + "番 "));
  await textarea("転入生へ同版追加");
  await dom.click(dom.button("4人分を追加発行"));
  await act(async () => {
    await vi.mocked(generatePrintPdf).mock.results[1].value;
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(latest().collections[0].recipients).toHaveLength(6);
  expect(latest().collections[0].printDriveFileId).toBe("initial-full-print");
  expect(vi.mocked(generatePrintPdf).mock.calls[1][0].studentIds).toEqual([
    "S03",
    "S04",
    "S05",
    "S06",
  ]);
  await dom.click(dom.container.querySelector('[aria-label="閉じる"]')!);
  await dom.click(dom.button("印刷PDF"));
  expect(generatePrintPdf).toHaveBeenCalledTimes(3);
  result = await vi.mocked(generatePrintPdf).mock.results[2].value;
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  expect((await PDFDocument.load(result.bytes)).getPageCount()).toBe(12);
  expect(
    dom.container.querySelector('a[href*="initial-full-print"]')?.textContent,
  ).toContain("初回印刷PDF");
  await dom.click(dom.container.querySelector('[aria-label="閉じる"]')!);
  await dom.click(dom.button("回収・照合"));
  await dom.click(dom.button("サンプルの回収PDFで試す"));
  expect(createDemoScan).toHaveBeenCalledTimes(1);
  const demo = await vi.mocked(createDemoScan).mock.results[0].value;
  expect((await PDFDocument.load(demo)).getPageCount()).toBe(6);
  expect(vi.mocked(createDemoScan).mock.calls[0][0].recipients).toHaveLength(6);
  expect(generatePrintPdf).toHaveBeenCalledTimes(3);
}, 30000);

async function scanDocument(values: string[], body: string) {
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica),
    page = doc.addPage([595.28, 841.89]);
  page.drawText(body, { x: 110, y: 550, size: 30, font });
  for (let i = 0; i < values.length; i++) {
    const image = await doc.embedPng(
      await QRCode.toDataURL(values[i], {
        errorCorrectionLevel: "Q",
        margin: 4,
        width: 300,
      }),
    );
    page.drawImage(image, {
      x: i ? 260 : 496,
      y: i ? 350 : 743,
      width: 71,
      height: 71,
    });
  }
  return doc.save();
}
async function realMount(state: AppState) {
  await mount(state, []);
  window.requestAnimationFrame = (f) =>
    setTimeout(() => f(performance.now()), 0) as unknown as number;
  window.cancelAnimationFrame = (n) => clearTimeout(n);
  vi.mocked(scanPdf).mockImplementation(actualScan);
  await mkdir("artifacts/test-execution/functional/review", {
    recursive: true,
  });
}
async function realUpload(bytes: Uint8Array, name: string) {
  const before = vi.mocked(scanPdf).mock.calls.length;
  const el = dom.container.querySelector(".upload-zone input[type=file]")!;
  Object.defineProperty(el, "files", {
    configurable: true,
    value: [
      {
        name,
        size: bytes.length,
        arrayBuffer: async () =>
          bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ),
      },
    ],
  });
  let pages: ScanPage[] = [];
  await act(async () => {
    el.dispatchEvent(new Event("change", { bubbles: true }));
    for (
      let i = 0;
      i < 100 && vi.mocked(scanPdf).mock.calls.length === before;
      i++
    )
      await new Promise((r) => setTimeout(r, 10));
    pages = await vi.mocked(scanPdf).mock.results[before].value;
    await new Promise((r) => setTimeout(r, 20));
  });
  await writeFile("artifacts/test-execution/functional/review/" + name, bytes);
  await writeFile(
    "artifacts/test-execution/functional/review/" + name + ".jpg",
    Buffer.from(pages[0].thumbnail!.split(",")[1], "base64"),
  );
  return pages;
}
it("PF-F142 actual old APPROVED/new CANCEL same QR becomes pending duplicate and preserves old receipt with teacher decision UI", async () => {
  const f = issued({}, r6().slice(0, 2));
  const token = f.collection.tokens[0].token;
  const A = await scanDocument([token], "APPROVED"),
    B = await scanDocument([token], "CANCEL");
  const hash = Buffer.from(
    await webcrypto.subtle.digest("SHA-256", new Uint8Array(A)),
  ).toString("hex");
  const existing = record(
    f.state,
    f.collection,
    [qrPage(f.collection, "S01", 1, 1)],
    "approved-batch",
    hash,
  );
  existing.batches[0].sourceDriveFileId = "approved-original";
  existing.artifacts = [
    {
      id: "approved-artifact",
      kind: "student",
      collectionId: f.collection.id,
      versionId: f.collection.versionId,
      studentId: "S01",
      driveFileId: "approved-student",
      name: "approved.pdf",
      receiptIds: existing.receipts.map((r) => r.id),
      createdAt: f.collection.createdAt,
    },
  ];
  await realMount(existing);
  const first = await realUpload(A, "F142-old.pdf");
  expect(first[0].status).toBe("duplicate");
  await dom.click(dom.button("回収状況を記録"));
  const old = structuredClone(latest().receipts);
  const oldId = latest().batches[0].id;
  const next = await realUpload(B, "F142-new.pdf");
  expect(next[0]).toMatchObject({
    status: "duplicate",
    resolution: "pending",
    studentId: "S01",
  });
  expect(
    dom.container.querySelector(".review-thumbnail img")?.getAttribute("src"),
  ).toBe(next[0].thumbnail);
  expect(dom.container.textContent).toContain("自動で上書きしません");
  expect(dom.button("既存と今回の画像を比較")).toBeTruthy();
  await dom.click(dom.button("回収状況を記録"));
  expect(latest().receipts).toEqual(old);
  expect(latest().receipts[0].batchId).toBe(oldId);
  expect(latest().artifacts?.[0].driveFileId).toBe("approved-student");
  expect(latest().batches.find((b) => b.id === oldId)?.sourceDriveFileId).toBe(
    "approved-original",
  );
  expect(latest().batches).toHaveLength(2);
  expect(
    latest().batches.find((b) => b.id !== oldId)?.pages[0].resolution,
  ).toBe("pending");
  await writeFile(
    "artifacts/test-execution/functional/review/F142-observed.json",
    JSON.stringify(
      {
        collection: f.collection,
        first,
        next,
        receipts: latest().receipts,
        artifacts: latest().artifacts,
      },
      null,
      2,
    ),
  );
  await dom.click(dom.button("配布物・回収状況"));
  expect(
    dom.container.querySelector('a[href*="approved-student"]'),
  ).not.toBeNull();
}, 30000);
it("PF-F149 actual two foreign collection QRs retain source image and create zero receipts for all three collections", async () => {
  const f = issued({}, r6().slice(0, 2)),
    a = issued({ title: "A" }, f.students).collection,
    b = issued({ title: "B" }, f.students).collection;
  f.state.collections.push(a, b);
  await realMount(f.state);
  const bytes = await scanDocument(
    [a.tokens[0].token, b.tokens[0].token],
    "CONFLICT A B",
  );
  const p = await realUpload(bytes, "F149.pdf");
  expect(p[0]).toMatchObject({
    status: "unreadable",
    resolution: "pending",
    sourcePage: 1,
  });
  expect(p[0].studentId).toBeUndefined();
  expect(dom.container.textContent).toContain("複数の管理QR");
  expect(
    dom.container.querySelector(".review-thumbnail img")?.getAttribute("src"),
  ).toBe(p[0].thumbnail);
  await dom.click(dom.button("回収状況を記録"));
  expect(latest().receipts).toHaveLength(0);
  expect(latest().batches[0].pages[0].resolution).toBe("pending");
  await writeFile(
    "artifacts/test-execution/functional/review/F149-observed.json",
    JSON.stringify(
      {
        collections: f.state.collections,
        pages: p,
        receipts: latest().receipts,
      },
      null,
      2,
    ),
  );
}, 30000);
it("PF-F156 actual S01 QR with visible NAME S02 stays S01 until teacher reopens and explicitly corrects to S02 with audit", async () => {
  const f = issued({}, r6().slice(0, 2));
  await realMount(f.state);
  const bytes = await scanDocument([f.collection.tokens[0].token], "NAME: S02");
  const p = await realUpload(bytes, "F156.pdf");
  expect(p[0]).toMatchObject({
    status: "matched",
    studentId: "S01",
    resolution: "accepted",
  });
  await dom.click(dom.button("回収状況を記録"));
  expect(latest().receipts[0].studentId).toBe("S01");
  await dom.click(dom.button("理由を記録して再確認へ"));
  await textarea("紙の名前と誤配布を確認");
  await dom.click(dom.button("理由を記録して変更"));
  expect(latest().receipts).toHaveLength(0);
  expect(
    dom.container.querySelector(".review-thumbnail img")?.getAttribute("src"),
  ).toBe(p[0].thumbnail);
  await dom.value(
    dom.container.querySelector(
      '[aria-label="1ページ目の生徒"]',
    ) as HTMLSelectElement,
    "S02",
  );
  await dom.value(dom.input("確認・保留・除外の理由"), "本人に確認しS02へ訂正");
  await dom.click(dom.button("照合する"));
  await dom.click(dom.button("回収状況を記録"));
  expect(latest().receipts).toHaveLength(1);
  expect(latest().receipts[0]).toMatchObject({
    studentId: "S02",
    pageNumber: 1,
    method: "manual",
  });
  expect(
    latest().events.some((e) => e.reason === "紙の名前と誤配布を確認"),
  ).toBe(true);
  expect(
    latest().events.some((e) => e.reason === "本人に確認しS02へ訂正"),
  ).toBe(true);
  await writeFile(
    "artifacts/test-execution/functional/review/F156-observed.json",
    JSON.stringify(
      {
        collection: f.collection,
        pages: p,
        receipts: latest().receipts,
        events: latest().events,
      },
      null,
      2,
    ),
  );
}, 30000);
