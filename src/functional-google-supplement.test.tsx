// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { webcrypto } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";
import App from "./App";
import ArchivePanel from "./ArchivePanel";
import { testDom } from "./testDom";
import {
  issued,
  qrPage,
  record,
  testActor,
  r6,
} from "./domain/functional-fixtures";
import { archiveCollections, planCollectionCleanup } from "./domain/lifecycle";
import { switchClassWorkspace } from "./domain/workspaces";
import { extractStudentPdf } from "./pdf/documents";
import { hashPdf, sourceForBatch, type CloudContext } from "./cloudWorkflow";
import type { AppState, ScanPage, DriveArtifact } from "./domain/types";
import type { GoogleWorkspaceClient } from "./google/client";
const data = vi.hoisted(() => ({
  initial: null as unknown,
  latest: null as unknown,
  pages: [] as ScanPage[],
  previews: new Map<string, Uint8Array>(),
  scan: vi.fn(),
}));
vi.mock("./domain/persistence", async (original) => ({
  ...(await original<typeof import("./domain/persistence")>()),
  readState: () => structuredClone(data.initial),
  writeState: (s: AppState) => {
    data.latest = structuredClone(s);
    return true;
  },
}));
vi.mock("./SeatPanel", async (original) => {
  const originalModule = await original<typeof import("./SeatPanel")>();
  return {
    ...originalModule,
    SeatPanel: (
      props: React.ComponentProps<typeof originalModule.SeatPanel>,
    ) => {
      data.latest = structuredClone(props.state);
      return <originalModule.SeatPanel {...props} />;
    },
  };
});
vi.mock("./pdfClient", () => ({
  scanPdf: data.scan,
  extractStudentPdf: (...args: Parameters<typeof extractStudentPdf>) =>
    extractStudentPdf(...args),
  generatePrintPdf: vi.fn(),
  generateSourcePdf: vi.fn(),
  createDemoScan: vi.fn(),
  inspectSourcePdf: vi.fn(),
  generatePrintPreview: vi.fn(),
}));
vi.mock("./PdfPreview", () => ({
  default: ({ bytes, title }: { bytes: Uint8Array; title?: string }) => {
    data.previews.set(title ?? "", bytes);
    return <div data-preview={title}>{title}</div>;
  },
}));
vi.mock("./useConcurrentSessionWarning", () => ({
  useConcurrentSessionWarning: () => false,
}));
let dom: ReturnType<typeof testDom>;
afterEach(async () => {
  await dom?.close();
  vi.clearAllMocks();
});
const latest = () => data.latest as AppState;
async function mount(s: AppState) {
  data.initial = s;
  data.latest = s;
  data.previews.clear();
  data.pages = [];
  data.scan
    .mockReset()
    .mockImplementation(async () => structuredClone(data.pages));
  dom = testDom();
  vi.stubGlobal("crypto", webcrypto);
  dom.dom.window.requestAnimationFrame = (cb) =>
    setTimeout(() => cb(Date.now()), 0) as unknown as number;
  dom.dom.window.cancelAnimationFrame = (id) => clearTimeout(id);
  await dom.render(<App />);
}
async function nav(text: string) {
  await dom.click(dom.button(text));
}
async function upload(
  bytes: Uint8Array,
  selector = ".upload-zone input[type=file]",
  name = "scan.pdf",
) {
  const el = dom.container.querySelector(selector)!;
  expect(el, `file input ${selector}`).toBeTruthy();
  await act(async () => {
    Object.defineProperty(el, "files", {
      configurable: true,
      value: [
        {
          name,
          size: bytes.length,
          arrayBuffer: async () => bytes.slice().buffer,
        },
      ],
    });
    el.dispatchEvent(new dom.dom.window.Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
  });
}
async function reason(text: string) {
  await act(async () => {
    const el = dom.container.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(
      dom.dom.window.HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(el, text);
    el.dispatchEvent(new dom.dom.window.Event("input", { bubbles: true }));
  });
}
async function coloredPdf(color: "red" | "blue", pages = 3) {
  const d = await PDFDocument.create(),
    font = await d.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= pages; n++) {
    const p = d.addPage([300, 300]);
    p.drawText(`${color === "red" ? "A" : "B"}-${n}`, {
      x: 50,
      y: 150,
      size: 70,
      font,
      color: color === "red" ? rgb(1, 0, 0) : rgb(0, 0, 1),
    });
  }
  return d.save();
}
async function checkPreview(
  title: string,
  letter: string,
  color: "red" | "blue",
) {
  const bytes = data.previews.get(title)!;
  expect(bytes).toBeTruthy();
  const pdf = getDocument({ data: bytes.slice(), useSystemFonts: true });
  const doc = await pdf.promise;
  try {
    expect(doc.numPages).toBe(1);
    const page = await doc.getPage(1),
      view = page.getViewport({ scale: 1 }),
      canvas = createCanvas(300, 300);
    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      viewport: view,
    }).promise;
    const text = (await page.getTextContent()).items
      .filter((i) => "str" in i)
      .map((i) => i.str)
      .join("");
    expect(text).toBe(letter);
    const image = canvas.getContext("2d").getImageData(0, 0, 300, 300).data;
    let red = 0,
      blue = 0;
    for (let i = 0; i < image.length; i += 4) {
      if (image[i] > 200 && image[i + 1] < 50 && image[i + 2] < 50) red++;
      if (image[i + 2] > 200 && image[i + 1] < 50 && image[i] < 50) blue++;
    }
    expect(color === "red" ? red : blue).toBeGreaterThan(100);
    expect(color === "red" ? blue : red).toBe(0);
    await mkdir("artifacts/test-execution/functional-supplement", {
      recursive: true,
    });
    await writeFile(
      `artifacts/test-execution/functional-supplement/${letter}.png`,
      canvas.toBuffer("image/png"),
    );
    return { text, red, blue };
  } finally {
    await pdf.destroy();
  }
}
function life() {
  const f = issued({}, r6().slice(0, 1)),
    other = issued({ title: "C2" }, r6().slice(0, 1)).collection;
  let s = record(
    f.state,
    f.collection,
    [qrPage(f.collection, "S01", 1, 1), qrPage(f.collection, "S01", 2, 2)],
    "B",
    "HASH",
    2,
  );
  s.collections.push(other);
  const c = s.collections[0];
  c.sourceDriveFileId = "O";
  c.printDriveFileId = "P";
  c.sourceDocumentId = "D";
  s.batches[0].sourceDriveFileId = "R";
  s.settings = {
    ...s.settings,
    ledgerId: "T",
    folderId: "F",
    schoolYear: "2026",
  };
  const artifact = (
    file: string,
    kind: DriveArtifact["kind"],
  ): DriveArtifact => ({
    id: "artifact-" + file,
    kind,
    collectionId: c.id,
    versionId: c.versionId,
    studentId: kind === "student" ? "S01" : undefined,
    batchId: kind === "source-scan" ? "B" : undefined,
    driveFileId: file,
    name: file + ".pdf",
    createdAt: c.createdAt,
    receiptIds: kind === "student" ? s.receipts.map((r) => r.id) : [],
  });
  s.artifacts = [
    artifact("O", "original"),
    artifact("P", "print"),
    artifact("R", "source-scan"),
    artifact("S", "student"),
    artifact("U", "unresolved"),
    artifact("A", "additional-print"),
  ];
  s.operations = [
    {
      id: "save-op",
      collectionId: c.id,
      kind: "archive",
      storageMode: "drive",
      recordStatus: "recorded",
      archiveStatus: "saved",
      receiptIds: s.receipts.map((r) => r.id),
      createdAt: c.createdAt,
      updatedAt: c.createdAt,
      plannedFileIds: { "source:B": "R", pending: "U" },
    },
  ];
  const otherClass = issued({ title: "C3" }, r6().slice(0, 1));
  s.savedClasses = [
    {
      id: "K2",
      className: "他クラス",
      students: otherClass.students,
      collections: [otherClass.collection],
      receipts: [],
      batches: [],
      events: [],
    },
  ];
  return { s, c, other };
}
async function mountArchive(initial: AppState) {
  dom = testDom();
  vi.stubGlobal("crypto", webcrypto);
  let state = initial;
  const errors: string[] = [];
  const client = {
    getIdentity: () => ({ id: "teacher", email: "teacher@example.test" }),
    isConnected: () => true,
    getFile: vi.fn(async (id: string) => ({
      id,
      mimeType: "application/pdf",
      trashed: false,
    })),
    trashFile: vi.fn(async () => {}),
    downloadPdf: vi.fn(),
  };
  function Harness() {
    const [current, setCurrent] = useState(initial);
    return (
      <ArchivePanel
        state={current}
        client={client as unknown as GoogleWorkspaceClient}
        busy={false}
        onError={(e) => errors.push(e)}
        onCommit={async (n) => {
          state = n;
          setCurrent(n);
        }}
      />
    );
  }
  await dom.render(<Harness />);
  return { state: () => state, errors, client };
}
describe("Additional functional cases through actual App/ArchivePanel handlers, isolated adapters", () => {
  it("PF-F003 same-name class switch preserves separate roster edits receipts folders and collection IDs", async () => {
    const a = issued({ title: "Aの課題" });
    a.state.classId = "CLASS-A";
    a.state.className = "2年A組";
    a.state.settings = { ledgerId: "TA", folderId: "FA" };
    const original = record(a.state, a.collection, [
      qrPage(a.collection, "S01", 1, 1),
    ]);
    const b = issued(
      { title: "Bの課題" },
      r6().map((s) => ({
        ...s,
        id: "B-" + s.id,
        seat: s.seat ? { row: s.seat.row + 1, col: s.seat.col } : null,
      })),
    );
    b.state.classId = "CLASS-B";
    b.state.className = "2年A組";
    b.state.settings = { ledgerId: "TB", folderId: "FB" };
    const switcher = switchClassWorkspace(b.state, {
      id: "CLASS-A",
      className: "2年A組",
    });
    const initial = { ...original, savedClasses: switcher.savedClasses };
    await mount(initial);
    const picker = () =>
      dom.container.querySelector(
        '[aria-label="作業するクラス"]',
      ) as HTMLSelectElement;
    await dom.value(picker(), "CLASS-B");
    await nav("座席");
    await dom.value(
      dom.container.querySelector(
        '[aria-label^="青木 葵の出席番号"]',
      ) as HTMLInputElement,
      "99",
    );
    await dom.click(dom.button("番号を保存"));
    const cells = () => [
      ...dom.container.querySelectorAll<HTMLButtonElement>(
        ".seat-board-grid button",
      ),
    ];
    expect(cells().length).toBeGreaterThan(0);
    const occupied = cells().find((e) => e.textContent?.includes("青木 葵"))!;
    await dom.click(occupied);
    const empty = cells().find((e) =>
      e.getAttribute("aria-label")?.includes("空席"),
    )!;
    await dom.click(empty);
    const bAfter = structuredClone(latest());
    expect(bAfter.students.find((s) => s.id === "B-S01")?.number).toBe(99);
    expect(bAfter.students.find((s) => s.id === "B-S01")?.seat).not.toEqual(
      b.students[0].seat,
    );
    await dom.value(picker(), "CLASS-A");
    await nav("座席");
    expect(latest().students).toEqual(original.students);
    expect(latest().receipts).toEqual(original.receipts);
    expect(latest().settings).toEqual(original.settings);
    expect(latest().collections).toEqual(original.collections);
    await dom.value(picker(), "CLASS-B");
    await nav("座席");
    expect(latest().students).toEqual(bAfter.students);
    expect(latest().settings).toEqual(b.state.settings);
    expect(latest().collections).toEqual(b.state.collections);
    expect(latest().receipts).toEqual([]);
  });
  it("PF-F190 ignoring an accepted page updates current receipt and shows old PDF as stale without Drive trash", async () => {
    const f = issued({}, r6().slice(0, 2));
    let s = record(
      f.state,
      f.collection,
      [qrPage(f.collection, "S01", 1, 1), qrPage(f.collection, "S01", 2, 2)],
      "old",
    );
    s.artifacts = [
      {
        id: "student",
        kind: "student",
        collectionId: f.collection.id,
        versionId: f.collection.versionId,
        studentId: "S01",
        driveFileId: "old-two-pages",
        name: "S01.pdf",
        createdAt: f.collection.createdAt,
        receiptIds: s.receipts.map((r) => r.id),
      },
    ];
    await mount(s);
    await nav("回収・照合");
    await dom.click(dom.button("理由を記録して再確認へ"));
    await reason("誤受理を確認");
    await dom.click(dom.button("理由を記録して変更"));
    await dom.value(
      dom.input("確認・保留・除外の理由"),
      "別書類だったため対象外",
    );
    await dom.click(dom.button("この元PDFページを全配布物で除外"));
    await dom.click(dom.button("回収状況を記録"));
    expect(latest().receipts.map((r) => r.pageNumber)).toEqual([2]);
    expect(latest().artifacts).toEqual(s.artifacts);
    await nav("配布物・回収");
    const row = [...dom.container.querySelectorAll("tbody tr")].find((e) =>
      e.textContent?.includes("青木 葵"),
    )!;
    expect(row.textContent).toContain("1 / 2");
    expect(row.textContent).toContain("前回保存分（現在の回収と差異あり）");
    expect(row.textContent).not.toContain("最新のPDF");
    expect(row.querySelector('a[href*="old-two-pages"]')).toBeTruthy();
  });
  it("PF-F191 comparison opens real extracted old red A1 and new blue B3 without replacing receipts", async () => {
    const f = issued({}, r6().slice(0, 2)),
      old = await coloredPdf("red"),
      current = await coloredPdf("blue");
    const s = record(
      f.state,
      f.collection,
      [qrPage(f.collection, "S01", 1, 1)],
      "old",
      await hashPdf(old),
      3,
    );
    await mount(s);
    await nav("回収・照合");
    data.pages = [
      qrPage(f.collection, "S01", 1, 1),
      { id: "u2", sourcePage: 2, status: "unreadable", resolution: "pending" },
      { id: "u3", sourcePage: 3, status: "unreadable", resolution: "pending" },
    ];
    await upload(old);
    await dom.click(dom.button("回収状況を記録"));
    const before = structuredClone(latest().receipts);
    data.pages = [
      { id: "u1", sourcePage: 1, status: "unreadable", resolution: "pending" },
      { id: "u2", sourcePage: 2, status: "unreadable", resolution: "pending" },
      qrPage(f.collection, "S01", 1, 3, {
        status: "duplicate",
        resolution: "pending",
      }),
    ];
    await upload(current);
    await dom.click(dom.button("既存と今回の画像を比較"));
    expect(dom.container.querySelector(".comparison-grid")).toBeTruthy();
    await checkPreview("既存の受領ページ", "A-1", "red");
    await checkPreview("今回のページ", "B-3", "blue");
    expect(data.previews.get("既存の受領ページ")).not.toEqual(
      data.previews.get("今回のページ"),
    );
    expect(latest().receipts).toEqual(before);
    await dom.click(dom.container.querySelector('[aria-label="閉じる"]')!);
    expect(dom.container.querySelector(".comparison-grid")).toBeNull();
    expect(latest().receipts).toEqual(before);
  });
  it("PF-F192 missing original asks for reselection and rejects wrong hash before matching comparison", async () => {
    const f = issued({}, r6().slice(0, 2)),
      old = await coloredPdf("red"),
      current = await coloredPdf("blue");
    const s = record(
      f.state,
      f.collection,
      [qrPage(f.collection, "S01", 1, 1)],
      "old",
      await hashPdf(old),
      3,
    );
    await mount(s);
    await nav("回収・照合");
    data.pages = [
      { id: "u1", sourcePage: 1, status: "unreadable", resolution: "pending" },
      { id: "u2", sourcePage: 2, status: "unreadable", resolution: "pending" },
      qrPage(f.collection, "S01", 1, 3, {
        status: "duplicate",
        resolution: "pending",
      }),
    ];
    await upload(current);
    await dom.click(dom.button("既存と今回の画像を比較"));
    expect(dom.container.textContent).toContain("原本再選択");
    expect(dom.container.querySelector(".comparison-grid")).toBeNull();
    await upload(current, 'input[aria-label="比較する旧原本PDF"]');
    expect(dom.container.textContent).toContain("記録した原本と一致しません");
    expect(dom.container.querySelector(".comparison-grid")).toBeNull();
    await upload(old, 'input[aria-label="比較する旧原本PDF"]');
    expect(dom.container.querySelector(".comparison-grid")).toBeTruthy();
    await checkPreview("既存の受領ページ", "A-1", "red");
    await checkPreview("今回のページ", "B-3", "blue");
    expect(latest().receipts).toEqual(s.receipts);
  });
  it("PF-F200 App archived filter and unarchive return same collection to normal list", async () => {
    const { s, c } = life(),
      initial = archiveCollections(s, [c.id], testActor);
    await mount(initial);
    await nav("配布物・回収");
    expect(
      [...dom.container.querySelectorAll(".collection-switcher button")].some(
        (e) => e.textContent?.includes(c.title),
      ),
    ).toBe(false);
    await dom.click(dom.input("アーカイブ済みの配布物も表示"));
    await dom.click(dom.button(c.title));
    await nav("接続・設定");
    await dom.value(dom.input("対象"), c.id);
    await dom.value(dom.input("操作"), "unarchive");
    await reason("再利用するため解除");
    await dom.click(
      dom.input("対象の配布物・件数・残すファイルを確認しました"),
    );
    await dom.click(dom.button("確認した対象のアーカイブを解除"));
    expect(latest().collections[0].archivedAt).toBeUndefined();
    expect(latest().collections[0].status).toBe("collecting");
    expect(latest().collections[0].tokens).toEqual(c.tokens);
    expect(latest().collections[0].versionId).toBe(c.versionId);
    expect(latest().receipts).toEqual(s.receipts);
    await nav("配布物・回収");
    await dom.click(dom.input("アーカイブ済みの配布物も表示"));
    expect(
      [...dom.container.querySelectorAll(".collection-switcher button")].some(
        (e) => e.textContent === c.title,
      ),
    ).toBe(true);
  });
  it("PF-F204 ArchivePanel shows six unique files and exact related record counts", async () => {
    const { s, c } = life();
    await mountArchive(s);
    await dom.value(dom.input("対象"), c.id);
    await dom.value(dom.input("操作"), "delete");
    const plan = planCollectionCleanup(s, [c.id]);
    expect(plan.counts).toEqual({
      collections: 1,
      tokens: 2,
      recipients: 1,
      receipts: 2,
      batches: 1,
      pages: 2,
      artifacts: 6,
      operations: 1,
    });
    expect(
      [...dom.container.querySelectorAll("details li a")]
        .map((a) => a.getAttribute("href")?.split("/").at(-2))
        .sort(),
    ).toEqual(["A", "O", "P", "R", "S", "U"]);
    const text = dom.container.textContent;
    for (const label of [
      "配布物1件",
      "対応token 2件",
      "対象者の対応 1件",
      "回収記録 2件",
      "回収PDF 1束・確認ページ 2件",
      "Driveファイル 6件",
      "成果物記録 6件",
      "保存操作 1件",
    ])
      expect(text).toContain(label);
  });
  it("PF-F207 delete first consumer then retrieve common original for second and include it in last cleanup", async () => {
    const { s, c, other } = life(),
      bytes = await coloredPdf("red", 2),
      hash = await hashPdf(bytes);
    s.receipts = s.receipts.filter((r) => r.sourcePage === 1);
    s.batches[0].pages = s.batches[0].pages.filter((p) => p.sourcePage === 1);
    s.batches[0].hash = hash;
    s.scanSources!.forEach((source) => {
      source.hash = hash;
    });
    s.artifacts!.find((a) => a.kind === "student")!.receiptIds = s.receipts.map(
      (r) => r.id,
    );
    let shared = record(s, other, [qrPage(other, "S01", 1, 2)], "B2", hash, 2);
    expect(shared.batches[1].sourceDriveFileId).toBeUndefined();
    const h = await mountArchive(shared);
    await dom.value(dom.input("対象"), c.id);
    await dom.value(dom.input("操作"), "delete");
    const item = [...dom.container.querySelectorAll("details li")].find((e) =>
      e.querySelector("a")?.getAttribute("href")?.includes("/R/"),
    );
    expect(item?.textContent).toContain("残す");
    await reason("最初の配布物だけ整理");
    await dom.click(
      dom.input("対象の配布物・件数・残すファイルを確認しました"),
    );
    await dom.click(dom.button("確認した対象をゴミ箱へ移す"));
    expect(h.errors).toEqual([]);
    expect(h.state().collections[0].deletedAt).toBeTruthy();
    expect(h.client.trashFile.mock.calls.flat()).not.toContain("R");
    h.client.downloadPdf.mockResolvedValue(bytes);
    const context = {
      client: h.client as unknown as GoogleWorkspaceClient,
      scanCache: new Map(),
    } as CloudContext;
    expect(await sourceForBatch(context, h.state(), "B2")).toEqual(bytes);
    expect(h.client.downloadPdf).toHaveBeenCalledWith("R");
    expect(h.state().batches[1].sourceDriveFileId).toBeUndefined();
    expect(
      planCollectionCleanup(h.state(), [other.id]).files.find(
        (f) => f.fileId === "R",
      )?.status,
    ).toBe("pending");
  });
});
