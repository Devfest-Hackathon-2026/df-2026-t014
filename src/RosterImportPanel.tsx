import { useEffect, useRef, useState } from "react";
import { Upload } from "lucide-react";
import type { AppState } from "./domain/types";
import {
  csvIdentityCandidate,
  NEW_STUDENT,
  parseRosterCsv,
  type RosterCsvRow,
} from "./domain/rosterCsv";
import {
  applyReviewedRoster,
  rosterReviewKey,
  rosterRowsFromSheet,
  suggestRosterColumns,
  validateRosterRows,
  ROSTER_COLUMN_LABELS,
  type RosterColumn,
  type RosterColumns,
} from "./domain/rosterSheet";
import type { GoogleWorkspaceClient, RosterSpreadsheet } from "./google/client";
import { Notice } from "./ui";

interface Props {
  state: AppState;
  client?: GoogleWorkspaceClient;
  busy: boolean;
  sample: boolean;
  actor: string;
  onChange(next: AppState): void;
  onBusyChange?(busy: boolean): void;
  onOpenSettings?(): void;
}
const emptyColumns = (): RosterColumns => ({
  number: -1,
  name: -1,
  externalId: -1,
  row: -1,
  col: -1,
});
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function RosterImportPanel({
  state,
  client,
  busy,
  sample,
  actor,
  onChange,
  onBusyChange,
  onOpenSettings,
}: Props) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [spreadsheet, setSpreadsheet] = useState<RosterSpreadsheet>();
  const [sheetId, setSheetId] = useState("");
  const [grid, setGrid] = useState<string[][]>([]);
  const [headerRow, setHeaderRow] = useState(1);
  const [columns, setColumns] = useState<RosterColumns>(emptyColumns);
  const [rows, setRows] = useState<RosterCsvRow[]>([]);
  const [mapping, setMapping] = useState<Record<number, string>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [source, setSource] = useState<"csv" | "sheets">("csv");
  const [sourceLabel, setSourceLabel] = useState("");
  const [previewKey, setPreviewKey] = useState("");
  const [sourceAccount, setSourceAccount] = useState("");
  const reviewKey = rosterReviewKey(state);
  const latestKey = useRef(reviewKey);
  latestKey.current = reviewKey;
  const mounted = useRef(true);
  const locked = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const disabled = busy || working;
  const connected = client?.isConnected() ?? false;
  const connectedAccount = client?.getIdentity()?.id;
  const stale = rows.length > 0 && previewKey !== reviewKey;
  const sameAccount =
    source !== "sheets" || (connected && connectedAccount === sourceAccount);
  useEffect(() => {
    // Once a Sheets review loses its authorization, reconnecting must not
    // silently revive its old confirmation. A fresh selection/read is required.
    if (
      source === "sheets" &&
      sourceAccount &&
      (!connected || connectedAccount !== sourceAccount)
    ) {
      setSourceAccount("");
      setConfirmed(false);
    }
  }, [source, sourceAccount, connected, connectedAccount]);
  const width = Math.max(0, ...grid.map((row) => row.length));
  const newCount = rows.filter(
    (row) => mapping[row.row] === NEW_STUDENT,
  ).length;
  const selectedIds = new Set(
    Object.values(mapping).filter((value) => value && value !== NEW_STUDENT),
  );
  const retainedCount = state.students.filter(
    (student) => !selectedIds.has(student.id),
  ).length;
  function clearPreview() {
    setRows([]);
    setMapping({});
    setConfirmed(false);
    setPreviewKey("");
  }
  function review(
    parsed: RosterCsvRow[],
    kind: "csv" | "sheets",
    label: string,
    key: string,
    account = "",
  ) {
    validateRosterRows(parsed);
    if (key !== latestKey.current)
      throw new Error(
        "読み込み中にクラス・名簿・座席が変わりました。名簿を選び直してください。",
      );
    setRows(parsed);
    setMapping(
      Object.fromEntries(
        parsed.map((row) => [
          row.row,
          csvIdentityCandidate(row, state.students) ?? "",
        ]),
      ),
    );
    setSource(kind);
    setSourceLabel(label);
    setSourceAccount(account);
    setPreviewKey(key);
    setConfirmed(false);
  }
  function accountId() {
    const identity = client?.getIdentity();
    if (!identity)
      throw new Error("Googleに接続して名簿のSheetsを選択してください。");
    if (
      state.settings?.googleAccountId &&
      identity.id !== state.settings.googleAccountId
    )
      throw new Error("現在のクラスと接続中のGoogleアカウントが異なります。");
    return identity.id;
  }
  async function run(action: (key: string) => Promise<void>) {
    if (locked.current || disabled || sample) return;
    locked.current = true;
    setWorking(true);
    onBusyChange?.(true);
    setError("");
    setMessage("");
    try {
      await action(reviewKey);
    } catch (error) {
      if (mounted.current) setError(messageOf(error));
    } finally {
      locked.current = false;
      if (mounted.current) setWorking(false);
      onBusyChange?.(false);
    }
  }
  async function readCsv(file?: File) {
    if (!file) return;
    await run(async (key) => {
      clearPreview();
      setSpreadsheet(undefined);
      setGrid([]);
      if (file.size > 1024 * 1024)
        throw new Error("名簿CSVは1 MiB以下にしてください。");
      const text = await file.text();
      if (!mounted.current) return;
      review(parseRosterCsv(text), "csv", file.name, key);
    });
  }
  async function selectSpreadsheet() {
    await run(async (key) => {
      const account = accountId();
      const [picked] = await client!.pickFiles({
        kind: "spreadsheet",
        title: "出席番号・座席を補完する名簿のSheetsを選択",
      });
      if (!picked || !mounted.current) return;
      clearPreview();
      setGrid([]);
      setSpreadsheet(undefined);
      setSheetId("");
      const result = await client!.readRosterSpreadsheet(picked.id);
      if (!mounted.current) return;
      if (key !== latestKey.current || account !== accountId())
        throw new Error(
          "クラスまたはアカウントが変わりました。Sheetsを選び直してください。",
        );
      setSpreadsheet(result);
      setSheetId(String(result.sheets[0].sheetId));
      setSourceAccount(account);
    });
  }
  async function readSheet() {
    await run(async (key) => {
      if (!spreadsheet || sheetId === "") return;
      const account = accountId();
      if (sourceAccount !== account)
        throw new Error(
          "接続アカウントが変わりました。Sheetsを選び直してください。",
        );
      clearPreview();
      setGrid([]);
      const result = await client!.readRosterSheet(
        spreadsheet.id,
        Number(sheetId),
      );
      if (!mounted.current) return;
      if (key !== latestKey.current || account !== accountId())
        throw new Error(
          "クラスまたはアカウントが変わりました。Sheetsを選び直してください。",
        );
      setGrid(result.values);
      setHeaderRow(1);
      setColumns(suggestRosterColumns(result.values[0] ?? []));
      setSourceLabel(`${result.title} / ${result.sheetTitle}`);
      setPreviewKey(key);
      setSource("sheets");
    });
  }
  function previewSheet() {
    try {
      setError("");
      if (accountId() !== sourceAccount)
        throw new Error(
          "接続アカウントが変わりました。Sheetsを選び直してください。",
        );
      review(
        rosterRowsFromSheet(grid, headerRow, columns),
        "sheets",
        sourceLabel,
        previewKey,
        sourceAccount,
      );
    } catch (error) {
      setError(messageOf(error));
    }
  }
  function apply() {
    try {
      setError("");
      if (
        disabled ||
        sample ||
        !confirmed ||
        !rows.length ||
        rows.some((row) => !mapping[row.row])
      )
        return;
      if (source === "sheets" && accountId() !== sourceAccount)
        throw new Error("Googleに再接続し、同じ名簿を読み直してください。");
      const next = applyReviewedRoster(
        state,
        rows,
        mapping,
        {
          actor: actor || "local-teacher",
          reason: `${source === "sheets" ? "Sheets" : "CSV"}の列と全生徒の対応先を確認して名簿を補完`,
        },
        source,
        previewKey,
      );
      onChange(next);
      clearPreview();
      setGrid([]);
      setMessage(
        "確認した名簿を反映しました。発行済みの情報は保持されています。次に座席を確認し、Sheets台帳へ保存してください。",
      );
    } catch (error) {
      setError(messageOf(error));
    }
  }
  return (
    <details>
      <summary>Sheets・CSVで出席番号と座席を補完</summary>
      <p>
        現在のクラス「{state.className}
        」の名簿へ反映します。氏名だけでは同一人物と判断せず、全行の対応先を確認します。取り込まない既存生徒と発行済みの情報は保持します。
      </p>
      {sample && (
        <Notice>
          外部の名簿を使うときは、接続・設定でGoogleへ接続し、対象クラスを選んでください。
          {onOpenSettings && (
            <button className="button quiet" onClick={onOpenSettings}>
              接続・設定を開く
            </button>
          )}
        </Notice>
      )}
      <div className="seat-history-row">
        <button
          className="button secondary"
          disabled={disabled || sample || !connected}
          onClick={() => void selectSpreadsheet()}
        >
          名簿のSheetsを選ぶ
        </button>
        <label className="seat-csv-upload">
          <Upload size={17} /> UTF-8 CSVを選択
          <input
            type="file"
            accept=".csv,text/csv"
            disabled={disabled || sample}
            onChange={(event) => {
              void readCsv(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </label>
      </div>
      {!connected && !sample && (
        <p>
          Sheetsから読み込む場合は、先に接続・設定でGoogleへ接続してください。
        </p>
      )}
      <p className="fine-print">
        CSV必須列: 出席番号、氏名。任意列:
        生徒ID、行、列。座席は1始まり。Sheetsは読取り専用で、選んだ名簿自体を書き換えません。
      </p>
      {working && <p role="status">名簿を読み込んでいます…</p>}
      {error && <Notice danger>{error}</Notice>}
      {message && <p role="status">{message}</p>}
      {spreadsheet && (
        <div className="seat-history-row">
          <label>
            名簿のシート
            <select
              value={sheetId}
              disabled={disabled}
              onChange={(event) => {
                setSheetId(event.target.value);
                clearPreview();
                setGrid([]);
              }}
            >
              {spreadsheet.sheets.map((sheet) => (
                <option key={sheet.sheetId} value={sheet.sheetId}>
                  {sheet.title}
                </option>
              ))}
            </select>
          </label>
          <button
            className="button secondary"
            disabled={disabled || sample || !connected}
            onClick={() => void readSheet()}
          >
            選んだシートを読み込む
          </button>
        </div>
      )}
      {grid.length > 0 && (
        <section aria-label="名簿の列を確認">
          <p>
            {sourceLabel}
            ：見出しの行と列を確認してください。1シート2000行・52列以内、取込対象は1000人以内です。空行・空列もシートの大きさに含まれます。
          </p>
          <label>
            見出しの行
            <input
              type="number"
              min={1}
              max={grid.length - 1}
              value={headerRow}
              disabled={disabled}
              onChange={(event) => {
                const value = Number(event.target.value);
                setHeaderRow(value);
                setColumns(suggestRosterColumns(grid[value - 1] ?? []));
                setRows([]);
                setMapping({});
                setConfirmed(false);
              }}
            />
          </label>
          <div className="seat-number-list">
            {(Object.keys(ROSTER_COLUMN_LABELS) as RosterColumn[]).map(
              (field) => (
                <label key={field}>
                  {ROSTER_COLUMN_LABELS[field]}
                  <select
                    value={columns[field]}
                    disabled={disabled}
                    onChange={(event) => {
                      setColumns({
                        ...columns,
                        [field]: Number(event.target.value),
                      });
                      setRows([]);
                      setMapping({});
                      setConfirmed(false);
                    }}
                  >
                    <option value={-1}>
                      {field === "number" || field === "name"
                        ? "列を選択"
                        : "取り込まない"}
                    </option>
                    {Array.from({ length: width }, (_, index) => (
                      <option key={index} value={index}>
                        {index + 1}列目:{" "}
                        {grid[headerRow - 1]?.[index] || "（見出しなし）"}
                      </option>
                    ))}
                  </select>
                </label>
              ),
            )}
          </div>
          <div className="seat-csv-table">
            <table>
              <caption>選択した見出しから先頭3行</caption>
              <tbody>
                {grid
                  .slice(
                    Math.max(0, headerRow - 1),
                    Math.max(0, headerRow - 1) + 4,
                  )
                  .map((row, index) => (
                    <tr key={index}>
                      <th>{headerRow + index}行</th>
                      {Array.from({ length: width }, (_, column) => (
                        <td key={column}>{row[column] ?? ""}</td>
                      ))}
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <button
            className="button secondary"
            disabled={disabled || sample || !connected}
            onClick={previewSheet}
          >
            この列で対応先を確認
          </button>
        </section>
      )}
      {rows.length > 0 && (
        <>
          <p>
            <b>{sourceLabel}</b>：{rows.length}人。既存へ対応 {selectedIds.size}
            人、新規追加 {newCount}人。対応していない既存 {retainedCount}
            人は残します。
          </p>
          {stale && (
            <Notice danger>
              クラス・名簿・座席が変わりました。名簿を読み直してください。
            </Notice>
          )}
          {!sameAccount && (
            <Notice danger>
              Google接続が変わりました。同じアカウントで名簿を読み直してください。
            </Notice>
          )}
          <div className="seat-csv-table seat-csv-review">
            <table>
              <thead>
                <tr>
                  <th>元の行</th>
                  <th>取り込む氏名・番号・座席</th>
                  <th>対応先（確認必須）</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.row}>
                    <td>{row.row}</td>
                    <td>
                      {row.number}番 {row.name}
                      <small>
                        {row.seat
                          ? ` / ${row.seat.row + 1}行${row.seat.col + 1}列`
                          : " / 座席は既存を維持（新規は未配置）"}
                        {row.externalId ? ` / ID ${row.externalId}` : ""}
                      </small>
                    </td>
                    <td>
                      <select
                        aria-label={`${row.row}行目の対応先`}
                        value={mapping[row.row] ?? ""}
                        disabled={disabled || stale}
                        onChange={(event) => {
                          setMapping({
                            ...mapping,
                            [row.row]: event.target.value,
                          });
                          setConfirmed(false);
                        }}
                      >
                        <option value="">対応先を選択</option>
                        <option value={NEW_STUDENT}>
                          新しい生徒として追加
                        </option>
                        {state.students.map((student) => (
                          <option key={student.id} value={student.id}>
                            {student.number}番 {student.name} ·{" "}
                            {student.id.slice(-6)}
                            {student.enrollment === "withdrawn"
                              ? "（転出・再在籍）"
                              : ""}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <label className="seat-check">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={disabled || stale || !sameAccount}
              onChange={(event) => setConfirmed(event.target.checked)}
            />{" "}
            人数・氏名・番号・座席と、全行の対応先を確認しました
          </label>
          <button
            className="button secondary"
            disabled={
              disabled ||
              sample ||
              !confirmed ||
              stale ||
              !sameAccount ||
              rows.some((row) => !mapping[row.row])
            }
            onClick={apply}
          >
            確認した名簿を反映
          </button>
          <button
            className="button quiet"
            disabled={disabled}
            onClick={clearPreview}
          >
            取込を取り消す
          </button>
        </>
      )}
    </details>
  );
}
