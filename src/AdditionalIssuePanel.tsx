import { useState } from "react";
import { FilePlus2, RefreshCw } from "lucide-react";
import type { AppState, Collection, ProgressCallback } from "./domain/types";
import type { GoogleWorkspaceClient } from "./google/client";
import { issueAdditionalRecipients } from "./additionalIssueCloud";
import { isCollectionDeleting } from "./domain/lifecycle";
import { Notice } from "./ui";

export interface AdditionalIssuePanelProps {
  state: AppState;
  collection: Collection;
  client?: GoogleWorkspaceClient;
  sample: boolean;
  busy: boolean;
  sourcePdf?: Uint8Array;
  actor?: string;
  onCommit(next: AppState): Promise<void>;
  onGenerated(bytes: Uint8Array, title: string): void;
  onError(message: string): void;
  onProgress?: ProgressCallback;
  onBusyChange?(busy: boolean): void;
}

export function AdditionalIssuePanel({
  state,
  collection,
  client,
  sample,
  busy,
  sourcePdf,
  actor,
  onCommit,
  onGenerated,
  onError,
  onProgress,
  onBusyChange,
}: AdditionalIssuePanelProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const eligible = state.students.filter(
    (student) =>
      student.enrollment !== "withdrawn" &&
      !collection.recipients.some((recipient) => recipient.id === student.id),
  );
  const resumable = (state.operations ?? []).filter(
    (operation) =>
      operation.collectionId === collection.id &&
      operation.kind === "print" &&
      operation.studentIds?.length &&
      operation.studentIds.every((id) =>
        collection.pendingRecipientIds?.includes(id),
      ),
  );
  const disabled = busy || working;
  const canIssue =
    !collection.archivedAt &&
    !isCollectionDeleting(state, collection.id) &&
    !["draft", "generating", "closed"].includes(collection.status ?? "ready");
  async function issue(operationId?: string) {
    setWorking(true);
    onBusyChange?.(true);
    setMessage("");
    onError("");
    try {
      const result = await issueAdditionalRecipients({
        state,
        collectionId: collection.id,
        studentIds: selected,
        actor: actor ?? client?.getIdentity()?.email ?? "local-teacher",
        reason:
          reason.trim() || (operationId ? "準備済みの追加発行を再試行" : ""),
        sample,
        client,
        sourcePdf,
        operationId,
        onCommit,
        onProgress,
      });
      setSelected([]);
      setReason("");
      setMessage(
        sample
          ? "追加対象だけの印刷PDFを作成しました。"
          : "追加対象の台帳と印刷PDFを保存しました。",
      );
      onGenerated(result.bytes, result.title);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking(false);
      onBusyChange?.(false);
    }
  }
  return (
    <details className="panel" style={{ padding: 18, marginTop: 16 }}>
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>
        新しく対象になった生徒へ追加発行
      </summary>
      <p className="fine-print">
        同じ版の原稿で、既に発行した生徒とQRを保ったまま追加します。既対象者の紛失・欠席分は「再印刷」を使ってください。
      </p>
      {!canIssue && (
        <Notice>
          {isCollectionDeleting(state, collection.id)
            ? "整理・削除処理中、または削除済みのため追加発行を開始・再開できません。整理・削除の履歴を確認してください。"
            : "追加発行は発行済み・回収中の配布物で行えます。終了した配布物は先に再開してください。"}
        </Notice>
      )}
      {message && <p role="status">{message}</p>}
      {resumable.map((operation) => (
        <div
          className="integration-strip"
          key={operation.id}
          style={{ margin: "12px 0" }}
        >
          <span>
            追加発行準備中:{" "}
            {operation
              .studentIds!.map(
                (id) =>
                  collection.recipients.find((student) => student.id === id)
                    ?.name ?? id,
              )
              .join("、")}
            <small style={{ display: "block" }}>
              {operation.error ?? "同じQR・保存先で処理を続けます。"}
            </small>
          </span>
          <button
            className="button secondary"
            disabled={disabled || !canIssue}
            onClick={() => void issue(operation.id)}
          >
            <RefreshCw size={16} />
            追加発行を再開
          </button>
        </div>
      ))}
      {eligible.length > 0 ? (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))",
              gap: 8,
              margin: "16px 0",
              maxHeight: 240,
              overflow: "auto",
            }}
          >
            {eligible.map((student) => (
              <label key={student.id} className="checkbox-label">
                <input
                  type="checkbox"
                  checked={selected.includes(student.id)}
                  disabled={disabled || !canIssue}
                  onChange={(event) =>
                    setSelected((current) =>
                      event.target.checked
                        ? [...current, student.id]
                        : current.filter((id) => id !== student.id),
                    )
                  }
                />
                <span>
                  {student.number}番 {student.name}
                  <small style={{ display: "block" }}>
                    ID末尾 {student.id.slice(-6)}
                  </small>
                </span>
              </label>
            ))}
          </div>
          <label className="field">
            追加する理由
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              disabled={disabled || !canIssue}
              rows={2}
              placeholder="例: 転入した生徒へ配布"
            />
          </label>
          <button
            className="button secondary"
            disabled={
              disabled || !canIssue || !selected.length || !reason.trim()
            }
            onClick={() => void issue()}
          >
            <FilePlus2 size={16} />
            {working
              ? "追加発行しています…"
              : `${selected.length}人分を追加発行`}
          </button>
        </>
      ) : (
        <p className="fine-print">
          現在の名簿に未発行の生徒はいません。転入した生徒は名簿を同期・追加してから選択できます。
        </p>
      )}
    </details>
  );
}
