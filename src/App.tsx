import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Cloud,
  FileText,
  FilePlus2,
  Grid2X2,
  LayoutDashboard,
  Link2,
  LoaderCircle,
  LogOut,
  Plus,
  ScanLine,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Upload,
  Users,
  X,
} from "lucide-react";
import type {
  AppState,
  Collection,
  Progress,
  Receipt,
  ScanBatch,
  ScanPage,
} from "./domain/types";
import {
  createCollection,
  getStudentStatus,
  validateStudents,
  recordBatch,
  toCsv,
} from "./domain/logic";
import {
  readState,
  writeState,
  sanitizeStateForStorage,
} from "./domain/persistence";
import { createInitialState } from "./domain/seed";
import { restoreReviewedPages } from "./domain/recovery";
import { prepareSharedScanReview, sharedScanViews } from "./domain/sharedScan";
import {
  generatePrintPdf,
  generateSourcePdf,
  scanPdf,
  createDemoScan,
  extractStudentPdf,
} from "./pdfClient";
import { GoogleWorkspaceClient, getGoogleClientId } from "./google";
import {
  listenForDocsSource,
  sendDocsSettings,
  checkDocsSource,
  type DocsSource,
} from "./google/docsBridge";
import PdfPreview from "./PdfPreview";
import CreateDialog from "./CreateDialog";
import { SeatPanel } from "./SeatPanel";
import { useConcurrentSessionWarning } from "./useConcurrentSessionWarning";
import { AdditionalIssuePanel } from "./AdditionalIssuePanel";
import ArchivePanel from "./ArchivePanel";
import { isCollectionDeleting } from "./domain/lifecycle";
import {
  addArchive,
  driveLink,
  hashPdf,
  mergeReceipts,
  operationLabel,
  persistCloudState,
  resumeArchive,
  saveCollectionRecord,
  saveIssuedPdf,
  sourceForBatch,
  type CloudContext,
} from "./cloudWorkflow";
import {
  getStudentArchiveSummary,
  markDriveArtifactMissing,
} from "./domain/operations";
import {
  setCollectionStatus,
  setRecipientRequirement,
  createRevision,
} from "./domain/workflows";
import { switchClassWorkspace, syncClassRoster } from "./domain/workspaces";
import { reviseReviewedPage } from "./domain/corrections";
import { Badge, Empty, Modal, Notice, ProgressBar, downloadBytes } from "./ui";

type View = "home" | "collections" | "seats" | "scan" | "settings";
const statusLabels = {
  complete: "回収済み",
  partial: "一部不足",
  uncollected: "未回収",
  exempt: "免除",
  superseded: "旧版",
};
const sampleSource = "PaperFlowサンプル原稿";
const printRecipients = (c: Collection) =>
  c.recipients
    .filter((s) => !c.pendingRecipientIds?.includes(s.id))
    .map((s) => s.id);
const printCacheKey = (c: Collection) =>
  `${c.id}:${printRecipients(c).join(",")}`;
const formatDate = (date: string) =>
  date
    ? new Intl.DateTimeFormat("ja-JP", {
        month: "short",
        day: "numeric",
      }).format(new Date(`${date.slice(0, 10)}T12:00:00`))
    : "期限なし";
const messageOf = (e: unknown) =>
  e instanceof Error
    ? e.message
    : "処理を完了できませんでした。もう一度お試しください。";

