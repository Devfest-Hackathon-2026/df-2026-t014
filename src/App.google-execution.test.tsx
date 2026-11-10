// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { PDFDocument } from "pdf-lib";
import App from "./App";
import { testDom } from "./testDom";
import { createInitialState } from "./domain/seed";
import { createCollection } from "./domain/logic";
import type { AppState, ScanPage } from "./domain/types";
import type { GoogleAuthState } from "./google/client";
import { LEDGER_TABS } from "./google/client";
import { GoogleApiError } from "./google/errors";
import { GoogleTokenSession, GOOGLE_SCOPES } from "./google/auth";
import type { PdfPreviewProps } from "./PdfPreview";
import { inspectSourcePdf } from "./pdf/documents";
const mock = vi.hoisted(() => ({
  client: {} as Record<string, unknown>,
  scan: vi.fn(),
  docs: undefined as undefined | ((source: unknown) => void),
}));
vi.mock("./google", async (importOriginal) => {
  const original = await importOriginal<typeof import("./google")>();
  return {
    ...original,
    getGoogleClientId: () => "test.apps.googleusercontent.com",
    GoogleWorkspaceClient: class {
      constructor() {
        Object.assign(this, mock.client);
      }
    },
  };
});
vi.mock("./pdfClient", () => ({
  scanPdf: mock.scan,
  extractStudentPdf: vi.fn(async (bytes: Uint8Array) => bytes),
  generatePrintPdf: vi.fn(),
  generateSourcePdf: vi.fn(),
  createDemoScan: vi.fn(),
  inspectSourcePdf: vi.fn(),
  generatePrintPreview: vi.fn(),
}));
vi.mock("./PdfPreview", async () => {
  const { useEffect } = await import("react");
  const Preview = ({ bytes, onPageViewed }: PdfPreviewProps) => {
    useEffect(() => {
      onPageViewed?.(1, 2);
      onPageViewed?.(2, 2);
    }, [bytes, onPageViewed]);
    return <div>PDF preview stub</div>;
  };
  return { default: Preview, PdfPreview: Preview };
});
vi.mock("./google/docsBridge", async (importOriginal) => {
  const original = await importOriginal<typeof import("./google/docsBridge")>();
  return {
    ...original,
    listenForDocsSource: (receive: (source: unknown) => void) => {
      mock.docs = receive;
      return () => {
        mock.docs = undefined;
      };
    },
  };
});
let h: ReturnType<typeof testDom> | undefined;
let bytes: Uint8Array;
let state: AppState;
let account = "teacher-A",
  connected = false;
let listener: ((state: GoogleAuthState) => void) | undefined;
let saved: AppState[] = [];
const client = {
  connect: vi.fn(),
  disconnect: vi.fn(),
  onAuthStateChange: vi.fn(),
  isConnected: vi.fn(),
  getIdentity: vi.fn(),
  listCourses: vi.fn(),
  listStudents: vi.fn(),
  pickFiles: vi.fn(),
  readLedger: vi.fn(),
  writeLedger: vi.fn(),
  createLedger: vi.fn(),
  generateFileId: vi.fn(),
  createFolder: vi.fn(),
  uploadPdf: vi.fn(),
  downloadPdf: vi.fn(),
};
const identity = () => ({
  id: account,
  email: account + "@example.test",
  name: "架空先生",
});
const handle = () => ({
  spreadsheetId: "ledger",
  spreadsheetUrl: "https://docs.google.com/spreadsheets/d/ledger/edit",
  schemaVersion: 1 as const,
  accountId: "teacher-A",
  revisionHash: "initial",
  sheets: Object.fromEntries(LEDGER_TABS.map((x, i) => [x, i])),
});
beforeEach(async () => {
  h = testDom();
  const { extractStudentPdf } = await import("./pdfClient");
  vi.mocked(extractStudentPdf).mockImplementation(async (bytes) => bytes);
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: () => "blob:test",
      revokeObjectURL: () => {},
    }),
  );
  state = createInitialState();
  state.classId = "test-class";
  state.className = "架空試験40人";
  state.settings = {
    googleAccountId: "teacher-A",
    folderId: "root-folder",
    ledgerId: "ledger",
    ledgerRevision: "initial",
  };
  const c = createCollection(
    {
      title: "架空回収票",
      className: state.className,
      pageCount: 2,
      requiredPages: [2],
      qrCorner: "top-right",
      duplex: false,
      order: "number",
      reverse: false,
    },
    state.students,
  );
  c.status = "collecting";
  c.folderId = "collection-folder";
  state.collections = [c];
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 38; i++) pdf.addPage([595, 842]);
  bytes = await pdf.save();
  const pages: ScanPage[] = state.students.slice(0, 36).map((s, i) => {
    const token = c.tokens.find(
      (t) => t.studentId === s.id && t.pageNumber === 2,
    )!;
    return {
      ...token,
      id: "p" + i,
      sourcePage: i + 1,
      status: "matched",
      resolution: "accepted",
    };
  });
  pages.push(
    { id: "p36", sourcePage: 37, status: "unreadable", resolution: "pending" },
    {
      id: "p37",
      sourcePage: 38,
      status: "duplicate",
      resolution: "ignored",
      reviewReason: "重複を確認",
      reviewedBy: "teacher-A",
      exclusionScope: "source",
    },
  );
  mock.scan.mockReset().mockResolvedValue(pages);
  account = "teacher-A";
  connected = false;
  saved = [];
  listener = undefined;
  for (const f of Object.values(client)) f.mockReset();
  client.connect.mockImplementation(async () => {
    connected = true;
    return identity();
  });
  client.disconnect.mockImplementation(() => {
    connected = false;
    listener?.({ status: "disconnected" });
  });
  client.onAuthStateChange.mockImplementation((fn) => {
    listener = fn;
    return () => {};
  });
  client.isConnected.mockImplementation(() => connected);
  client.getIdentity.mockImplementation(() =>
    connected ? identity() : undefined,
  );
  client.listCourses.mockResolvedValue([
    { id: "a", name: "同名クラス" },
    { id: "b", name: "同名クラス" },
    { id: "c", name: "別クラス" },
  ]);
  client.listStudents.mockImplementation(async () =>
    structuredClone(state.students),
  );
  client.pickFiles.mockResolvedValue([
    {
      id: "ledger",
      name: "台帳",
      mimeType: "application/vnd.google-apps.spreadsheet",
    },
  ]);
  client.readLedger.mockImplementation(async () => ({
    state: structuredClone(state),
    ledger: handle(),
    revisionHash: "initial",
    operationId: "initial",
  }));
  client.writeLedger.mockImplementation(async (_l, next) => {
    saved.push(structuredClone(next));
    return {
      revisionHash: "r" + saved.length,
      operationId: "write-" + saved.length,
      recovered: false,
    };
  });
  client.generateFileId.mockImplementation(async () => crypto.randomUUID());
  client.createFolder.mockImplementation(async (name) => ({
    id: "folder-" + name,
    name,
  }));
  client.uploadPdf.mockImplementation(async (o) => ({
    id: o.fileId,
    name: o.name,
  }));
  client.downloadPdf.mockResolvedValue(bytes);
  Object.assign(mock.client, client);
  await h.render(<App />);
});
afterEach(async () => {
  if (h) await finishAsyncApp();
  await h?.close();
  h = undefined;
  vi.restoreAllMocks();
});
async function settings() {
  await h!.click(h!.button("接続・設定"));
}
async function connect() {
  await settings();
  await h!.click(h!.button("Googleに接続"));
}
async function restore() {
  await connect();
  await h!.click(h!.button("既存のSheets台帳を開く"));
  await settings();
}
async function openDocsFixture(email: string, title: string) {
  const api = await import("./pdfClient");
  const doc = await PDFDocument.create();
  doc.addPage([595.28, 841.89]);
  doc.addPage([595.28, 841.89]).drawText(title);
  const source = await doc.save();
  vi.mocked(api.inspectSourcePdf).mockResolvedValue(
    await inspectSourcePdf(source),
  );
  vi.mocked(api.generatePrintPreview).mockImplementation(
    async ({ collection }) => ({
      bytes: source,
      collection,
    }),
  );
  await act(async () =>
    mock.docs!({
      documentId: "fixture-docs-A",
      accountEmail: email,
      name: `${title}.pdf`,
      bytes: source,
    }),
  );
  const consent = h!.input("右上の幅90mm");
  await vi.waitFor(() => expect(consent.disabled).toBe(false));
  await h!.click(consent);
  return source;
}

