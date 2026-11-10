import type { AppState } from "../domain/types";
import { getStudentStatus } from "../domain/logic";
import { sanitizeStateForStorage } from "../domain/persistence";
import { getStudentArchiveSummary } from "../domain/operations";
import { GoogleApiError } from "./errors";
import { isCollectionDeleting } from "../domain/lifecycle";

export const LEDGER_TABS = [
  "Summary",
  "Students",
  "Collections",
  "Tokens",
  "Receipts",
  "Batches",
  "Events",
  "AppState",
  "Metadata",
] as const;
export type LedgerTabName = (typeof LEDGER_TABS)[number];
export type CellValue = string | number | boolean;
export type SheetRows = Record<LedgerTabName, CellValue[][]>;

export function ledgerRows(state: AppState): SheetRows {
  const labels = {
    uncollected: "未回収",
    partial: "一部不足",
    complete: "回収済み",
    exempt: "対象外",
    superseded: "置換済み",
  };
  return {
    Summary: [
      [
        "クラス",
        "配布物",
        "出席番号",
        "氏名",
        "回収状態",
        "不足ページ",
        "最終記録日時",
        "必要ページ数",
        "回収ページ数",
        "保管状態",
        "PDFリンク",
        "備考",
        "versionId",
        "studentId",
        "管理状態",
      ],
      ...state.collections.flatMap((collection) =>
        [...collection.recipients]
          .sort((a, b) => a.number - b.number || a.id.localeCompare(b.id))
          .map((student) => {
            const status = getStudentStatus(
              collection,
              student.id,
              state.receipts,
            );
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
            const receipts = state.receipts.filter(
              (r) =>
                r.collectionId === collection.id &&
                r.versionId === collection.versionId &&
                r.studentId === student.id,
            );
            const ids = new Set(receipts.map((r) => r.id));
            const latestArtifact = [...(state.artifacts ?? [])]
              .filter(
                (a) =>
                  a.kind === "student" &&
                  a.collectionId === collection.id &&
                  a.studentId === student.id &&
                  a.versionId === collection.versionId,
              )
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
            const archived = getStudentArchiveSummary(
              state,
              collection.id,
              student.id,
            );
            const artifact = archived.artifact ?? latestArtifact;
            const exact = archived.status === "current";
            const storage = artifact?.deleted
              ? "保存先不明"
              : artifact
                ? exact
                  ? "最新PDF保管済み"
                  : `前回保存分（${artifact.receiptIds.filter((id) => ids.has(id)).length}/${ids.size}ページ）`
                : "未保管";
            return [
              collection.className,
              collection.title,
              student.number,
              student.name,
              labels[status.status],
              status.missingPages.join("・"),
              displayTimestamp(
                recordedAt,
                state.settings?.timezone ?? "Asia/Tokyo",
              ),
              status.requiredCount,
              status.receivedCount,
              storage,
              artifact && !artifact.deleted
                ? `https://drive.google.com/file/d/${encodeURIComponent(artifact.driveFileId)}/view`
                : "",
              "",
              collection.versionId,
              student.id,
              collection.deletedAt
                ? "削除済み（履歴）"
                : isCollectionDeleting(state, collection.id)
                  ? "削除処理中"
                  : collection.archivedAt
                    ? "アーカイブ"
                    : "利用中",
            ];
          }),
      ),
    ],
    Students: [
      ["studentId", "name", "number", "seatRow", "seatColumn", "className"],
      ...state.students.map((s) => [
        s.id,
        s.name,
        s.number,
        s.seat?.row ?? "",
        s.seat?.col ?? "",
        state.className,
      ]),
    ],
    Collections: [
      [
        "collectionId",
        "versionId",
        "title",
        "className",
        "dueDate",
        "createdAt",
        "pageCount",
        "requiredPages",
        "qrCorner",
        "duplex",
        "order",
        "reverse",
        "sourceName",
        "recipientsJson",
      ],
      ...state.collections.map((c) => [
        c.id,
        c.versionId,
        c.title,
        c.className,
        c.dueDate,
        c.createdAt,
        c.pageCount,
        c.requiredPages.join(","),
        c.qrCorner,
        c.duplex,
        c.order,
        c.reverse,
        c.sourceName,
        JSON.stringify(c.recipients),
      ]),
    ],
    Tokens: [
      [
        "token",
        "collectionId",
        "versionId",
        "studentId",
        "pageNumber",
        "kind",
        "required",
      ],
      ...state.collections.flatMap((c) =>
        c.tokens.map((t) => [
          t.token,
          t.collectionId,
          t.versionId,
          t.studentId,
          t.pageNumber,
          t.kind,
          t.required,
        ]),
      ),
    ],
    Receipts: [
      [
        "receiptId",
        "collectionId",
        "versionId",
        "studentId",
        "pageNumber",
        "token",
        "batchId",
        "sourcePage",
        "recordedAt",
        "method",
        "actor",
      ],
      ...state.receipts.map((r) => [
        r.id,
        r.collectionId,
        r.versionId,
        r.studentId,
        r.pageNumber,
        r.token ?? "",
        r.batchId,
        r.sourcePage,
        r.recordedAt,
        r.method,
        r.actor ?? "",
      ]),
    ],
    Batches: [
      [
        "batchId",
        "hash",
        "fileName",
        "pageCount",
        "collectionId",
        "createdAt",
        "recordedAt",
        "pagesJson",
        "sourceDriveFileId",
        "storageMode",
      ],
      ...state.batches.map((b) => [
        b.id,
        b.hash,
        b.fileName,
        b.pageCount,
        b.collectionId,
        b.createdAt,
        b.recordedAt ?? "",
        JSON.stringify(
          b.pages.map(({ thumbnail: _thumbnail, ...page }) => page),
        ),
        b.sourceDriveFileId ?? "",
        b.storageMode ?? "record-only",
      ]),
    ],
    Events: [
      ["eventId", "at", "action", "detail"],
      ...state.events.map((e) => [e.id, e.at, e.action, e.detail]),
    ],
    AppState: [],
    Metadata: [],
  };
}

