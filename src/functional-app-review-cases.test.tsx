// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import App from "./App";
import { scanPdf } from "./pdfClient";
import { testDom } from "./testDom";
import {
  issued,
  qrPage,
  record,
  baseState,
} from "./domain/functional-fixtures";
import type { AppState, ScanPage, Collection } from "./domain/types";
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
  vi.restoreAllMocks();
  vi.useRealTimers();
});
/** Observe the completed UI operation, including real WebCrypto work outside React's event promise. */
async function waitForUi(assertComplete: () => void, timeoutMs = 3000) {
  const deadline = performance.now() + timeoutMs;
  let failure: unknown;
  do {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    try {
      assertComplete();
      return;
    } catch (error) {
      failure = error;
    }
  } while (performance.now() < deadline);
  throw failure;
}
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
async function upload(bytes = new Uint8Array([1, 2, 3]), name = "scan.pdf") {
  const el = dom.container.querySelector(".upload-zone input[type=file]")!;
  await act(async () => {
    Object.defineProperty(el, "files", {
      configurable: true,
      value: [
        { name, size: bytes.length, arrayBuffer: async () => bytes.buffer },
      ],
    });
    el.dispatchEvent(new dom.dom.window.Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
  });
}
const latest = () => fixture.latest as AppState;
async function setReason(value: string) {
  await dom.value(dom.input("確認・保留・除外の理由"), value);
}
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
function unreadable(): ScanPage {
  return {
    id: "p1",
    sourcePage: 1,
    status: "unreadable",
    resolution: "pending",
    thumbnail: "data:image/png;base64,TEST",
  };
}
describe("Excel functional App production review handlers (decoder/storage adapters)", () => {
  it("PF-F184 manual matching without reason is blocked before any receipt is accepted", async () => {
    const f = issued();
    await mount(f.state, [unreadable()]);
    await upload();
    await dom.value(
      dom.container.querySelector(
        '[aria-label="1ページ目の生徒"]',
      ) as HTMLSelectElement,
      "S03",
    );
    const match = dom.button("照合する");
    expect(match.disabled).toBe(true);
    await dom.click(match);
    expect(dom.container.querySelectorAll(".review-card")).toHaveLength(1);
    expect((fixture.latest as AppState).receipts).toHaveLength(0);
  });
  it("PF-F184 PF-F179 explicit manual reason and actor persist in receipt review audit through App save", async () => {
    const f = issued();
    await mount(f.state, [unreadable()]);
    await upload();
    await dom.value(
      dom.container.querySelector(
        '[aria-label="1ページ目の生徒"]',
      ) as HTMLSelectElement,
      "S03",
    );
    await setReason("紙の番号と氏名を確認");
    await dom.click(dom.button("照合する"));
    expect(dom.container.querySelectorAll(".review-card")).toHaveLength(0);
    await dom.click(dom.button("回収状況を記録"));
    expect(latest().receipts).toHaveLength(1);
    expect(latest().receipts[0]).toMatchObject({
      studentId: "S03",
      method: "manual",
      actor: "ローカルの先生",
    });
    expect(
      latest().events.find((e) => e.action === "manual_assignment"),
    ).toMatchObject({
      reason: "紙の番号と氏名を確認",
      actor: "ローカルの先生",
    });
    expect(latest().batches[0].pages[0]).toMatchObject({
      reviewReason: "紙の番号と氏名を確認",
      reviewedBy: "ローカルの先生",
      sourcePage: 1,
    });
  });
  it("PF-F181 manual person choices exclude current roster people who were never issued", async () => {
    const f = issued({}, issued().students.slice(0, 2));
    f.state.students = issued().students;
    await mount(f.state, [unreadable()]);
    await upload();
    const options = [
      ...dom.container.querySelectorAll(
        '[aria-label="1ページ目の生徒"] option',
      ),
    ].map((e) => (e as HTMLOptionElement).value);
    expect(options).toEqual(["", "S01", "S02"]);
  });
  it("PF-F185 hold action preserves reason, original position and pending notice without a person assignment", async () => {
    const f = issued();
    await mount(f.state, [unreadable()]);
    await upload();
    await setReason("薄い文字のため再スキャン依頼");
    await dom.click(dom.button("理由を付けて保留"));
    await dom.click(dom.button("回収状況を記録"));
    expect(latest().receipts).toHaveLength(0);
    expect(latest().batches[0].pages[0]).toMatchObject({
      resolution: "pending",
      sourcePage: 1,
      reviewReason: "薄い文字のため再スキャン依頼",
    });
    expect(dom.container.textContent).toContain("未回収人数は暫定");
    expect(
      dom.container.querySelector(".review-thumbnail img")?.getAttribute("src"),
    ).toBe("data:image/png;base64,TEST");
  });
  it("PF-F178 PF-F183 dirty mixed-PDF handoff commits accepted and explicit pending decisions before next collection", async () => {
    const f = issued(),
      b = issued({ title: "別の課題" }).collection;
    f.state.collections.push(b);
    const pages = [
      qrPage(f.collection, "S01", 1, 1),
      qrPage(b, "S02", 1, 2),
      { ...unreadable(), id: "p3", sourcePage: 3 },
    ];
    await mount(f.state, pages);
    await upload();
    await dom.value(
      dom.container.querySelector(
        '[aria-label="回収する配布物"]',
      ) as HTMLSelectElement,
      b.id,
    );
    expect(dom.container.textContent).toContain("未記録の確認内容");
    expect(
      (
        dom.container.querySelector(
          '[aria-label="回収する配布物"]',
        ) as HTMLSelectElement
      ).value,
    ).toBe(f.collection.id);
    const hold = [...dom.container.querySelectorAll(".review-card")].find((e) =>
      e.textContent?.includes("3ページ目"),
    )!;
    await dom.value(hold.querySelector("input")!, "確認保留の理由A");
    await dom.click(
      [...hold.querySelectorAll("button")].find((e) =>
        e.textContent?.includes("理由を付けて保留"),
      )!,
    );
    await dom.click(dom.button("別の課題へ切り替える"));
    expect(
      (
        dom.container.querySelector(
          '[aria-label="回収する配布物"]',
        ) as HTMLSelectElement
      ).value,
    ).toBe(b.id);
    expect(latest().receipts).toHaveLength(1);
    expect(
      latest().batches[0].pages.find((p) => p.sourcePage === 3)?.reviewReason,
    ).toBe("確認保留の理由A");
    expect(dom.container.textContent).toContain("別の配布物で処理済み");
    await dom.click(dom.button("回収状況を記録"));
    await dom.value(
      dom.container.querySelector(
        '[aria-label="回収する配布物"]',
      ) as HTMLSelectElement,
      f.collection.id,
    );
    const restored = [...dom.container.querySelectorAll(".review-card")].find(
      (e) => e.textContent?.includes("3ページ目"),
    )!;
    expect((restored.querySelector("input") as HTMLInputElement).value).toBe(
      "確認保留の理由A",
    );
    expect(latest().receipts).toHaveLength(2);
  });
  it("PF-F220 dirty review refuses another PDF without discarding bytes, original metadata or reason", async () => {
    const f = issued();
    await mount(f.state, [unreadable()]);
    await upload(new Uint8Array([1, 2, 3]), "original.pdf");
    await setReason("未保存の保留理由");
    await dom.click(dom.button("理由を付けて保留"));
    const scans = fixture.scanCalls;
    await upload(new Uint8Array([4, 5, 6]), "different.pdf");
    expect(fixture.scanCalls).toBe(scans);
    expect(dom.container.textContent).toContain("未記録の確認内容");
    expect(dom.container.textContent).toContain("original.pdf");
    expect(
      (dom.input("確認・保留・除外の理由") as HTMLInputElement).value,
    ).toBe("未保存の保留理由");
    await dom.click(dom.button("回収状況を記録"));
    expect(latest().batches[0].fileName).toBe("original.pdf");
    expect(latest().batches[0].pages[0].reviewReason).toBe("未保存の保留理由");
    await upload(new Uint8Array([4, 5, 6]), "different.pdf");
    expect(fixture.scanCalls).toBe(scans + 1);
    expect(dom.container.textContent).toContain("different.pdf");
  });
  it("PF-F182 closed archived owner is opened directly for correction and never re-recorded on handoff", async () => {
    const f = issued(),
      bytes = new Uint8Array([1, 2, 3]),
      hash = Buffer.from(
        await webcrypto.subtle.digest("SHA-256", bytes),
      ).toString("hex");
    let s = record(
      f.state,
      f.collection,
      [qrPage(f.collection, "S01", 1, 1)],
      "OWNER",
      hash,
      2,
    );
    s.collections[0] = {
      ...s.collections[0],
      status: "closed",
      archivedAt: "2026-11-10T00:00:00Z",
    };
    const b = issued({ title: "現在の課題" }).collection;
    s.collections.push(b);
    await mount(s, [qrPage(f.collection, "S01", 1, 1), qrPage(b, "S02", 1, 2)]);
    await upload(bytes);
    await dom.click(dom.button("の元の記録へ"));
    expect(
      (
        dom.container.querySelector(
          '[aria-label="回収する配布物"]',
        ) as HTMLSelectElement
      ).value,
    ).toBe(f.collection.id);
    expect(
      latest().collections.find((c) => c.id === f.collection.id)?.status,
    ).toBe("closed");
    await dom.click(dom.button("理由を記録して再確認へ"));
    await textarea("誤った割当を確認し取消");
    await dom.click(dom.button("理由を記録して変更"));
    expect(
      latest().receipts.filter((r) => r.collectionId === f.collection.id),
    ).toHaveLength(0);
    expect(
      latest().receipts.filter((r) => r.collectionId === b.id),
    ).toHaveLength(1);
    expect(
      latest().collections.find((c) => c.id === f.collection.id)?.status,
    ).toBe("closed");
    expect(
      dom.container.querySelector('[role="alert"]')?.textContent ?? "",
    ).not.toContain("回収受付");
    // Handoff rehashes the same source asynchronously. Keep the hash pending
    // deliberately so this regression cannot pass merely due to fast execution.
    const digest = webcrypto.subtle.digest.bind(webcrypto.subtle);
    let resumeHash: (() => void) | undefined;
    const hashSpy = vi.spyOn(webcrypto.subtle, "digest").mockImplementationOnce(
      (algorithm, data) =>
        new Promise((resolve, reject) => {
          resumeHash = () => {
            void digest(algorithm, data).then(resolve, reject);
          };
        }),
    );
    const target = () =>
      dom.container.querySelector(
        '[aria-label="回収する配布物"]',
      ) as HTMLSelectElement;
    await dom.value(target(), b.id);
    expect(resumeHash).toBeTypeOf("function");
    expect(target().disabled).toBe(true);
    expect(target().value).toBe(f.collection.id);
    await act(async () => {
      resumeHash!();
    });
    await waitForUi(() => {
      expect(target().disabled).toBe(false);
      expect(target().value).toBe(b.id);
      expect(dom.container.textContent).toContain("別の配布物");
    });
    hashSpy.mockRestore();
    expect(
      latest().receipts.filter((r) => r.collectionId === b.id),
    ).toHaveLength(1);
    expect(
      latest().receipts.filter((r) => r.collectionId === f.collection.id),
    ).toHaveLength(0);
  });

  it("PF-F088 deadline uses school timezone across four midnight boundaries and avoids inferring submission lateness", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (const [time, overdue] of [
      ["2026-11-09T14:59:00Z", false],
      ["2026-11-09T15:00:00Z", false],
      ["2026-11-10T14:59:00Z", false],
      ["2026-11-10T15:00:00Z", true],
    ] as const) {
      vi.setSystemTime(new Date(time));
      const f = issued({ dueDate: "2026-11-10" });
      await mount(f.state, []);
      await dom.click(dom.button("配布物・回収状況"));
      expect(
        dom.container.textContent!.includes("回収期限を過ぎています"),
      ).toBe(overdue);
      if (overdue)
        expect(dom.container.textContent).toContain(
          "スキャン日時だけでは提出の遅れを判定しません",
        );
      await dom.close();
    }
  });
  it("PF-F002 duplicate-name students show distinct completed/uncollected rows and seat state", async () => {
    const f = issued({ pageCount: 1, requiredPages: [1] }),
      s = record(f.state, f.collection, [qrPage(f.collection, "S03", 1, 1)]);
    await mount(s, []);
    await dom.click(dom.button("配布物・回収状況"));
    const rows = [...dom.container.querySelectorAll("tr")].filter((el) =>
      el.textContent?.includes("佐藤 蓮"),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("回収済み");
    expect(rows[1].textContent).toContain("未回収");
    await dom.click(dom.button("座席表"));
    const cells = [
      ...dom.container.querySelectorAll(".seat-board-cell"),
    ].filter((el) => el.textContent?.includes("佐藤 蓮"));
    expect(cells[0].className).toContain("seat-status-complete");
    expect(cells[1].className).toContain("seat-status-uncollected");
  });
  it("PF-F179 unreadable source2 assigned to S01-p2 completes prior p1 without merging another same-name recipient", async () => {
    const f = issued(),
      page = { ...unreadable(), id: "p2", sourcePage: 2 };
    await mount(f.state, [qrPage(f.collection, "S01", 1, 1), page]);
    await upload();
    await dom.value(
      dom.container.querySelector(
        '[aria-label="2ページ目の生徒"]',
      ) as HTMLSelectElement,
      "S01",
    );
    await dom.value(
      dom.container.querySelector(
        '[aria-label="2ページ目のページ番号"]',
      ) as HTMLSelectElement,
      "2",
    );
    await setReason("番号と本文の2頁目を紙で確認");
    await dom.click(dom.button("照合する"));
    await dom.click(dom.button("回収状況を記録"));
    expect(latest().receipts).toHaveLength(2);
    expect(latest().receipts.find((r) => r.sourcePage === 2)).toMatchObject({
      studentId: "S01",
      pageNumber: 2,
      method: "manual",
      actor: "ローカルの先生",
    });
    await dom.click(dom.button("回収一覧を見る"));
    const row = [...dom.container.querySelectorAll("tr")].find((el) =>
      el.textContent?.includes("青木 葵"),
    )!;
    expect(row.textContent).toContain("回収済み");
  });

  it("PF-F195 same-original replacement shows old source ignored and new source accepted after App normalization", async () => {
    const f = issued(),
      bytes = new Uint8Array([1, 2, 3]),
      hash = Buffer.from(
        await webcrypto.subtle.digest("SHA-256", bytes),
      ).toString("hex"),
      pages = [
        qrPage(f.collection, "S01", 1, 1),
        { ...unreadable(), id: "p2", sourcePage: 2 },
        qrPage(f.collection, "S01", 1, 3),
      ];
    const s = record(f.state, f.collection, [pages[0]], "OLD", hash, 3);
    await mount(s, pages);
    await upload(bytes);
    const dup = [...dom.container.querySelectorAll(".review-card")].find((el) =>
      el.textContent?.includes("重複するページ"),
    )!;
    expect(dup.textContent).toContain("3ページ目");
    await dom.value(dup.querySelector("input")!, "今回画像の方が鮮明");
    await dom.click(
      [...dup.querySelectorAll("button")].find((el) =>
        el.textContent?.includes("このページに差し替える"),
      )!,
    );
    await dom.click(dom.button("差し替えを確定"));
    await dom.click(dom.button("回収状況を記録"));
    expect(latest().receipts).toHaveLength(1);
    expect(latest().receipts[0].sourcePage).toBe(3);
    expect(
      latest().batches[0].pages.find((p) => p.sourcePage === 1)?.resolution,
    ).toBe("ignored");
    expect(
      latest().batches[0].pages.find((p) => p.sourcePage === 3)?.resolution,
    ).toBe("accepted");
    const rows = [...dom.container.querySelectorAll(".history-row")].map(
      (el) => el.textContent,
    );
    expect(
      rows.some(
        (t) => t?.includes("元PDF 1ページ") && t.includes("元PDF全体から除外"),
      ),
    ).toBe(true);
    expect(
      rows.some((t) => t?.includes("元PDF 3ページ") && t.includes("採用")),
    ).toBe(true);
  });
  it("PF-F226 damaged common-source backup cannot replace current App workspace", async () => {
    const f = issued(),
      s = record(f.state, f.collection, [qrPage(f.collection, "S01", 1, 1)]),
      bad = structuredClone(s);
    bad.batches[0].sourceId = "missing";
    await mount(s, []);
    await dom.click(dom.button("接続・設定"));
    const el = dom.container.querySelector(
      'input[accept="application/json,.json"]',
    )!;
    await act(async () => {
      Object.defineProperty(el, "files", {
        configurable: true,
        value: [{ size: 2000, text: async () => JSON.stringify(bad) }],
      });
      el.dispatchEvent(new dom.dom.window.Event("change", { bubbles: true }));
    });
    expect(
      dom.container.querySelector('[role="alert"]')?.textContent,
    ).toContain("形式を確認できません");
    expect(latest().batches).toEqual(s.batches);
    expect(latest().receipts).toEqual(s.receipts);
    expect(dom.container.textContent).toContain("サンプルモード");
  });
  it("PF-F199 PF-F216 archived or logically deleted collections stay absent from ordinary home recent list", async () => {
    for (const flag of ["archivedAt", "deletedAt"]) {
      const f = issued();
      f.state.collections[0] = {
        ...f.collection,
        [flag]: "2026-11-10T00:00:00Z",
      };
      await mount(f.state, []);
      await dom.click(dom.button("ホーム"));
      expect(dom.container.querySelectorAll(".collection-row")).toHaveLength(0);
      await dom.close();
    }
  });
  it("PF-F060 saving seat route changes the next App create dialog defaults independently of QR corner", async () => {
    const f = issued();
    await mount(f.state, []);
    await dom.click(dom.button("座席表"));
    await dom.value(dom.input("配布順"), "snake");
    await dom.value(dom.input("開始位置"), "bottom-right");
    await dom.click(dom.input("逆順"));
    await dom.click(dom.button("配置・順序を保存"));
    await dom.click(dom.button("配布物・回収状況"));
    await dom.click(dom.button("配布物を作る"));
    expect(dom.input("配布順").value).toBe("snake");
    expect(dom.input("配布を始める位置").value).toBe("bottom-right");
    expect((dom.input("生徒の配布順を反転") as HTMLInputElement).checked).toBe(
      true,
    );
    expect(dom.input("QRの位置").value).toBe("top-right");
  });
});

const pixelTruth = JSON.parse(
  readFileSync("tests/fixtures/pixel-source-truth.json", "utf8"),
) as {
  collection: Collection;
  results: Array<{ ids: string[]; observed: ScanPage[] }>;
};
function pixelInput(id: string) {
  const collection = structuredClone(pixelTruth.collection);
  return {
    state: { ...baseState(collection.recipients), collections: [collection] },
    pages: structuredClone(
      pixelTruth.results.find((r) => r.ids.includes(id))!.observed,
    ),
  };
}
it("PF-F139 actual Chrome logical-p2 output enters App as accepted review but not a persisted receipt until explicit save", async () => {
  const f = pixelInput("PF-F139");
  await mount(f.state, f.pages);
  await upload();
  expect(latest().receipts).toHaveLength(0);
  expect(dom.button("回収状況を記録").disabled).toBe(false);
  expect(dom.container.textContent).not.toContain("回収状況を記録しました");
  await dom.click(dom.button("回収状況を記録"));
  expect(latest().receipts).toHaveLength(1);
  expect(latest().receipts[0]).toMatchObject({
    studentId: "S01",
    pageNumber: 2,
    sourcePage: 1,
  });
});
it("PF-F155 actual unfilled QR paper is a received page without signature/consent/completion claims", async () => {
  const f = pixelInput("PF-F155");
  await mount(f.state, f.pages);
  await upload();
  expect(dom.container.querySelectorAll(".review-card")).toHaveLength(0);
  await dom.click(dom.button("回収状況を記録"));
  expect(latest().receipts[0]).toMatchObject({
    studentId: "S01",
    pageNumber: 1,
  });
  expect(dom.container.textContent).not.toMatch(/署名済み|記入完了|同意済み/);
  await dom.click(dom.button("配布物・回収状況"));
  expect(dom.container.textContent).not.toMatch(/署名済み|記入完了|同意済み/);
});
it("PF-F168 actual three unreadable pages stay unassigned with reasons and provisional zero-completed display after save", async () => {
  const f = pixelInput("PF-F168");
  await mount(f.state, f.pages);
  await upload();
  expect(dom.container.querySelectorAll(".review-card")).toHaveLength(3);
  for (const card of dom.container.querySelectorAll(".review-card")) {
    await dom.value(card.querySelector("input")!, "原本の氏名を先生が確認予定");
    await dom.click(
      [...card.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("理由を付けて保留"),
      )!,
    );
  }
  await dom.click(dom.button("回収状況を記録"));
  expect(latest().receipts).toHaveLength(0);
  expect(latest().batches[0].pages).toHaveLength(3);
  expect(
    latest().batches[0].pages.every(
      (p) =>
        p.resolution === "pending" &&
        !p.studentId &&
        p.reviewReason === "原本の氏名を先生が確認予定",
    ),
  ).toBe(true);
  expect(dom.container.textContent).toContain("未回収人数は暫定");
  await dom.click(dom.button("配布物・回収状況"));
  expect(dom.container.querySelectorAll(".status-complete")).toHaveLength(0);
});
it("PF-F151 actual other-collection QR offers explicit owner route while current collection has no receipt", async () => {
  const f = pixelInput("PF-F151"),
    other = issued({ title: "現在選択の別課題" }, f.state.students).collection;
  f.state.collections.unshift(other);
  await mount(f.state, f.pages);
  await upload();
  expect(latest().receipts).toHaveLength(0);
  expect(dom.container.textContent).toContain("同じPDFに別の配布物があります");
  expect(dom.button(pixelTruth.collection.title + "へ切り替える")).toBeTruthy();
  expect(
    dom.container.querySelector('[aria-label="回収する配布物"]'),
  ).toHaveProperty("value", other.id);
});

it("PF-F165 recorded workspace and archived links survive all three real decoder error outputs without new success", async () => {
  const f = issued();
  const state = record(
    f.state,
    f.collection,
    [qrPage(f.collection, "S01", 1, 1)],
    "existing",
    "old-hash",
  );
  state.batches[0].sourceDriveFileId = "original-scan";
  state.artifacts = [
    {
      id: "archive",
      kind: "student",
      collectionId: f.collection.id,
      versionId: f.collection.versionId,
      studentId: "S01",
      driveFileId: "old-student-pdf",
      name: "old.pdf",
      receiptIds: [state.receipts[0].id],
      createdAt: f.collection.createdAt,
    },
  ];
  await mount(state, []);
  const before = structuredClone(latest());
  const errors = pixelTruth.results.find((r) => r.ids.includes("PF-F165"))!
    .observed as unknown as string[];
  for (let i = 0; i < 3; i++) {
    const error = errors[i].replace(/^Error: /, "");
    vi.mocked(scanPdf).mockRejectedValueOnce(new Error(error));
    await upload(
      i === 0 ? new Uint8Array() : new Uint8Array([i, 1, 2]),
      ["zero.pdf", "corrupt.pdf", "encrypted.pdf"][i],
    );
    expect(dom.container.textContent).toContain(error);
    expect(latest()).toEqual(before);
    expect(latest().batches).toHaveLength(1);
    expect(latest().receipts).toHaveLength(1);
    expect(latest().artifacts?.[0].driveFileId).toBe("old-student-pdf");
    expect(
      dom.container.querySelector("button[disabled]")?.textContent,
    ).not.toBe("解析をキャンセル");
  }
  await dom.click(dom.button("配布物・回収状況"));
  expect(
    dom.container.querySelector('a[href*="old-student-pdf"]'),
  ).not.toBeNull();
});
it("PF-F167 App abort releases processing state and same120page PDF restarts from first page with zero premature receipts", async () => {
  const f = pixelInput("PF-F140");
  const pair = [f.pages[1], f.pages[3]];
  f.pages = Array.from({ length: 120 }, (_, i) => ({
    ...pair[i % 2],
    id: "p" + (i + 1),
    sourcePage: i + 1,
    ...(i > 1
      ? { status: "duplicate" as const, resolution: "pending" as const }
      : {}),
  }));
  await mount(f.state, f.pages);
  let signal: AbortSignal | undefined;
  vi.mocked(scanPdf).mockImplementationOnce(async (options) => {
    signal = options.signal;
    options.onProgress?.({
      current: 39,
      total: 120,
      message: "39 / 120 pages",
    });
    return new Promise((_, reject) =>
      options.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("解析を中止しました。", "AbortError")),
        { once: true },
      ),
    );
  });
  const bytes = new Uint8Array([120, 1, 2, 3]);
  await upload(bytes, "same120.pdf");
  expect(dom.button("解析をキャンセル")).toBeTruthy();
  await dom.click(dom.button("解析をキャンセル"));
  expect(signal?.aborted).toBe(true);
  expect(latest().receipts).toHaveLength(0);
  expect(latest().batches).toHaveLength(0);
  expect(
    (dom.container.querySelector(".upload-zone input") as HTMLInputElement)
      .disabled,
  ).toBe(false);
  expect(
    [...dom.container.querySelectorAll("button")].some((b) =>
      b.textContent?.includes("解析をキャンセル"),
    ),
  ).toBe(false);
  await upload(bytes, "same120.pdf");
  expect(latest().receipts).toHaveLength(0);
  await dom.click(dom.button("回収状況を記録"));
  expect(latest().batches[0].pageCount).toBe(120);
  expect(latest().batches[0].pages.map((p) => p.sourcePage)).toEqual(
    Array.from({ length: 120 }, (_, i) => i + 1),
  );
  expect(latest().receipts).toHaveLength(2);
  expect(new Set(latest().receipts.map((r) => r.pageNumber))).toEqual(
    new Set([1, 2]),
  );
});
