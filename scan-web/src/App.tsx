import { useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDownToLine,
  BookOpen,
  CheckCircle2,
  FileSpreadsheet,
  FileUp,
  Loader2,
  QrCode,
  RefreshCw,
  X,
} from "lucide-react";
import {
  LEDGER_TEMPLATE_COPY_URL,
  LEDGER_TEMPLATE_URL_IS_PLACEHOLDER,
} from "./config";
import type {
  Progress,
  ScanCsvStatus,
  ScanPage,
  ScanSession,
} from "./domain/types";
import {
  applyDuplicateChoices,
  buildScanCsvRows,
  createScanCsv,
  duplicateGroups,
} from "./domain/scanCsv";
import { scanPdf } from "./pdfClient";

const MAX_PDF_BYTES = 100 * 1024 * 1024;

const statusLabel: Record<ScanCsvStatus | "excluded", string> = {
  ok: "読み取りOK",
  unreadable: "読取不可",
  duplicate: "重複",
  excluded: "対象外",
};

const statusTone: Record<ScanCsvStatus | "excluded", "ok" | "warn" | "muted"> =
  {
    ok: "ok",
    unreadable: "warn",
    duplicate: "warn",
    excluded: "muted",
  };

function messageOf(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "処理を完了できませんでした。もう一度お試しください。";
}

function shortToken(token: string): string {
  return token.length > 14 ? `${token.slice(0, 10)}…` : token;
}

