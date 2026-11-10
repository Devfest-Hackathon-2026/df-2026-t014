export type QrCorner =
  "top-right" | "top-left" | "bottom-right" | "bottom-left";

export interface Progress {
  current: number;
  total: number;
  message: string;
}

export type ProgressCallback = (progress: Progress) => void;

/** One page of the collected PDF. `token` is absent when QR reading failed. */
export interface ScanPage {
  sourcePage: number;
  token?: string;
  thumbnail?: string;
  /** Why the QR could not be read. Not used for CSV `note` when a token exists. */
  reason?: string;
  /** Set by the teacher; excluded pages are omitted from the CSV. */
  excluded?: boolean;
}

export interface ScanSession {
  id: string;
  fileName: string;
  pageCount: number;
  /** ISO 8601 timestamp of the moment reading finished. */
  createdAt: string;
  pages: ScanPage[];
}

export type ScanCsvStatus = "ok" | "unreadable" | "duplicate";

export interface ScanCsvMeta {
  scanId: string;
  scannedAt: string;
  sourceFile: string;
}

export interface ScanCsvRow {
  scanId: string;
  scannedAt: string;
  sourceFile: string;
  page: number;
  token: string;
  status: ScanCsvStatus;
  note: string;
}

export interface ScanOptions {
  bytes: Uint8Array;
  onProgress?: ProgressCallback;
  signal?: AbortSignal;
}
