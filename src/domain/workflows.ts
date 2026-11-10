import {
  createCollection,
  orderStudents,
  validateStudents,
  type CreateCollectionInput,
} from "./logic";
import type {
  AppState,
  AuditEvent,
  ChangeContext,
  Collection,
  CollectionStatus,
  DistributionOrder,
  SeatLayout,
  Student,
  QrCorner,
} from "./types";

export function requireChangeContext(context: ChangeContext): void {
  if (!context.actor.trim() || !context.reason.trim())
    throw new Error("操作した人と変更理由を記録してください。");
}

export function changeEvent(
  action: string,
  targetId: string,
  context: ChangeContext,
  before: unknown,
  after: unknown,
): AuditEvent {
  requireChangeContext(context);
  return {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    action,
    targetId,
    actor: context.actor.trim(),
    reason: context.reason.trim(),
    before: JSON.stringify(before),
    after: JSON.stringify(after),
    detail: context.reason.trim(),
  };
}

export function collectionSeries(collection: Collection): string {
  return collection.logicalCollectionId ?? collection.id;
}

export function setCollectionStatus(
  state: AppState,
  collectionId: string,
  status: CollectionStatus,
  context: ChangeContext = {
    actor: "local-teacher",
    reason: "発行・回収状態を変更",
  },
): AppState {
  const target = state.collections.find((item) => item.id === collectionId);
  if (!target) throw new Error("対象の配布物が見つかりません。");
  if ((target.archivedAt || target.deletedAt) && status !== "closed")
    throw new Error("保管・削除済みの配布物は状態を変更できません。");
  if (
    status !== "closed" &&
    state.cleanupOperations?.some(
      (operation) =>
        operation.status !== "complete" &&
        operation.collectionIds.includes(collectionId),
    )
  )
    throw new Error("整理・削除処理が未完了の配布物は再開できません。");
  const current = target.status ?? "ready";
  const active =
    status === "draft" || status === "generating"
      ? false
      : status === "ready" || status === "collecting"
        ? true
        : undefined;
  const publishRevision = status === "ready" && target.pendingRevision === true;
  if (
    current === status &&
    !publishRevision &&
    (active === undefined ||
      target.tokens.every((token) => token.active === active))
  )
    return state;
  const transitions: Record<CollectionStatus, CollectionStatus[]> = {
    draft: ["generating"],
    generating: ["ready", "draft"],
    ready: ["generating", "collecting", "closed"],
    collecting: ["closed", "ready"],
    closed: ["ready", "collecting"],
  };
  if (current !== status && !transitions[current].includes(status))
    throw new Error(`発行状態を ${current} から ${status} へ変更できません。`);
  const targetIds = new Set(target.recipients.map((student) => student.id));
  const collections = state.collections.map((item) => {
    if (item.id === target.id)
      return {
        ...item,
        status,
        tokens:
          active === undefined
            ? item.tokens
            : item.tokens.map((token) => ({
                ...token,
                active:
                  active &&
                  !item.pendingRecipientIds?.includes(token.studentId),
              })),
        ...(publishRevision
          ? {
              pendingRevision: false,
              recipientStates: Object.fromEntries(
                item.recipients.map((student) => [
                  student.id,
                  item.recipientStates?.[student.id] === "exempt"
                    ? ("exempt" as const)
                    : ("required" as const),
                ]),
              ),
            }
          : {}),
      };
    if (!publishRevision || collectionSeries(item) !== collectionSeries(target))
      return item;
    return {
      ...item,
      recipientStates: Object.fromEntries(
        item.recipients.map((student) => [
          student.id,
          targetIds.has(student.id) &&
          (item.recipientStates?.[student.id] ?? "required") === "required"
            ? ("superseded" as const)
            : (item.recipientStates?.[student.id] ?? "required"),
        ]),
      ),
    };
  });
  return {
    ...state,
    collections,
    events: [
      ...state.events,
      changeEvent(
        publishRevision ? "publish_revision" : "collection_status",
        target.id,
        context,
        publishRevision
          ? state.collections
              .filter(
                (item) => collectionSeries(item) === collectionSeries(target),
              )
              .map((item) => ({
                id: item.id,
                status: item.status,
                recipientStates: item.recipientStates,
              }))
          : current,
        publishRevision
          ? collections
              .filter(
                (item) => collectionSeries(item) === collectionSeries(target),
              )
              .map((item) => ({
                id: item.id,
                status: item.status,
                recipientStates: item.recipientStates,
              }))
          : status,
      ),
    ],
  };
}

