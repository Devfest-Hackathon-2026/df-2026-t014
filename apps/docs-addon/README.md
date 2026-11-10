# TABANE Docs Editor add-on

このフォルダは Docs 内のサイドバーです。役割は **原稿への QR 帯の予約** だけに限定しています。QR の発行・印刷用 PDF の組み立て・台帳への記録は、台帳スプレッドシート側のスプシアプリ [`apps/sheets-ledger/`](../sheets-ledger/) が行います。Web アプリへの原稿受け渡しは行いません。

- メニュー「TABANE を開く」でサイドバーを開く。
- サイドバーは次の3ブロックだけ。
  1. **QRの予約**: 予約の有無・位置（右上・左上・右下・左下）・帯の高さを最上部に常時表示する。「QRの予約」「予約を解除」で操作する。
  2. **仮の名前**: 予約に付ける任意の表示名（30文字まで）。予約済みのときに変更すると、目印とヘッダーのガイドにも反映する。
  3. **QRのプレビュー**: 予約位置に置かれる QR の位置と大きさのサンプル。四隅の選択と帯の高さに連動する。実際の QR は台帳側で生徒ごとに発行する。
- サイドバーを開いた時点と、予約・名前の反映・解除の直後にサーバーから状態を再取得する。

## 予約の保持形式

- 予約はタブの上余白（`Body.setMarginTop`）、ヘッダーのガイド段落、名前付き範囲で保持する。
  Docs の名前付き範囲はヘッダー要素をアンカーにできないため、アンカーは本文の先頭要素に置く。
  同じマーカーをヘッダーのガイドにも書くので、文書コピーでどちらかが欠けても予約を復元できる。
- マーカー形式は次の4セグメントで統一する。

  `PFQR1_<tr|tl|br|bl>_<帯の高さpt>_<予約前の上余白pt>_<base64urlラベル>`

  ラベルは UTF-8 の base64url（`A-Z a-z 0-9 - _` のみ）。名前付き範囲の名前に使えない文字を避けるため、
  日本語や空白をそのまま入れない。ラベルが空でも4セグメント目を空にする
  （例: `PFQR1_tr_96_72_`）。ラベルなしの旧形式 `PFQR1_tr_96_72` も読み取れる。
- ヘッダーのガイド文には、人が読めるラベルとマーカーを併記する。
  例: `ここにQRコードが入ります 名前「文化祭ポスター」 PFQR1_tr_96_72_5paH5YyW56Wt44Od44K544K_44O8`
  ラベルが空なら `ここにQRコードが入ります PFQR1_tr_96_72_`。
- 複数セクションの文書は未対応。タブ先頭セクションの上余白だけを扱う。
- 予約を解除すると、このアドオンが付けた目印とガイドだけを削除し、上余白を元の値へ戻す。

## 設定

UserProperties に保存するのは予約に必要な次の項目だけ。

- `qrCorner`: 既定の配置コーナー（`top-right` / `top-left` / `bottom-right` / `bottom-left`）
- `qrBandHeightPt`: 既定の帯の高さ（48〜180pt）
- `qrLabel`: 直近の仮の名前（30文字まで）

原稿の本文・名簿・QR トークンなどは保存しない。

## 認可

`documents.currentonly` と `script.container.ui` の2つだけを要求する。

- `documents.currentonly`: このアドオンがバインドされた文書だけを読み書きするため。予約の作成・解除に使う。
- `script.container.ui`: サイドバーの表示のため。

Web への受け渡しとアカウント照合を廃止したため、`userinfo.email` は要求しない。
`Session.getEffectiveUser()` などのメール取得も使っていない。
QR の発行を台帳側へ移したため、`documents`（Docs 全体）、`spreadsheets`、`drive.file` も要求しない。

## 検証範囲

`Code.test.ts` は Apps Script API を模擬し、サイドバーの3ブロック構成、状態取得（有無・位置・帯の高さ・名前）、
マーカーの符号化／復号（ラベルあり・なし両形式）、名前だけの更新、二重予約の防止、
文書コピー後の予約復元、設定の項目制限、認可スコープ、旧 URL・旧受け渡し関数の不在を検証する。
台帳側のマーカー検出は [`apps/sheets-ledger/Code.test.ts`](../sheets-ledger/Code.test.ts) にある。

実 Docs のサイドバー表示・予約操作・コピー後の復元は未検証。モック上でのみ確認している。
詳しくは [テスト仕様書](../../docs/test-plan.md) を参照する。

Marketplace 公開、任意の教師の Docs への配布、学校管理アカウントでの検証は未実施。

参照:
[Bodyの用紙幅・高さ](<https://developers.google.com/apps-script/reference/document/body#getPageWidth()>)、
[Editor add-onのテスト](https://developers.google.com/workspace/add-ons/how-tos/testing-editor-addons)。
