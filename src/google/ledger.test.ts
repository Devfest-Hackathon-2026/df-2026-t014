import { describe, expect, it } from "vitest";
import { createInitialState } from "../domain/seed";
import type { AppState } from "../domain/types";
import { ledgerRows } from "./ledger";

const recordedAt = "2026-11-10T00:00:00.000Z";

function fixture(): AppState {
  const initial = createInitialState();
  return {
    ...initial,
    receipts: [
      {
        id: "receipt-1",
        collectionId: "collection-1",
        versionId: "version-1",
        studentId: "student-1",
        pageNumber: 2,
        token: "token-1",
        batchId: "batch-1",
        sourcePage: 3,
        recordedAt,
        method: "qr",
        actor: "teacher",
      },
    ],
    batches: [
      {
        id: "batch-1",
        hash: "hash-1",
        fileName: "回収.pdf",
        pageCount: 1,
        createdAt: recordedAt,
        collectionId: "collection-1",
        recordedAt,
        sourceDriveFileId: "drive-file-1",
        storageMode: "drive",
        pages: [
          {
            id: "page-1",
            sourcePage: 1,
            status: "matched",
            resolution: "accepted",
          },
        ],
      },
    ],
  };
}

describe("ledgerRows", () => {
  it("emits the same number of values as the header in every tab", () => {
    const rows = ledgerRows(fixture());
    for (const [tab, table] of Object.entries(rows)) {
      if (!table.length) continue;
      const width = table[0].length;
      table.forEach((row, index) =>
        expect(row, `${tab}[${index}]`).toHaveLength(width),
      );
    }
  });

  it("maps Receipts values to the matching header columns", () => {
    const rows = ledgerRows(fixture());
    const header = rows.Receipts[0].map(String);
    const receipt = rows.Receipts[1];
    expect(receipt[header.indexOf("receiptId")]).toBe("receipt-1");
    expect(receipt[header.indexOf("collectionId")]).toBe("collection-1");
    expect(receipt[header.indexOf("versionId")]).toBe("version-1");
    expect(receipt[header.indexOf("studentId")]).toBe("student-1");
    expect(receipt[header.indexOf("pageNumber")]).toBe(2);
    expect(receipt[header.indexOf("token")]).toBe("token-1");
    expect(receipt[header.indexOf("batchId")]).toBe("batch-1");
    expect(receipt[header.indexOf("sourcePage")]).toBe(3);
    expect(receipt[header.indexOf("recordedAt")]).toBe(recordedAt);
    expect(receipt[header.indexOf("method")]).toBe("qr");
    expect(receipt[header.indexOf("actor")]).toBe("teacher");
  });

  it("maps Batches values to the matching header columns", () => {
    const rows = ledgerRows(fixture());
    const header = rows.Batches[0].map(String);
    const batch = rows.Batches[1];
    expect(batch[header.indexOf("batchId")]).toBe("batch-1");
    expect(batch[header.indexOf("sourceDriveFileId")]).toBe("drive-file-1");
    expect(batch[header.indexOf("storageMode")]).toBe("drive");
    expect(typeof batch[header.indexOf("pagesJson")]).toBe("string");
  });
});
