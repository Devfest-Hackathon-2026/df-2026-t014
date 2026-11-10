import { describe, expect, it } from "vitest";
import type { ScanPage } from "./types";
import {
  SCAN_CSV_HEADER,
  applyDuplicateChoices,
  buildScanCsvRows,
  createScanCsv,
  duplicateGroups,
  serializeScanCsv,
} from "./scanCsv";

const meta = {
  scanId: "scan-1",
  scannedAt: "2026-11-10T06:30:00.000Z",
  sourceFile: "回収.pdf",
};

function page(sourcePage: number, token?: string, reason?: string): ScanPage {
  return { sourcePage, token, reason };
}

function lines(csv: string): string[] {
  return csv.split("\r\n");
}

describe("scan CSV header", () => {
  it("matches the ledger header exactly, in column order", () => {
    expect(SCAN_CSV_HEADER).toBe(
      "scan_id,scanned_at,source_file,page,token,status,note",
    );
    expect(lines(createScanCsv([], meta))[0]).toBe(SCAN_CSV_HEADER);
  });
});

describe("scan CSV status decisions", () => {
  it("marks the first occurrence ok and later occurrences duplicate, in page order", () => {
    const pages = [
      page(1, "a".repeat(32)),
      page(2),
      page(3, "a".repeat(32)),
      page(4, "b".repeat(32)),
      page(5, "a".repeat(32)),
    ];
    const rows = buildScanCsvRows(pages, meta);
    expect(rows.map((row) => [row.page, row.status])).toEqual([
      [1, "ok"],
      [2, "unreadable"],
      [3, "duplicate"],
      [4, "ok"],
      [5, "duplicate"],
    ]);
    expect(rows[2].note).toBe("重複先: 1ページ");
    expect(rows[4].note).toBe("重複先: 1ページ");
    expect(rows[0].note).toBe("");
  });

  it("keeps unreadable rows in the CSV with an empty token and a note", () => {
    const rows = buildScanCsvRows(
      [page(1), page(2, undefined, "空白の可能性があります。")],
      meta,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe("unreadable");
    expect(rows[0].token).toBe("");
    expect(rows[0].note).toBe("QRを読み取れませんでした。");
    expect(rows[1].note).toBe("空白の可能性があります。");
  });

  it("omits excluded pages and does not count them as earlier occurrences", () => {
    const pages = [
      { ...page(1, "a".repeat(32)), excluded: true },
      page(2, "a".repeat(32)),
      page(3, "a".repeat(32)),
    ];
    const rows = buildScanCsvRows(pages, meta);
    expect(rows.map((row) => [row.page, row.status])).toEqual([
      [2, "ok"],
      [3, "duplicate"],
    ]);
    expect(rows[1].note).toBe("重複先: 2ページ");
  });

  it("sorts rows by PDF page number regardless of input order", () => {
    const rows = buildScanCsvRows(
      [page(3, "c".repeat(32)), page(1, "a".repeat(32))],
      meta,
    );
    expect(rows.map((row) => row.page)).toEqual([1, 3]);
  });
});

describe("scan CSV serialization", () => {
  it("writes every column and quotes commas, quotes and newlines", () => {
    const csv = createScanCsv(
      [page(1, "a".repeat(32))],
      { ...meta, sourceFile: 'a,b "c"\n.pdf' },
    );
    expect(csv).toContain(
      'scan-1,2026-11-10T06:30:00.000Z,"a,b ""c""\n.pdf",1,',
    );
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("serializes rows in the fixed column order", () => {
    const rows = buildScanCsvRows([page(1, "f".repeat(32))], meta);
    expect(serializeScanCsv(rows).split("\r\n")[1]).toBe(
      `scan-1,2026-11-10T06:30:00.000Z,回収.pdf,1,${"f".repeat(32)},ok,`,
    );
  });
});

describe("duplicate review", () => {
  it("groups pages by token and ignores pages without a token", () => {
    const token = "d".repeat(32);
    const groups = duplicateGroups([
      page(1, token),
      page(2),
      page(3, token),
      page(4, "e".repeat(32)),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].pages.map((item) => item.sourcePage)).toEqual([1, 3]);
  });

  it("excludes the other pages when the teacher picks the authoritative page", () => {
    const token = "d".repeat(32);
    const pages = [page(1, token), page(2, token), page(3, token)];
    const effective = applyDuplicateChoices(pages, { [token]: 2 });
    const rows = buildScanCsvRows(effective, meta);
    expect(rows.map((row) => [row.page, row.status])).toEqual([[2, "ok"]]);
  });

  it("keeps duplicate rows when no authoritative page is chosen", () => {
    const token = "d".repeat(32);
    const effective = applyDuplicateChoices(
      [page(1, token), page(2, token)],
      {},
    );
    expect(buildScanCsvRows(effective, meta).map((row) => row.status)).toEqual([
      "ok",
      "duplicate",
    ]);
  });
});
