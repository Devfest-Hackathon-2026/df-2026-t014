import { useEffect, useRef, useState } from "react";
import "./PdfPreview.css";

export interface PdfPreviewProps {
  bytes: Uint8Array;
  title?: string;
  onPageViewed?: (page: number, count: number) => void;
  page?: number;
  onPageChange?: (page: number) => void;
}

interface PreviewState {
  bytes: Uint8Array;
  page: number;
  count: number;
  image: string;
  loading: boolean;
  error: string;
}

/** A browser-independent preview that renders only the currently selected PDF page. */
export function PdfPreview({
  bytes,
  title,
  onPageViewed,
  page: controlledPage,
  onPageChange,
}: PdfPreviewProps) {
  const [selection, setSelection] = useState({ bytes, page: 1 });
  const [retry, setRetry] = useState(0);
  const [preview, setPreview] = useState<PreviewState>({
    bytes,
    page: 1,
    count: 0,
    image: "",
    loading: true,
    error: "",
  });
  const pageCount = useRef<{ bytes: Uint8Array; count: number } | null>(null);
  const viewedCallback = useRef(onPageViewed);
  viewedCallback.current = onPageViewed;
  const page =
    controlledPage ?? (selection.bytes === bytes ? selection.page : 1);
  const current =
    preview.bytes === bytes && preview.page === page ? preview : null;
  const count = preview.bytes === bytes ? preview.count : 0;
  const loading = current === null || current.loading;

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setPreview({
      bytes,
      page,
      count: pageCount.current?.bytes === bytes ? pageCount.current.count : 0,
      image: "",
      loading: true,
      error: "",
    });
    void (async () => {
      try {
        const { getPdfPageCount, renderPdfPage } = await import("./pdf");
        if (cancelled) return;
        const total =
          pageCount.current?.bytes === bytes
            ? pageCount.current.count
            : await getPdfPageCount(bytes);
        if (cancelled) return;
        if (total < 1) throw new Error("表示できるページがありません。");
        pageCount.current = { bytes, count: total };
        setPreview({
          bytes,
          page,
          count: total,
          image: "",
          loading: true,
          error: "",
        });
        const image = await renderPdfPage(bytes, page, controller.signal);
        if (!cancelled) {
          setPreview({
            bytes,
            page,
            count: total,
            image,
            loading: false,
            error: "",
          });
          viewedCallback.current?.(page, total);
        }
      } catch (error) {
        if (!cancelled)
          setPreview({
            bytes,
            page,
            count:
              pageCount.current?.bytes === bytes ? pageCount.current.count : 0,
            image: "",
            loading: false,
            error:
              error instanceof Error
                ? error.message
                : "PDFのプレビューを表示できませんでした。",
          });
      }
    })();
    // renderPdfPage releases its PDF.js document after each render. Ignore stale results on navigation/unmount.
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [bytes, page, retry]);

  const move = (delta: number) => {
    const next = Math.max(1, Math.min(count, page + delta));
    setSelection({ bytes, page: next });
    onPageChange?.(next);
  };

  return (
    <section
      className="paperflow-pdf-preview"
      aria-label={title ?? "PDFプレビュー"}
      aria-busy={loading}
    >
      {title && <p className="paperflow-pdf-title">{title}</p>}
      <div className="paperflow-pdf-toolbar">
        <button
          type="button"
          className="button secondary"
          onClick={() => move(-1)}
          disabled={loading || page <= 1}
          aria-label="前のページ"
        >
          ← 前へ
        </button>
        <span className="paperflow-pdf-page" aria-live="polite">
          {count ? `${page} / ${count} ページ` : "ページ数を確認中"}
        </span>
        <button
          type="button"
          className="button secondary"
          onClick={() => move(1)}
          disabled={loading || !count || page >= count}
          aria-label="次のページ"
        >
          次へ →
        </button>
      </div>
      <div className="paperflow-pdf-stage">
        {loading && (
          <p className="paperflow-pdf-message" role="status">
            プレビューを準備しています…
          </p>
        )}
        {!loading && current?.error && (
          <div className="paperflow-pdf-error">
            <div className="notice danger" role="alert">
              {current.error}
            </div>
            <button
              type="button"
              className="button secondary"
              onClick={() => setRetry((value) => value + 1)}
            >
              再読み込み
            </button>
          </div>
        )}
        {!loading && current?.image && (
          <img
            className="paperflow-pdf-image"
            src={current.image}
            alt={`PDFの${page}ページ目`}
          />
        )}
      </div>
    </section>
  );
}

export default PdfPreview;
