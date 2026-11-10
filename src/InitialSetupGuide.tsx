import { useState } from "react";
import type { AppState } from "./domain/types";
import { validateStudents } from "./domain/logic";
import type { GoogleWorkspaceClient } from "./google/client";
import { Notice } from "./ui";

interface Props {
  state: AppState;
  client?: GoogleWorkspaceClient;
  sample: boolean;
  busy: boolean;
  onOpenSettings?(): void;
  onSaveLedger?(): void;
}

/** A local review guide; checking boxes never sends data or claims a Google save succeeded. */
export function InitialSetupGuide({
  state,
  client,
  sample,
  busy,
  onOpenSettings,
  onSaveLedger,
}: Props) {
  const active = state.students.filter(
    (student) => student.enrollment !== "withdrawn",
  );
  const rosterKey = JSON.stringify([
    state.classId ?? state.className,
    active.map((s) => [s.id, s.name, s.number]),
  ]);
  const seatsKey = JSON.stringify([
    rosterKey,
    active.map((s) => [s.id, s.seat]),
    state.settings?.activeSeatLayoutId,
  ]);
  const [confirmedRoster, setConfirmedRoster] = useState("");
  const [confirmedSeats, setConfirmedSeats] = useState("");
  const errors = validateStudents(state.students);
  const connected = client?.isConnected() ?? false;
  const rosterChecked = confirmedRoster === rosterKey;
  const seatsChecked = confirmedSeats === seatsKey;
  const layout = state.seatLayouts?.find(
    (item) => item.id === state.settings?.activeSeatLayoutId,
  );
  const unplaced = active.filter(
    (s) =>
      !s.seat ||
      (layout && (s.seat.row >= layout.rows || s.seat.col >= layout.cols)),
  ).length;
  const saveReady =
    !sample &&
    connected &&
    active.length > 0 &&
    !errors.length &&
    rosterChecked &&
    seatsChecked &&
    !!state.settings?.folderId;
  return (
    <details className="panel" open={!state.settings?.ledgerId}>
      <summary>初回設定：クラス → 人数・番号 → 座席 → 保存先</summary>
      <ol>
        <li>
          <b>Google接続・対象クラス</b>
          <p>
            {sample
              ? "現在は架空サンプルです。実名簿の設定は接続・設定から始めてください。"
              : `${state.className} / ${connected ? "Google接続中" : "Google未接続"}`}
          </p>
          {onOpenSettings && (
            <button
              className="button quiet"
              disabled={busy}
              onClick={onOpenSettings}
            >
              接続・クラスを確認
            </button>
          )}
        </li>
        <li>
          <b>人数と出席番号</b>
          <p>
            在籍 {active.length}
            人。Classroomの仮番号は正式な出席番号として確定せず、下の番号編集またはSheets・CSV取込で確認してください。
          </p>
          <label className="seat-check">
            <input
              type="checkbox"
              disabled={busy || sample || !active.length || !!errors.length}
              checked={rosterChecked}
              onChange={(e) =>
                setConfirmedRoster(e.target.checked ? rosterKey : "")
              }
            />{" "}
            対象クラスの人数と全員の番号を確認しました
          </label>
        </li>
        <li>
          <b>座席と配布順</b>
          <p>
            未配置 {unplaced}
            人。下の座席表で行列・通路・配布順を編集し、「配置・順序を保存」で確定します。未配置者は発行時に扱いを選びます。
          </p>
          <label className="seat-check">
            <input
              type="checkbox"
              disabled={busy || sample || !rosterChecked}
              checked={seatsChecked}
              onChange={(e) =>
                setConfirmedSeats(e.target.checked ? seatsKey : "")
              }
            />{" "}
            座席・未配置者・配布順を確認しました
          </label>
        </li>
        <li>
          <b>保存先と台帳</b>
          <p>
            {state.settings?.folderId
              ? "保存先フォルダを選択済みです。"
              : "接続・設定でDrive保存先フォルダを選択してください。"}
            確認後にSheetsへ保存すると、このクラスの設定を次回も利用できます。
          </p>
          {onOpenSettings && (
            <button
              className="button quiet"
              disabled={busy || sample || !rosterChecked || !seatsChecked}
              onClick={onOpenSettings}
            >
              保存先を確認
            </button>
          )}
          {onSaveLedger && (
            <button
              className="button secondary"
              disabled={busy || !saveReady}
              onClick={onSaveLedger}
            >
              確認した設定をSheetsへ保存
            </button>
          )}
        </li>
      </ol>
      {!!errors.length && <Notice danger>{errors.join(" / ")}</Notice>}
      <p className="fine-print">
        チェックだけではGoogleに送信しません。台帳への保存結果は画面の同期状態で確認してください。
      </p>
    </details>
  );
}
