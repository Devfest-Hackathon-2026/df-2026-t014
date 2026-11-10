import type { DistributionOrder, QrCorner } from "../domain/types";

export interface DocsSettings {
  className?: string;
  classKey?: string;
  count?: number;
  title?: string;
  dueDate?: string;
  qrCorner?: QrCorner;
  startCorner?: QrCorner;
  order?: DistributionOrder;
  reverse?: boolean;
  duplex?: boolean;
  showNames?: boolean;
  layoutMode?: "reserved-corner" | "management-band";
}
export interface DocsSource {
  documentId: string;
  accountEmail?: string;
  defaults?: DocsSettings;
  sourceHash?: string;
  exportedAt?: string;
  name: string;
  bytes: Uint8Array;
}
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

function bridgeContext(): { nonce: string; parentOrigin: string } | undefined {
  if (typeof window === "undefined" || window.parent === window)
    return undefined;
  const params = new URLSearchParams(window.location.hash.slice(1));
  const nonce = params.get("paperflowBridge"),
    parentOrigin = params.get("paperflowParentOrigin");
  if (!nonce || !/^[a-f0-9-]{32,64}$/i.test(nonce) || !parentOrigin)
    return undefined;
  try {
    const url = new URL(parentOrigin);
    if (
      url.origin !== parentOrigin ||
      url.protocol !== "https:" ||
      !(
        url.hostname === "script.google.com" ||
        url.hostname.endsWith(".googleusercontent.com")
      )
    )
      return undefined;
  } catch {
    return undefined;
  }
  return { nonce, parentOrigin };
}

function safeSettings(value: unknown): DocsSettings {
  const source = (value && typeof value === "object" ? value : {}) as Record<
    string,
    unknown
  >;
  const result: DocsSettings = {};
  for (const key of ["className", "classKey", "title", "dueDate"] as const)
    if (typeof source[key] === "string" && source[key].length <= 500)
      result[key] = source[key];
  for (const key of ["reverse", "duplex", "showNames"] as const)
    if (typeof source[key] === "boolean") result[key] = source[key];
  if (
    typeof source.count === "number" &&
    Number.isSafeInteger(source.count) &&
    source.count > 0 &&
    source.count <= 1000
  )
    result.count = source.count;
  if (
    ["top-right", "top-left", "bottom-right", "bottom-left"].includes(
      String(source.qrCorner),
    )
  )
    result.qrCorner = source.qrCorner as QrCorner;
  if (
    ["top-right", "top-left", "bottom-right", "bottom-left"].includes(
      String(source.startCorner),
    )
  )
    result.startCorner = source.startCorner as QrCorner;
  if (["row", "column", "snake", "number"].includes(String(source.order)))
    result.order = source.order as DistributionOrder;
  if (
    source.layoutMode === "reserved-corner" ||
    source.layoutMode === "management-band"
  )
    result.layoutMode = source.layoutMode;
  return result;
}

/** Sends only print preferences to the add-on; no access token, roster, or file bytes. */
export function sendDocsSettings(settings: DocsSettings): boolean {
  const context = bridgeContext();
  if (!context) return false;
  window.parent.postMessage(
    {
      type: "paperflow:web-settings",
      nonce: context.nonce,
      settings: safeSettings(settings),
    },
    context.parentOrigin,
  );
  return true;
}

/** User-triggered recheck. A changed document must be re-exported and previewed before printing. */
export function checkDocsSource(
  sourceHash: string,
): Promise<{ unchanged: boolean; sourceHash: string }> {
  const context = bridgeContext();
  if (!context || !/^[a-f0-9]{64}$/i.test(sourceHash))
    return Promise.reject(
      new Error(
        "Docs原稿の再確認を開始できません。Docsから原稿を読み込み直してください。",
      ),
    );
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener("message", receive);
    };
    const receive = (event: MessageEvent) => {
      if (
        event.source !== window.parent ||
        event.origin !== context.parentOrigin ||
        event.data?.nonce !== context.nonce ||
        event.data?.type !== "paperflow:source-check" ||
        event.data?.requestId !== requestId
      )
        return;
      cleanup();
      if (typeof event.data.error === "string") {
        reject(new Error(event.data.error.slice(0, 500)));
        return;
      }
      if (
        typeof event.data.unchanged !== "boolean" ||
        typeof event.data.sourceHash !== "string" ||
        !/^[a-f0-9]{64}$/i.test(event.data.sourceHash)
      ) {
        reject(new Error("Docs原稿の確認結果を検証できませんでした。"));
        return;
      }
      resolve({
        unchanged: event.data.unchanged && event.data.sourceHash === sourceHash,
        sourceHash: event.data.sourceHash,
      });
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          "Docs原稿の再確認が時間内に完了しませんでした。再試行してください。",
        ),
      );
    }, 60_000);
    window.addEventListener("message", receive);
    window.parent.postMessage(
      {
        type: "paperflow:check-source",
        nonce: context.nonce,
        requestId,
        sourceHash,
      },
      context.parentOrigin,
    );
  });
}

/** Receives only source PDF data. It never accepts OAuth tokens or executes API operations. */
export function listenForDocsSource(
  onSource: (source: DocsSource) => void,
  onError?: (message: string) => void,
): () => void {
  const context = bridgeContext();
  if (!context) return () => undefined;
  const { nonce, parentOrigin } = context;
  const receive = (event: MessageEvent) => {
    if (
      event.source !== window.parent ||
      event.origin !== parentOrigin ||
      event.data?.nonce !== nonce ||
      event.data?.type !== "paperflow:docs-source"
    )
      return;
    const source = event.data.source as Record<string, unknown> | undefined;
    if (
      !source ||
      typeof source.base64 !== "string" ||
      typeof source.name !== "string" ||
      typeof source.documentId !== "string" ||
      source.base64.length > Math.ceil(MAX_SOURCE_BYTES / 3) * 4
    ) {
      onError?.(
        "Docsから受け取った原稿を読み込めませんでした。20MB以下のPDFを使用してください。",
      );
      return;
    }
    try {
      const binary = atob(source.base64);
      if (!binary.startsWith("%PDF-") || binary.length > MAX_SOURCE_BYTES)
        throw new Error("not a PDF");
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      onSource({
        documentId: source.documentId,
        name: source.name,
        bytes,
        defaults: safeSettings(source.defaults),
        ...(typeof source.accountEmail === "string" &&
        source.accountEmail.trim()
          ? { accountEmail: source.accountEmail.trim().toLowerCase() }
          : {}),
        ...(typeof source.sourceHash === "string" &&
        /^[a-f0-9]{64}$/i.test(source.sourceHash)
          ? { sourceHash: source.sourceHash }
          : {}),
        ...(typeof source.exportedAt === "string" &&
        Number.isFinite(Date.parse(source.exportedAt))
          ? { exportedAt: source.exportedAt }
          : {}),
      });
    } catch {
      onError?.("Docsから受け取った原稿がPDFではないか、破損しています。");
    }
  };
  window.addEventListener("message", receive);
  window.parent.postMessage(
    { type: "paperflow:web-ready", nonce },
    parentOrigin,
  );
  return () => window.removeEventListener("message", receive);
}