export function createRevision(
  state: AppState,
  collectionId: string,
  patch: Partial<CreateCollectionInput> & { students?: Student[] },
  context: ChangeContext,
): { state: AppState; collection: Collection } {
  requireChangeContext(context);
  const previous = state.collections.find((item) => item.id === collectionId);
  if (!previous) throw new Error("改訂元の配布物が見つかりません。");
  if (
    previous.archivedAt ||
    previous.deletedAt ||
    previous.pendingRecipientIds?.length
  )
    throw new Error(
      "保管・削除済み、または追加発行中の配布物は改訂できません。",
    );
  if (
    state.cleanupOperations?.some(
      (operation) =>
        operation.status !== "complete" &&
        operation.collectionIds.includes(collectionId),
    )
  )
    throw new Error("整理・削除処理が未完了の配布物は改訂できません。");
  const series = collectionSeries(previous);
  const revision =
    Math.max(
      ...state.collections
        .filter((item) => collectionSeries(item) === series)
        .map((item) => item.revision ?? 1),
    ) + 1;
  const collection = createCollection(
    {
      ...previous,
      ...patch,
      versionLabel: patch.versionLabel ?? `v${revision}`,
    },
    patch.students ?? previous.recipients,
  );
  collection.logicalCollectionId = series;
  collection.revision = revision;
  collection.status = "draft";
  collection.pendingRevision = true;
  collection.tokens = collection.tokens.map((token) => ({
    ...token,
    active: false,
  }));
  collection.createdBy = context.actor;
  collection.recipientStates = Object.fromEntries(
    collection.recipients.map((student) => [
      student.id,
      previous.recipientStates?.[student.id] === "exempt"
        ? ("exempt" as const)
        : ("superseded" as const),
    ]),
  );
  return {
    collection,
    state: {
      ...state,
      collections: [collection, ...state.collections],
      events: [
        ...state.events,
        changeEvent(
          "create_revision",
          collection.id,
          context,
          { collectionId: previous.id, versionId: previous.versionId },
          {
            collectionId: collection.id,
            versionId: collection.versionId,
            revision,
          },
        ),
      ],
    },
  };
}

export function setRecipientRequirement(
  state: AppState,
  collectionId: string,
  studentId: string,
  requirement: "required" | "exempt",
  context: ChangeContext,
): AppState {
  requireChangeContext(context);
  const target = state.collections.find((item) => item.id === collectionId);
  if (!target?.recipients.some((student) => student.id === studentId))
    throw new Error("対象生徒がこの版に含まれていません。");
  if (
    target.archivedAt ||
    target.deletedAt ||
    state.cleanupOperations?.some(
      (operation) =>
        operation.status !== "complete" &&
        operation.collectionIds.includes(collectionId),
    )
  )
    throw new Error(
      "保管済み・削除中・削除済みの配布物では受理する版・免除を変更できません。整理・削除の履歴を確認してください。",
    );
  if (target.status === "draft" || target.status === "generating")
    throw new Error("発行が完了してから受理する版・免除を変更してください。");
  if (target.pendingRecipientIds?.includes(studentId))
    throw new Error("追加発行が完了してから対象の生徒を変更してください。");
  const before = state.collections
    .filter((item) => collectionSeries(item) === collectionSeries(target))
    .map((item) => ({
      id: item.id,
      requirement: item.recipientStates?.[studentId] ?? "required",
    }));
  const collections = state.collections.map((item) => {
    if (
      collectionSeries(item) !== collectionSeries(target) ||
      !item.recipients.some((student) => student.id === studentId)
    )
      return item;
    const current = item.recipientStates?.[studentId] ?? "required";
    return {
      ...item,
      recipientStates: {
        ...item.recipientStates,
        [studentId]:
          item.id === target.id
            ? requirement
            : current === "required"
              ? ("superseded" as const)
              : current,
      },
    };
  });
  return {
    ...state,
    collections,
    events: [
      ...state.events,
      changeEvent(
        "recipient_requirement",
        `${collectionId}:${studentId}`,
        context,
        before,
        { collectionId, requirement },
      ),
    ],
  };
}

