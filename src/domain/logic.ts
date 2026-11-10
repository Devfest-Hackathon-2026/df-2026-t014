import type {
  AppState,
  AuditEvent,
  Collection,
  DistributionOrder,
  PageToken,
  QrCorner,
  Receipt,
  ScanBatch,
  ScanPage,
  Student,
} from "./types";
import { linkSharedScanSource, prepareSharedScanReview } from "./sharedScan";
import { assertCollectionWritable } from "./lifecycle";

export interface CreateCollectionInput {
  title: string;
  className: string;
  pageCount: number;
  requiredPages: number[];
  qrCorner: QrCorner;
  duplex: boolean;
  order: DistributionOrder;
  reverse: boolean;
  startCorner?: QrCorner;
  dueDate?: string;
  sourceName?: string;
  layoutMode?: Collection["layoutMode"];
  showNames?: boolean;
  versionLabel?: string;
  sourceDocumentId?: string;
}

export interface StudentStatus {
  status: "uncollected" | "partial" | "complete" | "exempt" | "superseded";
  requiredCount: number;
  receivedCount: number;
  requiredPages: number[];
  receivedPages: number[];
  missingPages: number[];
}

export interface RecordBatchOptions {
  replaceReceiptIds?: string[];
  actor?: string;
  reason?: string;
}

function opaqueId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function cloneStudent(student: Student): Student {
  return {
    id: student.id,
    name: student.name,
    number: student.number,
    seat: student.seat ? { ...student.seat } : null,
    ...(student.classroomUserId
      ? { classroomUserId: student.classroomUserId }
      : {}),
    ...(student.enrollment ? { enrollment: student.enrollment } : {}),
  };
}

