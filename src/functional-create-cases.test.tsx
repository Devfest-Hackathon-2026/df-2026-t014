// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import CreateDialog from "./CreateDialog";
import { testDom } from "./testDom";
import { r6, uiFixtures, testActor } from "./domain/functional-fixtures";
import { saveSeatLayout } from "./domain/workflows";
import { orderStudents, type CreateCollectionInput } from "./domain/logic";
import type { DocsSettings } from "./google/docsBridge";
import type { Collection, Student } from "./domain/types";
// Only renderer/worker boundary is simulated. This verifies production dialog decisions, not PDF raster quality.
vi.mock("./pdfClient", () => ({
  inspectSourcePdf: vi.fn(async (bytes: Uint8Array) => ({
    pageCount: bytes[0] || 2,
  })),
  generatePrintPreview: vi.fn(async () => ({ bytes: new Uint8Array([1, 2]) })),
}));
vi.mock("./PdfPreview", () => ({
  PdfPreview: ({
    onPageViewed,
  }: {
    onPageViewed?: (p: number, n: number) => void;
  }) => (
    <div data-testid="renderer-adapter">
      <button type="button" onClick={() => onPageViewed?.(1, 2)}>
        adapter page1
      </button>
      <button type="button" onClick={() => onPageViewed?.(2, 3)}>
        adapter page2
      </button>
      <button type="button" onClick={() => onPageViewed?.(3, 3)}>
        adapter page3
      </button>
    </div>
  ),
}));
let dom: ReturnType<typeof testDom>;
afterEach(async () => {
  await dom?.close();
  vi.clearAllMocks();
});
async function mount(
  students = r6(),
  previous?: Collection,
  source: {
    name: string;
    bytes: Uint8Array;
    defaults?: DocsSettings;
  } | null = null,
) {
  dom = testDom();
  const onCreate = vi.fn(
    async (_input: CreateCollectionInput, _source?: Uint8Array) => {},
  );
  await dom.render(
    <CreateDialog
      className="架空2年A組"
      count={students.length}
      source={source}
      busy={false}
      progress={null}
      error=""
      onClose={() => {}}
      onCreate={onCreate}
      students={students}
      previous={previous}
    />,
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 350));
  });
  return { onCreate, submit: () => dom.button("確認してQR付きPDFを作成") };
}
async function consent() {
  await dom.click(dom.button("adapter page1"));
  await dom.click(dom.button("adapter page2"));
  await dom.click(dom.container.querySelector(".shrink-consent input")!);
}
describe("Excel functional CreateDialog UI with explicit renderer boundary", () => {
  it("PF-F001 empty roster cannot create or call onCreate", async () => {
    const h = await mount([]);
    expect(h.submit().disabled).toBe(true);
    expect(dom.container.textContent).toContain("名簿を確認");
    await dom.click(h.submit());
    expect(h.onCreate).not.toHaveBeenCalled();
  });
  it("PF-F051 all six unassigned recipients require explicit append and create in attendance order", async () => {
    const students = r6().map((s) => ({ ...s, seat: null })),
      h = await mount(students);
    await consent();
    expect(h.submit().disabled).toBe(true);
    expect(dom.container.textContent).toContain("座席未配置が6人");
    await dom.click(dom.input("未配置者を番号順で最後にまとめる"));
    expect(h.submit().disabled).toBe(false);
    await dom.click(h.submit());
    expect(h.onCreate).toHaveBeenCalledTimes(1);
    expect(
      orderStudents(students, "snake", false, "top-left").map((s) => s.number),
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it("PF-F052 one unassigned person requires acknowledgement before production create handler runs", async () => {
    const students: Student[] = r6().map((s, i) =>
        i === 5 ? { ...s, seat: null } : s,
      ),
      h = await mount(students);
    await consent();
    expect(h.submit().disabled).toBe(true);
    await dom.click(h.submit());
    expect(h.onCreate).not.toHaveBeenCalled();
    await dom.click(dom.input("未配置者を番号順で最後にまとめる"));
    expect(h.submit().disabled).toBe(false);
    await dom.click(h.submit());
    expect(h.onCreate).toHaveBeenCalledTimes(1);
  });
  it("PF-F060 saved defaults initialize new dialog order/corner/reverse", async () => {
    const s = saveSeatLayout(
      uiFixtures().R6,
      {
        rows: 2,
        cols: 3,
        order: "snake",
        startCorner: "bottom-right",
        reverse: true,
      },
      testActor,
    );
    const previous = {
      ...s.collections[0],
      order: s.settings!.defaultOrder!,
      startCorner: s.settings!.defaultStartCorner!,
      reverse: s.settings!.defaultReverse!,
    };
    await mount(s.students, previous);
    expect(dom.input("配布順").value).toBe("snake");
    expect(dom.input("配布を始める位置").value).toBe("bottom-right");
    expect((dom.input("生徒の配布順を反転") as HTMLInputElement).checked).toBe(
      true,
    );
  });
  it("PF-F061 blank title prevents preview/creation and preserves previous collection", async () => {
    const previous = uiFixtures().R6.collections[0],
      before = structuredClone(previous),
      h = await mount(r6(), previous);
    await consent();
    await dom.value(dom.input("配布物名"), "  ");
    expect(h.submit().disabled).toBe(true);
    await dom.click(h.submit());
    expect(h.onCreate).not.toHaveBeenCalled();
    expect(previous).toEqual(before);
  });
  it("PF-F062 no required page disables production create action", async () => {
    const h = await mount();
    await consent();
    await dom.click(dom.input("2ページ目"));
    expect(h.submit().disabled).toBe(true);
    await dom.click(h.submit());
    expect(h.onCreate).not.toHaveBeenCalled();
  });
  it("PF-F117 PF-F118 consent remains blocked until all preview pages reported and changing layout invalidates it", async () => {
    const h = await mount();
    const check = () =>
      dom.container.querySelector(".shrink-consent input") as HTMLInputElement;
    expect(check().disabled).toBe(true);
    await dom.click(dom.button("adapter page1"));
    expect(check().disabled).toBe(true);
    await dom.click(dom.button("adapter page2"));
    expect(check().disabled).toBe(false);
    await dom.click(check());
    expect(h.submit().disabled).toBe(false);
    await dom.value(dom.input("QRの位置"), "bottom-left");
    expect(check().checked).toBe(false);
    expect(h.submit().disabled).toBe(true);
  });
  it("PF-F117 three-page source requires pages1,2,3 and separate consent before create", async () => {
    const h = await mount(r6(), undefined, {
      name: "three.pdf",
      bytes: new Uint8Array([3]),
    });
    const check = () =>
      dom.container.querySelector(".shrink-consent input") as HTMLInputElement;
    await dom.click(dom.button("adapter page1"));
    expect(check().disabled).toBe(true);
    await dom.click(dom.button("adapter page2"));
    expect(check().disabled).toBe(true);
    expect(h.submit().disabled).toBe(true);
    await dom.click(dom.button("adapter page3"));
    expect(check().disabled).toBe(false);
    expect(h.submit().disabled).toBe(true);
    await dom.click(check());
    expect(h.submit().disabled).toBe(false);
  });
  it("PF-F121 source defaults override prior settings while missing values inherit and new collection uses defaults", async () => {
    const previous = uiFixtures().R6.collections[0];
    previous.qrCorner = "bottom-left";
    previous.order = "column";
    previous.startCorner = "bottom-right";
    previous.reverse = true;
    previous.layoutMode = "management-band";
    await mount(r6(), previous, {
      name: "two.pdf",
      bytes: new Uint8Array([2]),
      defaults: {
        qrCorner: "top-left",
        order: "row",
        startCorner: "top-right",
        reverse: false,
        layoutMode: "reserved-corner",
      },
    });
    expect(dom.input("QRの位置").value).toBe("top-left");
    expect(dom.input("配布順").value).toBe("row");
    expect(dom.input("配布を始める位置").value).toBe("top-right");
    expect((dom.input("生徒の配布順を反転") as HTMLInputElement).checked).toBe(
      false,
    );
    await dom.close();
    await mount(r6(), previous);
    expect(dom.input("QRの位置").value).toBe("bottom-left");
    expect(dom.input("配布順").value).toBe("column");
    await dom.close();
    await mount();
    expect(dom.input("QRの位置").value).toBe("top-right");
    expect(dom.input("QR領域の確保方法").value).toBe("reserved-corner");
  });
  it("PF-F122 prior required pages are intersected with new source and fallback to all in-range pages", async () => {
    const previous = uiFixtures().R6.collections[0];
    previous.pageCount = 3;
    previous.requiredPages = [2, 3];
    for (const n of [2, 1]) {
      await mount(r6(), previous, {
        name: "new.pdf",
        bytes: new Uint8Array([n]),
      });
      const selected = [
        ...dom.container.querySelectorAll(".page-chips input"),
      ].flatMap((e, i) => ((e as HTMLInputElement).checked ? [i + 1] : []));
      expect(selected).toEqual(n === 2 ? [2] : [1]);
      await dom.close();
    }
  });
  it("PF-F123 first-three display lists exactly the real1/2/3 recipients with no synthetic extra", async () => {
    for (const n of [1, 2, 3]) {
      await mount(r6().slice(0, n));
      const facts = dom.container.querySelector(
        ".paperflow-print-facts",
      )!.textContent!;
      for (let i = 0; i < n; i++) expect(facts).toContain(r6()[i].name);
      for (let i = n; i < 6; i++) expect(facts).not.toContain(`${i + 1}番`);
      expect(facts).not.toContain("undefined");
      await dom.close();
    }
  });
});
