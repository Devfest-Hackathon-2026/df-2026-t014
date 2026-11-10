import { describe, expect, it } from "vitest";
import { createInitialState } from "./seed";
import {
  createCollection,
  getStudentStatus,
  orderStudents,
  recordBatch,
  toCsv,
  validateStudents,
} from "./logic";
import type { CreateCollectionInput } from "./logic";
import type {
  AppState,
  Collection,
  Receipt,
  ScanBatch,
  ScanPage,
  Student,
} from "./types";
import {
  clearState,
  readState,
  sanitizeStateForStorage,
  STORAGE_KEY,
  writeState,
} from "./persistence";
import type { StorageLike } from "./persistence";

function setup(
  overrides: Partial<CreateCollectionInput> = {},
  students = createInitialState().students.slice(0, 3),
) {
  const collection = createCollection(
    {
      title: "架空の修学旅行同意書",
      className: "2年A組",
      pageCount: 3,
      requiredPages: [1, 3],
      qrCorner: "top-right",
      duplex: false,
      order: "row",
      reverse: false,
      ...overrides,
    },
    students,
  );
  const state: AppState = {
    ...createInitialState(),
    students,
    collections: [collection],
  };
  return { state, collection, students };
}

function pageFor(
  collection: Collection,
  studentId: string,
  pageNumber: number,
  sourcePage: number,
  extra: Partial<ScanPage> = {},
): ScanPage {
  const token = collection.tokens.find(
    (item) => item.studentId === studentId && item.pageNumber === pageNumber,
  )!;
  return {
    id: `scan-page-${sourcePage}`,
    sourcePage,
    token: token.token,
    studentId,
    pageNumber,
    collectionId: collection.id,
    versionId: collection.versionId,
    status: token.kind === "spacer" ? "spacer" : "matched",
    resolution: token.kind === "spacer" ? "ignored" : "accepted",
    ...extra,
  };
}

function batchFor(
  collection: Collection,
  pages: ScanPage[],
  hash = "fixture-scan-hash",
  id = `batch-${hash}`,
): ScanBatch {
  return {
    id,
    hash,
    fileName: "架空の回収.pdf",
    collectionId: collection.id,
    pageCount: Math.max(1, ...pages.map((page) => page.sourcePage)),
    createdAt: "2026-11-09T01:00:00.000Z",
    pages,
  };
}

function receiptFor(
  collection: Collection,
  studentId: string,
  pageNumber: number,
  extra: Partial<Receipt> = {},
): Receipt {
  return {
    id: `receipt-${studentId}-${pageNumber}`,
    studentId,
    pageNumber,
    collectionId: collection.id,
    versionId: collection.versionId,
    batchId: "test-batch",
    sourcePage: pageNumber,
    method: "qr",
    recordedAt: "2026-11-09T01:00:00.000Z",
    ...extra,
  };
}