export default function App() {
  const [state, setState] = useState<AppState>(() => readState());
  const [view, setView] = useState<View>("home");
  const [activeId, setActiveId] = useState<string>(
    () => state.collections[0]?.id ?? "",
  );
  const [creating, setCreating] = useState(false);
  const [sample, setSample] = useState(true);
  const [dataSource, setDataSource] = useState("サンプル");
  const [resetPrompt, setResetPrompt] = useState(false);
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [preview, setPreview] = useState<{
    url: string;
    title: string;
    bytes: Uint8Array;
  } | null>(null);
  const printCache = useRef(new Map<string, Uint8Array>());
  const sourceCache = useRef(new Map<string, Uint8Array>());
  const scanCache = useRef(new Map<string, Uint8Array>());
  const [docsSource, setDocsSource] = useState<{
    name: string;
    bytes: Uint8Array;
    documentId?: string;
    accountEmail?: string;
    sourceHash?: string;
    defaults?: DocsSource["defaults"];
  } | null>(null);
  const [batch, setBatch] = useState<ScanBatch | null>(null);
  const [replacements, setReplacements] = useState<string[]>([]);
  const [localArchive, setLocalArchive] = useState(false);
  const [recorded, setRecorded] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const googleRef = useRef<GoogleWorkspaceClient | null>(null);
  const [googleAccount, setGoogleAccount] = useState("");
  const [courses, setCourses] = useState<{ id: string; name: string }[]>([]);
  const [courseId, setCourseId] = useState("");
  const [ledger, setLedgerState] = useState<Awaited<
    ReturnType<GoogleWorkspaceClient["createLedger"]>
  > | null>(null);
  const ledgerRef = useRef<typeof ledger>(null);
  function setLedger(next: typeof ledger) {
    ledgerRef.current = next;
    setLedgerState(next);
  }
  const [googleSaveStatus, setGoogleSaveStatus] = useState("");
  const syncedState = useRef<AppState | null>(null);
  const [archiveGoogle, setArchiveGoogle] = useState(false);
  const pendingRecordSave = useRef<{
    base: AppState;
    key: string;
    state: AppState;
    operationId?: string;
    commitId: string;
  } | null>(null);
  const multiTabWarning = useConcurrentSessionWarning(
    state.classId ?? "sample",
  );
  const [revisionOf, setRevisionOf] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const issuanceStudents = useMemo(
    () =>
      revisionOf
        ? (state.collections.find((c) => c.id === revisionOf)?.recipients ?? [])
        : state.students.filter((s) => s.enrollment !== "withdrawn"),
    [revisionOf, state.collections, state.students],
  );
  const [reviewHistory, setReviewHistory] = useState(false);
  const [changeRequest, setChangeRequest] = useState<{
    kind: "exempt" | "required" | "reopen" | "ignore";
    studentId?: string;
    sourcePage?: number;
  } | null>(null);
  const [changeReason, setChangeReason] = useState("");
  const [comparison, setComparison] = useState<{
    old: Uint8Array;
    current: Uint8Array;
    title: string;
  } | null>(null);
  const [comparisonSourceRequest, setComparisonSourceRequest] = useState<{
    receiptId: string;
    batchId: string;
    currentBatchId: string;
    collectionId: string;
    page: ScanPage;
  } | null>(null);
  const actor = googleAccount || "ローカルの先生";
  const homeCollections = state.collections.filter(
    (c) => !c.deletedAt && !c.archivedAt,
  );
  const visibleCollections = state.collections.filter(
    (c) => !c.deletedAt && (showArchived || !c.archivedAt),
  );
  const active =
    visibleCollections.find((c) => c.id === activeId) ?? visibleCollections[0];
  const totalComplete = active
    ? active.recipients.filter(
        (s) =>
          getStudentStatus(active, s.id, state.receipts).status === "complete",
      ).length
    : 0;
  const totalPartial = active
    ? active.recipients.filter(
        (s) =>
          getStudentStatus(active, s.id, state.receipts).status === "partial",
      ).length
    : 0;
  const rosterErrors = validateStudents(state.students);
  const pendingCount = state.batches.reduce(
    (sum, b) => sum + b.pages.filter((p) => p.resolution === "pending").length,
    0,
  );

  useEffect(() => {
    if (sample && !rosterErrors.length && !writeState(state))
      setError(
        "このブラウザに記録を保存できません。設定画面からバックアップを保存してください。",
      );
  }, [state, sample]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    if (!preview) return;
    return () => URL.revokeObjectURL(preview.url);
  }, [preview]);
  useEffect(
    () =>
      listenForDocsSource((source) => {
        setDocsSource(source);
        setCreating(true);
        setToast("Google Docsの原稿を受け取りました");
      }, setError),
    [],
  );

  useEffect(() => {
    if (syncedState.current && state !== syncedState.current)
      setGoogleSaveStatus("未同期の変更があります");
  }, [state]);
  function cloudContext(): CloudContext {
    if (!googleRef.current?.isConnected())
      throw new Error("接続・設定からGoogleに再接続してください。");
    return {
      client: googleRef.current,
      ledger: ledgerRef.current,
      onLedger: setLedger,
      scanCache: scanCache.current,
      onState: (next, committed) => {
        if (committed) {
          syncedState.current = next;
          setGoogleSaveStatus("Sheetsへ記録済み");
          const current = batch && next.batches.find((b) => b.id === batch.id);
          if (current?.recordedAt) {
            setBatch({
              ...current,
              pages: current.pages.map((p) => ({
                ...p,
                thumbnail: batch?.pages.find((old) => old.id === p.id)
                  ?.thumbnail,
              })),
            });
            setRecorded(true);
            setReplacements([]);
          }
        } else
          setGoogleSaveStatus(
            "未同期の変更があります。保存を再試行してください。",
          );
        setState(next);
      },
      onMessage: setGoogleSaveStatus,
    };
  }
  async function commitWorkspace(next: AppState) {
    if (sample) setState(next);
    else await persistCloudState(cloudContext(), next);
  }
  async function run<T>(task: () => Promise<T>): Promise<T | undefined> {
    setError("");
    setBusy(true);
    try {
      return await task();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }
  function openPdf(bytes: Uint8Array, title: string) {
    setPreview({
      url: URL.createObjectURL(
        new Blob([new Uint8Array(bytes)], { type: "application/pdf" }),
      ),
      title,
      bytes,
    });
  }
  function navigate(next: View) {
    setError("");
    setView(next);
    setQuery("");
    if (next === "scan" && active && batch?.collectionId !== active.id) {
      const previous = state.batches.find((b) => b.collectionId === active.id);
      setBatch(
        previous
          ? {
              ...previous,
              pages: prepareSharedScanReview(state, previous.pages, {
                hash: previous.hash,
                pageCount: previous.pageCount,
                collectionId: previous.collectionId,
              }).pages,
            }
          : null,
      );
      setRecorded(!!previous?.recordedAt);
      setReplacements([]);
    }
  }
  function switchCollection(id: string) {
    if (view === "scan" && batch && !recorded && id !== active?.id) {
      setError(
        "未記録の確認内容があります。先に記録するか、照合結果の「記録して切り替える」を使ってください。",
      );
      return;
    }
    setActiveId(id);
    setBatch(null);
    setRecorded(false);
    setReplacements([]);
    setQuery("");
  }
  function resetWorkspace(next: AppState, isSample: boolean, origin: string) {
    pendingRecordSave.current = null;
    printCache.current.clear();
    sourceCache.current.clear();
    scanCache.current.clear();
    syncedState.current = null;
    setState(next);
    setSample(isSample);
    setArchiveGoogle(next.settings?.defaultStorageMode === "drive");
    setLocalArchive(false);
    setDataSource(origin);
    setBatch(null);
    setPreview(null);
    setComparison(null);
    setComparisonSourceRequest(null);
    setLedger(null);
    setGoogleSaveStatus("");
    setActiveId(next.collections[0]?.id ?? "");
    setRecorded(false);
    setReplacements([]);
    setView("home");
    setError("");
  }
  async function restoreBackup(file?: File) {
    if (!file) return;
    await run(async () => {
      if (file.size > 10 * 1024 * 1024)
        throw new Error("バックアップは10MB以下を選択してください。");
      const restored = sanitizeStateForStorage(JSON.parse(await file.text()));
      if (!restored)
        throw new Error("このバックアップの形式を確認できませんでした。");
      resetWorkspace(restored, false, "バックアップ");
      setToast("バックアップを復元しました。このセッションで保持します。");
    });
  }
  async function ensurePrint(c: Collection) {
    const cacheKey = printCacheKey(c);
    const cached = printCache.current.get(cacheKey);
    if (cached) return cached;
    const hasAdditionalRecipients = state.operations?.some(
      (op) =>
        op.collectionId === c.id &&
        op.kind === "print" &&
        op.studentIds?.some((id) => !c.pendingRecipientIds?.includes(id)),
    );
    if (
      !hasAdditionalRecipients &&
      c.printDriveFileId &&
      googleRef.current?.isConnected()
    ) {
      const bytes = await googleRef.current.downloadPdf(c.printDriveFileId);
      printCache.current.set(cacheKey, bytes);
      return bytes;
    }
    let source = sourceCache.current.get(c.id);
    if (!source && c.sourceDriveFileId && googleRef.current?.isConnected()) {
      source = await googleRef.current.downloadPdf(
        c.sourceDriveFileId,
        c.sourceHash,
      );
      sourceCache.current.set(c.id, source);
    }
    if (!source && c.sourceName !== sampleSource)
      throw new Error(
        "この原稿PDFはメモリにありません。保存した印刷用PDFを開いて印刷してください。原稿を再選択すると新しい配布物として発行されます。",
      );
    const result = await generatePrintPdf({
      collection: c,
      students: c.recipients,
      studentIds: printRecipients(c),
      sourcePdf: source,
      onProgress: setProgress,
    });
    printCache.current.set(cacheKey, result.bytes);
    return result.bytes;
  }
  async function create(
    input: Parameters<typeof createCollection>[0],
    source?: Uint8Array,
  ) {
    await run(async () => {
      if (input.sourceDocumentId && sample)
        throw new Error(
          "Docsの原稿はGoogleに接続し、クラスを選択してから発行してください。接続・設定で名簿を選んでから原稿を読み込み直してください。",
        );
      if (!sample && !googleRef.current?.isConnected())
        throw new Error("Googleに接続してから配布物を保存してください。");
      if (
        docsSource?.accountEmail &&
        googleAccount &&
        docsSource.accountEmail.toLowerCase() !== googleAccount.toLowerCase()
      )
        throw new Error(
          "DocsとWebでGoogleアカウントが異なります。Docsと同じアカウントへ接続し直してください。",
        );
      if (input.sourceDocumentId && docsSource?.sourceHash) {
        const checked = await checkDocsSource(docsSource.sourceHash);
        if (!checked.unchanged)
          throw new Error(
            "原稿が変更されています。Docsの『原稿を読み直す』から再プレビューしてください。",
          );
      }
      const revised = revisionOf
        ? createRevision(state, revisionOf, input, {
            actor,
            reason: "原稿を改訂して新しい版を発行",
          })
        : null;
      let collection =
        revised?.collection ??
        createCollection(
          input,
          state.students.filter((s) => s.enrollment !== "withdrawn"),
        );
      collection = {
        ...collection,
        status: "generating",
        tokens: collection.tokens.map((t) => ({ ...t, active: false })),
        sourceDocumentId: input.sourceDocumentId,
        sourceHash: source ? await hashPdf(source) : undefined,
        createdBy: actor,
        seatLayoutId: state.settings?.activeSeatLayoutId,
      };
      if (!source) {
        source = await generateSourcePdf(collection);
        collection = { ...collection, sourceHash: await hashPdf(source) };
      }
      let next = revised
        ? {
            ...revised.state,
            collections: revised.state.collections.map((c) =>
              c.id === collection.id ? collection : c,
            ),
          }
        : { ...state, collections: [collection, ...state.collections] };
      if (source) sourceCache.current.set(collection.id, source);
      setState(next);
      setActiveId(collection.id);
      setCreating(false);
      setRevisionOf(null);
      setView("collections");
      if (!sample) next = await persistCloudState(cloudContext(), next);
      const result = await generatePrintPdf({
        collection,
        students: collection.recipients,
        sourcePdf: source,
        onProgress: setProgress,
      });
      printCache.current.set(printCacheKey(collection), result.bytes);
      next = {
        ...next,
        collections: next.collections.map((c) =>
          c.id === collection.id
            ? { ...result.collection, status: "generating" }
            : c,
        ),
      };
      if (sample) {
        next = setCollectionStatus(next, collection.id, "ready", {
          actor,
          reason: "サンプルPDFの生成完了",
        });
        setState(next);
      } else
        next = await saveIssuedPdf(
          cloudContext(),
          next,
          collection,
          result.bytes,
          source,
        );
      sendDocsSettings({
        classKey: state.classId,
        className: state.className,
        count: collection.recipients.length,
        title: collection.title,
        dueDate: collection.dueDate,
        qrCorner: collection.qrCorner,
        order: collection.order,
        startCorner: collection.startCorner,
        duplex: collection.duplex,
        reverse: collection.reverse,
        showNames: collection.showNames,
        layoutMode: collection.layoutMode,
      });
      setDocsSource(null);
      setToast(
        sample
          ? "サンプルの印刷用PDFを作成しました"
          : "台帳と印刷用PDFを保存しました",
      );
      openPdf(result.bytes, `${collection.title} — 印刷用`);
    });
  }
  async function createSample() {
    await create({
      title: "修学旅行参加同意書",
      className: state.className,
      dueDate: "2026-11-20",
      pageCount: 2,
      requiredPages: [2],
      qrCorner: "top-right",
      duplex: false,
      order: "snake",
      reverse: false,
      sourceName: sampleSource,
    });
  }
  async function analyze(
    bytes: Uint8Array,
    name: string,
    targetCollection = active,
    committedState?: AppState,
  ) {
    if (!targetCollection) {
      setError("先に配布物を作成してください。");
      return;
    }
    const c = targetCollection;
    if (batch && !recorded && !committedState) {
      setError(
        "未記録の確認内容があります。現在の確認を記録してから、別のPDFや配布物へ進んでください。",
      );
      return;
    }
    const scanState = committedState ?? state;
    if (
      c.status === "generating" ||
      c.status === "draft" ||
      c.status === "closed"
    ) {
      setError(
        "発行・保存が完了して回収を開始できる配布物を選択してください。",
      );
      return;
    }
    abortRef.current = new AbortController();
    await run(async () => {
      const hashBytes = await crypto.subtle.digest(
        "SHA-256",
        new Uint8Array(bytes),
      );
      const hash = Array.from(new Uint8Array(hashBytes), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
      const old = scanState.batches.find(
        (b) => b.hash === hash && b.collectionId === c.id,
      );
      const pages = await scanPdf({
        bytes,
        tokens: scanState.collections.flatMap((x) => x.tokens),
        collectionId: c.id,
        existingReceipts: scanState.receipts,
        onProgress: setProgress,
        signal: abortRef.current?.signal,
        qrCorner: c.qrCorner,
      });
      const restoredPages = restoreReviewedPages(
        pages,
        old,
        scanState.receipts,
        {
          hash,
          collectionId: c.id,
          versionId: c.versionId,
        },
      );
      const shared = prepareSharedScanReview(scanState, restoredPages, {
        hash,
        pageCount: pages.length,
        collectionId: c.id,
      });
      const next: ScanBatch = {
        ...old,
        id: old?.id ?? crypto.randomUUID(),
        sourceId: shared.sourceId,
        hash,
        fileName: name,
        pageCount: pages.length,
        createdAt: old?.createdAt ?? new Date().toISOString(),
        collectionId: c.id,
        pages: shared.pages,
      };
      scanCache.current.set(next.id, bytes);
      setBatch(next);
      setActiveId(c.id);
      setReplacements([]);
      setRecorded(false);
      setView("scan");
      setToast(`${pages.length}ページの解析が完了しました`);
    });
  }
  async function demoScan() {
    if (!active) return;
    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;
    const bytes = await run(async () => {
      const print = await ensurePrint(active);
      return createDemoScan(active, print, (p) => {
        if (signal.aborted)
          throw new Error("サンプル生成をキャンセルしました。");
        setProgress(p);
      });
    });
    if (bytes) await analyze(bytes, `${active.title}_サンプル回収.pdf`);
  }
  async function uploadScan(file?: File) {
    if (!file) return;
    if (file.size > 100 * 1024 * 1024) {
      setError("100MB以下のPDFを選択してください。");
      return;
    }
    try {
      await analyze(new Uint8Array(await file.arrayBuffer()), file.name);
    } catch (e) {
      setError(messageOf(e));
    }
  }
  function updatePage(id: string, patch: Partial<ScanPage>) {
    if (batch?.pages.find((page) => page.id === id)?.handledBy) {
      setError(
        "この元PDFページは別の配布物で処理済みです。元の配布物の記録から変更してください。",
      );
      return;
    }
    setBatch((b) =>
      b
        ? {
            ...b,
            pages: b.pages.map((p) => (p.id === id ? { ...p, ...patch } : p)),
          }
        : b,
    );
    setRecorded(false);
  }
  function assignPage(
    page: ScanPage,
    studentId: string,
    pageNumber: number,
    reviewReason: string,
  ) {
    if (!active || !studentId) return;
    if (!reviewReason.trim()) {
      setError("画像を確認した理由を入力してください。");
      return;
    }
    const token = active.tokens.find(
      (t) =>
        t.studentId === studentId &&
        t.pageNumber === pageNumber &&
        t.kind === "content",
    );
    if (!token) {
      setError("対象の生徒・ページの発行情報がありません。");
      return;
    }
    const same = batch?.pages.some(
      (p) =>
        p.id !== page.id &&
        p.resolution === "accepted" &&
        p.studentId === studentId &&
        p.pageNumber === pageNumber,
    );
    if (same) {
      setError("この生徒の同じページは既に今回の回収に含まれます。");
      return;
    }
    const existing = state.receipts.find(
      (r) =>
        r.versionId === active.versionId &&
        r.studentId === studentId &&
        r.pageNumber === pageNumber,
    );
    updatePage(page.id, {
      ...token,
      manual: true,
      reviewReason: reviewReason.trim(),
      reviewedBy: actor,
      handledBy: undefined,
      exclusionScope: undefined,
      status: existing ? "duplicate" : "matched",
      resolution: existing ? "pending" : "accepted",
      reason: existing
        ? "すでに記録済みのページです。既存を維持するか差し替えてください。"
        : "手動で照合しました",
    });
  }
  async function saveBatch(): Promise<AppState | undefined> {
    if (!batch || !active || batch.collectionId !== active.id) return;
    return await run(async () => {
      const key = JSON.stringify([
        batch,
        replacements,
        archiveGoogle,
        googleRef.current?.getIdentity()?.id,
      ]);
      let prepared = pendingRecordSave.current;
      if (!prepared || prepared.base !== state || prepared.key !== key) {
        prepared = {
          base: state,
          key,
          state: recordBatch(state, batch, batch.pages, {
            replaceReceiptIds: replacements,
            actor,
          }),
          commitId: crypto.randomUUID(),
        };
        pendingRecordSave.current = prepared;
      }
      const attempt = prepared;
      const next = attempt.state;
      const committed = sample
        ? next
        : await saveCollectionRecord(
            cloudContext(),
            next,
            active.id,
            batch.id,
            archiveGoogle,
            {
              operationId: attempt.operationId,
              commitId: attempt.commitId,
              onPrepared(next, operationId) {
                attempt.state = next;
                attempt.operationId = operationId;
              },
            },
          );
      pendingRecordSave.current = null;
      if (sample) setState(committed);
      const normalized = committed.batches.find((b) => b.id === batch.id)!;
      setBatch({
        ...normalized,
        pages: normalized.pages.map((p) => ({
          ...p,
          thumbnail: batch.pages.find((old) => old.id === p.id)?.thumbnail,
        })),
      });
      setReplacements([]);
      setRecorded(true);
      setToast(
        sample
          ? "回収状況をブラウザに記録しました"
          : "回収状況をSheetsに記録しました",
      );
      if (localArchive) await downloadMatchedPdf(normalized);
      return committed;
    });
  }
  async function handoffScan(targetId: string, ownerBatchId?: string) {
    if (!batch) return;
    const target = state.collections.find(
      (collection) => collection.id === targetId,
    );
    if (!target || target.deletedAt) {
      setError("切替先の配布物が見つからないか、削除済みです。");
      return;
    }
    if (
      !ownerBatchId &&
      (target.archivedAt ||
        ["draft", "generating", "closed"].includes(target.status ?? "ready"))
    ) {
      setError(
        "切替先の発行・保存を完了し、回収を開始できる状態にしてください。",
      );
      return;
    }
    const bytes = scanCache.current.get(batch.id);
    if (!ownerBatchId && !bytes) {
      setError(
        "同じ回収PDFを選び直してから切り替えてください。現在の確認内容は残っています。",
      );
      return;
    }
    const committed = recorded ? state : await saveBatch();
    if (!committed) return;
    if (ownerBatchId) {
      const owner = committed.batches.find(
        (item) =>
          item.id === ownerBatchId &&
          item.collectionId === targetId &&
          item.hash === batch.hash,
      );
      if (!owner) {
        setError("元の処理記録が見つかりません。台帳を読み直してください。");
        return;
      }
      if (bytes) scanCache.current.set(owner.id, bytes);
      if (target.archivedAt) setShowArchived(true);
      setActiveId(targetId);
      setBatch({
        ...owner,
        pages: prepareSharedScanReview(committed, owner.pages, {
          hash: owner.hash,
          pageCount: owner.pageCount,
          collectionId: owner.collectionId,
        }).pages,
      });
      setRecorded(true);
      setReplacements([]);
      setView("scan");
      return;
    }
    await analyze(bytes!, batch.fileName, target, committed);
  }
  async function downloadMatchedPdf(targetBatch = batch) {
    if (!targetBatch || !active) return;
    const bytes = scanCache.current.get(targetBatch.id);
    if (!bytes)
      throw new Error(
        "PDF保存には同じ回収PDFを選び直してください。回収記録は保存済みです。",
      );
    const pages = targetBatch.pages.filter((p) => p.resolution === "accepted");
    if (!pages.length) throw new Error("照合できたページがありません。");
    downloadBytes(
      await extractStudentPdf(
        bytes,
        pages.map((p) => p.sourcePage),
      ),
      `${active.title}_照合済み.pdf`,
    );
  }
  async function saveStudentPdf(studentId: string) {
    if (!active) return;
    await run(async () => {
      const receipts = state.receipts
        .filter(
          (r) =>
            r.collectionId === active.id &&
            r.versionId === active.versionId &&
            r.studentId === studentId,
        )
        .sort((a, b) => a.pageNumber - b.pageNumber);
      if (!receipts.length)
        throw new Error("この生徒の回収記録はまだありません。");
      const ctx = googleRef.current?.isConnected()
        ? cloudContext()
        : ({ scanCache: scanCache.current } as CloudContext);
      const result = await mergeReceipts(ctx, state, receipts);
      const student = active.recipients.find((s) => s.id === studentId);
      downloadBytes(
        result,
        `${student?.number}_${student?.name}_${active.title}.pdf`,
      );
    });
  }
  async function connectGoogle() {
    await run(async () => {
      const client =
        googleRef.current ??
        new GoogleWorkspaceClient({ clientId: getGoogleClientId() });
      if (!googleRef.current)
        client.onAuthStateChange((status) => {
          if (status.status !== "connected") {
            pendingRecordSave.current = null;
            setGoogleAccount("");
            setGoogleSaveStatus("Googleに再接続して保存を続けてください");
          }
        });
      googleRef.current = client;
      const account = await client.connect();
      if (
        state.settings?.googleAccountId &&
        state.settings.googleAccountId !== account.id
      ) {
        client.disconnect();
        setLedger(null);
        throw new Error(
          "現在のクラスに接続した元のGoogleアカウントを選んでください。",
        );
      }
      setGoogleAccount(account.email || account.name || "Googleアカウント");
      const list = await client.listCourses();
      setCourses(list.map((c) => ({ id: c.id, name: c.name })));
      setToast("Googleに接続しました。クラスを選んでください。");
    });
  }
  async function importCourse() {
    if (!googleRef.current || !courseId) return;
    await run(async () => {
      const students = await googleRef.current!.listStudents(courseId);
      if (!students.length)
        throw new Error("このクラスには生徒が登録されていません。");
      const className =
        courses.find((c) => c.id === courseId)?.name ?? "Classroom";
      let next = switchClassWorkspace(state, {
        id: `classroom:${courseId}`,
        className,
        students: students.map((s, i) => ({
          ...s,
          seat: { row: Math.floor(i / 5), col: i % 5 },
        })),
        classroomCourseId: courseId,
      });
      next = syncClassRoster(next, students, {
        actor,
        reason: "Classroom名簿の人数と在籍を同期",
      });
      resetWorkspace(next, false, "Google Classroom");
      setView("seats");
      setToast("名簿を読み込みました。出席番号と座席を確認してください。");
    });
  }
  async function syncGoogle() {
    if (!googleRef.current?.isConnected()) {
      setError("接続・設定からGoogleに接続してください。");
      return;
    }
    await run(async () => {
      setGoogleSaveStatus("記録中");
      try {
        await persistCloudState(cloudContext(), state);
      } catch (e) {
        setGoogleSaveStatus("Sheetsへの記録を再試行してください");
        throw e;
      }
      setToast("Google Sheetsへ記録しました");
    });
  }
  async function uploadPrint() {
    if (!active || !googleRef.current?.isConnected()) {
      setError("接続・設定からGoogleに接続してください。");
      return;
    }
    await run(async () => {
      const bytes = await ensurePrint(active);
      let source = sourceCache.current.get(active.id);
      if (!source && active.sourceDriveFileId)
        source = await googleRef.current!.downloadPdf(
          active.sourceDriveFileId,
          active.sourceHash,
        );
      await saveIssuedPdf(cloudContext(), state, active, bytes, source);
      setToast("印刷用PDFと台帳を保存しました");
    });
  }
  async function openLedger() {
    await run(async () => {
      const ctx = cloudContext();
      const selected = await ctx.client.pickFiles({ kind: "spreadsheet" });
      if (!selected.length) return;
      const loaded = await ctx.client.readLedger(selected[0].id);
      if (
        loaded.state.settings?.googleAccountId &&
        loaded.state.settings.googleAccountId !== ctx.client.getIdentity()?.id
      )
        throw new Error("この台帳は別のGoogleアカウントに結び付いています。");
      const switched = switchClassWorkspace(state, {
        id: loaded.state.classId ?? loaded.ledger.spreadsheetId,
        className: loaded.state.className,
      });
      const next = {
        ...loaded.state,
        settings: {
          ...loaded.state.settings,
          ledgerRevision: loaded.revisionHash,
        },
        savedClasses: switched.savedClasses,
      };
      resetWorkspace(next, false, "Google Sheets");
      setLedger(loaded.ledger);
      syncedState.current = next;
      setArchiveGoogle(next.settings?.defaultStorageMode === "drive");
      setGoogleSaveStatus("台帳を読み込みました");
      setToast(
        `${next.className}・${next.students.length}人の台帳を復元しました`,
      );
    });
  }
  async function selectDriveFolder() {
    await run(async () => {
      const selected = await cloudContext().client.pickFiles({
        kind: "folder",
      });
      if (!selected.length) return;
      setState({
        ...state,
        settings: { ...state.settings, folderId: selected[0].id },
      });
      setToast(`保存先: ${selected[0].name}`);
    });
  }
  async function chooseDrivePdf(kind: "source" | "scan") {
    await run(async () => {
      const ctx = cloudContext();
      const selected = await ctx.client.pickFiles({ kind: "pdf" });
      if (!selected.length) return;
      const bytes = await ctx.client.downloadPdf(selected[0].id);
      if (kind === "scan") await analyze(bytes, selected[0].name);
      else {
        setDocsSource({ name: selected[0].name, bytes });
        setCreating(true);
      }
    });
  }
  async function restoreSource(file?: File) {
    if (!file || !active) return;
    await run(async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!active.sourceHash || (await hashPdf(bytes)) !== active.sourceHash)
        throw new Error(
          "発行時に使った原稿PDFと一致しません。元の原稿を選択してください。",
        );
      sourceCache.current.set(active.id, bytes);
      setToast("同じ原稿を再読込しました。保存を再開できます。");
    });
  }
  async function verifyArtifacts() {
    await run(async () => {
      const ctx = cloudContext();
      let next = state;
      let missing = 0;
      for (const artifact of state.artifacts ?? []) {
        try {
          const file = await ctx.client.getFile(artifact.driveFileId);
          if (file.trashed) {
            next = markDriveArtifactMissing(next, artifact.driveFileId);
            missing++;
          }
        } catch (e) {
          if (
            typeof e === "object" &&
            e &&
            "status" in e &&
            (e.status === 404 || e.status === 403)
          ) {
            next = markDriveArtifactMissing(next, artifact.driveFileId);
            missing++;
          } else throw e;
        }
      }
      if (next !== state) await persistCloudState(ctx, next);
      setToast(
        missing
          ? `${missing}件の保管先を確認できません。元の回収PDFから再保管できます。`
          : "保管先のファイルを確認しました",
      );
    });
  }
  async function comparePage(page: ScanPage) {
    if (!batch || !active) return;
    await run(async () => {
      const existing = state.receipts.find(
        (r) =>
          r.collectionId === active.id &&
          r.studentId === page.studentId &&
          r.pageNumber === page.pageNumber,
      );
      if (!existing) throw new Error("既存の受領記録が見つかりません。");
      const ctx = googleRef.current?.isConnected()
        ? cloudContext()
        : ({ scanCache: scanCache.current } as CloudContext);
      let old: Uint8Array;
      try {
        old = await sourceForBatch(ctx, state, existing.batchId);
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message.startsWith("原本再選択待ち:") ||
            error.message.includes("記録した原本と一致しません"))
        ) {
          setComparisonSourceRequest({
            receiptId: existing.id,
            batchId: existing.batchId,
            currentBatchId: batch.id,
            collectionId: active.id,
            page: { ...page },
          });
        }
        throw error;
      }
      const current = scanCache.current.get(batch.id);
      if (!current) throw new Error("今回の回収PDFをもう一度選んでください。");
      setComparison({
        old: await extractStudentPdf(old, [existing.sourcePage]),
        current: await extractStudentPdf(current, [page.sourcePage]),
        title: "既存の紙と今回の紙を比較",
      });
    });
  }
  async function selectComparisonSource(file?: File) {
    const request = comparisonSourceRequest;
    if (!file || !request) return;
    await run(async () => {
      if (file.size > 100 * 1024 * 1024)
        throw new Error("回収PDFは100MB以下を選択してください。");
      const existing = state.receipts.find(
        (receipt) =>
          receipt.id === request.receiptId &&
          receipt.batchId === request.batchId &&
          receipt.collectionId === request.collectionId,
      );
      const oldBatch = state.batches.find(
        (item) => item.id === request.batchId,
      );
      if (
        !existing ||
        !oldBatch ||
        batch?.id !== request.currentBatchId ||
        active?.id !== request.collectionId
      )
        throw new Error(
          "比較対象の記録が変わりました。比較を閉じて選び直してください。",
        );
      const old = new Uint8Array(await file.arrayBuffer());
      if ((await hashPdf(old)) !== oldBatch.hash)
        throw new Error("選択した回収PDFが記録した原本と一致しません。");
      const current = scanCache.current.get(request.currentBatchId);
      if (!current) throw new Error("今回の回収PDFをもう一度選んでください。");
      const oldPage = await extractStudentPdf(old, [existing.sourcePage]);
      const currentPage = await extractStudentPdf(current, [
        request.page.sourcePage,
      ]);
      // Only a validated original enters the cache. The current review and receipts stay intact.
      scanCache.current.set(oldBatch.id, old);
      setComparisonSourceRequest(null);
      setComparison({
        old: oldPage,
        current: currentPage,
        title: "既存の紙と今回の紙を比較",
      });
    });
  }
  async function applyChange() {
    if (!changeRequest || !active || !changeReason.trim()) return;
    if (batch && !recorded) {
      setError(
        "未記録の確認内容があります。現在の確認を記録してから、記録済みページや提出対象を訂正してください。",
      );
      return;
    }
    await run(async () => {
      const context = { actor, reason: changeReason.trim() };
      let next: AppState;
      if (changeRequest.kind === "exempt" || changeRequest.kind === "required")
        next = setRecipientRequirement(
          state,
          active.id,
          changeRequest.studentId!,
          changeRequest.kind,
          context,
        );
      else {
        if (!batch) return;
        next = reviseReviewedPage(
          state,
          batch.id,
          changeRequest.sourcePage!,
          { kind: changeRequest.kind },
          context,
        );
      }
      const committed = sample
        ? next
        : await persistCloudState(cloudContext(), next);
      if (sample) setState(committed);
      if (batch) {
        const normalized = committed.batches.find((b) => b.id === batch.id);
        if (normalized) {
          setBatch({
            ...normalized,
            pages: prepareSharedScanReview(committed, normalized.pages, {
              hash: normalized.hash,
              pageCount: normalized.pageCount,
              collectionId: normalized.collectionId,
            }).pages.map((page) => ({
              ...page,
              thumbnail:
                batch.hash === normalized.hash
                  ? batch.pages.find((old) => old.sourcePage === page.sourcePage)
                      ?.thumbnail
                  : undefined,
            })),
          });
          setRecorded(!!normalized.recordedAt);
        }
      }
      setChangeRequest(null);
      setChangeReason("");
      setToast("理由を履歴に残して更新しました");
    });
  }
  async function reprint(studentIds: string[]) {
    if (!active) return;
    await run(async () => {
      if (!studentIds.length) throw new Error("再印刷する対象者がいません。");
      let source = sourceCache.current.get(active.id);
      if (!source && active.sourceDriveFileId)
        source = await cloudContext().client.downloadPdf(
          active.sourceDriveFileId,
          active.sourceHash,
        );
      if (!source && active.sourceName !== sampleSource)
        throw new Error("同じ原稿PDFを再選択してから再印刷してください。");
      const result = await generatePrintPdf({
        collection: active,
        students: active.recipients,
        studentIds,
        sourcePdf: source,
        onProgress: setProgress,
      });
      openPdf(result.bytes, `${active.title} — 選択した生徒の再印刷`);
    });
  }
  const viewTitles: Record<View, string> = {
    home: "ホーム",
    collections: "配布物・回収状況",
    seats: "座席表",
    scan: "回収・照合",
    settings: "接続・設定",
  };
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            navigate("home");
          }}
        >
          <span className="brand-icon">
            <FileText size={22} />
          </span>
          <span>
            PaperFlow<span className="brand-dot">.</span>
          </span>
        </a>
        <div className="workspace-picker">
          <div className="workspace-avatar">教</div>
          <div>
            <small>クラスのワークスペース</small>
            {state.savedClasses?.length ? (
              <select
                aria-label="作業するクラス"
                value={state.classId ?? "sample"}
                disabled={busy}
                onChange={(e) => {
                  const next = switchClassWorkspace(state, {
                    id: e.target.value,
                    className: state.savedClasses!.find(
                      (c) => c.id === e.target.value,
                    )!.className,
                  });
                  resetWorkspace(next, false, "保存したクラス");
                  setView("settings");
                  setToast(
                    "クラスを切り替えました。保存前に台帳を開いて最新状態を確認してください。",
                  );
                }}
              >
                <option value={state.classId ?? "sample"}>
                  {state.className}
                </option>
                {state.savedClasses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.className}
                  </option>
                ))}
              </select>
            ) : (
              <b>{state.className}</b>
            )}
          </div>
          <ChevronDown size={15} />
        </div>
        <div className="nav-label">ワークスペース</div>
        <nav>
          {(
            [
              { id: "home", label: "ホーム", icon: LayoutDashboard },
              { id: "collections", label: "配布物・回収状況", icon: FileText },
              { id: "seats", label: "座席表", icon: Grid2X2 },
              { id: "scan", label: "回収・照合", icon: ScanLine },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              className={`nav-item ${view === item.id ? "active" : ""}`}
              onClick={() => navigate(item.id)}
            >
              <item.icon size={19} strokeWidth={1.7} />
              {item.label}
              {item.id === "scan" && pendingCount > 0 && (
                <span className="nav-count">{pendingCount}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="privacy-note">
            <ShieldCheck size={20} />
            <b>紙の情報は、手元に。</b>
            <p>
              PDFの解析はブラウザ内で。
              <br />
              大切な情報を守ります。
            </p>
          </div>
          <button
            className={`nav-item ${view === "settings" ? "active" : ""}`}
            onClick={() => navigate("settings")}
          >
            <Settings2 size={19} />
            接続・設定
          </button>
          <div className="profile">
            <span className="profile-avatar">R2</span>
            <div>
              <b>R2K2 Workspace</b>
              <small>DevFest Hackathon 2026</small>
            </div>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            ワークスペース
            <ChevronRight size={14} />
            <span>{viewTitles[view]}</span>
          </div>
          <div className="topbar-right">
            <Badge tone={sample ? "amber" : "green"}>
              <span className="status-dot" />
              {sample ? "サンプルモード" : `${dataSource} · セッションのみ`}
            </Badge>
            <button
              className="icon-button"
              aria-label="使い方"
              onClick={() => {
                navigate("settings");
              }}
            >
              <CircleHelp size={19} />
            </button>
          </div>
        </header>
        <div className="content">
          {error && (
            <div className="error-banner" role="alert">
              <Notice danger>{error}</Notice>
              <button
                className="icon-button"
                aria-label="エラーを閉じる"
                onClick={() => setError("")}
              >
                <X size={17} />
              </button>
            </div>
          )}
          {view === "home" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">YOUR CLASS, IN FLOW</div>
                  <h1>今日の紙仕事を、軽やかに。</h1>
                  <p>
                    配る、集める、確かめる。クラスの書類を、ひとつの流れに。
                  </p>
                </div>
                <button
                  className="button primary"
                  onClick={() => setCreating(true)}
                  disabled={busy}
                >
                  <Plus size={18} />
                  配布物を作る
                </button>
              </div>
              <div className="hero-card">
                <div className="hero-copy">
                  <Badge tone="paper">
                    <Sparkles size={13} />
                    いつもの紙を、もっとスムーズに
                  </Badge>
                  <h2>
                    配ったあとの
                    <br />
                    「誰の紙？」をなくそう。
                  </h2>
                  <p>
                    座席順にプリントを作成。戻ってきた紙は、
                    <br className="desktop-only" />
                    順番を気にせず、まとめて照合できます。
                  </p>
                  <button
                    className="text-button"
                    onClick={() =>
                      active ? navigate("scan") : void createSample()
                    }
                    disabled={busy}
                  >
                    {active ? "回収をはじめる" : "サンプルの配布物を作ってみる"}
                    <ArrowRight size={17} />
                  </button>
                </div>
                <div className="hero-art" aria-hidden="true">
                  <div className="art-dots" />
                  <div className="paper-sheet back" />
                  <div className="paper-sheet front">
                    <div className="paper-header">
                      <span className="tiny-logo">P</span>
                      <span>2年A組</span>
                      <div className="fake-qr">▦</div>
                    </div>
                    <div className="paper-line long" />
                    <div className="paper-line medium" />
                    <div className="paper-line" />
                    <div className="paper-signature" />
                    <div className="paper-bottom">
                      <span>修学旅行参加同意書</span>
                      <span>02 / 40</span>
                    </div>
                  </div>
                  <div className="art-status">
                    <span>
                      <Check size={17} />
                    </span>
                    <div>
                      <b>回収を確認しました</b>
                      <small>02　伊藤 結衣</small>
                    </div>
                  </div>
                  <div className="art-label">
                    PAPER → FLOW
                    <ArrowUpRight size={14} />
                  </div>
                </div>
              </div>
              <div className="section-heading">
                <h2>クラスのいま</h2>
                <span>
                  {state.className} · {state.students.length}人
                </span>
              </div>
              <div className="stats-grid">
                <Stat
                  label="管理中の配布物"
                  value={homeCollections.length}
                  unit="件"
                  icon={<FileText size={19} />}
                  detail="クラスの配布・回収をまとめて"
                />
                <Stat
                  label="回収済み"
                  value={totalComplete}
                  unit={`/ ${active?.recipients.length ?? 0} 人`}
                  icon={<CheckCircle2 size={19} />}
                  detail={active?.title ?? "配布物を作ると表示されます"}
                  green
                />
                <Stat
                  label="確認が必要なページ"
                  value={pendingCount}
                  unit="ページ"
                  icon={<ScanLine size={19} />}
                  detail={
                    pendingCount
                      ? "例外を確認して照合を完了"
                      : "確認待ちのページはありません"
                  }
                />
              </div>
              <div className="section-heading">
                <h2>
                  最近の配布物{" "}
                  <span className="section-count">
                    {homeCollections.length}
                  </span>
                </h2>
                <button
                  className="text-button subtle"
                  onClick={() => navigate("collections")}
                >
                  すべて見る
                  <ArrowRight size={15} />
                </button>
              </div>
              <div className="panel">
                {homeCollections.length ? (
                  homeCollections.slice(0, 4).map((c) => (
                    <CollectionRow
                      key={c.id}
                      collection={c}
                      state={state}
                      onClick={() => {
                        switchCollection(c.id);
                        navigate("collections");
                      }}
                    />
                  ))
                ) : (
                  <Empty
                    title="最初の配布物を作りましょう"
                    detail="原稿とクラスを選ぶと、生徒別のQR付きPDFができあがります。"
                  >
                    <button
                      className="button secondary"
                      onClick={() => setCreating(true)}
                    >
                      <FilePlus2 size={17} />
                      配布物を作成
                    </button>
                  </Empty>
                )}
              </div>
              <div className="flow-strip">
                {[
                  {
                    icon: FilePlus2,
                    title: "つくる",
                    detail: "原稿にQRをプラス",
                  },
                  {
                    icon: Users,
                    title: "くばる",
                    detail: "座席順で、迷わず配布",
                  },
                  {
                    icon: ScanLine,
                    title: "あつめる",
                    detail: "紙の束をまとめて照合",
                  },
                ].map((x, i) => (
                  <div key={x.title}>
                    <span className="flow-number">0{i + 1}</span>
                    <x.icon size={20} />
                    <span>
                      <b>{x.title}</b>
                      <small>{x.detail}</small>
                    </span>
                    {i < 2 && (
                      <ChevronRight className="flow-chevron" size={17} />
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
          {view === "collections" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">COLLECTIONS</div>
                  <h1>配布物・回収状況</h1>
                  <p>必要なページが、誰から戻ってきたかを確認できます。</p>
                </div>
                <button
                  className="button primary"
                  onClick={() => setCreating(true)}
                  disabled={busy}
                >
                  <Plus size={18} />
                  配布物を作る
                </button>
              </div>
              <label className="checkbox-label" style={{ marginBottom: 16 }}>
                <input
                  type="checkbox"
                  checked={showArchived}
                  onChange={(e) => setShowArchived(e.target.checked)}
                />
                アーカイブ済みの配布物も表示
              </label>
              {!active ? (
                <div className="panel">
                  <Empty
                    title="配布物はまだありません"
                    detail="架空名簿で実際のPDF生成から試せます。"
                  >
                    <button
                      className="button primary"
                      onClick={() => void createSample()}
                      disabled={busy}
                    >
                      <Sparkles size={17} />
                      サンプルを作成
                    </button>
                  </Empty>
                </div>
              ) : (
                <>
                  <div className="collection-switcher">
                    {visibleCollections.map((c) => (
                      <button
                        className={active.id === c.id ? "selected" : ""}
                        key={c.id}
                        onClick={() => {
                          switchCollection(c.id);
                        }}
                      >
                        <FileText size={16} />
                        {c.title}
                        {c.archivedAt ? "（アーカイブ）" : ""}
                      </button>
                    ))}
                  </div>
                  <div className="collection-detail panel">
                    <div className="collection-title">
                      <div className="document-icon">
                        <FileText size={24} />
                      </div>
                      <div>
                        <h2>{active.title}</h2>
                        <p>
                          {active.className} · {active.pageCount}ページ ·
                          返却対象 {active.requiredPages.join("・")}ページ目 ·
                          期限 {formatDate(active.dueDate)}
                        </p>
                      </div>
                      <Badge
                        tone={
                          active.status === "generating" ||
                          active.status === "draft"
                            ? "amber"
                            : "green"
                        }
                      >
                        {
                          (
                            {
                              draft: "下書き",
                              generating: "保存待ち",
                              ready: "発行可能",
                              collecting: "回収中",
                              closed: "終了",
                            } as const
                          )[active.status ?? "ready"]
                        }
                      </Badge>
                    </div>
                    <div className="collection-actions">
                      <button
                        className="button secondary"
                        disabled={busy}
                        onClick={() =>
                          void run(async () =>
                            openPdf(await ensurePrint(active), active.title),
                          )
                        }
                      >
                        <FileText size={16} />
                        印刷PDF
                      </button>
                      <button
                        className="button secondary"
                        disabled={busy}
                        onClick={() =>
                          void run(async () =>
                            downloadBytes(
                              await ensurePrint(active),
                              `${active.title}_印刷用.pdf`,
                            ),
                          )
                        }
                      >
                        <ArrowDownToLine size={16} />
                        再ダウンロード
                      </button>
                      <button
                        className="button primary"
                        onClick={() => navigate("scan")}
                        disabled={busy}
                      >
                        <ScanLine size={16} />
                        回収PDFを読み込む
                      </button>
                    </div>
                  </div>
                  {state.batches.some(
                    (b) =>
                      b.collectionId === active.id &&
                      b.pages.some((p) => p.resolution === "pending"),
                  ) && (
                    <Notice>
                      未照合ページが残っています。未回収人数は暫定です。
                    </Notice>
                  )}
                  {active.dueDate &&
                    active.dueDate <
                      new Date().toLocaleDateString("sv-SE", {
                        timeZone: state.settings?.timezone ?? "Asia/Tokyo",
                      }) && (
                      <Notice>
                        回収期限を過ぎています。スキャン日時だけでは提出の遅れを判定しません。
                      </Notice>
                    )}
                  {(active.status === "generating" ||
                    active.status === "draft") && (
                    <Notice>
                      印刷PDFと台帳の保存が終わるまで発行は確定しません。
                      <button
                        className="button secondary"
                        disabled={busy}
                        onClick={() => void uploadPrint()}
                      >
                        同じ発行処理を再試行
                      </button>
                      <label className="button quiet file-label">
                        発行時の原稿を再選択
                        <input
                          type="file"
                          accept="application/pdf,.pdf"
                          onChange={(e) =>
                            void restoreSource(e.target.files?.[0])
                          }
                        />
                      </label>
                    </Notice>
                  )}
                  <div className="collection-actions">
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() =>
                        void reprint(
                          active.recipients
                            .filter((s) =>
                              ["uncollected", "partial"].includes(
                                getStudentStatus(active, s.id, state.receipts)
                                  .status,
                              ),
                            )
                            .map((s) => s.id),
                        )
                      }
                    >
                      未回収・一部不足の人だけ再印刷
                    </button>
                    <button
                      className="button quiet"
                      disabled={busy}
                      onClick={() => {
                        setRevisionOf(active.id);
                        setCreating(true);
                      }}
                    >
                      改訂版を作成
                    </button>
                    <button
                      className="button quiet"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const next = setCollectionStatus(
                            state,
                            active.id,
                            active.status === "closed" ? "ready" : "closed",
                            {
                              actor,
                              reason:
                                active.status === "closed"
                                  ? "回収を再開"
                                  : "回収を終了",
                            },
                          );
                          if (sample) setState(next);
                          else await persistCloudState(cloudContext(), next);
                        })
                      }
                    >
                      {active.status === "closed" ? "回収を再開" : "回収を終了"}
                    </button>
                    {active.printDriveFileId && (
                      <a
                        className="button quiet"
                        href={driveLink(active.printDriveFileId)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Driveの初回印刷PDFを開く
                      </a>
                    )}
                  </div>
                  <AdditionalIssuePanel
                    key={active.id}
                    state={state}
                    collection={active}
                    client={googleRef.current ?? undefined}
                    sample={sample}
                    busy={busy}
                    sourcePdf={sourceCache.current.get(active.id)}
                    actor={actor}
                    onCommit={commitWorkspace}
                    onGenerated={openPdf}
                    onError={setError}
                    onProgress={setProgress}
                    onBusyChange={setBusy}
                  />
                  {(state.artifacts ?? [])
                    .filter(
                      (a) =>
                        a.collectionId === active.id &&
                        a.kind === "additional-print" &&
                        !a.deleted,
                    )
                    .map((a) => (
                      <p key={a.id}>
                        <a
                          href={driveLink(a.driveFileId)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {a.name}
                        </a>
                        （追加分の印刷PDF）
                      </p>
                    ))}
                  <div className="summary-line">
                    <span>
                      <i className="legend-dot green" />
                      回収済み <b>{totalComplete}</b>人
                    </span>
                    <span>
                      <i className="legend-dot amber" />
                      一部不足 <b>{totalPartial}</b>人
                    </span>
                    <span>
                      <i className="legend-dot gray" />
                      未回収{" "}
                      <b>
                        {
                          active.recipients.filter(
                            (s) =>
                              getStudentStatus(active, s.id, state.receipts)
                                .status === "uncollected",
                          ).length
                        }
                      </b>
                      人
                    </span>
                    <span className="muted">
                      記入内容・署名の確認は含みません
                    </span>
                  </div>
                  <div className="panel">
                    <div className="table-toolbar">
                      <div className="search-input">
                        <Search size={17} />
                        <input
                          placeholder="氏名・出席番号で検索"
                          aria-label="生徒を検索"
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                        />
                      </div>
                      <select
                        aria-label="回収状況で絞り込み"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                      >
                        <option value="all">すべての状況</option>
                        <option value="complete">回収済み</option>
                        <option value="partial">一部不足</option>
                        <option value="uncollected">未回収</option>
                      </select>
                      <button
                        className="button quiet"
                        onClick={() =>
                          downloadBytes(
                            toCsv(state, active),
                            `${active.title}_回収状況.csv`,
                            "text/csv;charset=utf-8",
                          )
                        }
                      >
                        <ArrowDownToLine size={16} />
                        CSV出力
                      </button>
                    </div>
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>出席番号</th>
                            <th>氏名</th>
                            <th>回収状況</th>
                            <th>必要ページ</th>
                            <th>不足ページ</th>
                            <th>書類の保管 / 記録日時</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {active.recipients
                            .filter((s) => (s.name + s.number).includes(query))
                            .filter(
                              (s) =>
                                filter === "all" ||
                                getStudentStatus(active, s.id, state.receipts)
                                  .status === filter,
                            )
                            .map((s) => {
                              const status = getStudentStatus(
                                active,
                                s.id,
                                state.receipts,
                              );
                              return (
                                <tr key={s.id}>
                                  <td className="number-cell">
                                    {String(s.number).padStart(2, "0")}
                                  </td>
                                  <td>
                                    <b>{s.name}</b>
                                  </td>
                                  <td>
                                    <Badge
                                      tone={
                                        status.status === "complete"
                                          ? "green"
                                          : status.status === "partial"
                                            ? "amber"
                                            : "neutral"
                                      }
                                    >
                                      {status.status === "complete" && (
                                        <Check size={12} />
                                      )}
                                      {statusLabels[status.status]}
                                    </Badge>
                                  </td>
                                  <td>
                                    {status.receivedCount} /{" "}
                                    {status.requiredCount}
                                  </td>
                                  <td>
                                    {status.missingPages.length
                                      ? status.missingPages
                                          .map((p) => `${p}ページ`)
                                          .join("・")
                                      : "—"}
                                  </td>
                                  <td>
                                    {(() => {
                                      const archive = getStudentArchiveSummary(
                                        state,
                                        active.id,
                                        s.id,
                                      );
                                      return (
                                        <>
                                          <span>
                                            {archive.status === "current"
                                              ? "最新のPDF"
                                              : archive.status === "stale"
                                                ? "前回保存分（現在の回収と差異あり）"
                                                : "未保管"}
                                          </span>
                                          {archive.artifact && (
                                            <a
                                              href={driveLink(
                                                archive.artifact.driveFileId,
                                              )}
                                              target="_blank"
                                              rel="noreferrer"
                                            >
                                              {" "}
                                              PDFを開く
                                            </a>
                                          )}
                                        </>
                                      );
                                    })()}
                                    <small className="cell-date">
                                      {state.receipts
                                        .filter(
                                          (r) =>
                                            r.collectionId === active.id &&
                                            r.studentId === s.id,
                                        )
                                        .map((r) => r.recordedAt)
                                        .sort()
                                        .at(-1)
                                        ? new Date(
                                            state.receipts
                                              .filter(
                                                (r) =>
                                                  r.collectionId ===
                                                    active.id &&
                                                  r.studentId === s.id,
                                              )
                                              .map((r) => r.recordedAt)
                                              .sort()
                                              .at(-1)!,
                                          ).toLocaleString("ja-JP", {
                                            timeZone:
                                              state.settings?.timezone ??
                                              "Asia/Tokyo",
                                          })
                                        : "—"}
                                    </small>
                                  </td>
                                  <td>
                                    <button
                                      className="text-button"
                                      disabled={busy}
                                      onClick={() => void reprint([s.id])}
                                    >
                                      再印刷
                                    </button>
                                    <button
                                      className="text-button subtle"
                                      disabled={busy}
                                      onClick={() => {
                                        setChangeRequest({
                                          kind:
                                            status.status === "exempt" ||
                                            status.status === "superseded"
                                              ? "required"
                                              : "exempt",
                                          studentId: s.id,
                                        });
                                        setChangeReason("");
                                      }}
                                    >
                                      {status.status === "exempt" ||
                                      status.status === "superseded"
                                        ? "この版を受理"
                                        : "免除"}
                                    </button>
                                    <button
                                      className="icon-button"
                                      disabled={busy || !status.receivedCount}
                                      aria-label={`${s.name}の回収PDFを保存`}
                                      onClick={() => void saveStudentPdf(s.id)}
                                    >
                                      <ArrowDownToLine size={16} />
                                    </button>
                                  </td>
                                </tr>
                              );
                            })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  <div className="integration-strip">
                    <span>
                      <Cloud size={18} />
                      Googleに接続して、学校の環境へ記録できます。
                    </span>
                    <button
                      className="text-button"
                      onClick={() =>
                        googleAccount ? void syncGoogle() : navigate("settings")
                      }
                      disabled={busy}
                    >
                      {googleAccount ? "Sheetsに記録" : "Google接続を設定"}
                      <ArrowUpRight size={15} />
                    </button>
                  </div>
                  {googleSaveStatus && (
                    <p className="muted">{googleSaveStatus}</p>
                  )}
                </>
              )}
            </>
          )}
          {view === "seats" && (
            <SeatPanel
              state={state}
              collection={active}
              busy={busy}
              actor={actor}
              client={googleRef.current ?? undefined}
              onBusyChange={setBusy}
              onOpenSettings={() => navigate("settings")}
              onSaveLedger={() => void syncGoogle()}
              sample={sample}
              onChange={(next) => {
                setState(next);
                setToast(
                  "座席・名簿を更新しました。Google台帳には『Sheetsに記録』で保存してください。",
                );
              }}
              onCollectionChange={switchCollection}
            />
          )}
          {view === "scan" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">COLLECT & CHECK</div>
                  <h1>紙の束を、まとめて照合。</h1>
                  <p>
                    順番がばらばらでも大丈夫。QRから生徒とページを確認します。
                  </p>
                </div>
                <Badge tone="green">
                  <ShieldCheck size={13} />
                  ブラウザ内で解析
                </Badge>
              </div>
              {!active ? (
                <div className="panel">
                  <Empty
                    title="先に配布物を作成してください"
                    detail="発行時のQR対応情報を使って、回収した紙を照合します。"
                  >
                    <button
                      className="button primary"
                      onClick={() => void createSample()}
                      disabled={busy}
                    >
                      サンプルを作成
                      <ArrowRight size={16} />
                    </button>
                  </Empty>
                </div>
              ) : (
                <>
                  <div className="scan-target">
                    <span>今回回収する配布物</span>
                    <select
                      aria-label="回収する配布物"
                      value={active.id}
                      disabled={busy}
                      onChange={(e) => {
                        if (batch && batch.collectionId === active.id) {
                          if (!recorded) {
                            setError(
                              "未記録の確認内容があります。先に記録するか、下の「記録して切り替える」を使ってください。",
                            );
                            return;
                          }
                          if (scanCache.current.has(batch.id))
                            void handoffScan(e.target.value);
                          else switchCollection(e.target.value);
                        } else switchCollection(e.target.value);
                      }}
                    >
                      {visibleCollections.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.title}
                        </option>
                      ))}
                    </select>
                    <small>
                      {active.recipients.length}人 · 返却対象{" "}
                      {active.requiredPages.join("・")}ページ目
                    </small>
                  </div>
                  <div
                    className={`upload-zone ${busy ? "disabled" : ""}`}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (!busy) void uploadScan(e.dataTransfer.files[0]);
                    }}
                  >
                    <div className="upload-icon">
                      <ScanLine size={30} strokeWidth={1.5} />
                    </div>
                    <h3>スキャンしたPDFをここにドロップ</h3>
                    <p>
                      最大100MB・200ページ。画像はこのブラウザで処理されます。
                    </p>
                    <label className="button secondary file-label">
                      <Upload size={16} />
                      PDFを選択
                      <input
                        type="file"
                        accept="application/pdf,.pdf"
                        disabled={busy}
                        onChange={(e) => {
                          void uploadScan(e.target.files?.[0]);
                          e.target.value = "";
                        }}
                      />
                    </label>
                    {googleAccount && (
                      <button
                        className="button secondary"
                        disabled={busy}
                        onClick={() => void chooseDrivePdf("scan")}
                      >
                        DriveからPDFを選択
                      </button>
                    )}
                    <span className="or-text">または</span>
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => void demoScan()}
                    >
                      <Sparkles size={15} />
                      サンプルの回収PDFで試す
                      <ArrowRight size={15} />
                    </button>
                  </div>
                  {sample && (
                    <p className="sample-caption">
                      サンプルには未回収・QRの読み取り不良・重複を含みます。実際のPDFを生成してQRを読み取ります。
                    </p>
                  )}
                  {busy && progress && (
                    <>
                      <ProgressBar {...progress} />
                      <button
                        className="text-button subtle"
                        onClick={() => abortRef.current?.abort()}
                      >
                        解析をキャンセル
                      </button>
                    </>
                  )}
                  {state.batches.some((b) => b.collectionId === active.id) && (
                    <label className="field">
                      過去の回収記録
                      <select
                        aria-label="過去の回収記録"
                        value={batch?.id ?? ""}
                        disabled={busy}
                        onChange={(e) => {
                          if (batch && !recorded) {
                            setError(
                              "未記録の確認内容があります。先に現在の確認を記録してください。",
                            );
                            return;
                          }
                          const previous = state.batches.find(
                            (b) => b.id === e.target.value,
                          );
                          setBatch(
                            previous
                              ? {
                                  ...previous,
                                  pages: prepareSharedScanReview(
                                    state,
                                    previous.pages,
                                    {
                                      hash: previous.hash,
                                      pageCount: previous.pageCount,
                                      collectionId: previous.collectionId,
                                    },
                                  ).pages,
                                }
                              : null,
                          );
                          setRecorded(!!previous?.recordedAt);
                          setReplacements([]);
                        }}
                      >
                        <option value="">選択してください</option>
                        {state.batches
                          .filter((b) => b.collectionId === active.id)
                          .map((b) => (
                            <option value={b.id} key={b.id}>
                              {b.fileName}（要確認{" "}
                              {
                                b.pages.filter(
                                  (p) => p.resolution === "pending",
                                ).length
                              }
                              ）
                            </option>
                          ))}
                      </select>
                    </label>
                  )}
                  {batch && batch.collectionId === active.id && (
                    <>
                      <div className="section-heading">
                        <h2>
                          照合結果{" "}
                          <span className="section-count">
                            {batch.pageCount}ページ
                          </span>
                        </h2>
                        <span>{batch.fileName}</span>
                      </div>
                      {batch.sourceId && (
                        <p className="fine-print">
                          元スキャンID {batch.sourceId.slice(-8)} ·
                          配布物を切り替えても元PDFのページ番号と処理済みの記録を共有します。
                        </p>
                      )}
                      {scanCache.current.has(batch.id) && (
                        <button
                          className="text-button subtle"
                          disabled={busy}
                          onClick={() =>
                            downloadBytes(
                              scanCache.current.get(batch.id)!,
                              batch.fileName,
                            )
                          }
                        >
                          <ArrowDownToLine size={15} />
                          元の回収PDFを保存
                        </button>
                      )}
                      <div className="scan-result-stats">
                        <div>
                          <b>
                            {
                              batch.pages.filter(
                                (p) => p.resolution === "accepted",
                              ).length
                            }
                          </b>
                          <span>照合できたページ</span>
                        </div>
                        <div>
                          <b>
                            {
                              batch.pages.filter(
                                (p) => p.resolution === "pending",
                              ).length
                            }
                          </b>
                          <span>確認が必要</span>
                        </div>
                        <div>
                          <b>
                            {
                              batch.pages.filter(
                                (p) => p.resolution === "ignored",
                              ).length
                            }
                          </b>
                          <span>対象外・他の配布物で処理済み</span>
                        </div>
                      </div>
                      {batch.pages.some((p) => p.resolution === "pending") && (
                        <Notice>
                          未照合の紙があるため、未回収人数は暫定です。確認できた分だけ先に記録できます。
                        </Notice>
                      )}
                      {batch.recordedAt && !scanCache.current.has(batch.id) && (
                        <Notice>
                          過去の記録を表示しています。紙の画像を確認するには、同じ回収PDFをもう一度選択してください。
                        </Notice>
                      )}
                      {sharedScanViews(state, batch).some(
                        (view) => view.sourceDriveFileId,
                      ) &&
                        !scanCache.current.has(batch.id) && (
                          <button
                            className="button secondary"
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                const bytes = await sourceForBatch(
                                  cloudContext(),
                                  state,
                                  batch.id,
                                );
                                await analyze(bytes, batch.fileName);
                              })
                            }
                          >
                            Driveの回収原本から再開
                          </button>
                        )}
                      {batch.pages.some(
                        (p) =>
                          p.status === "foreign" &&
                          !p.handledBy &&
                          p.collectionId,
                      ) && (
                        <Notice>
                          同じPDFに別の配布物があります。現在の確認を記録してから、未処理ページを次の配布物へ引き継ぎます。別の配布物で扱うページは除外せず切り替えてください。
                          {[
                            ...new Set(
                              batch.pages
                                .filter(
                                  (p) => p.status === "foreign" && !p.handledBy,
                                )
                                .map((p) => p.collectionId),
                            ),
                          ].map((id) => {
                            const c = state.collections.find(
                              (x) => x.id === id,
                            );
                            return c ? (
                              <button
                                className="button secondary"
                                disabled={busy}
                                key={id}
                                onClick={() => void handoffScan(c.id)}
                              >
                                {recorded ? "" : "現在の確認を記録して、"}
                                {c.title}へ切り替える
                              </button>
                            ) : null;
                          })}
                        </Notice>
                      )}
                      {batch.pages.some((page) => page.handledBy) && (
                        <Notice>
                          {batch.pages.filter((page) => page.handledBy).length}
                          ページは、この元PDFの別の配布物で処理済みです。ここでは再採用しません。除外を取り消す場合は、元の記録で理由を付けて再確認へ戻してください。
                          {[
                            ...new Set(
                              batch.pages.flatMap((page) =>
                                page.handledBy ? [page.handledBy.batchId] : [],
                              ),
                            ),
                          ].map((ownerId) => {
                            const owner = state.batches.find(
                              (item) => item.id === ownerId,
                            );
                            const target = state.collections.find(
                              (item) => item.id === owner?.collectionId,
                            );
                            return owner && target ? (
                              <button
                                className="button secondary"
                                disabled={busy}
                                key={ownerId}
                                onClick={() =>
                                  void handoffScan(target.id, owner.id)
                                }
                              >
                                {recorded ? "" : "現在の確認を記録して、"}「
                                {target.title}」の元の記録へ
                              </button>
                            ) : null;
                          })}
                        </Notice>
                      )}
                      {batch.pages.some(
                        (p) =>
                          p.status === "blank" && p.resolution === "pending",
                      ) && (
                        <Notice>
                          空白候補は自動除外していません。薄い記入がないか各ページを確認してください。
                        </Notice>
                      )}
                      <div className="review-list">
                        {batch.pages
                          .filter((p) => p.resolution === "pending")
                          .map((p) => (
                            <ReviewCard
                              key={p.id}
                              page={p}
                              collection={active}
                              receipts={state.receipts}
                              onCompare={() => void comparePage(p)}
                              onHold={(reason) =>
                                updatePage(p.id, {
                                  reviewReason: reason,
                                  reviewedBy: actor,
                                  reason,
                                })
                              }
                              onPreview={() =>
                                void run(async () => {
                                  const bytes = scanCache.current.get(batch.id);
                                  if (!bytes)
                                    throw new Error(
                                      "同じ回収PDFをもう一度選択してください。",
                                    );
                                  openPdf(
                                    await extractStudentPdf(bytes, [
                                      p.sourcePage,
                                    ]),
                                    `スキャン ${p.sourcePage}ページ目`,
                                  );
                                })
                              }
                              onIgnore={(reason) =>
                                updatePage(p.id, {
                                  resolution: "ignored",
                                  exclusionScope: "source",
                                  reviewReason: reason,
                                  reviewedBy: actor,
                                  reason,
                                })
                              }
                              onAssign={(s, n, reason) => {
                                if (!scanCache.current.has(batch.id)) {
                                  setError(
                                    "元の回収PDFを読み込んで画像を確認してください。",
                                  );
                                  return;
                                }
                                assignPage(p, s, n, reason);
                              }}
                              onReplace={(receiptId, reason) => {
                                if (!reason.trim()) {
                                  setError(
                                    "差し替える理由を入力してください。",
                                  );
                                  return;
                                }
                                setReplacements((old) => [
                                  ...new Set([...old, receiptId]),
                                ]);
                                updatePage(p.id, {
                                  resolution: "accepted",
                                  manual: true,
                                  reviewReason: reason.trim(),
                                  reviewedBy: actor,
                                });
                              }}
                            />
                          ))}
                      </div>
                      <div className="save-panel panel">
                        <div>
                          <h3>
                            {recorded
                              ? "回収状況を記録しました"
                              : "確認できたページを記録する"}
                          </h3>
                          <p>
                            {sample
                              ? "サンプルの記録はこのブラウザに保存されます。Googleには自動送信しません。"
                              : "確認できたページと未照合の状態をGoogle Sheetsへ記録します。"}
                          </p>
                          {!sample && (
                            <label className="checkbox-label">
                              <input
                                type="checkbox"
                                checked={archiveGoogle}
                                onChange={(e) => {
                                  setArchiveGoogle(e.target.checked);
                                  setState({
                                    ...state,
                                    settings: {
                                      ...state.settings,
                                      defaultStorageMode: e.target.checked
                                        ? "drive"
                                        : "record-only",
                                    },
                                  });
                                }}
                              />
                              書類もDriveに保管（元スキャンと生徒別PDF）
                            </label>
                          )}
                          {!sample && !archiveGoogle && (
                            <p className="fine-print">
                              回収状況だけ記録します。回収画像はGoogleへ送信しません。
                            </p>
                          )}
                          <label className="checkbox-label">
                            <input
                              type="checkbox"
                              checked={localArchive}
                              onChange={(e) =>
                                setLocalArchive(e.target.checked)
                              }
                            />
                            照合できたページのPDFもダウンロードする
                          </label>
                        </div>
                        <div className="save-actions">
                          <button
                            className="button primary"
                            disabled={busy || recorded}
                            onClick={() => void saveBatch()}
                          >
                            {recorded ? (
                              <CheckCircle2 size={17} />
                            ) : (
                              <Check size={17} />
                            )}
                            {recorded
                              ? "記録済み"
                              : !sample && archiveGoogle
                                ? "記録して書類を保管"
                                : "回収状況を記録"}
                          </button>
                          {recorded && (
                            <button
                              className="button secondary"
                              disabled={busy}
                              onClick={() =>
                                void run(() => downloadMatchedPdf())
                              }
                            >
                              <ArrowDownToLine size={16} />
                              照合済みPDFを保存
                            </button>
                          )}
                          {recorded && (
                            <button
                              className="button secondary"
                              onClick={() => navigate("collections")}
                            >
                              回収一覧を見る
                              <ArrowRight size={16} />
                            </button>
                          )}
                        </div>
                      </div>
                      {batch.recordedAt && !sample && (
                        <div className="integration-strip">
                          <span>書類を後から保管できます</span>
                          <button
                            className="button secondary"
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                await addArchive(
                                  cloudContext(),
                                  state,
                                  active.id,
                                  batch.id,
                                );
                                setToast("書類をDriveに保管しました");
                              })
                            }
                          >
                            現在の回収内容をDriveに保管
                          </button>
                        </div>
                      )}
                      {batch.pages.some(
                        (page) => page.resolution !== "pending",
                      ) && (
                        <details className="panel history-panel">
                          <summary>
                            記録済み・対象外のページを確認、訂正する
                          </summary>
                          {batch.pages
                            .filter((p) => p.resolution !== "pending")
                            .map((p) => (
                              <div className="history-row" key={p.id}>
                                <span>
                                  元PDF {p.sourcePage}ページ ·{" "}
                                  {p.resolution === "accepted"
                                    ? "採用"
                                    : p.handledBy
                                      ? "別の配布物で処理済み"
                                      : p.exclusionScope === "source"
                                        ? "元PDF全体から除外"
                                        : "この配布物で対象外"}
                                </span>
                                <button
                                  className="text-button"
                                  disabled={busy || !!p.handledBy}
                                  onClick={() => {
                                    const stored = state.batches
                                      .find((item) => item.id === batch.id)
                                      ?.pages.find(
                                        (page) =>
                                          page.sourcePage === p.sourcePage,
                                      );
                                    if (
                                      !stored ||
                                      stored.resolution === "pending"
                                    ) {
                                      updatePage(p.id, {
                                        resolution: "pending",
                                        exclusionScope: undefined,
                                      });
                                      return;
                                    }
                                    setChangeRequest({
                                      kind: "reopen",
                                      sourcePage: p.sourcePage,
                                    });
                                    setChangeReason("");
                                  }}
                                >
                                  理由を記録して再確認へ
                                </button>
                              </div>
                            ))}
                        </details>
                      )}
                      {googleAccount && recorded && (
                        <div className="integration-strip">
                          <span>
                            <Cloud size={18} />
                            Google Sheetsへ回収記録を保存
                          </span>
                          <button
                            className="button secondary"
                            disabled={busy}
                            onClick={() => void syncGoogle()}
                          >
                            Sheetsに記録
                            <ArrowUpRight size={15} />
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </>
          )}
          {view === "settings" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">SETTINGS & CONNECTIONS</div>
                  <h1>接続・設定</h1>
                  <p>Google Workspaceとつないで、いつもの環境で使えます。</p>
                </div>
              </div>
              <div className="settings-grid">
                <section className="panel settings-card">
                  <div className="settings-icon">
                    <Link2 size={22} />
                  </div>
                  <h2>Google Workspace</h2>
                  <p>
                    Classroomの名簿取得、Driveへの印刷PDF保存、Sheetsへの回収記録に接続します。
                  </p>
                  <Badge tone={googleAccount ? "green" : "neutral"}>
                    {googleAccount || "未接続"}
                  </Badge>
                  {!googleAccount ? (
                    <>
                      <button
                        className="button primary"
                        disabled={busy || !getGoogleClientId()}
                        onClick={() => void connectGoogle()}
                      >
                        <Cloud size={17} />
                        Googleに接続
                      </button>
                      {!getGoogleClientId() && (
                        <Notice>
                          この環境ではGoogle連携がまだ設定されていません。架空データの体験は利用できます。
                        </Notice>
                      )}
                    </>
                  ) : (
                    <>
                      <label className="field">
                        担当クラス
                        <select
                          value={courseId}
                          onChange={(e) => setCourseId(e.target.value)}
                        >
                          <option value="">クラスを選択</option>
                          {courses.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        className="button primary"
                        disabled={busy || !courseId}
                        onClick={() => void importCourse()}
                      >
                        名簿を読み込む
                        <ArrowRight size={16} />
                      </button>
                      <button
                        className="text-button subtle"
                        onClick={() => {
                          googleRef.current?.disconnect();
                          setGoogleAccount("");
                          setCourses([]);
                          setLedger(null);
                          syncedState.current = null;
                          setGoogleSaveStatus("");
                        }}
                      >
                        <LogOut size={15} />
                        接続を解除
                      </button>
                    </>
                  )}
                  {googleAccount && (
                    <>
                      <button
                        className="button secondary"
                        disabled={busy}
                        onClick={() => void openLedger()}
                      >
                        既存のSheets台帳を開く
                      </button>
                      <button
                        className="button secondary"
                        disabled={busy}
                        onClick={() => void selectDriveFolder()}
                      >
                        Drive保存先フォルダを選ぶ
                      </button>
                      <button
                        className="button secondary"
                        disabled={busy}
                        onClick={() => void chooseDrivePdf("source")}
                      >
                        Driveの原稿PDFから作成
                      </button>
                      <button
                        className="button quiet"
                        disabled={busy}
                        onClick={() => {
                          const next = createInitialState();
                          next.classId = crypto.randomUUID();
                          next.className = "PaperFlow 実連携テスト（架空40人）";
                          next.settings = {
                            googleAccountId:
                              googleRef.current?.getIdentity()?.id,
                            timezone: "Asia/Tokyo",
                          };
                          resetWorkspace(
                            next,
                            false,
                            "架空名簿・Google連携テスト",
                          );
                          setView("settings");
                        }}
                      >
                        架空名簿でGoogle連携を試す
                      </button>
                    </>
                  )}
                  {state.settings?.folderId && (
                    <a
                      href={`https://drive.google.com/drive/folders/${state.settings.folderId}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      現在の保存先を開く
                    </a>
                  )}
                  {ledger && (
                    <a
                      href={ledger.spreadsheetUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      管理台帳を開く
                    </a>
                  )}
                  {googleAccount && active && (
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => void uploadPrint()}
                    >
                      <Upload size={16} />
                      印刷PDFをDriveへ保存
                    </button>
                  )}
                </section>
                <section className="panel settings-card">
                  <div className="settings-icon">
                    <ShieldCheck size={22} />
                  </div>
                  <h2>記録とプライバシー</h2>
                  <p>
                    PDFはメモリ内で処理され、ページを閉じると消えます。サンプルの名簿と回収記録はこのブラウザに保存します。
                  </p>
                  <div className="settings-fact">
                    <span>画像の解析</span>
                    <b>ブラウザ内</b>
                  </div>
                  <div className="settings-fact">
                    <span>Googleへの送信</span>
                    <b>保存操作をしたときだけ</b>
                  </div>
                  <div className="settings-fact">
                    <span>現在の名簿</span>
                    <b>{sample ? "架空のサンプル" : dataSource}</b>
                  </div>
                  <button
                    className="button secondary"
                    onClick={() =>
                      downloadBytes(
                        JSON.stringify(sanitizeStateForStorage(state), null, 2),
                        "paperflow-backup.json",
                        "application/json",
                      )
                    }
                  >
                    <ArrowDownToLine size={16} />
                    名簿・記録をバックアップ
                  </button>
                  <p className="fine-print">
                    バックアップは名簿・QR対応表を含みます。PDF画像は含みません。
                  </p>
                  <label className="button secondary file-label">
                    <Upload size={16} />
                    バックアップから復元
                    <input
                      type="file"
                      accept="application/json,.json"
                      disabled={busy}
                      onChange={(e) => {
                        void restoreBackup(e.target.files?.[0]);
                        e.target.value = "";
                      }}
                    />
                  </label>
                  <p className="fine-print">
                    復元すると現在の作業を置き換えます。必要な記録は先にバックアップしてください。
                  </p>
                  <button
                    className="text-button subtle"
                    disabled={busy}
                    onClick={() => setResetPrompt(true)}
                  >
                    新しいサンプルではじめる
                  </button>
                </section>
              </div>
              <ArchivePanel
                state={state}
                client={googleRef.current}
                busy={busy}
                onCommit={commitWorkspace}
                onError={setError}
                onBusyChange={setBusy}
              />
              <section className="panel settings-card">
                <h2>保存状況と履歴</h2>
                <label className="field">
                  学校のタイムゾーン
                  <select
                    value={state.settings?.timezone ?? "Asia/Tokyo"}
                    onChange={(e) =>
                      setState({
                        ...state,
                        settings: {
                          ...state.settings,
                          timezone: e.target.value,
                        },
                      })
                    }
                  >
                    <option>Asia/Tokyo</option>
                    <option>UTC</option>
                  </select>
                </label>
                {state.operations?.length ? (
                  state.operations.map((op) => (
                    <div className="history-row" key={op.id}>
                      <span>
                        {
                          state.collections.find(
                            (c) => c.id === op.collectionId,
                          )?.title
                        }{" "}
                        · {operationLabel(op)}
                        <small>{op.error}</small>
                      </span>
                      {op.storageMode === "drive" &&
                        op.archiveStatus !== "saved" &&
                        !isCollectionDeleting(state, op.collectionId) &&
                        op.kind !== "print" && (
                          <button
                            className="button secondary"
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                await resumeArchive(
                                  cloudContext(),
                                  state,
                                  op.id,
                                );
                                setToast("書類保管を再開しました");
                              })
                            }
                          >
                            保管を再試行
                          </button>
                        )}
                    </div>
                  ))
                ) : (
                  <p>保存操作はまだありません。</p>
                )}
                {googleAccount && (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void verifyArtifacts()}
                  >
                    Drive保管先を確認
                  </button>
                )}
                <button
                  className="text-button"
                  onClick={() => setReviewHistory(!reviewHistory)}
                >
                  {reviewHistory ? "操作履歴を閉じる" : "操作履歴を見る"}
                </button>
                {reviewHistory &&
                  [...state.events]
                    .sort((a, b) => b.at.localeCompare(a.at))
                    .map((event) => (
                      <div key={event.id} className="history-row">
                        <div>
                          <b>{event.action}</b>
                          <p>{event.reason ?? event.detail}</p>
                          <small>
                            {event.actor ?? "ローカル"} ·{" "}
                            {new Date(event.at).toLocaleString("ja-JP", {
                              timeZone:
                                state.settings?.timezone ?? "Asia/Tokyo",
                            })}
                          </small>
                          {event.before && (
                            <details>
                              <summary>変更前後</summary>
                              <pre>{event.before}</pre>
                              <pre>{event.after}</pre>
                            </details>
                          )}
                        </div>
                      </div>
                    ))}
              </section>
              <div className="panel getting-started">
                <h2>はじめてのPaperFlow</h2>
                <div className="guide-steps">
                  {[
                    {
                      n: "01",
                      title: "座席を整える",
                      text: "座席表を確認し、教室の配置に合わせます。",
                      view: "seats",
                    },
                    {
                      n: "02",
                      title: "配布用PDFを作る",
                      text: "サンプル原稿または手元のPDFにQRを付けます。",
                      view: "collections",
                    },
                    {
                      n: "03",
                      title: "戻った紙を読み込む",
                      text: "スキャンPDFを照合し、例外だけ確認します。",
                      view: "scan",
                    },
                  ].map((x) => (
                    <button key={x.n} onClick={() => navigate(x.view as View)}>
                      <span>{x.n}</span>
                      <b>{x.title}</b>
                      <p>{x.text}</p>
                      <ArrowUpRight size={17} />
                    </button>
                  ))}
                </div>
                <p className="fine-print">
                  Docsアドオンのソースと導入手順は apps/docs-addon
                  にあります。ローカル体験のPDF生成・QR読み取りは実処理です。Googleの実APIは認可設定後に検証してください。
                </p>
              </div>
            </>
          )}
          {multiTabWarning && (
            <Notice danger>
              同じクラスを別のタブでも開いています。書き込みは1つのタブだけで行ってください。台帳が変更された場合、保存を停止します。
            </Notice>
          )}
          {busy && progress && view !== "scan" && <ProgressBar {...progress} />}
          <footer className="footer">
            <span>
              PaperFlow <span className="footer-dot">·</span>{" "}
              紙とクラスを、つなぐ。
            </span>
            <span>R2K2 / DevFest 2026</span>
          </footer>
        </div>
      </main>
      {comparisonSourceRequest && (
        <Modal
          title="比較する原本を選び直す"
          onClose={() => setComparisonSourceRequest(null)}
        >
          {error && <Notice danger>{error}</Notice>}
          <Notice>
            原本再選択待ちです。既存の受領ページを確認するため、
            {
              state.batches.find(
                (item) => item.id === comparisonSourceRequest.batchId,
              )?.fileName
            }
            を選んでください。今回の照合結果は保持します。
          </Notice>
          <label className="field">
            比較する旧原本PDF
            <input
              type="file"
              accept="application/pdf,.pdf"
              aria-label="比較する旧原本PDF"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                void selectComparisonSource(file);
              }}
            />
          </label>
        </Modal>
      )}
      {comparison && (
        <Modal
          title={comparison.title}
          onClose={() => setComparison(null)}
          wide
        >
          <div className="comparison-grid">
            <section>
              <h3>既存の受領ページ</h3>
              <PdfPreview bytes={comparison.old} title="既存の受領ページ" />
            </section>
            <section>
              <h3>今回のページ</h3>
              <PdfPreview bytes={comparison.current} title="今回のページ" />
            </section>
          </div>
        </Modal>
      )}
      {changeRequest && (
        <Modal
          title="理由を残して記録を変更"
          onClose={() => setChangeRequest(null)}
        >
          <p>
            既に保存した記録の変更は履歴に残ります。PDFを保管済みの場合は再保管が必要になります。
          </p>
          <label className="field">
            変更理由
            <textarea
              value={changeReason}
              onChange={(e) => setChangeReason(e.target.value)}
              rows={3}
            />
          </label>
          <div className="modal-footer">
            <button
              className="button quiet"
              onClick={() => setChangeRequest(null)}
            >
              キャンセル
            </button>
            <button
              className="button primary"
              disabled={busy || !changeReason.trim()}
              onClick={() => void applyChange()}
            >
              理由を記録して変更
            </button>
          </div>
        </Modal>
      )}
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={18} />
          {toast}
        </div>
      )}
      {busy && !progress && (
        <div className="working-pill" role="status">
          <LoaderCircle size={16} className="spin" />
          処理しています…
        </div>
      )}
      {creating && (
        <CreateDialog
          className={state.className}
          count={issuanceStudents.length}
          students={issuanceStudents}
          previous={
            revisionOf
              ? state.collections.find(
                  (collection) => collection.id === revisionOf,
                )
              : state.collections[0]
          }
          distributionDefaults={revisionOf ? undefined : state.settings}
          sample={sample}
          source={docsSource}
          busy={busy}
          progress={progress}
          error={error}
          onClose={() => {
            if (!busy) {
              setCreating(false);
              setDocsSource(null);
            }
          }}
          onCreate={create}
        />
      )}
      {resetPrompt && (
        <Modal
          title="新しいサンプルではじめる"
          onClose={() => setResetPrompt(false)}
        >
          <div style={{ padding: 24 }}>
            <p>
              現在の作業を架空40人の空のサンプルに置き換えます。必要な記録は先にバックアップしてください。
            </p>
            <button
              className="button secondary"
              onClick={() =>
                downloadBytes(
                  JSON.stringify(sanitizeStateForStorage(state), null, 2),
                  "paperflow-backup.json",
                  "application/json",
                )
              }
            >
              現在の記録をバックアップ
            </button>
          </div>
          <div className="modal-footer">
            <button
              className="button quiet"
              onClick={() => setResetPrompt(false)}
            >
              戻る
            </button>
            <button
              className="button primary"
              onClick={() => {
                resetWorkspace(createInitialState(), true, "サンプル");
                setResetPrompt(false);
              }}
            >
              サンプルを作り直す
            </button>
          </div>
        </Modal>
      )}
      {preview && (
        <Modal title={preview.title} onClose={() => setPreview(null)} wide>
          <PdfPreview bytes={preview.bytes} />
          <div className="modal-footer">
            <span className="muted">
              印刷は1ページ／面。両面・排紙順はプリンターで確認してください。
            </span>
            <a
              className="button primary"
              href={preview.url}
              download={`${preview.title}.pdf`}
            >
              <ArrowDownToLine size={16} />
              PDFを保存
            </a>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  unit,
  icon,
  detail,
  green,
}: {
  label: string;
  value: number;
  unit: string;
  icon: React.ReactNode;
  detail: string;
  green?: boolean;
}) {
  return (
    <div className={`stat-card ${green ? "stat-green" : ""}`}>
      <div className="stat-top">
        <span>{label}</span>
        {icon}
      </div>
      <div className="stat-value">
        {value}
        <span>{unit}</span>
      </div>
      <p>{detail}</p>
    </div>
  );
}
function CollectionRow({
  collection: c,
  state,
  onClick,
}: {
  collection: Collection;
  state: AppState;
  onClick: () => void;
}) {
  const complete = c.recipients.filter(
    (s) => getStudentStatus(c, s.id, state.receipts).status === "complete",
  ).length;
  return (
    <button className="collection-row" onClick={onClick}>
      <span className="document-icon">
        <FileText size={22} />
      </span>
      <span className="row-title">
        <b>{c.title}</b>
        <small>
          {c.className} <span>·</span> 期限 {formatDate(c.dueDate)}
        </small>
      </span>
      <div className="mini-progress">
        <span>
          <b>{complete}</b> / {c.recipients.length} 人
        </span>
        <div>
          <i
            style={{
              width: `${(complete / Math.max(1, c.recipients.length)) * 100}%`,
            }}
          />
        </div>
      </div>
      <Badge tone={complete === c.recipients.length ? "green" : "neutral"}>
        {complete === c.recipients.length ? "回収完了" : "回収受付中"}
      </Badge>
      <ChevronRight size={18} />
    </button>
  );
}

function ReviewCard({
  page,
  collection,
  receipts,
  onPreview,
  onCompare,
  onHold,
  onIgnore,
  onAssign,
  onReplace,
}: {
  page: ScanPage;
  collection: Collection;
  receipts: Receipt[];
  onPreview: () => void;
  onCompare: () => void;
  onHold: (reason: string) => void;
  onIgnore: (reason: string) => void;
  onAssign: (id: string, n: number, reason: string) => void;
  onReplace: (id: string, reason: string) => void;
}) {
  const [studentId, setStudentId] = useState(page.studentId ?? "");
  const [pageNumber, setPageNumber] = useState(
    page.pageNumber ?? collection.requiredPages[0],
  );
  const [holdReason, setHoldReason] = useState(page.reviewReason ?? "");
  const [confirmReplace, setConfirmReplace] = useState(false);
  const existing = receipts.find(
    (r) =>
      r.versionId === collection.versionId &&
      r.studentId === page.studentId &&
      r.pageNumber === page.pageNumber,
  );
  const labels = {
    duplicate: "重複するページ",
    unreadable: "QRを読み取れませんでした",
    unknown: "未登録のQR",
    foreign: "別の配布物",
    spacer: "印刷調整ページ",
    matched: "確認待ち",
    blank: "空白候補",
  };
  return (
    <div className="review-card panel">
      <button
        className="review-thumbnail"
        aria-label={`${page.sourcePage}ページ目を拡大`}
        onClick={onPreview}
      >
        {page.thumbnail ? (
          <img
            src={page.thumbnail}
            alt={`スキャン${page.sourcePage}ページ目`}
          />
        ) : (
          <FileText size={35} />
        )}
        <span>{page.sourcePage}ページ目 · 拡大</span>
      </button>
      <div className="review-body">
        <Badge tone="amber">要確認</Badge>
        <h3>{labels[page.status]}</h3>
        <p>
          {page.reason ??
            "紙の内容を確認し、正しい生徒とページを選んでください。"}
        </p>
        {page.status !== "foreign" && (
          <div className="assignment-fields">
            <select
              aria-label={`${page.sourcePage}ページ目の生徒`}
              value={studentId}
              onChange={(e) => setStudentId(e.target.value)}
            >
              <option value="">生徒を選択</option>
              {collection.recipients.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.number}　{s.name}
                </option>
              ))}
            </select>
            <select
              aria-label={`${page.sourcePage}ページ目のページ番号`}
              value={pageNumber}
              onChange={(e) => setPageNumber(Number(e.target.value))}
            >
              {Array.from(
                { length: collection.pageCount },
                (_, i) => i + 1,
              ).map((n) => (
                <option key={n} value={n}>
                  {n}ページ目
                </option>
              ))}
            </select>
            <button
              className="button secondary"
              disabled={!studentId || !holdReason.trim()}
              onClick={() => onAssign(studentId, pageNumber, holdReason.trim())}
            >
              照合する
            </button>
          </div>
        )}
        <div className="field-row">
          <label className="field">
            確認・保留・除外の理由
            <input
              value={holdReason}
              onChange={(e) => setHoldReason(e.target.value)}
              placeholder="例: 薄い文字のため再スキャン待ち"
            />
          </label>
          <button
            className="button quiet"
            disabled={!holdReason.trim()}
            onClick={() => onHold(holdReason.trim())}
          >
            理由を付けて保留
          </button>
        </div>
        <div className="review-actions">
          {existing && (
            <button className="text-button" onClick={onCompare}>
              既存と今回の画像を比較
            </button>
          )}
          <button
            className="text-button subtle"
            disabled={!holdReason.trim()}
            onClick={() => onIgnore(holdReason.trim())}
          >
            {page.status === "duplicate"
              ? "既存の記録を維持し、この元PDFページを全配布物で除外"
              : "この元PDFページを全配布物で除外"}
          </button>
          {page.status === "duplicate" && existing && (
            <button
              className="text-button warning-text"
              onClick={() => setConfirmReplace(true)}
            >
              このページに差し替える
            </button>
          )}
        </div>
        {confirmReplace && existing && (
          <div className="replace-confirm">
            <p>
              {
                collection.recipients.find((s) => s.id === existing.studentId)
                  ?.name
              }
              さんの{existing.pageNumber}ページ目を、この画像へ差し替えます。
            </p>
            <button
              className="button secondary"
              disabled={!holdReason.trim()}
              onClick={() => {
                onReplace(existing.id, holdReason.trim());
                setConfirmReplace(false);
              }}
            >
              差し替えを確定
            </button>
            <button
              className="button quiet"
              onClick={() => setConfirmReplace(false)}
            >
              やめる
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
