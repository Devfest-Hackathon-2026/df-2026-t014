import { createInitialState } from "./seed";
import { validateStudents } from "./logic";
import { validateSharedScanReferences } from "./sharedScan";
import type {
  AppState,
  AuditEvent,
  Collection,
  DistributionOrder,
  PageToken,
  QrCorner,
  Receipt,
  ScanBatch,
  ScanSource,
  ScanPage,
  Student,
  SaveOperation,
  DriveArtifact,
  SeatLayout,
  ClassSettings,
  SavedClass,
  CleanupOperation,
  CleanupFile,
} from "./types";

export const STORAGE_KEY = "paperflow-demo-state-v1";
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): StorageLike | undefined {
  try {
    return typeof window !== "undefined" ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid object");
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid string");
  return value;
}
function integer(value: unknown, minimum = 0): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  )
    throw new Error("Invalid integer");
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Invalid boolean");
  return value;
}
function array<T>(value: unknown, parser: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error("Invalid array");
  return value.map(parser);
}
function enumValue<const T extends string>(
  value: unknown,
  allowed: readonly T[],
): T {
  const result = string(value);
  if (!allowed.includes(result as T)) throw new Error("Invalid value");
  return result as T;
}
function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : string(value);
}

function student(value: unknown): Student {
  const item = object(value);
  const seat = item.seat === null ? null : object(item.seat);
  return {
    id: string(item.id),
    name: string(item.name),
    number: integer(item.number, 1),
    seat: seat ? { row: integer(seat.row), col: integer(seat.col) } : null,
    ...(item.classroomUserId !== undefined
      ? { classroomUserId: string(item.classroomUserId) }
      : {}),
    ...(item.enrollment !== undefined
      ? { enrollment: enumValue(item.enrollment, ["active", "withdrawn"]) }
      : {}),
  };
}

function pageToken(value: unknown): PageToken {
  const item = object(value);
  return {
    token: string(item.token),
    studentId: string(item.studentId),
    collectionId: string(item.collectionId),
    versionId: string(item.versionId),
    pageNumber: integer(item.pageNumber, 1),
    kind: enumValue(item.kind, ["content", "spacer"]),
    required: boolean(item.required),
    ...(item.active !== undefined ? { active: boolean(item.active) } : {}),
  };
}

