import { useEffect, useId, useState } from "react";
import { ArrowDownUp, History, Save } from "lucide-react";
import type {
  AppState,
  Collection,
  DistributionOrder,
  QrCorner,
  Student,
} from "./domain/types";
import {
  getStudentStatus,
  orderStudents,
  validateStudents,
} from "./domain/logic";
import {
  changeEvent,
  restoreSeatLayout,
  saveSeatLayout,
} from "./domain/workflows";
import type { GoogleWorkspaceClient } from "./google/client";
import { RosterImportPanel } from "./RosterImportPanel";
import { InitialSetupGuide } from "./InitialSetupGuide";
import { Badge, Notice } from "./ui";
import "./SeatPanel.css";

interface SeatPanelProps {
  state: AppState;
  collection?: Collection;
  busy: boolean;
  onChange(next: AppState): void;
  actor: string;
  onCollectionChange(id: string): void;
  client?: GoogleWorkspaceClient;
  sample?: boolean;
  onBusyChange?(busy: boolean): void;
  onOpenSettings?(): void;
  onSaveLedger?(): void;
}
const orderLabels: Record<DistributionOrder, string> = {
  row: "横方向",
  column: "縦方向",
  snake: "蛇行",
  number: "出席番号順",
};
const statusLabels = {
  uncollected: "未回収",
  partial: "一部回収",
  complete: "回収済み",
  exempt: "免除",
  superseded: "別の版を使用",
};
const sameSeat = (a: Student["seat"], b: Student["seat"]) =>
  !!a && !!b && a.row === b.row && a.col === b.col;
const cornerLabels: Record<QrCorner, string> = {
  "top-left": "左上から",
  "top-right": "右上から",
  "bottom-left": "左下から",
  "bottom-right": "右下から",
};
const dimensions = (students: Student[]) => ({
  rows: Math.max(1, ...students.map((s) => (s.seat?.row ?? 0) + 1)),
  cols: Math.max(1, ...students.map((s) => (s.seat?.col ?? 0) + 1)),
});

