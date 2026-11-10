import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const gsFiles = [
  "Code.gs",
  "Roster.gs",
  "SeatChart.gs",
  "Reservation.gs",
  "Issuance.gs",
  "QrCode.gs",
  "QrImage.gs",
  "ScanImport.gs",
];
const code = gsFiles
  .map((name) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8"))
  .join("\n");

type Sheet = {
  name: string;
  rows: unknown[][];
  notes: Record<string, string>;
  backgrounds: Record<string, string | null>;
  getName: () => string;
  getLastRow: () => number;
  getLastColumn: () => number;
  getMaxRows: () => number;
  getMaxColumns: () => number;
  clear: () => void;
  setColumnWidth: () => void;
  setRowHeight: () => void;
  setHiddenGridlines: () => void;
  getRange: (row: number, column: number, rows?: number, columns?: number) => Range;
};

type Range = {
  getValues: () => unknown[][];
  setValues: (values: unknown[][]) => void;
  getValue: () => unknown;
  setValue: (value: unknown) => void;
  clearContent: () => void;
  setFontWeight: () => Range;
  setFontSize: () => Range;
  setForegroundColor: () => Range;
  setBackground: (color: string | null) => Range;
  setNote: (note: string) => Range;
  setNumberFormat: (format: string) => Range;
  setHorizontalAlignment: () => Range;
  setVerticalAlignment: () => Range;
  setWrap: () => Range;
  setBorder: () => Range;
  merge: () => Range;
  breakApart: () => Range;
  getSheet: () => Sheet;
  getRow: () => number;
  getColumn: () => number;
  getNumRows: () => number;
  getNumColumns: () => number;
};

function makeSheet(name: string, rows: unknown[][] = []): Sheet {
  const sheet: Sheet = {
    name,
    rows,
    notes: {},
    backgrounds: {},
    getName: () => name,
    getLastRow: () => sheet.rows.length,
    getLastColumn: () => sheet.rows.reduce((max, row) => Math.max(max, row.length), 0),
    getMaxRows: () => Math.max(1000, sheet.rows.length),
    getMaxColumns: () => Math.max(26, sheet.rows.reduce((max, row) => Math.max(max, row.length), 0)),
    clear: () => {
      sheet.rows.length = 0;
      Object.keys(sheet.notes).forEach((key) => delete sheet.notes[key]);
      Object.keys(sheet.backgrounds).forEach((key) => delete sheet.backgrounds[key]);
    },
    setColumnWidth: () => undefined,
    setRowHeight: () => undefined,
    setHiddenGridlines: () => undefined,
    getRange: (row, column, rowCount = 1, columnCount = 1) => {
      while (sheet.rows.length < row + rowCount - 1) sheet.rows.push([]);
      const range: Range = {
        getValues: () =>
          Array.from({ length: rowCount }, (_, r) =>
            Array.from({ length: columnCount }, (_, c) => {
              const value = sheet.rows[row - 1 + r]?.[column - 1 + c];
              return value === undefined ? "" : value;
            }),
          ),
        setValues: (values) => {
          values.forEach((sourceRow, r) => {
            const target = row - 1 + r;
            while (sheet.rows.length <= target) sheet.rows.push([]);
            sourceRow.forEach((value, c) => {
              sheet.rows[target][column - 1 + c] = value;
            });
          });
        },
        getValue: () => {
          const value = sheet.rows[row - 1]?.[column - 1];
          return value === undefined ? "" : value;
        },
        setValue: (value) => {
          while (sheet.rows.length < row) sheet.rows.push([]);
          sheet.rows[row - 1][column - 1] = value;
        },
        clearContent: () => {
          for (let r = 0; r < rowCount; r += 1) {
            const target = row - 1 + r;
            if (!sheet.rows[target]) continue;
            for (let c = 0; c < columnCount; c += 1) sheet.rows[target][column - 1 + c] = "";
          }
        },
        setFontWeight: () => range,
        setFontSize: () => range,
        setForegroundColor: () => range,
        setBackground: (color) => {
          sheet.backgrounds[`${row},${column}`] = color;
          return range;
        },
        setNote: (note) => {
          sheet.notes[`${row},${column}`] = note;
          return range;
        },
        setNumberFormat: () => range,
        setHorizontalAlignment: () => range,
        setVerticalAlignment: () => range,
        setWrap: () => range,
        setBorder: () => range,
        merge: () => range,
        breakApart: () => range,
        getSheet: () => sheet,
        getRow: () => row,
        getColumn: () => column,
        getNumRows: () => rowCount,
        getNumColumns: () => columnCount,
      };
      return range;
    },
  };
  return sheet;
}

function makeParagraph(text: string) {
  let value = text;
  const paragraph: Record<string, unknown> = {
    getType: () => "PARAGRAPH",
    getText: () => value,
    copy: () => makeParagraph(value),
    setFontSize: () => paragraph,
    setForegroundColor: () => paragraph,
    setBold: () => paragraph,
    setItalic: () => paragraph,
  };
  return paragraph;
}

function makeTable(collector: { texts: string[]; imageCount: number }) {
  return {
    setAttributes: () => undefined,
    appendTableRow: () => ({
      appendTableCell: () => ({
        appendParagraph: (text: string) => {
          collector.texts.push(text);
          return makeParagraph(text);
        },
        appendImage: () => {
          collector.imageCount += 1;
          const image: Record<string, unknown> = {
            setWidth: () => image,
            setHeight: () => image,
          };
          return image;
        },
      }),
    }),
  };
}

type LedgerOptions = {
  roster?: unknown[][];
  form?: unknown[][];
  headerParagraphs?: string[];
  namedRanges?: string[];
  marginTop?: number;
  sourceName?: string;
  externalRoster?: { id: string; rows: Record<string, unknown[][]> };
};

function issueForm(options: {
  url?: string;
  title?: string;
} = {}) {
  return [
    ["項目", "値"],
    ["原稿DocのURL", options.url ?? "https://docs.google.com/document/d/source-doc-id/edit"],
    ["配布物名", options.title ?? "小テスト"],
    ["", ""],
    ["発行日時", ""],
    ["発行人数", ""],
    ["状態", ""],
    ["メモ", ""],
    ["印刷用PDF", ""],
    ["印刷用Doc", ""],
  ];
}

function ledger(options: LedgerOptions = {}) {
  const properties = new Map<string, string>();
  const propertyApi = {
    getProperty: (key: string) => properties.get(key) ?? null,
    setProperty: (key: string, value: string) => {
      properties.set(key, value);
      return propertyApi;
    },
  };
  const sheets = new Map<string, Sheet>();
  const initialSheets: Record<string, unknown[][]> = {
    名簿: options.roster ?? [
      ["出席番号", "氏名", "座席の行", "座席の列"],
      [2, "佐藤 花子", 2, 1],
      [1, "鈴木 一郎", 1, 1],
    ],
    QR発行: options.form ?? issueForm(),
  };
  Object.entries(initialSheets).forEach(([name, rows]) =>
    sheets.set(name, makeSheet(name, rows.map((row) => [...row]))),
  );

  const spreadsheet = {
    getId: () => "ledger-spreadsheet-id",
    getName: () => "2年A組 台帳",
    getSheets: () => [...sheets.values()],
    getSheetByName: (name: string) => sheets.get(name) ?? null,
    getActiveSheet: () => [...sheets.values()][0] ?? null,
    toast: () => undefined,
    insertSheet: (name: string) => {
      const sheet = makeSheet(name, []);
      sheets.set(name, sheet);
      return sheet;
    },
    deleteSheet: (sheet: Sheet) => {
      sheets.delete(sheet.getName());
    },
  };
  const externalSheets = new Map<string, Sheet>();
  if (options.externalRoster) {
    Object.entries(options.externalRoster.rows).forEach(([name, rows]) =>
      externalSheets.set(name, makeSheet(name, rows.map((row) => [...row]))),
    );
  }
  const externalSpreadsheet = options.externalRoster
    ? {
        getId: () => options.externalRoster!.id,
        getName: () => "別名簿",
        getSheets: () => [...externalSheets.values()],
        getSheetByName: (name: string) => externalSheets.get(name) ?? null,
        insertSheet: (name: string) => {
          const sheet = makeSheet(name, []);
          externalSheets.set(name, sheet);
          return sheet;
        },
      }
    : null;

  const sourceBody = {
    getPageWidth: () => 595.28,
    getPageHeight: () => 841.89,
    getMarginTop: () => options.marginTop ?? 72,
    getMarginLeft: () => 72,
    getMarginRight: () => 72,
    getMarginBottom: () => 72,
    getNumChildren: () => 1,
    getChild: () => makeParagraph("原稿本文"),
  };
  const headerParagraphs = (options.headerParagraphs ?? []).map((text) => makeParagraph(text));
  const header = headerParagraphs.length
    ? {
        getParagraphs: () => headerParagraphs,
        getText: () => headerParagraphs.map((paragraph) => paragraph.getText()).join("\n"),
      }
    : null;
  const namedRanges = (options.namedRanges ?? []).map((name) => ({ getName: () => name }));
  const tab: Record<string, unknown> = {
    getBody: () => sourceBody,
    getHeader: () => header,
    getNamedRanges: () => namedRanges,
    getFooter: () => null,
  };
  const sourceDoc = {
    getId: () => "source-doc-id",
    getName: () => options.sourceName ?? "同意書",
    getTabs: () => [{ getChildTabs: () => [], asDocumentTab: () => tab }],
  };

  const createdBodies: Array<Record<string, unknown>> = [];
  const pdfs: Array<Record<string, unknown>> = [];
  const printFiles: Array<Record<string, unknown>> = [];
  const printDocs = new Map<string, Record<string, unknown>>();
  const filesById = new Map<string, Record<string, unknown>>();
  const folders = new Map<string, Record<string, unknown>>();
  const drive = { createFolderCalls: 0, failNextPdf: false };
  let folderCount = 0;
  const blobs: Array<{ bytes: number[]; type: string; name: string }> = [];
  let printDocCount = 0;

  function makeCreatedBody() {
    let marginTop = 72;
    const children: Array<Record<string, unknown>> = [];
    const collector = { texts: [] as string[], imageCount: 0 };
    const body: Record<string, unknown> = {
      texts: collector.texts,
      collector,
      getPageWidth: () => 595.28,
      getPageHeight: () => 841.89,
      getMarginTop: () => marginTop,
      setMarginTop: (value: number) => {
        marginTop = value;
      },
      setPageWidth: () => undefined,
      setPageHeight: () => undefined,
      setMarginLeft: () => undefined,
      setMarginRight: () => undefined,
      setMarginBottom: () => undefined,
      appendParagraph: (value: string | Record<string, unknown>) => {
        const paragraph = typeof value === "string" ? makeParagraph(value) : value;
        children.push(paragraph);
        return paragraph;
      },
      appendListItem: (value: Record<string, unknown>) => {
        children.push(value);
        return value;
      },
      appendTable: () => {
        const table = makeTable(collector);
        children.push(table as Record<string, unknown>);
        return table;
      },
      appendImage: (value: Record<string, unknown>) => {
        children.push(value);
        return value;
      },
      appendHorizontalRule: () => undefined,
      appendPageBreak: () => undefined,
    };
    createdBodies.push(body);
    return body;
  }

  function makePrintFile(id: string, name = "") {
    const file: Record<string, unknown> = {
      id,
      name,
      mimeType: "application/vnd.google-apps.document",
      trashed: false,
      parents: [] as string[],
    };
    return file;
  }

  function makeOutputFolder(id: string, name: string) {
    const folder: Record<string, unknown> = {
      id,
      name,
      mimeType: "application/vnd.google-apps.folder",
      trashed: false,
    };
    folders.set(id, folder);
    return folder;
  }

  const context = {
    DocumentApp: {
      openById: (id: string) => {
        if (id === "source-doc-id") return sourceDoc;
        const existing = printDocs.get(id);
        if (!existing) throw new Error("not found");
        return existing;
      },
      create: (name: string) => {
        printDocCount += 1;
        const id = `print-doc-${printDocCount}`;
        const file = makePrintFile(id);
        file.name = name;
        printFiles.push(file);
        filesById.set(id, file);
        const doc = {
          getId: () => id,
          getName: () => name,
          getBody: () => makeCreatedBody(),
          getAs: () => ({
            getBytes: () => new TextEncoder().encode("%PDF-1.7\nprint"),
          }),
          saveAndClose: () => undefined,
        };
        printDocs.set(id, doc);
        return doc;
      },
      Attribute: { BORDER_WIDTH: "BORDER_WIDTH" },
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => spreadsheet,
      openById: (id: string) => {
        if (externalSpreadsheet && id === options.externalRoster!.id) return externalSpreadsheet;
        throw new Error("not found");
      },
    },
    PropertiesService: {
      getScriptProperties: () => propertyApi,
      getUserProperties: () => propertyApi,
    },
    Utilities: {
      getUuid: () => randomUUID(),
      base64EncodeWebSafe: (bytes: number[]) =>
        Buffer.from(bytes)
          .toString("base64")
          .replace(/\+/g, "-")
          .replace(/\//g, "_"),
      base64DecodeWebSafe: (value: string) =>
        Array.from(
          Buffer.from(
            value.replace(/-/g, "+").replace(/_/g, "/"),
            "base64",
          ),
        ),
      newBlob: (data: number[] | string, type: string, name: string) => {
        const bytes =
          typeof data === "string"
            ? Array.from(Buffer.from(data, "utf8"))
            : data;
        blobs.push({ bytes, type, name });
        return {
          bytes,
          type,
          name,
          getBytes: () => bytes,
          getDataAsString: () => Buffer.from(bytes).toString("utf8"),
        };
      },
    },
    Drive: {
      Files: {
        create: (resource: Record<string, unknown>, media?: unknown) => {
          if (media && drive.failNextPdf) {
            drive.failNextPdf = false;
            throw new Error("PDFを保存できません");
          }
          if (resource.mimeType === "application/vnd.google-apps.folder") {
            drive.createFolderCalls += 1;
            folderCount += 1;
            return makeOutputFolder(`folder-${folderCount}`, String(resource.name));
          }
          const fileId = `pdf-${pdfs.length + 1}`;
          const file = makePrintFile(fileId, String(resource.name ?? ""));
          file.blob = media;
          file.parents = [...((resource.parents as string[] | undefined) ?? [])];
          pdfs.push(file);
          filesById.set(fileId, file);
          return file;
        },
        get: (fileId: string) => {
          const file = folders.get(fileId) ?? filesById.get(fileId);
          if (!file) throw new Error("not found");
          return file;
        },
        update: (
          resource: Record<string, unknown>,
          fileId: string,
          _media?: unknown,
          options?: { addParents?: string; removeParents?: string },
        ) => {
          const file = folders.get(fileId) ?? filesById.get(fileId);
          if (!file) throw new Error("not found");
          Object.assign(file, resource);
          const parents = new Set((file.parents as string[] | undefined) ?? []);
          if (options?.addParents) parents.add(options.addParents);
          if (options?.removeParents)
            String(options.removeParents)
              .split(",")
              .forEach((parent) => parents.delete(parent));
          file.parents = [...parents];
          return file;
        },
      },
    },
  };
  const api = runInNewContext(
    `${code}\n({setupTABANELedger,issueTABANEQr,parseTABANEScanCsv,importTABANEScanCsv,parseRosterValues_,orderStudentsForIssuance_,createTABANEToken_,createTABANEQrPngBlob_,decodeQrReservationMarker_,encodeQrReservationMarker_,getQrReservationFromDocument_,getTABANELedgerSettings,saveTABANELedgerSettings,readIssuanceForm_,findRosterSheet_,detectRosterColumns_,previewTABANERosterCsv,importTABANERosterCsv,onEdit,redrawTABANESeatChart,getTABANESeatChartStatus,resolveTABANESeatInput_,seatChartLayout_,drawTABANESeatChart_,resetTABANELedgerTemplate,getOutputFolder_})`,
    context,
  ) as Record<string, (...args: any[]) => any>;
  return {
    api,
    sheets,
    spreadsheet,
    properties,
    createdBodies,
    pdfs,
    printFiles,
    folders,
    drive,
    blobs,
    sourceDoc,
  };
}

function recordOf(sheet: Sheet, rowIndex = 1) {
  const header = sheet.rows[0].map(String);
  return Object.fromEntries(header.map((name, index) => [name, sheet.rows[rowIndex][index]]));
}

function tokenFor(env: ReturnType<typeof ledger>, studentNumber: number) {
  const sheet = env.sheets.get("対応表")!;
  const header = sheet.rows[0].map(String);
  const tokenIndex = header.indexOf("token");
  const numberIndex = header.indexOf("studentNumber");
  const row = sheet.rows
    .slice(1)
    .find((candidate) => Number(candidate[numberIndex]) === studentNumber);
  return String(row![tokenIndex]);
}

function csv(fields: unknown[]) {
  return fields
    .map((field) => {
      const text = field === null || field === undefined ? "" : String(field);
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    })
    .join(",");
}

const SCAN_HEADER = "scan_id,scanned_at,source_file,page,token,status,note";

describe("TABANE ledger setup", () => {
  it("creates the tabs, keeps existing ones, and adds missing roster columns", () => {
    const env = ledger({ roster: [["出席番号", "氏名"], [1, "既存の太郎"]] });
    const result = env.api.setupTABANELedger();
    expect(result.created).toEqual(["座席表", "対応表", "発行記録", "回収記録"]);
    expect(result.kept).toEqual(["名簿", "QR発行"]);
    expect(result.addedRosterHeaders).toEqual(["生徒ID", "座席の行", "座席の列"]);
    expect([...env.sheets.keys()]).toEqual([
      "名簿",
      "QR発行",
      "座席表",
      "対応表",
      "発行記録",
      "回収記録",
    ]);
    expect(env.sheets.get("名簿")!.rows[0]).toEqual([
      "出席番号",
      "氏名",
      "生徒ID",
      "座席の行",
      "座席の列",
    ]);
    expect(env.sheets.get("名簿")!.rows[1]).toEqual([1, "既存の太郎"]);
    expect(env.sheets.get("対応表")!.rows[0]).toEqual([
      "token",
      "collectionId",
      "versionId",
      "studentId",
      "kind",
      "studentNumber",
      "studentName",
      "title",
      "jobId",
      "issuedAt",
    ]);
    expect(env.sheets.get("回収記録")!.rows[0]).toEqual([
      "token",
      "collectionId",
      "studentId",
      "studentNumber",
      "studentName",
      "pageNumber",
      "status",
      "scanId",
      "scannedAt",
      "sourceFile",
      "importedAt",
      "note",
    ]);
    expect(env.sheets.get("発行記録")!.rows[0]).toEqual([
      "jobId",
      "status",
      "title",
      "sourceDocumentId",
      "collectionId",
      "versionId",
      "studentCount",
      "doneStudents",
      "tokenCount",
      "layoutMode",
      "qrCorner",
      "bandHeightPt",
      "issuedAt",
      "updatedAt",
      "printDocumentId",
      "printDocumentUrl",
      "pdfFileId",
      "pdfUrl",
      "note",
    ]);
    expect(env.sheets.get("QR発行")!.rows[0]).toEqual(["項目", "値"]);
    expect(env.sheets.get("QR発行")!.rows[1][0]).toBe("原稿DocのURL");

    const seatSheet = env.sheets.get("座席表")!;
    expect(seatSheet.rows[0][0]).toBe("座席表");
    expect(seatSheet.rows[2].slice(0, 7)).toEqual(["席", 1, 2, 3, 4, 5, 6]);
    expect(seatSheet.rows[3].slice(0, 7)).toEqual([1, "", "", "", "", "", ""]);

    const again = env.api.setupTABANELedger();
    expect(again.created).toEqual([]);
    expect(again.kept).toEqual(["名簿", "座席表", "QR発行", "対応表", "発行記録", "回収記録"]);
    expect(again.addedRosterHeaders).toEqual([]);
    expect(env.sheets.get("名簿")!.rows[1]).toEqual([1, "既存の太郎"]);
  });

  it("rewrites an old QR form to the 2-input layout without touching other tabs", () => {
    const env = ledger({
      roster: [["出席番号", "氏名"], [1, "既存の太郎"]],
      form: [
        ["項目", "値"],
        ["原稿DocのURL", "https://docs.google.com/document/d/source-doc-id/edit"],
        ["配布物名", "旧配布物"],
        ["版", "v1"],
        ["原稿のページ数", 2],
        ["返却必要ページ", "全部"],
        ["クラス名", "2年A組"],
        ["発行日時", "2026-01-01T00:00:00Z"],
        ["発行人数", 2],
        ["状態", "完了"],
        ["メモ", "旧メモ"],
        ["印刷用PDF", "https://drive.google.com/file/d/pdf-1/view"],
        ["印刷用Doc", "https://docs.google.com/document/d/print-doc-1/edit"],
      ],
    });
    const result = env.api.setupTABANELedger();
    expect(result.kept).toContain("QR発行");
    const formRows = env.sheets.get("QR発行")!.rows;
    expect(formRows.slice(0, 10)).toEqual([
      ["項目", "値"],
      ["原稿DocのURL", "https://docs.google.com/document/d/source-doc-id/edit"],
      ["配布物名", "旧配布物"],
      ["", ""],
      ["発行日時", ""],
      ["発行人数", ""],
      ["状態", ""],
      ["メモ", ""],
      ["印刷用PDF", ""],
      ["印刷用Doc", ""],
    ]);
    expect(formRows.slice(10).every((row) => row.every((cell) => cell === "" || cell === undefined))).toBe(
      true,
    );
    // データのある他のタブは壊さない。
    expect(env.sheets.get("名簿")!.rows[1]).toEqual([1, "既存の太郎"]);
  });

  it("leaves an already new QR form and its output values alone on setup rerun", () => {
    const form = issueForm();
    form[4][1] = "2026-01-01T00:00:00Z";
    const env = ledger({ form });
    env.api.setupTABANELedger();
    expect(env.sheets.get("QR発行")!.rows[4]).toEqual(["発行日時", "2026-01-01T00:00:00Z"]);
  });
});

describe("TABANE ledger roster", () => {
  it("accepts reordered columns and full-width attendance numbers", () => {
    const { api } = ledger();
    const roster = api.parseRosterValues_([
      ["メモ", "座席の行", "氏名", "出席番号", "座席の列"],
      ["", 2, "山田 太郎", "１０", 3],
      ["", "", "", "", ""],
      ["", 1, "佐藤 花子", 2, 1],
    ]);
    expect(roster.students).toEqual([
      {
        studentId: "n010",
        number: 10,
        name: "山田 太郎",
        seat: { row: 2, col: 3 },
        className: "",
      },
      {
        studentId: "n002",
        number: 2,
        name: "佐藤 花子",
        seat: { row: 1, col: 1 },
        className: "",
      },
    ]);
    expect(() => api.parseRosterValues_([["氏名"], ["名前だけ"]])).toThrow("出席番号");
  });

  it("orders seated students first, then unseated students by attendance number", () => {
    const { api } = ledger();
    const allSeated = [
      { studentId: "n001", number: 1, name: "A", seat: { row: 2, col: 1 } },
      { studentId: "n002", number: 2, name: "B", seat: { row: 1, col: 2 } },
      { studentId: "n003", number: 3, name: "C", seat: { row: 1, col: 1 } },
    ];
    expect(api.orderStudentsForIssuance_(allSeated).map((student: any) => student.number)).toEqual([
      3, 2, 1,
    ]);

    // 混在: 座席ありを先（行→列）、座席なしを後ろ（出席番号）。
    const mixed = [
      { studentId: "n003", number: 3, name: "C", seat: { row: 1, col: 1 } },
      { studentId: "n001", number: 1, name: "A", seat: null },
      { studentId: "n004", number: 4, name: "D", seat: { row: 1, col: 2 } },
      { studentId: "n002", number: 2, name: "B", seat: null },
    ];
    expect(api.orderStudentsForIssuance_(mixed).map((student: any) => student.number)).toEqual([
      3, 4, 1, 2,
    ]);

    // 全員座席なしなら出席番号順そのもの。
    const unseated = [
      { studentId: "n003", number: 3, name: "C", seat: null },
      { studentId: "n001", number: 1, name: "A" },
      { studentId: "n002", number: 2, name: "B", seat: null },
    ];
    expect(api.orderStudentsForIssuance_(unseated).map((student: any) => student.number)).toEqual([
      1, 2, 3,
    ]);

    // 同じ行・列は出席番号で安定させる（エラーにしない）。
    const sameSeat = [
      { studentId: "n005", number: 5, name: "E", seat: { row: 2, col: 2 } },
      { studentId: "n002", number: 2, name: "B", seat: { row: 2, col: 2 } },
      { studentId: "n001", number: 1, name: "A", seat: { row: 1, col: 1 } },
    ];
    expect(api.orderStudentsForIssuance_(sameSeat).map((student: any) => student.number)).toEqual([
      1, 2, 5,
    ]);
  });

  it("reads a separate roster spreadsheet when configured", () => {
    const env = ledger({
      externalRoster: {
        id: "external-roster-id",
        rows: {
          名簿: [
            ["出席番号", "氏名"],
            [1, "別スプシの太郎"],
          ],
        },
      },
    });
    env.api.saveTABANELedgerSettings({
      rosterSpreadsheetUrl: "https://docs.google.com/spreadsheets/d/external-roster-id/edit",
    });
    expect(env.api.getTABANELedgerSettings().rosterSpreadsheetUrl).toContain("external-roster-id");
    const result = env.api.issueTABANEQr({});
    expect(result.studentCount).toBe(1);
    expect(result.tokenCount).toBe(1);
    expect(env.sheets.get("対応表")!.rows[1][6]).toBe("別スプシの太郎");
  });
});

describe("TABANE roster CSV import", () => {
  it("previews and replaces roster rows, keeping headers and reading student IDs and seats", () => {
    const env = ledger({
      roster: [["出席番号", "氏名", "座席の行", "座席の列"], [1, "既存 太郎", 1, 1]],
    });
    env.api.setupTABANELedger();
    const text = [
      "\uFEFF氏名,出席番号,生徒ID,行,列",
      csv(["山田 太郎", "１０", "s-10", 2, 3]),
      csv(["佐藤 花子", 2, "", "", ""]),
      "",
    ].join("\r\n");

    const preview = env.api.previewTABANERosterCsv(text);
    expect(preview.ok).toBe(true);
    expect(preview.count).toBe(2);
    expect(preview.seatedCount).toBe(1);
    expect(preview.studentIdCount).toBe(1);

    const result = env.api.importTABANERosterCsv({
      text,
      fileName: "roster.csv",
      confirmReplace: true,
    });
    expect(result.students).toBe(2);
    expect(result.replacedRows).toBe(1);

    const sheet = env.sheets.get("名簿")!;
    expect(sheet.rows[0]).toEqual([
      "出席番号",
      "氏名",
      "座席の行",
      "座席の列",
      "生徒ID",
    ]);
    const roster = env.api.parseRosterValues_(sheet.rows);
    expect(roster.students).toEqual([
      {
        studentId: "s-10",
        number: 10,
        name: "山田 太郎",
        seat: { row: 2, col: 3 },
        className: "",
      },
      {
        studentId: "n002",
        number: 2,
        name: "佐藤 花子",
        seat: null,
        className: "",
      },
    ]);
    expect(sheet.rows.some((row: unknown[]) => row[1] === "既存 太郎")).toBe(false);
  });

  it("stops the whole import and reports counts and examples when any row is broken", () => {
    const env = ledger({ roster: [["出席番号", "氏名"], [1, "既存 太郎"]] });
    env.api.setupTABANELedger();
    const text = [
      "出席番号,氏名,行,列",
      csv([1, "新人 A", 1, 1]),
      csv([1, "新人 B", "", ""]),
      csv(["x", "新人 C", "", ""]),
      csv([4, "", "", ""]),
      csv([5, "新人 D", 0, 1]),
    ].join("\n");
    expect(() => env.api.previewTABANERosterCsv(text)).not.toThrow();
    const preview = env.api.previewTABANERosterCsv(text);
    expect(preview.ok).toBe(false);
    expect(preview.errorCount).toBe(4);
    expect(preview.errors[0].reason).toContain("重複");
    expect(() =>
      env.api.importTABANERosterCsv({ text, confirmReplace: true }),
    ).toThrow("4件");
    expect(env.sheets.get("名簿")!.rows[1]).toEqual([1, "既存 太郎"]);
  });

  it("requires the replace confirmation", () => {
    const env = ledger();
    env.api.setupTABANELedger();
    const text = "出席番号,氏名\n1,新人 A\n";
    expect(() => env.api.importTABANERosterCsv({ text })).toThrow("確認");
    expect(env.sheets.get("名簿")!.rows[1]).toEqual([2, "佐藤 花子", 2, 1]);
  });

  it("adds missing optional columns contiguously even before setup", () => {
    const env = ledger({ roster: [["出席番号", "氏名"], [1, "既存 太郎"]] });
    const text = "出席番号,氏名,生徒ID,行,列\n2,新人 A,id-2,1,2\n";
    env.api.importTABANERosterCsv({ text, confirmReplace: true });
    const sheet = env.sheets.get("名簿")!;
    expect(sheet.rows[0]).toEqual(["出席番号", "氏名", "生徒ID", "座席の行", "座席の列"]);
    const roster = env.api.parseRosterValues_(sheet.rows);
    expect(roster.students).toEqual([
      {
        studentId: "id-2",
        number: 2,
        name: "新人 A",
        seat: { row: 1, col: 2 },
        className: "",
      },
    ]);
  });
});

describe("TABANE seat resolution", () => {
  const students = [
    { studentId: "n001", number: 1, name: "田中 大希" },
    { studentId: "n002", number: 2, name: "田中 花子" },
    { studentId: "n003", number: 3, name: "佐藤 一郎" },
  ];

  it("matches an exact number, including full-width digits and display text", () => {
    const env = ledger();
    expect(env.api.resolveTABANESeatInput_("３", students)).toMatchObject({
      status: "matched",
      by: "number",
    });
    expect(env.api.resolveTABANESeatInput_("3", students).student.number).toBe(3);
    expect(env.api.resolveTABANESeatInput_("2 田中 花子", students).student.number).toBe(2);
  });

  it("matches a unique name prefix and reports ambiguous or missing names", () => {
    const env = ledger();
    expect(env.api.resolveTABANESeatInput_("佐藤", students).student.number).toBe(3);
    const ambiguous = env.api.resolveTABANESeatInput_("田中", students);
    expect(ambiguous.status).toBe("ambiguous");
    expect(ambiguous.candidates).toHaveLength(2);
    expect(env.api.resolveTABANESeatInput_("存在しない", students).status).toBe("none");
    expect(env.api.resolveTABANESeatInput_("", students).status).toBe("none");
  });
});

function seatRoster() {
  return [
    ["出席番号", "氏名", "座席の行", "座席の列"],
    [1, "田中 大希", "", ""],
    [2, "田中 花子", "", ""],
    [3, "佐藤 一郎", "", ""],
  ];
}

function enterSeatCell(env: ReturnType<typeof ledger>, row: number, column: number, value: string) {
  const sheet = env.sheets.get("座席表")!;
  sheet.getRange(row, column).setValue(value);
  env.api.onEdit({ source: env.spreadsheet, range: sheet.getRange(row, column) });
}

describe("TABANE seat chart editing", () => {
  it("records a seat from a number, moves it by name, and clears it", () => {
    const env = ledger({ roster: seatRoster() });
    env.api.setupTABANELedger();
    const roster = env.sheets.get("名簿")!;
    const seat = env.sheets.get("座席表")!;

    enterSeatCell(env, 4, 2, "３");
    expect(roster.rows[3][2]).toBe(1);
    expect(roster.rows[3][3]).toBe(1);
    expect(seat.rows[3][1]).toBe("3 佐藤 一郎");

    enterSeatCell(env, 4, 3, "佐藤");
    expect(roster.rows[3][2]).toBe(1);
    expect(roster.rows[3][3]).toBe(2);
    expect(seat.rows[3][2]).toBe("3 佐藤 一郎");
    expect(seat.rows[3][1]).toBe("");

    enterSeatCell(env, 4, 3, "");
    expect(roster.rows[3][2]).toBe("");
    expect(roster.rows[3][3]).toBe("");
    expect(seat.rows[3][2]).toBe("");
  });

  it("marks ambiguous and missing inputs without recording a seat", () => {
    const env = ledger({ roster: seatRoster() });
    env.api.setupTABANELedger();
    const roster = env.sheets.get("名簿")!;
    const seat = env.sheets.get("座席表")!;

    enterSeatCell(env, 4, 2, "田中");
    expect(roster.rows[1][2]).toBe("");
    expect(roster.rows[2][2]).toBe("");
    expect(seat.rows[3][1]).toBe("田中");
    expect(seat.notes["4,2"]).toContain("候補が2人");

    enterSeatCell(env, 4, 3, "存在しない");
    expect(seat.notes["4,3"]).toContain("該当する生徒");
  });

  it("detects the same student in two cells and does not record", () => {
    const env = ledger({ roster: seatRoster() });
    env.api.setupTABANELedger();
    const roster = env.sheets.get("名簿")!;
    const seat = env.sheets.get("座席表")!;

    // 名簿に座席がないのに、表示だけが別セルに残っている状態を作る。
    seat.getRange(5, 2).setValue("1 田中 大希");
    enterSeatCell(env, 4, 2, "1");

    expect(roster.rows[1][2]).toBe("");
    expect(seat.notes["4,2"]).toContain("複数");
    expect(seat.notes["5,2"]).toContain("複数");
  });

  it("reflects a direct roster edit into the seat chart", () => {
    const env = ledger({ roster: seatRoster() });
    env.api.setupTABANELedger();
    const roster = env.sheets.get("名簿")!;
    const seat = env.sheets.get("座席表")!;

    roster.getRange(2, 3).setValue(2);
    roster.getRange(2, 4).setValue(2);
    env.api.onEdit({ source: env.spreadsheet, range: roster.getRange(2, 3) });

    expect(seat.rows[4][2]).toBe("1 田中 大希");
  });

  it("keeps a combined 座席 column in sync when seats move or clear", () => {
    const env = ledger({
      roster: [["出席番号", "氏名", "座席"], [1, "田中 大希", ""]],
    });
    env.api.setupTABANELedger();
    const roster = env.sheets.get("名簿")!;

    enterSeatCell(env, 4, 2, "1");
    expect(roster.rows[1][2]).toBe("1行1列");
    expect(roster.rows[1][4]).toBe(1);
    expect(roster.rows[1][5]).toBe(1);

    enterSeatCell(env, 4, 2, "");
    expect(roster.rows[1][2]).toBe("");
    expect(roster.rows[1][4]).toBe("");
    expect(roster.rows[1][5]).toBe("");
  });

  it("reports students outside a resized grid instead of dropping them silently", () => {
    const env = ledger({
      roster: [["出席番号", "氏名", "座席の行", "座席の列"], [1, "A", 5, 5]],
    });
    env.api.setupTABANELedger();
    const saved = env.api.saveTABANELedgerSettings({ seatGridRows: 2, seatGridCols: 2 });
    expect(saved.seatGridRows).toBe(2);
    expect(saved.seatGridCols).toBe(2);

    const status = env.api.getTABANESeatChartStatus();
    expect(status.outside).toEqual(["1 A"]);
    const redraw = env.api.redrawTABANESeatChart();
    expect(redraw.outside).toHaveLength(1);
    expect(String(env.sheets.get("座席表")!.rows[1][0])).toContain("グリッド外");
  });
});

describe("TABANE roster student IDs", () => {
  it("uses the 生徒ID column for the token ledger when present", () => {
    const env = ledger({
      roster: [
        ["出席番号", "氏名", "生徒ID"],
        [1, "田中 大希", "taro-1"],
        [2, "田中 花子", ""],
      ],
      form: issueForm(),
    });
    const result = env.api.issueTABANEQr({});
    expect(result.studentCount).toBe(2);
    const tokenSheet = env.sheets.get("対応表")!;
    const header = tokenSheet.rows[0].map(String);
    const idIndex = header.indexOf("studentId");
    expect(tokenSheet.rows.slice(1).map((row) => row[idIndex])).toEqual(["taro-1", "n002"]);
  });
});

describe("TABANE ledger reservation detection", () => {
  it("decodes markers and reads them from a copied header", () => {
    const env = ledger({
      headerParagraphs: ["既存のヘッダー", "ここにQRコードが入ります PFQR1_bl_120_72"],
      marginTop: 192,
    });
    expect(env.api.decodeQrReservationMarker_("PFQR1_bl_120_72")).toMatchObject({
      corner: "bottom-left",
      bandHeightPt: 120,
      originalTopMarginPt: 72,
    });
    expect(env.api.decodeQrReservationMarker_("PFQR1_xx_120_72")).toBeNull();
    expect(env.api.getQrReservationFromDocument_(env.sourceDoc)).toMatchObject({
      corner: "bottom-left",
      bandHeightPt: 120,
      originalTopMarginPt: 72,
      currentTopMarginPt: 192,
      guideFound: true,
      namedRangeFound: false,
    });
  });

  it("reads the reservation from a named range when the header is gone", () => {
    const env = ledger({ namedRanges: ["PFQR1_tr_96_72"] });
    expect(env.api.getQrReservationFromDocument_(env.sourceDoc)).toMatchObject({
      corner: "top-right",
      bandHeightPt: 96,
      originalTopMarginPt: 72,
      label: "",
      guideFound: false,
      namedRangeFound: true,
    });
  });

  it("decodes the labeled marker and keeps compatibility with the old three-segment format", () => {
    const env = ledger();
    const labeled = env.api.encodeQrReservationMarker_(
      "top-right",
      96,
      72,
      "文化祭 ポスター",
    );
    expect(labeled).toMatch(/^PFQR1_tr_96_72_[A-Za-z0-9_-]+$/);
    expect(env.api.decodeQrReservationMarker_(labeled)).toMatchObject({
      corner: "top-right",
      bandHeightPt: 96,
      originalTopMarginPt: 72,
      label: "文化祭 ポスター",
      marker: labeled,
    });
    expect(env.api.decodeQrReservationMarker_("PFQR1_tr_96_72")).toMatchObject({
      label: "",
    });
    expect(env.api.decodeQrReservationMarker_("PFQR1_tr_96_72_")).toMatchObject({
      label: "",
    });
    expect(
      env.api.decodeQrReservationMarker_("PFQR1_xx_96_72_dGVzdA"),
    ).toBeNull();
  });

  it("reads a labeled reservation from the copied header and from the named range", () => {
    const env = ledger({
      headerParagraphs: [
        "既存のヘッダー",
        "ここにQRコードが入ります 名前「文化祭 ポスター」 PFQR1_bl_120_72_5paH5YyW56WtIOODneOCueOCv-ODvA",
      ],
      marginTop: 192,
    });
    expect(env.api.getQrReservationFromDocument_(env.sourceDoc)).toMatchObject({
      corner: "bottom-left",
      bandHeightPt: 120,
      originalTopMarginPt: 72,
      label: "文化祭 ポスター",
      guideFound: true,
      namedRangeFound: false,
    });

    const labeled = ledger().api.encodeQrReservationMarker_(
      "bottom-right",
      120,
      72,
      "名前 つき",
    );
    const fromRange = ledger({ namedRanges: [labeled] });
    expect(
      fromRange.api.getQrReservationFromDocument_(fromRange.sourceDoc),
    ).toMatchObject({
      corner: "bottom-right",
      bandHeightPt: 120,
      label: "名前 つき",
      namedRangeFound: true,
    });
  });
});

describe("TABANE ledger issuance", () => {
  it("generates unique 32-hex tokens and a PNG QR without external services", () => {
    const env = ledger();
    const seen = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      const token = env.api.createTABANEToken_();
      expect(token).toMatch(/^[0-9a-f]{32}$/);
      expect(seen.has(token)).toBe(false);
      seen.add(token);
    }
    const blob = env.api.createTABANEQrPngBlob_("a".repeat(32), { scale: 3 });
    expect(blob.type).toBe("image/png");
    expect(env.blobs[0].bytes.slice(0, 8)).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect(Buffer.from(env.blobs[0].bytes).includes(Buffer.from("IEND"))).toBe(true);
  });

  it("issues one token per student, records the new schema, and writes the fixed form outputs", () => {
    const env = ledger({
      form: issueForm(),
      headerParagraphs: ["ここにQRコードが入ります PFQR1_tr_96_72"],
      marginTop: 168,
    });
    const result = env.api.issueTABANEQr({});
    expect(result.status).toBe("完了");
    expect(result.studentCount).toBe(2);
    expect(result.tokenCount).toBe(2);
    expect(result.layoutMode).toBe("reserved-corner");
    expect(result.qrCorner).toBe("top-right");
    expect(result.bandHeightPt).toBe(96);
    expect(result.pdfUrl).toContain("https://drive.google.com/file/d/");

    const tokenSheet = env.sheets.get("対応表")!;
    expect(tokenSheet.rows).toHaveLength(3);
    const header = tokenSheet.rows[0].map(String);
    const at = (name: string) => header.indexOf(name);
    // 座席順（鈴木→佐藤）で、1生徒1行。
    expect(tokenSheet.rows.slice(1).map((row) => [row[at("studentId")], row[at("studentNumber")]])).toEqual([
      ["n001", 1],
      ["n002", 2],
    ]);
    tokenSheet.rows.slice(1).forEach((row) => {
      expect(row[at("token")]).toMatch(/^[0-9a-f]{32}$/);
      expect(row[at("kind")]).toBe("content");
      expect(row[at("title")]).toBe("小テスト");
      expect(row[at("studentName")]).toBeTruthy();
    });
    expect(header).not.toContain("pageNumber");
    expect(header).not.toContain("required");
    expect(header).not.toContain("className");

    const issueSheet = env.sheets.get("発行記録")!;
    expect(issueSheet.rows).toHaveLength(2);
    const record = recordOf(issueSheet);
    expect(record.status).toBe("完了");
    expect(record.tokenCount).toBe(2);
    expect(record.studentCount).toBe(2);
    expect(record.layoutMode).toBe("reserved-corner");
    expect(record.qrCorner).toBe("top-right");
    expect(record.bandHeightPt).toBe(96);
    expect(record.printDocumentId).toBe("print-doc-1");
    expect(record.pdfUrl).toContain("https://drive.google.com/file/");
    ["versionLabel", "className", "pageCount", "printPageEstimate"].forEach((name) => {
      expect(issueSheet.rows[0]).not.toContain(name);
      expect(record[name]).toBeUndefined();
    });

    const form = env.sheets.get("QR発行")!;
    expect(String(form.rows[4][1])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(form.rows[5][1]).toBe(2);
    expect(form.rows[6][1]).toBe("完了");
    expect(String(form.rows[8][1])).toContain("https://drive.google.com/file/");
    expect(String(form.rows[9][1])).toContain("https://docs.google.com/document/d/");

    // 予約済みなので、印刷用Docの上余白は予約前の72ptに戻す。
    expect(env.createdBodies[0].getMarginTop()).toBe(72);
    expect((env.createdBodies[0] as any).collector.imageCount).toBe(2);
    expect((env.createdBodies[0] as any).texts).toEqual([
      "1番　鈴木 一郎",
      "小テスト",
      "2番　佐藤 花子",
      "小テスト",
    ]);
    expect(env.pdfs).toHaveLength(1);
    expect(String(env.pdfs[0].name)).toContain("小テスト 印刷用 ");
    expect(String(env.pdfs[0].name)).not.toContain("v1");
    expect(String(env.printFiles[0].name)).toContain("小テスト 印刷用 ");
    expect(String(env.printFiles[0].name)).not.toContain("v1");
  });

  it("reads the two inputs and validates the required URL and title", () => {
    const missingUrl = ledger({ form: issueForm({ url: "" }) });
    expect(() => missingUrl.api.issueTABANEQr({})).toThrow("原稿DocのURL");

    const missingTitle = ledger({ form: issueForm({ title: "" }) });
    expect(() => missingTitle.api.issueTABANEQr({})).toThrow("配布物名");

    const env = ledger({ form: issueForm({ title: "  確認テスト  " }) });
    const form = env.api.readIssuanceForm_(env.spreadsheet);
    expect(form.sourceDocumentUrl).toContain("source-doc-id");
    expect(form.title).toBe("確認テスト");
    expect(form.versionLabel).toBeUndefined();
    expect(form.pageCount).toBeUndefined();
    expect(form.className).toBeUndefined();
  });

  it("migrates an old QR form layout on issuance instead of writing outputs beside wrong labels", () => {
    const env = ledger({
      form: [
        ["項目", "値"],
        ["原稿DocのURL", "https://docs.google.com/document/d/source-doc-id/edit"],
        ["配布物名", "旧配布物"],
        ["版", "v1"],
        ["原稿のページ数", 2],
        ["返却必要ページ", "全部"],
        ["クラス名", "2年A組"],
        ["発行日時", ""],
        ["発行人数", ""],
        ["状態", ""],
        ["メモ", ""],
        ["印刷用PDF", ""],
        ["印刷用Doc", ""],
      ],
    });
    const result = env.api.issueTABANEQr({});
    expect(result.title).toBe("旧配布物");
    expect(result.tokenCount).toBe(2);
    const form = env.sheets.get("QR発行")!;
    expect(form.rows.slice(0, 10).map((row) => row[0])).toEqual([
      "項目",
      "原稿DocのURL",
      "配布物名",
      "",
      "発行日時",
      "発行人数",
      "状態",
      "メモ",
      "印刷用PDF",
      "印刷用Doc",
    ]);
    expect(String(form.rows[4][1])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(form.rows[6][1]).toBe("完了");
  });

  it("falls back to the management band when the original has no reservation", () => {
    const env = ledger({
      form: issueForm(),
      headerParagraphs: [],
    });
    const result = env.api.issueTABANEQr({});
    expect(result.layoutMode).toBe("management-band");
    expect(result.tokenCount).toBe(2);
    expect(recordOf(env.sheets.get("発行記録")!).layoutMode).toBe("management-band");
  });

  it("resumes the same job without duplicating tokens", () => {
    const env = ledger({
      form: issueForm(),
      headerParagraphs: ["ここにQRコードが入ります PFQR1_tr_96_72"],
      marginTop: 168,
    });
    const first = env.api.issueTABANEQr({});
    const issueSheet = env.sheets.get("発行記録")!;
    const statusColumn = issueSheet.rows[0].indexOf("status");
    issueSheet.rows[1][statusColumn] = "途中";

    const resumed = env.api.issueTABANEQr({});
    expect(resumed.jobId).toBe(first.jobId);
    expect(resumed.status).toBe("完了");
    expect(resumed.resumedTokenCount).toBe(2);
    expect(resumed.tokenCount).toBe(2);
    expect(env.sheets.get("対応表")!.rows).toHaveLength(3);
    expect(issueSheet.rows).toHaveLength(2);
    expect(recordOf(issueSheet).status).toBe("完了");
  });

  it("resumes a job whose PDF save failed without recreating tokens or the print document", () => {
    const env = ledger({
      form: issueForm(),
      headerParagraphs: ["ここにQRコードが入ります PFQR1_tr_96_72"],
      marginTop: 168,
    });
    env.drive.failNextPdf = true;
    expect(() => env.api.issueTABANEQr({})).toThrow("PDFの保存に失敗");

    const issueSheet = env.sheets.get("発行記録")!;
    expect(recordOf(issueSheet).status).toBe("途中");
    expect(recordOf(issueSheet).printDocumentId).toBe("print-doc-1");
    expect(recordOf(issueSheet).pdfFileId).toBe("");
    expect(env.sheets.get("対応表")!.rows).toHaveLength(3);
    expect(env.printFiles).toHaveLength(1);
    expect(env.pdfs).toHaveLength(0);
    expect(env.drive.createFolderCalls).toBe(1);

    const resumed = env.api.issueTABANEQr({});
    expect(resumed.jobId).toBe(recordOf(issueSheet).jobId);
    expect(resumed.status).toBe("完了");
    expect(resumed.tokenCount).toBe(2);
    expect(resumed.resumedTokenCount).toBe(2);
    // 印刷用Docは作り直さず、既存のDocからPDFを保存する。
    expect(env.printFiles).toHaveLength(1);
    expect(env.pdfs).toHaveLength(1);
    expect(recordOf(issueSheet).printDocumentId).toBe("print-doc-1");
    expect(recordOf(issueSheet).status).toBe("完了");
    expect(env.drive.createFolderCalls).toBe(1);
  });

  it("resumes an unfinished job whose ledger rows still use the old page-based columns", () => {
    const env = ledger();
    const jobId = "a".repeat(32);
    const collectionId = "b".repeat(32);
    const versionId = "c".repeat(32);
    env.sheets.set(
      "発行記録",
      makeSheet("発行記録", [
        [
          "jobId", "status", "title", "versionLabel", "className", "sourceDocumentId",
          "collectionId", "versionId", "pageCount", "studentCount", "doneStudents",
          "tokenCount", "layoutMode", "qrCorner", "bandHeightPt", "issuedAt", "updatedAt",
          "printDocumentId", "printDocumentUrl", "pdfFileId", "pdfUrl", "printPageEstimate", "note",
        ],
        [
          jobId, "途中", "旧配布物", "v1", "2年A組", "source-doc-id",
          collectionId, versionId, 2, 2, 2,
          4, "management-band", "top-right", 96, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z",
          "", "", "", "", 4, "旧メモ",
        ],
      ]),
    );
    const oldTokenRows = [["n001", 1], ["n001", 2], ["n002", 1], ["n002", 2]].map(
      ([studentId, pageNumber], index) => [
        `${index}`.repeat(32),
        collectionId,
        versionId,
        studentId,
        pageNumber,
        "content",
        true,
        1,
        "鈴木 一郎",
        "2年A組",
        "旧配布物",
        jobId,
        "2026-01-01T00:00:00Z",
      ],
    );
    env.sheets.set(
      "対応表",
      makeSheet("対応表", [
        [
          "token", "collectionId", "versionId", "studentId", "pageNumber", "kind", "required",
          "studentNumber", "studentName", "className", "title", "jobId", "issuedAt",
        ],
        ...oldTokenRows,
      ]),
    );

    const resumed = env.api.issueTABANEQr({});
    expect(resumed.jobId).toBe(jobId);
    expect(resumed.status).toBe("完了");
    // 旧形式のページ別トークンは、生徒ごとに先頭の1つだけを再利用する。
    expect(resumed.resumedTokenCount).toBe(2);
    expect(resumed.tokenCount).toBe(2);
    expect(env.sheets.get("対応表")!.rows).toHaveLength(5);
    expect(recordOf(env.sheets.get("発行記録")!).status).toBe("完了");
    expect(recordOf(env.sheets.get("発行記録")!).title).toBe("小テスト");
  });
});

describe("TABANE scan CSV", () => {
  it("parses reordered headers and RFC 4180 quoting with CRLF", () => {
    const env = ledger();
    const text =
      "token,status,scan_id,scanned_at,source_file,page,note\r\n" +
      'abc,ok,s1,2026-11-10T10:00:00Z,"scan,1.pdf",1,"line1\nline2"\r\n';
    const parsed = env.api.parseTABANEScanCsv(text);
    expect(parsed.rows).toEqual([
      {
        scanId: "s1",
        scannedAt: "2026-11-10T10:00:00Z",
        sourceFile: "scan,1.pdf",
        page: 1,
        token: "abc",
        status: "ok",
        note: "line1\nline2",
        rowNumber: 2,
      },
    ]);
    expect(parsed.broken).toEqual([]);
  });

  it("rejects a header that does not match the specification", () => {
    const env = ledger();
    expect(() => env.api.parseTABANEScanCsv("a,b\n1,2")).toThrow("ヘッダー");
    expect(() =>
      env.api.parseTABANEScanCsv(
        SCAN_HEADER.replace(",note", "") + "\ns1,2026-11-10T10:00:00Z,a.pdf,1,t,ok",
      ),
    ).toThrow("不足");
  });

  it("reports broken rows with counts while keeping valid rows", () => {
    const env = ledger();
    const text = [
      SCAN_HEADER,
      "s1,2026-11-10T10:00:00Z,a.pdf,1,tok,ok,",
      "s1,2026-11-10T10:00:00Z,a.pdf,not-a-page,tok,ok,",
      "s1,not-a-date,a.pdf,2,tok,ok,",
      "s1,2026-11-10T10:00:00Z,a.pdf,3,,bad,",
      "s1,2026-11-10T10:00:00Z,a.pdf,4,,ok,",
      "s1,2026-11-10T10:00:00Z,a.pdf,5",
      "",
    ].join("\n");
    const parsed = env.api.parseTABANEScanCsv(text);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.broken).toHaveLength(5);
    expect(parsed.broken.map((row: any) => row.reason).join(" / ")).toContain("page");
  });
});

describe("TABANE scan import", () => {
  it("matches tokens, imports cumulatively, is re-import safe, and builds submission tabs", () => {
    const env = ledger({
      form: issueForm(),
      headerParagraphs: ["ここにQRコードが入ります PFQR1_tr_96_72"],
      marginTop: 168,
      roster: [
        ["出席番号", "氏名", "座席の行", "座席の列"],
        [1, "架空 太郎", 1, 1],
        [2, "架空 花子", 1, 2],
        [3, "架空 次郎", 2, 1],
      ],
    });
    env.api.issueTABANEQr({});
    const token1 = tokenFor(env, 1);
    const token2 = tokenFor(env, 2);
    const token3 = tokenFor(env, 3);
    const unknownToken = "f".repeat(32);

    const firstCsv = [
      SCAN_HEADER,
      csv(["s1", "2026-11-10T10:00:00Z", "scan-1.pdf", 1, token1, "ok", ""]),
      csv(["s1", "2026-11-10T10:00:00Z", "scan-1.pdf", 2, token2, "ok", ""]),
      csv(["s1", "2026-11-10T10:00:00Z", "scan-1.pdf", 3, token1, "duplicate", "同一スキャン内の重複"]),
      csv(["s1", "2026-11-10T10:00:00Z", "scan-1.pdf", 9, "", "unreadable", "QRが切れている"]),
      csv(["s1", "2026-11-10T10:00:00Z", "scan-1.pdf", 10, unknownToken, "ok", ""]),
      csv(["s1", "2026-11-10T10:00:00Z", "scan-1.pdf", 11, "", "bad", ""]),
      "",
    ].join("\r\n");

    const result = env.api.importTABANEScanCsv({ fileName: "scan-1.csv", text: firstCsv });
    expect(result.okRows).toBe(2);
    expect(result.duplicateRows).toBe(1);
    expect(result.unreadableRows).toBe(1);
    expect(result.unknownTokens).toBe(1);
    expect(result.brokenRows).toBe(1);
    expect(result.reviewCount).toBe(3);
    expect(result.tabs).toHaveLength(2);

    const receipts = env.sheets.get("回収記録")!;
    expect(receipts.rows).toHaveLength(6);
    const receiptHeader = receipts.rows[0].map(String);
    const receiptAt = (name: string) => receiptHeader.indexOf(name);
    expect(receipts.rows.slice(1).map((row) => row[receiptAt("status")])).toEqual([
      "ok",
      "ok",
      "duplicate",
      "unreadable",
      "unknown",
    ]);
    // 回収記録のページは、対応表ではなくCSV行の page（スキャン上のページ）。
    expect(receipts.rows.slice(1).map((row) => row[receiptAt("pageNumber")])).toEqual([
      1,
      2,
      3,
      9,
      10,
    ]);
    expect(receiptHeader).not.toContain("required");

    const collectionTabName = result.tabs.find((name: string) => name.includes("小テスト"));
    const collectionTab = env.sheets.get(collectionTabName)!;
    expect(collectionTab.rows[0].slice(0, 2)).toEqual(["配布物", "小テスト"]);
    expect(collectionTab.rows[1][0]).toBe("取り込み日時");
    const headerRowIndex = collectionTab.rows.findIndex((row) => row[0] === "出席番号");
    expect(collectionTab.rows[headerRowIndex].slice(0, 3)).toEqual(["出席番号", "氏名", "まとめ"]);
    const students = collectionTab.rows
      .slice(headerRowIndex + 1)
      .filter((row) => typeof row[0] === "number");
    expect(students).toHaveLength(3);
    expect(students[0].slice(0, 3)).toEqual([1, "架空 太郎", "提出済み"]);
    expect(students[1].slice(0, 3)).toEqual([2, "架空 花子", "提出済み"]);
    expect(students[2].slice(0, 3)).toEqual([3, "架空 次郎", "未提出"]);
    const summaryRow = collectionTab.rows.find((row) => row[0] === "集計")!;
    expect(summaryRow.slice(0, 2)).toEqual(["集計", "提出済み 2人 / 未提出 1人"]);
    expect(
      collectionTab.rows.some(
        (row) => row[1] === "重複（要確認）" && row[2] === token1 && row[3] === 3,
      ),
    ).toBe(true);
    const flatTab = collectionTab.rows.map((row) => row.join("\u0000")).join("\n");
    expect(flatTab).not.toContain("一部不足");
    expect(flatTab).not.toContain("不足ページ");

    const unclassifiedName = result.tabs.find((name: string) => name.includes("未分類"));
    const unclassified = env.sheets.get(unclassifiedName)!;
    expect(unclassified.rows.some((row) => row[1] === "読み取り不可")).toBe(true);
    expect(unclassified.rows.some((row) => row[1] === "対応表にないトークン")).toBe(true);

    // 同じCSVの再取り込みでは、回収記録を増やさない。
    const again = env.api.importTABANEScanCsv({ fileName: "scan-1.csv", text: firstCsv });
    expect(again.importedRows).toBe(0);
    expect(again.alreadyImported).toBe(5);
    expect(again.reviewCount).toBe(3);
    expect(again.tabs).toHaveLength(2);
    expect(env.sheets.get("回収記録")!.rows).toHaveLength(6);

    // 未提出だった生徒のトークンを後から取り込むと、累積の回収記録から「提出済み」になる。
    const secondCsv = [
      SCAN_HEADER,
      csv(["s2", "2026-11-11T10:00:00Z", "scan-2.pdf", 5, token3, "ok", ""]),
      "",
    ].join("\n");
    const second = env.api.importTABANEScanCsv({ fileName: "scan-2.csv", text: secondCsv });
    expect(second.okRows).toBe(1);
    const secondTab = env.sheets.get(second.tabs[0])!;
    const secondHeaderRowIndex = secondTab.rows.findIndex((row) => row[0] === "出席番号");
    const secondStudents = secondTab.rows
      .slice(secondHeaderRowIndex + 1)
      .filter((row) => typeof row[0] === "number");
    expect(secondStudents[0].slice(0, 3)).toEqual([1, "架空 太郎", "提出済み"]);
    expect(secondStudents[1].slice(0, 3)).toEqual([2, "架空 花子", "提出済み"]);
    expect(secondStudents[2].slice(0, 3)).toEqual([3, "架空 次郎", "提出済み"]);
    expect(secondTab.rows.find((row) => row[0] === "集計")!.slice(0, 2)).toEqual([
      "集計",
      "提出済み 3人 / 未提出 0人",
    ]);
    const lastReceipt = env.sheets.get("回収記録")!.rows.slice(-1)[0];
    expect(lastReceipt[receiptAt("token")]).toBe(token3);
    expect(lastReceipt[receiptAt("pageNumber")]).toBe(5);
  });

  it("creates an unclassified tab when no token matches the fixture", () => {
    const env = ledger();
    env.api.setupTABANELedger();
    const text = [
      SCAN_HEADER,
      csv(["s9", "2026-11-10T10:00:00Z", "scan.pdf", 1, "", "unreadable", "読めない"]),
      "",
    ].join("\n");
    const result = env.api.importTABANEScanCsv({ fileName: "scan.pdf", text });
    expect(result.reviewCount).toBe(1);
    expect(result.tabs[0]).toContain("未分類");
    expect(env.sheets.get(result.tabs[0])!.rows.some((row) => row[1] === "読み取り不可")).toBe(
      true,
    );
  });

  it("builds a submission tab from old page-based tokens without dropping students", () => {
    const env = ledger();
    env.api.setupTABANELedger();
    const collectionId = "b".repeat(32);
    env.sheets.set(
      "対応表",
      makeSheet("対応表", [
        [
          "token", "collectionId", "versionId", "studentId", "pageNumber", "kind", "required",
          "studentNumber", "studentName", "className", "title", "jobId", "issuedAt",
        ],
        ["1".repeat(32), collectionId, "v", "n001", 1, "content", true, 1, "旧 太郎", "2年A組", "旧配布物", "j", "2026-01-01"],
        ["2".repeat(32), collectionId, "v", "n001", 2, "content", true, 1, "旧 太郎", "2年A組", "旧配布物", "j", "2026-01-01"],
        ["3".repeat(32), collectionId, "v", "n002", 1, "content", true, 2, "旧 花子", "2年A組", "旧配布物", "j", "2026-01-01"],
      ]),
    );
    env.sheets.set(
      "回収記録",
      makeSheet("回収記録", [
        [
          "token", "collectionId", "studentId", "studentNumber", "studentName", "pageNumber",
          "status", "scanId", "scannedAt", "sourceFile", "importedAt", "note",
        ],
        // 1人に複数トークンがある旧データ。2ページ目のトークンだけが回収済み。
        ["2".repeat(32), collectionId, "n001", 1, "旧 太郎", 2, "ok", "s0", "2026-01-01T00:00:00Z", "old.pdf", "2026-01-01T00:00:00Z", ""],
      ]),
    );

    const text = [
      SCAN_HEADER,
      csv(["s1", "2026-11-10T10:00:00Z", "scan.pdf", 1, "3".repeat(32), "ok", ""]),
      "",
    ].join("\n");
    const result = env.api.importTABANEScanCsv({ fileName: "scan.pdf", text });
    const tab = env.sheets.get(result.tabs[0])!;
    const headerRowIndex = tab.rows.findIndex((row) => row[0] === "出席番号");
    const students = tab.rows.slice(headerRowIndex + 1).filter((row) => typeof row[0] === "number");
    expect(students.map((row) => row.slice(0, 3))).toEqual([
      [1, "旧 太郎", "提出済み"],
      [2, "旧 花子", "提出済み"],
    ]);
    expect(tab.rows.find((row) => row[0] === "集計")!.slice(0, 2)).toEqual([
      "集計",
      "提出済み 2人 / 未提出 0人",
    ]);
  });

  it("rejects empty input", () => {
    const env = ledger();
    expect(() => env.api.importTABANEScanCsv({ text: "" })).toThrow("CSV");
  });
});

describe("TABANE template reset", () => {
  it("clears data rows, deletes submission tabs, and resets only development settings", () => {
    const env = ledger();
    env.api.setupTABANELedger();

    const roster = env.sheets.get("名簿")!;
    const rosterHeader = [...roster.rows[0]];
    roster.rows.push([3, "高橋 次郎", "", "", ""]);

    const tokens = env.sheets.get("対応表")!;
    tokens.rows.push([
      "a".repeat(32),
      "collection-1",
      "version-1",
      "n003",
      "content",
      3,
      "高橋 次郎",
      "小テスト",
      "job-1",
      "2026-11-10T00:00:00Z",
    ]);

    const issues = env.sheets.get("発行記録")!;
    issues.rows.push(["job-1", "完了"]);
    const receipts = env.sheets.get("回収記録")!;
    receipts.rows.push([
      "a".repeat(32),
      "collection-1",
      "n003",
      3,
      "高橋 次郎",
      1,
      "ok",
      "scan-1",
      "2026-11-10T00:00:00Z",
      "scan.pdf",
      "2026-11-10T00:00:00Z",
      "",
    ]);

    const form = env.sheets.get("QR発行")!;
    form.rows[1][1] = "https://docs.google.com/document/d/source-doc-id/edit";
    form.rows[4][1] = "2026-11-10T00:00:00Z";
    form.rows[8][1] = "https://drive.google.com/file/d/pdf-1/view";

    env.api.saveTABANELedgerSettings({
      rosterSpreadsheetUrl:
        "https://docs.google.com/spreadsheets/d/abcDEF1234567890_-XYZ/edit",
      rosterSheetName: "開発名簿",
      qrCorner: "bottom-right",
      qrBandHeightPt: 120,
      outputFolderName: "検証出力",
      seatGridRows: 5,
      seatGridCols: 4,
    });
    env.sheets.set(
      "提出一覧_小テスト_20260101-1200",
      makeSheet("提出一覧_小テスト_20260101-1200", [["配布物名"]]),
    );
    env.sheets.set(
      "提出一覧_未分類_20260101-1201",
      makeSheet("提出一覧_未分類_20260101-1201", [["要確認"]]),
    );
    env.sheets.set("メモ", makeSheet("メモ", [["残すタブ"]]));

    const result = env.api.resetTABANELedgerTemplate();

    expect(result.deleted).toEqual([
      "提出一覧_小テスト_20260101-1200",
      "提出一覧_未分類_20260101-1201",
    ]);
    expect(env.sheets.has("提出一覧_小テスト_20260101-1200")).toBe(false);
    expect(env.sheets.has("提出一覧_未分類_20260101-1201")).toBe(false);
    expect(env.sheets.get("メモ")!.rows[0]).toEqual(["残すタブ"]);

    // 見出し行は残し、データ行だけが空になる。
    expect(roster.rows[0]).toEqual(rosterHeader);
    expect(roster.rows.slice(1).every((row) => row.every((cell) => cell === "" || cell === undefined))).toBe(
      true,
    );
    expect(tokens.rows[0].slice(0, 3)).toEqual(["token", "collectionId", "versionId"]);
    expect(tokens.rows.slice(1).every((row) => row.every((cell) => cell === "" || cell === undefined))).toBe(
      true,
    );
    expect(issues.rows[0][0]).toBe("jobId");
    expect(issues.rows.slice(1).every((row) => row.every((cell) => cell === "" || cell === undefined))).toBe(
      true,
    );
    expect(receipts.rows[0][0]).toBe("token");
    expect(receipts.rows.slice(1).every((row) => row.every((cell) => cell === "" || cell === undefined))).toBe(
      true,
    );

    // QR発行はA列の項目名を残し、B列の値だけを空にする（新レイアウトのB2:B10）。
    expect(form.rows[0]).toEqual(["項目", "値"]);
    expect(form.rows[1][0]).toBe("原稿DocのURL");
    expect(form.rows[1][1]).toBe("");
    expect(form.rows[2][0]).toBe("配布物名");
    expect(form.rows[2][1]).toBe("");
    expect(form.rows[3]).toEqual(["", ""]);
    expect(form.rows[4][0]).toBe("発行日時");
    expect(form.rows[4][1]).toBe("");
    expect(form.rows[9][0]).toBe("印刷用Doc");
    expect(form.rows[9][1]).toBe("");
    expect(form.rows).toHaveLength(10);
    expect(result.cleared.some((item: any) => item.tab === "QR発行" && item.rows === 9)).toBe(true);

    const settings = env.api.getTABANELedgerSettings();
    expect(settings).toMatchObject({
      rosterSpreadsheetUrl: "",
      rosterSheetName: "名簿",
      qrCorner: "bottom-right",
      qrBandHeightPt: 120,
      outputFolderName: "検証出力",
      seatGridRows: 5,
      seatGridCols: 4,
    });
    expect(result.resetFields).toEqual(["名簿スプレッドシートのURL", "名簿タブ名"]);
    expect(result.keptFields).toContain("座席表の行数");
    expect(result.message).toContain("別スプレッドシートは変更していません");

    // 座席表は空の名簿から、残した5行×4列で描き直す。
    const seats = env.sheets.get("座席表")!;
    expect(seats.rows[0][0]).toBe("座席表");
    expect(seats.rows[2][0]).toBe("席");
    expect(seats.rows[2][1]).toBe(1);
    expect(seats.rows[2][4]).toBe(4);
    expect(
      seats.rows.some((row) => row.some((cell) => String(cell).includes("佐藤") || String(cell).includes("鈴木"))),
    ).toBe(false);
  });
});

describe("TABANE ledger settings", () => {
  it("stores only allowlisted settings and validates URLs and bands", () => {
    const env = ledger();
    const saved = env.api.saveTABANELedgerSettings({
      rosterSpreadsheetUrl:
        "https://docs.google.com/spreadsheets/d/abcDEF1234567890_-XYZ/edit#gid=0",
      rosterSheetName: "  ",
      qrCorner: "bottom-left",
      qrBandHeightPt: 120,
      outputFolderName: "  ",
      accessToken: "secret",
    });
    expect(saved).toMatchObject({
      rosterSpreadsheetUrl:
        "https://docs.google.com/spreadsheets/d/abcDEF1234567890_-XYZ/edit#gid=0",
      rosterSheetName: "名簿",
      qrCorner: "bottom-left",
      qrBandHeightPt: 120,
      outputFolderName: "TABANE 発行",
    });
    expect(JSON.stringify([...env.properties])).not.toContain("secret");
    expect(env.api.getTABANELedgerSettings()).toEqual(saved);

    expect(() =>
      env.api.saveTABANELedgerSettings({ rosterSpreadsheetUrl: "https://evil.example/" }),
    ).toThrow("名簿スプレッドシート");
    const defaults = env.api.saveTABANELedgerSettings({ qrCorner: "middle", qrBandHeightPt: 10 });
    expect(defaults.qrCorner).toBe("top-right");
    expect(defaults.qrBandHeightPt).toBe(96);
  });
});

describe("TABANE ledger output folder", () => {
  it("creates the folder once and reuses it by ID, even after a Drive-side rename", () => {
    const env = ledger();
    const first = env.api.getOutputFolder_();
    expect(env.drive.createFolderCalls).toBe(1);
    expect(first.name).toBe("TABANE 発行");
    const stored = env.api.getTABANELedgerSettings();
    expect(stored.outputFolderId).toBe(first.id);
    expect(stored.outputFolderCreatedName).toBe("TABANE 発行");

    const second = env.api.getOutputFolder_();
    expect(env.drive.createFolderCalls).toBe(1);
    expect(second.id).toBe(first.id);

    // Drive 上で名前を変えただけでは作り直さない（設定の名前は変えていない）。
    env.folders.get(first.id as string)!.name = "先生がDriveで改名";
    const third = env.api.getOutputFolder_();
    expect(env.drive.createFolderCalls).toBe(1);
    expect(third.id).toBe(first.id);
    expect(env.api.getTABANELedgerSettings().outputFolderId).toBe(first.id);
  });

  it("recreates the folder when the saved folder is trashed or no longer accessible", () => {
    const env = ledger();
    const first = env.api.getOutputFolder_();
    env.folders.get(first.id as string)!.trashed = true;
    const second = env.api.getOutputFolder_();
    expect(env.drive.createFolderCalls).toBe(2);
    expect(second.id).not.toBe(first.id);
    expect(env.api.getTABANELedgerSettings().outputFolderId).toBe(second.id);

    env.folders.delete(second.id as string);
    const third = env.api.getOutputFolder_();
    expect(env.drive.createFolderCalls).toBe(3);
    expect(third.id).not.toBe(second.id);
    const updated = env.api.getTABANELedgerSettings();
    expect(updated.outputFolderId).toBe(third.id);
    expect(updated.outputFolderCreatedName).toBe("TABANE 発行");
  });

  it("creates a new folder when the settings folder name changes", () => {
    const env = ledger();
    const first = env.api.getOutputFolder_();
    env.api.saveTABANELedgerSettings({ outputFolderName: "別の出力先" });
    // ダイアログは名前しか送らないので、保存時点では ID を保つ。
    expect(env.api.getTABANELedgerSettings().outputFolderId).toBe(first.id);

    const second = env.api.getOutputFolder_();
    expect(env.drive.createFolderCalls).toBe(2);
    expect(second.name).toBe("別の出力先");
    expect(second.id).not.toBe(first.id);
    const updated = env.api.getTABANELedgerSettings();
    expect(updated.outputFolderId).toBe(second.id);
    expect(updated.outputFolderCreatedName).toBe("別の出力先");
  });

  it("saves the folder ID on issuance and reuses it on the next issuance", () => {
    const env = ledger();
    env.api.issueTABANEQr({});
    expect(env.drive.createFolderCalls).toBe(1);
    expect(env.api.getTABANELedgerSettings().outputFolderId).toBe("folder-1");
    expect(env.pdfs).toHaveLength(1);

    // 完了した発行記録を消して、次の発行を作る。
    env.sheets.get("発行記録")!.rows.length = 1;
    env.api.issueTABANEQr({});
    expect(env.drive.createFolderCalls).toBe(1);
    expect(env.api.getTABANELedgerSettings().outputFolderId).toBe("folder-1");
    expect(env.pdfs).toHaveLength(2);
  });
});

describe("TABANE ledger manifest", () => {
  it("requests spreadsheets, documents, drive.file and container UI only", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("./appsscript.json", import.meta.url), "utf8"),
    );
    expect(manifest.oauthScopes).toEqual([
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/drive.file",
      "https://www.googleapis.com/auth/script.container.ui",
    ]);
    expect(manifest.addOns).toBeUndefined();
    expect(manifest.dependencies.enabledAdvancedServices).toEqual([
      { userSymbol: "Drive", serviceId: "drive", version: "v3" },
    ]);
  });
});
