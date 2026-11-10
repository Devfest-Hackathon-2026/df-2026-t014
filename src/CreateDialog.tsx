import { useCallback, useEffect, useMemo, useState } from "react";
import { Users, FileText, FilePlus2, LoaderCircle } from "lucide-react";
import type {
  Collection,
  ClassSettings,
  DistributionOrder,
  QrCorner,
  Progress,
  Student,
} from "./domain/types";
import { createCollection, orderStudents } from "./domain/logic";
import { generatePrintPreview, inspectSourcePdf } from "./pdfClient";
import { printLayoutMetrics, type LayoutMode } from "./pdf/geometry";
import { PdfPreview } from "./PdfPreview";
import { Modal, Notice, ProgressBar } from "./ui";
import "./CreateDialog.css";
import type { DocsSettings } from "./google/docsBridge";

const sampleSource = "PaperFlowサンプル原稿";
const messageOf = (e: unknown) =>
  e instanceof Error ? e.message : "処理を完了できませんでした。";
const cornerLabels: Record<QrCorner, string> = {
  "top-right": "右上",
  "top-left": "左上",
  "bottom-right": "右下",
  "bottom-left": "左下",
};
const orderLabels: Record<DistributionOrder, string> = {
  snake: "蛇行順",
  row: "横方向",
  column: "縦方向",
  number: "出席番号順",
};
const previewStudent: Student = {
  id: "preview-only",
  name: "見本の生徒",
  number: 1,
  seat: { row: 0, col: 0 },
};
const fallbackStudents = [previewStudent];

