import { GoogleApiError } from "./errors";

/** Apps Script Picker requires the editor's host origin, not the nested app origin. */
export function pickerOrigin(): string {
  if (window.parent === window) return window.location.origin;
  const params = new URLSearchParams(window.location.hash.slice(1));
  const parent = params.get("paperflowParentOrigin");
  const host = params.get("paperflowHostOrigin");
  const nonce = params.get("paperflowBridge");
  if (
    host === "https://docs.google.com" &&
    parent &&
    nonce &&
    /^[a-f0-9-]{32,64}$/i.test(nonce)
  ) {
    try {
      const origin = new URL(parent);
      if (
        origin.origin === parent &&
        origin.protocol === "https:" &&
        origin.hostname.endsWith(".googleusercontent.com")
      )
        return host;
    } catch {
      /* Use this app's origin outside its Docs bridge. */
    }
  }
  return window.location.origin;
}

export interface PickerConfiguration {
  apiKey: string;
  appId: string;
}
export interface PickerOptions {
  kind: "pdf" | "spreadsheet" | "folder";
  multiple?: boolean;
  title?: string;
}
export interface PickedFile {
  id: string;
  name: string;
  mimeType: string;
}

interface PickerView {
  setMimeTypes(value: string): PickerView;
  setIncludeFolders(value: boolean): PickerView;
  setSelectFolderEnabled(value: boolean): PickerView;
  setMode(value: string): PickerView;
}
interface PickerInstance {
  setVisible(value: boolean): void;
  dispose(): void;
}
interface PickerBuilder {
  addView(view: PickerView): PickerBuilder;
  setOAuthToken(value: string): PickerBuilder;
  setDeveloperKey(value: string): PickerBuilder;
  setAppId(value: string): PickerBuilder;
  setOrigin(value: string): PickerBuilder;
  setTitle(value: string): PickerBuilder;
  setLocale(value: string): PickerBuilder;
  enableFeature(value: string): PickerBuilder;
  setCallback(
    value: (data: { action?: string; docs?: unknown[] }) => void,
  ): PickerBuilder;
  build(): PickerInstance;
}
interface PickerNamespace {
  DocsView: new (view?: string) => PickerView;
  PickerBuilder: new () => PickerBuilder;
  ViewId: { DOCS: string; FOLDERS: string; SPREADSHEETS: string };
  DocsViewMode: { LIST: string };
  Feature: { MULTISELECT_ENABLED: string; SUPPORT_DRIVES?: string };
  Action: { PICKED: string; CANCEL: string; ERROR?: string };
}
type PickerWindow = Window & {
  google?: { picker?: PickerNamespace };
  gapi?: {
    load(
      name: string,
      options: {
        callback: () => void;
        onerror: () => void;
        timeout: number;
        ontimeout: () => void;
      },
    ): void;
  };
};

let loading: Promise<void> | undefined;

/** SDK preparation does not start authorization or enumerate private files. */
export function prepareGooglePicker(): Promise<void> {
  if (typeof window === "undefined")
    return Promise.reject(
      new GoogleApiError(
        "CONFIG_REQUIRED",
        "Drive選択はブラウザで実行してください。",
      ),
    );
  const target = window as PickerWindow;
  if (target.google?.picker) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise<void>((resolve, reject) => {
    const failed = () =>
      reject(
        new GoogleApiError(
          "NETWORK",
          "Google Pickerを読み込めませんでした。再試行してください。",
        ),
      );
    const loadPicker = () =>
      target.gapi?.load("picker", {
        callback: resolve,
        onerror: failed,
        timeout: 20_000,
        ontimeout: failed,
      });
    if (target.gapi) {
      loadPicker();
      return;
    }
    const script = document.createElement("script");
    const timer = setTimeout(() => {
      script.remove();
      failed();
    }, 20_000);
    script.src = "https://apis.google.com/js/api.js";
    script.async = true;
    script.onload = () => {
      clearTimeout(timer);
      target.gapi ? loadPicker() : failed();
    };
    script.onerror = () => {
      clearTimeout(timer);
      script.remove();
      failed();
    };
    document.head.appendChild(script);
  }).catch((error) => {
    loading = undefined;
    throw error;
  });
  return loading;
}

