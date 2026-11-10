import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleTokenSession, GOOGLE_SCOPES } from "./auth";
import { GoogleWorkspaceClient } from "./client";
import { pickerOrigin } from "./picker";
import {
  encodeSnapshot,
  decodeSnapshot,
  canonicalJson,
  hashText,
} from "./ledger";
import { sanitizeStateForStorage } from "../domain/persistence";
import type { AppState } from "../domain/types";
import { createCollection } from "../domain/logic";
const clientId = "test.apps.googleusercontent.com";
const identity = {
  sub: "teacher",
  email: "teacher@example.test",
  name: "架空先生",
};
const json = (x: unknown, status = 200) =>
  new Response(JSON.stringify(x), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function auth(response: Record<string, unknown> = {}) {
  vi.stubGlobal("window", {
    google: {
      accounts: {
        oauth2: {
          initTokenClient: (o: {
            callback: (v: unknown) => void;
            error_callback: (v: unknown) => void;
          }) => ({
            requestAccessToken: () =>
              o.callback({
                access_token: "test-token",
                expires_in: 3600,
                scope: GOOGLE_SCOPES.join(" "),
                ...response,
              }),
          }),
        },
      },
    },
  });
}
async function clientWith(fetcher: ReturnType<typeof vi.fn>) {
  auth();
  const c = new GoogleWorkspaceClient({
    clientId,
    fetch: fetcher as unknown as typeof fetch,
  });
  await c.connect();
  return c;
}
function empty(): AppState {
  return {
    schemaVersion: 1,
    className: "架空",
    students: [],
    collections: [],
    receipts: [],
    batches: [],
    events: [],
  };
}
function sizedState(size: number) {
  const s = empty();
  s.events = Array.from({ length: Math.ceil(size / 40000) }, (_, i) => ({
    id: String(i),
    at: "now",
    action: "boundary",
    detail: "",
  }));
  let remaining = size - canonicalJson(sanitizeStateForStorage(s)).length;
  for (const e of s.events) {
    const n = Math.min(40000, remaining);
    e.detail = "x".repeat(n);
    remaining -= n;
  }
  expect(remaining).toBe(0);
  expect(canonicalJson(sanitizeStateForStorage(s)).length).toBe(size);
  return s;
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("PF Google execution: mocked APIs and pure boundaries", () => {
  it.each([403, 404])(
    "PF-G018 PDF HTTP %s keeps the status and guides individual selection",
    async (status) => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(json(identity))
        .mockResolvedValueOnce(
          json({ error: { message: "not accessible" } }, status),
        );
      const client = await clientWith(fetcher);
      try {
        await expect(
          client.downloadPdf("unselected-pdf"),
        ).rejects.toMatchObject({
          status,
          message: expect.stringContaining(
            "対象のPDFを個別に選び直してください",
          ),
        });
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(String(fetcher.mock.calls[1][0])).not.toContain("alt=media");
      } finally {
        client.disconnect();
      }
    },
  );
  it("PF-G002 cancelled authorization does not connect or request APIs", async () => {
    auth({ error: "access_denied", access_token: undefined });
    const f = vi.fn();
    const c = new GoogleWorkspaceClient({ clientId, fetch: f });
    await expect(c.connect()).rejects.toMatchObject({ code: "AUTH_DENIED" });
    expect(c.isConnected()).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
  it("PF-G003 partial scopes never connect", async () => {
    auth({
      scope: "openid email profile https://www.googleapis.com/auth/drive.file",
    });
    const f = vi.fn();
    const c = new GoogleWorkspaceClient({ clientId, fetch: f });
    await expect(c.connect()).rejects.toMatchObject({ code: "AUTH_DENIED" });
    expect(f).not.toHaveBeenCalled();
  });
  it("PF-G004 401 emits expired and stops further calls", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(json(identity))
      .mockResolvedValueOnce(json({}, 401));
    const c = await clientWith(f);
    const changed = vi.fn();
    c.onAuthStateChange(changed);
    await expect(c.listCourses()).rejects.toMatchObject({
      code: "AUTH_EXPIRED",
    });
    expect(c.getIdentity()).toBeUndefined();
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({ status: "expired" }),
    );
    await expect(c.listCourses()).rejects.toThrow();
    expect(f).toHaveBeenCalledTimes(2);
  });
  for (const [id, seconds, allowed] of [
    ["PF-G005", 9, false],
    ["PF-G006", 10, false],
    ["PF-G007", 11, true],
  ] as const)
    it(`${id} expiry acceptance ${seconds}s`, async () => {
      vi.useFakeTimers();
      auth({ expires_in: seconds });
      const s = new GoogleTokenSession(clientId);
      if (allowed) {
        await s.connect();
        expect(s.isConnected()).toBe(true);
        vi.advanceTimersByTime(1000);
        expect(s.isConnected()).toBe(false);
      } else {
        await expect(s.connect()).rejects.toMatchObject({
          code: "AUTH_DENIED",
        });
        expect(s.isConnected()).toBe(false);
      }
      s.clear();
    });
  for (const [id, ms, live] of [
    ["PF-G008", 3589999, true],
    ["PF-G009", 3590000, false],
    ["PF-G010", 3590001, false],
  ] as const)
    it(`${id} effective expiry ${ms}ms`, async () => {
      vi.useFakeTimers();
      auth();
      const s = new GoogleTokenSession(clientId);
      const changed = vi.fn();
      s.subscribe(changed);
      await s.connect();
      vi.advanceTimersByTime(ms);
      expect(s.isConnected()).toBe(live);
      if (!live) {
        expect(changed).toHaveBeenLastCalledWith("expired");
        expect(() => s.getAccessToken()).toThrow();
      }
      s.clear();
    });
  for (const [id, key, value] of [
    ["PF-G019", "paperflowHostOrigin", ""],
    ["PF-G020", "paperflowHostOrigin", "https://evil.test"],
    ["PF-G021", "paperflowBridge", "bad"],
    ["PF-G022", "paperflowParentOrigin", "https://evil.test"],
  ] as const)
    it(`${id} untrusted embedded picker context uses own origin`, () => {
      const p = new URLSearchParams({
        paperflowBridge: crypto.randomUUID(),
        paperflowParentOrigin: "https://script.googleusercontent.com",
        paperflowHostOrigin: "https://docs.google.com",
      });
      if (value) p.set(key, value);
      else p.delete(key);
      vi.stubGlobal("window", {
        parent: {},
        location: { origin: "https://paperflow.test", hash: "#" + p },
      });
      expect(pickerOrigin()).toBe("https://paperflow.test");
    });
  it("PF-G032 follows all teacher course pages with teacherId me", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(json(identity))
      .mockResolvedValueOnce(
        json({ courses: [{ id: "A", name: "A" }], nextPageToken: "two" }),
      )
      .mockResolvedValueOnce(json({ courses: [{ id: "B", name: "B" }] }));
    const c = await clientWith(f);
    const courses = await c.listCourses();
    expect(courses.map((v) => v.id)).toEqual(["A", "B"]);
    for (const call of f.mock.calls.slice(1))
      expect(new URL(call[0]).searchParams.get("teacherId")).toBe("me");
    expect(new URL(f.mock.calls[2][0]).searchParams.get("pageToken")).toBe(
      "two",
    );
  });
  for (const [id, count] of [
    ["PF-G033", 0],
    ["PF-G034", 1],
    ["PF-G035", 30],
    ["PF-G036", 31],
    ["PF-G037", 40],
  ] as const)
    it(`${id} roster ${count} IDs without name merging`, async () => {
      const rows = Array.from({ length: count }, (_, i) => ({
        userId: String(i),
        profile: { name: { fullName: "同姓同名" } },
      }));
      const f = vi.fn().mockResolvedValueOnce(json(identity));
      if (count > 30)
        f.mockResolvedValueOnce(
          json({ students: rows.slice(0, 30), nextPageToken: "two" }),
        ).mockResolvedValueOnce(json({ students: rows.slice(30) }));
      else f.mockResolvedValueOnce(json({ students: rows }));
      const c = await clientWith(f);
      const list = await c.listStudents("course");
      expect(list.length).toBe(count);
      expect(new Set(list.map((v) => v.classroomUserId)).size).toBe(count);
      expect(list.every((v, i) => v.number === i + 1 && v.seat === null)).toBe(
        true,
      );
      expect(f).toHaveBeenCalledTimes(count > 30 ? 3 : 2);
    });
  it("PF-G038 second page failure rejects entire roster", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(json(identity))
      .mockResolvedValueOnce(
        json({
          students: [{ userId: "1", profile: { name: { fullName: "架空" } } }],
          nextPageToken: "two",
        }),
      )
      .mockResolvedValueOnce(json({}, 503));
    const c = await clientWith(f);
    await expect(c.listStudents("course")).rejects.toMatchObject({
      status: 503,
    });
    expect(f).toHaveBeenCalledTimes(3);
  });
  for (const [id, mutation] of [
    ["PF-G040", "missing"],
    ["PF-G041", "reversed"],
    ["PF-G042", "changed"],
    ["PF-G043", "account"],
  ] as const)
    it(`${id} rejects corrupted snapshot ${mutation}`, async () => {
      const { tables } = await encodeSnapshot(
        sizedState(30001),
        "teacher",
        "commit",
      );
      if (mutation === "missing") tables.AppState.pop();
      if (mutation === "reversed")
        tables.AppState.splice(1, 2, tables.AppState[2], tables.AppState[1]);
      if (mutation === "changed") tables.AppState[1][1] += " ";
      if (mutation === "account")
        tables.Metadata.find((r) => r[0] === "accountId")![1] = "other";
      await expect(decodeSnapshot(tables, "teacher")).rejects.toMatchObject({
        code: mutation === "account" ? "ACCOUNT_MISMATCH" : "INVALID_DATA",
      });
    });
  for (const [id, field] of [
    ["PF-G044", "batchId"],
    ["PF-G045", "token"],
  ] as const)
    it(`${id} rejects broken receipt ${field} even with valid hash`, async () => {
      const s = empty();
      s.students = [{ id: "s", name: "架空", number: 1, seat: null }];
      const c = createCollection(
        {
          title: "架空票",
          className: s.className,
          pageCount: 1,
          requiredPages: [1],
          qrCorner: "top-right",
          duplex: false,
          order: "number",
          reverse: false,
        },
        s.students,
      );
      const token = c.tokens[0].token;
      s.collections = [c];
      s.batches = [
        {
          id: "b",
          hash: "hash",
          fileName: "架空.pdf",
          pageCount: 1,
          createdAt: c.createdAt,
          collectionId: c.id,
          pages: [
            {
              id: "p",
              sourcePage: 1,
              status: "matched",
              resolution: "accepted",
              studentId: "s",
              collectionId: c.id,
              versionId: c.versionId,
              pageNumber: 1,
              token,
            },
          ],
        },
      ];
      s.receipts = [
        {
          id: "r",
          collectionId: c.id,
          versionId: c.versionId,
          studentId: "s",
          pageNumber: 1,
          batchId: "b",
          sourcePage: 1,
          recordedAt: c.createdAt,
          method: "qr",
          token,
        },
      ];
      const { tables } = await encodeSnapshot(s, "teacher", "commit");
      await expect(decodeSnapshot(tables, "teacher")).resolves.toBeDefined();
      const corrupt = structuredClone(s);
      corrupt.receipts[0][field] = "missing";
      const serialized = canonicalJson(corrupt);
      tables.AppState = [
        ["chunk", "json"],
        [0, serialized],
      ];
      tables.Metadata.find((r) => r[0] === "stateHash")![1] =
        await hashText(serialized);
      await expect(decodeSnapshot(tables, "teacher")).rejects.toMatchObject({
        code: "INVALID_DATA",
      });
    });
  it("PF-G046 refuses old 6 and 7 tab ledgers without snapshot reconstruction", async () => {
    for (const count of [6, 7]) {
      const names = [
        "Students",
        "Collections",
        "Tokens",
        "Receipts",
        "Batches",
        "Events",
        ...(count === 7 ? ["Summary"] : []),
      ];
      const f = vi
        .fn()
        .mockResolvedValueOnce(json(identity))
        .mockResolvedValueOnce(
          json({
            sheets: names.map((title, sheetId) => ({
              properties: { title, sheetId },
              data: [],
            })),
          }),
        );
      const c = await clientWith(f);
      await expect(c.readLedger("legacy")).rejects.toThrow("旧形式");
      expect(f).toHaveBeenCalledTimes(2);
    }
  });
  for (const [id, size] of [
    ["PF-G047", 29999],
    ["PF-G048", 30000],
    ["PF-G049", 30001],
    ["PF-G050", 9999999],
    ["PF-G051", 10000000],
    ["PF-G052", 10000001],
  ] as const)
    it(`${id} exact snapshot size ${size}`, async () => {
      const s = sizedState(size);
      if (size > 10000000) {
        await expect(encodeSnapshot(s, "teacher", "commit")).rejects.toThrow(
          "大きすぎ",
        );
        return;
      }
      const e = await encodeSnapshot(s, "teacher", "commit");
      expect(e.tables.AppState.length - 1).toBe(Math.ceil(size / 30000));
      expect(
        e.tables.AppState.slice(1).every((r) => String(r[1]).length <= 30000),
      ).toBe(true);
      const decoded = await decodeSnapshot(e.tables, "teacher");
      expect(canonicalJson(decoded.state)).toBe(canonicalJson(e.state));
      expect(decoded.stateHash).toBe(e.stateHash);
    });
  for (const [id, status] of [
    ["PF-G069", 403],
    ["PF-G070", 404],
    ["PF-G071", 429],
    ["PF-G072", 500],
    ["PF-G073", 503],
  ] as const)
    it(`${id} API ${status} never reports write success or loops`, async () => {
      for (const action of ["drive", "sheets"]) {
        const f = vi
          .fn()
          .mockResolvedValueOnce(json(identity))
          .mockResolvedValueOnce(json({}, status));
        const c = await clientWith(f);
        const call =
          action === "drive"
            ? c.uploadPdf({
                name: "架空.pdf",
                bytes: new TextEncoder().encode("%PDF-fixture"),
                fileId: "fixed",
              })
            : c.readLedger("ledger");
        await expect(call).rejects.toMatchObject({ status });
        expect(f).toHaveBeenCalledTimes(2);
      }
    });
  for (const [id, size] of [
    ["PF-G076", 4194303],
    ["PF-G077", 4194304],
    ["PF-G078", 4194305],
    ["PF-G079", 8388609],
  ] as const)
    it(`${id} direct resumable chunk boundary ${size}`, async () => {
      const ranges: string[] = [];
      const lengths: number[] = [];
      const f = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("userinfo")) return json(identity);
        if (init?.method === "POST")
          return new Response("", {
            headers: {
              Location:
                "https://www.googleapis.com/upload/drive/v3/files?upload_id=fake",
            },
          });
        const range = new Headers(init?.headers).get("Content-Range")!;
        ranges.push(range);
        lengths.push((init!.body as Blob).size);
        const end = Number(/-(\d+)\//.exec(range)![1]);
        return end === size - 1
          ? json({ id: "fixed" })
          : new Response("", {
              status: 308,
              headers: { Range: `bytes=0-${end}` },
            });
      });
      const c = await clientWith(f);
      const method = c as unknown as {
        uploadResumable: (
          m: unknown,
          b: Blob,
          h: string,
          a: string,
          p: string,
        ) => Promise<unknown>;
      };
      await expect(
        method.uploadResumable(
          { id: "fixed", name: "架空.pdf", mimeType: "application/pdf" },
          new Blob([new Uint8Array(size)]),
          "hash",
          "teacher",
          "fields=id",
        ),
      ).resolves.toMatchObject({ id: "fixed" });
      expect(lengths.reduce((a, b) => a + b, 0)).toBe(size);
      expect(lengths.every((n) => n <= 4194304)).toBe(true);
      expect(ranges.map((r) => Number(/bytes (\d+)-/.exec(r)![1]))).toEqual(
        lengths.map((_, i) => i * 4194304),
      );
    });
  for (const [id, range] of [
    ["PF-G081", "bytes=0-999999999"],
    ["PF-G082", "bytes=1-10"],
    ["PF-G083", "garbage"],
    ["PF-G084", "bytes=0-0"],
  ] as const)
    it(`${id} invalid second chunk range ${range}`, async () => {
      const f = vi
        .fn()
        .mockResolvedValueOnce(json(identity))
        .mockResolvedValueOnce(
          new Response("", {
            headers: {
              Location:
                "https://www.googleapis.com/upload/drive/v3/files?upload_id=fake",
            },
          }),
        )
        .mockResolvedValueOnce(
          new Response("", {
            status: 308,
            headers: { Range: "bytes=0-4194303" },
          }),
        )
        .mockResolvedValueOnce(
          new Response("", { status: 308, headers: { Range: range } }),
        );
      const c = await clientWith(f);
      const bytes = new Uint8Array(8388609);
      bytes.set(new TextEncoder().encode("%PDF-"));
      await expect(
        c.uploadPdf({ name: "架空.pdf", bytes, fileId: "fixed" }),
      ).rejects.toMatchObject({ code: "API" });
      expect(f).toHaveBeenCalledTimes(4);
    });
  it("PF-G085 expired upload session restarts with the same planned file ID", async () => {
    const location =
      "https://www.googleapis.com/upload/drive/v3/files?upload_id=fake";
    const f = vi
      .fn()
      .mockResolvedValueOnce(json(identity))
      .mockResolvedValueOnce(
        new Response("", { headers: { Location: location } }),
      )
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(json({}, 404))
      .mockResolvedValueOnce(
        new Response("", { headers: { Location: location + "2" } }),
      )
      .mockResolvedValueOnce(
        new Response("", {
          status: 308,
          headers: { Range: "bytes=0-4194303" },
        }),
      )
      .mockResolvedValueOnce(json({ id: "fixed" }));
    const c = await clientWith(f);
    const bytes = new Uint8Array(6 * 1024 * 1024);
    bytes.set(new TextEncoder().encode("%PDF-"));
    await expect(
      c.uploadPdf({ name: "架空.pdf", bytes, fileId: "fixed" }),
    ).rejects.toThrow();
    await expect(
      c.uploadPdf({ name: "架空.pdf", bytes, fileId: "fixed" }),
    ).resolves.toMatchObject({ id: "fixed" });
    const starts = f.mock.calls.filter((call) => call[1]?.method === "POST");
    expect(starts).toHaveLength(2);
    expect(
      starts.every((call) => JSON.parse(String(call[1]?.body)).id === "fixed"),
    ).toBe(true);
  });
  for (const [id, location] of [
    ["PF-G087", "https://example.test/upload/drive/"],
    ["PF-G088", "http://www.googleapis.com/upload/drive/"],
    ["PF-G089", "https://www.googleapis.com.evil.test/upload/drive/"],
    ["PF-G090", "https://user:pass@www.googleapis.com/upload/drive/"],
  ] as const)
    it(`${id} invalid upload location receives no bearer or PDF`, async () => {
      const f = vi
        .fn()
        .mockResolvedValueOnce(json(identity))
        .mockResolvedValueOnce(
          new Response("", { headers: { Location: location } }),
        );
      const c = await clientWith(f);
      const bytes = new Uint8Array(6 * 1024 * 1024);
      bytes.set(new TextEncoder().encode("%PDF-"));
      await expect(
        c.uploadPdf({ name: "架空.pdf", bytes, fileId: "fixed" }),
      ).rejects.toMatchObject({ code: "API" });
      expect(f).toHaveBeenCalledTimes(2);
      expect(f.mock.calls.every((call) => call[0] !== location)).toBe(true);
    });
});