function collection(value: unknown): Collection {
  const item = object(value);
  const result: Collection = {
    id: string(item.id),
    title: string(item.title),
    dueDate: string(item.dueDate),
    className: string(item.className),
    versionId: string(item.versionId),
    createdAt: string(item.createdAt),
    pageCount: integer(item.pageCount, 1),
    requiredPages: array(item.requiredPages, (page) => integer(page, 1)),
    qrCorner: enumValue<QrCorner>(item.qrCorner, [
      "top-right",
      "top-left",
      "bottom-right",
      "bottom-left",
    ]),
    duplex: boolean(item.duplex),
    order: enumValue<DistributionOrder>(item.order, [
      "row",
      "column",
      "snake",
      "number",
    ]),
    reverse: boolean(item.reverse),
    sourceName: string(item.sourceName),
    tokens: array(item.tokens, pageToken),
    recipients: array(item.recipients, student),
  };
  for (const key of [
    "logicalCollectionId",
    "sourceDocumentId",
    "sourceHash",
    "sourceDriveFileId",
    "printDriveFileId",
    "folderId",
    "createdBy",
    "versionLabel",
    "seatLayoutId",
    "archivedAt",
    "deletedAt",
  ] as const) {
    if (item[key] !== undefined) result[key] = string(item[key]);
  }
  if (item.status !== undefined)
    result.status = enumValue(item.status, [
      "draft",
      "generating",
      "ready",
      "collecting",
      "closed",
    ]);
  if (item.revision !== undefined) result.revision = integer(item.revision, 1);
  if (item.pendingRevision !== undefined)
    result.pendingRevision = boolean(item.pendingRevision);
  if (item.pendingRecipientIds !== undefined)
    result.pendingRecipientIds = array(item.pendingRecipientIds, string);
  if (item.printStudentOrder !== undefined)
    result.printStudentOrder = array(item.printStudentOrder, string);
  if (item.layoutMode !== undefined)
    result.layoutMode = enumValue(item.layoutMode, [
      "reserved-corner",
      "management-band",
    ]);
  if (item.showNames !== undefined) result.showNames = boolean(item.showNames);
  if (item.startCorner !== undefined)
    result.startCorner = enumValue(item.startCorner, [
      "top-left",
      "top-right",
      "bottom-left",
      "bottom-right",
    ]);
  if (item.recipientStates !== undefined)
    result.recipientStates = Object.fromEntries(
      Object.entries(object(item.recipientStates)).map(([id, value]) => {
        if (!result.recipients.some((student) => student.id === id))
          throw new Error("Unknown recipient");
        return [id, enumValue(value, ["required", "exempt", "superseded"])];
      }),
    );
  if (
    !result.id ||
    !result.versionId ||
    !result.requiredPages.length ||
    validateStudents(result.recipients).length ||
    !result.recipients.length ||
    result.requiredPages.some((page) => page > result.pageCount) ||
    new Set(result.requiredPages).size !== result.requiredPages.length
  )
    throw new Error("Invalid collection");
  const studentIds = new Set(result.recipients.map((person) => person.id));
  if (
    result.printStudentOrder &&
    (result.printStudentOrder.length !== studentIds.size ||
      new Set(result.printStudentOrder).size !== studentIds.size ||
      result.printStudentOrder.some((id) => !studentIds.has(id)))
  )
    throw new Error("Invalid print order");
  if (
    result.pendingRecipientIds &&
    (new Set(result.pendingRecipientIds).size !==
      result.pendingRecipientIds.length ||
      result.pendingRecipientIds.some(
        (id) =>
          !studentIds.has(id) ||
          result.recipientStates?.[id] !== "superseded" ||
          result.tokens.some(
            (token) => token.studentId === id && token.active !== false,
          ),
      ))
  )
    throw new Error("Invalid pending recipient");
  const tokens = new Set<string>();
  const issuedPages = new Set<string>();
  for (const token of result.tokens) {
    if (
      !token.token ||
      tokens.has(token.token) ||
      token.collectionId !== result.id ||
      token.versionId !== result.versionId ||
      !studentIds.has(token.studentId)
    )
      throw new Error("Invalid token mapping");
    if (
      token.kind === "content" &&
      (token.pageNumber > result.pageCount ||
        token.required !== result.requiredPages.includes(token.pageNumber))
    )
      throw new Error("Invalid page mapping");
    if (
      token.kind === "spacer" &&
      (token.required ||
        !result.duplex ||
        result.pageCount % 2 !== 1 ||
        token.pageNumber !== result.pageCount + 1)
    )
      throw new Error("Invalid spacer");
    tokens.add(token.token);
    const issuedPage = `${token.studentId}:${token.pageNumber}`;
    if (issuedPages.has(issuedPage)) throw new Error("Duplicate issued page");
    issuedPages.add(issuedPage);
  }
  for (const person of result.recipients) {
    for (let page = 1; page <= result.pageCount; page++)
      if (!issuedPages.has(`${person.id}:${page}`))
        throw new Error("Missing issued page");
    if (
      result.duplex &&
      result.pageCount % 2 &&
      !issuedPages.has(`${person.id}:${result.pageCount + 1}`)
    )
      throw new Error("Missing duplex spacer");
  }
  return result;
}

function receipt(value: unknown): Receipt {
  const item = object(value);
  return {
    id: string(item.id),
    collectionId: string(item.collectionId),
    versionId: string(item.versionId),
    studentId: string(item.studentId),
    pageNumber: integer(item.pageNumber, 1),
    token: optionalString(item.token),
    batchId: string(item.batchId),
    sourcePage: integer(item.sourcePage, 1),
    recordedAt: string(item.recordedAt),
    method: enumValue(item.method, ["qr", "manual"]),
    ...(item.actor !== undefined ? { actor: string(item.actor) } : {}),
  };
}

