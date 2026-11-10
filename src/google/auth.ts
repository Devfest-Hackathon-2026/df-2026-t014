import { GoogleApiError } from "./errors";

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/classroom.courses.readonly",
  "https://www.googleapis.com/auth/classroom.rosters.readonly",
  "https://www.googleapis.com/auth/drive.file",
] as const;

interface TokenResponse {
  access_token?: string;
  expires_in?: number | string;
  scope?: string;
  error?: string;
}
interface GoogleIdentityServices {
  accounts: {
    oauth2: {
      initTokenClient(options: {
        client_id: string;
        scope: string;
        include_granted_scopes: boolean;
        callback: (response: TokenResponse) => void;
        error_callback: (error: { type?: string }) => void;
      }): { requestAccessToken(options: { prompt: string }): void };
    };
  };
}
type GoogleWindow = Window & { google?: GoogleIdentityServices };

export type TokenState = "connected" | "disconnected" | "expired";

let gisLoading: Promise<void> | undefined;

/** Loads Google's SDK only when explicitly called; it does not authorize or send user files. */
export function prepareGoogleIdentity(): Promise<void> {
  if (typeof window === "undefined")
    return Promise.reject(
      new GoogleApiError(
        "CONFIG_REQUIRED",
        "Google接続はブラウザで実行してください。",
      ),
    );
  if ((window as GoogleWindow).google?.accounts?.oauth2)
    return Promise.resolve();
  if (gisLoading) return gisLoading;
  gisLoading = new Promise<void>((resolve, reject) => {
    const previous = document.querySelector<HTMLScriptElement>(
      "script[data-paperflow-gis]",
    );
    const script = previous ?? document.createElement("script");
    const timer = window.setTimeout(
      () =>
        finish(
          new GoogleApiError(
            "NETWORK",
            "Google認証の読み込みが完了しませんでした。ネットワークを確認して再試行してください。",
          ),
        ),
      20_000,
    );
    const finish = (error?: Error) => {
      window.clearTimeout(timer);
      script.removeEventListener("load", loaded);
      script.removeEventListener("error", failed);
      if (error) {
        script.remove();
        reject(error);
      } else resolve();
    };
    const loaded = () =>
      (window as GoogleWindow).google?.accounts?.oauth2
        ? finish()
        : finish(
            new GoogleApiError("NETWORK", "Google認証を読み込めませんでした。"),
          );
    const failed = () =>
      finish(
        new GoogleApiError("NETWORK", "Google認証を読み込めませんでした。"),
      );
    script.addEventListener("load", loaded, { once: true });
    script.addEventListener("error", failed, { once: true });
    if (!previous) {
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.dataset.paperflowGis = "true";
      document.head.appendChild(script);
    }
  }).catch((error) => {
    gisLoading = undefined;
    throw error;
  });
  return gisLoading;
}

/** This session intentionally has no persistent storage, refresh token, or automatic login. */
export class GoogleTokenSession {
  private token: string | undefined;
  private expiresAt = 0;
  private connecting: Promise<void> | undefined;
  private generation = 0;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private readonly listeners = new Set<(state: TokenState) => void>();

  constructor(private readonly clientId: string) {}

  isConnected(): boolean {
    if (this.token && Date.now() >= this.expiresAt) this.clear("expired");
    return Boolean(this.token && Date.now() < this.expiresAt);
  }
  subscribe(listener: (state: TokenState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private notify(state: TokenState): void {
    for (const listener of this.listeners) listener(state);
  }
  clear(reason: TokenState = "disconnected"): void {
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    this.token = undefined;
    this.expiresAt = 0;
    this.generation += 1;
    this.notify(reason);
  }
  getAccessToken(): string {
    if (!this.token)
      throw new GoogleApiError(
        "AUTH_REQUIRED",
        "Googleに接続してから操作してください。",
      );
    if (Date.now() >= this.expiresAt) {
      this.clear("expired");
      throw new GoogleApiError(
        "AUTH_EXPIRED",
        "Google認可の有効期限が切れました。再接続してから保存を再開してください。",
      );
    }
    return this.token;
  }

  /** Call from an explicit user gesture. A blocked popup is reported, never treated as success. */
  async connect(): Promise<void> {
    if (
      !this.clientId.trim() ||
      !this.clientId.endsWith(".apps.googleusercontent.com")
    ) {
      throw new GoogleApiError(
        "CONFIG_REQUIRED",
        "Google連携が未設定です。VITE_GOOGLE_CLIENT_IDにWeb用OAuthクライアントIDを設定してください。デモは接続せず利用できます。",
      );
    }
    if (this.connecting) return this.connecting;
    this.clear();
    const generation = this.generation;
    this.connecting = (async () => {
      await prepareGoogleIdentity();
      if (this.generation !== generation)
        throw new GoogleApiError("AUTH_DENIED", "接続を取り消しました。");
      await new Promise<void>((resolve, reject) => {
        const google = (window as GoogleWindow).google!;
        const client = google.accounts.oauth2.initTokenClient({
          client_id: this.clientId,
          scope: GOOGLE_SCOPES.join(" "),
          include_granted_scopes: false,
          callback: (response) => {
            if (this.generation !== generation) {
              reject(
                new GoogleApiError("AUTH_DENIED", "接続を取り消しました。"),
              );
              return;
            }
            if (response.error || !response.access_token) {
              reject(
                new GoogleApiError(
                  "AUTH_DENIED",
                  "Googleへの接続が許可されませんでした。保存は行っていません。",
                ),
              );
              return;
            }
            const granted = new Set((response.scope ?? "").split(" "));
            const required = GOOGLE_SCOPES.filter((scope) =>
              scope.startsWith("https://"),
            );
            if (required.some((scope) => !granted.has(scope))) {
              reject(
                new GoogleApiError(
                  "AUTH_DENIED",
                  "Classroomと選択したDriveファイルへの必要な権限が揃っていません。接続し直してください。",
                ),
              );
              return;
            }
            const expires = Number(response.expires_in);
            if (!Number.isFinite(expires) || expires <= 10) {
              reject(
                new GoogleApiError(
                  "AUTH_DENIED",
                  "Google認可の有効期限を確認できませんでした。接続し直してください。",
                ),
              );
              return;
            }
            this.token = response.access_token;
            this.expiresAt = Date.now() + expires * 1_000 - 10_000;
            this.expiryTimer = setTimeout(
              () => this.clear("expired"),
              Math.min(expires * 1_000 - 10_000, 2_147_483_647),
            );
            // Node test timers must not keep a finished test process alive.
            (this.expiryTimer as unknown as { unref?: () => void }).unref?.();
            this.notify("connected");
            resolve();
          },
          error_callback: (error) =>
            reject(
              new GoogleApiError(
                "POPUP_BLOCKED",
                error.type === "popup_closed"
                  ? "認可画面が閉じられました。接続は完了していません。"
                  : "Google認可画面を開けませんでした。ポップアップを許可してもう一度押してください。",
              ),
            ),
        });
        client.requestAccessToken({ prompt: "select_account" });
      });
    })();
    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }
}

export function getGoogleClientId(): string {
  return (
    (
      import.meta as ImportMeta & { env?: Record<string, string> }
    ).env?.VITE_GOOGLE_CLIENT_ID?.trim() ?? ""
  );
}
