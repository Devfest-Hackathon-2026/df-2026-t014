# TABANE スキャン（paperflow-scan）

回収PDFのQRをブラウザ内で読み取り、台帳スプレッドシートへ取り込むためのCSVを出力するサイトです。Googleアカウントへの接続や台帳の読み書きは行いません。

## 開発

```bash
npm ci
npm run dev
```

環境変数は不要です。

## ビルドとテスト

```bash
npm run build
npm test
```

## 配信

`firebase.json` の `site: "tabane"` で https://tabane.web.app に配信します。

```bash
npm run build
firebase deploy --only hosting
```

## 台帳テンプレートの入手ボタン

トップ画面の「台帳テンプレートを入手」は、台帳テンプレート用スプレッドシートの
「コピーを作成」リンク（`/copy` 形式）へ誘導します。URL の差し込み口は 1 か所だけです。

- ファイル: `src/config.ts`
- 定数: `LEDGER_TEMPLATE_COPY_URL`
- 形式: `https://docs.google.com/spreadsheets/d/<スプレッドシートID>/copy`

現在は `REPLACE_WITH_TEMPLATE_SPREADSHEET_ID` の仮値です。仮値の間は画面に「公開 URL は準備中」と表示します。
URL を差し替えたら `npm run build` と `npm run test` を通し、`firebase deploy --only hosting` で再配信してください。
xlsx などのファイルダウンロード形式は使いません（変換で Apps Script が消えるため）。

## 使い方ガイド

同じサイト内に「使用法はこちら」（`#guide`）のセクションがあります。テンプレートのコピーから、
台帳の「初期設定」・名簿入力・原稿 Doc の「QRを予約する」・「QRを発行」・回収PDFの読み取り・
「QR結果を読み取る」・「提出一覧」の確認までを、実装済みのメニュー名に合わせて説明しています。
名簿や生徒情報がこのサイトへ送信されないことも記載しています。

## 流れ

1. 回収PDFを選ぶ（100MiB / 200ページまで）
2. ページごとにQRを読み取る
3. 要確認（読取不可・重複）をページ画像で確認し、必要なら対象外にする／重複の正ページを選ぶ
4. CSVをダウンロードし、台帳側の「QR結果を読み取る」で取り込む

## CSV 仕様

`src/domain/scanCsv.ts` の `SCAN_CSV_HEADER` が正本です。台帳側 `apps/sheets-ledger/ScanImport.gs` の `PAPERFLOW_SCAN_HEADERS` と完全一致させてください。

```
scan_id,scanned_at,source_file,page,token,status,note
```

- 1行 = 回収PDFの1ページ分。`page` はPDF内ページ番号（1始まり）
- `status` は `ok` / `unreadable` / `duplicate`
  - `ok`: トークンを読め、そのスキャンで最初の出現
  - `unreadable`: QRを読めなかった（`token` は空。証跡としてCSVに残す）
  - `duplicate`: 同じトークンが前のページにも出た（`note` に重複先ページ）
- 対象外にしたページはCSVに含めず、重複判定にも数えない

## 構成

- `src/pdf/`: QRデコード、PDF描画、スキャン
- `src/domain/scanCsv.ts`: CSV生成と重複判定
- `src/App.tsx`: 取り込み・読み取り・確認・ダウンロードの画面
