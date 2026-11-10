import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleWorkspaceClient } from "./client";
import { GOOGLE_SCOPES } from "./auth";
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const identity = {
  sub: "teacher-1",
  name: "Teacher",
  email: "teacher@example.test",
};
const metadata = (rows = 1000, cols = 26) => ({
  spreadsheetId: "roster",
  properties: { title: "名簿" },
  sheets: [
    {
      properties: {
        sheetId: 7,
        title: "1'A",
        sheetType: "GRID",
        gridProperties: { rowCount: rows, columnCount: cols },
      },
    },
  ],
});
function authorize() {
  vi.stubGlobal("window", {
    google: {
      accounts: {
        oauth2: {
          initTokenClient: (options: { callback(value: unknown): void }) => ({
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
  });
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("read-only Sheets roster adapter (authored, execution tracked separately)", () => {
  it("requires a connected identity and requests no extra Sheets scope", async () => {
    const fetcher = vi.fn();
    const client = new GoogleWorkspaceClient({
      clientId: "test.apps.googleusercontent.com",
      fetch: fetcher,
    });
    await expect(client.readRosterSpreadsheet("roster")).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(GOOGLE_SCOPES).toContain(
      "https://www.googleapis.com/auth/drive.file",
    );
    expect(
      GOOGLE_SCOPES.some((scope) => scope.includes("/auth/spreadsheets")),
    ).toBe(false);
  });
  it("escapes sheet titles, reads formatted IDs, and performs only GETs", async () => {
    authorize();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(identity))
      .mockResolvedValueOnce(json(metadata()))
      .mockResolvedValueOnce(
        json({
          values: [
            ["出席番号", "氏名", "生徒ID"],
            ["1", "架空", "001234567890123456"],
          ],
        }),
      );
    const client = new GoogleWorkspaceClient({
      clientId: "test.apps.googleusercontent.com",
      fetch: fetcher,
    });
    await client.connect();
    const result = await client.readRosterSheet("roster", 7);
    expect(result.values[1][2]).toBe("001234567890123456");
    const request = new URL(fetcher.mock.calls[2][0]);
    expect(decodeURIComponent(request.pathname)).toContain("'1''A'!A1:Z1000");
    expect(request.searchParams.get("valueRenderOption")).toBe(
      "FORMATTED_VALUE",
    );
    expect(
      fetcher.mock.calls.every(
        (call) => !call[1]?.method || call[1].method === "GET",
      ),
    ).toBe(true);
  });
  it("rejects a too-large grid before fetching cells and never silently truncates", async () => {
    authorize();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(identity))
      .mockResolvedValueOnce(json(metadata(2001)));
    const client = new GoogleWorkspaceClient({
      clientId: "test.apps.googleusercontent.com",
      fetch: fetcher,
    });
    await client.connect();
    await expect(client.readRosterSheet("roster", 7)).rejects.toThrow(/2000/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("stops on missing selected sheet or denied individual permission", async () => {
    authorize();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(identity))
      .mockResolvedValueOnce(json(metadata()))
      .mockResolvedValueOnce(json({ error: "denied" }, 403));
    const client = new GoogleWorkspaceClient({
      clientId: "test.apps.googleusercontent.com",
      fetch: fetcher,
    });
    await client.connect();
    await expect(client.readRosterSheet("roster", 99)).rejects.toThrow(
      /削除・変更/,
    );
    await expect(
      client.readRosterSpreadsheet("not-granted"),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("PF Sheets roster exact adapter execution", () => {
  async function read(
    meta: ReturnType<typeof metadata>,
    values: unknown,
    id = 7,
  ) {
    authorize();
    const f = vi
      .fn()
      .mockResolvedValueOnce(json(identity))
      .mockResolvedValueOnce(json(meta))
      .mockResolvedValueOnce(json({ values }));
    const c = new GoogleWorkspaceClient({
      clientId: "test.apps.googleusercontent.com",
      fetch: f,
    });
    await c.connect();
    return { result: c.readRosterSheet("roster", id), f };
  }
  it("PF-S004 quoted apostrophe and range-like tab titles request only selected grid", async () => {
    for (const title of ["1'A", "A1"]) {
      const m = metadata();
      m.sheets[0].properties.title = title;
      const { result, f } = await read(m, [
        ["番号", "氏名"],
        ["1", "架空"],
      ]);
      expect((await result).values).toHaveLength(2);
      expect(
        decodeURIComponent(new URL(f.mock.calls[2][0]).pathname),
      ).toContain(`'${title.replaceAll("'", "''")}'!A1:Z1000`);
      expect(
        new URL(f.mock.calls[2][0]).searchParams.get("valueRenderOption"),
      ).toBe("FORMATTED_VALUE");
    }
  });
  it("PF-S011 grid physical row limit includes empty rows 2000 and 2001", async () => {
    for (const n of [2000, 2001]) {
      const { result, f } = await read(metadata(n), [
        ["番号", "氏名"],
        ["1", "架空"],
      ]);
      if (n === 2000) {
        await expect(result).resolves.toMatchObject({ sheetTitle: "1'A" });
        expect(f).toHaveBeenCalledTimes(3);
        expect(decodeURIComponent(f.mock.calls[2][0])).toContain("Z2000");
      } else {
        await expect(result).rejects.toThrow("2000");
        expect(f).toHaveBeenCalledTimes(2);
      }
    }
  });
  it("PF-S012 grid physical column limit requests AZ26 and refuses BA", async () => {
    for (const n of [52, 53]) {
      const { result, f } = await read(metadata(26, n), [
        ["番号", "氏名"],
        ["1", "架空"],
      ]);
      if (n === 52) {
        await expect(result).resolves.toBeDefined();
        expect(decodeURIComponent(f.mock.calls[2][0])).toContain("AZ26");
      } else {
        await expect(result).rejects.toThrow("52");
        expect(f).toHaveBeenCalledTimes(2);
      }
    }
  });
  it("PF-S013 exact 1000 per-cell and 1000000 total characters without truncation", async () => {
    for (const [values, valid] of [
      [["x".repeat(1000)], ["1"]],
      [["x".repeat(1001)], ["1"]],
    ].map((v, i) => [v, i === 0] as const)) {
      const { result } = await read(metadata(), values);
      if (valid) {
        const r = await result;
        expect(r.values[0][0]).toHaveLength(1000);
      } else await expect(result).rejects.toThrow("文字数");
    }
    for (const n of [1000000, 1000001]) {
      const values = Array.from({ length: 100 }, () =>
        Array(10).fill("x".repeat(1000)),
      );
      if (n > 1000000) values.push(["1"]);
      const { result } = await read(metadata(), values);
      if (n === 1000000) {
        const r = await result;
        expect(r.values.flat().join("").length).toBe(n);
      } else await expect(result).rejects.toThrow("文字数");
    }
  });
  it("PF-S014 formatted long ID and number with leading zero retain every source digit", async () => {
    const rows = [
      ["番号", "氏名", "生徒ID"],
      ["001", "架空", "00123456789012345678901234567890"],
    ];
    const { result, f } = await read(metadata(), rows);
    expect((await result).values).toEqual(rows);
    expect(
      new URL(f.mock.calls[2][0]).searchParams.get("valueRenderOption"),
    ).toBe("FORMATTED_VALUE");
  });
  it("PF-S026 deleted tab non-GRID duplicate ID and invalid dimensions do not read cells", async () => {
    for (const kind of ["deleted", "non-grid", "duplicate", "invalid"]) {
      const m = metadata();
      if (kind === "non-grid") m.sheets[0].properties.sheetType = "OBJECT";
      if (kind === "duplicate") m.sheets.push(structuredClone(m.sheets[0]));
      if (kind === "invalid")
        m.sheets[0].properties.gridProperties.rowCount = 0;
      const { result, f } = await read(
        m,
        [
          ["番号", "氏名"],
          ["1", "架空"],
        ],
        kind === "deleted" ? 99 : 7,
      );
      await expect(result).rejects.toMatchObject({ code: "INVALID_DATA" });
      expect(f).toHaveBeenCalledTimes(2);
    }
  });
  it("PF-S027 malformed values are rejected by adapter itself", async () => {
    for (const values of [
      { cells: [] },
      [["番号"], [{ cell: "value" }]],
      [["番号"], { cells: ["bad"] }],
    ]) {
      const { result } = await read(metadata(), values);
      await expect(result).rejects.toMatchObject({ code: "INVALID_DATA" });
    }
  });
});