function scanPage(value: unknown): ScanPage {
  const item = object(value);
  const result: ScanPage = {
    id: string(item.id),
    sourcePage: integer(item.sourcePage, 1),
    status: enumValue(item.status, [
      "matched",
      "unreadable",
      "unknown",
      "duplicate",
      "foreign",
      "spacer",
      "blank",
    ]),
    resolution: enumValue(item.resolution, ["accepted", "ignored", "pending"]),
  };
  for (const key of [
    "token",
    "studentId",
    "collectionId",
    "versionId",
    "reason",
    "reviewReason",
    "reviewedBy",
  ] as const) {
    const parsed = optionalString(item[key]);
    if (parsed !== undefined) result[key] = parsed;
  }
  if (item.pageNumber !== undefined)
    result.pageNumber = integer(item.pageNumber, 1);
  if (item.manual !== undefined) result.manual = boolean(item.manual);
  if (item.exclusionScope !== undefined)
    result.exclusionScope = enumValue(item.exclusionScope, [
      "source",
      "collection",
    ]);
  if (item.handledBy !== undefined) {
    const owner = object(item.handledBy);
    result.handledBy = {
      batchId: string(owner.batchId),
      collectionId: string(owner.collectionId),
      resolution: enumValue(owner.resolution, ["accepted", "ignored"]),
    };
  }
  // Deliberately omit thumbnails, image bytes and any unknown fields.
  return result;
}

function batch(value: unknown): ScanBatch {
  const item = object(value);
  const result: ScanBatch = {
    id: string(item.id),
    hash: string(item.hash),
    fileName: string(item.fileName),
    pageCount: integer(item.pageCount, 1),
    createdAt: string(item.createdAt),
    collectionId: string(item.collectionId),
    pages: array(item.pages, scanPage),
  };
  if (item.recordedAt !== undefined)
    result.recordedAt = string(item.recordedAt);
  if (item.sourceId !== undefined) result.sourceId = string(item.sourceId);
  if (item.sourceDriveFileId !== undefined)
    result.sourceDriveFileId = string(item.sourceDriveFileId);
  if (item.storageMode !== undefined)
    result.storageMode = enumValue(item.storageMode, ["record-only", "drive"]);
  if (
    result.pages.some((page) => page.sourcePage > result.pageCount) ||
    new Set(result.pages.map((page) => page.sourcePage)).size !==
      result.pages.length
  )
    throw new Error("Invalid scan pages");
  return result;
}

function scanSource(value: unknown): ScanSource {
  const item = object(value);
  const result = {
    id: string(item.id),
    hash: string(item.hash),
    fileName: string(item.fileName),
    pageCount: integer(item.pageCount, 1),
    createdAt: string(item.createdAt),
  };
  if (!result.id || !result.hash) throw new Error("Invalid scan source");
  return result;
}

function event(value: unknown): AuditEvent {
  const item = object(value);
  const result: AuditEvent = {
    id: string(item.id),
    at: string(item.at),
    action: string(item.action),
    detail: string(item.detail),
  };
  for (const key of [
    "actor",
    "reason",
    "targetId",
    "operationId",
    "before",
    "after",
  ] as const)
    if (item[key] !== undefined) result[key] = string(item[key]);
  return result;
}