it("PF-G012 a different Docs account cannot issue into B's workspace or the sample", async () => {
  const { generatePrintPdf } = await import("./pdfClient");
  vi.mocked(generatePrintPdf).mockClear();
  account = "teacher-B";
  state.settings!.googleAccountId = account;
  client.readLedger.mockImplementation(async () => ({
    state: structuredClone(state),
    ledger: { ...handle(), accountId: account },
    revisionHash: "initial",
  }));
  await restore();
  expect(h!.container.textContent).toContain("teacher-B@example.test");
  await openDocsFixture("teacher-A@example.test", "Account A only");
  expect(h!.button("確認してQR付きPDFを作成").disabled).toBe(false);
  await h!.click(h!.button("確認してQR付きPDFを作成"));
  expect(h!.container.textContent).toContain(
    "DocsとWebでGoogleアカウントが異なります",
  );
  await h!.click(h!.button("キャンセル"));
  await h!.click(h!.button("新しいサンプルではじめる"));
  await h!.click(h!.button("サンプルを作り直す"));
  await openDocsFixture("teacher-A@example.test", "Account A only");
  expect(h!.button("確認してQR付きPDFを作成").disabled).toBe(true);
  await h!.click(h!.button("確認してQR付きPDFを作成"));
  expect(h!.container.textContent).toContain(
    "Docsの原稿はサンプル名簿では発行できません",
  );
  expect(generatePrintPdf).not.toHaveBeenCalled();
  expect(client.writeLedger).not.toHaveBeenCalled();
  expect(client.uploadPdf).not.toHaveBeenCalled();
});
async function scan() {
  await h!.click(h!.button("回収・照合"));
  const input = h!.container.querySelector(
    'input[type=file][accept="application/pdf,.pdf"]',
  )!;
  expect(input).not.toBeNull();
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [
      {
        name: "架空38ページ.pdf",
        size: bytes.length,
        arrayBuffer: async () => new Uint8Array(bytes).buffer,
      },
    ],
  });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await finishAsyncApp();
  expect(h!.container.textContent).toContain("38ページ");
}
function saveButton() {
  return [...h!.container.querySelectorAll("button")].find(
    (b) =>
      b.textContent?.trim() === "回収状況を記録" ||
      b.textContent?.trim() === "記録して書類を保管",
  )!;
}
describe("PF Google App integration with in-memory API and decoder stubs", () => {
  it("PF-G002 cancelled connect can be retried without success display", async () => {
    client.connect.mockRejectedValueOnce(
      new GoogleApiError("AUTH_DENIED", "接続を取り消しました"),
    );
    await connect();
    expect(h!.container.textContent).toContain("接続を取り消しました");
    expect(h!.button("Googleに接続").disabled).toBe(false);
    expect(client.listCourses).not.toHaveBeenCalled();
    await h!.click(h!.button("Googleに接続"));
    expect(h!.container.textContent).toContain("teacher-A@example.test");
    expect(client.listCourses).toHaveBeenCalledOnce();
  });
  it("PF-G004 expired auth clears UI and allows same-account reconnect and ledger reload", async () => {
    await restore();
    client.readLedger.mockImplementationOnce(async () => {
      connected = false;
      listener?.({ status: "expired" });
      throw new GoogleApiError("AUTH_EXPIRED", "認可失効");
    });
    await h!.click(h!.button("既存のSheets台帳を開く"));
    expect(h!.container.textContent).toContain("認可失効");
    expect(h!.button("Googleに接続")).toBeDefined();
    expect(client.writeLedger).not.toHaveBeenCalled();
    await h!.click(h!.button("Googleに接続"));
    await h!.click(h!.button("既存のSheets台帳を開く"));
    expect(h!.container.textContent).toContain("40人の台帳を復元しました");
  });
  it("PF-G011 other account cannot write restored A ledger or planned Drive IDs", async () => {
    await restore();
    await h!.click(h!.button("接続を解除"));
    account = "teacher-B";
    await h!.click(h!.button("Googleに接続"));
    expect(h!.container.textContent).toContain("元のGoogleアカウント");
    expect(client.writeLedger).not.toHaveBeenCalled();
    expect(client.uploadPdf).not.toHaveBeenCalled();
    expect(
      h!.container.querySelector('a[href*="spreadsheets/d/ledger"]'),
    ).toBeNull();
  });
  it("PF-G016 all four Picker cancellations preserve current workspace and release busy", async () => {
    await restore();
    client.pickFiles.mockResolvedValue([]);
    for (const label of [
      "既存のSheets台帳を開く",
      "Drive保存先フォルダを選ぶ",
      "Driveの原稿PDFから作成",
    ]) {
      await h!.click(h!.button(label));
      expect(h!.button(label).disabled).toBe(false);
      expect(h!.container.textContent).toContain("架空試験40人");
    }
    await h!.click(h!.button("回収・照合"));
    await h!.click(h!.button("DriveからPDFを選択"));
    expect(h!.button("DriveからPDFを選択").disabled).toBe(false);
    expect(client.downloadPdf).not.toHaveBeenCalled();
    expect(client.readLedger).toHaveBeenCalledTimes(1);
    expect(client.writeLedger).not.toHaveBeenCalled();
  });
  it("PF-G017 invalid Picker MIME error preserves workspace and never reads target file", async () => {
    await restore();
    client.pickFiles.mockRejectedValue(
      new GoogleApiError(
        "INVALID_DATA",
        "選択したファイルの種類を確認できません。",
      ),
    );
    for (const label of [
      "既存のSheets台帳を開く",
      "Drive保存先フォルダを選ぶ",
      "Driveの原稿PDFから作成",
    ]) {
      await h!.click(h!.button(label));
      expect(h!.container.textContent).toContain("種類を確認できません");
      expect(h!.container.textContent).toContain("架空試験40人");
    }
    await h!.click(h!.button("回収・照合"));
    await h!.click(h!.button("DriveからPDFを選択"));
    expect(client.readLedger).toHaveBeenCalledTimes(1);
    expect(client.downloadPdf).not.toHaveBeenCalled();
    expect(client.writeLedger).not.toHaveBeenCalled();
  });
  it("PF-G032 displays three course IDs including same names and selects a distinct course", async () => {
    await connect();
    const select = h!.input("担当クラス") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual([
      "",
      "a",
      "b",
      "c",
    ]);
    await h!.value(select, "b");
    await h!.click(h!.button("名簿を読み込む"));
    expect(client.listStudents).toHaveBeenCalledWith("b");
    expect(h!.container.textContent).toContain("名簿を読み込みました");
  });
  for (const [id, n] of [
    ["PF-G033", 0],
    ["PF-G034", 1],
    ["PF-G035", 30],
    ["PF-G036", 31],
    ["PF-G037", 40],
  ] as const)
    it(`${id} exact roster import count ${n} in App`, async () => {
      await restore();
      await settings();
      client.listStudents.mockResolvedValueOnce(state.students.slice(0, n));
      await h!.value(h!.input("担当クラス"), "c");
      await h!.click(h!.button("名簿を読み込む"));
      if (!n) {
        expect(h!.container.textContent).toContain("生徒が登録されていません");
        expect(h!.container.textContent).toContain("架空試験40人");
      } else {
        expect(h!.container.textContent).toContain(`在籍 ${n}人`);
        expect(h!.container.textContent).toContain("別クラス");
      }
    });
  it("PF-G038 failed partial fetch leaves existing forty-person workspace unchanged", async () => {
    await restore();
    client.listStudents.mockRejectedValueOnce(
      new GoogleApiError("API", "名簿2ページ目503", 503),
    );
    await h!.value(h!.input("担当クラス"), "c");
    await h!.click(h!.button("名簿を読み込む"));
    expect(h!.container.textContent).toContain("名簿2ページ目503");
    expect(h!.container.textContent).toContain("架空試験40人");
    expect(client.writeLedger).not.toHaveBeenCalled();
    await h!.click(h!.button("座席表"));
    expect(h!.container.textContent).toContain("在籍 40人");
  });
  for (const id of [
    "PF-G040",
    "PF-G041",
    "PF-G042",
    "PF-G043",
    "PF-G044",
    "PF-G045",
    "PF-G046",
  ])
    it(`${id} rejected decoder preserves old App workspace without empty overwrite`, async () => {
      await restore();
      client.readLedger.mockRejectedValueOnce(
        new GoogleApiError(
          "INVALID_DATA",
          "台帳の復元データが欠けています。上書きを停止しました。",
        ),
      );
      await h!.click(h!.button("既存のSheets台帳を開く"));
      expect(h!.container.textContent).toContain("上書きを停止");
      expect(h!.container.textContent).toContain("架空試験40人");
      expect(client.writeLedger).not.toHaveBeenCalled();
      expect(client.createLedger).not.toHaveBeenCalled();
    });
  it("PF-G057 failed precommit shows unsaved then retry records exactly 36 once", async () => {
    await restore();
    await scan();
    client.writeLedger.mockRejectedValueOnce(
      new GoogleApiError("NETWORK", "Sheets offline"),
    );
    await h!.click(saveButton());
    expect(h!.container.textContent).toContain("Sheets offline");
    expect(h!.container.textContent).not.toContain("回収状況を記録しました");
    expect(saved).toHaveLength(0);
    await h!.click(saveButton());
    expect(saved.at(-1)!.receipts).toHaveLength(36);
    expect(new Set(saved.at(-1)!.receipts.map((r) => r.token)).size).toBe(36);
    const first = client.writeLedger.mock.calls[0][1] as AppState;
    const retried = client.writeLedger.mock.calls[1][1] as AppState;
    expect(retried.operations![0].id).toBe(first.operations![0].id);
    expect(retried.receipts.map((r) => r.id)).toEqual(
      first.receipts.map((r) => r.id),
    );
    expect(h!.container.textContent).toContain("回収状況を記録しました");
  });
  it("PF-G062 busy disables double save and does not duplicate receipts or operations", async () => {
    await restore();
    await scan();
    let resolve!: (v: unknown) => void;
    client.writeLedger.mockImplementationOnce((_l, next) => {
      saved.push(structuredClone(next));
      return new Promise((r) => {
        resolve = r;
      });
    });
    const button = saveButton();
    await h!.click(button);
    expect(button.disabled).toBe(true);
    await h!.click(button);
    expect(client.writeLedger).toHaveBeenCalledOnce();
    await act(async () => {
      resolve({ revisionHash: "new", operationId: "one", recovered: false });
    });
    expect(saved[0].receipts).toHaveLength(36);
    expect(saved[0].operations).toHaveLength(1);
    expect(h!.container.textContent).toContain("回収状況を記録しました");
  });
  it("PF-G091 record-only App sends metadata and zero PDF uploads", async () => {
    await restore();
    await scan();
    await h!.click(saveButton());
    expect(saved.at(-1)!.receipts).toHaveLength(36);
    expect(saved.at(-1)!.operations!.at(-1)!.storageMode).toBe("record-only");
    expect(client.uploadPdf).not.toHaveBeenCalled();
    expect(client.generateFileId).not.toHaveBeenCalled();
    expect(JSON.stringify(saved)).not.toContain("data:image");
    expect(h!.container.textContent).toContain("回収状況を記録しました");
  });
});

