import type { AppState, ChangeContext, Student } from "./types";
import { validateStudents } from "./logic";
import { changeEvent, requireChangeContext } from "./workflows";

export interface RosterCsvRow {
  row: number;
  name: string;
  number: number;
  externalId?: string;
  seat?: { row: number; col: number };
}
export const NEW_STUDENT = "__new_student__";

export function parseRosterCsv(text: string): RosterCsvRow[] {
  const rows: string[][] = [];
  let row: string[] = [],
    value = "",
    quoted = false;
  const input = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"') {
      if (quoted && input[i + 1] === '"') {
        value += '"';
        i++;
      } else if (!quoted && value.length)
        throw new Error("CSVの引用符を確認してください。");
      else quoted = !quoted;
    } else if (!quoted && (ch === "," || ch === "\n" || ch === "\r")) {
      row.push(value);
      value = "";
      if (ch !== ",") {
        if (row.some((cell) => cell.trim())) rows.push(row);
        row = [];
        if (ch === "\r" && input[i + 1] === "\n") i++;
      }
    } else value += ch;
  }
  if (quoted) throw new Error("CSVの引用符が閉じていません。");
  row.push(value);
  if (row.some((cell) => cell.trim())) rows.push(row);
  if (rows.length < 2) throw new Error("見出しと1人以上の名簿が必要です。");
  const header = rows[0].map((cell) => cell.trim().toLowerCase());
  const column = (aliases: string[]) =>
    header.findIndex((cell) => aliases.includes(cell));
  const nameIndex = column(["氏名", "名前", "name"]);
  const numberIndex = column(["出席番号", "番号", "number"]);
  const idIndex = column(["生徒id", "classroom id", "classroomuserid", "id"]);
  const rowIndex = column(["行", "seatrow", "row"]);
  const colIndex = column(["列", "seatcolumn", "col"]);
  if (nameIndex < 0 || numberIndex < 0)
    throw new Error("CSVに「出席番号」「氏名」の見出しを用意してください。");
  const result = rows.slice(1).map((cells, index): RosterCsvRow => {
    const name = cells[nameIndex]?.trim() ?? "";
    const numberText = cells[numberIndex]?.trim() ?? "";
    if (!name || !/^\d+$/.test(numberText) || Number(numberText) < 1)
      throw new Error(`${index + 2}行目の氏名・出席番号を確認してください。`);
    const result: RosterCsvRow = {
      row: index + 2,
      name,
      number: Number(numberText),
    };
    const id = idIndex >= 0 ? cells[idIndex]?.trim() : "";
    if (id) result.externalId = id;
    const r = rowIndex >= 0 ? cells[rowIndex]?.trim() : "";
    const c = colIndex >= 0 ? cells[colIndex]?.trim() : "";
    if (r || c) {
      if (!r || !c || !/^\d+$/.test(r) || !/^\d+$/.test(c) || +r < 1 || +c < 1)
        throw new Error(
          `${index + 2}行目の座席は1以上の行・列で指定してください。`,
        );
      result.seat = { row: Number(r) - 1, col: Number(c) - 1 };
    }
    return result;
  });
  if (new Set(result.map((row) => row.number)).size !== result.length)
    throw new Error("CSVの出席番号が重複しています。");
  return result;
}

/** Every row requires an explicit stable-ID mapping or a confirmed new-person choice. Names never identify a person. */
export function applyRosterCsv(
  state: AppState,
  rows: RosterCsvRow[],
  mapping: Record<number, string>,
  context: ChangeContext,
): AppState {
  requireChangeContext(context);
  const usedIds = new Set<string>();
  let students = structuredClone(state.students);
  for (const row of rows) {
    const choice = mapping[row.row];
    if (!choice)
      throw new Error(
        `${row.row}行目を既存の生徒、または新規追加へ対応付けてください。`,
      );
    if (choice === NEW_STUDENT) {
      students.push({
        id: crypto.randomUUID(),
        name: row.name,
        number: row.number,
        seat: row.seat ?? null,
        enrollment: "active",
      });
    } else {
      if (
        usedIds.has(choice) ||
        !students.some((student) => student.id === choice)
      )
        throw new Error(
          "同じ生徒への複数行の割り当て、または不明な生徒があります。",
        );
      usedIds.add(choice);
      students = students.map((student) =>
        student.id === choice
          ? {
              ...student,
              name: row.name,
              number: row.number,
              seat: row.seat ?? student.seat,
              enrollment: "active",
            }
          : student,
      );
    }
  }
  const errors = validateStudents(students);
  if (errors.length) throw new Error(errors.join("\n"));
  return {
    ...state,
    students,
    events: [
      ...state.events,
      changeEvent(
        "import_roster_csv",
        state.classId ?? "local-class",
        context,
        state.students.map((student) => ({
          id: student.id,
          name: student.name,
          number: student.number,
        })),
        students.map((student) => ({
          id: student.id,
          name: student.name,
          number: student.number,
        })),
      ),
    ],
  };
}

export function csvIdentityCandidate(
  row: RosterCsvRow,
  students: Student[],
): string | undefined {
  if (!row.externalId) return undefined;
  const matches = students.filter(
    (student) =>
      student.id === row.externalId ||
      student.classroomUserId === row.externalId ||
      student.id === `classroom:${row.externalId}`,
  );
  return matches.length === 1 ? matches[0].id : undefined;
}
