import { createCollection, orderStudents, validateStudents } from "./logic";
import type { AppState, ChangeContext, Collection } from "./types";
import {
  changeEvent,
  collectionSeries,
  requireChangeContext,
} from "./workflows";

function issuanceTarget(
  state: AppState,
  collectionId: string,
  studentIds: string[],
  context: ChangeContext,
): Collection {
  requireChangeContext(context);
  const target = state.collections.find(
    (collection) => collection.id === collectionId,
  );
  if (!target) throw new Error("追加発行する配布物が見つかりません。");
  if (target.archivedAt || target.deletedAt)
    throw new Error("保管・削除済みの配布物には追加発行できません。");
  if (
    state.cleanupOperations?.some(
      (operation) =>
        operation.status !== "complete" &&
        operation.collectionIds.includes(collectionId),
    )
  )
    throw new Error("整理・削除処理が未完了の配布物には追加発行できません。");
  if (
    target.status === "closed" ||
    target.status === "draft" ||
    target.status === "generating"
  )
    throw new Error(
      "発行済み・回収中の配布物で追加発行してください。終了した配布物は先に再開してください。",
    );
  if (
    !studentIds.length ||
    new Set(studentIds).size !== studentIds.length ||
    studentIds.some((id) => !id)
  )
    throw new Error("追加発行する生徒を重複なく1人以上選んでください。");
  return target;
}

/** Persists new tokens before PDF generation; established recipients and receipts remain untouched. */
export function prepareAdditionalIssue(
  state: AppState,
  collectionId: string,
  studentIds: string[],
  context: ChangeContext,
): { state: AppState; collection: Collection; addedStudentIds: string[] } {
  const target = issuanceTarget(state, collectionId, studentIds, context);
  if (
    studentIds.some((id) =>
      target.recipients.some((student) => student.id === id),
    )
  )
    throw new Error(
      "既にこの版の対象になっている生徒がいます。既存の対象者には再印刷を使用してください。",
    );
  const selected = studentIds.map((id) => {
    const student = state.students.find((student) => student.id === id);
    if (!student || student.enrollment === "withdrawn")
      throw new Error("現在の在籍名簿にない生徒には追加発行できません。");
    if (
      state.collections.some(
        (collection) =>
          collection.id !== target.id &&
          collectionSeries(collection) === collectionSeries(target) &&
          collection.recipients.some((person) => person.id === id) &&
          (collection.recipientStates?.[id] ?? "required") === "required",
      )
    )
      throw new Error(
        "同じ配布物の別版で回収対象になっています。受理する版を確認してください。",
      );
    return student;
  });
  const added = createCollection(target, selected);
  const combinedErrors = validateStudents([
    ...target.recipients,
    ...added.recipients,
  ]);
  if (combinedErrors.length)
    throw new Error(
      `既発行時の名簿と追加対象の番号・座席が重複しています。既発行の情報は上書きしません。追加対象の番号・座席を確認してください。\n${combinedErrors.join("\n")}`,
    );
  const addedStudentIds = added.recipients.map((student) => student.id);
  const oldOrder =
    target.printStudentOrder ??
    orderStudents(
      target.recipients,
      target.order,
      target.reverse,
      target.startCorner,
    ).map((student) => student.id);
  const collection: Collection = {
    ...target,
    recipients: [...target.recipients, ...added.recipients],
    tokens: [
      ...target.tokens,
      ...added.tokens.map((token) => ({
        ...token,
        collectionId: target.id,
        versionId: target.versionId,
        active: false,
      })),
    ],
    recipientStates: {
      ...target.recipientStates,
      ...Object.fromEntries(
        addedStudentIds.map((id) => [id, "superseded" as const]),
      ),
    },
    pendingRecipientIds: [
      ...(target.pendingRecipientIds ?? []),
      ...addedStudentIds,
    ],
    printStudentOrder: [...oldOrder, ...addedStudentIds],
  };
  const next = {
    ...state,
    collections: state.collections.map((item) =>
      item.id === target.id ? collection : item,
    ),
    events: [
      ...state.events,
      changeEvent(
        "additional_issue_prepare",
        target.id,
        context,
        {
          versionId: target.versionId,
          recipientIds: target.recipients.map((student) => student.id),
        },
        {
          versionId: target.versionId,
          studentIds: addedStudentIds,
          recipients: added.recipients,
        },
      ),
    ],
  };
  return { state: next, collection, addedStudentIds };
}

/** Call only after the selected recipients' print PDF is available; retries cannot reissue tokens. */
export function completeAdditionalIssue(
  state: AppState,
  collectionId: string,
  studentIds: string[],
  context: ChangeContext,
): AppState {
  const target = issuanceTarget(state, collectionId, studentIds, context);
  const selected = new Set(studentIds);
  if (
    state.collections.some(
      (collection) =>
        collection.id !== target.id &&
        collectionSeries(collection) === collectionSeries(target) &&
        collection.recipients.some(
          (student) =>
            selected.has(student.id) &&
            (collection.recipientStates?.[student.id] ?? "required") ===
              "required",
        ),
    )
  )
    throw new Error(
      "追加対象が別版の回収対象に変更されています。受理する版を確認してください。",
    );
  if (studentIds.some((id) => !target.pendingRecipientIds?.includes(id))) {
    const alreadyPublished = state.events.some((event) => {
      if (
        event.action !== "additional_issue_complete" ||
        event.targetId !== collectionId ||
        !event.after
      )
        return false;
      try {
        const value = JSON.parse(event.after) as { studentIds?: string[] };
        return (
          value.studentIds?.length === studentIds.length &&
          value.studentIds.every((id) => selected.has(id))
        );
      } catch {
        return false;
      }
    });
    if (
      alreadyPublished &&
      studentIds.every(
        (id) =>
          target.recipients.some((student) => student.id === id) &&
          !target.pendingRecipientIds?.includes(id),
      )
    )
      return state;
    throw new Error("追加発行を準備した生徒の一覧と一致しません。");
  }
  const collection: Collection = {
    ...target,
    pendingRecipientIds: target.pendingRecipientIds!.filter(
      (id) => !selected.has(id),
    ),
    tokens: target.tokens.map((token) =>
      selected.has(token.studentId) ? { ...token, active: true } : token,
    ),
    recipientStates: {
      ...target.recipientStates,
      ...Object.fromEntries(studentIds.map((id) => [id, "required" as const])),
    },
  };
  return {
    ...state,
    collections: state.collections.map((item) =>
      item.id === collectionId ? collection : item,
    ),
    events: [
      ...state.events,
      changeEvent(
        "additional_issue_complete",
        collectionId,
        context,
        { versionId: target.versionId, studentIds, status: "prepared" },
        { versionId: target.versionId, studentIds, status: "issued" },
      ),
    ],
  };
}
