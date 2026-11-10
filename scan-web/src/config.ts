/**
 * 台帳テンプレート（Google スプレッドシート）の「コピーを作成」URL。
 *
 * ここが差し込み口です。本物の URL が決まったら、この定数 1 か所だけを
 * `https://docs.google.com/spreadsheets/d/<スプレッドシートID>/copy` の形に
 * 置き換えてください。
 *
 * xlsx などのファイルダウンロード形式は使いません（変換で Apps Script が消えるため）。
 */
export const LEDGER_TEMPLATE_COPY_URL =
  "https://docs.google.com/spreadsheets/d/REPLACE_WITH_TEMPLATE_SPREADSHEET_ID/copy";

/** 仮の URL のままかどうか。画面に「準備中」を出すためだけに使います。 */
export const LEDGER_TEMPLATE_URL_IS_PLACEHOLDER =
  LEDGER_TEMPLATE_COPY_URL.includes("REPLACE_WITH_TEMPLATE_SPREADSHEET_ID");
