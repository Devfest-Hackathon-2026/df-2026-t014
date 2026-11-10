# REPORT_SCAN — paperflow-scan 実装報告

## 1. 概要

PaperFlow の本番形として、QR読み取りと台帳への記録だけを行う専用サイト `paperflow-scan` を新規作成しました。データの正本は先生本人の Google スプレッドシート台帳で、サイト側には発行・名簿編集・回収管理ダッシュボードを持たせていません。

- 参照元: `/Users/ryo/Documents/OpenCode/paperflow-inspect/paperflow-dev`（読み取りのみ）
- 新規プロジェクト: `/Users/ryo/Documents/OpenCode/paperflow-inspect/paperflow-scan`
- 参照元の変更: なし（`git status --porcelain` が空であることを確認済み）

## 2. 再利用したモジュール

QRデコード・PDF処理・Google連携・照合ロジックは再実装せず、参照元からコピーして再利用しました。

### PDF / QR

| ファイル | 用途 |
| --- | --- |
| `src/pdf/decode.ts` | 実際のピクセルからの QR デコード、QR候補判定 |
| `src/pdf/scan.ts` | ページごとの QR 読み取り・token 照合・重複/別配布物/未登録判定 |
| `src/pdf/renderer.ts` | PDF.js によるページ描画、サムネイル生成、中断処理 |
| `src/pdf/documents.ts` | PDF 入力検証、ページ数取得、照合済みページの PDF 抽出 |
| `src/pdf/geometry.ts` | `documents.ts` が参照する A4 定義（依存として同梱） |
| `src/pdf/index.ts` | 必要最小限の export に縮小 |
| `src/pdfClient.ts` | PDF エンジンの遅延読み込み（scan / extract のみに縮小） |

QR読み取り・照合・PDF描画のロジックは変更していません。発行用の `generate.ts`、`font.ts`、`demo.ts`、フォント資産はスキャン専用サイトでは不要なため同梱していません。

### Google 連携

| ファイル | 用途 |
| --- | --- |
| `src/google/auth.ts` | Google Identity Services による認可、メモリ内トークン管理 |
| `src/google/client.ts` | Sheets 台帳の読み書き、Drive Picker、PDF ダウンロード等 |
| `src/google/picker.ts` | 台帳スプレッドシートの選択 |
| `src/google/ledger.ts` | 台帳タブ、AppState スナップショットのエンコード/デコード、原子的書き込み用データ生成 |
| `src/google/errors.ts` | Google API エラー型 |
| `src/google/journal.ts` | 台帳作成の重複防止用ジャーナル |
| `src/google/index.ts` | 公開 API の集約 |
| `src/google/docsBridge.ts` | 参照元の一式に含まれるため同梱（本サイトでは未使用） |

認可スコープのみ、スキャン専用サイトに合わせて変更しました。

- 変更前: `openid`, `email`, `profile`, Classroom 2種, `drive.file`
- 変更後: `openid`, `email`, `profile`, `drive.file`

Classroom の権限を要求しないための最小権限化です。認可エラー文言も「台帳スプレッドシートへの権限」に合わせました。この変更に伴い、コピーした Google テストの「部分認可」ケース 2 件を `drive.file` 欠落のケースに更新しています。

### ドメイン / 記録処理

| ファイル | 用途 |
| --- | --- |
| `src/domain/types.ts` | 台帳・スキャン・受領記録の型 |
| `src/domain/logic.ts` | `recordBatch` による受領記録、`toCsv` による CSV 出力、生徒状態集計 |
| `src/domain/sharedScan.ts` | 同一PDFの別配布物利用、ページ所有者、確認状態の正規化 |
| `src/domain/recovery.ts` | 同じPDFを再解析した際の確認済み・対象外判断の復元 |
| `src/domain/lifecycle.ts` | 配布物の書き込み可否判定 |
| `src/domain/workflows.ts` | 監査イベント、配布物状態更新 |
| `src/domain/operations.ts` | 保存操作・成果物の管理（`recordBatch` / 台帳書き込みの依存） |
| `src/domain/persistence.ts` | 台帳から復元した AppState の検証（`sanitizeStateForStorage`） |
| `src/domain/seed.ts` | 初期状態（依存） |
| `src/domain/rosterSheet.ts` / `rosterCsv.ts` | `client.ts` が参照する名簿ユーティリティ（依存） |
| `src/domain/corrections.ts` / `workspaces.ts` | `sharedScan` のテスト・依存 |
| `src/cloudWorkflow.ts` | `saveCollectionRecord` による Sheets への原子的な記録、`hashPdf` |

