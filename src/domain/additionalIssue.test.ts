import { describe, expect, it } from "vitest";
import {
  prepareAdditionalIssue,
  completeAdditionalIssue,
} from "./additionalIssue";
import { createCollection, getStudentStatus, recordBatch } from "./logic";
import { createInitialState } from "./seed";
import { sanitizeStateForStorage } from "./persistence";
import { setCollectionStatus, setRecipientRequirement } from "./workflows";
import type { ScanPage } from "./types";
const context = { actor: "teacher", reason: "転入した生徒へ追加配布" };
function fixture() {
  const initial = createInitialState();
  const students = initial.students.slice(0, 3);
  const collection = createCollection(
    {
      title: "確認票",
      className: "2年A組",
      pageCount: 3,
      requiredPages: [3],
      duplex: true,
      qrCorner: "top-right",
      order: "row",
      reverse: false,
      startCorner: "bottom-right",
    },
    students.slice(0, 2),
  );
  const state = { ...initial, students, collections: [collection] };
  return { state, collection, students };
}
describe("same-version additional issuance", () => {
  it("keeps inactive original tokens and unfinished cleanup blocked even for manual QR-free assignment", () => {
    const { state, collection, students } = fixture();
    const inactive = {
      ...state,
      collections: [
        {
          ...collection,
          tokens: collection.tokens.map((token) => ({
            ...token,
            active: false,
          })),
        },
      ],
      cleanupOperations: [
        {
          id: "cleanup",
          collectionIds: [collection.id],
          actor: "teacher",
          reason: "整理",
          createdAt: "now",
          status: "failed" as const,
          files: [],
        },
      ],
    };
    const page: ScanPage = {
      id: "p",
      sourcePage: 1,
      status: "matched",
      resolution: "accepted",
      manual: true,
      studentId: students[0].id,
      pageNumber: 3,
    };
    const batch = {
      id: "b",
      hash: "h",
      fileName: "scan.pdf",
      pageCount: 1,
      collectionId: collection.id,
      createdAt: "now",
      pages: [page],
    };
    expect(() => recordBatch(inactive, batch, [page])).toThrow(/削除/);
    expect(inactive.receipts).toHaveLength(0);
    expect(() =>
      setCollectionStatus(inactive, collection.id, "ready", context),
    ).toThrow(/未完了/);
    expect(() =>
      prepareAdditionalIssue(
        inactive,
        collection.id,
        [students[2].id],
        context,
      ),
    ).toThrow(/未完了/);
  });
  it("preserves old recipients, tokens and requirements until new packets are ready", () => {
    const { state, collection, students } = fixture();
    const exempt = setRecipientRequirement(
      state,
      collection.id,
      students[0].id,
      "exempt",
      context,
    );
    const result = prepareAdditionalIssue(
      exempt,
      collection.id,
      [students[2].id],
      context,
    );
    expect(result.collection.versionId).toBe(collection.versionId);
    expect(result.collection.recipients.slice(0, 2)).toEqual(
      collection.recipients,
    );
    expect(result.collection.tokens.slice(0, collection.tokens.length)).toEqual(
      collection.tokens,
    );
    expect(result.collection.recipientStates![students[0].id]).toBe("exempt");
    expect(
      result.collection.tokens.filter(
        (token) => token.studentId === students[2].id,
      ),
    ).toHaveLength(4);
    expect(
      result.collection.tokens
        .filter((token) => token.studentId === students[2].id)
        .every((token) => token.active === false),
    ).toBe(true);
    expect(
      new Set(result.collection.tokens.map((token) => token.token)).size,
    ).toBe(result.collection.tokens.length);
    expect(sanitizeStateForStorage(result.state)).not.toBeNull();
    expect(result.collection.printStudentOrder).toEqual([
      ...collection.recipients.map((student) => student.id),
      students[2].id,
    ]);
    expect(() =>
      setRecipientRequirement(
        result.state,
        collection.id,
        students[2].id,
        "required",
        context,
      ),
    ).toThrow(/追加発行/);
    const reopened = setCollectionStatus(
      setCollectionStatus(result.state, collection.id, "closed", context),
      collection.id,
      "ready",
      context,
    );
    expect(
      reopened.collections[0].tokens
        .filter((token) => token.studentId === students[2].id)
        .every((token) => token.active === false),
    ).toBe(true);
    const complete = completeAdditionalIssue(
      reopened,
      collection.id,
      result.addedStudentIds,
      context,
    );
    expect(
      complete.collections[0].tokens
        .filter((token) => token.studentId === students[2].id)
        .every((token) => token.active === true),
    ).toBe(true);
    expect(
      getStudentStatus(
        complete.collections[0],
        students[2].id,
        complete.receipts,
      ).status,
    ).toBe("uncollected");
    expect(complete.collections[0].recipientStates![students[0].id]).toBe(
      "exempt",
    );
    expect(
      completeAdditionalIssue(
        complete,
        collection.id,
        result.addedStudentIds,
        context,
      ),
    ).toBe(complete);
    expect(sanitizeStateForStorage(complete)).not.toBeNull();
  });
  it("does not accept a new QR or manual assignment before completion, then records the same issued token", () => {
    const { state, collection, students } = fixture();
    const prepared = prepareAdditionalIssue(
      state,
      collection.id,
      [students[2].id],
      context,
    );
    const token = prepared.collection.tokens.find(
      (token) => token.studentId === students[2].id && token.pageNumber === 3,
    )!;
    const page: ScanPage = {
      ...token,
      id: "p",
      sourcePage: 1,
      status: "matched",
      resolution: "accepted",
    };
    const batch = {
      id: "b",
      hash: "hash",
      fileName: "追加.pdf",
      pageCount: 1,
      collectionId: collection.id,
      createdAt: "now",
      pages: [page],
    };
    expect(recordBatch(prepared.state, batch, [page]).receipts).toHaveLength(0);
    expect(
      recordBatch(prepared.state, batch, [
        { ...page, token: undefined, manual: true },
      ]).receipts,
    ).toHaveLength(0);
    const issued = completeAdditionalIssue(
      prepared.state,
      collection.id,
      [students[2].id],
      context,
    );
    const recorded = recordBatch(issued, batch, [page]);
    expect(recorded.receipts).toHaveLength(1);
    expect(recorded.receipts[0].token).toBe(token.token);
    expect(sanitizeStateForStorage(recorded)).not.toBeNull();
  });
  it("rejects existing, withdrawn, unknown, conflicting snapshots, duplicate targets and closed collections", () => {
    const { state, collection, students } = fixture();
    expect(() =>
      prepareAdditionalIssue(state, collection.id, [students[0].id], context),
    ).toThrow(/再印刷/);
    expect(() =>
      prepareAdditionalIssue(state, collection.id, ["missing"], context),
    ).toThrow(/在籍/);
    expect(() =>
      prepareAdditionalIssue(
        state,
        collection.id,
        [students[2].id, students[2].id],
        context,
      ),
    ).toThrow(/重複/);
    expect(() =>
      prepareAdditionalIssue(
        {
          ...state,
          students: state.students.map((student) =>
            student.id === students[2].id
              ? { ...student, enrollment: "withdrawn" }
              : student,
          ),
        },
        collection.id,
        [students[2].id],
        context,
      ),
    ).toThrow(/在籍/);
    expect(() =>
      prepareAdditionalIssue(
        {
          ...state,
          students: state.students.map((student) =>
            student.id === students[2].id
              ? { ...student, seat: students[0].seat }
              : student,
          ),
        },
        collection.id,
        [students[2].id],
        context,
      ),
    ).toThrow(/既発行時/);
    for (const status of ["draft", "generating", "closed"] as const)
      expect(() =>
        prepareAdditionalIssue(
          { ...state, collections: [{ ...collection, status }] },
          collection.id,
          [students[2].id],
          context,
        ),
      ).toThrow(/発行済み/);
    expect(() =>
      prepareAdditionalIssue(state, collection.id, [students[2].id], {
        ...context,
        reason: "",
      }),
    ).toThrow(/理由/);
  });
});
