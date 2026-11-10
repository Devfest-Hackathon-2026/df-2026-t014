import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, Trash2, RotateCcw } from "lucide-react";
import type { AppState } from "./domain/types";
import type { GoogleWorkspaceClient } from "./google/client";
import {
  archiveCollections,
  unarchiveCollections,
  planCollectionCleanup,
  prepareCollectionCleanup,
  runCollectionCleanup,
  withSchoolYear,
} from "./domain/lifecycle";
import { Notice } from "./ui";

export interface ArchivePanelProps {
  state: AppState;
  client?: GoogleWorkspaceClient | null;
  busy: boolean;
  onCommit: (next: AppState) => Promise<void>;
  onError: (message: string) => void;
  onBusyChange?: (busy: boolean) => void;
}

/** All Drive effects are inside the teacher's explicit submit handler. */
export default function ArchivePanel({
  state,
  client,
  busy,
  onCommit,
  onError,
  onBusyChange,
}: ArchivePanelProps) {
  const [scope, setScope] = useState("all");
  const [action, setAction] = useState<"archive" | "unarchive" | "delete">(
    "archive",
  );
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [year, setYear] = useState(state.settings?.schoolYear ?? "");
  const [resumeId, setResumeId] = useState<string | null>(null);
  const lock = useRef(false);
  const resume = state.cleanupOperations?.find(
    (operation) => operation.id === resumeId && operation.status !== "complete",
  );
  const available = state.collections.filter(
    (collection) => !collection.deletedAt,
  );
  const selectedIds =
    resume?.collectionIds ??
    (scope === "all" ? available.map((collection) => collection.id) : [scope]);
  const selectionKey = selectedIds.join("\n");
  const review = useMemo(() => {
    try {
      return { plan: planCollectionCleanup(state, selectedIds), error: "" };
    } catch (error) {
      return {
        plan: null,
        error:
          error instanceof Error ? error.message : "対象を確認してください。",
      };
    }
    // Selection is represented by the stable opaque-ID key, not an array identity.
  }, [state, selectionKey]);
  const plan = review.plan;
  const pending =
    state.cleanupOperations?.filter(
      (operation) => operation.status !== "complete",
    ) ?? [];
  const overlapping = pending.some(
    (operation) =>
      operation.id !== resumeId &&
      operation.collectionIds.some((id) => selectedIds.includes(id)),
  );
  const expectedFiles = resume?.files ?? plan?.files ?? [];
  const toTrash = expectedFiles.filter((file) => file.status !== "protected");
  const shared = expectedFiles.filter((file) => file.status === "protected");
  const requiresGoogle =
    action === "delete" && toTrash.some((file) => file.status !== "trashed");
  const disabled = busy || working;

  useEffect(() => {
    setConfirmed(false);
  }, [plan?.fingerprint, action, resumeId]);
  useEffect(() => {
    setYear(state.settings?.schoolYear ?? "");
  }, [state.classId, state.settings?.schoolYear]);

  async function apply() {
    if (
      lock.current ||
      disabled ||
      !plan ||
      !confirmed ||
      !reason.trim() ||
      overlapping
    )
      return;
    lock.current = true;
    setWorking(true);
    onBusyChange?.(true);
    setMessage("");
    try {
      const identity = client?.getIdentity();
      if (requiresGoogle && (!client?.isConnected() || !identity))
        throw new Error(
          "対象ファイルを確認できるGoogleアカウントへ接続してください。",
        );
      if (
        requiresGoogle &&
        state.settings?.googleAccountId &&
        identity?.id !== state.settings.googleAccountId
      )
        throw new Error(
          "このクラスの台帳と接続アカウントが異なります。元のアカウントで接続してください。",
        );
      const context = {
        actor: identity?.email ?? "ローカル利用者",
        reason: reason.trim(),
      };
      if (action === "archive") {
        await onCommit(archiveCollections(state, plan.collectionIds, context));
        setMessage(
          `${plan.counts.collections}件をアーカイブしました。回収の終了状態・書類・台帳記録は維持しています。`,
        );
      } else if (action === "unarchive") {
        await onCommit(
          unarchiveCollections(state, plan.collectionIds, context),
        );
        setMessage(
          "選択した配布物のアーカイブを解除しました。回収状態は維持しています。",
        );
      } else {
        const started = resume
          ? { state, operation: resume }
          : prepareCollectionCleanup(state, plan, context);
        const accountId = identity?.id;
        const next = await runCollectionCleanup(
          started.state,
          started.operation.id,
          {
            onCommit,
            trashFile: async (fileId) => {
              if (
                !client?.isConnected() ||
                client.getIdentity()?.id !== accountId
              )
                throw new Error(
                  "Google接続が変わりました。同じアカウントへ再接続して再開してください。",
                );
              setMessage(
                `Driveの対象を確認しています（${fileId.slice(0, 8)}…）`,
              );
              const metadata = await client.getFile(fileId);
              if (metadata.mimeType !== "application/pdf")
                throw new Error(
                  "対象がPDFではないため移動を停止しました。元のDocs・台帳・フォルダは削除しません。",
                );
              // Reserved IDs may never have become files; a 404/permission error is
              // left unresolved, never silently counted as a successful deletion.
              if (!metadata.trashed) await client.trashFile(fileId);
            },
          },
        );
        const operation = next.cleanupOperations!.find(
          (item) => item.id === started.operation.id,
        )!;
        if (operation.status === "complete") {
          setMessage(
            `${operation.collectionIds.length}件の整理を完了しました。共有ファイル${operation.files.filter((file) => file.status === "protected").length}件と台帳の証跡は残しています。`,
          );
          setResumeId(null);
        } else {
          setResumeId(operation.id);
          onError(
            "一部のファイルをゴミ箱へ移動できませんでした。成功済みのファイルを再送せず、保存した計画から再開できます。",
          );
        }
      }
      setConfirmed(false);
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "整理を完了できませんでした。",
      );
    } finally {
      lock.current = false;
      setWorking(false);
      onBusyChange?.(false);
    }
  }

  async function saveYear() {
    if (lock.current || disabled) return;
    lock.current = true;
    setWorking(true);
    onBusyChange?.(true);
    try {
      await onCommit(withSchoolYear(state, year));
      setMessage("年度表示を保存しました。対象範囲は現在のクラス全体です。");
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "年度を保存できませんでした。",
      );
    } finally {
      lock.current = false;
      setWorking(false);
      onBusyChange?.(false);
    }
  }

  return (
    <section
      className="panel"
      style={{ padding: 24 }}
      aria-label="年度・配布物の整理"
    >
      <h2>年度・配布物の整理</h2>
      <p className="muted">
        アーカイブは一覧を整理する操作です。回収を終了する操作と区別して記録します。
      </p>
      <div className="field-row">
        <label className="field">
          現在のクラスの年度
          <input
            value={year}
            inputMode="numeric"
            maxLength={4}
            placeholder="例：2026"
            disabled={disabled}
            onChange={(event) => setYear(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="button secondary"
          disabled={disabled || year === (state.settings?.schoolYear ?? "")}
          onClick={() => void saveYear()}
        >
          年度表示を保存
        </button>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void apply();
        }}
      >
        <fieldset
          disabled={disabled}
          style={{ border: 0, padding: 0, margin: 0 }}
        >
          <div className="field-row">
            <label className="field">
              対象
              <select
                value={resume ? "resume" : scope}
                onChange={(event) => {
                  setScope(event.target.value);
                  setResumeId(null);
                  setConfirmed(false);
                }}
              >
                {resume && (
                  <option value="resume">
                    保存した削除計画の{resume.collectionIds.length}件
                  </option>
                )}
                <option value="all">
                  現在のクラス全体
                  {state.settings?.schoolYear
                    ? `（${state.settings.schoolYear}年度）`
                    : "（年度の整理）"}
                </option>
                {available.map((collection) => (
                  <option key={collection.id} value={collection.id}>
                    {collection.title} /{" "}
                    {collection.versionLabel ??
                      collection.versionId.slice(0, 8)}
                    {collection.archivedAt ? "（アーカイブ済み）" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              操作
              <select
                value={action}
                onChange={(event) => {
                  setAction(
                    event.target.value as "archive" | "unarchive" | "delete",
                  );
                  setResumeId(null);
                }}
              >
                <option value="archive">アーカイブする</option>
                <option value="unarchive">アーカイブを解除する</option>
                <option value="delete">
                  関連PDFをゴミ箱へ移し、台帳を論理削除
                </option>
              </select>
            </label>
          </div>
          {scope === "all" && !resume && (
            <p className="muted">
              現在のクラスにある配布物をすべて対象にします。年度表示を変えても、作成日から自動で絞り込みません。
            </p>
          )}
          {plan ? (
            <>
              <p>
                <b>配布物{plan.counts.collections}件</b>：
                {plan.titles.join("、")}
              </p>
              <p>
                対応token {plan.counts.tokens}件 ／ 対象者の対応{" "}
                {plan.counts.recipients}件 ／ 回収記録 {plan.counts.receipts}件
                ／ 回収PDF {plan.counts.batches}束・確認ページ{" "}
                {plan.counts.pages}件 ／ 成果物記録 {plan.counts.artifacts}件 ／
                保存操作 {plan.counts.operations}件
              </p>
              <p>
                Driveファイル {toTrash.length}件 ／ 共有・保護対象として残す{" "}
                {shared.length}件
              </p>
              {action === "delete" && (
                <Notice danger>
                  対象のPDFをDriveのゴミ箱へ移します。削除開始時点で対象tokenを無効にし、台帳には削除済みの印と対応情報・操作履歴を残します。元のGoogle
                  Docs、管理台帳、保存先フォルダ、他の配布物と共有するファイルは残します。
                </Notice>
              )}
              {expectedFiles.length > 0 && (
                <details>
                  <summary>
                    対象ファイルを確認する（{expectedFiles.length}件）
                  </summary>
                  <ul>
                    {expectedFiles.map((file) => (
                      <li
                        key={file.fileId}
                        style={{ overflowWrap: "anywhere", marginBottom: 8 }}
                      >
                        <a
                          href={`https://drive.google.com/file/d/${encodeURIComponent(file.fileId)}/view`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {file.name}
                        </a>{" "}
                        —{" "}
                        {
                          (
                            {
                              pending: "移動予定",
                              protected: "残す",
                              trashed: "移動済み",
                              failed: "再試行が必要",
                            } as const
                          )[file.status]
                        }
                        {file.error ? `：${file.error}` : ""}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <label className="field">
                整理する理由
                <textarea
                  required
                  maxLength={500}
                  rows={2}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="例：2026年度の保管期間が終了したため"
                />
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                対象の配布物・件数・残すファイルを確認しました
              </label>
              {overlapping && (
                <Notice>
                  対象に未完了の削除があります。下の保存計画を選び直して再開してください。
                </Notice>
              )}
              {requiresGoogle && !client?.isConnected() && (
                <Notice>
                  ファイル整理には、元の保存アカウントへのGoogle接続が必要です。
                </Notice>
              )}
              <button
                type="submit"
                className={
                  action === "delete" ? "button secondary" : "button primary"
                }
                disabled={
                  disabled ||
                  !confirmed ||
                  !reason.trim() ||
                  overlapping ||
                  (requiresGoogle && !client?.isConnected())
                }
                style={{ marginTop: 16 }}
              >
                {action === "delete" ? (
                  <Trash2 size={16} />
                ) : (
                  <Archive size={16} />
                )}
                {action === "delete"
                  ? resume
                    ? "確認した計画の削除を再開"
                    : "確認した対象をゴミ箱へ移す"
                  : action === "unarchive"
                    ? "確認した対象のアーカイブを解除"
                    : "確認した対象をアーカイブ"}
              </button>
            </>
          ) : (
            <Notice>{review.error}</Notice>
          )}
        </fieldset>
      </form>
      {pending.length > 0 && (
        <div style={{ marginTop: 22 }}>
          <h3>未完了の削除計画</h3>
          {pending.map((operation) => (
            <div key={operation.id} style={{ marginBottom: 12 }}>
              <p>
                {operation.collectionIds.length}件 / 移動済み
                {
                  operation.files.filter((file) => file.status === "trashed")
                    .length
                }
                ファイル — {operation.reason}
              </p>
              <button
                type="button"
                className="button secondary"
                disabled={disabled}
                onClick={() => {
                  setResumeId(operation.id);
                  setAction("delete");
                  setReason(operation.reason);
                  setConfirmed(false);
                }}
              >
                <RotateCcw size={15} />
                この計画の対象を再確認
              </button>
            </div>
          ))}
        </div>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