`recordBatch` と `saveCollectionRecord` をそのまま使うことで、受領記録の重複防止、差し替え、監査イベント、台帳リビジョン競合の検出を再利用しています。

## 3. 実装した機能

1. **Google 接続**
   - 利用者本人の Google アカウントで明示的に接続。
   - アクセストークンはメモリ内のみ。リロード時は再接続が必要。
2. **台帳スプレッドシートの選択／特定**
   - Google Picker でスプレッドシートを選択。
   - URL またはスプレッドシート ID を直接入力して読み込む経路も用意。
   - 読み込み時に `readLedger` で台帳の AppState、token、生徒、受領記録を復元。
3. **回収PDFの取り込み**
   - ファイル選択とドラッグ＆ドロップ。
   - 100MiB / 200ページの既存制限を利用。
4. **QR読み取り・照合**
   - 台帳から読み込んだ `tokens` と生徒の対応表を `scanPdf` に渡して照合。
   - 既存受領記録を渡し、重複スキャンを検出。
   - 同一PDFを再解析した場合は `restoreReviewedPages` で確認済み・対象外の判断を復元。
   - 別配布物で処理済みのページは `prepareSharedScanReview` で変更不可として表示。
5. **要確認の確認画面**
   - 照合済み／要確認／対象外の件数を表示。
   - ページごとにサムネイル、元PDFページ、生徒・配布物ページ、理由を表示。
   - QR読取不可、未登録QR、空ページ、重複などを「対象外」にできる。
   - 重複スキャンは、既存記録を今回のスキャンで「差し替える」ことができる。
   - 「要確認をすべて対象外」で未確認ページをまとめて除外可能。
6. **Sheets への記録**
   - 「Sheetsに記録」で `recordBatch` → `saveCollectionRecord` を実行し、本人の台帳スプレッドシートへ書き戻す。
   - 記録のみ（record-only）で、PDFのDrive保管は行わない。
   - 通信断などで結果が不明な場合に備え、同じ確認内容・同じ操作IDで再試行できるよう準備状態を保持。
7. **出力（任意機能）**
   - 記録後に「照合済みPDF」をダウンロード（`extractStudentPdf` を再利用）。
   - 記録後に「回収状況CSV」をダウンロード（`toCsv` を再利用）。
8. **デプロイ準備**
   - Vite + React + TypeScript。
   - `firebase.json` で `paperflow-scan` という別 Hosting サイトを指定。
   - `public: dist`、SPA rewrite、セキュリティヘッダー、アセットキャッシュを設定。

## 4. 入れていない機能

- QR付き印刷PDFの発行、原稿PDFの生成
- 名簿・座席表の編集
- 管理用ダッシュボード、回収状況の管理画面
- サンプルモード
- PDFのDrive保管（record-only のみ）
- QR読取不可ページの手動割り当て（指示にある「確認・除外」の範囲に限定）

## 5. ビルド・テスト結果

Node.js はシェルの PATH に無かったため、Homebrew の `/opt/homebrew/bin` を使用しました。

- Node.js: `v24.22.1`
- npm: `11.19.1`

### ビルド

```text
npm run build
> tsc -b && vite build
✓ built in 163ms
```

成功しています。出力は `paperflow-scan/dist` です。

主なチャンク:

- `index-*.js` 約 336kB（gzip 約104kB）
- `pdf-*.js` 約 580kB（gzip 約184kB、pdf-lib / PDF.js の遅延読み込み）
- `pdf.worker.min-*.mjs` 約1.27MB

