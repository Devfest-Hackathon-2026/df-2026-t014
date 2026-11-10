import type { AppState, Student } from "../domain/types";
import {
  LEDGER_TABS,
  encodeSnapshot,
  decodeSnapshot,
  hashTables,
  hashText,
  summaryNotes,
  type LedgerTabName,
  type SheetRows,
  type CellValue,
} from "./ledger";
export { LEDGER_TABS, ledgerRows } from "./ledger";
import {
  getPickerConfiguration,
  openGooglePicker,
  type PickerConfiguration,
  type PickerOptions,
  type PickedFile,
} from "./picker";
import { GoogleTokenSession } from "./auth";
import { GoogleApiError } from "./errors";
import { readCreationReceipt, writeCreationReceipt } from "./journal";
import {
  MAX_ROSTER_GRID_ROWS,
  MAX_ROSTER_GRID_COLUMNS,
  normalizeRosterValues,
} from "../domain/rosterSheet";

export interface RosterSpreadsheet {
  id: string;
  title: string;
  sheets: {
    sheetId: number;
    title: string;
    rowCount: number;
    columnCount: number;
  }[];
}
export interface RosterSheetData {
  title: string;
  sheetTitle: string;
  values: string[][];
}

export interface GoogleIdentity {
  id: string;
  name: string;
  email: string;
}
export interface ClassroomCourse {
  id: string;
  name: string;
  section?: string;
}
export interface DriveFile {
  id: string;
  name: string;
  webViewLink: string;
}
export interface GoogleLedger {
  spreadsheetId: string;
  spreadsheetUrl: string;
  schemaVersion: 1;
  sheets: Record<LedgerTabName, number>;
  accountId?: string;
  revisionHash?: string;
  /** A recovered creation contains data: explicitly restore it before writing. */
  restorationRequired?: boolean;
}
export interface LedgerReadResult {
  ledger: GoogleLedger;
  state: AppState;
  revisionHash: string;
  operationId: string;
}
export interface LedgerWriteOptions {
  expectedRevisionHash?: string;
  operationId?: string;
}
export interface LedgerWriteResult {
  revisionHash: string;
  operationId: string;
  recovered: boolean;
}
export interface LedgerCreateOptions {
  idempotencyKey?: string;
  parentId?: string;
}
export interface GoogleAuthState {
  status: "connected" | "disconnected" | "expired";
  identity?: GoogleIdentity;
}
export interface GoogleClientOptions {
  clientId: string;
  fetch?: typeof fetch;
  apiKey?: string;
  appId?: string;
  onAuthStateChange?: (state: GoogleAuthState) => void;
}
export interface PdfUploadOptions {
  name: string;
  bytes: Uint8Array;
  parentId?: string;
  idempotencyKey?: string;
  /** Persist this pre-generated ID in the save operation before uploading. */
  fileId?: string;
}

interface UploadOperation {
  fingerprint: string;
  id: Promise<string>;
  inFlight?: Promise<DriveFile>;
}
export interface DriveMetadata {
  id: string;
  name?: string;
  webViewLink?: string;
  mimeType?: string;
  size?: string;
  sha256Checksum?: string;
  parents?: string[];
  trashed?: boolean;
  appProperties?: Record<string, string>;
  modifiedTime?: string;
  capabilities?: {
    canAddChildren?: boolean;
    canEdit?: boolean;
    canDownload?: boolean;
    canTrash?: boolean;
  };
}
export interface DriveListOptions {
  parentId?: string;
  mimeType?: string;
  appProperties?: Record<string, string>;
  includeTrashed?: boolean;
}
export interface FolderCreateOptions {
  name: string;
  parentId?: string;
  fileId?: string;
  idempotencyKey?: string;
}