export function validateStudents(students: Student[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const classroomIds = new Set<string>();
  const numbers = new Set<number>();
  const seats = new Set<string>();
  for (const student of students) {
    if (!student.id || ids.has(student.id))
      errors.push("生徒の内部IDが空、または重複しています。");
    ids.add(student.id);
    if (student.classroomUserId) {
      if (classroomIds.has(student.classroomUserId))
        errors.push("Classroomの生徒IDが重複しています。");
      classroomIds.add(student.classroomUserId);
    }
    if (!student.name.trim()) errors.push("氏名が空の生徒がいます。");
    if (
      !Number.isSafeInteger(student.number) ||
      student.number < 1 ||
      numbers.has(student.number)
    ) {
      errors.push("出席番号は重複しない1以上の整数にしてください。");
    }
    numbers.add(student.number);
    if (student.seat) {
      const { row, col } = student.seat;
      if (
        !Number.isSafeInteger(row) ||
        row < 0 ||
        !Number.isSafeInteger(col) ||
        col < 0
      ) {
        errors.push("座席の行・列が不正です。");
      }
      const key = `${row}:${col}`;
      if (seats.has(key))
        errors.push("同じ座席に複数の生徒が配置されています。");
      seats.add(key);
    }
  }
  return Array.from(new Set(errors));
}

/** Zero-based seat coordinates; unplaced recipients are appended in attendance order. */
export function orderStudents(
  students: Student[],
  order: DistributionOrder,
  reverse = false,
  startCorner?: QrCorner,
): Student[] {
  if (!["row", "column", "snake", "number"].includes(order))
    throw new Error("配布順が不正です。");
  const errors = validateStudents(students);
  if (errors.length) throw new Error(errors.join("\n"));
  if (
    startCorner !== undefined &&
    !["top-left", "top-right", "bottom-left", "bottom-right"].includes(
      startCorner,
    )
  )
    throw new Error("配布の開始位置が不正です。");
  const seats = students.flatMap((student) =>
    student.seat ? [student.seat] : [],
  );
  const minRow =
    startCorner === undefined || !seats.length
      ? 0
      : Math.min(...seats.map((seat) => seat.row));
  const minCol = seats.length ? Math.min(...seats.map((seat) => seat.col)) : 0;
  const maxRow = Math.max(0, ...seats.map((seat) => seat.row));
  const maxCol = Math.max(0, ...seats.map((seat) => seat.col));
  const fromBottom = startCorner?.startsWith("bottom") ?? false;
  const fromRight = startCorner?.endsWith("right") ?? false;
  const rowOf = (student: Student) =>
    fromBottom ? maxRow - student.seat!.row : student.seat!.row - minRow;
  const colOf = (student: Student) =>
    fromRight ? maxCol - student.seat!.col : student.seat!.col - minCol;
  const tieBreak = (a: Student, b: Student) =>
    a.number - b.number || a.id.localeCompare(b.id);
  const ordered = [...students].sort((a, b) => {
    if (order === "number") return tieBreak(a, b);
    if (!a.seat) return !b.seat ? tieBreak(a, b) : 1;
    if (!b.seat) return -1;
    if (order === "column")
      return colOf(a) - colOf(b) || rowOf(a) - rowOf(b) || tieBreak(a, b);
    const rowDifference = rowOf(a) - rowOf(b);
    if (rowDifference) return rowDifference;
    const direction = order === "snake" && rowOf(a) % 2 === 1 ? -1 : 1;
    return direction * (colOf(a) - colOf(b)) || tieBreak(a, b);
  });
  if (!reverse) return ordered;
  if (order === "number") return ordered.reverse();
  return [
    ...ordered.filter((student) => student.seat).reverse(),
    ...ordered.filter((student) => !student.seat),
  ];
}

export function createCollection(
  input: CreateCollectionInput,
  students: Student[],
): Collection {
  if (!input.title.trim() || !input.className.trim())
    throw new Error("配布物名とクラス名を入力してください。");
  if (!students.length) throw new Error("対象生徒がいません。");
  if (!Number.isSafeInteger(input.pageCount) || input.pageCount < 1)
    throw new Error("ページ数が不正です。");
  if (
    !input.requiredPages.length ||
    input.requiredPages.some(
      (page) =>
        !Number.isSafeInteger(page) || page < 1 || page > input.pageCount,
    )
  ) {
    throw new Error(
      "返却必須ページを原稿の範囲内で1ページ以上選んでください。",
    );
  }
  if (new Set(input.requiredPages).size !== input.requiredPages.length)
    throw new Error("返却必須ページが重複しています。");
  if (
    !["top-right", "top-left", "bottom-right", "bottom-left"].includes(
      input.qrCorner,
    )
  )
    throw new Error("QRの配置が不正です。");
  const recipients = orderStudents(
    students,
    input.order,
    input.reverse,
    input.startCorner ?? "top-left",
  ).map(cloneStudent);
  const id = opaqueId();
  const versionId = opaqueId();
  const requiredPages = [...input.requiredPages].sort((a, b) => a - b);
  const usedTokens = new Set<string>();
  const newToken = () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const value = opaqueId();
      if (!usedTokens.has(value)) {
        usedTokens.add(value);
        return value;
      }
    }
    throw new Error("安全なtokenを生成できませんでした。再試行してください。");
  };
  const tokens: PageToken[] = [];
  for (const student of recipients) {
    for (let pageNumber = 1; pageNumber <= input.pageCount; pageNumber += 1) {
      tokens.push({
        token: newToken(),
        collectionId: id,
        versionId,
        studentId: student.id,
        pageNumber,
        kind: "content",
        required: requiredPages.includes(pageNumber),
      });
    }
    if (input.duplex && input.pageCount % 2 === 1) {
      tokens.push({
        token: newToken(),
        collectionId: id,
        versionId,
        studentId: student.id,
        pageNumber: input.pageCount + 1,
        kind: "spacer",
        required: false,
      });
    }
  }
  return {
    id,
    versionId,
    title: input.title.trim(),
    className: input.className.trim(),
    dueDate: input.dueDate ?? "",
    sourceName: input.sourceName ?? "サンプル原稿",
    createdAt: new Date().toISOString(),
    pageCount: input.pageCount,
    requiredPages,
    qrCorner: input.qrCorner,
    duplex: input.duplex,
    order: input.order,
    reverse: input.reverse,
    startCorner: input.startCorner ?? "top-left",
    recipients,
    tokens,
    status: "ready",
    logicalCollectionId: id,
    revision: 1,
    layoutMode: input.layoutMode ?? "reserved-corner",
    showNames: input.showNames ?? true,
    ...(input.versionLabel ? { versionLabel: input.versionLabel } : {}),
    ...(input.sourceDocumentId
      ? { sourceDocumentId: input.sourceDocumentId }
      : {}),
    recipientStates: Object.fromEntries(
      recipients.map((student) => [student.id, "required" as const]),
    ),
  };
}

