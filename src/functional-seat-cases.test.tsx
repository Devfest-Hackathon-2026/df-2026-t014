// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { useState } from "react";
import { SeatPanel } from "./SeatPanel";
import { testDom } from "./testDom";
import {
  uiFixtures,
  testActor,
  issued,
  baseState,
  r6,
} from "./domain/functional-fixtures";
let dom: ReturnType<typeof testDom>;
afterEach(async () => {
  await dom?.close();
});
async function mount(name = "R6", supplied?: ReturnType<typeof baseState>) {
  dom = testDom();
  let current = supplied ?? uiFixtures()[name];
  if (name === "STATUS6")
    current.collections.push(issued({ title: "別の配布物" }).collection);
  function Harness() {
    const [state, setState] = useState(current);
    const [collectionId, setCollectionId] = useState(
      current.collections[0]?.id,
    );
    return (
      <SeatPanel
        state={state}
        collection={state.collections.find((c) => c.id === collectionId)}
        busy={false}
        sample
        actor={testActor.actor}
        onChange={(next) => {
          current = next;
          setState(next);
        }}
        onCollectionChange={setCollectionId}
      />
    );
  }
  await dom.render(<Harness />);
  const cell = (r: number, c: number) =>
    dom.container.querySelector(`[aria-label^="${r}行${c}列 "]`)!;
  return { state: () => current, cell };
}
describe("Excel functional SeatPanel real handlers (jsdom)", () => {
  it("PF-F039 swaps two occupied seats with audit and leaves the other four untouched", async () => {
    const h = await mount(),
      before = structuredClone(h.state());
    await dom.click(h.cell(1, 1));
    await dom.click(h.cell(2, 3));
    expect(h.state().students.find((s) => s.id === "S01")?.seat).toEqual({
      row: 1,
      col: 2,
    });
    expect(h.state().students.find((s) => s.id === "S06")?.seat).toEqual({
      row: 0,
      col: 0,
    });
    expect(h.state().students.slice(1, 5)).toEqual(before.students.slice(1, 5));
    expect(h.state().events.at(-1)).toMatchObject({
      action: "move_seat",
      actor: testActor.actor,
      reason: "座席を入れ替え",
    });
    expect(h.state().events.at(-1)?.before).toBeTruthy();
    expect(h.state().events.at(-1)?.after).toBeTruthy();
    expect(h.cell(2, 3).textContent).toContain("青木");
  });
  it("PF-F040 places unassigned S07 in an occupied seat and moves its former occupant to unassigned", async () => {
    const h = await mount("R6_PLUS_UNPLACED");
    await dom.click(dom.container.querySelector(".seat-person-chip")!);
    await dom.click(h.cell(1, 1));
    expect(h.state().students.find((s) => s.id === "S07")?.seat).toEqual({
      row: 0,
      col: 0,
    });
    expect(h.state().students.find((s) => s.id === "S01")?.seat).toBeNull();
    expect(h.state().students).toHaveLength(7);
    expect(
      dom.container.querySelector(".seat-unplaced")?.textContent,
    ).toContain("1人");
  });
  it("PF-F041 rejects occupied aisle then permits empty aisle and prevents seating there", async () => {
    const h = await mount();
    await dom.click(dom.input("通路を編集"));
    await dom.click(h.cell(1, 1));
    expect(dom.container.textContent).toContain("生徒を移動してから");
    expect(h.cell(1, 1).className).not.toContain("seat-aisle");
    await dom.click(dom.input("通路を編集"));
    await dom.click(h.cell(1, 1));
    await dom.click(dom.button("未配置へ移す"));
    await dom.click(dom.input("通路を編集"));
    await dom.click(h.cell(1, 1));
    expect(h.cell(1, 1).className).toContain("seat-aisle");
    await dom.click(dom.input("通路を編集"));
    await dom.click(dom.container.querySelector(".seat-person-chip")!);
    await dom.click(h.cell(1, 1));
    expect(h.state().students[0].seat).toBeNull();
    await dom.click(dom.button("配置・順序を保存"));
    expect(h.state().seatLayouts?.at(-1)?.blockedCells).toEqual([
      { row: 0, col: 0 },
    ]);
  });
  it("PF-F042 shrinking layout preserves all six and shows four out of range, refusing save", async () => {
    const h = await mount(),
      history = h.state().seatLayouts?.length;
    await dom.value(dom.input("行"), "1");
    await dom.value(dom.input("列"), "2");
    expect(dom.container.querySelectorAll(".seat-board-cell")).toHaveLength(2);
    expect(dom.container.querySelectorAll(".seat-person-chip")).toHaveLength(4);
    expect(h.state().students).toHaveLength(6);
    await dom.click(dom.button("配置・順序を保存"));
    expect(h.state().seatLayouts).toHaveLength(history!);
    expect(dom.container.textContent).toMatch(/範囲|外/);
  });
  it("PF-F048 number order disables corner and includes all people even unassigned", async () => {
    await mount("R6_PLUS_UNPLACED");
    await dom.value(dom.input("配布順"), "number");
    expect(dom.input("開始位置").disabled).toBe(true);
    expect(
      dom.container.querySelector(".seat-route-summary")?.textContent,
    ).toContain("1番");
    expect(
      dom.container.querySelector(".seat-route-summary")?.textContent,
    ).toContain("7番");
    await dom.click(dom.input("逆順"));
    expect(
      dom.container.querySelector(".seat-route-summary")?.textContent,
    ).toContain("開始: 7番");
  });
  it("PF-F055 current swap does not alter issued snapshot shown by toggle", async () => {
    const h = await mount(),
      snapshot = structuredClone(h.state().collections[0]);
    await dom.click(h.cell(1, 1));
    await dom.click(h.cell(2, 3));
    expect(h.cell(1, 1).textContent).toContain("渡辺");
    await dom.click(dom.input("発行時の配置を表示"));
    expect(h.cell(1, 1).textContent).toContain("青木");
    expect(h.state().collections[0]).toEqual(snapshot);
    await dom.click(dom.input("発行時の配置を表示"));
    expect(h.cell(1, 1).textContent).toContain("渡辺");
  });
  it("PF-F056 issued view is read-only and current view becomes editable again", async () => {
    const h = await mount(),
      before = structuredClone(h.state());
    await dom.click(dom.input("発行時の配置を表示"));
    expect((h.cell(1, 1) as HTMLButtonElement).disabled).toBe(true);
    expect(dom.container.querySelector(".seat-toolbar")).toBeNull();
    await dom.click(h.cell(1, 1));
    expect(h.state()).toEqual(before);
    await dom.click(dom.input("発行時の配置を表示"));
    expect((h.cell(1, 1) as HTMLButtonElement).disabled).toBe(false);
    await dom.click(h.cell(1, 1));
    expect(dom.container.textContent).toContain("を選択中");
  });
  it("PF-F057 status classes, partial count and unresolved notice reflect only confirmed records", async () => {
    const h = await mount("STATUS6");
    for (const [r, c, cls] of [
      [1, 1, "complete"],
      [1, 2, "partial"],
      [1, 3, "uncollected"],
      [2, 1, "uncollected"],
      [2, 2, "exempt"],
      [2, 3, "superseded"],
    ] as const)
      expect(h.cell(r, c).className).toContain(`seat-status-${cls}`);
    expect(h.cell(1, 2).textContent).toContain("一部回収 1/2");
    expect(dom.container.textContent).toContain("要確認のページが 1");
    expect(h.state().receipts).toHaveLength(3);
    await dom.value(
      dom.container.querySelector(
        '[aria-label="座席表に表示する配布物"]',
      ) as HTMLSelectElement,
      h.state().collections[1].id,
    );
    expect(
      dom.container.querySelectorAll(".seat-status-uncollected"),
    ).toHaveLength(6);
    expect(dom.container.textContent).not.toContain("要確認のページが 1");
  });
  it("PF-F058 route arrow skips empty aisle and unassigned recipients", async () => {
    const h = await mount();
    await dom.click(h.cell(1, 3));
    await dom.click(dom.button("未配置へ移す"));
    await dom.click(dom.input("通路を編集"));
    await dom.click(h.cell(1, 3));
    expect(
      dom.container.querySelectorAll(".seat-route-lines line"),
    ).toHaveLength(4);
    for (const line of dom.container.querySelectorAll("line"))
      expect([line.getAttribute("x2"), line.getAttribute("y2")]).not.toEqual([
        "250",
        "50",
      ]);
    expect(
      dom.container.querySelector(".seat-person-chip")?.textContent,
    ).toContain("3番");
    expect(
      dom.container.querySelector(".seat-route-summary")?.textContent,
    ).toContain("終了: 3番");
  });
  it("PF-F059 out-of-range recipients remain visible and can be moved to an empty cell", async () => {
    const h = await mount("OFFGRID");
    expect(dom.container.querySelectorAll(".seat-person-chip")).toHaveLength(2);
    await dom.click(
      [...dom.container.querySelectorAll(".seat-person-chip")].find((e) =>
        e.textContent?.includes("2番"),
      )!,
    );
    await dom.click(h.cell(1, 2));
    expect(h.state().students.find((s) => s.id === "S02")?.seat).toEqual({
      row: 0,
      col: 1,
    });
    expect(dom.container.querySelectorAll(".seat-person-chip")).toHaveLength(1);
    expect(
      dom.container.querySelector(".seat-person-chip")?.textContent,
    ).toContain("1番");
  });
  it("PF-F060 saving corner, snake and reverse updates defaults and immutable history", async () => {
    const h = await mount(),
      old = structuredClone(h.state().seatLayouts);
    await dom.value(dom.input("配布順"), "snake");
    await dom.value(dom.input("開始位置"), "bottom-right");
    await dom.click(dom.input("逆順"));
    await dom.click(dom.button("配置・順序を保存"));
    expect(h.state().settings).toMatchObject({
      defaultOrder: "snake",
      defaultStartCorner: "bottom-right",
      defaultReverse: true,
    });
    expect(h.state().seatLayouts?.slice(0, -1)).toEqual(old);
    expect(h.state().seatLayouts?.at(-1)).toMatchObject({
      order: "snake",
      startCorner: "bottom-right",
      reverse: true,
    });
  });
});