describe("PF App save interruption and privacy paths", () => {
  for (const [id, status] of [
    ["PF-G069", 403],
    ["PF-G070", 404],
    ["PF-G071", 429],
    ["PF-G072", 500],
    ["PF-G073 PF-G060", 503],
  ] as const)
    it(`${id} archive HTTP ${status} retains 36 committed receipts and resumes same IDs`, async () => {
      await restore();
      await scan();
      await h!.click(h!.input("書類もDriveに保管"));
      client.uploadPdf.mockRejectedValueOnce(
        new GoogleApiError("API", `Drive ${status}`, status),
      );
      await h!.click(saveButton());
      await finishAsyncApp();
      expect(h!.container.textContent).toContain(`Drive ${status}`);
      expect(saved[0].receipts).toHaveLength(36);
      expect(saved.at(-1)!.operations!.at(-1)!.archiveStatus).toBe("failed");
      const planned = { ...saved[0].operations![0].plannedFileIds };
      const ids = client.generateFileId.mock.calls.length;
      await settings();
      await h!.click(h!.button("保管を再試行"));
      await finishAsyncApp();
      expect(saved.at(-1)!.operations!.at(-1)!.archiveStatus).toBe("saved");
      expect(saved.at(-1)!.operations!.at(-1)!.plannedFileIds).toEqual(planned);
      expect(client.generateFileId).toHaveBeenCalledTimes(ids);
      expect(saved.at(-1)!.receipts).toHaveLength(36);
    });
  it("PF-G055 stale revision failure does not replace current UI state or claim sync", async () => {
    await restore();
    await scan();
    client.writeLedger.mockRejectedValueOnce(
      new GoogleApiError(
        "CONFLICT",
        "台帳に別の更新があります。再読込してください。",
      ),
    );
    await h!.click(saveButton());
    expect(h!.container.textContent).toContain("別の更新");
    expect(h!.container.textContent).not.toContain("回収状況を記録しました");
    expect(saved).toHaveLength(0);
    expect(client.uploadPdf).not.toHaveBeenCalled();
  });
  it("PF-G091 record-only uploads no images, explicit later archive sends PDFs", async () => {
    await restore();
    await scan();
    await h!.click(saveButton());
    expect(client.uploadPdf).not.toHaveBeenCalled();
    await h!.click(h!.button("現在の回収内容をDriveに保管"));
    await finishAsyncApp();
    expect(client.uploadPdf).toHaveBeenCalled();
    expect(
      client.uploadPdf.mock.calls.every(([o]) => o.bytes instanceof Uint8Array),
    ).toBe(true);
    expect(saved.at(-1)!.operations!.at(-1)!.archiveStatus).toBe("saved");
  });
  it("PF-G092 keeps the issued roster, PDF, receipt and OAuth token in the session until explicit Google save", async () => {
    const marker = "TEST_PRIVATE_01";
    state.students[0].name = marker;
    const initialStorage = JSON.stringify({ ...window.localStorage });
    const indexed = { open: vi.fn(), deleteDatabase: vi.fn() };
    vi.stubGlobal("indexedDB", indexed);
    Object.defineProperty(window, "indexedDB", {
      value: indexed,
      configurable: true,
    });
    const logs = ["log", "info", "warn", "error", "debug"].map((level) =>
      vi.spyOn(console, level as "log"),
    );
    const oauth = new GoogleTokenSession("test.apps.googleusercontent.com");
    const token = "fixture-oauth-secret-092";
    Object.defineProperty(window, "google", {
      value: {
        accounts: {
          oauth2: {
            initTokenClient: ({
              callback,
            }: {
              callback: (value: unknown) => void;
            }) => ({
              requestAccessToken: () =>
                callback({
                  access_token: token,
                  scope: GOOGLE_SCOPES.join(" "),
                  expires_in: 3600,
                }),
            }),
          },
        },
      },
    });
    client.connect.mockImplementation(async () => {
      await oauth.connect();
      connected = true;
      return identity();
    });
    try {
      await restore();
      expect(oauth.getAccessToken()).toBe(token);
      const source = await openDocsFixture(identity().email, marker);
      const { generatePrintPdf } = await import("./pdfClient");
      vi.mocked(generatePrintPdf).mockImplementationOnce(
        async ({ collection }) => ({ bytes: source, collection }),
      );
      await h!.click(h!.button("確認してQR付きPDFを作成"));
      await finishAsyncApp();
      expect(h!.container.textContent).toContain(
        "台帳と印刷用PDFを保存しました",
      );
      const issued = saved.at(-1)!.collections.find((c) => c.title === marker)!;
      expect(issued.recipients[0].name).toBe(marker);
      expect(issued.status).toBe("ready");
      expect(client.uploadPdf).toHaveBeenCalledTimes(2);
      await h!.click(
        h!.container.querySelector('button[aria-label="閉じる"]')!,
      );
      const t = issued.tokens.find((item) => item.required)!;
      mock.scan.mockResolvedValueOnce([
        {
          ...t,
          id: "p1",
          sourcePage: 1,
          status: "matched",
          resolution: "accepted",
        },
      ]);
      await uploadRecovered(source, `${marker}-scan.pdf`);
      await h!.click(saveButton());
      await finishAsyncApp();
      expect(
        saved
          .at(-1)!
          .receipts.some((receipt) => receipt.collectionId === issued.id),
      ).toBe(true);
      expect(client.uploadPdf).toHaveBeenCalledTimes(2);
      expect(JSON.stringify({ ...window.localStorage })).toBe(initialStorage);
      expect(window.sessionStorage.length).toBe(0);
      expect(indexed.open).not.toHaveBeenCalled();
      expect(indexed.deleteDatabase).not.toHaveBeenCalled();
      const exposed = JSON.stringify([
        window.location.href,
        initialStorage,
        ...logs.flatMap((spy) =>
          spy.mock.calls.map((call) => call.map(String)),
        ),
      ]);
      for (const privateValue of [
        marker,
        token,
        t.token,
        issued.id,
        Buffer.from(source).toString("base64"),
      ]) {
        expect(exposed).not.toContain(privateValue);
      }
      const reads = client.readLedger.mock.calls.length;
      const connections = client.connect.mock.calls.length;
      await h!.render(null);
      connected = false;
      await h!.render(<App />);
      await settings();
      expect(h!.container.textContent).toContain("Googleに接続");
      expect(h!.container.textContent).not.toContain(marker);
      expect(h!.container.textContent).not.toContain("既存のSheets台帳を開く");
      expect(client.readLedger).toHaveBeenCalledTimes(reads);
      expect(client.connect).toHaveBeenCalledTimes(connections);
    } finally {
      oauth.clear();
    }
  });
  it("PF-G093 App sample mode prevents outside roster input and navigation remains available", async () => {
    await h!.click(h!.button("座席表"));
    const input = h!.container.querySelector(
      'input[type=file][accept=".csv,text/csv"]',
    ) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(h!.button("名簿のSheetsを選ぶ").disabled).toBe(true);
    await h!.click(h!.button("接続・設定を開く"));
    expect(h!.container.textContent).toContain("Googleに接続");
    expect(client.readLedger).not.toHaveBeenCalled();
    expect(client.listStudents).not.toHaveBeenCalled();
  });
});