PDFエンジンが大きいため Vite の 500kB 警告が出ますが、ビルドは成功し、PDF処理は動的 import で初期表示から分離されています。

### テスト

```text
npm test
Test Files  11 passed (11)
Tests       142 passed (142)
```

内訳:

- 参照元からコピーした QRデコード、スキャン中断、PDF抽出、Google クライアント、Picker、台帳復旧、ドメインロジック、確認状態復元、共有スキャンのテスト
- 新規の `src/scanSiteWorkflow.test.ts`: 台帳の token → `recordBatch` → 受領記録 → 台帳行、および未読取ページが受領記録にならないことの確認

実際の Google アカウントを使った OAuth 接続、実スプレッドシートの読み込み、Sheets への書き込みは、認証情報とデプロイ先がないため未実施です。ビルド・自動テストと、参照元のモック API テストまでを確認しています。

## 6. コンソール側の残作業

コード外のため未実施です。

1. **Firebase Hosting サイトの新規作成**
   - 既存プロジェクト内に `paperflow-scan` という Hosting サイトを作成する。
   - 既存の `qrchecker-533d2.web.app` とは別ドメインになる。
   - プロジェクト ID が未確定のため `.firebaserc` は作成していない。
   - 作成後、`firebase deploy --only hosting:paperflow-scan`（または hosting target 設定）で配信する。
2. **OAuth クライアントの許可オリジン追加**
   - Google Cloud Console の OAuth クライアント（Web アプリ）に、新しい Hosting ドメインを「承認済みの JavaScript 生成元」として追加する。
   - 例: `https://paperflow-scan.web.app`、カスタムドメインを使う場合はそのオリジン。
   - 本サイトは GIS のトークンフローなので、リダイレクト URI の追加は不要。
3. **Google Cloud API の有効化**
   - Google Sheets API
   - Google Drive API
   - Google Picker API
4. **API キーの制限**
   - `VITE_GOOGLE_API_KEY` に設定するキーへ、新しい Hosting ドメインの HTTP リファラー制限を追加。
   - API 制限をかける場合は Picker / Sheets / Drive に限定。
5. **環境変数の設定**
   - `VITE_GOOGLE_CLIENT_ID`
   - `VITE_GOOGLE_API_KEY`
   - `VITE_GOOGLE_PROJECT_NUMBER`
   - ビルド前に `.env` または CI の環境変数へ設定する。
6. **OAuth 同意画面**
   - 公開・審査が必要な場合は `drive.file` の利用目的を記載。
   - テスト公開の場合は、利用する先生のアカウントをテストユーザーに追加。
7. **Drive の共有・権限**
   - 先生本人が台帳スプレッドシートを所有していること。
   - Picker で選べる状態であること。

## 7. 詰まった点・正直な注意点

- **照合ロジックはアプリ内状態前提**
  - 参照元の `scanPdf` は `PageToken[]`、`Collection`、既存 `Receipt[]` を必要とします。このため、新規実装では台帳を `readLedger` で読み、その `AppState` から token・生徒・受領記録・対象配布物を取り出して渡す設計にしました。
  - QRデコードや照合ロジックを切り出して書き直すことはせず、参照元の関数をそのまま利用しています。
- **Picker 設定が必須**
  - Drive から台帳を選ぶには `VITE_GOOGLE_API_KEY` と `VITE_GOOGLE_PROJECT_NUMBER` が必要です。未設定時は URL / ID 入力で読み込む経路を使えますが、`drive.file` の性質上、そのファイルへのアクセスが既に許可されている必要があります。
  - 参照元と同じ OAuth クライアント ID を使う場合、既存台帳への `drive.file` アクセスが引き継がれる可能性があります。別クライアント ID にする場合は Picker での選択が確実です。
- **手動 ID 入力の制約**
  - `drive.file` は「アプリが作成したファイル、または Picker で開いたファイル」へのアクセス権です。未許可のスプレッドシート ID を直接入力すると 403 になることがあります。その場合は Picker で選び直してください。