export interface SeatLayoutInput {
  rows: number;
  cols: number;
  blockedCells?: Array<{ row: number; col: number }>;
  name?: string;
  order?: DistributionOrder;
  reverse?: boolean;
  startCorner?: QrCorner;
}

export function saveSeatLayout(
  state: AppState,
  input: SeatLayoutInput,
  context: ChangeContext,
): AppState {
  requireChangeContext(context);
  if (
    !Number.isSafeInteger(input.rows) ||
    !Number.isSafeInteger(input.cols) ||
    input.rows < 1 ||
    input.cols < 1 ||
    input.rows > 100 ||
    input.cols > 100
  )
    throw new Error("座席表の行・列は1〜100の整数にしてください。");
  const errors = validateStudents(state.students);
  if (errors.length) throw new Error(errors.join("\n"));
  orderStudents(
    state.students,
    input.order ?? state.settings?.defaultOrder ?? "snake",
    input.reverse ?? false,
    input.startCorner ?? state.settings?.defaultStartCorner ?? "top-left",
  );
  const inBounds = (seat: { row: number; col: number }) =>
    Number.isSafeInteger(seat.row) &&
    Number.isSafeInteger(seat.col) &&
    seat.row >= 0 &&
    seat.row < input.rows &&
    seat.col >= 0 &&
    seat.col < input.cols;
  const blocked = input.blockedCells ?? [];
  if (
    blocked.some((seat) => !inBounds(seat)) ||
    new Set(blocked.map((seat) => `${seat.row}:${seat.col}`)).size !==
      blocked.length
  )
    throw new Error("通路・利用しない席の設定が不正です。");
  if (
    state.students.some(
      (student) =>
        student.seat &&
        (!inBounds(student.seat) ||
          blocked.some(
            (seat) =>
              seat.row === student.seat!.row && seat.col === student.seat!.col,
          )),
    )
  )
    throw new Error("生徒の席が範囲外、または通路に置かれています。");
  const layout: SeatLayout = {
    id: crypto.randomUUID(),
    name:
      input.name?.trim() || `座席表 ${(state.seatLayouts?.length ?? 0) + 1}`,
    createdAt: new Date().toISOString(),
    rows: input.rows,
    cols: input.cols,
    blockedCells: structuredClone(blocked),
    students: structuredClone(state.students),
    order: input.order ?? state.settings?.defaultOrder ?? "snake",
    reverse: input.reverse ?? false,
    startCorner:
      input.startCorner ?? state.settings?.defaultStartCorner ?? "top-left",
  };
  return {
    ...state,
    seatLayouts: [...(state.seatLayouts ?? []), layout],
    settings: {
      ...state.settings,
      activeSeatLayoutId: layout.id,
      defaultOrder: layout.order,
      defaultReverse: layout.reverse,
      defaultStartCorner: layout.startCorner,
    },
    events: [
      ...state.events,
      changeEvent(
        "save_seat_layout",
        layout.id,
        context,
        state.settings?.activeSeatLayoutId,
        { id: layout.id, rows: layout.rows, cols: layout.cols },
      ),
    ],
  };
}

export function restoreSeatLayout(
  state: AppState,
  layoutId: string,
  context: ChangeContext,
): AppState {
  const layout = state.seatLayouts?.find((item) => item.id === layoutId);
  if (!layout) throw new Error("座席表の履歴が見つかりません。");
  const students = state.students.map((student) => ({
    ...student,
    seat:
      student.enrollment === "withdrawn"
        ? null
        : structuredClone(
            layout.students.find((old) => old.id === student.id)?.seat ?? null,
          ),
  }));
  return saveSeatLayout(
    { ...state, students },
    { ...layout, name: `${layout.name}から復元` },
    context,
  );
}
