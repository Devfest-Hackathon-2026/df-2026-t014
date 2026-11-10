import type { AppState, ChangeContext } from "./types";
import { applyRosterCsv, type RosterCsvRow } from "./rosterCsv";

export const MAX_ROSTER_GRID_ROWS = 2000;
export const MAX_ROSTER_GRID_COLUMNS = 52;
export const MAX_ROSTER_PEOPLE = 1000;
export type RosterColumn = "number" | "name" | "externalId" | "row" | "col";
export type RosterColumns = Record<RosterColumn, number>;
export const ROSTER_COLUMN_LABELS: Record<RosterColumn, string> = {
  number: "出席番号",
  name: "氏名",
  externalId: "生徒ID（任意）",
  row: "座席の行（任意）",
  col: "座席の列（任意）",
};
const aliases: Record<RosterColumn, string[]> = {
  number: ["出席番号", "番号", "number"],
  name: ["氏名", "名前", "name"],
  externalId: ["生徒id", "classroom id", "classroomuserid", "id"],
  row: ["行", "seatrow", "row"],
  col: ["列", "seatcolumn", "col"],
};

/** Header labels suggest columns only. Names never identify a student. */
export function suggestRosterColumns(header: string[]): RosterColumns {
  return Object.fromEntries(
    Object.entries(aliases).map(([field, names]) => {
      const matches = header.flatMap((value, index) =>
        names.includes(value.trim().toLowerCase()) ? [index] : [],
      );
      return [field, matches.length === 1 ? matches[0] : -1];
    }),
  ) as RosterColumns;
}

export function normalizeRosterValues(value: unknown): string[][] {
  if (!Array.isArray(value) || value.length > MAX_ROSTER_GRID_ROWS)
    throw new Error(
      `名簿シートは${MAX_ROSTER_GRID_ROWS}行以内にしてください。`,
    );
  let length = 0;
  return value.map((row) => {
    if (!Array.isArray(row) || row.length > MAX_ROSTER_GRID_COLUMNS)
      throw new Error(
        `名簿シートは${MAX_ROSTER_GRID_COLUMNS}列以内にしてください。`,
      );
    return row.map((cell) => {
      if (
        typeof cell !== "string" &&
        typeof cell !== "number" &&
        typeof cell !== "boolean" &&
        cell !== null
      )
        throw new Error("名簿シートのセル形式を確認できません。");
      const text = cell === null ? "" : String(cell);
      length += text.length;
      if (text.length > 1000 || length > 1_000_000)
        throw new Error(
          "名簿のセルや全体の文字数が多すぎます。名簿専用のシートに分けてください。",
        );
      return text;
    });
  });
}

export function rosterRowsFromSheet(
  values: string[][],
  headerRow: number,
  columns: RosterColumns,
): RosterCsvRow[] {
  if (
    !Number.isSafeInteger(headerRow) ||
    headerRow < 1 ||
    headerRow >= values.length
  )
    throw new Error("見出しの行と、その下の名簿を確認してください。");
  const width = Math.max(0, ...values.map((row) => row.length));
  const chosen = Object.values(columns).filter((index) => index !== -1);
  if (
    columns.number < 0 ||
    columns.name < 0 ||
    chosen.some(
      (index) => !Number.isSafeInteger(index) || index < 0 || index >= width,
    )
  )
    throw new Error("出席番号・氏名の列を選択してください。");
  if (new Set(chosen).size !== chosen.length)
    throw new Error("同じ列を複数の項目へ割り当てることはできません。");
  if (columns.row < 0 !== columns.col < 0)
    throw new Error("座席を取り込む場合は行と列の両方を選択してください。");
  const result: RosterCsvRow[] = [];
  const integer = (
    value: string,
    label: string,
    row: number,
    max = Number.MAX_SAFE_INTEGER,
  ) => {
    const parsed = Number(value);
    if (
      !/^\d+$/.test(value) ||
      !Number.isSafeInteger(parsed) ||
      parsed < 1 ||
      parsed > max
    )
      throw new Error(
        `${row}行目の${label}は1以上${max === 100 ? "100以下" : ""}の整数にしてください。`,
      );
    return parsed;
  };
  for (let index = headerRow; index < values.length; index++) {
    const cells = values[index];
    const cell = (field: RosterColumn) =>
      columns[field] < 0 ? "" : (cells[columns[field]] ?? "").trim();
    if (!Object.keys(columns).some((field) => cell(field as RosterColumn)))
      continue;
    const row = index + 1;
    const name = cell("name");
    if (!name) throw new Error(`${row}行目の氏名を確認してください。`);
    const entry: RosterCsvRow = {
      row,
      name,
      number: integer(cell("number"), "出席番号", row),
    };
    if (cell("externalId")) entry.externalId = cell("externalId");
    const r = cell("row"),
      c = cell("col");
    if (r || c)
      entry.seat = {
        row: integer(r, "座席の行", row, 100) - 1,
        col: integer(c, "座席の列", row, 100) - 1,
      };
    result.push(entry);
  }
  validateRosterRows(result);
  return result;
}

