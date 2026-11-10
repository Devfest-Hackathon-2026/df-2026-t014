// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { normalizeRosterValues } from "./domain/rosterSheet";
import { RosterImportPanel } from "./RosterImportPanel";
import { testDom } from "./testDom";
import { baseState, r6, testActor } from "./domain/functional-fixtures";
import type { GoogleWorkspaceClient } from "./google/client";
import type { AppState } from "./domain/types";
let dom: ReturnType<typeof testDom>;
afterEach(async () => {
  await dom?.close();
  vi.restoreAllMocks();
});
async function setup(values: string[][]) {
  dom = testDom();
  const state = baseState(r6());
  state.settings = { ...state.settings, googleAccountId: "teacher" };
  const before = structuredClone(state);
  const onChange = vi.fn();
  const client = {
    isConnected: () => true,
    getIdentity: () => ({ id: "teacher", email: testActor.actor }),
    pickFiles: vi.fn(async () => [
      {
        id: "book",
        name: "架空Sheets",
        mimeType: "application/vnd.google-apps.spreadsheet",
      },
    ]),
    readRosterSpreadsheet: vi.fn(async () => ({
      id: "book",
      title: "架空Sheets",
      sheets: [{ sheetId: 1, title: "名簿", rowCount: 20, columnCount: 6 }],
    })),
    readRosterSheet: vi.fn(async () => ({
      title: "架空Sheets",
      sheetTitle: "名簿",
      values: normalizeRosterValues(values),
    })),
  };
  await dom.render(
    <RosterImportPanel
      state={state}
      client={client as unknown as GoogleWorkspaceClient}
      sample={false}
      busy={false}
      actor={testActor.actor}
      onChange={onChange}
    />,
  );
  await dom.click(dom.button("名簿のSheetsを選ぶ"));
  await dom.click(dom.button("選んだシートを読み込む"));
  const preview = async () => {
    const b = [...dom.container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("この列で対応先を確認"),
    );
    if (b) await dom.click(b);
  };
  const mapping = (row: number) =>
    dom.container.querySelector(
      `[aria-label="${row}行目の対応先"]`,
    ) as HTMLSelectElement;
  const apply = async () => {
    await dom.click(dom.input("人数・氏名・番号・座席と"));
    await dom.click(dom.button("確認した名簿を反映"));
  };
  return { state, before, onChange, preview, mapping, apply };
}
it("PF-F023 exact arbitrary Sheets columns and explicit unknown identity preserve internal IDs and chosen seats", async () => {
  const h = await setup([
    ["備考", "氏名", "Classroom ID", "出席番号", "列", "行"],
    ["S06", "青木更新", "google-1", "11", "1", "1"],
    ["S05", "佐藤 蓮", "unrecognized", "12", "3", "1"],
  ]);
  for (const [label, value] of [
    ["氏名", "1"],
    ["出席番号", "3"],
    ["生徒ID（任意）", "2"],
    ["座席の行", "5"],
    ["座席の列", "4"],
  ])
    await dom.value(dom.input(label), value);
  await h.preview();
  expect(h.mapping(2).value).toBe("S01");
  expect(h.mapping(3).value).toBe("");
  await h.apply();
  expect(h.onChange).not.toHaveBeenCalled();
  expect(h.state).toEqual(h.before);
  await dom.value(h.mapping(3), "S03");
  await h.apply();
  expect(h.onChange).toHaveBeenCalledTimes(1);
  const next = h.onChange.mock.calls[0][0] as AppState;
  expect(next.students.find((s) => s.id === "S01")).toMatchObject({
    number: 11,
    name: "青木更新",
    seat: { row: 0, col: 0 },
  });
  expect(next.students.find((s) => s.id === "S03")).toMatchObject({
    number: 12,
    name: "佐藤 蓮",
    seat: { row: 0, col: 2 },
  });
  expect(next.students.find((s) => s.id === "S05")).toEqual(
    h.before.students[4],
  );
});
it("PF-F024 blank and duplicate Sheets numbers leave roster unchanged; corrected same-name rows require separate S03/S04 selections", async () => {
  for (const numbers of [
    ["", "4"],
    ["3", "3"],
    ["3", "4"],
  ]) {
    const h = await setup([
      ["出席番号", "氏名"],
      [numbers[0], "佐藤 蓮"],
      [numbers[1], "佐藤 蓮"],
    ]);
    await h.preview();
    if (numbers[0] === "" || numbers[0] === numbers[1]) {
      expect(h.mapping(2)).toBeNull();
      expect(h.onChange).not.toHaveBeenCalled();
      expect(h.state).toEqual(h.before);
    } else {
      expect(h.mapping(2).value).toBe("");
      expect(h.mapping(3).value).toBe("");
      await h.apply();
      expect(h.onChange).not.toHaveBeenCalled();
      await dom.value(h.mapping(2), "S03");
      await dom.value(h.mapping(3), "S04");
      await h.apply();
      const next = h.onChange.mock.calls[0][0] as AppState;
      expect(
        next.students
          .filter((s) => ["S03", "S04"].includes(s.id))
          .map((s) => [s.id, s.number, s.name]),
      ).toEqual([
        ["S03", 3, "佐藤 蓮"],
        ["S04", 4, "佐藤 蓮"],
      ]);
    }
    await dom.close();
  }
});
it("PF-F030 exact 999/1000/1001-character Sheets values are not truncated and controls remain in accessible DOM", async () => {
  for (const count of [999, 1000, 1001]) {
    const name = "名".repeat(count);
    const h = await setup([
      ["出席番号", "氏名", "生徒ID"],
      ["1", name, "S01"],
    ]);
    await h.preview();
    if (count <= 1000) {
      expect(dom.container.textContent).toContain(name);
      expect(h.mapping(2).value).toBe("S01");
      expect(dom.button("確認した名簿を反映")).toBeTruthy();
      await h.apply();
      expect((h.onChange.mock.calls[0][0] as AppState).students[0].name).toBe(
        name,
      );
    } else {
      expect(h.mapping(2)).toBeNull();
      expect(h.onChange).not.toHaveBeenCalled();
      expect(dom.container.textContent).toContain("文字数");
    }
    await dom.close();
  }
});
