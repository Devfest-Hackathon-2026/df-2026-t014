import { describe, expect, it, vi } from "vitest";
import {
  baseState,
  issued,
  qrPage,
  r6,
  record,
  testActor,
  uiFixtures,
} from "./functional-fixtures";
import { createCollection, getStudentStatus, orderStudents } from "./logic";
import {
  createRevision,
  restoreSeatLayout,
  saveSeatLayout,
  setCollectionStatus,
  setRecipientRequirement,
} from "./workflows";
import {
  prepareAdditionalIssue,
  completeAdditionalIssue,
} from "./additionalIssue";
import { reviseReviewedPage } from "./corrections";
import { createInitialState } from "./seed";
import type { AppState, QrCorner } from "./types";
const corners: QrCorner[] = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
];
const input = (s = baseState()) => ({
  title: "架空 課題",
  className: s.className,
  pageCount: 2,
  requiredPages: [1, 2],
  qrCorner: "top-right" as const,
  duplex: false,
  order: "row" as const,
  reverse: false,
});
function publish(state: AppState, id: string) {
  return setCollectionStatus(
    setCollectionStatus(state, id, "generating", testActor),
    id,
    "ready",
    testActor,
  );
}
describe("Excel functional seats, issuance and requirements", () => {
  it("PF-F035 one student fits1x1 and every order/corner emits one content token", () => {
    const s = baseState(r6().slice(0, 1));
    expect(
      saveSeatLayout(s, { rows: 1, cols: 1 }, testActor).seatLayouts?.at(-1)
        ?.students,
    ).toHaveLength(1);
    for (const order of ["number", "row", "column", "snake"] as const)
      for (const startCorner of corners) {
        const c = createCollection(
          { ...input(s), pageCount: 1, requiredPages: [1], order, startCorner },
          s.students,
        );
        expect(c.recipients).toHaveLength(1);
        expect(c.tokens).toHaveLength(1);
      }
  });
  it("PF-F036 dimensions0/101 reject and1/99/100 accept without mutation on failure", () => {
    for (const n of [0, 1, 99, 100, 101]) {
      const s = baseState([]),
        before = structuredClone(s);
      if (n >= 1 && n <= 100)
        expect(
          saveSeatLayout(s, { rows: n, cols: n }, testActor).seatLayouts?.at(
            -1,
          ),
        ).toMatchObject({ rows: n, cols: n });
      else
        expect(() =>
          saveSeatLayout(s, { rows: n, cols: n }, testActor),
        ).toThrow();
      expect(s).toEqual(before);
    }
  });
  it("PF-F037 negative fractional and NaN seat coordinates reject and create no history", () => {
    for (const n of [-1, 0.5, NaN]) {
      const s = baseState([{ ...r6()[0], seat: { row: n, col: 0 } }]);
      expect(() =>
        saveSeatLayout(s, { rows: 2, cols: 3 }, testActor),
      ).toThrow();
      expect(s.seatLayouts ?? []).toHaveLength(0);
      expect(() => createCollection(input(), s.students)).toThrow();
    }
  });
  it("PF-F038 two people in one seat reject layout and issuance", () => {
    const students = r6();
    students[1].seat = { ...students[0].seat! };
    const s = baseState(students);
    expect(() => saveSeatLayout(s, { rows: 2, cols: 3 }, testActor)).toThrow(
      /同じ座席/,
    );
    expect(() => createCollection(input(), students)).toThrow(/同じ座席/);
  });
  it("PF-F043 blocked cell bounds and uniqueness enforced", () => {
    const s = baseState([]);
    expect(
      saveSeatLayout(
        s,
        { rows: 2, cols: 3, blockedCells: [{ row: 1, col: 2 }] },
        testActor,
      ).seatLayouts?.at(-1)?.blockedCells,
    ).toEqual([{ row: 1, col: 2 }]);
    for (const blockedCells of [
      [{ row: 2, col: 2 }],
      [{ row: 1, col: 3 }],
      [
        { row: 1, col: 2 },
        { row: 1, col: 2 },
      ],
    ])
      expect(() =>
        saveSeatLayout(s, { rows: 2, cols: 3, blockedCells }, testActor),
      ).toThrow();
  });
  for (const [id, order, expected] of [
    ["PF-F044", "row", ["123456", "321654", "456123", "654321"]],
    ["PF-F045", "column", ["142536", "362514", "415263", "635241"]],
    ["PF-F046", "snake", ["123654", "321456", "456321", "654123"]],
  ] as const)
    it(`${id} all four start corners produce exact ${order} sequence`, () => {
      corners.forEach((corner, i) =>
        expect(
          orderStudents(r6(), order, false, corner)
            .map((s) => s.number)
            .join(""),
        ).toBe(expected[i]),
      );
    });
  it("PF-F047 snake uses coordinate-row relative parity for explicit corner but keeps legacy parity when omitted", () => {
    const students = r6()
      .slice(0, 4)
      .map((s, i) => ({ ...s, seat: { row: i < 2 ? 1 : 3, col: i % 2 } }));
    expect(
      orderStudents(students, "snake", false, "top-left").map((s) => s.number),
    ).toEqual([1, 2, 3, 4]);
    expect(
      orderStudents(students, "snake", false).map((s) => s.number),
    ).toEqual([2, 1, 4, 3]);
  });
  it("PF-F048 number order independent of seat and corner with whole-list reverse", () => {
    const students = r6()
      .map((s, i) => ({ ...s, seat: i % 2 ? null : s.seat }))
      .reverse();
    for (const corner of corners) {
      expect(
        orderStudents(students, "number", false, corner).map((s) => s.number),
      ).toEqual([1, 2, 3, 4, 5, 6]);
      expect(
        orderStudents(students, "number", true, corner).map((s) => s.number),
      ).toEqual([6, 5, 4, 3, 2, 1]);
    }
  });
  it("PF-F050 reverse placed group while unplaced remains ascending at end", () => {
    const students = [
      ...r6(),
      { id: "S08", name: "H", number: 8, seat: null },
      { id: "S07", name: "G", number: 7, seat: null },
    ];
    expect(
      orderStudents(students, "row", true, "top-left").map((s) => s.number),
    ).toEqual([6, 5, 4, 3, 2, 1, 7, 8]);
  });
  it("PF-F053 saving layout adds new immutable history and selects new ID", () => {
    const s = uiFixtures().R6,
      old = structuredClone(s.seatLayouts);
    const n = saveSeatLayout(
      s,
      { rows: 2, cols: 3, name: "次の配置", startCorner: "bottom-right" },
      testActor,
    );
    expect(n.seatLayouts).toHaveLength(old!.length + 1);
    expect(n.seatLayouts?.slice(0, -1)).toEqual(old);
    expect(n.settings?.activeSeatLayoutId).toBe(n.seatLayouts?.at(-1)?.id);
    expect(n.seatLayouts?.at(-1)?.id).not.toBe(old![0].id);
    n.students[0].seat = null;
    expect(n.seatLayouts?.at(-1)?.students[0].seat).toEqual({ row: 0, col: 0 });
  });
  it("PF-F054 restore ignores withdrawn student and leaves newly added student unassigned", () => {
    const s = uiFixtures().R6,
      old = structuredClone(s.seatLayouts);
    s.students = s.students.map((x) => ({
      ...x,
      seat: null,
      enrollment: x.id === "S06" ? "withdrawn" : "active",
    }));
    s.students.push({ id: "S07", name: "新規", number: 7, seat: null });
    const n = restoreSeatLayout(s, old![0].id, testActor);
    for (let i = 0; i < 5; i++)
      expect(n.students[i].seat).toEqual(r6()[i].seat);
    expect(n.students[5].seat).toBeNull();
    expect(n.students[6].seat).toBeNull();
    expect(n.seatLayouts).toHaveLength(2);
    expect(n.seatLayouts?.[0]).toEqual(old![0]);
  });
  it("PF-F061 blank title/class refuse and nonblank names trim", () => {
    for (const field of ["title", "className"])
      expect(() =>
        createCollection({ ...input(), [field]: " \n " }, r6()),
      ).toThrow();
    const c = createCollection(
      { ...input(), title: "  課題  ", className: "  2年A組 " },
      r6(),
    );
    expect(c.title).toBe("課題");
    expect(c.className).toBe("2年A組");
  });
  it("PF-F062 empty required page list rejected", () =>
    expect(() => issued({ requiredPages: [] })).toThrow());
  it("PF-F063 required-page boundaries and duplicates enforced", () => {
    for (const requiredPages of [[0], [4], [1.5], [1, 1]])
      expect(() => issued({ pageCount: 3, requiredPages })).toThrow();
    for (const requiredPages of [[1], [3]]) {
      const c = issued({ pageCount: 3, requiredPages }).collection;
      expect(c.requiredPages).toEqual(requiredPages);
      for (const t of c.tokens)
        expect(t.required).toBe(requiredPages.includes(t.pageNumber));
    }
  });
  it("PF-F064 optional page never completes a required-only return", () => {
    const f = issued({ requiredPages: [2] });
    let s = record(f.state, f.collection, [qrPage(f.collection, "S01", 1, 1)]);
    expect(getStudentStatus(f.collection, "S01", s.receipts)).toMatchObject({
      status: "uncollected",
      receivedCount: 0,
      requiredCount: 1,
    });
    s = record(s, f.collection, [qrPage(f.collection, "S01", 2, 1)], "second");
    expect(getStudentStatus(f.collection, "S01", s.receipts)).toMatchObject({
      status: "complete",
      receivedCount: 1,
      requiredCount: 1,
    });
  });
  it("PF-F065 legal lifecycle controls tokens and refuses recording after close with history", () => {
    const f = issued();
    let s = {
      ...f.state,
      collections: [
        {
          ...f.collection,
          status: "draft" as const,
          tokens: f.collection.tokens.map((t) => ({ ...t, active: false })),
        },
      ],
    };
    s = setCollectionStatus(
      s,
      f.collection.id,
      "generating",
      testActor,
    ) as typeof s;
    expect(s.collections[0].tokens.every((t) => !t.active)).toBe(true);
    for (const status of ["ready", "collecting"] as const) {
      s = setCollectionStatus(
        s,
        f.collection.id,
        status,
        testActor,
      ) as typeof s;
      expect(s.collections[0].tokens.every((t) => t.active)).toBe(true);
    }
    s = setCollectionStatus(
      s,
      f.collection.id,
      "closed",
      testActor,
    ) as typeof s;
    expect(() =>
      record(s, s.collections[0], [qrPage(s.collections[0], "S01", 1, 1)]),
    ).toThrow(/終了/);
    expect(s.events).toHaveLength(4);
  });
  it("PF-F066 illegal transitions reject atomically", () => {
    for (const [from, to] of [
      ["draft", "closed"],
      ["draft", "ready"],
      ["collecting", "draft"],
    ] as const) {
      const f = issued(),
        s = { ...f.state, collections: [{ ...f.collection, status: from }] },
        before = structuredClone(s);
      expect(() =>
        setCollectionStatus(s, f.collection.id, to, testActor),
      ).toThrow();
      expect(s).toEqual(before);
    }
  });
  it("PF-F069 token RNG collision retries and persistent collision stops issuance", () => {
    let call = 0;
    const spy = vi
      .spyOn(globalThis.crypto, "getRandomValues")
      .mockImplementation((buffer) => {
        call++;
        (buffer as Uint8Array).fill(call === 4 ? 3 : call);
        return buffer;
      });
    try {
      const c = issued({}, r6().slice(0, 1)).collection;
      expect(c.tokens).toHaveLength(2);
      expect(new Set(c.tokens.map((t) => t.token)).size).toBe(2);
      expect(call).toBe(5);
      call = 0;
      spy.mockImplementation((buffer) => {
        call++;
        (buffer as Uint8Array).fill(1);
        return buffer;
      });
      expect(() => issued({}, r6().slice(0, 1))).toThrow(/token/);
      expect(call).toBe(13);
    } finally {
      spy.mockRestore();
    }
  });
  it("PF-F070 forty students times ten pages produce400 opaque unique correct tokens", () => {
    const students = createInitialState().students,
      c = issued(
        { pageCount: 10, requiredPages: [1, 10] },
        students,
      ).collection;
    expect(c.tokens).toHaveLength(400);
    expect(new Set(c.tokens.map((t) => t.token)).size).toBe(400);
    for (const student of students)
      expect(
        c.tokens
          .filter((t) => t.studentId === student.id)
          .map((t) => t.pageNumber),
      ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const token of c.tokens) {
      expect(token.token).toMatch(/^[0-9a-f]{32}$/);
      expect(token).toMatchObject({
        collectionId: c.id,
        versionId: c.versionId,
        kind: "content",
      });
      expect(c.recipients.some((s) => s.id === token.studentId)).toBe(true);
      expect(token.required).toBe([1, 10].includes(token.pageNumber));
    }
  });
  it("PF-F071 revision new IDs and fresh tokens preserve original source snapshot and receipt", () => {
    const f = issued();
    f.collection.sourceHash = "original-a";
    const s = record(f.state, f.collection, [
        qrPage(f.collection, "S01", 1, 1),
      ]),
      before = structuredClone(s.collections[0]);
    const n = createRevision(
      s,
      f.collection.id,
      { sourceName: "new source" },
      testActor,
    );
    expect(n.collection.id).not.toBe(f.collection.id);
    expect(n.collection.versionId).not.toBe(f.collection.versionId);
    expect(n.collection.logicalCollectionId).toBe(f.collection.id);
    expect(
      n.collection.tokens.some((t) =>
        f.collection.tokens.some((old) => old.token === t.token),
      ),
    ).toBe(false);
    expect(n.state.collections.find((c) => c.id === f.collection.id)).toEqual(
      before,
    );
    expect(n.state.receipts).toEqual(s.receipts);
  });
  it("PF-F072 pending revision leaves old requirement active until publication", () => {
    const f = issued(),
      n = createRevision(f.state, f.collection.id, {}, testActor);
    expect(n.collection.status).toBe("draft");
    expect(n.collection.tokens.every((t) => t.active === false)).toBe(true);
    expect(
      n.state.collections.find((c) => c.id === f.collection.id)?.recipientStates
        ?.S01,
    ).toBe("required");
    expect(
      record(n.state, f.collection, [qrPage(f.collection, "S01", 1, 1)])
        .receipts,
    ).toHaveLength(1);
    expect(() =>
      record(n.state, n.collection, [qrPage(n.collection, "S01", 1, 1)]),
    ).toThrow();
  });
  it("PF-F073 publishing a revision subset switches only those recipient requirements", () => {
    const f = issued(),
      n = createRevision(
        f.state,
        f.collection.id,
        { students: [r6()[0]] },
        testActor,
      ),
      s = publish(n.state, n.collection.id);
    expect(
      s.collections.find((c) => c.id === f.collection.id)?.recipientStates,
    ).toMatchObject({ S01: "superseded", S02: "required" });
    expect(
      s.collections.find((c) => c.id === n.collection.id)?.recipientStates?.S01,
    ).toBe("required");
  });
  it("PF-F074 old p1 and new p2 never combine across versions", () => {
    const f = issued();
    let s = record(f.state, f.collection, [qrPage(f.collection, "S01", 1, 1)]);
    const rev = createRevision(s, f.collection.id, {}, testActor);
    s = publish(rev.state, rev.collection.id);
    const c = s.collections[0];
    s = record(s, c, [qrPage(c, "S01", 2, 1)], "revision-batch");
    expect(getStudentStatus(f.collection, "S01", s.receipts)).toMatchObject({
      receivedCount: 1,
      missingPages: [2],
    });
    expect(getStudentStatus(c, "S01", s.receipts)).toMatchObject({
      receivedCount: 1,
      missingPages: [1],
      status: "partial",
    });
  });
  it("PF-F075 explicitly accepting old version changes only one person with before/after audit", () => {
    const f = issued(),
      rev = createRevision(f.state, f.collection.id, {}, testActor),
      s = publish(rev.state, rev.collection.id),
      n = setRecipientRequirement(
        s,
        f.collection.id,
        "S01",
        "required",
        testActor,
      );
    expect(
      n.collections.find((c) => c.id === f.collection.id)?.recipientStates,
    ).toMatchObject({ S01: "required", S02: "superseded" });
    expect(
      n.collections.find((c) => c.id === rev.collection.id)?.recipientStates,
    ).toMatchObject({ S01: "superseded", S02: "required" });
    expect(n.events.at(-1)).toMatchObject({
      actor: testActor.actor,
      reason: testActor.reason,
    });
    expect(n.events.at(-1)?.before).toBeTruthy();
    expect(n.events.at(-1)?.after).toBeTruthy();
  });
  it("PF-F076 exemption inherited by revision and remains excluded from uncollected", () => {
    const f = issued(),
      s = setRecipientRequirement(
        f.state,
        f.collection.id,
        "S05",
        "exempt",
        testActor,
      ),
      rev = createRevision(s, f.collection.id, {}, testActor),
      n = publish(rev.state, rev.collection.id);
    expect(getStudentStatus(n.collections[0], "S05", []).status).toBe("exempt");
    expect(n.events.some((e) => e.action === "recipient_requirement")).toBe(
      true,
    );
  });
  it("PF-F077 exemption does not destroy receipts and restoring requirement restores complete", () => {
    const f = issued();
    let s = record(f.state, f.collection, [
      qrPage(f.collection, "S01", 1, 1),
      qrPage(f.collection, "S01", 2, 2),
    ]);
    const ids = s.receipts.map((r) => r.id);
    s = setRecipientRequirement(s, f.collection.id, "S01", "exempt", testActor);
    expect(getStudentStatus(s.collections[0], "S01", s.receipts).status).toBe(
      "exempt",
    );
    s = setRecipientRequirement(
      s,
      f.collection.id,
      "S01",
      "required",
      testActor,
    );
    expect(s.receipts.map((r) => r.id)).toEqual(ids);
    expect(getStudentStatus(s.collections[0], "S01", s.receipts).status).toBe(
      "complete",
    );
  });
  it("PF-F078 changes without actor or reason reject atomically", () => {
    const f = issued();
    for (const context of [
      { actor: "", reason: "reason" },
      { actor: "actor", reason: " " },
    ]) {
      const before = structuredClone(f.state);
      expect(() =>
        setRecipientRequirement(
          f.state,
          f.collection.id,
          "S01",
          "exempt",
          context,
        ),
      ).toThrow();
      expect(() =>
        createRevision(f.state, f.collection.id, {}, context),
      ).toThrow();
      expect(f.state).toEqual(before);
    }
  });
  it("PF-F079 closed collection refuses new record and reassign without retracting old receipt", () => {
    const f = issued();
    let s = record(f.state, f.collection, [qrPage(f.collection, "S01", 1, 1)]);
    s = setCollectionStatus(s, f.collection.id, "closed", testActor);
    const before = structuredClone(s);
    expect(() =>
      record(
        s,
        s.collections[0],
        [qrPage(s.collections[0], "S01", 2, 1)],
        "closed",
      ),
    ).toThrow(/終了/);
    expect(() =>
      reviseReviewedPage(
        s,
        s.batches[0].id,
        1,
        { kind: "reassign", studentId: "S02", pageNumber: 1 },
        testActor,
      ),
    ).toThrow(/再開/);
    expect(s).toEqual(before);
  });
  it("PF-F080 reopening preserves issued identifiers and tokens while accepting remaining page", () => {
    const f = issued();
    let s = record(f.state, f.collection, [qrPage(f.collection, "S01", 1, 1)]);
    const old = s.receipts[0];
    s = setCollectionStatus(
      setCollectionStatus(s, f.collection.id, "closed", testActor),
      f.collection.id,
      "ready",
      testActor,
    );
    expect(s.collections[0].versionId).toBe(f.collection.versionId);
    expect(s.collections[0].tokens.map((t) => t.token)).toEqual(
      f.collection.tokens.map((t) => t.token),
    );
    s = record(
      s,
      s.collections[0],
      [qrPage(s.collections[0], "S01", 2, 1)],
      "reopened",
    );
    expect(s.receipts).toContainEqual(old);
    expect(getStudentStatus(s.collections[0], "S01", s.receipts)).toMatchObject(
      { status: "complete", receivedCount: 2 },
    );
  });
  it("PF-F081 additional issuance uses same version, retains previous tokens and receipts", () => {
    const f = issued({}, r6().slice(0, 2));
    f.state.students = r6();
    const s = record(f.state, f.collection, [
        qrPage(f.collection, "S01", 1, 1),
      ]),
      n = prepareAdditionalIssue(s, f.collection.id, ["S03"], testActor),
      done = completeAdditionalIssue(
        n.state,
        f.collection.id,
        ["S03"],
        testActor,
      );
    expect(done.collections[0].versionId).toBe(f.collection.versionId);
    expect(done.collections[0].tokens.slice(0, 4)).toEqual(f.collection.tokens);
    expect(
      done.collections[0].tokens.filter((t) => t.studentId === "S03"),
    ).toHaveLength(2);
    expect(done.receipts).toEqual(s.receipts);
  });
  it("PF-F082 existing withdrawn unknown or empty recipient choices reject without state mutation", () => {
    const f = issued({}, r6().slice(0, 2));
    f.state.students = [...f.students, { ...r6()[2], enrollment: "withdrawn" }];
    for (const ids of [["S01"], ["S03"], ["S99"], []]) {
      const before = structuredClone(f.state);
      expect(() =>
        prepareAdditionalIssue(f.state, f.collection.id, ids, testActor),
      ).toThrow();
      expect(f.state).toEqual(before);
    }
  });
  it("PF-F083 new recipient snapshot collision in number or seat rejects without rewriting issued snapshot", () => {
    for (const collision of [
      { number: 1, seat: null },
      { number: 3, seat: { row: 0, col: 0 } },
    ]) {
      const f = issued({}, r6().slice(0, 2));
      f.state.students = [...f.students, { ...r6()[2], ...collision }];
      const before = structuredClone(f.state);
      expect(() =>
        prepareAdditionalIssue(f.state, f.collection.id, ["S03"], testActor),
      ).toThrow(/重複/);
      expect(f.state).toEqual(before);
    }
  });
  it("PF-F084 pending additional recipient cannot record, change requirement or revise before completion", () => {
    const f = issued({}, r6().slice(0, 2));
    f.state.students = r6();
    const n = prepareAdditionalIssue(
      f.state,
      f.collection.id,
      ["S03"],
      testActor,
    );
    expect(
      record(n.state, n.collection, [qrPage(n.collection, "S03", 1, 1)])
        .receipts,
    ).toHaveLength(0);
    expect(() =>
      setRecipientRequirement(
        n.state,
        n.collection.id,
        "S03",
        "required",
        testActor,
      ),
    ).toThrow();
    expect(() =>
      createRevision(n.state, n.collection.id, {}, testActor),
    ).toThrow();
    expect(
      record(n.state, n.collection, [qrPage(n.collection, "S01", 1, 1)])
        .receipts,
    ).toHaveLength(1);
  });
});