export function SeatPanel({
  state,
  collection,
  busy,
  onChange,
  actor,
  onCollectionChange,
  client,
  sample = false,
  onBusyChange,
  onOpenSettings,
  onSaveLedger,
}: SeatPanelProps) {
  const activeLayout = state.seatLayouts?.find(
    (layout) => layout.id === state.settings?.activeSeatLayoutId,
  );
  const initial = activeLayout ?? dimensions(state.students);
  const [rows, setRows] = useState(initial.rows);
  const [cols, setCols] = useState(initial.cols);
  const [blocked, setBlocked] = useState(activeLayout?.blockedCells ?? []);
  const [order, setOrder] = useState<DistributionOrder>(
    state.settings?.defaultOrder ?? "snake",
  );
  const [reverse, setReverse] = useState(
    state.settings?.defaultReverse ?? false,
  );
  const [issued, setIssued] = useState(false);
  const [startCorner, setStartCorner] = useState<QrCorner>(
    state.settings?.defaultStartCorner ?? "top-left",
  );
  const [aisleMode, setAisleMode] = useState(false);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [layoutName, setLayoutName] = useState("");
  const [reason, setReason] = useState("");
  const [historyId, setHistoryId] = useState("");
  const [numberDraft, setNumberDraft] = useState<Record<string, string>>({});
  const markerId = useId().replace(/:/g, "");
  const classKey = state.classId ?? state.className;
  const numberKey = state.students
    .map((student) => `${student.id}:${student.number}`)
    .join("|");
  useEffect(() => {
    const layout = state.seatLayouts?.find(
      (item) => item.id === state.settings?.activeSeatLayoutId,
    );
    const size = layout ?? dimensions(state.students);
    setRows(size.rows);
    setCols(size.cols);
    setBlocked(layout?.blockedCells ?? []);
    setOrder(state.settings?.defaultOrder ?? "snake");
    setReverse(state.settings?.defaultReverse ?? false);
    setStartCorner(state.settings?.defaultStartCorner ?? "top-left");
    setSelected("");
    setHistoryId("");
  }, [classKey, state.settings?.activeSeatLayoutId]);
  useEffect(() => {
    setNumberDraft(
      Object.fromEntries(
        state.students.map((student) => [student.id, String(student.number)]),
      ),
    );
  }, [numberKey]);

  const readOnly = issued && !!collection;
  const shown = readOnly
    ? collection.recipients
    : state.students.filter((student) => student.enrollment !== "withdrawn");
  const issuedLayout = readOnly
    ? state.seatLayouts?.find((layout) => layout.id === collection.seatLayoutId)
    : undefined;
  const shownSize = readOnly
    ? (issuedLayout ?? dimensions(shown))
    : { rows, cols };
  const shownBlocked = readOnly ? (issuedLayout?.blockedCells ?? []) : blocked;
  const shownOrder = readOnly ? collection.order : order;
  const shownReverse = readOnly ? collection.reverse : reverse;
  const shownCorner = readOnly ? collection.startCorner : startCorner;
  const inBounds = (student: Student) =>
    !!student.seat &&
    student.seat.row < shownSize.rows &&
    student.seat.col < shownSize.cols;
  const unplaced = shown.filter((student) => !inBounds(student));
  const route = orderStudents(shown, shownOrder, shownReverse, shownCorner);
  const placedRoute = route.filter(inBounds);
  const selectedStudent = shown.find((student) => student.id === selected);
  const pendingCount = collection
    ? state.batches
        .filter((batch) => batch.collectionId === collection.id)
        .reduce(
          (count, batch) =>
            count +
            batch.pages.filter((page) => page.resolution === "pending").length,
          0,
        )
    : 0;
  const context = (fallback: string) => ({
    actor: actor || "local-teacher",
    reason: reason.trim() || fallback,
  });
  const run = (action: () => void) => {
    try {
      setError("");
      setMessage("");
      action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  function commitStudents(students: Student[], action: string, detail: string) {
    const errors = validateStudents(students);
    if (errors.length) throw new Error(errors.join("\n"));
    onChange({
      ...state,
      students,
      events: [
        ...state.events,
        changeEvent(
          action,
          classKey,
          context(detail),
          state.students,
          students,
        ),
      ],
    });
  }
  function chooseCell(row: number, col: number) {
    if (busy || readOnly) return;
    const seat = { row, col };
    const occupant = shown.find((student) => sameSeat(student.seat, seat));
    if (aisleMode) {
      if (occupant) {
        setError("生徒を移動してから、通路に変更してください。");
        return;
      }
      setBlocked((current) =>
        current.some((cell) => sameSeat(cell, seat))
          ? current.filter((cell) => !sameSeat(cell, seat))
          : [...current, seat],
      );
      return;
    }
    if (shownBlocked.some((cell) => sameSeat(cell, seat))) return;
    if (!selectedStudent) {
      setSelected(occupant?.id ?? "");
      return;
    }
    if (occupant?.id === selectedStudent.id) {
      setSelected("");
      return;
    }
    run(() => {
      const before = selectedStudent.seat;
      const students = state.students.map((student) =>
        student.id === selectedStudent.id
          ? { ...student, seat }
          : student.id === occupant?.id
            ? { ...student, seat: before }
            : student,
      );
      commitStudents(
        students,
        "move_seat",
        occupant ? "座席を入れ替え" : "座席を移動",
      );
      setSelected("");
    });
  }
  function saveLayout() {
    run(() => {
      onChange(
        saveSeatLayout(
          state,
          {
            rows,
            cols,
            blockedCells: blocked,
            name: layoutName,
            order,
            reverse,
            startCorner,
          },
          context("座席配置と配布順を保存"),
        ),
      );
      setMessage("現在の配置と配布順を履歴に保存しました。");
    });
  }

  return (
    <div className="seat-workspace">
      <div className="seat-workspace-heading">
        <div>
          <h2>座席と配布順</h2>
          <p>席を選んで移動先を押すと、移動・入れ替えができます。</p>
        </div>
        <div className="seat-view-controls">
          <label>
            回収状況の配布物
            <select
              aria-label="座席表に表示する配布物"
              value={collection?.id ?? ""}
              onChange={(e) => onCollectionChange(e.target.value)}
              disabled={busy || !state.collections.length}
            >
              {!collection && <option value="">選択してください</option>}
              {state.collections.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title} · {item.versionLabel ?? `v${item.revision ?? 1}`}
                </option>
              ))}
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={issued}
              onChange={(e) => {
                setIssued(e.target.checked);
                setSelected("");
              }}
              disabled={!collection}
            />{" "}
            発行時の配置を表示
          </label>
        </div>
      </div>
      {!readOnly && (
        <InitialSetupGuide
          key={classKey}
          state={state}
          client={client}
          sample={sample}
          busy={busy}
          onOpenSettings={onOpenSettings}
          onSaveLedger={onSaveLedger}
        />
      )}
      {error && <Notice danger>{error}</Notice>}
      {message && (
        <div className="seat-message" role="status">
          {message}
        </div>
      )}
      {pendingCount > 0 && (
        <Notice>
          この配布物には要確認のページが {pendingCount}{" "}
          ページあります。座席の回収状況は確定した記録だけを表示します。
        </Notice>
      )}
      {readOnly ? (
        <Notice>
          発行時の名簿・配布順を表示中です。現在の名簿を変更しても、この版の発行時情報は変わりません。
        </Notice>
      ) : (
        <>
          <div className="seat-toolbar">
            <label>
              行
              <input
                type="number"
                min="1"
                max="100"
                value={rows}
                disabled={busy}
                onChange={(e) =>
                  setRows(Math.min(100, Math.max(1, Number(e.target.value))))
                }
              />
            </label>
            <label>
              列
              <input
                type="number"
                min="1"
                max="100"
                value={cols}
                disabled={busy}
                onChange={(e) =>
                  setCols(Math.min(100, Math.max(1, Number(e.target.value))))
                }
              />
            </label>
            <label>
              配布順
              <select
                value={order}
                onChange={(e) => setOrder(e.target.value as DistributionOrder)}
                disabled={busy}
              >
                {Object.entries(orderLabels).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              開始位置
              <select
                aria-label="配布の開始位置"
                value={startCorner}
                onChange={(e) => setStartCorner(e.target.value as QrCorner)}
                disabled={busy || order === "number"}
              >
                {Object.entries(cornerLabels).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="seat-check">
              <input
                type="checkbox"
                checked={reverse}
                onChange={(e) => setReverse(e.target.checked)}
                disabled={busy}
              />{" "}
              逆順
            </label>
            <label className="seat-check">
              <input
                type="checkbox"
                checked={aisleMode}
                onChange={(e) => {
                  setAisleMode(e.target.checked);
                  setSelected("");
                }}
                disabled={busy}
              />{" "}
              通路を編集
            </label>
            <button
              className="button secondary"
              disabled={busy}
              onClick={saveLayout}
            >
              <Save size={16} />
              配置・順序を保存
            </button>
          </div>
          <p className="seat-help">
            通路・行列・配布順は「配置・順序を保存」で確定します。
            {order === "number"
              ? "番号順では未配置の人も番号に従います。"
              : "未配置の人は、逆順でも番号順で最後にまとめます。"}
          </p>
        </>
      )}
      <div className="seat-route-summary">
        <ArrowDownUp size={17} />
        <b>
          {orderLabels[shownOrder]}
          {shownOrder !== "number"
            ? `・${cornerLabels[shownCorner ?? "top-left"]}`
            : ""}
          {shownReverse ? "・逆順" : ""}
        </b>
        <span>
          開始:{" "}
          {route[0] ? `${route[0].number}番 ${route[0].name}` : "対象なし"}
        </span>
        <span>終了: {route.at(-1) ? `${route.at(-1)!.number}番` : "—"}</span>
      </div>
      <div className="seat-board-scroll">
        <div
          className="seat-board"
          style={{
            width: Math.max(380, shownSize.cols * 124),
            minWidth: Math.max(380, shownSize.cols * 124),
          }}
        >
          <div className="seat-blackboard">黒板・教卓</div>
          <div
            className="seat-board-grid"
            style={{
              gridTemplateColumns: `repeat(${shownSize.cols}, minmax(0, 1fr))`,
            }}
          >
            <svg
              className="seat-route-lines"
              viewBox={`0 0 ${shownSize.cols * 100} ${shownSize.rows * 100}`}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <defs>
                <marker
                  id={markerId}
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="4"
                  markerHeight="4"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" />
                </marker>
              </defs>
              {placedRoute.slice(1).map((student, index) => (
                <line
                  key={student.id}
                  x1={placedRoute[index].seat!.col * 100 + 50}
                  y1={placedRoute[index].seat!.row * 100 + 50}
                  x2={student.seat!.col * 100 + 50}
                  y2={student.seat!.row * 100 + 50}
                  markerEnd={`url(#${markerId})`}
                />
              ))}
            </svg>
            {Array.from(
              { length: shownSize.rows * shownSize.cols },
              (_, index) => {
                const row = Math.floor(index / shownSize.cols),
                  col = index % shownSize.cols;
                const student = shown.find((item) =>
                  sameSeat(item.seat, { row, col }),
                );
                const aisle = shownBlocked.some((cell) =>
                  sameSeat(cell, { row, col }),
                );
                const status =
                  student &&
                  collection?.recipients.some((item) => item.id === student.id)
                    ? getStudentStatus(collection, student.id, state.receipts)
                    : undefined;
                const routeIndex = student
                  ? route.findIndex((item) => item.id === student.id)
                  : -1;
                return (
                  <button
                    key={index}
                    className={`seat-board-cell ${aisle ? "seat-aisle" : ""} ${student ? "seat-occupied" : ""} ${selected === student?.id ? "seat-selected" : ""} ${status ? `seat-status-${status.status}` : ""}`}
                    onClick={() => chooseCell(row, col)}
                    disabled={busy || readOnly}
                    aria-label={`${row + 1}行${col + 1}列 ${student ? `${student.number}番 ${student.name} ${status ? statusLabels[status.status] : ""}` : aisle ? "通路" : "空席"}`}
                    aria-pressed={!!student && selected === student.id}
                  >
                    {student ? (
                      <>
                        <span className="seat-number">
                          {student.number}
                          <small>番</small>
                          <em>
                            {routeIndex === 0 ? "開始" : `${routeIndex + 1}順`}
                          </em>
                        </span>
                        <strong title={student.name}>{student.name}</strong>
                        <span className="seat-status-text">
                          {status
                            ? `${statusLabels[status.status]}${status.status === "partial" ? ` ${status.receivedCount}/${status.requiredCount}` : ""}`
                            : "回収対象外"}
                        </span>
                      </>
                    ) : (
                      <span>{aisle ? "通路" : "空席"}</span>
                    )}
                  </button>
                );
              },
            )}
          </div>
        </div>
      </div>
      <div className="seat-legend">
        <Badge tone="green">回収済み</Badge>
        <Badge tone="amber">一部回収</Badge>
        <Badge>未回収</Badge>
        <span>
          矢印は配布の順序です。開始位置は四隅から選べます。逆順では生徒の束ごと並びを反転します。
        </span>
      </div>
      {!readOnly && selectedStudent && (
        <div className="seat-selected-actions">
          <b>
            {selectedStudent.number}番 {selectedStudent.name} を選択中
          </b>
          <button
            className="button secondary"
            disabled={busy}
            onClick={() =>
              run(() => {
                commitStudents(
                  state.students.map((student) =>
                    student.id === selectedStudent.id
                      ? { ...student, seat: null }
                      : student,
                  ),
                  "unplace_seat",
                  "座席を未配置へ変更",
                );
                setSelected("");
              })
            }
          >
            未配置へ移す
          </button>
          <button className="button quiet" onClick={() => setSelected("")}>
            選択解除
          </button>
        </div>
      )}
      <div className="seat-unplaced">
        <h3>
          未配置・表示範囲外 <span>{unplaced.length}人</span>
        </h3>
        <p>
          未配置の人を選び、空席を押すと配置できます。範囲外の席は広げるか、移動してから保存してください。
        </p>
        <div>
          {unplaced.map((student) => (
            <button
              key={student.id}
              className={`seat-person-chip ${selected === student.id ? "selected" : ""}`}
              disabled={busy || readOnly}
              onClick={() => setSelected(student.id)}
            >
              {student.number}番 {student.name}
              {student.seat && <small>範囲外</small>}
            </button>
          ))}
          {!unplaced.length && <span className="seat-help">全員配置済み</span>}
        </div>
      </div>
      {!readOnly && (
        <div className="seat-editor-details">
          <section>
            <h3>
              <History size={18} /> 配置の履歴
            </h3>
            <label>
              履歴の名前
              <input
                value={layoutName}
                onChange={(e) => setLayoutName(e.target.value)}
                placeholder="例: 11月の席替え"
                disabled={busy}
              />
            </label>
            <label>
              変更理由
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="例: 席替え・名簿の訂正"
                disabled={busy}
              />
            </label>
            <div className="seat-history-row">
              <select
                aria-label="復元する座席履歴"
                value={historyId}
                onChange={(e) => setHistoryId(e.target.value)}
                disabled={busy}
              >
                <option value="">履歴を選択</option>
                {[...(state.seatLayouts ?? [])].reverse().map((layout) => (
                  <option key={layout.id} value={layout.id}>
                    {layout.name} ·{" "}
                    {new Date(layout.createdAt).toLocaleDateString("ja-JP")}
                  </option>
                ))}
              </select>
              <button
                className="button secondary"
                disabled={busy || !historyId}
                onClick={() =>
                  run(() => {
                    onChange(
                      restoreSeatLayout(
                        state,
                        historyId,
                        context("座席の履歴を復元"),
                      ),
                    );
                    setMessage(
                      "現在の氏名・番号を保ち、座席と配布順を復元しました。",
                    );
                  })
                }
              >
                復元
              </button>
            </div>
          </section>
          <details>
            <summary>出席番号を編集</summary>
            <p>番号を入れ替える場合は、変更をまとめて保存します。</p>
            <div className="seat-number-list">
              {state.students
                .filter((student) => student.enrollment !== "withdrawn")
                .map((student) => (
                  <label key={student.id}>
                    <span title={student.name}>{student.name}</span>
                    <input
                      aria-label={`${student.name}の出席番号（ID ${student.id.slice(-6)}）`}
                      type="number"
                      min="1"
                      value={numberDraft[student.id] ?? student.number}
                      onChange={(e) =>
                        setNumberDraft({
                          ...numberDraft,
                          [student.id]: e.target.value,
                        })
                      }
                      disabled={busy}
                    />
                  </label>
                ))}
            </div>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() =>
                run(() => {
                  commitStudents(
                    state.students.map((student) => ({
                      ...student,
                      number: Number(numberDraft[student.id] ?? student.number),
                    })),
                    "edit_attendance_numbers",
                    "出席番号を訂正",
                  );
                  setMessage(
                    "出席番号を保存しました。発行済みの名簿は変更されません。",
                  );
                })
              }
            >
              番号を保存
            </button>
          </details>
          <RosterImportPanel
            key={classKey}
            state={state}
            client={client}
            sample={sample}
            busy={busy}
            actor={actor}
            onChange={onChange}
            onBusyChange={onBusyChange}
            onOpenSettings={onOpenSettings}
          />
        </div>
      )}
    </div>
  );
}