export function getPickerConfiguration(): PickerConfiguration {
  return {
    apiKey: import.meta.env.VITE_GOOGLE_API_KEY?.trim() ?? "",
    appId: import.meta.env.VITE_GOOGLE_PROJECT_NUMBER?.trim() ?? "",
  };
}

/** Only the selected IDs are returned. Selecting a folder grants no recursive access. */
export async function openGooglePicker(
  configuration: PickerConfiguration,
  accessToken: () => string,
  options: PickerOptions,
): Promise<PickedFile[]> {
  if (!configuration.apiKey || !/^\d+$/.test(configuration.appId))
    throw new GoogleApiError(
      "CONFIG_REQUIRED",
      "Drive選択にはVITE_GOOGLE_API_KEYとVITE_GOOGLE_PROJECT_NUMBERの設定が必要です。",
    );
  await prepareGooglePicker();
  const picker = (window as PickerWindow).google!.picker!;
  const mimeType =
    options.kind === "pdf"
      ? "application/pdf"
      : options.kind === "folder"
        ? "application/vnd.google-apps.folder"
        : "application/vnd.google-apps.spreadsheet";
  const view = new picker.DocsView(
    options.kind === "folder"
      ? picker.ViewId.FOLDERS
      : options.kind === "spreadsheet"
        ? picker.ViewId.SPREADSHEETS
        : picker.ViewId.DOCS,
  )
    .setMimeTypes(mimeType)
    .setIncludeFolders(true)
    .setSelectFolderEnabled(options.kind === "folder")
    .setMode(picker.DocsViewMode.LIST);
  return new Promise((resolve, reject) => {
    let instance: PickerInstance | undefined;
    let settled = false;
    const finish = (files?: PickedFile[], error?: Error) => {
      if (settled) return;
      settled = true;
      instance?.dispose();
      if (error) reject(error);
      else resolve(files ?? []);
    };
    let builder = new picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(accessToken())
      .setDeveloperKey(configuration.apiKey)
      .setAppId(configuration.appId)
      .setOrigin(pickerOrigin())
      .setLocale("ja")
      .setTitle(options.title ?? "PaperFlowで使用するファイルを選択")
      .setCallback((data) => {
        if (data.action === picker.Action.CANCEL) {
          finish([]);
          return;
        }
        if (data.action === picker.Action.ERROR || data.action === "error") {
          finish(
            undefined,
            new GoogleApiError(
              "API",
              "Driveの選択に失敗しました。接続アカウントとPicker設定を確認してください。",
            ),
          );
          return;
        }
        if (data.action !== picker.Action.PICKED) return;
        const documents = data.docs ?? [];
        const files: PickedFile[] = [];
        for (const value of documents) {
          const doc = value as Partial<PickedFile>;
          if (
            typeof doc?.id !== "string" ||
            !doc.id ||
            typeof doc.name !== "string" ||
            doc.mimeType !== mimeType
          ) {
            finish(
              undefined,
              new GoogleApiError(
                "INVALID_DATA",
                "選択したファイルの種類を確認できません。指定された形式を選び直してください。",
              ),
            );
            return;
          }
          files.push({ id: doc.id, name: doc.name, mimeType });
        }
        finish(files);
      });
    if (options.multiple)
      builder = builder.enableFeature(picker.Feature.MULTISELECT_ENABLED);
    if (picker.Feature.SUPPORT_DRIVES)
      builder = builder.enableFeature(picker.Feature.SUPPORT_DRIVES);
    instance = builder.build();
    instance.setVisible(true);
  });
}