function stringMap(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(object(value)).map(([key, value]) => [key, string(value)]),
  );
}
function operation(value: unknown): SaveOperation {
  const item = object(value);
  const result: SaveOperation = {
    id: string(item.id),
    collectionId: string(item.collectionId),
    kind: enumValue(item.kind, ["record", "archive", "print"]),
    storageMode: enumValue(item.storageMode, ["record-only", "drive"]),
    recordStatus: enumValue(item.recordStatus, [
      "prepared",
      "recording",
      "recorded",
      "failed",
    ]),
    archiveStatus: enumValue(item.archiveStatus, [
      "not-requested",
      "pending",
      "saving",
      "saved",
      "partial",
      "failed",
      "source-required",
    ]),
    receiptIds: array(item.receiptIds, string),
    createdAt: string(item.createdAt),
    updatedAt: string(item.updatedAt),
  };
  if (item.batchId !== undefined) result.batchId = string(item.batchId);
  if (item.error !== undefined) result.error = string(item.error);
  if (item.studentIds !== undefined)
    result.studentIds = array(item.studentIds, string);
  if (item.unresolvedPages !== undefined)
    result.unresolvedPages = array(item.unresolvedPages, (value) =>
      integer(value, 1),
    );
  if (item.plannedFileIds !== undefined)
    result.plannedFileIds = stringMap(item.plannedFileIds);
  if (
    result.storageMode === "record-only" &&
    result.archiveStatus !== "not-requested"
  )
    throw new Error("Record-only operation has archive state");
  return result;
}
function artifact(value: unknown): DriveArtifact {
  const item = object(value);
  const result: DriveArtifact = {
    id: string(item.id),
    collectionId: string(item.collectionId),
    driveFileId: string(item.driveFileId),
    kind: enumValue(item.kind, [
      "original",
      "print",
      "additional-print",
      "source-scan",
      "student",
      "unresolved",
    ]),
    name: string(item.name),
    receiptIds: array(item.receiptIds, string),
    createdAt: string(item.createdAt),
  };
  for (const key of [
    "versionId",
    "studentId",
    "batchId",
    "operationId",
  ] as const)
    if (item[key] !== undefined) result[key] = string(item[key]);
  if (item.deleted !== undefined) result.deleted = boolean(item.deleted);
  return result;
}
function layout(value: unknown): SeatLayout {
  const item = object(value);
  const result: SeatLayout = {
    id: string(item.id),
    name: string(item.name),
    createdAt: string(item.createdAt),
    rows: integer(item.rows, 1),
    cols: integer(item.cols, 1),
    blockedCells: array(item.blockedCells, (value) => {
      const cell = object(value);
      return { row: integer(cell.row), col: integer(cell.col) };
    }),
    students: array(item.students, student),
    order: enumValue(item.order, ["row", "column", "snake", "number"]),
    reverse: boolean(item.reverse),
  };
  if (item.startCorner !== undefined)
    result.startCorner = enumValue(item.startCorner, [
      "top-left",
      "top-right",
      "bottom-left",
      "bottom-right",
    ]);
  const validCell = (cell: { row: number; col: number }) =>
    cell.row < result.rows && cell.col < result.cols;
  if (
    validateStudents(result.students).length ||
    result.rows > 100 ||
    result.cols > 100 ||
    result.blockedCells.some((cell) => !validCell(cell)) ||
    new Set(result.blockedCells.map((cell) => `${cell.row}:${cell.col}`))
      .size !== result.blockedCells.length ||
    result.students.some(
      (person) =>
        person.seat &&
        (!validCell(person.seat) ||
          result.blockedCells.some(
            (cell) =>
              cell.row === person.seat!.row && cell.col === person.seat!.col,
          )),
    )
  )
    throw new Error("Invalid seat layout");
  return result;
}
function settings(value: unknown): ClassSettings {
  const item = object(value);
  const result: ClassSettings = {};
  for (const key of [
    "schoolYear",
    "classroomCourseId",
    "ledgerId",
    "ledgerRevision",
    "googleAccountId",
    "folderId",
    "timezone",
    "activeSeatLayoutId",
  ] as const)
    if (item[key] !== undefined) result[key] = string(item[key]);
  if (item.defaultOrder !== undefined)
    result.defaultOrder = enumValue(item.defaultOrder, [
      "row",
      "column",
      "snake",
      "number",
    ]);
  if (item.defaultQrCorner !== undefined)
    result.defaultQrCorner = enumValue(item.defaultQrCorner, [
      "top-right",
      "top-left",
      "bottom-right",
      "bottom-left",
    ]);
  if (item.defaultDuplex !== undefined)
    result.defaultDuplex = boolean(item.defaultDuplex);
  if (item.defaultReverse !== undefined)
    result.defaultReverse = boolean(item.defaultReverse);
  if (item.defaultStartCorner !== undefined)
    result.defaultStartCorner = enumValue(item.defaultStartCorner, [
      "top-left",
      "top-right",
      "bottom-left",
      "bottom-right",
    ]);
  if (item.defaultStorageMode !== undefined)
    result.defaultStorageMode = enumValue(item.defaultStorageMode, [
      "record-only",
      "drive",
    ]);
  if (result.timezone)
    new Intl.DateTimeFormat("ja-JP", { timeZone: result.timezone });
  return result;
}

