import { useEffect, useRef, type ReactNode } from "react";
import {
  X,
  Check,
  AlertCircle,
  LoaderCircle,
  ArrowUpRight,
  FileText,
} from "lucide-react";
export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
interface ModalFocusEntry {
  dialog: HTMLElement;
  previousFocus: HTMLElement | null;
}
const modalFocusStacks = new WeakMap<Document, ModalFocusEntry[]>();

export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const ownerDocument = dialog.ownerDocument;
    const stack = modalFocusStacks.get(ownerDocument) ?? [];
    const entry: ModalFocusEntry = { dialog, previousFocus };
    stack.push(entry);
    modalFocusStacks.set(ownerDocument, stack);
    const isTopModal = () => stack.at(-1) === entry;
    const focusableElements = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], button, input, select, textarea, iframe, [contenteditable="true"], [tabindex]',
        ),
      ).filter(
        (element) =>
          element.tabIndex >= 0 &&
          !element.matches(":disabled") &&
          !element.closest("[hidden], [inert]") &&
          element.getClientRects().length > 0 &&
          getComputedStyle(element).visibility !== "hidden",
      );
    let lastFocus: HTMLElement | null = null;
    const moveInside = () => {
      if (!isTopModal()) return;
      const elements = focusableElements();
      const target =
        lastFocus && elements.includes(lastFocus)
          ? lastFocus
          : (elements[0] ?? dialog);
      target.focus({ preventScroll: true });
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isTopModal() || event.defaultPrevented) return;
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusableElements();
      const first = elements[0];
      const last = elements.at(-1);
      if (!first || !last) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
      } else if (
        event.shiftKey &&
        (document.activeElement === first ||
          !elements.includes(document.activeElement as HTMLElement))
      ) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !elements.includes(document.activeElement as HTMLElement))
      ) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    const handleFocusIn = (event: FocusEvent) => {
      if (!isTopModal()) return;
      if (
        event.target instanceof HTMLElement &&
        dialog.contains(event.target)
      ) {
        lastFocus = event.target;
      } else {
        moveInside();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("focusin", handleFocusIn);
    moveInside();
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("focusin", handleFocusIn);
      const wasTop = isTopModal();
      const index = stack.indexOf(entry);
      if (index >= 0) stack.splice(index, 1);
      // If a background dialog is removed first, carry its return target to any
      // dialogs above it rather than later restoring focus into detached content.
      for (const remaining of stack)
        if (remaining.previousFocus && dialog.contains(remaining.previousFocus))
          remaining.previousFocus = entry.previousFocus;
      if (wasTop) {
        const target = entry.previousFocus?.isConnected
          ? entry.previousFocus
          : stack.at(-1)?.dialog;
        target?.focus({ preventScroll: true });
      }
      if (!stack.length) modalFocusStacks.delete(ownerDocument);
    };
  }, []);

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        tabIndex={-1}
        className={`modal ${wide ? "modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="modal-heading">
          <h2>{title}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="閉じる"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
export function Empty({
  title,
  detail,
  children,
}: {
  title: string;
  detail: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <FileText size={29} strokeWidth={1.4} />
      </div>
      <h3>{title}</h3>
      <p>{detail}</p>
      {children}
    </div>
  );
}
export function Notice({
  children,
  danger = false,
}: {
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <div className={`notice ${danger ? "danger" : ""}`}>
      <AlertCircle size={17} />
      <div>{children}</div>
    </div>
  );
}
export function ProgressBar({
  current,
  total,
  message,
}: {
  current: number;
  total: number;
  message: string;
}) {
  return (
    <div className="progress-box" role="status">
      <div>
        <LoaderCircle size={16} className="spin" />
        <span>{message}</span>
        <b>
          {current} / {total}
        </b>
      </div>
      <div className="progress-track">
        <div
          style={{
            width: `${Math.max(2, (current / Math.max(1, total)) * 100)}%`,
          }}
        />
      </div>
    </div>
  );
}
export function downloadBytes(
  bytes: Uint8Array | string,
  name: string,
  mime = "application/pdf",
) {
  const url = URL.createObjectURL(
    new Blob([typeof bytes === "string" ? bytes : new Uint8Array(bytes)], {
      type: mime,
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export function SaveIcon({ done }: { done: boolean }) {
  return done ? <Check size={16} /> : <ArrowUpRight size={16} />;
}
