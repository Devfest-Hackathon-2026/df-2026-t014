import { describe, expect, it } from "vitest";
import { createCollection, orderStudents } from "./logic";
import { sanitizeStateForStorage } from "./persistence";
import { createInitialState } from "./seed";
import { restoreSeatLayout, saveSeatLayout } from "./workflows";
import type { DistributionOrder, QrCorner, Student } from "./types";

function grid(rows: number, cols: number): Student[] {
  return Array.from({ length: rows * cols }, (_, index) => ({
    id: String.fromCharCode(97 + index),
    name: String.fromCharCode(65 + index),
    number: index + 1,
    seat: { row: Math.floor(index / cols), col: index % cols },
  }));
}
const ids = (
  students: Student[],
  order: DistributionOrder,
  corner?: QrCorner,
  reverse = false,
) =>
  orderStudents(students, order, reverse, corner)
    .map((student) => student.id)
    .join("");
const expected: Array<{
  corner: QrCorner;
  row: string;
  column: string;
  snake: string;
}> = [
  { corner: "top-left", row: "abcdef", column: "adbecf", snake: "abcfed" },
  { corner: "top-right", row: "cbafed", column: "cfbead", snake: "cbadef" },
  { corner: "bottom-left", row: "defabc", column: "daebfc", snake: "defcba" },
  { corner: "bottom-right", row: "fedcba", column: "fcebda", snake: "fedabc" },
];

describe("distribution starting corner", () => {
  it.each(expected)(
    "orders rows, columns and snake from $corner",
    ({ corner, row, column, snake }) => {
      const students = grid(2, 3);
      const before = structuredClone(students);
      expect(ids(students, "row", corner)).toBe(row);
      expect(ids(students, "column", corner)).toBe(column);
      expect(ids(students, "snake", corner)).toBe(snake);
      expect(students).toEqual(before);
    },
  );
  it.each(expected)(
    "reverses student packets while appending unplaced students in number order from $corner",
    ({ corner, row, column, snake }) => {
      const students = [
        { id: "z", name: "Z", number: 9, seat: null },
        ...grid(2, 3),
        { id: "y", name: "Y", number: 8, seat: null },
      ];
      for (const [order, forward] of [
        ["row", row],
        ["column", column],
        ["snake", snake],
      ] as const)
        expect(ids(students, order, corner, true)).toBe(
          [...forward].reverse().join("") + "yz",
        );
    },
  );
  it("alternates odd rectangular rows and respects a shifted seating origin", () => {
    const students = grid(3, 2).map((student) => ({
      ...student,
      seat: { row: student.seat!.row + 1, col: student.seat!.col + 3 },
    }));
    expect(ids(students, "snake", "top-left")).toBe("abdcef");
    expect(ids(students, "snake", "top-right")).toBe("bacdfe");
    expect(ids(students, "snake", "bottom-left")).toBe("efdcab");
    expect(ids(students, "snake", "bottom-right")).toBe("fecdba");
    // A legacy collection without the new field keeps its original zero-based row parity.
    expect(ids(students, "snake")).toBe("bacdfe");
  });
  it("handles empty seats and empty rosters without losing recipients; number order ignores the corner", () => {
    const students = grid(2, 3).filter(
      (student) => !["b", "e"].includes(student.id),
    );
    expect(ids(students, "snake", "bottom-right")).toBe("fdac");
    expect(ids(students, "number", "bottom-right")).toBe("acdf");
    expect(ids(students, "number", "bottom-right", true)).toBe("fdca");
    expect(orderStudents([], "snake", false, "bottom-left")).toEqual([]);
    expect(
      ids(
        [
          { id: "x", name: "X", number: 2, seat: null },
          { id: "y", name: "Y", number: 1, seat: null },
        ],
        "row",
        "bottom-right",
        true,
      ),
    ).toBe("yx");
    expect(() =>
      orderStudents(students, "row", false, "middle" as QrCorner),
    ).toThrow(/開始位置/);
  });
  it("fixes the issued recipient order and retains the corner in metadata and seat history", () => {
    const students = grid(2, 3);
    const collection = createCollection(
      {
        title: "順序テスト",
        className: "架空組",
        pageCount: 3,
        requiredPages: [1],
        qrCorner: "top-right",
        duplex: true,
        order: "snake",
        reverse: false,
        startCorner: "bottom-right",
      },
      students,
    );
    expect(collection.recipients.map((student) => student.id).join("")).toBe(
      "fedabc",
    );
    expect(collection.startCorner).toBe("bottom-right");
    let state = {
      ...createInitialState(),
      students,
      collections: [collection],
    };
    const context = { actor: "teacher", reason: "右下から配布" };
    state = saveSeatLayout(
      state,
      { rows: 2, cols: 3, order: "snake", startCorner: "bottom-right" },
      context,
    );
    const first = state.seatLayouts![0];
    const restored = sanitizeStateForStorage(state)!;
    expect(restored.collections[0].startCorner).toBe("bottom-right");
    expect(restored.settings?.defaultStartCorner).toBe("bottom-right");
    expect(restored.seatLayouts![0].startCorner).toBe("bottom-right");
    const other = saveSeatLayout(
      restored,
      { rows: 2, cols: 3, startCorner: "top-left" },
      context,
    );
    expect(
      restoreSeatLayout(other, first.id, context).settings?.defaultStartCorner,
    ).toBe("bottom-right");
    expect(
      sanitizeStateForStorage({
        ...state,
        settings: { ...state.settings, defaultStartCorner: "middle" },
      }),
    ).toBeNull();
    expect(
      sanitizeStateForStorage({
        ...state,
        collections: [{ ...collection, startCorner: "middle" }],
      }),
    ).toBeNull();
  });
});