export default function CreateDialog({
  className,
  count,
  source,
  busy,
  progress,
  error,
  onClose,
  onCreate,
  students = fallbackStudents,
  previous,
  distributionDefaults,
  sample = true,
}: {
  className: string;
  count: number;
  source: {
    name: string;
    bytes: Uint8Array;
    documentId?: string;
    defaults?: DocsSettings;
  } | null;
  busy: boolean;
  progress: Progress | null;
  error: string;
  students?: Student[];
  previous?: Collection;
  distributionDefaults?: Pick<
    ClassSettings,
    "defaultOrder" | "defaultStartCorner" | "defaultReverse"
  >;
  sample?: boolean;
  onClose: () => void;
  onCreate: (
    input: Parameters<typeof createCollection>[0],
    source?: Uint8Array,
  ) => Promise<void>;
}) {
  const [title, setTitle] = useState(
    source?.defaults?.title ??
      source?.name.replace(/\.pdf$/i, "") ??
      "修学旅行参加同意書",
  );
  const [dueDate, setDueDate] = useState(source?.defaults?.dueDate ?? "");
  const [pageCount, setPageCount] = useState(2);
  const [required, setRequired] = useState<number[]>([2]);
  const [corner, setCorner] = useState<QrCorner>(
    source?.defaults?.qrCorner ?? previous?.qrCorner ?? "top-right",
  );
  const [order, setOrder] = useState<DistributionOrder>(
    source?.defaults?.order ??
      distributionDefaults?.defaultOrder ??
      previous?.order ??
      "snake",
  );
  const [startCorner, setStartCorner] = useState<QrCorner>(
    source?.defaults?.startCorner ??
      distributionDefaults?.defaultStartCorner ??
      previous?.startCorner ??
      "top-left",
  );
  const [reverse, setReverse] = useState(
    source?.defaults?.reverse ??
      distributionDefaults?.defaultReverse ??
      previous?.reverse ??
      false,
  );
  const [duplex, setDuplex] = useState(
    source?.defaults?.duplex ?? previous?.duplex ?? false,
  );
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(
    source?.defaults?.layoutMode ?? previous?.layoutMode ?? "reserved-corner",
  );
  const [showNames, setShowNames] = useState(
    source?.defaults?.showNames ?? previous?.showNames ?? true,
  );
  const [versionLabel, setVersionLabel] = useState("第1版");
  const [sourceBytes, setSourceBytes] = useState<Uint8Array | undefined>(
    source?.bytes,
  );
  const [sourceName, setSourceName] = useState(source?.name ?? sampleSource);
  const [sourceDocumentId, setSourceDocumentId] = useState(source?.documentId);
  const [loadingSource, setLoadingSource] = useState(Boolean(source));
  const [fileError, setFileError] = useState("");
  const [consent, setConsent] = useState(false);
  const [appendUnseated, setAppendUnseated] = useState(false);
  const [previewBytes, setPreviewBytes] = useState<Uint8Array | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [previewRetry, setPreviewRetry] = useState(0);
  const [showOriginal, setShowOriginal] = useState(false);
  const [previewPage, setPreviewPage] = useState(1);
  const [viewedPages, setViewedPages] = useState<number[]>([]);

  const chooseRequiredPages = useCallback(
    (n: number) => {
      const reusable =
        previous?.requiredPages.filter((page) => page <= n) ?? [];
      return reusable.length
        ? reusable
        : Array.from({ length: n }, (_, index) => index + 1);
    },
    [previous],
  );
  useEffect(() => {
    if (!source) return;
    let cancelled = false;
    setLoadingSource(true);
    void inspectSourcePdf(source.bytes)
      .then((info) => {
        if (cancelled) return;
        setPageCount(info.pageCount);
        setRequired(chooseRequiredPages(info.pageCount));
        setSourceBytes(source.bytes);
        setSourceName(source.name);
        setSourceDocumentId(source.documentId);
        setFileError("");
      })
      .catch((e) => {
        if (!cancelled) setFileError(messageOf(e));
      })
      .finally(() => {
        if (!cancelled) setLoadingSource(false);
      });
    return () => {
      cancelled = true;
    };
  }, [source, chooseRequiredPages]);

  async function load(file?: File) {
    if (!file) return;
    setLoadingSource(true);
    setFileError("");
    try {
      if (file.size > 20 * 1024 * 1024)
        throw new Error("原稿は20MiB以下のPDFを選んでください。");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const info = await inspectSourcePdf(bytes);
      setSourceBytes(bytes);
      setSourceName(file.name);
      setSourceDocumentId(undefined);
      setPageCount(info.pageCount);
      setRequired(chooseRequiredPages(info.pageCount));
    } catch (e) {
      setFileError(messageOf(e));
    } finally {
      setLoadingSource(false);
    }
  }

  const input = useMemo(
    () => ({
      title: title.trim(),
      className,
      dueDate,
      pageCount,
      requiredPages: required,
      qrCorner: corner,
      duplex,
      order,
      startCorner,
      reverse,
      sourceName,
      layoutMode,
      showNames,
      versionLabel: versionLabel.trim(),
      sourceDocumentId,
    }),
    [
      title,
      className,
      dueDate,
      pageCount,
      required,
      corner,
      duplex,
      order,
      startCorner,
      reverse,
      sourceName,
      layoutMode,
      showNames,
      versionLabel,
      sourceDocumentId,
    ],
  );
  const ordered = useMemo(() => {
    try {
      return orderStudents(students, order, reverse, startCorner);
    } catch {
      return [];
    }
  }, [students, order, reverse, startCorner]);
  const unseated =
    order === "number" ? [] : students.filter((student) => !student.seat);
  const metrics = printLayoutMetrics(pageCount, count, duplex, layoutMode);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setPreviewBytes(null);
    setPreviewError("");
    setViewedPages([]);
    setPreviewPage(1);
    setConsent(false);
    if (
      loadingSource ||
      fileError ||
      !input.title ||
      !input.requiredPages.length ||
      !students.length
    ) {
      setPreviewBusy(false);
      return () => controller.abort();
    }
    setPreviewBusy(true);
    const timer = setTimeout(() => {
      void (async () => {
        const collection = createCollection(input, students);
        const result = await generatePrintPreview(
          {
            collection,
            students,
            sourcePdf: sourceBytes,
            signal: controller.signal,
          },
          "all",
        );
        if (!cancelled) setPreviewBytes(result.bytes);
      })()
        .catch((e) => {
          if (!cancelled && (e as Error).name !== "AbortError")
            setPreviewError(messageOf(e));
        })
        .finally(() => {
          if (!cancelled) setPreviewBusy(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [input, students, sourceBytes, loadingSource, fileError, previewRetry]);

  const onPageViewed = useCallback((page: number) => {
    setViewedPages((old) => (old.includes(page) ? old : [...old, page]));
  }, []);
  const allViewed = viewedPages.length === pageCount;
  const docsNeedsGoogleClass = sample && Boolean(sourceDocumentId);
  const canCreate =
    !busy &&
    !docsNeedsGoogleClass &&
    !loadingSource &&
    !previewBusy &&
    !fileError &&
    !previewError &&
    !!previewBytes &&
    allViewed &&
    consent &&
    required.length > 0 &&
    !!title.trim() &&
    !!versionLabel.trim() &&
    (sample || Boolean(sourceBytes)) &&
    (unseated.length === 0 || appendUnseated) &&
    metrics.totalPages <= 400;

  return (
    <Modal title="新しい配布物を作成" onClose={onClose} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canCreate) void onCreate(input, sourceBytes);
        }}
      >
        {docsNeedsGoogleClass && (
          <Notice danger>
            Docsの原稿はサンプル名簿では発行できません。閉じて接続・設定でGoogle接続し、Classroomまたは検証用の名簿を選択してから、Docsの原稿を再読込してください。
            <button
              type="button"
              className="button secondary"
              onClick={onClose}
            >
              この画面を閉じる
            </button>
          </Notice>
        )}
        <div className="create-layout paperflow-create-layout">
          <section className="create-preview paperflow-source-preview">
            <span className="eyebrow">印刷前の原稿確認</span>
            {previewBusy && (
              <p role="status">
                <LoaderCircle size={18} className="spin" />{" "}
                実際の原稿でプレビューを準備しています…
              </p>
            )}
            {previewError && (
              <Notice danger>
                {previewError}
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setPreviewRetry((value) => value + 1)}
                >
                  プレビューを再生成
                </button>
              </Notice>
            )}
            {sourceBytes && (
              <div className="paperflow-preview-tabs">
                <button
                  type="button"
                  className={
                    showOriginal ? "button secondary" : "button primary"
                  }
                  onClick={() => setShowOriginal(false)}
                >
                  QRを重ねた原稿
                </button>
                <button
                  type="button"
                  className={
                    showOriginal ? "button primary" : "button secondary"
                  }
                  onClick={() => setShowOriginal(true)}
                >
                  元の原稿
                </button>
              </div>
            )}
            {showOriginal && sourceBytes ? (
              <PdfPreview
                bytes={sourceBytes}
                page={previewPage}
                onPageChange={setPreviewPage}
              />
            ) : (
              previewBytes && (
                <PdfPreview
                  bytes={previewBytes}
                  onPageViewed={onPageViewed}
                  page={previewPage}
                  onPageChange={setPreviewPage}
                />
              )
            )}
            {!previewBusy && !previewBytes && !previewError && (
              <p>原稿と返却ページを選ぶと表示します。</p>
            )}
            <p className="preview-confirm-progress">
              {viewedPages.length} / {pageCount}
              ページを表示済み。全ページで原稿とQR・文字の重なりを確認してください。
            </p>
            <small>
              先頭の生徒で確認しています。プレビュー用QRは発行時のQRとは別です。
            </small>
            <div className="paperflow-print-facts">
              <p>
                1人 {metrics.sheetsPerStudent}枚（本文{pageCount}ページ
                {metrics.pagesPerStudent > pageCount ? "＋調整1ページ" : ""}） ×{" "}
                {count}人
              </p>
              <p>
                <b>
                  合計 {metrics.totalPages}ページ・用紙{metrics.totalSheets}枚
                </b>
              </p>
              <p>
                先頭3人：
                {ordered
                  .slice(0, 3)
                  .map((student) => `${student.number}番 ${student.name}`)
                  .join(" → ") || "名簿を確認してください"}
              </p>
            </div>
            <label className="checkbox-label shrink-consent">
              <input
                type="checkbox"
                checked={consent}
                disabled={!allViewed || previewBusy || busy}
                onChange={(e) => setConsent(e.target.checked)}
              />
              {layoutMode === "reserved-corner"
                ? `${cornerLabels[corner]}の幅90mm×高さ25mm（紙端から10mm）に本文がないことを全ページで確認しました`
                : `全ページの文字を確認し、${(metrics.scale * 100).toFixed(1)}%に縮小して管理帯を追加します`}
            </label>
          </section>
          <fieldset
            disabled={busy}
            className="create-fields paperflow-create-fields"
          >
            {previous && (
              <Notice>
                {distributionDefaults?.defaultOrder ||
                distributionDefaults?.defaultStartCorner ||
                distributionDefaults?.defaultReverse !== undefined
                  ? "座席表で保存した配布順と、前回のQR位置・印刷設定を初期値にしています。"
                  : "前回のQR位置・配布順・印刷設定を引き継いでいます。"}
              </Notice>
            )}
            <label className="field">
              配布物名
              <input
                required
                maxLength={80}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <div className="field-row">
              <label className="field">
                対象クラス
                <div className="read-only">
                  <Users size={16} />
                  {className}
                  <span>{count}人</span>
                </div>
              </label>
              <label className="field">
                回収期限
                <input
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                />
              </label>
            </div>
            <label className="field">
              印字する版
              <input
                required
                maxLength={24}
                value={versionLabel}
                onChange={(e) => setVersionLabel(e.target.value)}
              />
              <small>
                例：第1版。本文の改訂は配布物の新版として発行してください。
              </small>
            </label>
            <div className="field">
              原稿
              <div className="source-choice">
                <FileText size={22} />
                <div>
                  <b>{sourceName}</b>
                  <small>
                    {pageCount}ページ ·{" "}
                    {sourceBytes ? "選択したPDF" : "架空の同意書"}
                  </small>
                </div>
                <label className="text-button file-label">
                  変更
                  <input
                    type="file"
                    accept="application/pdf,.pdf"
                    disabled={busy || loadingSource}
                    onChange={(e) => void load(e.target.files?.[0])}
                  />
                </label>
              </div>
              <small>
                A4縦・1〜10ページ・20MiB以下。切り抜き領域のあるPDFには対応していません。
              </small>
            </div>
            {!sample && !sourceBytes && (
              <Notice>
                現在は架空の原稿です。実際に配るPDFを選択してください。
              </Notice>
            )}
            <fieldset className="field">
              <legend>返却が必要なページ</legend>
              <div className="page-chips">
                {Array.from({ length: pageCount }, (_, index) => index + 1).map(
                  (number) => (
                    <label
                      key={number}
                      className={required.includes(number) ? "checked" : ""}
                    >
                      <input
                        type="checkbox"
                        checked={required.includes(number)}
                        onChange={(e) =>
                          setRequired((old) =>
                            e.target.checked
                              ? [...old, number].sort((a, b) => a - b)
                              : old.filter((page) => page !== number),
                          )
                        }
                      />
                      {number}ページ目
                    </label>
                  ),
                )}
              </div>
              <small>説明文など、返却不要のページは外せます。</small>
            </fieldset>
            <label className="field">
              QR領域の確保方法
              <select
                value={layoutMode}
                onChange={(e) => setLayoutMode(e.target.value as LayoutMode)}
              >
                <option value="reserved-corner">
                  原寸のまま、原稿の空けた隅を使う
                </option>
                <option value="management-band">
                  原稿を縮小して管理帯を追加
                </option>
              </select>
              <small>
                {layoutMode === "reserved-corner"
                  ? "原稿は100%。選んだ隅に幅90mm×高さ25mmの空白を用意してください。"
                  : `原稿を${(metrics.scale * 100).toFixed(1)}%に縮小します。文字の大きさをプレビューで確認してください。`}
              </small>
            </label>
            <div className="field-row">
              <label className="field">
                QRの位置
                <select
                  value={corner}
                  onChange={(e) => setCorner(e.target.value as QrCorner)}
                >
                  {Object.entries(cornerLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                配布順
                <select
                  value={order}
                  onChange={(e) =>
                    setOrder(e.target.value as DistributionOrder)
                  }
                >
                  {Object.entries(orderLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="field">
              配布を始める位置
              <select
                value={startCorner}
                disabled={order === "number"}
                onChange={(e) => setStartCorner(e.target.value as QrCorner)}
              >
                <option value="top-left">左上から</option>
                <option value="top-right">右上から</option>
                <option value="bottom-left">左下から</option>
                <option value="bottom-right">右下から</option>
              </select>
              <small>
                {order === "number"
                  ? "出席番号順では開始位置を使いません。"
                  : "教卓側を上として指定します。先頭3人の表示で順番を確認してください。"}
              </small>
            </label>
            <div className="check-row">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={reverse}
                  onChange={(e) => setReverse(e.target.checked)}
                />
                生徒の配布順を反転
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={duplex}
                  onChange={(e) => setDuplex(e.target.checked)}
                />
                両面印刷用
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={showNames}
                  onChange={(e) => setShowNames(e.target.checked)}
                />
                氏名を印字
              </label>
            </div>
            {unseated.length > 0 && (
              <Notice>
                <p>
                  座席未配置が{unseated.length}人います：
                  {unseated.map((student) => `${student.number}番`).join("、")}
                  。座席表で配置するか、下の選択を確認してください。
                </p>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={appendUnseated}
                    onChange={(e) => setAppendUnseated(e.target.checked)}
                  />
                  未配置者を番号順で最後にまとめる
                </label>
              </Notice>
            )}
            {metrics.totalPages > 400 && (
              <Notice danger>印刷PDFは400ページ以内にしてください。</Notice>
            )}
            {(fileError || error) && (
              <Notice danger>{fileError || error}</Notice>
            )}
          </fieldset>
        </div>
        {progress && <ProgressBar {...progress} />}
        <div className="modal-footer">
          <button
            type="button"
            className="button quiet"
            disabled={busy}
            onClick={onClose}
          >
            キャンセル
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={!canCreate}
          >
            {busy ? (
              <LoaderCircle size={17} className="spin" />
            ) : (
              <FilePlus2 size={17} />
            )}
            {busy ? "PDFを生成しています" : "確認してQR付きPDFを作成"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