function downloadText(text: string, name: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/csv;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function csvFileName(sourceFile: string): string {
  return `${sourceFile.replace(/\.pdf$/i, "")}_QR結果.csv`;
}

export default function App() {
  const fileInput = useRef<HTMLInputElement | null>(null);

  const [file, setFile] = useState<{ name: string; bytes: Uint8Array } | null>(
    null,
  );
  const [session, setSession] = useState<ScanSession | null>(null);
  const [duplicateChoices, setDuplicateChoices] = useState<
    Record<string, number>
  >({});
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dragging, setDragging] = useState(false);

  const groups = useMemo(
    () => (session ? duplicateGroups(session.pages) : []),
    [session],
  );
  const effectivePages = useMemo(
    () =>
      session ? applyDuplicateChoices(session.pages, duplicateChoices) : [],
    [session, duplicateChoices],
  );
  const rows = useMemo(
    () =>
      session
        ? buildScanCsvRows(effectivePages, {
            scanId: session.id,
            scannedAt: session.createdAt,
            sourceFile: session.fileName,
          })
        : [],
    [session, effectivePages],
  );
  const statusByPage = useMemo(() => {
    const map = new Map<number, ScanCsvStatus | "excluded">();
    for (const page of effectivePages)
      map.set(page.sourcePage, page.excluded ? "excluded" : "ok");
    for (const row of rows) map.set(row.page, row.status);
    return map;
  }, [effectivePages, rows]);

  const counts = useMemo(() => {
    const unreadable = rows.filter((row) => row.status === "unreadable");
    const duplicate = rows.filter((row) => row.status === "duplicate");
    return {
      ok: rows.filter((row) => row.status === "ok").length,
      unreadable: unreadable.length,
      duplicate: duplicate.length,
      excluded: effectivePages.filter((page) => page.excluded).length,
    };
  }, [rows, effectivePages]);

  const unreadablePages = useMemo(
    () =>
      (session?.pages ?? [])
        .filter((page) => !page.token)
        .sort((a, b) => a.sourcePage - b.sourcePage),
    [session],
  );

  function clearResult() {
    setSession(null);
    setDuplicateChoices({});
    setProgress(null);
    setNotice("");
  }

  async function importFile(nextFile: File | undefined) {
    if (!nextFile) return;
    setError("");
    if (nextFile.size > MAX_PDF_BYTES) {
      setError("PDFは100MiB以下のファイルを選択してください。");
      return;
    }
    try {
      const bytes = new Uint8Array(await nextFile.arrayBuffer());
      setFile({ name: nextFile.name, bytes });
      clearResult();
    } catch {
      setError("PDFを読み込めませんでした。ファイルを選び直してください。");
    }
  }

  async function analyze() {
    if (!file) return;
    setBusy(true);
    setError("");
    setNotice("");
    setProgress(null);
    try {
      const pages = await scanPdf({
        bytes: file.bytes,
        onProgress: setProgress,
      });
      setSession({
        id: crypto.randomUUID(),
        fileName: file.name,
        pageCount: pages.length,
        createdAt: new Date().toISOString(),
        pages,
      });
      setDuplicateChoices({});
      const readable = pages.filter((page) => page.token).length;
      setNotice(
        `${pages.length}ページを読み取りました。トークンあり ${readable}ページ、読取不可 ${pages.length - readable}ページです。`,
      );
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  function toggleExclude(page: ScanPage) {
    if (!session) return;
    setSession({
      ...session,
      pages: session.pages.map((item) =>
        item.sourcePage === page.sourcePage
          ? { ...item, excluded: !item.excluded }
          : item,
      ),
    });
  }

  function chooseAuthoritative(token: string, value: string) {
    if (!session) return;
    const chosen = value ? Number(value) : undefined;
    // Clear manual exclusions inside the group so the choice is predictable.
    setSession({
      ...session,
      pages: session.pages.map((page) =>
        page.token === token ? { ...page, excluded: false } : page,
      ),
    });
    setDuplicateChoices((current) => {
      const next = { ...current };
      if (chosen === undefined) delete next[token];
      else next[token] = chosen;
      return next;
    });
  }

  function downloadCsv() {
    if (!session) return;
    downloadText(
      createScanCsv(effectivePages, {
        scanId: session.id,
        scannedAt: session.createdAt,
        sourceFile: session.fileName,
      }),
      csvFileName(session.fileName),
    );
  }

  return (
    <div className="app-shell" id="top">
      <header className="site-header">
        <div className="brand">
          <span className="brand-mark">
            <QrCode size={22} />
          </span>
          <div>
            <strong>TABANE</strong>
            <span>回収PDFのQR結果をCSVにするサイト</span>
          </div>
        </div>
        <div className="header-actions">
          <span className="header-note">アカウント不要 / ブラウザ内で処理</span>
          <a className="header-link" href="#guide">
            使用法
          </a>
        </div>
      </header>

      <main>
        <section className="hero">
          <div>
            <p className="eyebrow">回収PDF → QR結果CSV</p>
            <h1>読み取って、確認して、CSVへ。</h1>
            <p>
              回収PDFのQRを読み取り、1ページ1行のCSVを作ります。アカウント接続は不要です。CSVは台帳スプレッドシートの「QR結果を読み取る」から取り込んでください。
            </p>
          </div>
          <ol className="flow">
            <li className={file ? "done" : "current"}>1. PDFを選ぶ</li>
            <li className={session ? "done" : file ? "current" : ""}>
              2. QRを読み取る
            </li>
            <li className={session ? "current" : ""}>3. 要確認を確認</li>
            <li className={session ? "current" : ""}>4. CSVをダウンロード</li>
          </ol>
        </section>

        <section className="start-panel" aria-labelledby="start-title">
          <div className="start-copy">
            <p className="eyebrow">はじめに</p>
            <h2 id="start-title">台帳テンプレートを入手</h2>
            <p>
              名簿・QR発行・回収状況をまとめる台帳スプレッドシートのテンプレートです。自分の
              Google ドライブにコピーして使います。
            </p>
            {LEDGER_TEMPLATE_URL_IS_PLACEHOLDER && (
              <p className="fine-print warn-text">
                テンプレートの公開 URL
                は準備中です。確定後にこのボタンのリンク先を差し替えます。
              </p>
            )}
          </div>
          <div className="start-actions">
            <a
              className="button primary"
              href={LEDGER_TEMPLATE_COPY_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              <FileSpreadsheet size={17} />
              台帳テンプレートを入手
            </a>
            <a className="text-button guide-link" href="#guide">
              <BookOpen size={15} />
              使用法はこちら
            </a>
          </div>
        </section>

        {error && (
          <div className="alert error" role="alert">
            <AlertTriangle size={18} />
            <span>{error}</span>
            <button
              className="icon-button"
              aria-label="閉じる"
              onClick={() => setError("")}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {notice && (
          <div className="alert info" role="status">
            <CheckCircle2 size={18} />
            <span>{notice}</span>
          </div>
        )}

        <section className="panel">
          <div className="panel-head">
            <div>
              <p className="step">STEP 1</p>
              <h2>回収PDFを選ぶ</h2>
            </div>
            {file && <span className="pill">{file.name}</span>}
          </div>

          <div
            className={`dropzone${dragging ? " dragging" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              if (busy) return;
              void importFile(event.dataTransfer.files?.[0]);
            }}
          >
            <FileUp size={30} />
            <p>
              {file
                ? file.name
                : "回収PDFをドラッグ＆ドロップ、またはファイルを選択"}
            </p>
            <label className="button secondary">
              ファイルを選択
              <input
                ref={fileInput}
                type="file"
                accept="application/pdf,.pdf"
                hidden
                disabled={busy}
                onChange={(event) => {
                  void importFile(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
            </label>
            <span className="fine-print">
              100MiBまで /
              200ページまで。PDFはこのブラウザ内だけで解析し、どこにも送信しません。
            </span>
          </div>

          <div className="action-row">
            <button
              className="button primary"
              onClick={() => void analyze()}
              disabled={!file || busy}
            >
              {busy && progress ? (
                <Loader2 className="spin" size={17} />
              ) : (
                <QrCode size={17} />
              )}
              QRを読み取る
            </button>
            {session && (
              <button
                className="button secondary"
                onClick={() => void analyze()}
                disabled={busy}
              >
                <RefreshCw size={16} />
                もう一度読み取る
              </button>
            )}
            {progress && (
              <div className="progress">
                <div
                  className="progress-bar"
                  style={{
                    width: `${progress.total ? (progress.current / progress.total) * 100 : 0}%`,
                  }}
                />
                <span>{progress.message}</span>
              </div>
            )}
          </div>
        </section>

        {session && (
          <>
            <section className="panel">
              <div className="panel-head">
                <div>
                  <p className="step">STEP 2</p>
                  <h2>要確認のページを確認する</h2>
                </div>
                <div className="counts">
                  <span className="pill ok">読み取りOK {counts.ok}</span>
                  <span className="pill warn">
                    読取不可 {counts.unreadable}
                  </span>
                  <span className="pill warn">重複 {counts.duplicate}</span>
                  <span className="pill muted">対象外 {counts.excluded}</span>
                </div>
              </div>
              <p className="fine-print">
                読取不可のページと重複したページを、ページ画像で確認してください。読取不可のページは証跡としてCSVに残ります。対象外にしたページはCSVに含めず、重複の判定にも数えません。
              </p>

              {!unreadablePages.length && !groups.length && (
                <div className="review-toolbar">
                  <span>要確認のページはありません。</span>
                </div>
              )}

              {unreadablePages.length > 0 && (
                <>
                  <h3 className="section-title">
                    読取不可 {unreadablePages.length}ページ
                  </h3>
                  <div className="page-list">
                    {unreadablePages.map((page) => (
                      <article
                        className={`page-row warn${
                          page.excluded ? " excluded" : ""
                        }`}
                        key={page.sourcePage}
                      >
                        {page.thumbnail ? (
                          <img
                            src={page.thumbnail}
                            alt={`元PDF ${page.sourcePage}ページ`}
                            loading="lazy"
                          />
                        ) : (
                          <div className="thumb-placeholder">
                            <FileUp size={22} />
                          </div>
                        )}
                        <div className="page-body">
                          <div className="page-title">
                            <strong>{page.sourcePage}ページ</strong>
                            <span className="pill warn">読取不可</span>
                            {page.excluded && (
                              <span className="pill muted">対象外</span>
                            )}
                          </div>
                          <p className="page-reason">
                            {page.reason ?? "QRを読み取れませんでした。"}
                          </p>
                        </div>
                        <div className="page-actions">
                          <button
                            className={`text-button${
                              page.excluded ? "" : " danger"
                            }`}
                            onClick={() => toggleExclude(page)}
                            disabled={busy}
                          >
                            {page.excluded ? "対象外を戻す" : "対象外にする"}
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                </>
              )}

              {groups.length > 0 && (
                <>
                  <h3 className="section-title">
                    重複 {groups.length}組（同じトークンが複数ページ）
                  </h3>
                  <div className="duplicate-list">
                    {groups.map((group) => {
                      const chosen = duplicateChoices[group.token];
                      return (
                        <article className="duplicate-group" key={group.token}>
                          <div className="duplicate-head">
                            <strong>
                              {group.pages
                                .map((page) => `${page.sourcePage}ページ`)
                                .join(" / ")}
                            </strong>
                            <span className="token">
                              {shortToken(group.token)}
                            </span>
                          </div>
                          <div className="duplicate-options">
                            <label className="checkbox-label">
                              <input
                                type="radio"
                                name={`dup-${group.token}`}
                                checked={chosen === undefined}
                                onChange={() =>
                                  chooseAuthoritative(group.token, "")
                                }
                                disabled={busy}
                              />
                              重複のまま残す（最初のページを ok、後のページを
                              duplicate として出力）
                            </label>
                            {group.pages.map((page) => (
                              <label
                                className="checkbox-label"
                                key={page.sourcePage}
                              >
                                <input
                                  type="radio"
                                  name={`dup-${group.token}`}
                                  checked={chosen === page.sourcePage}
                                  onChange={() =>
                                    chooseAuthoritative(
                                      group.token,
                                      String(page.sourcePage),
                                    )
                                  }
                                  disabled={busy}
                                />
                                {page.sourcePage}
                                ページを正とする（他のページは対象外）
                              </label>
                            ))}
                          </div>
                          <div className="thumb-grid">
                            {group.pages.map((page) => (
                              <figure key={page.sourcePage}>
                                {page.thumbnail ? (
                                  <img
                                    src={page.thumbnail}
                                    alt={`元PDF ${page.sourcePage}ページ`}
                                    loading="lazy"
                                  />
                                ) : (
                                  <div className="thumb-placeholder">
                                    <FileUp size={18} />
                                  </div>
                                )}
                                <figcaption>{page.sourcePage}ページ</figcaption>
                              </figure>
                            ))}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </>
              )}

              <details className="all-pages">
                <summary>
                  すべてのページを表示（{session.pageCount}ページ）
                </summary>
                <div className="thumb-grid">
                  {[...session.pages]
                    .sort((a, b) => a.sourcePage - b.sourcePage)
                    .map((page) => {
                      const status = statusByPage.get(page.sourcePage) ?? "ok";
                      return (
                        <figure key={page.sourcePage}>
                          {page.thumbnail ? (
                            <img
                              src={page.thumbnail}
                              alt={`元PDF ${page.sourcePage}ページ`}
                              loading="lazy"
                            />
                          ) : (
                            <div className="thumb-placeholder">
                              <FileUp size={18} />
                            </div>
                          )}
                          <figcaption>
                            {page.sourcePage}ページ
                            <span className={`pill ${statusTone[status]}`}>
                              {statusLabel[status]}
                            </span>
                          </figcaption>
                        </figure>
                      );
                    })}
                </div>
              </details>
            </section>

            <section className="panel">
              <div className="panel-head">
                <div>
                  <p className="step">STEP 3</p>
                  <h2>QR結果CSVをダウンロードする</h2>
                </div>
                <span className="pill">{rows.length}行</span>
              </div>
              <div className="ledger-summary">
                <div>
                  <span>元のPDF</span>
                  <strong>{session.fileName}</strong>
                </div>
                <div>
                  <span>スキャンID</span>
                  <strong>{session.id.slice(0, 8)}…</strong>
                </div>
                <div>
                  <span>読取日時</span>
                  <strong>
                    {new Date(session.createdAt).toLocaleString()}
                  </strong>
                </div>
                <div>
                  <span>CSVの行数</span>
                  <strong>{rows.length}行</strong>
                </div>
              </div>
              <p className="fine-print">
                列は scan_id, scanned_at, source_file, page, token, status, note
                です。status は ok / unreadable / duplicate
                のみで、対象外にしたページは出力しません。
              </p>
              <div className="action-row">
                <button
                  className="button primary"
                  onClick={downloadCsv}
                  disabled={busy || !rows.length}
                >
                  <ArrowDownToLine size={17} />
                  CSVをダウンロード
                </button>
                <button
                  className="button secondary"
                  onClick={() => {
                    setFile(null);
                    clearResult();
                    setError("");
                  }}
                  disabled={busy}
                >
                  別のPDFを選ぶ
                </button>
              </div>
            </section>
          </>
        )}

        <section
          id="guide"
          className="panel guide"
          aria-labelledby="guide-title"
        >
          <div className="panel-head">
            <div>
              <p className="step">使い方ガイド</p>
              <h2 id="guide-title">テンプレート入手から提出確認まで</h2>
            </div>
            <a className="text-button" href="#top">
              ページ上部へ
            </a>
          </div>
          <ol className="guide-steps">
            <li>
              <h3>1. 台帳テンプレートをコピーする</h3>
              <p>
                上の「台帳テンプレートを入手」を押し、Google
                スプレッドシートのコピーを作成します。初回にメニューを実行したとき、スクリプトの実行認可を求められます。内容を確認して許可してください。
              </p>
            </li>
            <li>
              <h3>2. 台帳で「初期設定」を実行し、名簿を入れる</h3>
              <p>
                コピーした台帳を開き、メニュー <code>TABANE → 初期設定</code>{" "}
                を実行します。「名簿」タブに出席番号・氏名（必要なら生徒ID・座席の行と列）を直接入力するか、メニュー{" "}
                <code>TABANE → 名簿をCSVから取り込む</code>{" "}
                を使います。座席を決めるときは「座席表」タブのセルに出席番号または氏名を入れてください。正本は「名簿」タブの行・列です。
              </p>
            </li>
            <li>
              <h3>3. 必要なら、原稿 Doc のサイドバーで「QRを予約する」</h3>
              <p>
                原稿の Google Doc を開き、メニュー{" "}
                <code>TABANE → TABANEを開く</code>{" "}
                でサイドバーを開きます。用紙が A4
                縦であることを確認し、「QRを予約する」を押すと、原稿の上余白に
                QR
                帯の場所が確保されます。予約は任意です。予約しなくても、台帳側が管理帯方式で組み立てます。
              </p>
            </li>
            <li>
              <h3>4. 台帳の「QR発行」タブで発行し、印刷・配布・回収する</h3>
              <p>
                「QR発行」タブの
                B2〜B3（原稿DocのURL、配布物名）を入力し、メニュー{" "}
                <code>TABANE → QRを発行</code>{" "}
                を実行します。出力欄に出た印刷用 PDF
                を印刷して配布し、回収してください。
              </p>
            </li>
            <li>
              <h3>5. 回収した紙をスキャンした PDF を、このサイトで読み取る</h3>
              <p>
                回収した紙をスキャンして PDF にまとめ、上の STEP 1
                で選びます。「QRを読み取る」→ 要確認のページを確認 →
                「CSVをダウンロード」の順に進めてください。読み取りと CSV
                作成は、このブラウザ内だけで完結します。
              </p>
            </li>
            <li>
              <h3>6. 台帳に CSV を取り込み、「提出一覧」で確認する</h3>
              <p>
                台帳のメニュー <code>TABANE → QR結果を読み取る</code>{" "}
                で、ダウンロードした CSV
                を選んで取り込みます。取り込みのたびに「提出一覧_…」タブができ、出席番号・氏名ごとの
                提出済み / 未提出と、要確認の内容を確認できます。判定は対応表と回収記録の累積で行われます。
              </p>
            </li>
          </ol>
          <p className="guide-note">
            名簿や生徒情報がこのサイト（Web）に送信されることはありません。このサイトが扱うのは、回収
            PDF
            と、そこから読み取ったトークン・ページ番号だけです。名簿の管理は台帳スプレッドシートの中で完結します。
          </p>
        </section>

        <section className="notes">
          <h2>このサイトが行わないこと</h2>
          <ul>
            <li>Googleアカウントへの接続、台帳の読み込み・書き込み</li>
            <li>QR付き印刷PDFの発行、名簿・座席表の編集</li>
            <li>回収状況の管理ダッシュボード</li>
          </ul>
          <p>
            回収PDFはブラウザ内だけで解析し、外部へ送信しません。ダウンロードしたCSVは台帳スプレッドシートの「QR結果を読み取る」から取り込んでください。
          </p>
        </section>
      </main>
    </div>
  );
}