function displayTimestamp(value: string, timezone: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  try {
    return new Intl.DateTimeFormat("ja-JP", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).format(date);
  } catch {
    throw new GoogleApiError(
      "INVALID_DATA",
      "学校のタイムゾーン設定を確認してください。",
    );
  }
}

/** Stable JSON hashes ignore property insertion order while preserving ordered arrays. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export async function hashText(value: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(hash)]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
export async function hashTables(tables: SheetRows): Promise<string> {
  // Summary is a recomputable, teacher-sortable view. Preserve remarks separately.
  return hashText(
    canonicalJson(
      Object.fromEntries(
        LEDGER_TABS.filter((name) => name !== "Summary").map((name) => [
          name,
          tables[name]
            .map((row) => {
              const copy = [...row];
              while (copy.length && copy.at(-1) === "") copy.pop();
              return copy;
            })
            .filter((row) => row.length),
        ]),
      ),
    ),
  );
}
export async function encodeSnapshot(
  state: AppState,
  accountId: string,
  operationId: string,
): Promise<{ tables: SheetRows; state: AppState; stateHash: string }> {
  const safe = sanitizeStateForStorage(state);
  if (!safe)
    throw new GoogleApiError(
      "INVALID_DATA",
      "台帳へ保存する記録の参照関係が壊れています。保存を停止しました。",
    );
  // One ledger is one class. Other classes remain in their own ledgers/local backup.
  delete safe.savedClasses;
  if (safe.settings) delete safe.settings.ledgerRevision;
  const serialized = canonicalJson(safe);
  if (serialized.length > 10_000_000)
    throw new GoogleApiError(
      "INVALID_DATA",
      "台帳のメタデータが大きすぎます。年度ごとにクラスを分けてください。",
    );
  const stateHash = await hashText(serialized);
  const chunks = [];
  for (let offset = 0; offset < serialized.length; offset += 30_000)
    chunks.push(serialized.slice(offset, offset + 30_000));
  const tables = ledgerRows(safe);
  // Pages are also kept in the canonical snapshot; split the tab into one row per page to avoid the 50k cell limit.
  tables.Batches = [
    [
      "batchId",
      "hash",
      "fileName",
      "pageCount",
      "collectionId",
      "createdAt",
      "recordedAt",
      "sourceDriveFileId",
      "storageMode",
      "pageJson",
    ],
    ...safe.batches.flatMap((b) =>
      (b.pages.length ? b.pages : [undefined]).map((page) => [
        b.id,
        b.hash,
        b.fileName,
        b.pageCount,
        b.collectionId,
        b.createdAt,
        b.recordedAt ?? "",
        b.sourceDriveFileId ?? "",
        b.storageMode ?? "record-only",
        page ? JSON.stringify(page) : "",
      ]),
    ),
  ];
  tables.AppState = [
    ["chunk", "json"],
    ...chunks.map((chunk, index) => [index, chunk]),
  ];
  tables.Metadata = [
    ["key", "value"],
    ["format", "paperflow-ledger-v2"],
    ["schemaVersion", 1],
    ["accountId", accountId],
    ["operationId", operationId],
    ["stateHash", stateHash],
    ["chunks", chunks.length],
  ];
  if (
    Object.values(tables).some((rows) =>
      rows.some((row) =>
        row.some((value) => typeof value === "string" && value.length > 49_000),
      ),
    )
  )
    throw new GoogleApiError(
      "INVALID_DATA",
      "台帳の1セルに入る文字数を超えています。備考や名簿の内容を確認してください。",
    );
  return { tables, state: safe, stateHash };
}
export async function decodeSnapshot(
  tables: SheetRows,
  expectedAccountId: string,
): Promise<{ state: AppState; operationId: string; stateHash: string }> {
  const meta = Object.fromEntries(
    tables.Metadata.slice(1).map((row) => [String(row[0]), row[1]]),
  );
  if (meta.format !== "paperflow-ledger-v2")
    throw new GoogleApiError(
      "INVALID_DATA",
      "この台帳は復元用データを含まない旧形式です。元のJSONバックアップを読み込み、新しい台帳へ保存してください。",
    );
  if (meta.accountId !== expectedAccountId)
    throw new GoogleApiError(
      "ACCOUNT_MISMATCH",
      "台帳を作成・保存したGoogleアカウントと接続中のアカウントが異なります。元の学校アカウントで接続してください。",
    );
  const rows = tables.AppState.slice(1);
  if (
    Number(meta.chunks) !== rows.length ||
    rows.some(
      (row, index) => Number(row[0]) !== index || typeof row[1] !== "string",
    )
  )
    throw new GoogleApiError(
      "INVALID_DATA",
      "台帳の復元データが欠けています。上書きせずバックアップを確認してください。",
    );
  const serialized = rows.map((row) => row[1]).join("");
  if (
    serialized.length > 10_000_000 ||
    (await hashText(serialized)) !== meta.stateHash
  )
    throw new GoogleApiError(
      "INVALID_DATA",
      "台帳の復元データが変更または破損しています。上書きを停止しました。",
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new GoogleApiError(
      "INVALID_DATA",
      "台帳の復元データを読み取れませんでした。",
    );
  }
  const state = sanitizeStateForStorage(parsed);
  if (!state)
    throw new GoogleApiError(
      "INVALID_DATA",
      "台帳の参照関係を検証できませんでした。欠損した記録を回収済みとして扱わず停止します。",
    );
  return {
    state,
    operationId: String(meta.operationId ?? ""),
    stateHash: String(meta.stateHash),
  };
}
export function summaryNotes(rows: CellValue[][]): Map<string, string> {
  const notes = new Map<string, string>();
  for (const row of rows.slice(1))
    if (
      typeof row[12] === "string" &&
      typeof row[13] === "string" &&
      typeof row[11] === "string"
    )
      notes.set(JSON.stringify([row[12], row[13]]), row[11]);
  return notes;
}