describe("PF ambiguous save and cross-collection boundaries", () => {
  it("PF-G058 lost commit confirmation reuses identical commit ID and 36 receipts on retry", async () => {
    await restore();
    await scan();
    let firstId: string | undefined, firstState: AppState | undefined;
    client.writeLedger
      .mockImplementationOnce(async (_l, next, options) => {
        firstId = options.operationId;
        firstState = structuredClone(next);
        throw new GoogleApiError(
          "AMBIGUOUS_WRITE",
          "確定応答が不明です。同じ保存操作で確認してください。",
        );
      })
      .mockImplementationOnce(async (_l, next, options) => {
        expect(options.operationId).toBe(firstId);
        expect(next).toEqual(firstState);
        saved.push(structuredClone(next));
        return {
          revisionHash: "recovered",
          operationId: options.operationId,
          recovered: true,
        };
      });
    await h!.click(saveButton());
    expect(h!.container.textContent).not.toContain("回収状況を記録しました");
    await h!.click(saveButton());
    expect(saved).toHaveLength(1);
    expect(saved[0].receipts).toHaveLength(36);
    expect(saved[0].operations).toHaveLength(1);
    expect(h!.container.textContent).toContain("回収状況を記録しました");
  });
  it("PF-F178 failed Google commit prevents mixed-PDF handoff and retains current review", async () => {
    const second = createCollection(
      {
        title: "次の配布物B",
        className: state.className,
        pageCount: 2,
        requiredPages: [2],
        qrCorner: "top-right",
        duplex: false,
        order: "number",
        reverse: false,
      },
      state.students,
    );
    second.status = "collecting";
    state.collections.push(second);
    const pages = await mock.scan();
    const b = second.tokens.find((t) => t.pageNumber === 2)!;
    pages[36] = {
      ...b,
      id: "p36",
      sourcePage: 37,
      status: "foreign",
      resolution: "pending",
    };
    mock.scan.mockResolvedValue(pages);
    await restore();
    await scan();
    client.writeLedger.mockRejectedValueOnce(
      new GoogleApiError("NETWORK", "引継ぎ前Sheets保存失敗"),
    );
    const target = h!.container.querySelector(
      '[aria-label="回収する配布物"]',
    ) as HTMLSelectElement;
    const before = target.value;
    await h!.click(h!.button("次の配布物B"));
    expect(h!.container.textContent).toContain("引継ぎ前Sheets保存失敗");
    expect(target.value).toBe(before);
    expect(saved).toHaveLength(0);
    expect(h!.container.textContent).not.toContain("回収状況を記録しました");
    expect(mock.scan).toHaveBeenCalledTimes(2);
    expect(h!.button("次の配布物B").disabled).toBe(false);
  });
  it("PF-G061 reload after Drive success but link commit failure reuses durable source and output IDs", async () => {
    await restore();
    await scan();
    await h!.click(h!.input("書類もDriveに保管"));
    let commits = 0;
    client.writeLedger.mockImplementation(async (_l, next) => {
      commits++;
      if (commits > 1) throw new GoogleApiError("API", "link commit 503", 503);
      saved.push(structuredClone(next));
      return { revisionHash: "plan", operationId: "plan", recovered: false };
    });
    await h!.click(saveButton());
    expect(saved).toHaveLength(1);
    expect(saved[0].receipts).toHaveLength(36);
    const remote = structuredClone(saved[0]);
    const firstUploaded = client.uploadPdf.mock.calls[0][0].fileId;
    const planned = remote.operations![0].plannedFileIds;
    const generated = client.generateFileId.mock.calls.length;
    expect(Object.values(planned!)).toContain(firstUploaded);
    state = remote;
    client.writeLedger.mockImplementation(async (_l, next) => {
      saved.push(structuredClone(next));
      return {
        revisionHash: "retry-" + saved.length,
        operationId: "retry",
        recovered: false,
      };
    });
    await h!.close();
    h = testDom();
    vi.stubGlobal("BroadcastChannel", undefined);
    await h.render(<App />);
    await restore();
    await scan();
    await settings();
    await h!.click(h!.button("保管を再試行"));
    await finishAsyncApp();
    expect(saved.at(-1)!.operations![0].archiveStatus).toBe("saved");
    expect(saved.at(-1)!.operations![0].plannedFileIds).toEqual(planned);
    expect(client.generateFileId).toHaveBeenCalledTimes(generated);
    expect(client.uploadPdf.mock.calls[1][0].fileId).toBe(firstUploaded);
    expect(saved.at(-1)!.receipts).toHaveLength(36);
  });
  it("PF-G064 switching next batch to record-only preserves old Drive artifacts", async () => {
    await restore();
    await scan();
    await h!.click(h!.input("書類もDriveに保管"));
    await h!.click(saveButton());
    await finishAsyncApp();
    const artifacts = structuredClone(saved.at(-1)!.artifacts);
    const uploads = client.uploadPdf.mock.calls.length;
    await h!.click(h!.input("書類もDriveに保管"));
    const pdf = await PDFDocument.create();
    pdf.addPage([595, 842]);
    bytes = await pdf.save();
    const c = state.collections[0];
    const token = c.tokens.find(
      (t) => t.studentId === state.students[36].id && t.pageNumber === 2,
    )!;
    mock.scan.mockResolvedValue([
      {
        ...token,
        id: "next",
        sourcePage: 1,
        status: "matched",
        resolution: "accepted",
      },
    ]);
    const input = h!.container.querySelector(
      'input[type=file][accept="application/pdf,.pdf"]',
    )!;
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [
        {
          name: "翌日.pdf",
          size: bytes.length,
          arrayBuffer: async () => new Uint8Array(bytes).buffer,
        },
      ],
    });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await finishAsyncApp();
    await h!.click(saveButton());
    await finishAsyncApp();
    expect(saved.at(-1)!.receipts).toHaveLength(37);
    expect(saved.at(-1)!.artifacts).toEqual(artifacts);
    expect(saved.at(-1)!.operations!.at(-1)!.storageMode).toBe("record-only");
    expect(client.uploadPdf).toHaveBeenCalledTimes(uploads);
  });
});