it("PF-F035 one student 1x1 saves all four routes without duplicate or off-grid cells", async () => {
  const state = baseState(r6().slice(0, 1));
  state.seatLayouts = [];
  const h = await mount("CUSTOM", state);
  await dom.value(dom.input("行"), "1");
  await dom.value(dom.input("列"), "1");
  for (const order of ["row", "column", "snake", "number"]) {
    await dom.value(dom.input("配布順"), order);
    await dom.click(dom.button("配置・順序を保存"));
    expect(h.state().seatLayouts?.at(-1)).toMatchObject({
      rows: 1,
      cols: 1,
      order,
    });
    expect(dom.container.querySelectorAll(".seat-board-cell")).toHaveLength(1);
    expect(
      dom.container.querySelectorAll(".seat-route-lines line"),
    ).toHaveLength(0);
    expect(h.cell(1, 1).textContent).toContain("1番");
  }
});
it("PF-F036 UI inputs clamp raw 0/101 to supported1/100 while domain rejects raw out-of-range values", async () => {
  const h = await mount("CUSTOM", baseState(r6().slice(0, 1)));
  for (const label of ["行", "列"]) {
    const input = dom.input(label) as HTMLInputElement;
    expect(input.min).toBe("1");
    expect(input.max).toBe("100");
    for (const value of ["0", "1", "99", "100", "101"]) {
      await dom.value(input, value);
      const bounded = Math.min(100, Math.max(1, Number(value)));
      expect(input.value).toBe(String(bounded));
      await dom.click(dom.button("配置・順序を保存"));
      expect(
        h.state().seatLayouts?.at(-1)?.[label === "行" ? "rows" : "cols"],
      ).toBe(bounded);
    }
    await dom.value(input, "1");
  }
});