export function getStudentStatus(
  collection: Collection,
  studentId: string,
  receipts: Receipt[],
): StudentStatus {
  const requiredPages = [...new Set(collection.requiredPages)].sort(
    (a, b) => a - b,
  );
  const receivedPages = [
    ...new Set(
      receipts
        .filter(
          (receipt) =>
            receipt.collectionId === collection.id &&
            receipt.versionId === collection.versionId &&
            receipt.studentId === studentId &&
            requiredPages.includes(receipt.pageNumber),
        )
        .map((receipt) => receipt.pageNumber),
    ),
  ].sort((a, b) => a - b);
  const missingPages = requiredPages.filter(
    (page) => !receivedPages.includes(page),
  );
  const requirement = collection.recipientStates?.[studentId];
  return {
    status:
      requirement === "exempt" || requirement === "superseded"
        ? requirement
        : receivedPages.length === 0
          ? "uncollected"
          : missingPages.length === 0
            ? "complete"
            : "partial",
    requiredCount: requiredPages.length,
    receivedCount: receivedPages.length,
    requiredPages,
    receivedPages,
    missingPages:
      requirement === "exempt" || requirement === "superseded"
        ? []
        : missingPages,
  };
}

const receiptKey = (
  receipt: Pick<
    Receipt,
    "collectionId" | "versionId" | "studentId" | "pageNumber"
  >,
) =>
  JSON.stringify([
    receipt.collectionId,
    receipt.versionId,
    receipt.studentId,
    receipt.pageNumber,
  ]);

function cleanPage(page: ScanPage): ScanPage {
  const result: ScanPage = {
    id: page.id,
    sourcePage: page.sourcePage,
    status: page.status,
    resolution: page.resolution,
  };
  if (page.token !== undefined) result.token = page.token;
  if (page.studentId !== undefined) result.studentId = page.studentId;
  if (page.pageNumber !== undefined) result.pageNumber = page.pageNumber;
  if (page.collectionId !== undefined) result.collectionId = page.collectionId;
  if (page.versionId !== undefined) result.versionId = page.versionId;
  if (page.reason !== undefined) result.reason = page.reason;
  if (page.manual !== undefined) result.manual = page.manual;
  if (page.reviewReason !== undefined) result.reviewReason = page.reviewReason;
  if (page.reviewedBy !== undefined) result.reviewedBy = page.reviewedBy;
  if (page.exclusionScope !== undefined)
    result.exclusionScope = page.exclusionScope;
  if (page.handledBy !== undefined) result.handledBy = { ...page.handledBy };
  return result;
}

function resolvePage(
  collection: Collection,
  page: ScanPage,
): Pick<
  Receipt,
  "collectionId" | "versionId" | "studentId" | "pageNumber" | "token" | "method"
> | null {
  if (
    page.handledBy ||
    page.resolution !== "accepted" ||
    !["matched", "duplicate"].includes(page.status)
  )
    return null;
  if (page.collectionId !== undefined && page.collectionId !== collection.id)
    return null;
  if (page.versionId !== undefined && page.versionId !== collection.versionId)
    return null;
  const token = collection.tokens.find(
    (candidate) => candidate.token === page.token,
  );
  const assignedStudent = page.manual ? page.studentId : token?.studentId;
  if (
    token?.active === false ||
    (assignedStudent &&
      collection.recipientStates?.[assignedStudent] === "superseded")
  )
    return null;
  if (page.manual) {
    const issuedTarget = collection.tokens.find(
      (candidate) =>
        candidate.studentId === page.studentId &&
        candidate.pageNumber === page.pageNumber &&
        candidate.kind === "content",
    );
    if (!issuedTarget || issuedTarget.active === false) return null;
    if (
      !page.studentId ||
      !collection.recipients.some((student) => student.id === page.studentId)
    )
      return null;
    if (
      !Number.isSafeInteger(page.pageNumber) ||
      (page.pageNumber ?? 0) < 1 ||
      (page.pageNumber ?? 0) > collection.pageCount
    )
      return null;
    return {
      collectionId: collection.id,
      versionId: collection.versionId,
      studentId: page.studentId,
      pageNumber: page.pageNumber!,
      method: "manual",
      ...(token &&
      token.studentId === page.studentId &&
      token.pageNumber === page.pageNumber &&
      token.kind === "content"
        ? { token: token.token }
        : {}),
    };
  }
  if (
    !token ||
    token.kind !== "content" ||
    token.collectionId !== collection.id ||
    token.versionId !== collection.versionId
  )
    return null;
  if (
    (page.studentId !== undefined && page.studentId !== token.studentId) ||
    (page.pageNumber !== undefined && page.pageNumber !== token.pageNumber)
  )
    return null;
  if (!collection.recipients.some((student) => student.id === token.studentId))
    return null;
  return {
    collectionId: token.collectionId,
    versionId: token.versionId,
    studentId: token.studentId,
    pageNumber: token.pageNumber,
    token: token.token,
    method: "qr",
  };
}