describe("PF current receipt vs saved document display", () => {
  it("PF-G065 completed 2/2 receipts keep prior 1/2 PDF visibly stale", async () => {
    const c = state.collections[0],
      student = state.students[0];
    c.requiredPages = [1, 2];
    c.tokens = c.tokens.map((t) => ({ ...t, required: true }));
    const token = c.tokens.find(
      (t) => t.studentId === student.id && t.pageNumber === 1,
    )!;
    state.batches = [
      {
        id: "previous-day",
        hash: "oldhash",
        fileName: "前日.pdf",
        recordedAt: c.createdAt,
        pageCount: 1,
        createdAt: c.createdAt,
        collectionId: c.id,
        sourceDriveFileId: "old-source",
        pages: [
          {
            ...token,
            id: "old-page",
            sourcePage: 1,
            status: "matched",
            resolution: "accepted",
          },
        ],
      },
    ];
    state.receipts = [
      {
        id: "old-receipt",
        collectionId: c.id,
        versionId: c.versionId,
        studentId: student.id,
        pageNumber: 1,
        batchId: "previous-day",
        sourcePage: 1,
        token: token.token,
        recordedAt: c.createdAt,
        method: "qr",
      },
    ];
    state.artifacts = [
      {
        id: "old-pdf",
        kind: "student",
        collectionId: c.id,
        versionId: c.versionId,
        studentId: student.id,
        driveFileId: "old-pdf",
        name: "前回1頁.pdf",
        receiptIds: ["old-receipt"],
        createdAt: c.createdAt,
      },
    ];
    await restore();
    await scan();
    await h!.click(saveButton());
    await h!.click(h!.button("配布物・回収状況"));
    const row = [...h!.container.querySelectorAll("tbody tr")].find((r) =>
      r.textContent?.includes(student.name),
    );
    expect(row?.textContent).toContain("回収済み");
    expect(row?.textContent).toContain("2 / 2");
    expect(row?.textContent).toContain("前回保存分");
    expect(row?.textContent).not.toContain("最新のPDF");
    expect(row?.querySelector("a")?.href).toContain("old-pdf");
    expect(client.uploadPdf).not.toHaveBeenCalled();
  });
});