class MemoryStorage implements StorageLike {
  private values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

describe("roster and distribution", () => {
  it("starts with 40 fictional recipients in 8 rows and 5 columns, including duplicate names", () => {
    const state = createInitialState();
    expect(state.className).toBe("2年A組");
    expect(state.students).toHaveLength(40);
    expect(state.students[39].seat).toEqual({ row: 7, col: 4 });
    expect(new Set(state.students.map((student) => student.id)).size).toBe(40);
    expect(
      new Set(state.students.map((student) => student.name)).size,
    ).toBeLessThan(40);
    expect(validateStudents(state.students)).toEqual([]);
    expect(state.collections).toEqual([]);
    expect(state.receipts).toEqual([]);
  });

  it("orders row, column and snake paths without mutating the roster; reversal reverses recipients", () => {
    const students: Student[] = [
      { id: "d", name: "D", number: 4, seat: { row: 1, col: 1 } },
      { id: "b", name: "B", number: 2, seat: { row: 0, col: 1 } },
      { id: "e", name: "E", number: 5, seat: null },
      { id: "a", name: "A", number: 1, seat: { row: 0, col: 0 } },
      { id: "c", name: "C", number: 3, seat: { row: 1, col: 0 } },
    ];
    const original = structuredClone(students);
    const ids = (order: Parameters<typeof orderStudents>[1], reverse = false) =>
      orderStudents(students, order, reverse)
        .map((student) => student.id)
        .join("");
    expect(ids("row")).toBe("abcde");
    expect(ids("column")).toBe("acbde");
    expect(ids("snake")).toBe("abdce");
    expect(ids("snake", true)).toBe("cdbae");
    expect(students).toEqual(original);
  });

  it("rejects duplicate seats and attendance numbers, but never uses names as keys", () => {
    const sameName = createInitialState().students.filter(
      (student) => student.name === "佐藤 葵",
    );
    expect(validateStudents(sameName)).toEqual([]);
    expect(
      validateStudents([
        { ...sameName[0] },
        { ...sameName[1], seat: sameName[0].seat },
      ]),
    ).not.toEqual([]);
    expect(
      validateStudents([
        { ...sameName[0] },
        { ...sameName[1], number: sameName[0].number },
      ]),
    ).not.toEqual([]);
    expect(() =>
      orderStudents([{ ...sameName[0], seat: { row: -1, col: 0 } }], "row"),
    ).toThrow();
  });
});

describe("issued paper manifest", () => {
  it("gives every content page an independent 128-bit token and pads odd duplex recipients", () => {
    const { collection } = setup({ duplex: true, requiredPages: [3] });
    expect(collection.tokens).toHaveLength(12);
    expect(new Set(collection.tokens.map((token) => token.token)).size).toBe(
      12,
    );
    expect(
      collection.tokens.every((token) => /^[0-9a-f]{32}$/.test(token.token)),
    ).toBe(true);
    for (const student of collection.recipients) {
      const tokens = collection.tokens.filter(
        (token) => token.studentId === student.id,
      );
      expect(tokens.map((token) => token.pageNumber)).toEqual([1, 2, 3, 4]);
      expect(
        tokens
          .filter((token) => token.required)
          .map((token) => token.pageNumber),
      ).toEqual([3]);
      expect(tokens[3]).toMatchObject({
        kind: "spacer",
        required: false,
        pageNumber: 4,
      });
    }
    const even = setup({
      duplex: true,
      pageCount: 2,
      requiredPages: [2],
    }).collection;
    expect(even.tokens.some((token) => token.kind === "spacer")).toBe(false);
  });

  it("freezes the recipient roster and uses new tokens for a new issuance", () => {
    const students = createInitialState().students.slice(0, 2);
    const { collection } = setup({}, students);
    const frozen = structuredClone(collection.recipients);
    students[0].name = "変更した氏名";
    students[0].seat!.row = 7;
    expect(collection.recipients).toEqual(frozen);
    const next = setup().collection;
    expect(next.versionId).not.toBe(collection.versionId);
    expect(
      next.tokens.some((token) =>
        collection.tokens.some((old) => old.token === token.token),
      ),
    ).toBe(false);
  });

  it("requires at least one valid, nonduplicated return page", () => {
    expect(() => setup({ requiredPages: [] })).toThrow();
    expect(() => setup({ requiredPages: [4] })).toThrow();
    expect(() => setup({ requiredPages: [1, 1] })).toThrow();
    expect(() => setup({ pageCount: 1.5 })).toThrow();
  });

  it("counts only required pages for the same person, collection and version", () => {
    const { collection, students } = setup({ requiredPages: [3] });
    const student = students[0];
    const wrong = [
      receiptFor(collection, student.id, 1),
      receiptFor(collection, students[1].id, 3),
      receiptFor(collection, student.id, 3, { versionId: "old-version" }),
      receiptFor(collection, student.id, 3, {
        collectionId: "other-collection",
      }),
    ];
    expect(getStudentStatus(collection, student.id, wrong)).toMatchObject({
      status: "uncollected",
      receivedCount: 0,
      missingPages: [3],
    });
    const accepted = receiptFor(collection, student.id, 3);
    expect(
      getStudentStatus(collection, student.id, [...wrong, accepted, accepted]),
    ).toMatchObject({ status: "complete", receivedCount: 1, requiredCount: 1 });
  });
});

describe("receipt registration and recovery", () => {
  it("records only accepted content pages, and reports partial then complete returns", () => {
    const { state, collection, students } = setup({ duplex: true });
    const first = pageFor(collection, students[0].id, 1, 1);
    const spacer = pageFor(collection, students[0].id, 4, 2);
    const partial = recordBatch(state, batchFor(collection, [first, spacer]), [
      first,
      spacer,
    ]);
    expect(partial.receipts).toHaveLength(1);
    expect(
      getStudentStatus(collection, students[0].id, partial.receipts).status,
    ).toBe("partial");
    const last = pageFor(collection, students[0].id, 3, 1);
    const complete = recordBatch(
      partial,
      batchFor(collection, [last], "second-day"),
      [last],
    );
    expect(
      getStudentStatus(collection, students[0].id, complete.receipts),
    ).toMatchObject({ status: "complete", receivedCount: 2 });
    expect(state.receipts).toEqual([]);
  });

  it("does not trust a mismatched claimed person or version even when the token is valid", () => {
    const { state, collection, students } = setup();
    const wrongPerson = pageFor(collection, students[0].id, 1, 1, {
      studentId: students[1].id,
    });
    const wrongVersion = pageFor(collection, students[0].id, 3, 2, {
      versionId: "another-version",
    });
    const output = recordBatch(
      state,
      batchFor(collection, [wrongPerson, wrongVersion]),
      [wrongPerson, wrongVersion],
    );
    expect(output.receipts).toEqual([]);
    expect(
      output.batches[0].pages.every((page) => page.resolution === "pending"),
    ).toBe(true);
  });

  it("never automatically records unknown, foreign, unreadable or ignored pages", () => {
    const { state, collection, students } = setup();
    const pages: ScanPage[] = [
      {
        id: "unreadable",
        sourcePage: 1,
        status: "unreadable",
        resolution: "pending",
      },
      {
        id: "unknown",
        sourcePage: 2,
        token: "unknown",
        status: "unknown",
        resolution: "pending",
      },
      pageFor(collection, students[0].id, 1, 3, {
        status: "foreign",
        collectionId: "different",
        resolution: "accepted",
      }),
      pageFor(collection, students[0].id, 3, 4, { resolution: "ignored" }),
    ];
    expect(
      recordBatch(state, batchFor(collection, pages), pages).receipts,
    ).toEqual([]);
  });

  it("deduplicates within one scan and across rescans without replacing earlier evidence", () => {
    const { state, collection, students } = setup();
    const one = pageFor(collection, students[0].id, 1, 1);
    const two = pageFor(collection, students[0].id, 1, 2);
    const first = recordBatch(state, batchFor(collection, [one, two]), [
      one,
      two,
    ]);
    expect(first.receipts).toHaveLength(1);
    expect(first.batches[0].pages[1]).toMatchObject({
      status: "duplicate",
      resolution: "pending",
    });
    const second = recordBatch(first, batchFor(collection, [one], "rescan"), [
      one,
    ]);
    expect(second.receipts).toEqual(first.receipts);
    expect(
      second.batches.find((batch) => batch.hash === "rescan")?.pages[0].status,
    ).toBe("duplicate");
  });

  it("reopening the same file under another transient ID is idempotent", () => {
    const { state, collection, students } = setup();
    const pages = [pageFor(collection, students[0].id, 1, 1)];
    const first = recordBatch(state, batchFor(collection, pages), pages);
    const replay = recordBatch(
      first,
      batchFor(collection, pages, "fixture-scan-hash", "new-ui-id"),
      pages.map((page) => ({ ...page, id: "new-page-ui-id" })),
    );
    expect(replay).toBe(first);
  });

  it("can resolve an unreadable page later without registering confirmed pages again", () => {
    const { state, collection, students } = setup();
    const first = pageFor(collection, students[0].id, 1, 1);
    const unreadable: ScanPage = {
      id: "unreadable",
      sourcePage: 2,
      status: "unreadable",
      resolution: "pending",
      thumbnail: "data:image/png;base64,private",
    };
    const initial = recordBatch(
      state,
      batchFor(collection, [first, unreadable]),
      [first, unreadable],
    );
    const manual: ScanPage = {
      ...unreadable,
      status: "matched",
      resolution: "accepted",
      manual: true,
      collectionId: collection.id,
      versionId: collection.versionId,
      studentId: students[0].id,
      pageNumber: 3,
    };
    const resumed = recordBatch(
      initial,
      batchFor(collection, [first, manual], "fixture-scan-hash", "new-ui-id"),
      [first, manual],
      { actor: "teacher", reason: "紙を目視して番号とページを確認" },
    );
    expect(resumed.receipts).toHaveLength(2);
    expect(resumed.batches).toHaveLength(1);
    expect(resumed.batches[0].pages.some((page) => page.thumbnail)).toBe(false);
    expect(
      resumed.events.filter((event) => event.action === "manual_assignment"),
    ).toHaveLength(1);
    expect(
      getStudentStatus(collection, students[0].id, resumed.receipts).status,
    ).toBe("complete");
  });

  it("does not reassign an already registered source page to a different person", () => {
    const { state, collection, students } = setup();
    const page = pageFor(collection, students[0].id, 1, 1);
    const initial = recordBatch(state, batchFor(collection, [page]), [page]);
    const changed = { ...page, manual: true, studentId: students[1].id };
    const result = recordBatch(initial, batchFor(collection, [changed]), [
      changed,
    ]);
    expect(result.receipts).toEqual(initial.receipts);
    expect(result.batches[0].pages[0].studentId).toBe(students[0].id);
  });

  it("explicitly replaces only the same issued page and retains an audit of old and new evidence", () => {
    const { state, collection, students } = setup();
    const originalPage = pageFor(collection, students[0].id, 1, 1);
    const first = recordBatch(
      state,
      batchFor(collection, [originalPage], "old-scan"),
      [originalPage],
    );
    const oldReceipt = first.receipts[0];
    const replacement = pageFor(collection, students[0].id, 1, 1, {
      status: "duplicate",
    });
    const updated = recordBatch(
      first,
      batchFor(collection, [replacement], "new-scan"),
      [replacement],
      {
        replaceReceiptIds: [oldReceipt.id],
        actor: "teacher",
        reason: "旧画像と新画像を比較して差し替え",
      },
    );
    expect(updated.receipts).toHaveLength(1);
    expect(updated.receipts[0].batchId).toBe("batch-new-scan");
    expect(updated.receipts[0].id).not.toBe(oldReceipt.id);
    expect(
      updated.batches.find((batch) => batch.id === "batch-old-scan")?.pages[0]
        .resolution,
    ).toBe("ignored");
    const audit = JSON.parse(
      updated.events.find((event) => event.action === "replace_receipt")!
        .detail,
    );
    expect(audit.previous.id).toBe(oldReceipt.id);
    expect(audit.next.id).toBe(updated.receipts[0].id);
    expect(audit.previous.token).toBeUndefined();
  });

  it("rejects replacements for an unknown ID or a different student/page/version", () => {
    const { state, collection, students } = setup();
    const original = pageFor(collection, students[0].id, 1, 1);
    const first = recordBatch(state, batchFor(collection, [original]), [
      original,
    ]);
    const otherStudent = pageFor(collection, students[1].id, 1, 1);
    expect(() =>
      recordBatch(
        first,
        batchFor(collection, [otherStudent], "other"),
        [otherStudent],
        { replaceReceiptIds: [first.receipts[0].id] },
      ),
    ).toThrow(/一致/);
    expect(() =>
      recordBatch(
        first,
        batchFor(collection, [original], "other"),
        [original],
        { replaceReceiptIds: ["missing-receipt"] },
      ),
    ).toThrow(/見つかりません/);
    expect(first.receipts).toHaveLength(1);
  });

  it("permits distinct original pages in the same scan bytes to be processed for different target collections", () => {
    const first = setup();
    const second = setup();
    const state = {
      ...first.state,
      collections: [first.collection, second.collection],
    };
    const firstPage = pageFor(first.collection, first.students[0].id, 1, 1);
    const afterFirst = recordBatch(
      state,
      {
        ...batchFor(first.collection, [firstPage], "mixed-scan", "batch-a"),
        pageCount: 2,
      },
      [firstPage],
    );
    const secondPage = pageFor(second.collection, second.students[0].id, 1, 2);
    const afterSecond = recordBatch(
      afterFirst,
      batchFor(second.collection, [secondPage], "mixed-scan", "batch-b"),
      [secondPage],
    );
    expect(afterSecond.receipts).toHaveLength(2);
    expect(afterSecond.batches).toHaveLength(2);
    expect(
      afterSecond.receipts.map((receipt) => receipt.sourcePage).sort(),
    ).toEqual([1, 2]);
    expect(
      new Set(afterSecond.batches.map((batch) => batch.sourceId)).size,
    ).toBe(1);
    const invalidSecondPage = pageFor(
      second.collection,
      second.students[0].id,
      1,
      1,
    );
    const blocked = recordBatch(
      afterFirst,
      {
        ...batchFor(
          second.collection,
          [invalidSecondPage],
          "mixed-scan",
          "batch-b",
        ),
        pageCount: 2,
      },
      [invalidSecondPage],
    );
    expect(blocked.receipts).toHaveLength(1);
    expect(
      blocked.batches.find((batch) => batch.id === "batch-b")!.pages[0]
        .handledBy?.batchId,
    ).toBe("batch-a");
  });
});

describe("safe local demo persistence and CSV", () => {
  it("escapes formula prefixes and CSV quotes, while exporting recorded statuses", () => {
    const names = [
      '=IMPORTXML("url")',
      "  +cmd",
      "\t@SUM(A1)",
      '通常,の"名前"',
    ];
    const students = createInitialState()
      .students.slice(0, 4)
      .map((student, index) => ({ ...student, name: names[index] }));
    const { state, collection } = setup({}, students);
    const csv = toCsv(state, collection);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain('"\'=IMPORTXML(""url"")"');
    expect(csv).toContain('"\'  +cmd"');
    expect(csv).toContain('"\'\t@SUM(A1)"');
    expect(csv).toContain('"通常,の""名前"""');
    expect(csv).toContain('"未回収"');
  });

  it("persists only allowlisted metadata, never PDF bytes, thumbnails or OAuth fields", () => {
    const { state, collection, students } = setup();
    const page = pageFor(collection, students[0].id, 1, 1, {
      thumbnail: "data:image/png;base64,private-image",
    });
    const withData = {
      ...recordBatch(state, batchFor(collection, [page]), [page]),
      oauthToken: "secret-oauth",
      sourcePdf: [1, 2, 3],
    };
    withData.batches[0].pages[0].thumbnail = "private-image";
    const target = new MemoryStorage();
    expect(writeState(withData, target)).toBe(true);
    const raw = target.getItem(STORAGE_KEY)!;
    expect(raw).not.toContain("private-image");
    expect(raw).not.toContain("secret-oauth");
    expect(raw).not.toContain("sourcePdf");
    const restored = readState(target);
    expect(restored.receipts).toHaveLength(1);
    expect(restored.collections[0].tokens).toEqual(collection.tokens);
    expect(restored.batches[0].pages[0].thumbnail).toBeUndefined();
    expect(clearState(target)).toBe(true);
    expect(readState(target).collections).toEqual([]);
  });

  it("recovers from unavailable storage, malformed JSON and unsupported schema without crashing", () => {
    const unavailable: StorageLike = {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("full");
      },
      removeItem() {
        throw new Error("denied");
      },
    };
    expect(readState(unavailable).students).toHaveLength(40);
    expect(writeState(createInitialState(), unavailable)).toBe(false);
    const target = new MemoryStorage();
    target.setItem(STORAGE_KEY, "{ broken JSON");
    expect(readState(target).collections).toEqual([]);
    target.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...createInitialState(), schemaVersion: 999 }),
    );
    expect(readState(target).schemaVersion).toBe(1);
    expect(sanitizeStateForStorage({ schemaVersion: 1 })).toBeNull();
  });
});