export function validateRosterRows(rows: RosterCsvRow[]): void {
  if (!rows.length || rows.length > MAX_ROSTER_PEOPLE)
    throw new Error(`取り込む名簿は1〜${MAX_ROSTER_PEOPLE}人にしてください。`);
  const numbers = new Set<number>(),
    ids = new Set<string>(),
    sourceRows = new Set<number>();
  for (const row of rows) {
    if (
      !Number.isSafeInteger(row.row) ||
      row.row < 1 ||
      sourceRows.has(row.row) ||
      !row.name.trim() ||
      !Number.isSafeInteger(row.number) ||
      row.number < 1
    )
      throw new Error("名簿の氏名・出席番号・元の行を確認してください。");
    sourceRows.add(row.row);
    if (numbers.has(row.number))
      throw new Error("取り込む名簿の出席番号が重複しています。");
    numbers.add(row.number);
    if (row.externalId) {
      if (ids.has(row.externalId))
        throw new Error("取り込む名簿の生徒IDが重複しています。");
      ids.add(row.externalId);
    }
    if (
      row.seat &&
      [row.seat.row, row.seat.col].some(
        (n) => !Number.isSafeInteger(n) || n < 0 || n >= 100,
      )
    )
      throw new Error(
        `${row.row}行目の座席は1〜100の行・列で指定してください。`,
      );
  }
}

/** Guards a preview against a roster/class/layout change before confirmation. */
export function rosterReviewKey(state: AppState): string {
  return JSON.stringify([
    state.classId ?? state.className,
    state.settings?.googleAccountId,
    state.students,
    state.settings?.activeSeatLayoutId,
    state.seatLayouts?.find(
      (layout) => layout.id === state.settings?.activeSeatLayoutId,
    ),
  ]);
}

export function applyReviewedRoster(
  state: AppState,
  rows: RosterCsvRow[],
  mapping: Record<number, string>,
  context: ChangeContext,
  source: "csv" | "sheets",
  expectedReviewKey: string,
): AppState {
  if (rosterReviewKey(state) !== expectedReviewKey)
    throw new Error(
      "確認中にクラス・名簿・座席が変わりました。元の名簿を読み直して対応先を確認してください。",
    );
  validateRosterRows(rows);
  const next = applyRosterCsv(state, rows, mapping, context);
  const layout = state.seatLayouts?.find(
    (item) => item.id === state.settings?.activeSeatLayoutId,
  );
  if (layout)
    for (const student of next.students.filter(
      (item) => item.enrollment !== "withdrawn",
    )) {
      if (
        student.seat &&
        (student.seat.row >= layout.rows ||
          student.seat.col >= layout.cols ||
          layout.blockedCells.some(
            (cell) =>
              cell.row === student.seat!.row && cell.col === student.seat!.col,
          ))
      )
        throw new Error(
          `${student.number}番の座席が保存済み配置の外または通路です。座席配置を先に変更・保存してから取り込んでください。`,
        );
    }
  if (source === "sheets")
    next.events = next.events.map((event, index) =>
      index === next.events.length - 1
        ? { ...event, action: "import_roster_sheets" }
        : event,
    );
  return next;
}
