export type QrCorner =
  "top-right" | "top-left" | "bottom-right" | "bottom-left";
export type DistributionOrder = "row" | "column" | "snake" | "number";
export interface Student {
  id: string;
  name: string;
  number: number;
  seat: { row: number; col: number } | null;
  classroomUserId?: string;
  enrollment?: "active" | "withdrawn";
}
export type CollectionStatus =
  "draft" | "generating" | "ready" | "collecting" | "closed";
export type RecipientRequirement = "required" | "exempt" | "superseded";
export interface ChangeContext {
  actor: string;
  reason: string;
}
export interface PageToken {
  token: string;
  studentId: string;
  collectionId: string;
  versionId: string;
  pageNumber: number;
  kind: "content" | "spacer";
  required: boolean;
  active?: boolean;
}
export interface Collection {
  id: string;
  title: string;
  dueDate: string;
  className: string;
  versionId: string;
  createdAt: string;
  pageCount: number;
  requiredPages: number[];
  qrCorner: QrCorner;
  duplex: boolean;
  order: DistributionOrder;
  reverse: boolean;
  startCorner?: QrCorner;
  sourceName: string;
  tokens: PageToken[];
  recipients: Student[];
  status?: CollectionStatus;
  logicalCollectionId?: string;
  revision?: number;
  pendingRevision?: boolean;
  pendingRecipientIds?: string[];
  printStudentOrder?: string[];
  archivedAt?: string;
  deletedAt?: string;
  recipientStates?: Record<string, RecipientRequirement>;
  sourceDocumentId?: string;
  sourceHash?: string;
  sourceDriveFileId?: string;
  printDriveFileId?: string;
  folderId?: string;
  createdBy?: string;
  layoutMode?: "reserved-corner" | "management-band";
  showNames?: boolean;
  versionLabel?: string;
  seatLayoutId?: string;
}
export type ScanPageStatus =
  | "matched"
  | "unreadable"
  | "unknown"
  | "duplicate"
  | "foreign"
  | "spacer"
  | "blank";
export interface ScanPage {
  id: string;
  sourcePage: number;
  token?: string;
  status: ScanPageStatus;
  studentId?: string;
  pageNumber?: number;
  collectionId?: string;
  versionId?: string;
  thumbnail?: string;
  reason?: string;
  resolution: "accepted" | "ignored" | "pending";
  manual?: boolean;
  reviewReason?: string;
  reviewedBy?: string;
  exclusionScope?: "source" | "collection";
  handledBy?: {
    batchId: string;
    collectionId: string;
    resolution: "accepted" | "ignored";
  };
}
export interface Receipt {
  id: string;
  collectionId: string;
  versionId: string;
  studentId: string;
  pageNumber: number;
  token?: string;
  batchId: string;
  sourcePage: number;
  recordedAt: string;
  method: "qr" | "manual";
  actor?: string;
}
export interface ScanBatch {
  id: string;
  sourceId?: string;
  hash: string;
  fileName: string;
  pageCount: number;
  createdAt: string;
  collectionId: string;
  pages: ScanPage[];
  recordedAt?: string;
  sourceDriveFileId?: string;
  storageMode?: StorageMode;
}
/** Class-scoped original PDF. ScanBatch remains a collection-specific review view for compatibility. */
export interface ScanSource {
  id: string;
  hash: string;
  fileName: string;
  pageCount: number;
  createdAt: string;
}
export interface AuditEvent {
  id: string;
  at: string;
  action: string;
  detail: string;
  actor?: string;
  reason?: string;
  targetId?: string;
  operationId?: string;
  before?: string;
  after?: string;
}
export type StorageMode = "record-only" | "drive";
export interface SaveOperation {
  id: string;
  collectionId: string;
  batchId?: string;
  kind: "record" | "archive" | "print";
  storageMode: StorageMode;
  recordStatus: "prepared" | "recording" | "recorded" | "failed";
  archiveStatus:
    | "not-requested"
    | "pending"
    | "saving"
    | "saved"
    | "partial"
    | "failed"
    | "source-required";
  receiptIds: string[];
  createdAt: string;
  updatedAt: string;
  error?: string;
  plannedFileIds?: Record<string, string>;
  /** Fixed unresolved source pages for this operation; absent on legacy plans. */
  unresolvedPages?: number[];
  studentIds?: string[];
}
export interface DriveArtifact {
  id: string;
  kind:
    | "original"
    | "print"
    | "additional-print"
    | "source-scan"
    | "student"
    | "unresolved";
  collectionId: string;
  versionId?: string;
  studentId?: string;
  batchId?: string;
  operationId?: string;
  driveFileId: string;
  name: string;
  receiptIds: string[];
  createdAt: string;
  deleted?: boolean;
}
export interface SeatLayout {
  id: string;
  name: string;
  createdAt: string;
  rows: number;
  cols: number;
  blockedCells: Array<{ row: number; col: number }>;
  students: Student[];
  order: DistributionOrder;
  reverse: boolean;
  startCorner?: QrCorner;
}
export interface ClassSettings {
  schoolYear?: string;
  classroomCourseId?: string;
  ledgerId?: string;
  ledgerRevision?: string;
  googleAccountId?: string;
  folderId?: string;
  timezone?: string;
  activeSeatLayoutId?: string;
  defaultOrder?: DistributionOrder;
  defaultReverse?: boolean;
  defaultStartCorner?: QrCorner;
  defaultQrCorner?: QrCorner;
  defaultDuplex?: boolean;
  defaultStorageMode?: StorageMode;
}
export interface SavedClass {
  id: string;
  className: string;
  students: Student[];
  collections: Collection[];
  receipts: Receipt[];
  batches: ScanBatch[];
  scanSources?: ScanSource[];
  events: AuditEvent[];
  operations?: SaveOperation[];
  artifacts?: DriveArtifact[];
  seatLayouts?: SeatLayout[];
  settings?: ClassSettings;
  cleanupOperations?: CleanupOperation[];
}
export interface AppState {
  schemaVersion: 1;
  className: string;
  students: Student[];
  collections: Collection[];
  receipts: Receipt[];
  batches: ScanBatch[];
  scanSources?: ScanSource[];
  events: AuditEvent[];
  classId?: string;
  savedClasses?: SavedClass[];
  operations?: SaveOperation[];
  artifacts?: DriveArtifact[];
  seatLayouts?: SeatLayout[];
  settings?: ClassSettings;
  cleanupOperations?: CleanupOperation[];
}
export interface CleanupFile {
  fileId: string;
  name: string;
  collectionIds: string[];
  status: "pending" | "trashed" | "protected" | "failed";
  error?: string;
}
export interface CleanupOperation {
  id: string;
  collectionIds: string[];
  actor: string;
  reason: string;
  createdAt: string;
  completedAt?: string;
  status: "planned" | "running" | "complete" | "failed";
  files: CleanupFile[];
}
export interface Progress {
  current: number;
  total: number;
  message: string;
}
export type ProgressCallback = (progress: Progress) => void;
export interface PrintOptions {
  collection: Collection;
  students: Student[];
  sourcePdf?: Uint8Array;
  onProgress?: ProgressCallback;
  studentIds?: string[];
  pageNumbers?: number[];
  signal?: AbortSignal;
}
export interface PrintResult {
  bytes: Uint8Array;
  collection: Collection;
}
export interface ScanOptions {
  bytes: Uint8Array;
  tokens: PageToken[];
  collectionId: string;
  existingReceipts: Receipt[];
  onProgress?: ProgressCallback;
  signal?: AbortSignal;
  qrCorner?: QrCorner;
}
