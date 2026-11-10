import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { createCollection, toCsv } from "../domain/logic";
import type { AppState } from "../domain/types";
describe("PF-G095 CSV export fixture for independent desktop Excel verification", () => {
  it("PF-G095 exports safe literal prefixes Unicode duplicates quotes and newline using production toCsv", () => {
    const names = [
      "=1+1",
      "+1+1",
      "-1+1",
      "@SUM(1,1)",
      "\t=1+1",
      "佐藤蓮",
      "佐藤蓮",
      "架空あいう𠮷😀",
      '架空"引用",欄',
      "架空\n改行",
    ];
    const students = names.map((name, i) => ({
      id: "fiction-" + (i + 1),
      name,
      number: i + 1,
      seat: null,
    }));
    const c = createCollection(
      {
        title: "G095架空CSV",
        className: "架空試験",
        pageCount: 1,
        requiredPages: [1],
        qrCorner: "top-right",
        duplex: false,
        order: "number",
        reverse: false,
      },
      students,
    );
    const state: AppState = {
      schemaVersion: 1,
      className: "架空試験",
      students,
      collections: [c],
      receipts: [],
      batches: [],
      events: [],
    };
    const csv = toCsv(state, c);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    for (const name of names.slice(0, 5)) expect(csv).toContain("'" + name);
    expect(csv).toContain('"架空""引用"",欄"');
    expect(csv).toContain('"架空\n改行"');
    mkdirSync("artifacts/test-execution/google", { recursive: true });
    writeFileSync("artifacts/test-execution/google/G095.csv", csv, "utf8");
    writeFileSync(
      "artifacts/test-execution/google/G095-expected.json",
      JSON.stringify(
        {
          fictional: true,
          generatedBy: "src/domain/logic.ts toCsv",
          encoding: "UTF-8 BOM",
          expectedHeaders: [
            "出席番号",
            "氏名",
            "回収状態",
            "必要ページ数",
            "回収ページ数",
            "不足ページ",
            "記録日時",
          ],
          rows: names.map((name, i) => ({
            excelRow: i + 2,
            number: i + 1,
            sourceName: name,
            csvName: (i < 5 ? "'" : "") + name,
            expectedStatus: "未回収",
            expectedFormula: false,
            requiredPages: 1,
            receivedPages: 0,
          })),
          excelChecks: [
            "B2:B6を数式として実行しない。セル表示・数式バーを確認。",
            "同姓同名のB7/B8は2行として維持。",
            "B9のUnicode、B10の二重引用符/コンマ、B11の改行を確認。",
            "ネットワーク接続関数や外部参照を含まない架空fixture。",
          ],
          executedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  });
});