function cleanupFile(value: unknown): CleanupFile {
  const item = object(value);
  return {
    fileId: string(item.fileId),
    name: string(item.name),
    collectionIds: array(item.collectionIds, string),
    status: enumValue(item.status, [
      "pending",
      "trashed",
      "protected",
      "failed",
    ]),
    ...(item.error !== undefined ? { error: string(item.error) } : {}),
  };
}
function cleanupOperation(value: unknown): CleanupOperation {
  const item = object(value);
  return {
    id: string(item.id),
    collectionIds: array(item.collectionIds, string),
    actor: string(item.actor),
    reason: string(item.reason),
    createdAt: string(item.createdAt),
    status: enumValue(item.status, [
      "planned",
      "running",
      "complete",
      "failed",
    ]),
    files: array(item.files, cleanupFile),
    ...(item.completedAt !== undefined
      ? { completedAt: string(item.completedAt) }
      : {}),
  };
}

/** Whitelists demo metadata. OAuth credentials and PDF/image data have no persisted fields. */
export function sanitizeStateForStorage(value: unknown): AppState | null {
  try {
    const item = object(value);
    if (item.schemaVersion !== 1) return null;
    const state: AppState = {
      schemaVersion: 1,
      className: string(item.className),
      students: array(item.students, student),
      collections: array(item.collections, collection),
      receipts: array(item.receipts, receipt),
      batches: array(item.batches, batch),
      events: array(item.events, event),
    };
    if (item.classId !== undefined) state.classId = string(item.classId);
    if (item.scanSources !== undefined)
      state.scanSources = array(item.scanSources, scanSource);
    if (item.operations !== undefined)
      state.operations = array(item.operations, operation);
    if (item.artifacts !== undefined)
      state.artifacts = array(item.artifacts, artifact);
    if (item.seatLayouts !== undefined)
      state.seatLayouts = array(item.seatLayouts, layout);
    if (item.settings !== undefined) state.settings = settings(item.settings);
    if (item.cleanupOperations !== undefined)
      state.cleanupOperations = array(item.cleanupOperations, cleanupOperation);
    if (item.savedClasses !== undefined)
      state.savedClasses = array(item.savedClasses, (value) => {
        const saved = object(value);
        const id = string(saved.id);
        const restored = sanitizeStateForStorage({
          ...saved,
          schemaVersion: 1,
          classId: id,
          savedClasses: undefined,
        });
        if (!id || !restored) throw new Error("Invalid saved class");
        const {
          schemaVersion: _schema,
          classId: _class,
          savedClasses: _saved,
          ...fields
        } = restored;
        return { id, ...fields } satisfies SavedClass;
      });
    if (
      validateStudents(state.students).length ||
      new Set(state.collections.map((entry) => entry.id)).size !==
        state.collections.length ||
      new Set(state.batches.map((entry) => entry.id)).size !==
        state.batches.length
    )
      return null;
    const receiptKeys = new Set<string>();
    const receiptIds = new Set<string>();
    const receiptSources = new Set<string>();
    const allTokenIds = state.collections.flatMap((collection) =>
      collection.tokens.map((token) => token.token),
    );
    if (new Set(allTokenIds).size !== allTokenIds.length) return null;
    const versions = state.collections.map(
      (collection) => collection.versionId,
    );
    if (new Set(versions).size !== versions.length) return null;
    const requested = new Set<string>();
    for (const collection of state.collections)
      for (const person of collection.recipients) {
        if (
          (collection.recipientStates?.[person.id] ?? "required") !== "required"
        )
          continue;
        const key = JSON.stringify([
          collection.logicalCollectionId ?? collection.id,
          person.id,
        ]);
        if (requested.has(key)) return null;
        requested.add(key);
      }
    for (const batch of state.batches)
      if (
        !batch.id ||
        !batch.hash ||
        !state.collections.some(
          (collection) => collection.id === batch.collectionId,
        )
      )
        return null;
    for (const entry of state.receipts) {
      const target = state.collections.find(
        (candidate) => candidate.id === entry.collectionId,
      );
      if (
        !target ||
        target.versionId !== entry.versionId ||
        entry.pageNumber > target.pageCount ||
        !target.recipients.some((person) => person.id === entry.studentId)
      )
        return null;
      const source = state.batches.find((batch) => batch.id === entry.batchId);
      const page = source?.pages.find(
        (page) => page.sourcePage === entry.sourcePage,
      );
      const token = entry.token
        ? target.tokens.find((token) => token.token === entry.token)
        : undefined;
      if (
        !entry.id ||
        receiptIds.has(entry.id) ||
        !source ||
        source.collectionId !== entry.collectionId ||
        entry.sourcePage > source.pageCount ||
        !page ||
        page.resolution !== "accepted" ||
        page.status !== "matched" ||
        page.collectionId !== entry.collectionId ||
        page.versionId !== entry.versionId ||
        page.studentId !== entry.studentId ||
        page.pageNumber !== entry.pageNumber ||
        (page.manual === true) !== (entry.method === "manual") ||
        (entry.token !== undefined &&
          (!token ||
            token.kind !== "content" ||
            token.studentId !== entry.studentId ||
            token.pageNumber !== entry.pageNumber)) ||
        (entry.method === "qr" && (!token || page.token !== entry.token))
      )
        return null;
      receiptIds.add(entry.id);
      const sourceKey = JSON.stringify([entry.batchId, entry.sourcePage]);
      if (receiptSources.has(sourceKey)) return null;
      receiptSources.add(sourceKey);
      const key = JSON.stringify([
        entry.collectionId,
        entry.versionId,
        entry.studentId,
        entry.pageNumber,
      ]);
      if (receiptKeys.has(key)) return null;
      receiptKeys.add(key);
    }
    for (const batch of state.batches)
      for (const page of batch.pages) {
        if (
          page.resolution === "accepted" &&
          !state.receipts.some(
            (receipt) =>
              receipt.batchId === batch.id &&
              receipt.sourcePage === page.sourcePage,
          )
        )
          return null;
      }
    const uniqueIds = (values: Array<{ id: string }>) =>
      values.every((value) => !!value.id) &&
      new Set(values.map((value) => value.id)).size === values.length;
    if (!uniqueIds(state.cleanupOperations ?? [])) return null;
    for (const cleanup of state.cleanupOperations ?? []) {
      if (
        !cleanup.actor.trim() ||
        !cleanup.reason.trim() ||
        !cleanup.collectionIds.length ||
        new Set(cleanup.collectionIds).size !== cleanup.collectionIds.length ||
        cleanup.collectionIds.some(
          (id) => !state.collections.some((collection) => collection.id === id),
        ) ||
        new Set(cleanup.files.map((file) => file.fileId)).size !==
          cleanup.files.length ||
        cleanup.files.some(
          (file) =>
            !file.fileId ||
            !file.collectionIds.length ||
            new Set(file.collectionIds).size !== file.collectionIds.length ||
            file.collectionIds.some(
              (id) => !cleanup.collectionIds.includes(id),
            ),
        ) ||
        (cleanup.status === "complete" &&
          cleanup.files.some(
            (file) => file.status !== "trashed" && file.status !== "protected",
          ))
      )
        return null;
    }
    if (
      !uniqueIds(state.operations ?? []) ||
      !uniqueIds(state.artifacts ?? []) ||
      !uniqueIds(state.seatLayouts ?? []) ||
      !uniqueIds(state.savedClasses ?? []) ||
      state.savedClasses?.some((saved) => saved.id === state.classId)
    )
      return null;
    if (
      state.settings?.activeSeatLayoutId &&
      !state.seatLayouts?.some(
        (layout) => layout.id === state.settings?.activeSeatLayoutId,
      )
    )
      return null;
    if (
      state.collections.some(
        (collection) =>
          collection.seatLayoutId &&
          !state.seatLayouts?.some(
            (layout) => layout.id === collection.seatLayoutId,
          ),
      )
    )
      return null;
    // Retired receipts remain referencable only when their audited before-state survives.
    const receiptHistory = new Map(
      state.receipts.map((receipt) => [receipt.id, receipt]),
    );
    for (const event of state.events) {
      let retired: unknown[] = [];
      try {
        if (event.action.startsWith("page_") && event.before) {
          const before = object(JSON.parse(event.before));
          if (Array.isArray(before.receipts)) retired = before.receipts;
        } else if (event.action === "replace_receipt") {
          retired = [object(JSON.parse(event.detail)).previous];
        }
      } catch {
        continue;
      }
      for (const value of retired) {
        const old = receipt(value);
        const target = state.collections.find(
          (collection) =>
            collection.id === old.collectionId &&
            collection.versionId === old.versionId,
        );
        const source = state.batches.find(
          (batch) =>
            batch.id === old.batchId && batch.collectionId === old.collectionId,
        );
        if (
          !old.id ||
          !target ||
          !source ||
          old.sourcePage > source.pageCount ||
          old.pageNumber > target.pageCount ||
          !target.recipients.some((student) => student.id === old.studentId)
        )
          return null;
        const known = receiptHistory.get(old.id);
        if (
          known &&
          (known.collectionId !== old.collectionId ||
            known.versionId !== old.versionId ||
            known.studentId !== old.studentId ||
            known.pageNumber !== old.pageNumber ||
            known.batchId !== old.batchId ||
            known.sourcePage !== old.sourcePage)
        )
          return null;
        receiptHistory.set(old.id, old);
      }
    }
    for (const operation of state.operations ?? []) {
      if (operation.unresolvedPages !== undefined) {
        const source = state.batches.find(
          (batch) => batch.id === operation.batchId,
        );
        if (
          !source ||
          new Set(operation.unresolvedPages).size !==
            operation.unresolvedPages.length ||
          operation.unresolvedPages.some((page) => page > source.pageCount)
        )
          return null;
      }
      if (
        operation.studentIds &&
        (operation.kind !== "print" ||
          !operation.studentIds.length ||
          new Set(operation.studentIds).size !== operation.studentIds.length ||
          operation.studentIds.some(
            (id) =>
              !state.collections
                .find((collection) => collection.id === operation.collectionId)
                ?.recipients.some((student) => student.id === id),
          ))
      )
        return null;
      if (
        !state.collections.some(
          (collection) => collection.id === operation.collectionId,
        ) ||
        new Set(operation.receiptIds).size !== operation.receiptIds.length ||
        operation.receiptIds.some(
          (id) =>
            receiptHistory.get(id)?.collectionId !== operation.collectionId,
        ) ||
        (operation.storageMode === "record-only" &&
          operation.archiveStatus !== "not-requested") ||
        (operation.batchId &&
          !state.batches.some(
            (batch) =>
              batch.id === operation.batchId &&
              batch.collectionId === operation.collectionId,
          ))
      )
        return null;
    }
    for (const artifact of state.artifacts ?? []) {
      const collection = state.collections.find(
        (collection) => collection.id === artifact.collectionId,
      );
      if (
        !collection ||
        !artifact.driveFileId ||
        (artifact.versionId && artifact.versionId !== collection.versionId) ||
        (artifact.studentId &&
          !collection.recipients.some(
            (student) => student.id === artifact.studentId,
          )) ||
        (artifact.kind === "student" && !artifact.studentId) ||
        (artifact.batchId &&
          !state.batches.some(
            (batch) =>
              batch.id === artifact.batchId &&
              batch.collectionId === artifact.collectionId,
          )) ||
        (artifact.operationId &&
          !state.operations?.some(
            (operation) =>
              operation.id === artifact.operationId &&
              operation.collectionId === artifact.collectionId &&
              operation.storageMode === "drive",
          )) ||
        new Set(artifact.receiptIds).size !== artifact.receiptIds.length ||
        artifact.receiptIds.some((id) => {
          const receipt = receiptHistory.get(id);
          return (
            !receipt ||
            receipt.collectionId !== artifact.collectionId ||
            (artifact.studentId !== undefined &&
              receipt.studentId !== artifact.studentId)
          );
        })
      )
        return null;
    }
    validateSharedScanReferences(state);
    return state;
  } catch {
    return null;
  }
}

export function readState(
  target: StorageLike | undefined = defaultStorage(),
): AppState {
  try {
    const stored = target?.getItem(STORAGE_KEY);
    if (!stored) return createInitialState();
    return sanitizeStateForStorage(JSON.parse(stored)) ?? createInitialState();
  } catch {
    return createInitialState();
  }
}

export function writeState(
  state: AppState,
  target: StorageLike | undefined = defaultStorage(),
): boolean {
  try {
    const safe = sanitizeStateForStorage(state);
    if (!target || !safe) return false;
    target.setItem(STORAGE_KEY, JSON.stringify(safe));
    return true;
  } catch {
    return false;
  }
}

export function clearState(
  target: StorageLike | undefined = defaultStorage(),
): boolean {
  try {
    if (!target) return false;
    target.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export const storage = {
  key: STORAGE_KEY,
  read: readState,
  write: writeState,
  clear: clearState,
};
