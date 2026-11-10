import type {
  ScanCsvMeta,
  ScanCsvRow,
  ScanCsvStatus,
  ScanPage,
} from "./types";

/**
 * Interface with `apps/sheets-ledger/ScanImport.gs`.
 * Keep this string byte-for-byte identical to PAPERFLOW_SCAN_HEADERS.
 */
export const SCAN_CSV_HEADER =
  "scan_id,scanned_at,source_file,page,token,status,note";

/** CSV output is RFC 4180: CRLF records, quotes doubled, comma/newline quoted. */
const CRLF = "\r\n";

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Decide `ok` / `unreadable` / `duplicate` for the pages that remain after
 * exclusion, in page order. Excluded pages are neither emitted nor counted as
 * an earlier occurrence.
 */
export function buildScanCsvRows(
  pages: ScanPage[],
  meta: ScanCsvMeta,
): ScanCsvRow[] {
  const ordered = [...pages].sort((a, b) => a.sourcePage - b.sourcePage);
  const firstPageByToken = new Map<string, number>();
  const rows: ScanCsvRow[] = [];
  for (const page of ordered) {
    if (page.excluded) continue;
    const token = page.token ?? "";
    let status: ScanCsvStatus;
    let note = "";
    if (!token) {
      status = "unreadable";
      note = page.reason ?? "QRを読み取れませんでした。";
    } else {
      const first = firstPageByToken.get(token);
      if (first === undefined) {
        status = "ok";
        firstPageByToken.set(token, page.sourcePage);
      } else {
        status = "duplicate";
        note = `重複先: ${first}ページ`;
      }
    }
    rows.push({
      scanId: meta.scanId,
      scannedAt: meta.scannedAt,
      sourceFile: meta.sourceFile,
      page: page.sourcePage,
      token,
      status,
      note,
    });
  }
  return rows;
}

export function serializeScanCsv(rows: ScanCsvRow[]): string {
  const lines = [SCAN_CSV_HEADER];
  for (const row of rows) {
    lines.push(
      [
        row.scanId,
        row.scannedAt,
        row.sourceFile,
        String(row.page),
        row.token,
        row.status,
        row.note,
      ]
        .map(csvField)
        .join(","),
    );
  }
  return lines.join(CRLF) + CRLF;
}

export function createScanCsv(pages: ScanPage[], meta: ScanCsvMeta): string {
  return serializeScanCsv(buildScanCsvRows(pages, meta));
}

export interface DuplicateGroup {
  token: string;
  pages: ScanPage[];
}

/** Pages sharing the same token, in page order (groups of 2 or more). */
export function duplicateGroups(pages: ScanPage[]): DuplicateGroup[] {
  const byToken = new Map<string, ScanPage[]>();
  for (const page of [...pages].sort((a, b) => a.sourcePage - b.sourcePage)) {
    if (!page.token) continue;
    const group = byToken.get(page.token);
    if (group) group.push(page);
    else byToken.set(page.token, [page]);
  }
  return [...byToken.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([token, group]) => ({ token, pages: group }));
}

/**
 * Apply the teacher's choice of authoritative page for duplicate groups.
 * The chosen page stays; every other page carrying the same token is excluded.
 * A group without a choice keeps all pages (the first is `ok`, later ones
 * become `duplicate` at CSV time).
 */
export function applyDuplicateChoices(
  pages: ScanPage[],
  choices: Record<string, number>,
): ScanPage[] {
  return pages.map((page) => {
    const chosen = page.token ? choices[page.token] : undefined;
    if (chosen === undefined || page.sourcePage === chosen) return page;
    return { ...page, excluded: true };
  });
}