const DRIVE = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const CLASSROOM = "https://classroom.googleapis.com/v1";

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value)
    throw new GoogleApiError(
      "API",
      `${label}をGoogleから取得できませんでした。`,
    );
  return value;
}
function fileLink(id: string): string {
  return `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`;
}
async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer,
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export class GoogleWorkspaceClient {
  private readonly session: GoogleTokenSession;
  private readonly fetcher: typeof fetch;
  private identity?: GoogleIdentity;
  private readonly uploadOperations = new Map<string, UploadOperation>();
  // Upload session URLs are deliberately memory-only. Persisted file IDs still make a full restart safe.
  private readonly resumableSessions = new Map<
    string,
    { url: string; hash: string }
  >();
  private readonly pickerConfiguration: PickerConfiguration;
  private readonly authListeners = new Set<(state: GoogleAuthState) => void>();

  constructor(options: GoogleClientOptions) {
    this.session = new GoogleTokenSession(options.clientId);
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    const picker = getPickerConfiguration();
    this.pickerConfiguration = {
      apiKey: options.apiKey ?? picker.apiKey,
      appId: options.appId ?? picker.appId,
    };
    if (options.onAuthStateChange)
      this.authListeners.add(options.onAuthStateChange);
    this.session.subscribe((status) => {
      if (status !== "connected") {
        this.identity = undefined;
        this.emitAuth({ status });
      }
    });
  }
  isConnected(): boolean {
    return this.session.isConnected();
  }
  disconnect(): void {
    this.session.clear();
    this.identity = undefined;
  }
  getIdentity(): GoogleIdentity | undefined {
    return this.isConnected() ? this.identity : undefined;
  }
  onAuthStateChange(listener: (state: GoogleAuthState) => void): () => void {
    this.authListeners.add(listener);
    return () => this.authListeners.delete(listener);
  }
  private emitAuth(state: GoogleAuthState): void {
    for (const listener of this.authListeners) listener(state);
  }

  async connect(): Promise<GoogleIdentity> {
    await this.session.connect();
    try {
      const profile = await this.json<{
        sub: string;
        name?: string;
        email?: string;
      }>("https://www.googleapis.com/oauth2/v3/userinfo");
      this.identity = {
        id: asString(profile.sub, "アカウント識別子"),
        name: profile.name ?? "",
        email: asString(profile.email, "接続アカウント"),
      };
      this.emitAuth({ status: "connected", identity: this.identity });
      return this.identity;
    } catch (error) {
      this.disconnect();
      throw error;
    }
  }

  private async response(
    url: string,
    init: RequestInit = {},
    allowedStatuses: readonly number[] = [],
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.session.getAccessToken()}`);
    let response: Response;
    try {
      response = await this.fetcher(url, { ...init, headers });
    } catch {
      throw new GoogleApiError(
        "NETWORK",
        "Googleとの通信が完了しませんでした。保存されたか不明な場合はDriveを確認してください。",
      );
    }
    if (!response.ok && !allowedStatuses.includes(response.status)) {
      if (response.status === 401) {
        this.session.clear("expired");
        throw new GoogleApiError(
          "AUTH_EXPIRED",
          "Google認可が失効しました。再接続してから操作してください。",
          401,
        );
      }
      if (response.status === 403)
        throw new GoogleApiError(
          "API",
          "Googleへのアクセスが拒否されました。ファイルの個別許可・OAuth権限・管理者設定を確認してください。",
          403,
        );
      if (response.status === 429)
        throw new GoogleApiError(
          "API",
          "Googleの利用上限に達しました。しばらくしてから再試行してください。",
          429,
        );
      throw new GoogleApiError(
        "API",
        `Google APIの処理に失敗しました（${response.status}）。成功として記録していません。`,
        response.status,
      );
    }
    return response;
  }
  private async json<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await this.response(url, init);
    try {
      return (await response.json()) as T;
    } catch {
      throw new GoogleApiError(
        "API",
        "Google APIの応答を読み取れませんでした。処理結果を確認してください。",
        response.status,
      );
    }
  }

  private async pages<T>(base: string, field: string): Promise<T[]> {
    const accountId = this.currentAccount().id;
    const output: T[] = [];
    const seen = new Set<string>();
    let token = "";
    do {
      this.assertAccount(accountId);
      const url = new URL(base);
      url.searchParams.set("pageSize", "100");
      if (token) url.searchParams.set("pageToken", token);
      const result = await this.json<Record<string, unknown>>(url.toString());
      this.assertAccount(accountId);
      if (result[field] !== undefined && !Array.isArray(result[field]))
        throw new GoogleApiError("API", "名簿APIの形式が想定と異なります。");
      output.push(...((result[field] ?? []) as T[]));
      token =
        typeof result.nextPageToken === "string" ? result.nextPageToken : "";
      if (token && seen.has(token))
        throw new GoogleApiError(
          "API",
          "名簿APIのページ取得が循環しました。人数を確定せず停止します。",
        );
      if (token) seen.add(token);
    } while (token);
    return output;
  }

  async listCourses(): Promise<ClassroomCourse[]> {
    return this.pages<ClassroomCourse>(
      `${CLASSROOM}/courses?teacherId=me&courseStates=ACTIVE`,
      "courses",
    );
  }

  /** Read-only metadata for a file explicitly selected with Picker; drive.file is sufficient. */
  async readRosterSpreadsheet(
    spreadsheetId: string,
  ): Promise<RosterSpreadsheet> {
    const account = this.currentAccount();
    if (!spreadsheetId.trim())
      throw new GoogleApiError(
        "INVALID_DATA",
        "名簿のSheetsを選択してください。",
      );
    const params = new URLSearchParams({
      fields:
        "spreadsheetId,properties(title),sheets(properties(sheetId,title,sheetType,gridProperties(rowCount,columnCount)))",
    });
    const value = await this.json<{
      spreadsheetId?: string;
      properties?: { title?: string };
      sheets?: {
        properties?: {
          sheetId?: number;
          title?: string;
          sheetType?: string;
          gridProperties?: { rowCount?: number; columnCount?: number };
        };
      }[];
    }>(`${SHEETS}/${encodeURIComponent(spreadsheetId)}?${params}`);
    this.assertAccount(account.id);
    if (value.spreadsheetId !== spreadsheetId || !Array.isArray(value.sheets))
      throw new GoogleApiError(
        "INVALID_DATA",
        "選択した名簿のSheetsを確認できません。",
      );
    const seen = new Set<number>();
    const sheets = value.sheets.flatMap((item) => {
      const p = item.properties;
      if (p?.sheetType && p.sheetType !== "GRID") return [];
      if (
        !Number.isSafeInteger(p?.sheetId) ||
        p!.sheetId! < 0 ||
        typeof p?.title !== "string" ||
        !p.title ||
        !Number.isSafeInteger(p.gridProperties?.rowCount) ||
        p.gridProperties!.rowCount! < 1 ||
        !Number.isSafeInteger(p.gridProperties?.columnCount) ||
        p.gridProperties!.columnCount! < 1 ||
        seen.has(p.sheetId!)
      )
        throw new GoogleApiError(
          "INVALID_DATA",
          "名簿シートの構成を確認できません。",
        );
      seen.add(p.sheetId!);
      return [
        {
          sheetId: p.sheetId!,
          title: p.title,
          rowCount: p.gridProperties!.rowCount!,
          columnCount: p.gridProperties!.columnCount!,
        },
      ];
    });
    if (!sheets.length)
      throw new GoogleApiError(
        "INVALID_DATA",
        "通常の表形式の名簿シートがありません。",
      );
    return {
      id: spreadsheetId,
      title: asString(value.properties?.title, "名簿のタイトル"),
      sheets,
    };
  }

  /** Reads the selected complete grid within explicit limits; never silently truncates people. */
  async readRosterSheet(
    spreadsheetId: string,
    sheetId: number,
  ): Promise<RosterSheetData> {
    const account = this.currentAccount();
    const metadata = await this.readRosterSpreadsheet(spreadsheetId);
    this.assertAccount(account.id);
    const sheet = metadata.sheets.find((item) => item.sheetId === sheetId);
    if (!sheet)
      throw new GoogleApiError(
        "INVALID_DATA",
        "選択したシートが削除・変更されています。Sheetsを選び直してください。",
      );
    if (
      sheet.rowCount > MAX_ROSTER_GRID_ROWS ||
      sheet.columnCount > MAX_ROSTER_GRID_COLUMNS
    )
      throw new GoogleApiError(
        "INVALID_DATA",
        `名簿専用シートを${MAX_ROSTER_GRID_ROWS}行・${MAX_ROSTER_GRID_COLUMNS}列以内にしてください。空行・空列もシートのサイズに含まれます。途中で切り捨てて取り込みません。`,
      );
    // Quote the title, including titles that resemble ranges, and escape apostrophes.
    const lastColumn =
      sheet.columnCount <= 26
        ? String.fromCharCode(64 + sheet.columnCount)
        : `A${String.fromCharCode(64 + sheet.columnCount - 26)}`;
    const range = `'${sheet.title.replaceAll("'", "''")}'!A1:${lastColumn}${sheet.rowCount}`;
    const params = new URLSearchParams({
      majorDimension: "ROWS",
      valueRenderOption: "FORMATTED_VALUE",
    });
    const value = await this.json<{ values?: unknown }>(
      `${SHEETS}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?${params}`,
    );
    this.assertAccount(account.id);
    try {
      const values = normalizeRosterValues(value.values ?? []);
      if (values.length < 2)
        throw new Error("見出しと1人以上の名簿が必要です。");
      return { title: metadata.title, sheetTitle: sheet.title, values };
    } catch (error) {
      throw new GoogleApiError(
        "INVALID_DATA",
        error instanceof Error ? error.message : "名簿の形式を確認できません。",
      );
    }
  }

  /** Classroom has no attendance-number field. These numbers are provisional and must be reviewed. */
  async listStudents(courseId: string): Promise<Student[]> {
    if (!courseId.trim())
      throw new GoogleApiError(
        "INVALID_DATA",
        "Classroomのクラスを選択してください。",
      );
    const rows = await this.pages<{
      userId: string;
      profile?: { name?: { fullName?: string } };
    }>(
      `${CLASSROOM}/courses/${encodeURIComponent(courseId)}/students`,
      "students",
    );
    const ids = new Set<string>();
    return rows.map((row, index) => {
      const id = asString(row.userId, "生徒ID");
      if (ids.has(id))
        throw new GoogleApiError(
          "API",
          "名簿に重複した生徒IDがありました。確定せずに停止します。",
        );
      ids.add(id);
      return {
        id: crypto.randomUUID(),
        classroomUserId: id,
        name: asString(row.profile?.name?.fullName, "生徒氏名"),
        number: index + 1,
        seat: null,
      };
    });
  }

  /** Uploads only on explicit invocation. No sharing permissions are created or changed. */
  async uploadPdf({
    name,
    bytes,
    parentId,
    idempotencyKey,
    fileId,
  }: PdfUploadOptions): Promise<DriveFile> {
    if (
      !name.trim() ||
      bytes.length < 5 ||
      new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-"
    ) {
      throw new GoogleApiError(
        "INVALID_DATA",
        "保存するPDFとファイル名を確認してください。",
      );
    }
    if (bytes.length > 100 * 1024 * 1024)
      throw new GoogleApiError(
        "INVALID_DATA",
        "この版では100MBを超えるPDFのGoogle保存に対応していません。ローカルに保存してください。",
      );
    this.session.getAccessToken();
    const accountId = this.identity?.id;
    if (!accountId)
      throw new GoogleApiError(
        "AUTH_REQUIRED",
        "Googleアカウントを確認してから保存してください。",
      );
    if (idempotencyKey !== undefined && !idempotencyKey.trim())
      throw new GoogleApiError("INVALID_DATA", "保存操作の識別子が空です。");
    if (fileId !== undefined && !fileId.trim())
      throw new GoogleApiError(
        "INVALID_DATA",
        "保存計画のファイルIDが空です。",
      );
    const snapshot = new Uint8Array(bytes);
    const hash = await sha256(snapshot);
    const fingerprint = JSON.stringify([
      name.trim(),
      parentId ?? "",
      hash,
      fileId ?? "",
    ]);
    const operationKey =
      idempotencyKey === undefined
        ? undefined
        : JSON.stringify([accountId, idempotencyKey]);
    this.assertAccount(accountId);
    let operation =
      operationKey === undefined
        ? undefined
        : this.uploadOperations.get(operationKey);
    if (operation && operation.fingerprint !== fingerprint) {
      throw new GoogleApiError(
        "INVALID_DATA",
        "同じ保存操作の識別子に異なるPDF・名前・保存先が指定されました。元の内容で再試行するか、新しい操作として保存してください。",
      );
    }
    if (!operation) {
      operation = {
        fingerprint,
        id: fileId ? Promise.resolve(fileId) : this.generateFileId(),
      };
      if (operationKey !== undefined)
        this.uploadOperations.set(operationKey, operation);
    }
    if (operation.inFlight) return operation.inFlight;
    const current = operation;
    current.inFlight = (async () => {
      let id: string;
      try {
        id = await current.id;
      } catch (error) {
        if (
          operationKey !== undefined &&
          this.uploadOperations.get(operationKey) === current
        )
          this.uploadOperations.delete(operationKey);
        throw error;
      }
      return this.uploadWithId(
        { name: name.trim(), bytes: snapshot, parentId },
        id,
        hash,
        accountId,
      );
    })();
    try {
      return await current.inFlight;
    } finally {
      current.inFlight = undefined;
    }
  }

  private assertAccount(expected: string): void {
    this.session.getAccessToken();
    if (this.identity?.id !== expected)
      throw new GoogleApiError(
        "AUTH_REQUIRED",
        "保存中に接続アカウントが変わりました。元のアカウントで接続して再試行してください。",
      );
  }

  async generateFileId(): Promise<string> {
    const generated = await this.json<{ ids: string[] }>(
      `${DRIVE}/files/generateIds?count=1&space=drive&type=files`,
    );
    return asString(generated.ids?.[0], "保存先ID");
  }

  private async confirmExistingUpload(
    options: PdfUploadOptions,
    id: string,
    hash: string,
    accountId: string,
  ): Promise<DriveFile> {
    this.assertAccount(accountId);
    const existing = await this.json<DriveMetadata>(
      `${DRIVE}/files/${encodeURIComponent(id)}?fields=id,name,mimeType,size,sha256Checksum,parents,trashed,webViewLink&supportsAllDrives=true`,
    );
    if (
      existing.id !== id ||
      existing.name !== options.name ||
      existing.mimeType !== "application/pdf" ||
      existing.trashed === true ||
      Number(existing.size) !== options.bytes.length ||
      (options.parentId && !existing.parents?.includes(options.parentId))
    ) {
      throw new GoogleApiError(
        "API",
        "同じ保存先IDのファイルを確認しましたが、保存内容・名前・場所が一致しません。上書きせず停止しました。",
        409,
      );
    }
    let actualHash = existing.sha256Checksum;
    if (!actualHash) {
      this.assertAccount(accountId);
      const download = await this.response(
        `${DRIVE}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`,
      );
      actualHash = await sha256(new Uint8Array(await download.arrayBuffer()));
    }
    if (actualHash !== hash)
      throw new GoogleApiError(
        "API",
        "保存済みPDFの内容が一致しません。上書きせず停止しました。",
        409,
      );
    return {
      id,
      name: existing.name,
      webViewLink: existing.webViewLink ?? fileLink(id),
    };
  }

  private async uploadWithId(
    options: PdfUploadOptions,
    id: string,
    hash: string,
    accountId: string,
  ): Promise<DriveFile> {
    const { name, bytes, parentId } = options;
    this.assertAccount(accountId);
    const metadata = {
      id,
      name,
      mimeType: "application/pdf",
      ...(parentId ? { parents: [parentId] } : {}),
    };
    const blob = new Blob([new Uint8Array(bytes).buffer], {
      type: "application/pdf",
    });
    const params = "fields=id,name,webViewLink&supportsAllDrives=true";
    let result: DriveMetadata;
    try {
      if (bytes.length <= 5 * 1024 * 1024) {
        const boundary = `paperflow_${crypto.randomUUID().replaceAll("-", "")}`;
        const body = new Blob([
          `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
          `--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`,
          blob,
          `\r\n--${boundary}--\r\n`,
        ]);
        result = await this.json(
          `${DRIVE_UPLOAD}/files?uploadType=multipart&${params}`,
          {
            method: "POST",
            headers: {
              "Content-Type": `multipart/related; boundary=${boundary}`,
            },
            body,
          },
        );
      } else {
        result = await this.uploadResumable(
          metadata,
          blob,
          hash,
          accountId,
          params,
        );
      }
    } catch (error) {
      if (error instanceof GoogleApiError && error.status === 409)
        return this.confirmExistingUpload(options, id, hash, accountId);
      throw error;
    }
    this.assertAccount(accountId);
    if (result.id !== id)
      throw new GoogleApiError(
        "API",
        "保存結果のファイルIDが一致しません。Driveで結果を確認してください。",
      );
    return {
      id,
      name: result.name ?? metadata.name,
      webViewLink: result.webViewLink ?? fileLink(id),
    };
  }

  private async uploadResumable(
    metadata: {
      id: string;
      name: string;
      mimeType: string;
      parents?: string[];
    },
    blob: Blob,
    hash: string,
    accountId: string,
    params: string,
  ): Promise<DriveMetadata> {
    const key = JSON.stringify([accountId, metadata.id]);
    let session = this.resumableSessions.get(key);
    if (session && session.hash !== hash)
      throw new GoogleApiError(
        "CONFLICT",
        "保存途中のPDFと今回の内容が異なります。",
      );
    let offset = 0;
    const received = (response: Response): number => {
      const range = response.headers.get("Range");
      if (!range) return 0;
      const match = /^bytes=0-(\d+)$/.exec(range);
      const next = match ? Number(match[1]) + 1 : NaN;
      if (!Number.isSafeInteger(next) || next < 0 || next > blob.size)
        throw new GoogleApiError(
          "API",
          "Googleの受信済み範囲を確認できません。",
        );
      return next;
    };
    if (session) {
      this.assertAccount(accountId);
      const status = await this.response(
        session.url,
        { method: "PUT", headers: { "Content-Range": `bytes */${blob.size}` } },
        [308, 404],
      );
      if (status.ok) {
        this.resumableSessions.delete(key);
        return status.json() as Promise<DriveMetadata>;
      }
      if (status.status === 404) {
        this.resumableSessions.delete(key);
        session = undefined;
      } else offset = received(status);
    }
    if (!session) {
      const start = await this.response(
        `${DRIVE_UPLOAD}/files?uploadType=resumable&${params}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Upload-Content-Type": "application/pdf",
            "X-Upload-Content-Length": String(blob.size),
          },
          body: JSON.stringify(metadata),
        },
      );
      const location = start.headers.get("Location");
      let valid = false;
      try {
        const url = new URL(location ?? "");
        valid =
          url.origin === "https://www.googleapis.com" &&
          url.pathname.startsWith("/upload/drive/") &&
          !url.username &&
          !url.password;
      } catch {
        /* Never send credentials to an unvalidated URL. */
      }
      if (!valid)
        throw new GoogleApiError(
          "API",
          "Googleのアップロード先を確認できませんでした。",
        );
      session = { url: location!, hash };
      this.resumableSessions.set(key, session);
    }
    // 4 MiB is a multiple of Drive's required 256 KiB chunk unit.
    while (offset < blob.size) {
      this.assertAccount(accountId);
      const end = Math.min(offset + 4 * 1024 * 1024, blob.size);
      const response = await this.response(
        session.url,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/pdf",
            "Content-Range": `bytes ${offset}-${end - 1}/${blob.size}`,
          },
          body: blob.slice(offset, end),
        },
        [308],
      );
      if (response.ok) {
        this.resumableSessions.delete(key);
        return response.json() as Promise<DriveMetadata>;
      }
      const next = received(response);
      if (next <= offset || next > end)
        throw new GoogleApiError(
          "API",
          "アップロードの進行を確認できませんでした。同じ保存操作で再試行してください。",
        );
      offset = next;
    }
    throw new GoogleApiError(
      "AMBIGUOUS_WRITE",
      "全データ送信後の完了応答を確認できません。同じ保存操作で再試行してください。",
    );
  }

  private currentAccount(): GoogleIdentity {
    this.session.getAccessToken();
    if (!this.identity)
      throw new GoogleApiError(
        "AUTH_REQUIRED",
        "Googleアカウントを確認してから操作してください。",
      );
    return this.identity;
  }

  async pickFiles(options: PickerOptions): Promise<PickedFile[]> {
    const account = this.currentAccount();
    const result = await openGooglePicker(
      this.pickerConfiguration,
      () => this.session.getAccessToken(),
      options,
    );
    this.assertAccount(account.id);
    return result;
  }

  /** drive.file only lists files individually granted to this application. */
  async listFiles(options: DriveListOptions = {}): Promise<DriveMetadata[]> {
    const escape = (value: string) =>
      value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
    const query = [
      options.includeTrashed ? "" : "trashed = false",
      options.parentId ? `'${escape(options.parentId)}' in parents` : "",
      options.mimeType ? `mimeType = '${escape(options.mimeType)}'` : "",
      ...Object.entries(options.appProperties ?? {}).map(
        ([key, value]) =>
          `appProperties has { key='${escape(key)}' and value='${escape(value)}' }`,
      ),
    ]
      .filter(Boolean)
      .join(" and ");
    const params = new URLSearchParams({
      q: query,
      spaces: "drive",
      fields:
        "nextPageToken,files(id,name,mimeType,webViewLink,parents,trashed,size,sha256Checksum,modifiedTime,appProperties,capabilities)",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    return this.pages<DriveMetadata>(`${DRIVE}/files?${params}`, "files");
  }

  async getFile(fileId: string): Promise<DriveMetadata> {
    if (!fileId.trim())
      throw new GoogleApiError(
        "INVALID_DATA",
        "DriveファイルIDを指定してください。",
      );
    return this.json<DriveMetadata>(
      `${DRIVE}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,webViewLink,parents,trashed,size,sha256Checksum,modifiedTime,appProperties,capabilities&supportsAllDrives=true`,
    );
  }

  async downloadPdf(
    fileId: string,
    expectedHash?: string,
  ): Promise<Uint8Array> {
    const account = this.currentAccount();
    const unavailable = (error: unknown): never => {
      if (
        error instanceof GoogleApiError &&
        (error.status === 403 || error.status === 404)
      ) {
        throw new GoogleApiError(
          error.code,
          `DriveのPDFが見つからないか、読み取りの許可がありません（${error.status}）。Driveから対象のPDFを個別に選び直してください。`,
          error.status,
        );
      }
      throw error;
    };
    const metadata = await this.getFile(fileId).catch(unavailable);
    if (
      metadata.trashed ||
      metadata.mimeType !== "application/pdf" ||
      metadata.capabilities?.canDownload === false
    )
      throw new GoogleApiError(
        "INVALID_DATA",
        "保存PDFが削除されているか、PDFの読取権限がありません。元ファイルを選び直してください。",
      );
    if (Number(metadata.size) > 100 * 1024 * 1024)
      throw new GoogleApiError(
        "INVALID_DATA",
        "100MBを超えるPDFはこの版で読み込めません。",
      );
    this.assertAccount(account.id);
    const response = await this.response(
      `${DRIVE}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
    ).catch(unavailable);
    const bytes = new Uint8Array(await response.arrayBuffer());
    this.assertAccount(account.id);
    if (
      bytes.length > 100 * 1024 * 1024 ||
      new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-"
    )
      throw new GoogleApiError(
        "INVALID_DATA",
        "Driveのファイルが対応するPDFではありません。",
      );
    if (expectedHash && (await sha256(bytes)) !== expectedHash)
      throw new GoogleApiError(
        "INVALID_DATA",
        "選択したPDFは記録した原本と一致しません。別の原本を選び直してください。",
      );
    return bytes;
  }

  async createFolder(
    name: string,
    options: Omit<FolderCreateOptions, "name"> = {},
  ): Promise<DriveFile> {
    const account = this.currentAccount();
    if (!name.trim())
      throw new GoogleApiError(
        "INVALID_DATA",
        "保存先フォルダ名を指定してください。",
      );
    const { parentId, fileId, idempotencyKey } = options;
    const key = idempotencyKey
      ? await hashText(`${account.id}:${idempotencyKey}`)
      : undefined;
    if (key && !fileId) {
      const found = await this.listFiles({
        mimeType: "application/vnd.google-apps.folder",
        appProperties: { paperflowKey: key },
      });
      if (found.length > 1)
        throw new GoogleApiError(
          "CONFLICT",
          "同じ保存操作のフォルダが複数あります。Driveで確認してください。",
        );
      if (found[0]) return this.confirmFolder(found[0], name.trim(), parentId);
    }
    const journalKey = key ? `folder:${key}` : undefined;
    const fingerprint = await hashText(
      JSON.stringify([name.trim(), parentId ?? ""]),
    );
    const previous = journalKey ? readCreationReceipt(journalKey) : undefined;
    if (previous && previous.fingerprint !== fingerprint)
      throw new GoogleApiError(
        "CONFLICT",
        "同じフォルダ作成操作の名前・保存先が異なります。",
      );
    const id = fileId ?? previous?.id ?? (await this.generateFileId());
    if (journalKey)
      writeCreationReceipt(journalKey, { fingerprint, id, unknown: true });
    this.assertAccount(account.id);
    try {
      const result = await this.json<DriveMetadata>(
        `${DRIVE}/files?fields=id,name,webViewLink,mimeType,parents,trashed&supportsAllDrives=true`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id,
            name: name.trim(),
            mimeType: "application/vnd.google-apps.folder",
            ...(parentId ? { parents: [parentId] } : {}),
            ...(key ? { appProperties: { paperflowKey: key } } : {}),
          }),
        },
      );
      return this.confirmFolder(result, name.trim(), parentId);
    } catch (error) {
      if (
        error instanceof GoogleApiError &&
        (error.status === 409 ||
          error.code === "NETWORK" ||
          (error.status ?? 0) >= 500)
      ) {
        try {
          return this.confirmFolder(
            await this.getFile(id),
            name.trim(),
            parentId,
          );
        } catch (verifyError) {
          if (error.status === 409) throw verifyError;
        }
      }
      throw error;
    }
  }
  private confirmFolder(
    file: DriveMetadata,
    name: string,
    parentId?: string,
  ): DriveFile {
    if (
      !file.id ||
      file.trashed ||
      file.mimeType !== "application/vnd.google-apps.folder" ||
      file.name !== name ||
      (parentId && !file.parents?.includes(parentId))
    )
      throw new GoogleApiError(
        "CONFLICT",
        "既存フォルダの名前・保存先が今回の計画と一致しません。自動変更せず停止しました。",
      );
    return {
      id: file.id,
      name,
      webViewLink:
        file.webViewLink ??
        `https://drive.google.com/drive/folders/${encodeURIComponent(file.id)}`,
    };
  }

  /** Explicit soft-delete only. Never grants access or permanently deletes a file. */
  async trashFile(fileId: string): Promise<void> {
    await this.json(
      `${DRIVE}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=id,trashed`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trashed: true }),
      },
    );
  }

  private async ledgerData(id: string): Promise<{
    ledger: GoogleLedger;
    tables: SheetRows;
    protection: Set<number>;
    dimensions: Map<number, { rowCount?: number; columnCount?: number }>;
  }> {
    const account = this.currentAccount();
    const result = await this.json<{
      spreadsheetId?: string;
      spreadsheetUrl?: string;
      sheets?: {
        properties: {
          title: string;
          sheetId: number;
          gridProperties?: { rowCount?: number; columnCount?: number };
        };
        protectedRanges?: {
          description?: string;
          range?: { sheetId?: number };
        }[];
        data?: {
          startRow?: number;
          startColumn?: number;
          rowData?: {
            values?: {
              userEnteredValue?: {
                stringValue?: string;
                numberValue?: number;
                boolValue?: boolean;
                formulaValue?: string;
              };
            }[];
          }[];
        }[];
      }[];
    }>(
      `${SHEETS}/${encodeURIComponent(id)}?includeGridData=true&fields=spreadsheetId,spreadsheetUrl,sheets(properties(sheetId,title,gridProperties),protectedRanges(description,range),data(startRow,startColumn,rowData(values(userEnteredValue))))`,
    );
    this.assertAccount(account.id);
    const sheets = {} as Record<LedgerTabName, number>;
    const tables = Object.fromEntries(
      LEDGER_TABS.map((name) => [name, []]),
    ) as unknown as SheetRows;
    const protection = new Set<number>();
    const dimensions = new Map<
      number,
      { rowCount?: number; columnCount?: number }
    >();
    for (const name of LEDGER_TABS) {
      const sheet = result.sheets?.find(
        (item) => item.properties.title === name,
      );
      if (!sheet || !Number.isInteger(sheet.properties.sheetId))
        throw new GoogleApiError(
          "INVALID_DATA",
          "台帳のシート名が変更されているか復元用タブを含まない旧形式です。元のJSONを復元して新しい台帳へ保存してください。",
        );
      sheets[name] = sheet.properties.sheetId;
      dimensions.set(
        sheet.properties.sheetId,
        sheet.properties.gridProperties ?? {},
      );
      if (
        sheet.protectedRanges?.some(
          (p) =>
            p.description === "PaperFlow system data" &&
            p.range?.sheetId === sheet.properties.sheetId,
        )
      )
        protection.add(sheet.properties.sheetId);
      for (const grid of sheet.data ?? [])
        for (const [index, row] of (grid.rowData ?? []).entries()) {
          const cells: CellValue[] = Array(grid.startColumn ?? 0).fill("");
          for (const value of row.values ?? []) {
            const cell = value.userEnteredValue;
            cells.push(
              cell?.formulaValue ??
                cell?.stringValue ??
                cell?.numberValue ??
                cell?.boolValue ??
                "",
            );
          }
          while (cells.length && cells.at(-1) === "") cells.pop();
          tables[name][(grid.startRow ?? 0) + index] = cells;
        }
      // API omits trailing empty rows. Normalize gaps and trailing blanks for stable hashes.
      tables[name] = Array.from(
        { length: tables[name].length },
        (_, i) => tables[name][i] ?? [],
      );
      while (tables[name].length && !tables[name].at(-1)?.length)
        tables[name].pop();
    }
    return {
      ledger: {
        spreadsheetId: id,
        spreadsheetUrl:
          result.spreadsheetUrl ??
          `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/edit`,
        schemaVersion: 1,
        sheets,
        accountId: account.id,
      },
      tables,
      protection,
      dimensions,
    };
  }

  async readLedger(id: string): Promise<LedgerReadResult> {
    const { ledger, tables } = await this.ledgerData(id);
    const decoded = await decodeSnapshot(tables, this.currentAccount().id);
    const revisionHash = await hashTables(tables);
    ledger.revisionHash = revisionHash;
    return {
      ledger,
      state: decoded.state,
      revisionHash,
      operationId: decoded.operationId,
    };
  }

  private readonly pendingCreates = new Map<
    string,
    { fingerprint: string; id?: string; unknown: boolean }
  >();

  /** Use a stable class-specific key. Response loss is resolved by that key, never by a filename. */
  async createLedger(
    title: string,
    options: LedgerCreateOptions = {},
  ): Promise<GoogleLedger> {
    const account = this.currentAccount();
    if (!title.trim())
      throw new GoogleApiError("INVALID_DATA", "台帳名を入力してください。");
    const key = await hashText(
      `${account.id}:${options.idempotencyKey ?? crypto.randomUUID()}`,
    );
    const fingerprint = await hashText(
      JSON.stringify([title.trim(), options.parentId ?? ""]),
    );
    const previous = this.pendingCreates.get(key) ?? readCreationReceipt(key);
    if (previous && previous.fingerprint !== fingerprint)
      throw new GoogleApiError(
        "CONFLICT",
        "同じ台帳作成操作で名前・保存先が変わっています。元の設定で再試行してください。",
      );
    let id = previous?.id;
    if (!id && options.idempotencyKey) {
      const existing = await this.listFiles({
        mimeType: "application/vnd.google-apps.spreadsheet",
        appProperties: { paperflowLedger: key },
      });
      if (existing.length > 1)
        throw new GoogleApiError(
          "CONFLICT",
          "同じ台帳作成操作のファイルが複数あります。自動選択せず停止しました。",
        );
      if (existing[0]) {
        if (existing[0].appProperties?.paperflowPlan !== fingerprint)
          throw new GoogleApiError(
            "CONFLICT",
            "既存台帳の作成計画と今回の名前・保存先が異なります。",
          );
        id = existing[0].id;
      }
    }
    if (!id && previous?.unknown)
      throw new GoogleApiError(
        "AMBIGUOUS_WRITE",
        "台帳作成の応答を確認できていません。Driveの反映後に同じ操作を再試行するかPickerで台帳を選んでください。重複作成は停止しました。",
      );
    if (!id) {
      const record = { fingerprint, unknown: true } as {
        fingerprint: string;
        id?: string;
        unknown: boolean;
      };
      this.pendingCreates.set(key, record);
      writeCreationReceipt(key, record);
      try {
        const created = await this.json<DriveMetadata>(
          `${DRIVE}/files?fields=id&supportsAllDrives=true`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: title.trim(),
              mimeType: "application/vnd.google-apps.spreadsheet",
              appProperties: {
                paperflowLedger: key,
                paperflowPlan: fingerprint,
              },
              ...(options.parentId ? { parents: [options.parentId] } : {}),
            }),
          },
        );
        id = asString(created.id, "台帳ID");
        record.id = id;
        record.unknown = false;
        writeCreationReceipt(key, record);
      } catch (error) {
        if (
          error instanceof GoogleApiError &&
          error.status !== undefined &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 408
        ) {
          record.unknown = false;
          this.pendingCreates.delete(key);
          writeCreationReceipt(key, undefined);
        }
        if (options.idempotencyKey && this.isConnected()) {
          const found = await this.listFiles({
            mimeType: "application/vnd.google-apps.spreadsheet",
            appProperties: { paperflowLedger: key },
          }).catch(() => []);
          if (
            found.length === 1 &&
            found[0].appProperties?.paperflowPlan === fingerprint
          ) {
            id = found[0].id;
            record.id = id;
            record.unknown = false;
            writeCreationReceipt(key, record);
          }
        }
        if (!id) throw error;
      }
    }
    this.assertAccount(account.id);
    const current = await this.json<{
      sheets?: { properties: { title: string; sheetId: number } }[];
    }>(
      `${SHEETS}/${encodeURIComponent(id)}?fields=sheets.properties(sheetId,title)`,
    );
    const used = new Set(
      current.sheets?.map((s) => s.properties.sheetId) ?? [],
    );
    const requests: unknown[] = [];
    for (const name of LEDGER_TABS)
      if (!current.sheets?.some((s) => s.properties.title === name)) {
        let sheetId = 0;
        while (used.has(sheetId)) sheetId++;
        used.add(sheetId);
        requests.push({
          addSheet: {
            properties: {
              sheetId,
              title: name,
              index: LEDGER_TABS.indexOf(name),
              gridProperties: {
                rowCount: 1000,
                columnCount: 20,
                frozenRowCount: 1,
              },
            },
          },
        });
      }
    if (requests.length)
      await this.json(`${SHEETS}/${encodeURIComponent(id)}:batchUpdate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requests }),
      });
    const data = await this.ledgerData(id);
    data.ledger.revisionHash = await hashTables(data.tables);
    // Recover a completed prior create without overwriting its state on the next write.
    if (data.tables.Metadata.length) {
      await decodeSnapshot(data.tables, account.id);
      data.ledger.restorationRequired = true;
    }
    return data.ledger;
  }

  /** One atomic Sheets batch; existing remote changes cause CONFLICT. This is not a distributed lock. */
  async writeLedger(
    ledger: GoogleLedger,
    state: AppState,
    options: LedgerWriteOptions = {},
  ): Promise<LedgerWriteResult> {
    const account = this.currentAccount();
    if (ledger.restorationRequired)
      throw new GoogleApiError(
        "CONFLICT",
        "同じクラスの既存台帳が見つかりました。内容を上書きする前に、台帳を開いて復元してください。",
      );
    if (
      ledger.schemaVersion !== 1 ||
      state.schemaVersion !== 1 ||
      !ledger.spreadsheetId
    )
      throw new GoogleApiError(
        "INVALID_DATA",
        "台帳の形式が対応していません。",
      );
    if (
      (ledger.accountId && ledger.accountId !== account.id) ||
      (state.settings?.googleAccountId &&
        state.settings.googleAccountId !== account.id)
    )
      throw new GoogleApiError(
        "ACCOUNT_MISMATCH",
        "この記録・台帳に対応する学校アカウントで接続してください。",
      );
    const operationId = options.operationId ?? crypto.randomUUID();
    const encoded = await encodeSnapshot(state, account.id, operationId);
    const current = await this.ledgerData(ledger.spreadsheetId);
    for (const name of LEDGER_TABS)
      if (current.ledger.sheets[name] !== ledger.sheets[name])
        throw new GoogleApiError(
          "INVALID_DATA",
          "台帳のシートIDが変更されています。上書きせず停止しました。",
        );
    if (current.tables.Metadata.length) {
      const meta = await decodeSnapshot(current.tables, account.id);
      if (meta.operationId === operationId) {
        if (meta.stateHash !== encoded.stateHash)
          throw new GoogleApiError(
            "CONFLICT",
            "同じ保存操作IDに異なる内容が指定されました。新しい操作として保存してください。",
          );
        const revisionHash = await hashTables(current.tables);
        ledger.revisionHash = revisionHash;
        return { revisionHash, operationId, recovered: true };
      }
    }
    const currentHash = await hashTables(current.tables);
    const expected = options.expectedRevisionHash ?? ledger.revisionHash;
    if (expected === undefined || expected !== currentHash)
      throw new GoogleApiError(
        "CONFLICT",
        "台帳に別の更新があるか未読込です。台帳を読み直して変更を確認し、再集計してから保存してください。",
      );
    const notes = summaryNotes(current.tables.Summary);
    for (const row of encoded.tables.Summary.slice(1))
      row[11] = notes.get(JSON.stringify([row[12], row[13]])) ?? "";
    const requests: unknown[] = [];
    for (const name of LEDGER_TABS) {
      const sheetId = ledger.sheets[name],
        rows = encoded.tables[name];
      const columns = Math.max(...rows.map((row) => row.length), 20);
      requests.push({
        updateSheetProperties: {
          properties: {
            sheetId,
            gridProperties: {
              rowCount: Math.max(
                rows.length,
                current.dimensions.get(sheetId)?.rowCount ?? 0,
                1000,
              ),
              columnCount: Math.max(
                columns,
                current.dimensions.get(sheetId)?.columnCount ?? 0,
              ),
              frozenRowCount: 1,
            },
          },
          fields: "gridProperties",
        },
      });
      requests.push({
        repeatCell: {
          range: {
            sheetId,
            ...(name === "Summary"
              ? { startColumnIndex: 0, endColumnIndex: 14 }
              : {}),
          },
          cell: {},
          fields: "userEnteredValue",
        },
      });
      requests.push({
        updateCells: {
          start: { sheetId, rowIndex: 0, columnIndex: 0 },
          rows: rows.map((row) => ({
            values: row.map((value) => ({
              userEnteredValue:
                typeof value === "number"
                  ? { numberValue: value }
                  : typeof value === "boolean"
                    ? { boolValue: value }
                    : { stringValue: value },
            })),
          })),
          fields: "userEnteredValue",
        },
      });
      if (name !== "Summary" && !current.protection.has(sheetId))
        requests.push({
          addProtectedRange: {
            protectedRange: {
              range: { sheetId },
              description: "PaperFlow system data",
              warningOnly: false,
              editors: { users: [account.email] },
            },
          },
        });
    }
    this.assertAccount(account.id);
    const revisionHash = await hashTables(encoded.tables);
    try {
      await this.json(
        `${SHEETS}/${encodeURIComponent(ledger.spreadsheetId)}:batchUpdate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requests }),
        },
      );
    } catch (error) {
      if (
        error instanceof GoogleApiError &&
        (error.code === "NETWORK" ||
          (error.status ?? 0) >= 500 ||
          (error.status !== undefined &&
            error.status >= 200 &&
            error.status < 300))
      ) {
        try {
          const saved = await this.ledgerData(ledger.spreadsheetId);
          const verified = await decodeSnapshot(saved.tables, account.id);
          if (
            verified.operationId === operationId &&
            verified.stateHash === encoded.stateHash
          ) {
            const recoveredHash = await hashTables(saved.tables);
            ledger.revisionHash = recoveredHash;
            return {
              revisionHash: recoveredHash,
              operationId,
              recovered: true,
            };
          }
        } catch {
          /* Preserve the original failure; never assume an unknown commit failed. */
        }
      }
      throw error;
    }
    ledger.revisionHash = revisionHash;
    ledger.accountId = account.id;
    return { revisionHash, operationId, recovered: false };
  }
}
