// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { readFile } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";
import CreateDialog from "./CreateDialog";
import { testDom } from "./testDom";
import { r6 } from "./domain/functional-fixtures";
import { inspectSourcePdf as realInspect } from "./pdf/documents";
import { generatePrintPreview, inspectSourcePdf } from "./pdfClient";
import type { PrintOptions } from "./domain/types";
vi.mock("./pdfClient", () => ({
  inspectSourcePdf: vi.fn(),
  generatePrintPreview: vi.fn(),
}));
vi.mock("./PdfPreview", () => ({
  PdfPreview: ({
    bytes,
    onPageViewed,
  }: {
    bytes: Uint8Array;
    onPageViewed?: (p: number, n: number) => void;
  }) => (
    <div data-preview={bytes[0]}>
      {[1, 2, 3].map((p) => (
        <button type="button" key={p} onClick={() => onPageViewed?.(p, 3)}>
          view{p}
        </button>
      ))}
    </div>
  ),
}));
let dom: ReturnType<typeof testDom>;
afterEach(async () => {
  await dom?.close();
  vi.resetAllMocks();
});
const wait = async () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 350));
  });
async function mount() {
  dom = testDom();
  vi.mocked(inspectSourcePdf).mockImplementation(realInspect);
  vi.mocked(generatePrintPreview).mockResolvedValue({
    bytes: new Uint8Array([9]),
  } as Awaited<ReturnType<typeof generatePrintPreview>>);
  const onCreate = vi.fn();
  await dom.render(
    <CreateDialog
      className="架空"
      count={2}
      source={null}
      students={r6().slice(0, 2)}
      busy={false}
      progress={null}
      error=""
      onClose={() => {}}
      onCreate={onCreate}
    />,
  );
  await wait();
  return onCreate;
}
async function upload(bytes: Uint8Array, name = "fixture.pdf") {
  const el = dom.container.querySelector("input[type=file]")!;
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
  await act(async () => {
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await wait();
}
async function pdf() {
  const d = await PDFDocument.create();
  for (let p = 0; p < 3; p++) d.addPage([595.28, 841.89]);
  return d.save();
}
const submit = () => dom.button("確認してQR付きPDFを作成");
async function consent() {
  for (const p of [1, 2, 3]) await dom.click(dom.button("view" + p));
  await dom.click(dom.container.querySelector(".shrink-consent input")!);
}
it("PF-F089 PF-F090 actual empty, PNG and UTF8 disguised PDFs clear preview and never issue or silently reuse previous source", async () => {
  const onCreate = await mount();
  await upload(await pdf());
  await consent();
  expect(submit().disabled).toBe(false);
  for (const bytes of [
    new Uint8Array(),
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    new TextEncoder().encode("not a PDF"),
  ]) {
    await upload(bytes);
    expect(submit().disabled).toBe(true);
    expect(dom.container.querySelector("[data-preview]")).toBeNull();
    await dom.click(submit());
    expect(onCreate).not.toHaveBeenCalled();
    expect(dom.container.textContent).toMatch(/PDF|空/);
  }
});
it("PF-F092 actual encrypted PDF refuses issue and decrypted three-page PDF restores preview only after renewed consent", async () => {
  const onCreate = await mount();
  const encrypted = new Uint8Array(
    await readFile("tests/fixtures/encrypted-test.pdf"),
  );
  await upload(encrypted);
  expect(dom.container.textContent).toContain("パスワード");
  expect(submit().disabled).toBe(true);
  expect(onCreate).not.toHaveBeenCalled();
  await upload(await pdf());
  expect(dom.container.querySelector("[data-preview]")).not.toBeNull();
  expect(submit().disabled).toBe(true);
  await consent();
  expect(submit().disabled).toBe(false);
  await dom.click(submit());
  expect(onCreate).toHaveBeenCalledTimes(1);
});
it("PF-F118 every actual QR/source/name/required-page change discards viewed pages and approval before regeneration", async () => {
  await mount();
  await upload(await pdf());
  for (const change of [
    () => dom.value(dom.input("QRの位置"), "bottom-left"),
    async () => upload(await pdf()),
    () => dom.click(dom.input("氏名を印字")),
    () => dom.click(dom.input("1ページ目")),
  ]) {
    if (!dom.container.querySelector("[data-preview]"))
      await upload(await pdf());
    await consent();
    expect(submit().disabled).toBe(false);
    await change();
    expect(submit().disabled).toBe(true);
    expect(
      (dom.container.querySelector(".shrink-consent input") as HTMLInputElement)
        .checked,
    ).toBe(false);
    expect(
      dom.container.querySelector(".preview-confirm-progress")?.textContent,
    ).toMatch(/0\s*\/\s*3/);
    await wait();
  }
  await upload(await pdf());
  await consent();
  expect(submit().disabled).toBe(false);
});
it("PF-F119 late completion of old QR preview cannot replace final bottom-right snapshot or re-enable consent early", async () => {
  await mount();
  await upload(await pdf());
  const releases: Array<{
    options: PrintOptions;
    resolve: (result: Awaited<ReturnType<typeof generatePrintPreview>>) => void;
  }> = [];
  vi.mocked(generatePrintPreview).mockImplementation(
    (options) => new Promise((resolve) => releases.push({ options, resolve })),
  );
  await dom.value(dom.input("QRの位置"), "top-right");
  await dom.value(dom.input("QRの位置"), "bottom-left");
  await wait();
  await dom.value(dom.input("QRの位置"), "bottom-right");
  await wait();
  expect(releases).toHaveLength(2);
  expect(submit().disabled).toBe(true);
  expect(releases[0].options.signal?.aborted).toBe(true);
  await act(async () =>
    releases[1].resolve({ bytes: new Uint8Array([33]) } as Awaited<
      ReturnType<typeof generatePrintPreview>
    >),
  );
  expect(
    dom.container.querySelector("[data-preview]")?.getAttribute("data-preview"),
  ).toBe("33");
  await act(async () =>
    releases[0].resolve({ bytes: new Uint8Array([22]) } as Awaited<
      ReturnType<typeof generatePrintPreview>
    >),
  );
  expect(
    dom.container.querySelector("[data-preview]")?.getAttribute("data-preview"),
  ).toBe("33");
  expect(dom.input("QRの位置").value).toBe("bottom-right");
  expect(submit().disabled).toBe(true);
  await consent();
  expect(submit().disabled).toBe(false);
});