function receiptHistory(receipt: Receipt) {
  return {
    id: receipt.id,
    collectionId: receipt.collectionId,
    versionId: receipt.versionId,
    studentId: receipt.studentId,
    pageNumber: receipt.pageNumber,
    batchId: receipt.batchId,
    sourcePage: receipt.sourcePage,
    recordedAt: receipt.recordedAt,
    method: receipt.method,
  };
}

/** Records metadata only. Each accepted source page and each issued logical page have at most one current receipt. */
export function recordBatch(
  state: AppState,
  batch: ScanBatch,
  pages: ScanPage[],
  options: RecordBatchOptions = {},
): AppState {
  const collection = state.collections.find(
    (item) => item.id === batch.collectionId,
  );
  if (!collection) throw new Error("対象の配布物が見つかりません。");
  assertCollectionWritable(state, collection.id);
  if (
    collection.status === "closed" ||
    collection.status === "draft" ||
    collection.status === "generating"
  )
    throw new Error(
      collection.status === "closed"
        ? "終了した配布物は回収受付中ではありません。再開してから回収を記録してください。"
        : "この配布物は回収受付中ではありません。発行状態を確認してください。",
    );
  if (
    !batch.id ||
    !batch.hash ||
    !Number.isSafeInteger(batch.pageCount) ||
    batch.pageCount < 1
  )
    throw new Error("スキャン情報が不正です。");
  const linked = linkSharedScanSource(state, batch);
  state = linked.state;
  batch = linked.batch;
  pages = prepareSharedScanReview(state, pages, {
    hash: batch.hash,
    pageCount: batch.pageCount,
    collectionId: batch.collectionId,
  }).pages;
  const positions = new Set<number>();
  for (const page of pages) {
    if (
      !Number.isSafeInteger(page.sourcePage) ||
      page.sourcePage < 1 ||
      page.sourcePage > batch.pageCount ||
      positions.has(page.sourcePage)
    ) {
      throw new Error("スキャンのページ位置が不正、または重複しています。");
    }
    positions.add(page.sourcePage);
  }
  const previousBatch = state.batches.find(
    (item) =>
      item.collectionId === batch.collectionId && item.hash === batch.hash,
  );
  if (previousBatch && previousBatch.pageCount !== batch.pageCount)
    throw new Error("同じスキャンのページ数が一致しません。");
  if (!previousBatch && state.batches.some((item) => item.id === batch.id))
    throw new Error("スキャンIDが別の入力と重複しています。");
  const batchId = previousBatch?.id ?? batch.id;
  const replacements = new Set(options.replaceReceiptIds ?? []);
  const replacementReceipts = state.receipts.filter((receipt) =>
    replacements.has(receipt.id),
  );
  if (replacementReceipts.length !== replacements.size)
    throw new Error("差し替え対象の記録が見つかりません。再読込してください。");
  const resolved = new Map(
    pages.map((page) => [page.sourcePage, resolvePage(collection, page)]),
  );
  for (const previous of replacementReceipts) {
    if (
      !Array.from(resolved.values()).some(
        (candidate) =>
          candidate && receiptKey(candidate) === receiptKey(previous),
      )
    ) {
      throw new Error("差し替え対象の版・生徒・ページが一致しません。");
    }
  }

  const now = new Date().toISOString();
  let receipts = [...state.receipts];
  const events: AuditEvent[] = [];
  const replacedSources = new Map<string, Set<number>>();
  const savedPages = new Map(
    (previousBatch?.pages ?? []).map((page) => [
      page.sourcePage,
      cleanPage(page),
    ]),
  );
  let addedCount = 0;
  let replacedCount = 0;
  for (const incoming of pages) {
    let page = cleanPage(incoming);
    const previousPage = savedPages.get(page.sourcePage);
    if (previousPage) page.id = previousPage.id;
    const candidate = resolved.get(page.sourcePage);
    const existingSource = receipts.find(
      (receipt) =>
        receipt.batchId === batchId && receipt.sourcePage === page.sourcePage,
    );
    if (
      existingSource &&
      (!candidate || receiptKey(existingSource) !== receiptKey(candidate))
    ) {
      // An already registered page cannot silently be reassigned to a different person.
      if (previousPage) savedPages.set(page.sourcePage, previousPage);
      continue;
    }
    if (!candidate) {
      if (page.resolution === "accepted")
        page = {
          ...page,
          resolution: "pending",
          reason: "割り当てと配布物の版・生徒・ページを確認してください。",
        };
      savedPages.set(page.sourcePage, page);
      if (
        !page.handledBy &&
        page.status !== "spacer" &&
        page.resolution === "ignored" &&
        previousPage?.resolution !== "ignored"
      )
        events.push({
          id: opaqueId(),
          at: now,
          action: "ignore_page",
          targetId: `${batchId}:${page.sourcePage}`,
          actor: page.reviewedBy ?? options.actor ?? "local-teacher",
          reason:
            page.reviewReason ?? options.reason ?? "教師が対象外として指定",
          before: previousPage
            ? JSON.stringify(cleanPage(previousPage))
            : undefined,
          after: JSON.stringify(page),
          detail: `スキャン ${page.sourcePage} ページを対象外にしました。`,
        });
      continue;
    }
    const existing = receipts.find(
      (receipt) => receiptKey(receipt) === receiptKey(candidate),
    );
    if (
      existing?.batchId === batchId &&
      existing.sourcePage === page.sourcePage
    ) {
      savedPages.set(
        page.sourcePage,
        previousPage ?? { ...page, status: "matched", resolution: "accepted" },
      );
      continue;
    }
    if (existing && !replacements.has(existing.id)) {
      savedPages.set(page.sourcePage, {
        ...page,
        status: "duplicate",
        resolution: "pending",
        reason:
          "この生徒・版・ページは記録済みです。差し替える場合は旧記録を確認してください。",
      });
      continue;
    }
    if (page.status === "duplicate" && !existing) {
      savedPages.set(page.sourcePage, {
        ...page,
        resolution: "pending",
        reason: "重複先を再確認してください。",
      });
      continue;
    }
    if (candidate.method === "manual" || existing) {
      const reviewActor = page.reviewedBy ?? options.actor;
      const reviewReason = page.reviewReason ?? options.reason;
      if (!reviewActor?.trim() || !reviewReason?.trim())
        throw new Error(
          "手動照合・差し替えには操作した人と確認理由を記録してください。",
        );
    }
    const receipt: Receipt = {
      ...candidate,
      id: opaqueId(),
      batchId,
      sourcePage: page.sourcePage,
      recordedAt: now,
      actor: page.reviewedBy ?? options.actor ?? "local-teacher",
    };
    if (existing) {
      receipts = receipts.filter((item) => item.id !== existing.id);
      replacements.delete(existing.id);
      const positionsForBatch =
        replacedSources.get(existing.batchId) ?? new Set<number>();
      positionsForBatch.add(existing.sourcePage);
      replacedSources.set(existing.batchId, positionsForBatch);
      events.push({
        id: opaqueId(),
        at: now,
        action: "replace_receipt",
        actor: options.actor ?? "local-teacher",
        reason: page.reviewReason ?? options.reason ?? "教師が差し替えを確認",
        targetId: receipt.id,
        detail: JSON.stringify({
          previous: receiptHistory(existing),
          next: receiptHistory(receipt),
        }),
      });
      replacedCount += 1;
    } else {
      addedCount += 1;
    }
    receipts.push(receipt);
    page = {
      ...page,
      status: "matched",
      resolution: "accepted",
      collectionId: candidate.collectionId,
      versionId: candidate.versionId,
      studentId: candidate.studentId,
      pageNumber: candidate.pageNumber,
    };
    savedPages.set(page.sourcePage, page);
    if (candidate.method === "manual")
      events.push({
        id: opaqueId(),
        at: now,
        action: "manual_assignment",
        actor: page.reviewedBy ?? options.actor ?? "local-teacher",
        reason: page.reviewReason ?? options.reason ?? "教師が紙を確認して照合",
        targetId: receipt.id,
        detail: `スキャン ${batchId} の ${page.sourcePage} ページを、生徒 ${candidate.studentId}・版 ${candidate.versionId}・${candidate.pageNumber} ページへ手動割り当てしました。`,
      });
  }
  // A replacement from the same PDF also marks the previous source page as historical.
  for (const sourcePage of replacedSources.get(batchId) ?? []) {
    const previous = savedPages.get(sourcePage);
    if (previous)
      savedPages.set(sourcePage, {
        ...previous,
        resolution: "ignored",
        exclusionScope: "source",
        reason: "後の取込で差し替え済みです。履歴として保持しています。",
      });
  }
  const nextBatch: ScanBatch = {
    id: batchId,
    sourceId: batch.sourceId,
    hash: batch.hash,
    fileName: previousBatch?.fileName ?? batch.fileName,
    pageCount: batch.pageCount,
    collectionId: batch.collectionId,
    createdAt: previousBatch?.createdAt ?? batch.createdAt,
    pages: Array.from(savedPages.values()).sort(
      (a, b) => a.sourcePage - b.sourcePage,
    ),
    recordedAt: previousBatch?.recordedAt ?? now,
    ...(previousBatch?.sourceDriveFileId
      ? { sourceDriveFileId: previousBatch.sourceDriveFileId }
      : {}),
    ...(previousBatch?.storageMode
      ? { storageMode: previousBatch.storageMode }
      : {}),
  };
  const changed =
    addedCount > 0 ||
    replacedCount > 0 ||
    !previousBatch ||
    JSON.stringify(previousBatch) !== JSON.stringify(nextBatch);
  if (!changed) return state;
  nextBatch.recordedAt = now;
  const batches = state.batches
    .filter((item) => item.id !== batchId)
    .map((item) => {
      const replaced = replacedSources.get(item.id);
      return replaced
        ? {
            ...item,
            pages: item.pages.map((page) =>
              replaced.has(page.sourcePage)
                ? {
                    ...cleanPage(page),
                    resolution: "ignored" as const,
                    exclusionScope: "source" as const,
                    reason:
                      "後の取込で差し替え済みです。履歴として保持しています。",
                  }
                : cleanPage(page),
            ),
          }
        : item;
    });
  batches.push(nextBatch);
  events.push({
    id: opaqueId(),
    at: now,
    action: "record_batch",
    detail: `「${collection.title}」: ${addedCount} ページを新規記録、${replacedCount} ページを差し替え。未確認 ${nextBatch.pages.filter((page) => page.resolution === "pending").length} ページ。`,
  });
  return {
    ...state,
    receipts,
    batches,
    collections:
      addedCount || replacedCount
        ? state.collections.map((item) =>
            item.id === collection.id
              ? { ...item, status: "collecting" as const }
              : item,
          )
        : state.collections,
    events: [...state.events, ...events],
  };
}

