import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppState, Collection, Receipt } from "../domain/types";
import { GOOGLE_SCOPES } from "./auth";
import { GoogleWorkspaceClient, LEDGER_TABS, ledgerRows } from "./client";

const clientId = "test-client.apps.googleusercontent.com";
function installIdentity(scopes = GOOGLE_SCOPES.join(" ")) {
  vi.stubGlobal("window", {
    google: {
      accounts: {
        oauth2: {
          initTokenClient: (options: {
            callback: (value: unknown) => void;
          }) => ({
            requestAccessToken: () =>
              options.callback({
                access_token: "test-access-token",
                expires_in: 3600,
                scope: scopes,
              }),
          }),
        },
      },
    },
  });
}
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
const identity = {
  sub: "teacher-1",
  email: "teacher@example.test",
  name: "Test Teacher",
};
const emptyState: AppState = {
  schemaVersion: 1,
  className: "架空クラス",
  students: [],
  collections: [],
  receipts: [],
  batches: [],
  events: [],
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Google adapter boundaries", () => {
  it("does not make API calls without configuration or an authenticated session", async () => {
    const fetcher = vi.fn();
    const client = new GoogleWorkspaceClient({ clientId: "", fetch: fetcher });
    await expect(client.connect()).rejects.toMatchObject({
      code: "CONFIG_REQUIRED",
    });
    await expect(client.listCourses()).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects partially granted scopes before making API requests", async () => {
    installIdentity(
      "openid email profile https://www.googleapis.com/auth/drive.file",
    );
    const fetcher = vi.fn();
    const client = new GoogleWorkspaceClient({ clientId, fetch: fetcher });
    await expect(client.connect()).rejects.toMatchObject({
      code: "AUTH_DENIED",
    });
    expect(client.isConnected()).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("follows Classroom pagination and retains IDs rather than merging equal names", async () => {
    installIdentity();
    const rows = Array.from({ length: 40 }, (_, index) => ({
      userId: String(index + 1),
      profile: { name: { fullName: "同姓同名" } },
    }));
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(identity))
      .mockResolvedValueOnce(
        json({ students: rows.slice(0, 30), nextPageToken: "page-two" }),
      )
      .mockResolvedValueOnce(json({ students: rows.slice(30) }));
    const client = new GoogleWorkspaceClient({ clientId, fetch: fetcher });
    await client.connect();
    const students = await client.listStudents("course/one");
    expect(students).toHaveLength(40);
    expect(new Set(students.map((student) => student.id)).size).toBe(40);
    expect(students[39]).toMatchObject({
      classroomUserId: "40",
      number: 40,
      seat: null,
    });
    const request = new URL(fetcher.mock.calls[2][0]);
    expect(request.searchParams.get("pageToken")).toBe("page-two");
    expect(request.pathname).toContain("course%2Fone");
    expect(
      new Headers(fetcher.mock.calls[2][1].headers).get("Authorization"),
    ).toBe("Bearer test-access-token");
  });

  it("clears a failed authorization and does not silently retry a write", async () => {
    installIdentity();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(identity))
      .mockResolvedValueOnce(json({ error: "expired" }, 401));
    const client = new GoogleWorkspaceClient({ clientId, fetch: fetcher });
    await client.connect();
    await expect(client.createLedger("台帳")).rejects.toMatchObject({
      code: "AUTH_EXPIRED",
    });
    expect(client.isConnected()).toBe(false);
    await expect(client.createLedger("台帳")).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("writes names as strings, never spreadsheet formulas, and clears stale snapshot values", async () => {
    installIdentity();
    const sheets = LEDGER_TABS.map((title, sheetId) => ({
      properties: { title, sheetId },
    }));
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(identity))
      .mockResolvedValueOnce(json({ id: "ledger-1" }))
      .mockResolvedValueOnce(json({ sheets }))
      .mockResolvedValueOnce(json({ sheets }))
      .mockResolvedValueOnce(json({ sheets }))
      .mockResolvedValueOnce(json({ replies: [] }));
    const client = new GoogleWorkspaceClient({ clientId, fetch: fetcher });
    await client.connect();
    const ledger = await client.createLedger("台帳");
    await client.writeLedger(ledger, {
      ...emptyState,
      students: [
        { id: "one", name: '=IMPORTXML("bad")', number: 1, seat: null },
      ],
    });
    const payload = JSON.parse(fetcher.mock.calls[5][1].body as string);
    const studentsUpdate = payload.requests.find(
      (request: { updateCells?: { start: { sheetId: number } } }) =>
        request.updateCells?.start.sheetId === ledger.sheets.Students,
    );
    expect(
      studentsUpdate.updateCells.rows[1].values[1].userEnteredValue,
    ).toEqual({ stringValue: '=IMPORTXML("bad")' });
    expect(
      payload.requests.filter(
        (request: { repeatCell?: unknown }) => request.repeatCell,
      ),
    ).toHaveLength(9);
    expect(JSON.stringify(payload)).not.toContain("formulaValue");
  });

  it("stops before writing when a ledger tab was renamed", async () => {
    installIdentity();
    const sheets = LEDGER_TABS.map((title, sheetId) => ({
      properties: { title, sheetId },
    }));
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(identity))
      .mockResolvedValueOnce(json({ id: "ledger-1" }))
      .mockResolvedValueOnce(json({ sheets }))
      .mockResolvedValueOnce(json({ sheets }))
      .mockResolvedValueOnce(
        json({
          sheets: [
            { properties: { title: "My notes", sheetId: 0 } },
            ...sheets.slice(1),
          ],
        }),
      );
    const client = new GoogleWorkspaceClient({ clientId, fetch: fetcher });
    await client.connect();
    const ledger = await client.createLedger("台帳");
    await expect(client.writeLedger(ledger, emptyState)).rejects.toMatchObject({
      code: "INVALID_DATA",
    });
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("does not send a bearer token to an unexpected resumable-upload origin", async () => {
    installIdentity();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(identity))
      .mockResolvedValueOnce(json({ ids: ["new-pdf"] }))
      .mockResolvedValueOnce(
        new Response("", {
          status: 200,
          headers: { Location: "https://untrusted.example/upload" },
        }),
      );
    const client = new GoogleWorkspaceClient({ clientId, fetch: fetcher });
    await client.connect();
    const bytes = new Uint8Array(5 * 1024 * 1024 + 1);
    bytes.set(new TextEncoder().encode("%PDF-1.7"));
    await expect(
      client.uploadPdf({ name: "架空.pdf", bytes }),
    ).rejects.toMatchObject({ code: "API" });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("exports a teacher-facing Summary using issued recipients and current-version receipts", () => {
    const collection: Collection = {
      id: "collection-1",
      versionId: "version-1",
      title: "架空同意書",
      className: "架空クラス",
      dueDate: "",
      createdAt: "",
      pageCount: 3,
      requiredPages: [1, 3],
      qrCorner: "top-right",
      duplex: false,
      order: "number",
      reverse: false,
      sourceName: "source.pdf",
      tokens: [],
      recipients: [
        { id: "three", number: 3, name: "旧名簿C", seat: null },
        { id: "one", number: 1, name: "旧名簿A", seat: null },
        { id: "two", number: 2, name: "旧名簿B", seat: null },
      ],
    };
    const receipt = (
      studentId: string,
      pageNumber: number,
      recordedAt: string,
      versionId = "version-1",
    ): Receipt => ({
      id: `${studentId}-${pageNumber}-${versionId}`,
      collectionId: "collection-1",
      versionId,
      studentId,
      pageNumber,
      recordedAt,
      batchId: "batch",
      sourcePage: 1,
      method: "qr",
    });
    const rows = ledgerRows({
      ...emptyState,
      collections: [collection],
      receipts: [
        receipt("one", 1, "2026-11-10T00:00:00Z", "old-version"),
        receipt("two", 1, "2026-11-09T01:00:00Z"),
        receipt("three", 1, "2026-11-09T01:00:00Z"),
        receipt("three", 3, "2026-11-09T02:00:00Z"),
        receipt("three", 3, "2026-11-10T00:00:00Z", "old-version"),
      ],
    }).Summary;
    expect(rows[1].slice(0, 9)).toEqual([
      "架空クラス",
      "架空同意書",
      1,
      "旧名簿A",
      "未回収",
      "1・3",
      "",
      2,
      0,
    ]);
    expect(rows[2].slice(0, 9)).toEqual([
      "架空クラス",
      "架空同意書",
      2,
      "旧名簿B",
      "一部不足",
      "3",
      "2026/11/09 10:00:00",
      2,
      1,
    ]);
    expect(rows[3].slice(0, 9)).toEqual([
      "架空クラス",
      "架空同意書",
      3,
      "旧名簿C",
      "回収済み",
      "",
      "2026/11/09 11:00:00",
      2,
      2,
    ]);
  });

  it("reuses the generated file ID after response loss and verifies the 409 file content", async () => {
    installIdentity();
    const bytes = new TextEncoder().encode("%PDF-1.7\nfixture");
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hash = Array.from(new Uint8Array(digest), (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(identity))
      .mockResolvedValueOnce(json({ ids: ["same-pdf"] }))
      .mockRejectedValueOnce(new TypeError("network response lost"))
      .mockResolvedValueOnce(json({ error: "already created" }, 409))
      .mockResolvedValueOnce(
        json({
          id: "same-pdf",
          name: "架空.pdf",
          mimeType: "application/pdf",
          size: String(bytes.length),
          sha256Checksum: hash,
        }),
      );
    const client = new GoogleWorkspaceClient({ clientId, fetch: fetcher });
    await client.connect();
    await expect(
      client.uploadPdf({ name: "架空.pdf", bytes, idempotencyKey: "print-v1" }),
    ).rejects.toMatchObject({ code: "NETWORK" });
    const result = await client.uploadPdf({
      name: "架空.pdf",
      bytes,
      idempotencyKey: "print-v1",
    });
    expect(result.id).toBe("same-pdf");
    expect(
      fetcher.mock.calls.filter((call) =>
        String(call[0]).includes("generateIds"),
      ),
    ).toHaveLength(1);
    expect(await (fetcher.mock.calls[2][1].body as Blob).text()).toContain(
      '"id":"same-pdf"',
    );
    expect(await (fetcher.mock.calls[3][1].body as Blob).text()).toContain(
      '"id":"same-pdf"',
    );
    expect(fetcher.mock.calls[4][0]).toContain("/files/same-pdf?fields=");
  });

  it("rejects reusing an idempotency key for changed PDF bytes", async () => {
    installIdentity();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(identity))
      .mockResolvedValueOnce(json({ ids: ["one-pdf"] }))
      .mockResolvedValueOnce(json({ id: "one-pdf", name: "架空.pdf" }));
    const client = new GoogleWorkspaceClient({ clientId, fetch: fetcher });
    await client.connect();
    await client.uploadPdf({
      name: "架空.pdf",
      bytes: new TextEncoder().encode("%PDF-1.7\noriginal"),
      idempotencyKey: "print-v1",
    });
    await expect(
      client.uploadPdf({
        name: "架空.pdf",
        bytes: new TextEncoder().encode("%PDF-1.7\nchanged"),
        idempotencyKey: "print-v1",
      }),
    ).rejects.toMatchObject({ code: "INVALID_DATA" });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("never reports success for a conflicting saved PDF with the wrong checksum", async () => {
    installIdentity();
    const bytes = new TextEncoder().encode("%PDF-1.7\nfixture");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(identity))
      .mockResolvedValueOnce(json({ ids: ["conflict-pdf"] }))
      .mockResolvedValueOnce(json({ error: "exists" }, 409))
      .mockResolvedValueOnce(
        json({
          id: "conflict-pdf",
          name: "架空.pdf",
          mimeType: "application/pdf",
          size: String(bytes.length),
          sha256Checksum: "wrong-hash",
        }),
      );
    const client = new GoogleWorkspaceClient({ clientId, fetch: fetcher });
    await client.connect();
    await expect(
      client.uploadPdf({ name: "架空.pdf", bytes, idempotencyKey: "print-v1" }),
    ).rejects.toMatchObject({ code: "API", status: 409 });
  });

  it("downloads the saved PDF for verification when Drive omits its SHA-256 checksum", async () => {
    installIdentity();
    const bytes = new TextEncoder().encode("%PDF-1.7\nfixture");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(identity))
      .mockResolvedValueOnce(json({ ids: ["existing-pdf"] }))
      .mockResolvedValueOnce(json({ error: "exists" }, 409))
      .mockResolvedValueOnce(
        json({
          id: "existing-pdf",
          name: "架空.pdf",
          mimeType: "application/pdf",
          size: String(bytes.length),
        }),
      )
      .mockResolvedValueOnce(
        new Response(bytes, { headers: { "Content-Type": "application/pdf" } }),
      );
    const client = new GoogleWorkspaceClient({ clientId, fetch: fetcher });
    await client.connect();
    await expect(
      client.uploadPdf({ name: "架空.pdf", bytes, idempotencyKey: "print-v1" }),
    ).resolves.toMatchObject({ id: "existing-pdf" });
    expect(fetcher.mock.calls[4][0]).toContain("alt=media");
  });
});
