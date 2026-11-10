import { describe, expect, it } from "vitest";
import { createInitialState } from "./seed";
import { createCollection } from "./logic";
import { csvIdentityCandidate, NEW_STUDENT } from "./rosterCsv";
import {
  applyReviewedRoster,
  normalizeRosterValues,
  rosterReviewKey,
  rosterRowsFromSheet,
  suggestRosterColumns,
} from "./rosterSheet";

const headers = ["氏名", "出席番号", "生徒ID", "行", "列"];
const columns = suggestRosterColumns(headers);
const context = { actor: "teacher", reason: "全行を確認" };

describe("reviewed Sheets roster import (authored, execution tracked separately)", () => {
  it("uses explicit columns and preserves original row numbers across blank rows", () => {
    const values = [
      ["タイトル"],
      headers,
      ["同姓同名", "001", "001234567890123456", "2", "3"],
      [],
      ["同姓同名", "2"],
    ];
    const rows = rosterRowsFromSheet(values, 2, columns);
    expect(rows.map((row) => row.row)).toEqual([3, 5]);
    expect(rows[0]).toMatchObject({
      number: 1,
      externalId: "001234567890123456",
      seat: { row: 1, col: 2 },
    });
    expect(
      csvIdentityCandidate(rows[1], [
        { id: "another", name: "同姓同名", number: 2, seat: null },
      ]),
    ).toBeUndefined();
  });
  it("does not choose an ambiguous header or allow two fields to use one column", () => {
    expect(suggestRosterColumns(["氏名", "名前", "番号"]).name).toBe(-1);
    expect(() =>
      rosterRowsFromSheet([headers, ["A", "1"]], 1, {
        ...columns,
        number: columns.name,
      }),
    ).toThrow(/同じ列/);
    expect(() =>
      rosterRowsFromSheet([headers, ["A", "1"]], 1, { ...columns, col: -1 }),
    ).toThrow(/両方/);
  });
  it("rejects partial rows, duplicate IDs/numbers, unsafe integers and invalid seats", () => {
    expect(() => rosterRowsFromSheet([headers, ["A"]], 1, columns)).toThrow(
      /出席番号/,
    );
    expect(() =>
      rosterRowsFromSheet(
        [headers, ["A", "1", "same"], ["B", "2", "same"]],
        1,
        columns,
      ),
    ).toThrow(/生徒ID.*重複/);
    expect(() =>
      rosterRowsFromSheet([headers, ["A", "1"], ["B", "1"]], 1, columns),
    ).toThrow(/出席番号.*重複/);
    expect(() =>
      rosterRowsFromSheet([headers, ["A", "9007199254740992"]], 1, columns),
    ).toThrow(/整数/);
    expect(() =>
      rosterRowsFromSheet([headers, ["A", "1", "", "1", "101"]], 1, columns),
    ).toThrow(/座席/);
  });
  it("rejects malformed or oversized cells instead of accepting a truncated roster", () => {
    expect(() => normalizeRosterValues([[{ value: "A" }]])).toThrow(/形式/);
    expect(() => normalizeRosterValues([["A".repeat(1001)]])).toThrow(/文字数/);
    expect(() =>
      normalizeRosterValues(Array.from({ length: 2001 }, () => [])),
    ).toThrow(/2000/);
    expect(() => normalizeRosterValues([Array(53).fill("")])).toThrow(/52/);
  });
  it("retains existing identities and issued snapshots, and records a Sheets-specific audit event", () => {
    const state = createInitialState();
    const collection = createCollection(
      {
        title: "配布物",
        className: state.className,
        dueDate: "2026-11-10",
        pageCount: 1,
        requiredPages: [1],
        qrCorner: "top-right",
        duplex: false,
        order: "number",
        reverse: false,
        sourceName: "原稿",
      },
      state.students,
    );
    state.collections = [collection];
    const rows = rosterRowsFromSheet(
      [headers, ["改姓後", "1", state.students[0].id]],
      1,
      columns,
    );
    const next = applyReviewedRoster(
      state,
      rows,
      { 2: state.students[0].id },
      context,
      "sheets",
      rosterReviewKey(state),
    );
    expect(next.students[0].id).toBe(state.students[0].id);
    expect(next.students[0].seat).toEqual(state.students[0].seat);
    expect(next.students[0].name).toBe("改姓後");
    expect(next.students).toHaveLength(40);
    expect(next.collections).toEqual(state.collections);
    expect(next.events.at(-1)?.action).toBe("import_roster_sheets");
  });
  it("stops an outdated preview and collisions with the retained roster", () => {
    const state = createInitialState();
    const key = rosterReviewKey(state);
    const rows = rosterRowsFromSheet([headers, ["追加", "1"]], 1, columns);
    expect(() =>
      applyReviewedRoster(
        state,
        rows,
        { 2: NEW_STUDENT },
        context,
        "sheets",
        key,
      ),
    ).toThrow(/重複/);
    expect(() =>
      applyReviewedRoster(
        { ...state, classId: "different" },
        rows,
        { 2: state.students[0].id },
        context,
        "sheets",
        key,
      ),
    ).toThrow(/変わりました/);
    expect(() =>
      applyReviewedRoster(state, rows, {}, context, "sheets", key),
    ).toThrow(/対応付け/);
  });
  it("rejects seats in aisles while keeping every existing student and old history intact", () => {
    const state = createInitialState();
    state.seatLayouts = [
      {
        id: "layout",
        name: "配置",
        createdAt: "2026-11-10T00:00:00Z",
        rows: 9,
        cols: 5,
        blockedCells: [{ row: 8, col: 0 }],
        students: state.students,
        order: "snake",
        reverse: false,
      },
    ];
    state.settings = { activeSeatLayoutId: "layout" };
    const rows = rosterRowsFromSheet(
      [headers, ["追加", "41", "", "9", "1"]],
      1,
      columns,
    );
    expect(() =>
      applyReviewedRoster(
        state,
        rows,
        { 2: NEW_STUDENT },
        context,
        "sheets",
        rosterReviewKey(state),
      ),
    ).toThrow(/通路/);
    expect(state.students).toHaveLength(40);
  });
});
