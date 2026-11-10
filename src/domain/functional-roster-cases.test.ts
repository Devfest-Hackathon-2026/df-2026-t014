import { describe, expect, it } from "vitest";
import {
  baseState,
  issued,
  qrPage,
  r6,
  record,
  testActor,
  uiFixtures,
} from "./functional-fixtures";
import { getStudentStatus } from "./logic";
import { syncClassRoster, switchClassWorkspace } from "./workspaces";
import {
  applyRosterCsv,
  csvIdentityCandidate,
  NEW_STUDENT,
  parseRosterCsv,
} from "./rosterCsv";
import {
  applyReviewedRoster,
  normalizeRosterValues,
  rosterReviewKey,
  rosterRowsFromSheet,
  suggestRosterColumns,
  type RosterColumns,
} from "./rosterSheet";
const columns: RosterColumns = {
  number: 0,
  name: 1,
  externalId: -1,
  row: -1,
  col: -1,
};
const from = (v: string[][], c = columns, h = 1) =>
  rosterRowsFromSheet(normalizeRosterValues(v), h, c);
const map = (rows: { row: number }[]) =>
  Object.fromEntries(rows.map((r) => [r.row, NEW_STUDENT]));
describe("Excel functional roster production domain", () => {
  it("PF-F001 empty roster cannot issue", () => {
    expect(() => issued({}, [])).toThrow();
  });
  it("PF-F002 duplicate display names do not combine student receipts", () => {
    const f = issued({ pageCount: 1, requiredPages: [1] });
    const next = record(f.state, f.collection, [
      qrPage(f.collection, "S03", 1, 1),
    ]);
    expect(getStudentStatus(f.collection, "S03", next.receipts).status).toBe(
      "complete",
    );
    expect(
      getStudentStatus(f.collection, "S03", next.receipts).receivedCount,
    ).toBe(1);
    expect(
      getStudentStatus(f.collection, "S04", next.receipts).receivedCount,
    ).toBe(0);
    expect(
      f.collection.tokens.filter((t) => ["S03", "S04"].includes(t.studentId)),
    ).toHaveLength(2);
  });
  it("PF-F003 same class names retain independent settings, seats and receipts by class ID", () => {
    const a = uiFixtures().STATUS6;
    a.settings = { ...a.settings, schoolYear: "2026" };
    let b = switchClassWorkspace(a, {
      id: "class-b",
      className: a.className,
      students: [{ ...r6()[0], id: "B1", seat: null }],
    });
    expect(b.receipts).toHaveLength(0);
    expect(b.students).toHaveLength(1);
    b.settings = { ...b.settings, schoolYear: "2025" };
    const restored = switchClassWorkspace(b, {
      id: a.classId!,
      className: a.className,
    });
    expect(restored.students).toEqual(a.students);
    expect(restored.receipts).toEqual(a.receipts);
    expect(restored.settings).toEqual(a.settings);
    expect(
      restored.savedClasses?.find((c) => c.id === "class-b")?.settings
        ?.schoolYear,
    ).toBe("2025");
  });
  it("PF-F004 shuffled refresh and renamed profile preserve internal IDs, numbers, seats and issued snapshot", () => {
    const f = issued();
    const s = record(f.state, f.collection, [
      qrPage(f.collection, "S01", 1, 1),
    ]);
    const before = structuredClone(s);
    const incoming = [...r6()]
      .reverse()
      .map((x, i) => ({
        ...x,
        id: "fresh-" + i,
        number: i + 1,
        seat: null,
        name: x.id === "S01" ? "改名 済" : x.name,
      }));
    const n = syncClassRoster(s, incoming, testActor);
    for (const old of before.students) {
      const x = n.students.find((v) => v.id === old.id)!;
      expect(x).toMatchObject({
        number: old.number,
        seat: old.seat,
        classroomUserId: old.classroomUserId,
      });
    }
    expect(n.students.find((x) => x.id === "S01")?.name).toBe("改名 済");
    expect(n.collections).toEqual(before.collections);
    expect(n.receipts).toEqual(before.receipts);
  });
  it("PF-F005 withdrawal keeps issued tokens and prior receipts", () => {
    const f = issued(),
      s = record(f.state, f.collection, [qrPage(f.collection, "S06", 1, 1)]);
    const n = syncClassRoster(s, r6().slice(0, 5), testActor);
    expect(n.students.find((x) => x.id === "S06")).toMatchObject({
      enrollment: "withdrawn",
      seat: null,
    });
    expect(n.collections).toEqual(s.collections);
    expect(n.receipts).toEqual(s.receipts);
  });
  it("PF-F006 return restores existing internal identity without duplicate", () => {
    let s = syncClassRoster(baseState(), r6().slice(0, 5), testActor);
    s = syncClassRoster(
      s,
      r6().map((x) => ({ ...x, id: "fresh-" + x.id })),
      testActor,
    );
    expect(s.students).toHaveLength(6);
    expect(s.students.find((x) => x.id === "S06")).toMatchObject({
      enrollment: "active",
      number: 6,
    });
  });
  it("PF-F007 legacy classroom-prefixed internal ID migrates without replacing identity", () => {
    const s = baseState([
      { ...r6()[0], id: "classroom:12345", classroomUserId: undefined },
    ]);
    const n = syncClassRoster(
      s,
      [{ ...r6()[0], id: "fresh", classroomUserId: "12345" }],
      testActor,
    );
    expect(n.students).toHaveLength(1);
    expect(n.students[0]).toMatchObject({
      id: "classroom:12345",
      classroomUserId: "12345",
      number: 1,
      seat: { row: 0, col: 0 },
    });
  });
  it("PF-F008 new roster member gets next number and no seat without changing issued recipients", () => {
    const f = issued(),
      n = syncClassRoster(
        f.state,
        [...r6(), { id: "S07", name: "転入", number: 7, seat: null }],
        testActor,
      );
    expect(n.students.find((x) => x.id === "S07")).toMatchObject({
      number: 7,
      seat: null,
      enrollment: "active",
    });
    expect(n.collections[0].recipients).toHaveLength(6);
  });
  it("PF-F009 BOM CRLF LF and header aliases produce equivalent rows and zero-based seats", () => {
    for (const header of [
      "出席番号,氏名,行,列",
      "number,name,row,col",
      "番号,名前,seatrow,seatcolumn",
    ])
      for (const nl of ["\n", "\r\n"]) {
        expect(
          parseRosterCsv("\uFEFF" + header + nl + "1,架空,1,1" + nl),
        ).toEqual([
          { row: 2, name: "架空", number: 1, seat: { row: 0, col: 0 } },
        ]);
      }
  });
  it("PF-F010 quoted comma, escaped quote and embedded newline stay in one CSV cell", () => {
    const rows = parseRosterCsv(
      '番号,氏名\n1,"名,前"\n2,"二""重"\n3,"複数\n行"',
    );
    expect(rows.map((x) => x.name)).toEqual(["名,前", '二"重', "複数\n行"]);
    expect(rows).toHaveLength(3);
  });
  it("PF-F011 unterminated quotation rejects whole import with unchanged state", () => {
    const s = baseState(),
      before = structuredClone(s);
    expect(() => parseRosterCsv('番号,氏名\n1,"未完')).toThrow(/引用符/);
    expect(s).toEqual(before);
  });
  it("PF-F012 empty blank and header-only inputs reject without clearing roster", () => {
    const s = baseState(),
      before = structuredClone(s);
    for (const csv of ["", "\n\r\n  ", "番号,氏名\n"])
      expect(() => parseRosterCsv(csv)).toThrow();
    expect(s).toEqual(before);
  });
  it("PF-F013 missing name or number header never guesses the columns", () => {
    for (const h of ["氏名,別列", "別列,番号", "a,b"])
      expect(() => parseRosterCsv(h + "\n1,人")).toThrow(/見出し/);
  });
  it("PF-F014 zero negative fraction and fullwidth attendance numbers reject", () => {
    for (const n of ["0", "-1", "1.5", "１"])
      expect(() => parseRosterCsv("番号,氏名\n" + n + ",架空")).toThrow();
  });
  it("PF-F015 safe integer limits accepted and unsafe integer rejected atomically", () => {
    for (const n of [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER]) {
      const rows = parseRosterCsv(`番号,氏名\n${n},架空`);
      expect(
        applyRosterCsv(baseState([]), rows, map(rows), testActor).students[0]
          .number,
      ).toBe(n);
    }
    const s = baseState([]),
      before = structuredClone(s),
      rows = parseRosterCsv(`番号,氏名\n9007199254740992,架空`);
    expect(() => applyRosterCsv(s, rows, map(rows), testActor)).toThrow();
    expect(s).toEqual(before);
  });
  it("PF-F016 duplicate CSV attendance numbers reject for same and different names", () => {
    for (const n of ["同名", "別名"])
      expect(() => parseRosterCsv("番号,氏名\n1,同名\n1," + n)).toThrow(/重複/);
  });
  it("PF-F017 seat pair requires positive complete coordinates and blank pair gives no seat", () => {
    for (const pair of ["1,", ",1", "0,1", "1,0"])
      expect(() => parseRosterCsv("番号,氏名,行,列\n1,架空," + pair)).toThrow();
    expect(parseRosterCsv("番号,氏名,行,列\n1,架空,1,1")[0].seat).toEqual({
      row: 0,
      col: 0,
    });
    expect(
      applyRosterCsv(
        baseState([]),
        parseRosterCsv("番号,氏名,行,列\n1,架空,,"),
        { 2: NEW_STUDENT },
        testActor,
      ).students[0].seat,
    ).toBeNull();
  });
  it("PF-F018 every row requires explicit ID selection and duplicate names never auto-match", () => {
    const s = baseState(),
      rows = parseRosterCsv("番号,氏名\n3,佐藤 蓮\n4,佐藤 蓮");
    expect(() => applyRosterCsv(s, rows, {}, testActor)).toThrow(/対応付け/);
    expect(() => applyRosterCsv(s, rows, { 2: "S03" }, testActor)).toThrow(
      /対応付け/,
    );
    const n = applyRosterCsv(s, rows, { 2: "S03", 3: "S04" }, testActor);
    expect(n.students).toHaveLength(6);
    expect(n.students.find((x) => x.id === "S03")?.number).toBe(3);
    expect(n.students.find((x) => x.id === "S04")?.number).toBe(4);
  });
  it("PF-F019 duplicate mapping to one existing ID rejects atomically", () => {
    const s = baseState(),
      before = structuredClone(s),
      rows = parseRosterCsv("番号,氏名\n3,佐藤 蓮\n4,佐藤 蓮");
    expect(() =>
      applyRosterCsv(s, rows, { 2: "S03", 3: "S03" }, testActor),
    ).toThrow();
    expect(s).toEqual(before);
  });
  it("PF-F020 importing collision with an unmentioned existing number or seat rejects", () => {
    const s = baseState(),
      before = structuredClone(s);
    for (const csv of ["番号,氏名\n6,新規", "番号,氏名,行,列\n7,新規,2,3"]) {
      const rows = parseRosterCsv(csv);
      expect(() => applyRosterCsv(s, rows, map(rows), testActor)).toThrow(
        /重複|同じ座席/,
      );
    }
    expect(s).toEqual(before);
  });
  it("PF-F021 external ID suggests existing identity but never applies without explicit mapping", () => {
    const s = baseState(),
      rows = parseRosterCsv("番号,氏名,id\n1,変更名,google-1");
    expect(csvIdentityCandidate(rows[0], s.students)).toBe("S01");
    expect(() => applyRosterCsv(s, rows, {}, testActor)).toThrow();
    const n = applyRosterCsv(s, rows, { 2: "S01" }, testActor);
    expect(n.students[0]).toMatchObject({
      id: "S01",
      name: "変更名",
      classroomUserId: "google-1",
    });
    expect(
      csvIdentityCandidate({ ...rows[0], externalId: undefined }, s.students),
    ).toBeUndefined();
  });
  it("PF-F023 arbitrary sheet columns require explicit mapping and map accurate fields", () => {
    const v = [
        ["備考", "氏名", "ID", "列", "番号", "行"],
        ["note", "架空", "g1", "3", "9", "2"],
      ],
      c = { number: 4, name: 1, externalId: 2, row: 5, col: 3 };
    expect(from(v, c)).toEqual([
      {
        row: 2,
        name: "架空",
        number: 9,
        externalId: "g1",
        seat: { row: 1, col: 2 },
      },
    ]);
    expect(() => from(v, { ...columns, number: -1 })).toThrow();
  });
  it("PF-F024 sheet same names remain distinct and blank or duplicate numbers reject", () => {
    const rows = from([
      ["番号", "氏名"],
      ["3", "佐藤 蓮"],
      ["4", "佐藤 蓮"],
    ]);
    const n = applyReviewedRoster(
      baseState(),
      rows,
      { 2: "S03", 3: "S04" },
      testActor,
      "sheets",
      rosterReviewKey(baseState()),
    );
    expect(n.students.filter((x) => x.name === "佐藤 蓮")).toHaveLength(2);
    for (const n of ["", "3"])
      expect(() =>
        from([
          ["番号", "氏名"],
          ["3", "佐藤 蓮"],
          [n, "佐藤 蓮"],
        ]),
      ).toThrow();
  });
  it("PF-F025 duplicate header ambiguity returns unselected and duplicate column assignment rejects", () => {
    expect(suggestRosterColumns(["番号", "氏名", "name"]).name).toBe(-1);
    expect(() =>
      from(
        [
          ["番号", "氏名"],
          ["1", "架空"],
        ],
        { ...columns, name: 0 },
      ),
    ).toThrow(/同じ列/);
  });
  it("PF-F026 physical sheet row numbers survive title rows and empty rows; partial row reports row6", () => {
    const v = [
      ["タイトル"],
      [],
      ["番号", "氏名"],
      ["1", "一"],
      [],
      ["2", "二"],
      ["3", "三"],
    ];
    expect(from(v, columns, 3).map((r) => r.row)).toEqual([4, 6, 7]);
    v[5] = ["", "二"];
    expect(() => from(v, columns, 3)).toThrow(/6行目/);
  });
  it("PF-F027 people count 0 and1001 reject while1 and1000 succeed", () => {
    for (const count of [0, 1, 1000, 1001]) {
      const v = [
        ["番号", "氏名"],
        ...Array.from({ length: count }, (_, i) => [String(i + 1), "架空"]),
      ];
      if (count === 1 || count === 1000) expect(from(v)).toHaveLength(count);
      else expect(() => from(v)).toThrow();
    }
  });
  it("PF-F028 physical rows1999/2000 accepted and2001 rejected including blank rows", () => {
    for (const count of [1999, 2000, 2001]) {
      const v = Array.from({ length: count }, () => [] as string[]);
      v[0] = ["番号", "氏名"];
      v[1] = ["1", "架空"];
      if (count <= 2000) expect(from(v)).toHaveLength(1);
      else expect(() => from(v)).toThrow(/2000/);
    }
  });
  it("PF-F029 columns51/52 accepted and53 rejected including unused trailing cells", () => {
    for (const n of [51, 52, 53]) {
      const v = [Array(n).fill(""), ["1", "架空"]];
      if (n <= 52) expect(from(v)).toHaveLength(1);
      else expect(() => from(v)).toThrow(/52/);
    }
  });
  it("PF-F030 cell characters999/1000 accepted and1001 rejected", () => {
    for (const n of [999, 1000, 1001]) {
      const v = [
        ["番号", "氏名"],
        ["1", "あ".repeat(n)],
      ];
      if (n <= 1000) expect(from(v)[0].name).toHaveLength(n);
      else expect(() => from(v)).toThrow(/文字数/);
    }
  });
  it("PF-F031 totalcharacters999999/1000000 accepted and1000001 rejected while cells and rows under caps", () => {
    for (const n of [999999, 1000000, 1000001]) {
      const v = Array.from({ length: 1000 }, (_, i) => [
        "x".repeat(Math.min(1000, Math.max(0, n - i * 1000))),
      ]);
      if (n > 1e6) v.push(["x"]);
      if (n <= 1e6)
        expect(normalizeRosterValues(v).flat().join("")).toHaveLength(n);
      else expect(() => normalizeRosterValues(v)).toThrow(/文字数/);
    }
  });
  it("PF-F032 sheet seat columns must be paired with coordinates1..100; unselected pair yields null", () => {
    const c = { ...columns, row: 2, col: 3 };
    for (const n of ["0", "101"])
      expect(() =>
        from(
          [
            ["番号", "氏名", "行", "列"],
            ["1", "架空", n, "1"],
          ],
          c,
        ),
      ).toThrow();
    expect(
      from(
        [
          ["番号", "氏名", "行", "列"],
          ["1", "架空", "100", "100"],
        ],
        c,
      )[0].seat,
    ).toEqual({ row: 99, col: 99 });
    expect(() =>
      from(
        [
          ["番号", "氏名", "行", "列"],
          ["1", "架空", "1", "1"],
        ],
        { ...c, col: -1 },
      ),
    ).toThrow(/両方/);
    expect(
      from([
        ["番号", "氏名", "行", "列"],
        ["1", "架空", "1", "1"],
      ])[0].seat,
    ).toBeUndefined();
  });
  it("PF-F033 class roster and saved layout changes invalidate reviewed import without mutation", () => {
    const s = uiFixtures().R6,
      rows = from([
        ["番号", "氏名"],
        ["1", "改名"],
      ]),
      key = rosterReviewKey(s);
    for (const mutate of [
      (n: typeof s) => {
        n.classId = "another";
      },
      (n: typeof s) => {
        n.students[0].name = "changed";
      },
      (n: typeof s) => {
        n.students[0].seat = null;
      },
      (n: typeof s) => {
        n.settings!.activeSeatLayoutId = "other";
      },
      (n: typeof s) => {
        n.seatLayouts![0].blockedCells = [{ row: 2, col: 0 }];
      },
    ]) {
      const n = structuredClone(s);
      mutate(n);
      const before = structuredClone(n);
      expect(() =>
        applyReviewedRoster(n, rows, { 2: "S01" }, testActor, "sheets", key),
      ).toThrow(/変わりました/);
      expect(n).toEqual(before);
    }
  });
});