- **`ledgerRows` の Receipts タブの列数**
  - 参照元の `ledgerRows` では Receipts のヘッダーが 13 列、行データが 10 値で、`method` がヘッダー上の `pagesJson` 位置に入る状態でした。
  - 現在は列ずれを修正済みです。詳細は「8. 台帳 Receipts タブの列ずれ修正」を参照してください。
- **記録のみ**
  - 指示の「Sheetsに記録」に合わせ、Drive への回収PDF・生徒別PDFの保管は行いません。必要になった場合は参照元の `prepareArchive` / `resumeArchive` を追加再利用できます。
- **未記録の確認内容**
  - 別のPDFを選び直す際は、未記録の確認内容を失わないようガードを入れています。破棄する場合は画面上の「確認内容を破棄して選び直す」を使います。
- **サンプルモードなし**
  - 指示どおりサンプルモードは実装していません。動作確認には実際の台帳と回収PDFが必要です。

## 8. 台帳 Receipts タブの列ずれ修正

### 修正内容

`src/google/ledger.ts` の `ledgerRows` が返す Receipts タブで、ヘッダーと行データの列数・順序が一致していませんでした。Receipts は台帳の復元には使われず（復元の正本は AppState タブ）、人が読むためのビューであるため、Receipt 型に実在する項目へヘッダーと行を揃えました。

- Receipts ヘッダー: `receiptId`, `collectionId`, `versionId`, `studentId`, `pageNumber`, `token`, `batchId`, `sourcePage`, `recordedAt`, `method`, `actor` の 11 列。
- 行データ: 上記と同じ順序で 11 値。`token` と `actor` は未設定時に空文字。
- 実体のない `pagesJson`, `sourceDriveFileId`, `storageMode` は Receipts から削除しました（いずれも Receipt 型の項目ではありません）。

あわせて `ledgerRows` の範囲で他のタブを確認し、Batches タブにも同種の不一致（ヘッダー 7 列に対し行が 10 値）があったため、ヘッダーへ `pagesJson`, `sourceDriveFileId`, `storageMode` を追加して 10 列に揃えました。Students、Collections、Tokens、Summary、Events はヘッダーと行の列数が一致していました。

`encodeSnapshot` / `decodeSnapshot` と AppState タブのエンコード・デコードには変更を加えていません。

### テスト

- `src/google/ledger.test.ts` を追加しました。
  - 全タブで、各行の値の数がヘッダーの列数と一致すること。
  - Receipts の各値が対応するヘッダー列に入ること（`method`、`actor` を含む）。
  - Batches の各値が対応するヘッダー列に入ること。
- 既存の `src/scanSiteWorkflow.test.ts` にあった「historical row layout」前提の `receiptRow[9] === "qr"` を、ヘッダー名で引く検証と行長の検証に置き換えました。

`paperflow-scan` のテスト結果:

```text
npm test
Test Files  12 passed (12)
Tests       145 passed (145)
```

### paperflow-dev 側の修正

同じ列ずれが `paperflow-dev/src/google/ledger.ts` にもあったため、同一内容で修正しました。

- 変更ファイル: `paperflow-dev/src/google/ledger.ts`（Receipts ヘッダーを 11 列へ、行に `actor` を追加、Batches ヘッダーに 3 列を追加）
- 追加ファイル: `paperflow-dev/src/google/ledger.test.ts`（scan 側と同一）
- 差分概要: 5 行追加、3 行削除。AppState タブのエンコード／デコードには変更なし。
- GitHub への push はしていません。ローカル修正のみです。

`paperflow-dev` のテスト結果:

```text
npm test
Test Files  51 passed (51)
Tests       633 passed (633)
```

初回の全体実行では、今回の変更と無関係な `src/functional-google-supplement.test.tsx` の PF-F191 が 1 件だけ失敗しましたが、単体実行および再実行では全件パスしました（タイミング依存の不安定なテストと判断しています）。
