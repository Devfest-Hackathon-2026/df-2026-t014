import type {
  AppState,
  Collection,
  ScanBatch,
  ScanPage,
  Student,
} from "./types";
import { createInitialState } from "./seed";
import {
  createCollection,
  recordBatch,
  type CreateCollectionInput,
} from "./logic";
import { saveSeatLayout, setRecipientRequirement } from "./workflows";

export const testActor = {
  actor: "functional-test@example.test",
  reason: "架空データでExcel機能テストを実行",
};
export function r6(): Student[] {
  return [
    "青木 葵",
    "井上 碧",
    "佐藤 蓮",
    "佐藤 蓮",
    "高橋 結衣",
    "渡辺 陽",
  ].map((name, index) => ({
    id: `S${String(index + 1).padStart(2, "0")}`,
    classroomUserId: `google-${index + 1}`,
    name,
    number: index + 1,
    seat: { row: Math.floor(index / 3), col: index % 3 },
    enrollment: "active",
  }));
}
export function baseState(students = r6()): AppState {
  return {
    ...createInitialState(),
    classId: "functional-r6",
    className: "架空テスト 2年A組",
    students,
    events: [],
    settings: { timezone: "Asia/Tokyo" },
  };
}
export function issued(
  overrides: Partial<CreateCollectionInput> = {},
  students = r6(),
): { state: AppState; collection: Collection; students: Student[] } {
  const state = baseState(students);
  const collection = createCollection(
    {
      title: "架空テスト 同意書",
      className: state.className,
      pageCount: 2,
      requiredPages: [1, 2],
      qrCorner: "top-right",
      duplex: false,
      order: "row",
      reverse: false,
      startCorner: "top-left",
      sourceName: "PaperFlowサンプル原稿",
      ...overrides,
    },
    students,
  );
  return {
    state: { ...state, collections: [collection] },
    collection,
    students,
  };
}
export function qrPage(
  collection: Collection,
  studentId: string,
  pageNumber: number,
  sourcePage: number,
  extra: Partial<ScanPage> = {},
): ScanPage {
  const token = collection.tokens.find(
    (token) => token.studentId === studentId && token.pageNumber === pageNumber,
  )!;
  return {
    ...token,
    id: `page-${sourcePage}`,
    sourcePage,
    status: token.kind === "spacer" ? "spacer" : "matched",
    resolution: token.kind === "spacer" ? "ignored" : "accepted",
    ...extra,
  };
}
export function scanBatch(
  collection: Collection,
  pages: ScanPage[],
  id = "functional-batch",
  hash = `hash-${id}`,
  pageCount = Math.max(1, ...pages.map((page) => page.sourcePage)),
): ScanBatch {
  return {
    id,
    hash,
    fileName: `${id}.pdf`,
    pageCount,
    collectionId: collection.id,
    createdAt: "2026-11-10T00:00:00.000Z",
    pages,
  };
}
export function record(
  state: AppState,
  collection: Collection,
  pages: ScanPage[],
  id = "functional-batch",
  hash = `hash-${id}`,
  pageCount?: number,
): AppState {
  return recordBatch(
    state,
    scanBatch(collection, pages, id, hash, pageCount),
    pages,
    testActor,
  );
}
export function uiFixtures(): Record<string, AppState> {
  const { state, collection } = issued();
  const seated = saveSeatLayout(
    state,
    {
      rows: 2,
      cols: 3,
      name: "初期2×3",
      order: "row",
      startCorner: "top-left",
    },
    testActor,
  );
  const statusPages = [
    qrPage(collection, "S01", 1, 1),
    qrPage(collection, "S01", 2, 2),
    qrPage(collection, "S02", 1, 3),
    {
      id: "unknown-4",
      sourcePage: 4,
      status: "unreadable" as const,
      resolution: "pending" as const,
      reason: "QR不読のテスト用ページ",
    },
  ];
  let status = record(seated, collection, statusPages, "status-batch");
  status = setRecipientRequirement(
    status,
    collection.id,
    "S05",
    "exempt",
    testActor,
  );
  status = {
    ...status,
    collections: status.collections.map((item) => ({
      ...item,
      recipientStates: { ...item.recipientStates, S06: "superseded" },
    })),
  };
  return {
    R6: seated,
    STATUS6: status,
    OFFGRID: {
      ...seated,
      students: seated.students.map((student) =>
        student.id === "S01"
          ? { ...student, seat: null }
          : student.id === "S02"
            ? { ...student, seat: { row: 5, col: 5 } }
            : student,
      ),
    },
    R6_PLUS_UNPLACED: {
      ...seated,
      students: [
        ...seated.students,
        {
          id: "S07",
          name: "転入 テスト",
          number: 7,
          seat: null,
          enrollment: "active",
        },
      ],
    },
    ALL_UNPLACED: {
      ...seated,
      students: seated.students.map((student) => ({ ...student, seat: null })),
    },
    EMPTY: baseState([]),
  };
}