async function finishAsyncApp(timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    if (!h?.container.querySelector(".working-pill")) return;
  }
  throw Error(
    "App did not finish within " +
      timeoutMs +
      "ms: " +
      h?.container.textContent?.slice(-1500),
  );
}

async function uploadRecovered(
  bytesToRead: Uint8Array,
  name = "reselected.pdf",
) {
  await h!.click(h!.button("回収・照合"));
  const input = h!.container.querySelector(".upload-zone input[type=file]")!;
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [
      {
        name,
        size: bytesToRead.length,
        arrayBuffer: async () => bytesToRead.slice().buffer,
      },
    ],
  });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function recoveryFixture() {
  const { hashPdf } = await import("./cloudWorkflow");
  const c = state.collections[0],
    student = state.students[0],
    token = c.tokens.find(
      (t) => t.studentId === student.id && t.pageNumber === 2,
    )!;
  state.batches = [
    {
      id: "restored-batch",
      hash: await hashPdf(bytes),
      fileName: "required-original.pdf",
      recordedAt: c.createdAt,
      pageCount: 38,
      createdAt: c.createdAt,
      collectionId: c.id,
      pages: [
        {
          ...token,
          id: "saved-p1",
          sourcePage: 1,
          status: "matched",
          resolution: "accepted",
        },
      ],
      storageMode: "record-only",
    },
  ];
  state.receipts = [
    {
      id: "current-R2",
      collectionId: c.id,
      versionId: c.versionId,
      studentId: student.id,
      pageNumber: 2,
      batchId: "restored-batch",
      sourcePage: 1,
      token: token.token,
      recordedAt: c.createdAt,
      method: "qr",
    },
  ];
  state.operations = [
    {
      id: "resume-op",
      collectionId: c.id,
      batchId: "restored-batch",
      kind: "archive",
      storageMode: "drive",
      recordStatus: "recorded",
      archiveStatus: "failed",
      receiptIds: ["current-R2"],
      createdAt: c.createdAt,
      updatedAt: c.createdAt,
      plannedFileIds: {
        "source:restored-batch": "original-reserved",
        [`student:${student.id}`]: "student-reserved",
      },
    },
  ];
  return { c, student };
}
describe("Remaining recoverable Google App scenarios, no real Google service", () => {
  it("PF-G066 obsolete archive retry preserves corrected R2 current PDF and historic R1 artifact", async () => {
    const { c, student } = await recoveryFixture();
    state.operations![0].receiptIds = ["removed-R1"];
    state.artifacts = [
      {
        id: "old",
        kind: "student",
        collectionId: c.id,
        versionId: c.versionId,
        studentId: student.id,
        driveFileId: "old-R1",
        name: "R1.pdf",
        createdAt: "2026-01-01T00:00:00Z",
        receiptIds: ["removed-R1"],
      },
      {
        id: "current",
        kind: "student",
        collectionId: c.id,
        versionId: c.versionId,
        studentId: student.id,
        driveFileId: "current-R2",
        name: "R2.pdf",
        createdAt: "2026-02-01T00:00:00Z",
        receiptIds: ["current-R2"],
      },
    ];
    const before = structuredClone(state);
    await restore();
    await h!.click(h!.button("保管を再試行"));
    await finishAsyncApp();
    expect(h!.container.textContent).toContain("採用ページが変更されています");
    expect(client.uploadPdf).not.toHaveBeenCalled();
    expect(saved.at(-1)!.receipts).toEqual(before.receipts);
    expect(saved.at(-1)!.artifacts).toEqual(before.artifacts);
    await h!.click(h!.button("配布物・回収状況"));
    const row = [...h!.container.querySelectorAll("tbody tr")].find((r) =>
      r.textContent?.includes(student.name),
    )!;
    expect(row.textContent).toContain("最新のPDF");
    expect(row.textContent).toContain("回収済み");
    expect(row.querySelector("a")?.href).toContain("current-R2");
  });
  it("PF-G067 two record-only days require both original hashes before ordered two-page archive", async () => {
    const { StandardFonts } = await import("pdf-lib");
    const make = async (label: string) => {
      const d = await PDFDocument.create(),
        font = await d.embedFont(StandardFonts.Helvetica);
      d.addPage([300, 300]).drawText(label, { font, x: 30, y: 150 });
      return d.save();
    };
    const a = await make("DAY-A LOGICAL-1"),
      b = await make("DAY-B LOGICAL-2");
    const { hashPdf } = await import("./cloudWorkflow");
    const { record, qrPage } = await import("./domain/functional-fixtures");
    const c = state.collections[0],
      student = state.students[0];
    c.requiredPages = [1, 2];
    c.tokens = c.tokens.map((t) => ({ ...t, required: true }));
    const pa = qrPage(c, student.id, 1, 1),
      pb = qrPage(c, student.id, 2, 1);
    state = record(state, c, [pa], "DAY-A", await hashPdf(a), 1);
    state = record(state, c, [pb], "DAY-B", await hashPdf(b), 1);
    state.batches.forEach((batch) => {
      batch.storageMode = "record-only";
    });
    const { extractStudentPdf: clientExtract } = await import("./pdfClient");
    const { extractStudentPdf: actualExtract } =
      await import("./pdf/documents");
    vi.mocked(clientExtract).mockImplementation(actualExtract);
    await restore();
    mock.scan.mockResolvedValue([pa]);
    await uploadRecovered(a, "DAY-A.pdf");
    await h!.click(saveButton());
    await h!.click(h!.button("現在の回収内容をDriveに保管"));
    await finishAsyncApp();
    expect(h!.container.textContent).toContain("原本再選択待ち: DAY-B.pdf");
    expect(
      client.uploadPdf.mock.calls.some(([arg]) =>
        arg.name?.includes(student.name),
      ),
    ).toBe(false);
    const op = saved.at(-1)!.operations!.find((op) => op.kind === "archive")!;
    const receipts = structuredClone(saved.at(-1)!.receipts);
    mock.scan.mockResolvedValue([pb]);
    await uploadRecovered(b, "DAY-B.pdf");
    await h!.click(saveButton());
    await settings();
    await h!.click(h!.button("保管を再試行"));
    await finishAsyncApp();
    expect(
      saved.at(-1)!.operations!.find((x) => x.id === op.id)!.archiveStatus,
    ).toBe("saved");
    expect(saved.at(-1)!.receipts).toEqual(receipts);
    const uploaded = client.uploadPdf.mock.calls
      .map(([arg]) => arg)
      .find(
        (arg) => arg.fileId === op.plannedFileIds![`student:${student.id}`],
      )!;
    const pdf = await PDFDocument.load(uploaded.bytes);
    expect(pdf.getPageCount()).toBe(2);
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = getDocument({
        data: uploaded.bytes.slice(),
        useSystemFonts: true,
      }),
      doc = await task.promise;
    try {
      const texts = [];
      for (let n = 1; n <= 2; n++) {
        texts.push(
          (await (await doc.getPage(n)).getTextContent()).items
            .filter((i) => "str" in i)
            .map((i) => i.str)
            .join(""),
        );
      }
      expect(texts).toEqual(["DAY-A LOGICAL-1", "DAY-B LOGICAL-2"]);
    } finally {
      await task.destroy();
    }
    vi.mocked(clientExtract).mockImplementation(async (bytes) => bytes);
  });
  it("PF-G068 missing Drive original rejects unrelated cache and resumes with matching local original only", async () => {
    const { student } = await recoveryFixture();
    state.batches[0].sourceDriveFileId = "trashed-original";
    state.operations![0].plannedFileIds = {
      [`student:${student.id}`]: "student-reserved",
    };
    client.downloadPdf.mockRejectedValue(
      new GoogleApiError("API", "削除済み", 404),
    );
    const original = structuredClone(state);
    await restore();
    await h!.click(h!.button("回収・照合"));
    await h!.click(h!.button("Driveの回収原本から再開"));
    expect(h!.container.textContent).toContain("原本再選択待ち");
    expect(client.downloadPdf).toHaveBeenCalledWith("trashed-original");
    const wrongPdf = await PDFDocument.create();
    wrongPdf.addPage([300, 300]);
    const wrong = await wrongPdf.save();
    await uploadRecovered(wrong, "required-original.pdf");
    await settings();
    await h!.click(h!.button("保管を再試行"));
    await finishAsyncApp();
    expect(h!.container.textContent).toContain("原本再選択待ち");
    expect(client.uploadPdf).not.toHaveBeenCalled();
    expect(saved.at(-1)!.operations![0].plannedFileIds).toEqual(
      original.operations![0].plannedFileIds,
    );
    expect(saved.at(-1)!.batches[0].hash).toBe(original.batches[0].hash);
    state = structuredClone(saved.at(-1)!);
    await h!.close();
    h = testDom();
    await h.render(<App />);
    await restore();
    await uploadRecovered(bytes, "required-original.pdf");
    await settings();
    await h!.click(h!.button("保管を再試行"));
    await finishAsyncApp();
    expect(saved.at(-1)!.operations![0].archiveStatus).toBe("saved");
    expect(client.uploadPdf).toHaveBeenCalledTimes(1);
    expect(client.uploadPdf.mock.calls[0][0].fileId).toBe("student-reserved");
    expect(saved.at(-1)!.receipts).toEqual(original.receipts);
  });
  it.each([
    ["prepared", "pending", "台帳の記録を再試行"],
    ["recorded", "not-requested", "記録のみ"],
    ["recorded", "pending", "保管待ち"],
    ["recorded", "saving", "保管中"],
    ["recorded", "failed", "保管を再試行"],
    ["recorded", "source-required", "原本再選択待ち"],
  ] as const)(
    "PF-G102 new session restores %s/%s stage %s then preserves receipts while missing bytes wait",
    async (recordStatus, archiveStatus, label) => {
      const { student } = await recoveryFixture();
      const op = state.operations![0];
      op.recordStatus = recordStatus;
      op.archiveStatus = archiveStatus;
      if (archiveStatus === "not-requested") {
        op.storageMode = "record-only";
        op.plannedFileIds = {};
      }
      const original = structuredClone(state);
      await restore();
      expect(h!.container.textContent).toContain(label);
      if (archiveStatus === "not-requested") {
        expect(
          [...h!.container.querySelectorAll("button")].some(
            (b) => b.textContent === "保管を再試行",
          ),
        ).toBe(false);
      } else {
        await h!.click(h!.button("保管を再試行"));
        await finishAsyncApp();
        expect(h!.container.textContent).toContain("原本再選択待ち");
        expect(saved.at(-1)!.operations![0].archiveStatus).toBe(
          "source-required",
        );
        expect(saved.at(-1)!.receipts).toEqual(original.receipts);
        expect(client.uploadPdf).not.toHaveBeenCalled();
      }
      await h!.click(h!.button("配布物・回収状況"));
      const row = [...h!.container.querySelectorAll("tbody tr")].find((r) =>
        r.textContent?.includes(student.name),
      )!;
      expect(row.textContent).toContain("回収済み");
      expect(row.textContent).toContain("未保管");
    },
  );
  it("PF-G094 hostile imported names stay literal through App search CSV Sheets boundary and failure display", async () => {
    const payload = "<img src=x onerror=alert(1)>";
    state.students[0].name = payload;
    state.collections[0].title = payload;
    state.collections[0].recipients[0].name = payload;
    const alerts = vi.fn(),
      fetches = vi.fn(async () => {
        throw Error("unexpected network");
      }),
      beacons = vi.fn();
    vi.stubGlobal("fetch", fetches);
    h!.dom.window.alert = alerts;
    Object.defineProperty(h!.dom.window.navigator, "sendBeacon", {
      configurable: true,
      value: beacons,
    });
    const errorLogs = vi.spyOn(console, "error");
    const blobs: Blob[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      blobs.push(blob as Blob);
      return "blob:test";
    });
    vi.spyOn(
      h!.dom.window.HTMLAnchorElement.prototype,
      "click",
    ).mockImplementation(() => {});
    await restore();
    await h!.click(h!.button("配布物・回収状況"));
    expect(h!.container.textContent).toContain(payload);
    expect(h!.container.querySelector('img[src="x"]')).toBeNull();
    expect(h!.container.querySelector("script")).toBeNull();
    await h!.value(
      h!.container.querySelector(
        '[aria-label="生徒を検索"]',
      ) as HTMLInputElement,
      payload,
    );
    expect(h!.container.querySelectorAll("tbody tr")).toHaveLength(1);
    await h!.click(h!.button("CSV出力"));
    expect(await blobs.at(-1)!.text()).toContain(payload);
    await h!.click(h!.button("Sheetsに記録"));
    expect(saved.at(-1)!.students[0].name).toBe(payload);
    const { ledgerRows } = await import("./google/ledger");
    expect(JSON.stringify(ledgerRows(saved.at(-1)!))).toContain(payload);
    client.writeLedger.mockRejectedValueOnce(new Error(payload));
    await h!.click(h!.button("Sheetsに記録"));
    expect(h!.container.textContent).toContain(payload);
    expect(h!.container.querySelector('img[src="x"]')).toBeNull();
    expect(alerts).not.toHaveBeenCalled();
    expect(fetches).not.toHaveBeenCalled();
    expect(beacons).not.toHaveBeenCalled();
    expect(
      errorLogs.mock.calls.flat().some((v) => String(v).includes(payload)),
    ).toBe(false);
  });
});

