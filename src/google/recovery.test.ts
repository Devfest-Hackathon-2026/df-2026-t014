import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "../domain/types";
import { GoogleWorkspaceClient, type GoogleLedger } from "./client";
import { GOOGLE_SCOPES } from "./auth";
import {
  LEDGER_TABS,
  decodeSnapshot,
  encodeSnapshot,
  hashTables,
  type SheetRows,
} from "./ledger";

const clientId = "test.apps.googleusercontent.com";
const identity = {
  sub: "teacher-1",
  email: "teacher@example.test",
  name: "Teacher",
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function setup() {
  const store = new Map<string, string>();
  const browser = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    },
    google: {
      accounts: {
        oauth2: {
          initTokenClient: (options: {
            callback: (response: unknown) => void;
          }) => ({
            requestAccessToken: () =>
              options.callback({
                access_token: "test-token",
                expires_in: 3600,
                scope: GOOGLE_SCOPES.join(" "),
              }),
          }),
        },
      },
    },
  };
  vi.stubGlobal("window", browser);
  return { browser, store };
}
function fixture(): AppState {
  const person = { id: "student", name: "架空生徒", number: 1, seat: null };
  const collection = {
    id: "collection",
    versionId: "version",
    title: "架空配布物",
    className: "架空クラス",
    dueDate: "",
    createdAt: "2026-11-09T00:00:00Z",
    pageCount: 2,
    requiredPages: [1, 2],
    qrCorner: "top-right" as const,
    duplex: false,
    order: "number" as const,
    reverse: false,
    sourceName: "source.pdf",
    tokens: [1, 2].map((pageNumber) => ({
      token: `token-${pageNumber}`,
      collectionId: "collection",
      versionId: "version",
      studentId: "student",
      pageNumber,
      kind: "content" as const,
      required: true,
    })),
    recipients: [person],
  };
  return {
    schemaVersion: 1,
    classId: "class-one",
    className: "架空クラス",
    students: [person],
    collections: [collection],
    receipts: [],
    batches: [
      {
        id: "batch",
        hash: "abc",
        fileName: "scan.pdf",
        pageCount: 2,
        createdAt: collection.createdAt,
        collectionId: collection.id,
        pages: [
          {
            id: "page-one",
            sourcePage: 1,
            status: "unreadable",
            resolution: "pending",
            thumbnail: "data:image/png,private",
            reviewReason: "再スキャン待ち",
          },
          {
            id: "page-two",
            sourcePage: 2,
            status: "unknown",
            resolution: "ignored",
            reason: "対象外",
          },
        ],
      },
    ],
    events: [],
    operations: [
      {
        id: "operation",
        collectionId: "collection",
        batchId: "batch",
        kind: "record",
        storageMode: "drive",
        recordStatus: "recorded",
        archiveStatus: "source-required",
        receiptIds: [],
        createdAt: collection.createdAt,
        updatedAt: collection.createdAt,
        plannedFileIds: { "source:batch": "fixed-file-id" },
      },
    ],
    settings: {
      googleAccountId: identity.sub,
      timezone: "Asia/Tokyo",
      ledgerRevision: "never-snapshot-this",
    },
  };
}
function sheetResponse(tables: SheetRows) {
  return {
    spreadsheetId: "ledger",
    spreadsheetUrl: "https://docs.google.com/spreadsheets/d/ledger/edit",
    sheets: LEDGER_TABS.map((title, sheetId) => ({
      properties: { title, sheetId },
      data: [
        {
          rowData: tables[title].map((row) => ({
            values: row.map((value) => ({
              userEnteredValue:
                typeof value === "string"
                  ? { stringValue: value }
                  : typeof value === "number"
                    ? { numberValue: value }
                    : { boolValue: value },
            })),
          })),
        },
      ],
    })),
  };
}
async function ledger(tables: SheetRows): Promise<GoogleLedger> {
  return {
    spreadsheetId: "ledger",
    spreadsheetUrl: "https://docs.google.com/spreadsheets/d/ledger/edit",
    schemaVersion: 1,
    accountId: identity.sub,
    sheets: Object.fromEntries(
      LEDGER_TABS.map((name, index) => [name, index]),
    ) as GoogleLedger["sheets"],
    revisionHash: await hashTables(tables),
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("durable Sheets snapshots", () => {
  it("roundtrips pending/ignored pages and save plans while omitting images, other classes and hash bookkeeping", async () => {
    const state = fixture();
    state.savedClasses = [
      {
        id: "other-class",
        className: "別クラス",
        students: [],
        collections: [],
        receipts: [],
        batches: [],
        events: [],
      },
    ];
    const encoded = await encodeSnapshot(state, identity.sub, "commit-1");
    const decoded = await decodeSnapshot(encoded.tables, identity.sub);
    expect(decoded.state.batches[0].pages).toMatchObject([
      { resolution: "pending", reviewReason: "再スキャン待ち" },
      { resolution: "ignored", reason: "対象外" },
    ]);
    expect(decoded.state.batches[0].pages[0].thumbnail).toBeUndefined();
    expect(decoded.state.operations?.[0].plannedFileIds).toEqual({
      "source:batch": "fixed-file-id",
    });
    expect(decoded.state.savedClasses).toBeUndefined();
    expect(decoded.state.settings?.ledgerRevision).toBeUndefined();
    expect(JSON.stringify(encoded.tables)).not.toContain("data:image");
    expect(encoded.tables.Batches).toHaveLength(3);
  });

  it("rejects a modified chunk and an account mismatch", async () => {
    const { tables } = await encodeSnapshot(
      fixture(),
      identity.sub,
      "commit-1",
    );
    await expect(
      decodeSnapshot(tables, "different-teacher"),
    ).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
    tables.AppState[1][1] += " ";
    await expect(decodeSnapshot(tables, identity.sub)).rejects.toMatchObject({
      code: "INVALID_DATA",
    });
  });

  it("splits metadata below the Sheets cell limit", async () => {
    const state = fixture();
    state.events = Array.from({ length: 3 }, (_, i) => ({
      id: String(i),
      at: "now",
      action: "テスト",
      detail: "x".repeat(25_000),
    }));
    const { tables } = await encodeSnapshot(state, identity.sub, "commit-1");
    expect(tables.AppState.length).toBeGreaterThan(3);
    expect(
      tables.AppState.slice(1).every((row) => String(row[1]).length <= 30_000),
    ).toBe(true);
    expect(
      (await decodeSnapshot(tables, identity.sub)).state.events,
    ).toHaveLength(3);
  });

  it("reads a verified snapshot through the live API adapter", async () => {
    setup();
    const { tables } = await encodeSnapshot(
      fixture(),
      identity.sub,
      "commit-1",
    );
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(identity))
      .mockResolvedValueOnce(json(sheetResponse(tables)));
    const client = new GoogleWorkspaceClient({ clientId, fetch: fetcher });
    await client.connect();
    const result = await client.readLedger("ledger");
    expect(result.state.operations?.[0].archiveStatus).toBe("source-required");
    expect(result.ledger.revisionHash).toBe(await hashTables(tables));
  });

  it("stops before writing when remote system data changed", async () => {
    setup();
    const encoded = await encodeSnapshot(fixture(), identity.sub, "commit-1");
    const handle = await ledger(encoded.tables);
    encoded.tables.Students[1][1] = "別画面で変更";
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(identity))
      .mockResolvedValueOnce(json(sheetResponse(encoded.tables)));
    const client = new GoogleWorkspaceClient({ clientId, fetch: fetcher });
    await client.connect();
    await expect(
      client.writeLedger(handle, fixture(), { operationId: "commit-2" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("preserves teacher remarks after Summary sorting and protects system tabs", async () => {
    setup();
    const encoded = await encodeSnapshot(fixture(), identity.sub, "commit-1");
    const handle = await ledger(encoded.tables);
    encoded.tables.Summary[1][11] = "先生の備考";
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(identity))
      .mockResolvedValueOnce(json(sheetResponse(encoded.tables)))
      .mockResolvedValueOnce(json({ replies: [] }));
    const client = new GoogleWorkspaceClient({ clientId, fetch: fetcher });
    await client.connect();
    await client.writeLedger(handle, fixture(), { operationId: "commit-2" });
    const body = JSON.parse(fetcher.mock.calls[2][1].body);
    const summary = body.requests.find(
      (r: { updateCells?: { start: { sheetId: number } } }) =>
        r.updateCells?.start.sheetId === 0,
    );
    expect(
      summary.updateCells.rows[1].values[11].userEnteredValue.stringValue,
    ).toBe("先生の備考");
    expect(
      body.requests.filter(
        (r: { addProtectedRange?: unknown }) => r.addProtectedRange,
      ),
    ).toHaveLength(8);
  });

  it("confirms a lost Sheets write response by operation ID and exact snapshot hash", async () => {
    setup();
    const before = await encodeSnapshot(fixture(), identity.sub, "commit-1"),
      after = await encodeSnapshot(fixture(), identity.sub, "commit-2");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(identity))
      .mockResolvedValueOnce(json(sheetResponse(before.tables)))
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockResolvedValueOnce(json(sheetResponse(after.tables)));
    const client = new GoogleWorkspaceClient({ clientId, fetch: fetcher });
    await client.connect();
    await expect(
      client.writeLedger(await ledger(before.tables), fixture(), {
        operationId: "commit-2",
      }),
    ).resolves.toMatchObject({ recovered: true, operationId: "commit-2" });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("refuses to reuse a committed operation ID for changed data", async () => {
    setup();
    const { tables } = await encodeSnapshot(
      fixture(),
      identity.sub,
      "commit-1",
    );
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(identity))
      .mockResolvedValueOnce(json(sheetResponse(tables)));
    const client = new GoogleWorkspaceClient({ clientId, fetch: fetcher });
    await client.connect();
    await expect(
      client.writeLedger(
        await ledger(tables),
        { ...fixture(), className: "変更" },
        { operationId: "commit-1" },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("Drive recovery and authorization", () => {
  it("uses the persisted file ID after constructing a new client", async () => {
    setup();
    const bytes = new TextEncoder().encode("%PDF-1.7 test");
    const hash = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    ]
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(identity))
      .mockResolvedValueOnce(json({}, 409))
      .mockResolvedValueOnce(
        json({
          id: "durable-id",
          name: "test.pdf",
          mimeType: "application/pdf",
          size: String(bytes.length),
          sha256Checksum: hash,
        }),
      );
    const client = new GoogleWorkspaceClient({ clientId, fetch: fetcher });
    await client.connect();
    await expect(
      client.uploadPdf({ name: "test.pdf", bytes, fileId: "durable-id" }),
    ).resolves.toMatchObject({ id: "durable-id" });
    expect(
      fetcher.mock.calls.some((call) =>
        String(call[0]).includes("generateIds"),
      ),
    ).toBe(false);
  });

  it("PF-G080 queries resumable status and continues at the server-confirmed offset after network failure", async () => {
    setup();
    const bytes = new Uint8Array(8388609);
    bytes.set(new TextEncoder().encode("%PDF-1.7"));
    const uploadUrl =
      "https://www.googleapis.com/upload/drive/v3/files?upload_id=test";
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(identity))
      .mockResolvedValueOnce(
        new Response("", { headers: { Location: uploadUrl } }),
      )
      .mockResolvedValueOnce(
        new Response("", {
          status: 308,
          headers: { Range: "bytes=0-4194303" },
        }),
      )
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(
        new Response("", {
          status: 308,
          headers: { Range: "bytes=0-4194303" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("", {
          status: 308,
          headers: { Range: "bytes=0-8388607" },
        }),
      )
      .mockResolvedValueOnce(json({ id: "big-pdf", name: "big.pdf" }));
    const client = new GoogleWorkspaceClient({ clientId, fetch: fetcher });
    await client.connect();
    await expect(
      client.uploadPdf({ name: "big.pdf", bytes, fileId: "big-pdf" }),
    ).rejects.toMatchObject({ code: "NETWORK" });
    await expect(
      client.uploadPdf({ name: "big.pdf", bytes, fileId: "big-pdf" }),
    ).resolves.toMatchObject({ id: "big-pdf" });
    expect(
      new Headers(fetcher.mock.calls[4][1].headers).get("Content-Range"),
    ).toBe(`bytes */${bytes.length}`);
    expect(
      new Headers(fetcher.mock.calls[5][1].headers).get("Content-Range"),
    ).toBe(`bytes 4194304-8388607/${bytes.length}`);
  });

  it("reports expiry to the UI without making another API call", async () => {
    setup();
    vi.useFakeTimers();
    const events = vi.fn();
    const fetcher = vi.fn().mockResolvedValue(json(identity));
    const client = new GoogleWorkspaceClient({
      clientId,
      fetch: fetcher,
      onAuthStateChange: events,
    });
    await client.connect();
    vi.advanceTimersByTime(3_590_001);
    expect(client.getIdentity()).toBeUndefined();
    expect(events).toHaveBeenLastCalledWith({ status: "expired" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not recreate a possibly successful ledger after reloading before search indexing catches up", async () => {
    const { store } = setup();
    const firstFetch = vi
      .fn()
      .mockResolvedValueOnce(json(identity))
      .mockResolvedValueOnce(json({ files: [] }))
      .mockRejectedValueOnce(new TypeError("lost create response"))
      .mockResolvedValueOnce(json({ files: [] }));
    const first = new GoogleWorkspaceClient({ clientId, fetch: firstFetch });
    await first.connect();
    await expect(
      first.createLedger("台帳", { idempotencyKey: "class-1" }),
    ).rejects.toMatchObject({ code: "NETWORK" });
    expect([...store.values()].join("")).not.toContain("台帳");
    const secondFetch = vi
      .fn()
      .mockResolvedValueOnce(json(identity))
      .mockResolvedValueOnce(json({ files: [] }));
    const second = new GoogleWorkspaceClient({ clientId, fetch: secondFetch });
    await second.connect();
    await expect(
      second.createLedger("台帳", { idempotencyKey: "class-1" }),
    ).rejects.toMatchObject({ code: "AMBIGUOUS_WRITE" });
    expect(secondFetch).toHaveBeenCalledTimes(2);
  });

  it("verifies a downloaded PDF against the original hash and does not accept an HTML error body", async () => {
    setup();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(identity))
      .mockResolvedValueOnce(
        json({ id: "pdf", mimeType: "application/pdf", size: "8" }),
      )
      .mockResolvedValueOnce(new Response("<html>error</html>"));
    const client = new GoogleWorkspaceClient({ clientId, fetch: fetcher });
    await client.connect();
    await expect(client.downloadPdf("pdf")).rejects.toMatchObject({
      code: "INVALID_DATA",
    });
  });
});

describe("PF additional response-loss and session boundaries", () => {
  it("PF-G059 resolves a lost creation through exact private appProperties after new client construction", async () => {
    setup();
    const firstFetch = vi
      .fn()
      .mockResolvedValueOnce(json(identity))
      .mockResolvedValueOnce(json({ files: [] }))
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockResolvedValueOnce(json({ files: [] }));
    const first = new GoogleWorkspaceClient({ clientId, fetch: firstFetch });
    await first.connect();
    await expect(
      first.createLedger("架空台帳", { idempotencyKey: "class-one" }),
    ).rejects.toThrow();
    const metadata = JSON.parse(firstFetch.mock.calls[2][1].body);
    const encoded = await encodeSnapshot(fixture(), identity.sub, "prior");
    const secondFetch = vi
      .fn()
      .mockResolvedValueOnce(json(identity))
      .mockResolvedValueOnce(
        json({
          files: [
            {
              id: "existing",
              name: "架空台帳",
              mimeType: "application/vnd.google-apps.spreadsheet",
              appProperties: metadata.appProperties,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        json({
          sheets: LEDGER_TABS.map((title, sheetId) => ({
            properties: { title, sheetId },
          })),
        }),
      )
      .mockResolvedValueOnce(
        json({ ...sheetResponse(encoded.tables), spreadsheetId: "existing" }),
      );
    const second = new GoogleWorkspaceClient({ clientId, fetch: secondFetch });
    await second.connect();
    const recovered = await second.createLedger("架空台帳", {
      idempotencyKey: "class-one",
    });
    expect(recovered.spreadsheetId).toBe("existing");
    expect(recovered.restorationRequired).toBe(true);
    expect(
      secondFetch.mock.calls.every(
        (call) => !call[1]?.method || call[1].method === "GET",
      ),
    ).toBe(true);
    expect(decodeURIComponent(secondFetch.mock.calls[1][0])).toContain(
      "paperflowLedger",
    );
  });
  it("PF-G086 fresh client restarts upload with persisted file ID and never stores token or session URL", async () => {
    const { store } = setup();
    const bytes = new Uint8Array(6 * 1024 * 1024);
    bytes.set(new TextEncoder().encode("%PDF-"));
    const url =
      "https://www.googleapis.com/upload/drive/v3/files?upload_id=old-private-session";
    const firstFetch = vi
      .fn()
      .mockResolvedValueOnce(json(identity))
      .mockResolvedValueOnce(new Response("", { headers: { Location: url } }))
      .mockRejectedValueOnce(new TypeError("closed"));
    const first = new GoogleWorkspaceClient({ clientId, fetch: firstFetch });
    await first.connect();
    await expect(
      first.uploadPdf({ name: "架空.pdf", bytes, fileId: "fixed" }),
    ).rejects.toThrow();
    expect([...store.values()].join("")).not.toMatch(
      /test-token|old-private-session|架空/,
    );
    const newUrl =
      "https://www.googleapis.com/upload/drive/v3/files?upload_id=new-session";
    const secondFetch = vi
      .fn()
      .mockResolvedValueOnce(json(identity))
      .mockResolvedValueOnce(
        new Response("", { headers: { Location: newUrl } }),
      )
      .mockResolvedValueOnce(
        new Response("", {
          status: 308,
          headers: { Range: "bytes=0-4194303" },
        }),
      )
      .mockResolvedValueOnce(json({ id: "fixed" }));
    const second = new GoogleWorkspaceClient({ clientId, fetch: secondFetch });
    await second.connect();
    await expect(
      second.uploadPdf({ name: "架空.pdf", bytes, fileId: "fixed" }),
    ).resolves.toMatchObject({ id: "fixed" });
    expect(secondFetch.mock.calls[1][1].method).toBe("POST");
    expect(JSON.parse(secondFetch.mock.calls[1][1].body).id).toBe("fixed");
    expect(
      secondFetch.mock.calls.some(
        (call) => call[0] === url || String(call[0]).includes("generateIds"),
      ),
    ).toBe(false);
    expect([...store.values()].join("")).not.toMatch(/test-token|session/);
  });
});
