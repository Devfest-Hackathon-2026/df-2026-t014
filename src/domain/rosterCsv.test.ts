import { describe, expect, it } from "vitest";
import {
  applyRosterCsv,
  csvIdentityCandidate,
  NEW_STUDENT,
  parseRosterCsv,
} from "./rosterCsv";
import { createInitialState } from "./seed";

describe("reviewed roster CSV import", () => {
  it("parses escaped CSV and one-based seat coordinates without using names as identities", () => {
    const rows = parseRosterCsv(
      '\uFEFF出席番号,氏名,生徒ID,行,列\r\n1,"同姓,同名",known,2,3\r\n2,"引用""名前",,,\r\n',
    );
    expect(rows[0]).toMatchObject({
      name: "同姓,同名",
      externalId: "known",
      seat: { row: 1, col: 2 },
    });
    expect(rows[1].name).toBe('引用"名前');
    expect(
      csvIdentityCandidate(rows[1], [
        { id: "x", name: rows[1].name, number: 2, seat: null },
      ]),
    ).toBeUndefined();
    expect(
      csvIdentityCandidate(rows[0], [
        { id: "known", name: "旧氏名", number: 1, seat: null },
      ]),
    ).toBe("known");
  });
  it("requires explicit mappings and keeps unmentioned students and issued history", () => {
    const state = createInitialState();
    const rows = parseRosterCsv("出席番号,氏名\n41,追加の人");
    const context = { actor: "teacher", reason: "CSV対応を確認" };
    expect(() => applyRosterCsv(state, rows, {}, context)).toThrow(/対応付け/);
    const result = applyRosterCsv(state, rows, { 2: NEW_STUDENT }, context);
    expect(result.students).toHaveLength(41);
    expect(result.students[40].seat).toBeNull();
    expect(state.students).toHaveLength(40);
    expect(result.events.at(-1)?.actor).toBe("teacher");
  });
  it("rejects duplicate numbers, unfinished quotes and partial seat coordinates", () => {
    expect(() => parseRosterCsv("出席番号,氏名\n1,A\n1,B")).toThrow(/重複/);
    expect(() => parseRosterCsv('出席番号,氏名\n1,"A')).toThrow(/閉じて/);
    expect(() => parseRosterCsv("出席番号,氏名,行,列\n1,A,2,")).toThrow(/座席/);
  });
});