describe("unresolved review change archive regression through App", () => {
  it("PF-G066 unchanged receipts with newly excluded unresolved pages start fresh plan and preserve old reservation", async () => {
    const pdf = await PDFDocument.create();
    for (let n = 0; n < 3; n++) pdf.addPage([595, 842]);
    bytes = await pdf.save();
    const c = state.collections[0],
      token = c.tokens.find(
        (t) => t.studentId === state.students[0].id && t.pageNumber === 2,
      )!;
    mock.scan.mockResolvedValue([
      {
        ...token,
        id: "accepted",
        sourcePage: 1,
        status: "matched",
        resolution: "accepted",
      },
      ...[2, 3].map((sourcePage) => ({
        id: `unknown-${sourcePage}`,
        sourcePage,
        status: "unreadable",
        resolution: "pending",
      })),
    ]);
    client.uploadPdf.mockImplementation(async (options) => {
      if (options.name.includes("未照合"))
        throw new GoogleApiError("NETWORK", "未照合PDF応答喪失");
      return { id: options.fileId, name: options.name };
    });
    await restore();
    await uploadRecovered(bytes);
    await h!.click(h!.input("書類もDriveに保管"));
    await h!.click(saveButton());
    await finishAsyncApp();
    expect(h!.container.textContent).toContain("未照合PDF応答喪失");
    const old = structuredClone(saved.at(-1)!.operations![0]),
      receipts = structuredClone(saved.at(-1)!.receipts);
    expect(old.unresolvedPages).toEqual([2, 3]);
    expect(old.archiveStatus).toBe("failed");
    for (const sourcePage of [2, 3]) {
      await h!.value(
        h!.input("確認・保留・除外の理由"),
        `${sourcePage}ページは別書類`,
      );
      await h!.click(h!.button("この元PDFページを全配布物で除外"));
    }
    await h!.click(h!.input("書類もDriveに保管"));
    await h!.click(saveButton());
    expect(saved.at(-1)!.receipts).toEqual(receipts);
    client.uploadPdf.mockImplementation(async (options) => ({
      id: options.fileId,
      name: options.name,
    }));
    const oldUnresolved =
        old.plannedFileIds![
          Object.keys(old.plannedFileIds!).find((k) =>
            k.startsWith("unresolved:"),
          )!
        ],
      calls = client.uploadPdf.mock.calls.length;
    await h!.click(h!.button("現在の回収内容をDriveに保管"));
    await finishAsyncApp();
    const result = saved.at(-1)!;
    expect(
      result.operations!.find((o) => o.id === old.id)!.plannedFileIds,
    ).toEqual(old.plannedFileIds);
    const current = result.operations!.at(-1)!;
    expect(current.id).not.toBe(old.id);
    expect(current.archiveStatus).toBe("saved");
    expect(current.unresolvedPages).toEqual([]);
    expect(result.receipts).toEqual(receipts);
    expect(
      client.uploadPdf.mock.calls
        .slice(calls)
        .some(([o]) => o.fileId === oldUnresolved),
    ).toBe(false);
    expect(
      client.uploadPdf.mock.calls.filter(([o]) => o.name.includes("回収元")),
    ).toHaveLength(1);
  });
});
