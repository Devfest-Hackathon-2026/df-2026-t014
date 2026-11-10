# Google 連携のセットアップ

Firebase Hosting が静的な Web アプリを配信する。架空データのサンプルは Google の設定なしで利用できる。

## Web の設定

1. 同じ Google Cloud project で Classroom API、Drive API、Sheets API、Google Picker API を有効にする。Firebase project ID と Google Cloud project の**数値の project number**を混同しない。
2. OAuth 同意画面を設定する。Testing の場合は、実際に利用する Google アカウントをテストユーザーに加える。学校の管理者制限がある場合は、そのアカウントでの利用を別途確認する。公開 URL を知っているだけでは OAuth の対象ユーザーにならない。
3. Web application 用 OAuth クライアントを作り、Authorized JavaScript origins に利用する Hosting の origin（既存の環境では `https://qrchecker-533d2.web.app`）を登録する。ローカルで検証するときは `http://127.0.0.1:5173` も登録する。`localhost` は別 origin なので必要なら別に登録する。
4. Picker 用ブラウザ API key を用意する。API 制限を Google Picker API、HTTP referrer 制限を使用するサイトに設定する。同じ project の OAuth クライアント・API key・project number を使う。
5. コミット対象外の `.env.local` に以下を設定し、Vite を再起動する。公開ビルドではビルド時の値が使われるため、変更後は再ビルドが必要。

```dotenv
VITE_GOOGLE_CLIENT_ID=Web用クライアントID.apps.googleusercontent.com
VITE_GOOGLE_API_KEY=ブラウザ用APIキー
VITE_GOOGLE_PROJECT_NUMBER=数値のGoogleCloudProjectNumber
```

6. 「接続・設定」で Google に接続し、学校アカウントを確認する。初めは架空名簿・架空原稿で一連操作を確認する。認可・読取・保存は、画面から明示した操作で実行する。

これらのブラウザ設定値はビルド後に閲覧でき、環境変数に入れても秘密にはならない。client secret、service-account key、OAuth access token、Firebase/clasp のログイン情報は入れない。公開リポジトリへ API key や実データを追加しない。

要求スコープは `openid email profile`、`classroom.courses.readonly`、`classroom.rosters.readonly`、`drive.file`。Drive 全体、Docs 全体、Classroom の提出状態を書き換える権限は要求しない。Classroom に公式の出席番号フィールドはないため、取得した番号は仮連番であり、先生が確認する。

## Firebase Hosting

`npm run build` で `dist/` を作成する。既存の PaperFlow 環境を更新する場合は、権限のあるアカウントで Firebase CLI にログインし、`firebase deploy --only hosting --project qrchecker-533d2` を実行する。別の Hosting サイトに配信する場合は `firebase.json` の `hosting.site` と OAuth の origin を合わせる。

## Docs Editor add-on

`apps/docs-addon` は未公開テスト用のEditor add-on構成。動作確認には、架空のテストDocに紐付けたコンテナバインドの Apps Script を使う。

1. 同じ標準 Cloud project に関連付けた Apps Script へ `Code.gs`、`Reservation.gs`、`Sidebar.html`、`appsscript.json` を取り込む。
2. 開発確認では架空の単一タブDocsに紐付くbound Apps Scriptへ読み込み、保存・認可後に文書のメニューから起動する。審査用のEditor add-on test deploymentは、特定文書・コードversion・対象利用者を指定して別途確認する。boundでの成功を配布成功とは扱わない。
3. サイドバーでQRの配置コーナー・帯の高さ・仮の名前を決めて予約する。予約の有無・位置・帯の高さはサイドバー上部に常時表示される。解除すると上余白を元に戻す。
4. QRの発行・印刷用PDFの組み立ては台帳スプレッドシート側で行う。原稿をWebアプリへ渡す工程はない。

認可、予約マーカーの形式、検証範囲は [Docs アドオンの README](../apps/docs-addon/README.md) を参照。

## 公式資料

- [GIS token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model)
- [Google Picker for web apps](https://developers.google.com/workspace/drive/picker/guides/web-picker)
- [Classroom students.list](https://developers.google.com/workspace/classroom/reference/rest/v1/courses.students/list)
- [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Drive upload・再開・事前発行IDの制限](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
- [Sheets batchUpdate](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate)
- [Editor scopes](https://developers.google.com/workspace/add-ons/concepts/editor-scopes)
- [Editor add-on testing](https://developers.google.com/workspace/add-ons/how-tos/testing-editor-addons)