function csvCell(value: string | number): string {
  let text = String(value);
  // Prevent spreadsheet formula execution even after leading spaces/control characters.
  if (/^[\s\u0000-\u001f]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text))
    text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function toCsv(state: AppState, collection: Collection): string {
  const rows: Array<Array<string | number>> = [
    [
      "出席番号",
      "氏名",
      "回収状態",
      "必要ページ数",
      "回収ページ数",
      "不足ページ",
      "記録日時",
    ],
  ];
  const labels = {
    uncollected: "未回収",
    partial: "一部不足",
    complete: "回収済み",
    exempt: "提出免除",
    superseded: "旧版・対象外",
  };
  for (const student of orderStudents(collection.recipients, "number")) {
    const status = getStudentStatus(collection, student.id, state.receipts);
    const recordedAt =
      state.receipts
        .filter(
          (receipt) =>
            receipt.collectionId === collection.id &&
            receipt.versionId === collection.versionId &&
            receipt.studentId === student.id,
        )
        .map((receipt) => receipt.recordedAt)
        .sort()
        .at(-1) ?? "";
    rows.push([
      student.number,
      student.name,
      labels[status.status],
      status.requiredCount,
      status.receivedCount,
      status.missingPages.join("・"),
      recordedAt,
    ]);
  }
  return (
    "\uFEFF" +
    rows.map((row) => row.map(csvCell).join(",")).join("\r\n") +
    "\r\n"
  );
}
