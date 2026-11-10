/**
 * TABANE 台帳スプレッドシート（スプシアプリ）。
 *
 * 台帳スプレッドシートにバインドして使う。役割:
 *   名簿を読む → 原稿Docの予約を検出 → トークンを発行して対応表へ記録
 *   → QR入り印刷用Doc・PDFを作る → 発行記録を書く
 *   → スキャン結果CSVを取り込み、回収記録と提出一覧を作る
 *
 * 原稿Doc側（apps/docs-addon）は QR 帯の予約だけを担当する。
 * トークンは外部APIへ送らない。QRの中身はトークン文字列そのもの。
 */

var PAPERFLOW_LEDGER_TAB_ROSTER = '名簿';
var PAPERFLOW_LEDGER_TAB_SEATS = '座席表';
var PAPERFLOW_LEDGER_TAB_ISSUE_FORM = 'QR発行';
var PAPERFLOW_LEDGER_TAB_TOKENS = '対応表';
var PAPERFLOW_LEDGER_TAB_ISSUES = '発行記録';
var PAPERFLOW_LEDGER_TAB_RECEIPTS = '回収記録';
var PAPERFLOW_LEDGER_TAB_UNCLASSIFIED = '未分類';
/** 取り込みのたびに作る集計タブ。テンプレート初期化ではこの接頭辞のタブを削除する。 */
var PAPERFLOW_LEDGER_TAB_SUBMISSIONS_PREFIX = '提出一覧';

var PAPERFLOW_SETTINGS_KEY = 'PAPERFLOW_LEDGER_SETTINGS_V1';
var PAPERFLOW_DEFAULT_OUTPUT_FOLDER = 'TABANE 発行';
var PAPERFLOW_DEFAULT_ROSTER_SHEET = '名簿';

var PAPERFLOW_MAX_STUDENTS = 60;
var PAPERFLOW_MAX_SCAN_BYTES = 5 * 1024 * 1024;

/** 座席表の既定グリッド。6行×6列＝36席（40人学級の標準的な教室を想定）。 */
var PAPERFLOW_SEAT_GRID_DEFAULT_ROWS = 6;
var PAPERFLOW_SEAT_GRID_DEFAULT_COLS = 6;
var PAPERFLOW_SEAT_GRID_MIN = 1;
var PAPERFLOW_SEAT_GRID_MAX = 20;
/** 座席表タブの固定行: 1=タイトル、2=説明、3=列番号、4行目以降が席。 */
var PAPERFLOW_SEAT_CHART_HEADER_ROW = 3;
var PAPERFLOW_SEAT_CHART_FIRST_DATA_ROW = 4;
var PAPERFLOW_SEAT_CHART_FIRST_DATA_COL = 2;
var PAPERFLOW_SEAT_CHART_TITLE = '座席表';

var PAPERFLOW_ROSTER_HEADERS = ['出席番号', '氏名', '生徒ID', '座席の行', '座席の列'];
var PAPERFLOW_TOKEN_HEADERS = [
  'token', 'collectionId', 'versionId', 'studentId', 'kind',
  'studentNumber', 'studentName', 'title', 'jobId', 'issuedAt'
];
var PAPERFLOW_ISSUE_HEADERS = [
  'jobId', 'status', 'title', 'sourceDocumentId',
  'collectionId', 'versionId', 'studentCount', 'doneStudents',
  'tokenCount', 'layoutMode', 'qrCorner', 'bandHeightPt', 'issuedAt', 'updatedAt',
  'printDocumentId', 'printDocumentUrl', 'pdfFileId', 'pdfUrl', 'note'
];
var PAPERFLOW_RECEIPT_HEADERS = [
  'token', 'collectionId', 'studentId', 'studentNumber', 'studentName', 'pageNumber',
  'status', 'scanId', 'scannedAt', 'sourceFile', 'importedAt', 'note'
];

/**
 * 「QR発行」タブの固定レイアウト。A列が項目名、B列が値。
 * 2〜3行目が入力、4行目は空行、5〜10行目が出力。
 */
var PAPERFLOW_ISSUE_FORM_ROWS = [
  ['項目', '値'],
  ['原稿DocのURL', ''],
  ['配布物名', ''],
  ['', ''],
  ['発行日時', ''],
  ['発行人数', ''],
  ['状態', ''],
  ['メモ', ''],
  ['印刷用PDF', ''],
  ['印刷用Doc', '']
];
var PAPERFLOW_ISSUE_FORM_INPUTS = ['原稿DocのURL', '配布物名'];
/** 入力の直後に空行を1つ挟み、出力はこの行から始まる。 */
var PAPERFLOW_ISSUE_FORM_OUTPUT_ROW = 5;
var PAPERFLOW_ISSUE_FORM_OUTPUT_COUNT = 6;

function onOpen() {
  SpreadsheetApp.getUi().createMenu('TABANE')
    .addItem('初期設定', 'setupTABANELedgerFromMenu')
    .addItem('名簿をCSVから取り込む', 'showTABANERosterImportDialog')
    .addItem('QRを発行', 'issueTABANEQrFromMenu')
    .addItem('QR結果を読み取る', 'showTABANEImportDialog')
    .addSeparator()
    .addItem('座席表を再描画', 'redrawTABANESeatChartFromMenu')
    .addItem('設定', 'showTABANELedgerSettings')
    .addItem('テンプレート用に初期化', 'resetTABANELedgerTemplateFromMenu')
    .addToUi();
}

function setupTABANELedgerFromMenu() {
  var result = setupTABANELedger();
  SpreadsheetApp.getUi().alert(
    'TABANE の初期設定が完了しました。',
    result.message,
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

function showTABANEImportDialog() {
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutputFromFile('Import').setWidth(640).setHeight(540),
    'TABANE — QR結果を読み取る'
  );
}

function showTABANERosterImportDialog() {
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutputFromFile('RosterImport').setWidth(640).setHeight(560),
    'TABANE — 名簿をCSVから取り込む'
  );
}

function redrawTABANESeatChartFromMenu() {
  var ui = SpreadsheetApp.getUi();
  try {
    var result = redrawTABANESeatChart();
    ui.alert('座席表を再描画しました。', result.message, ui.ButtonSet.OK);
  } catch (error) {
    ui.alert('座席表を再描画できませんでした。', String(error && error.message ? error.message : error), ui.ButtonSet.OK);
  }
}

function showTABANELedgerSettings() {
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutputFromFile('Settings').setWidth(560).setHeight(600),
    'TABANE — 設定'
  );
}

/**
 * 配布用テンプレートを作るときの初期化。何が消えるかを確認してから実行する。
 * 開発用台帳のコピーで使う想定で、タブ構成・見出し・書式は残す。
 */
function resetTABANELedgerTemplateFromMenu() {
  var ui = SpreadsheetApp.getUi();
  var response = ui.alert(
    'テンプレート用に初期化',
    [
      'この台帳を配布用テンプレートの状態に戻します。',
      '',
      '消えるもの:',
      '・「名簿」「対応表」「発行記録」「回収記録」のデータ行（1行目の見出しは残ります）',
      '・「QR発行」タブの入力欄と出力欄の値（A列の項目名は残ります）',
      '・「提出一覧」で始まるタブ（すべて削除します）',
      '・設定のうち開発用の値（名簿スプレッドシートのURL、名簿タブ名）',
      '',
      '残るもの:',
      '・タブ構成、見出し、書式、スクリプト',
      '・未予約原稿のQR位置、帯の高さ、出力フォルダ名、座席表の行数と列数',
      '',
      'この操作は取り消せません。開発用台帳のコピーでのみ実行してください。よろしいですか？'
    ].join('\n'),
    ui.ButtonSet.YES_NO
  );
  if (response !== ui.Button.YES) return;
  try {
    var result = resetTABANELedgerTemplate();
    ui.alert('テンプレート用に初期化しました。', result.message, ui.ButtonSet.OK);
  } catch (error) {
    ui.alert(
      '初期化できませんでした。',
      String(error && error.message ? error.message : error),
      ui.ButtonSet.OK
    );
  }
}

function issueTABANEQrFromMenu() {
  var ui = SpreadsheetApp.getUi();
  var response = ui.alert(
    'QRを発行',
    '「QR発行」タブの入力でトークンを発行し、印刷用PDFを作ります。よろしいですか？',
    ui.ButtonSet.YES_NO
  );
  if (response !== ui.Button.YES) return;
  try {
    var result = issueTABANEQr({});
    ui.alert('QRを発行しました。', buildIssuanceSummary_(result), ui.ButtonSet.OK);
  } catch (error) {
    markIssuanceFormFailure_(String(error && error.message ? error.message : error));
    ui.alert('発行できませんでした。', String(error && error.message ? error.message : error), ui.ButtonSet.OK);
  }
}

/** 入力段階で止まったときも「QR発行」タブに失敗理由を残す。 */
function markIssuanceFormFailure_(message) {
  try {
    var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    if (!spreadsheet) return;
    var sheet = spreadsheet.getSheetByName(PAPERFLOW_LEDGER_TAB_ISSUE_FORM);
    if (!sheet) return;
    writeIssuanceFormOutputs_(sheet, {
      issuedAt: '',
      studentCount: '',
      status: '途中',
      note: String(message).slice(0, 1000),
      pdfUrl: '',
      documentUrl: ''
    });
  } catch (error) {
    /* 画面表示より元のエラーを優先する */
  }
}

function buildIssuanceSummary_(result) {
  return [
    result.title,
    result.studentCount + '人・トークン' + result.tokenCount + '件',
    result.layoutMode === 'reserved-corner' ? '原稿の予約帯を使用しました。' : '未予約のため管理帯方式で組み立てました。',
    result.pdfUrl ? 'PDF: ' + result.pdfUrl : ''
  ].filter(Boolean).join('\n');
}

/** 台帳のタブと見出しを作る。既にあるタブの中身は変更しない（名簿の任意列だけは補う）。 */
function setupTABANELedger() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error('台帳スプレッドシートを開いてから実行してください。');
  var created = [];
  var kept = [];
  var notes = [];

  function ensureTable(name, headers) {
    var result = ensureTableSheet_(spreadsheet, name, headers);
    (result.created ? created : kept).push(name);
  }

  var rosterResult = ensureRosterSheet_(spreadsheet);
  (rosterResult.created ? created : kept).push(PAPERFLOW_LEDGER_TAB_ROSTER);
  if (rosterResult.addedHeaders.length)
    notes.push('「名簿」タブに列「' + rosterResult.addedHeaders.join('」「') + '」を追加しました。');
  ensureSeatChartSheet_(spreadsheet, rosterResult.sheet, created, kept);
  ensureIssueFormSheet_(spreadsheet, created, kept);
  ensureTable(PAPERFLOW_LEDGER_TAB_TOKENS, PAPERFLOW_TOKEN_HEADERS);
  ensureTable(PAPERFLOW_LEDGER_TAB_ISSUES, PAPERFLOW_ISSUE_HEADERS);
  ensureTable(PAPERFLOW_LEDGER_TAB_RECEIPTS, PAPERFLOW_RECEIPT_HEADERS);

  var lines = [];
  if (created.length) lines.push('作成したタブ: ' + created.join('、'));
  if (kept.length) lines.push('既にあり、変更しなかったタブ: ' + kept.join('、'));
  notes.forEach(function(note) { lines.push(note); });
  lines.push('「名簿」タブに出席番号・氏名（必要なら生徒ID・座席の行と列）を入力するか、メニューの「名簿をCSVから取り込む」を使ってください。');
  lines.push('「座席表」タブのセルに出席番号または氏名を入れると、座席を名簿へ記録します。');
  lines.push('「QR発行」タブの入力を埋め、メニューの「QRを発行」を実行します。');
  return {
    spreadsheetId: spreadsheet.getId(),
    created: created,
    kept: kept,
    addedRosterHeaders: rosterResult.addedHeaders,
    message: lines.join('\n')
  };
}

/**
 * 台帳を配布用テンプレートの状態にする。
 * データ行だけを空にし、タブ・見出し・書式は残す。集計タブと開発用の設定だけ消す。
 */
function resetTABANELedgerTemplate() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error('台帳スプレッドシートを開いてから実行してください。');
  var cleared = [];
  var deleted = [];
  var notes = [];

  var rosterSheet = spreadsheet.getSheetByName(PAPERFLOW_LEDGER_TAB_ROSTER);
  if (rosterSheet) {
    cleared.push({
      tab: PAPERFLOW_LEDGER_TAB_ROSTER,
      rows: clearTABANERosterDataRows_(rosterSheet)
    });
  } else {
    notes.push('「名簿」タブがありませんでした。');
  }

  [PAPERFLOW_LEDGER_TAB_TOKENS, PAPERFLOW_LEDGER_TAB_ISSUES, PAPERFLOW_LEDGER_TAB_RECEIPTS]
    .forEach(function(name) {
      var sheet = spreadsheet.getSheetByName(name);
      if (!sheet) {
        notes.push('「' + name + '」タブがありませんでした。');
        return;
      }
      cleared.push({ tab: name, rows: clearTABANETableDataRows_(sheet) });
    });

  var form = spreadsheet.getSheetByName(PAPERFLOW_LEDGER_TAB_ISSUE_FORM);
  if (form) {
    // 旧レイアウトの台帳でも、テンプレートは新レイアウトで配れるようにする。
    if (!issueFormLayoutMatches_(form)) writeIssueFormLayout_(form);
    // A列の項目名は残し、B列の値だけを空にする（2〜10行目）。
    form.getRange(2, 2, PAPERFLOW_ISSUE_FORM_ROWS.length - 1, 1).clearContent();
    cleared.push({
      tab: PAPERFLOW_LEDGER_TAB_ISSUE_FORM,
      rows: PAPERFLOW_ISSUE_FORM_ROWS.length - 1
    });
  } else {
    notes.push('「QR発行」タブがありませんでした。');
  }

  listTABANESubmissionSheets_(spreadsheet).forEach(function(sheet) {
    var name = sheet.getName();
    spreadsheet.deleteSheet(sheet);
    deleted.push(name);
  });

  var settingsResult = stripTABANETemplateSettings_();

  var seatSheet = spreadsheet.getSheetByName(PAPERFLOW_LEDGER_TAB_SEATS);
  if (seatSheet) {
    try {
      drawTABANESeatChart_(spreadsheet, rosterSheet, [], settingsResult.settings);
      notes.push('「座席表」を空の名簿から描き直しました。');
    } catch (error) {
      notes.push(
        '「座席表」を再描画できませんでした: ' +
          String(error && error.message ? error.message : error)
      );
    }
  } else {
    notes.push('「座席表」タブがありませんでした。');
  }

  if (settingsResult.hadExternalRoster) {
    notes.push(
      '名簿の参照先に設定されていた別スプレッドシートは変更していません。必要なら手動で整理してください。'
    );
  }

  var lines = [];
  if (cleared.length) {
    lines.push(
      '空にしたタブ: ' +
        cleared
          .map(function(item) {
            return '「' + item.tab + '」（' + item.rows + '行）';
          })
          .join('、')
    );
  }
  if (deleted.length) lines.push('削除したタブ: ' + deleted.join('、'));
  lines.push('設定: ' + settingsResult.resetFields.join('、') + ' を初期値に戻しました。');
  lines.push('設定: ' + settingsResult.keptFields.join('、') + ' は残しました。');
  notes.forEach(function(note) {
    lines.push(note);
  });
  lines.push('タブ構成・見出し・書式はそのまま残しています。');
  lines.push('この台帳を配布用テンプレートとして共有してください。');

  return {
    spreadsheetId: spreadsheet.getId(),
    cleared: cleared,
    deleted: deleted,
    resetFields: settingsResult.resetFields,
    keptFields: settingsResult.keptFields,
    message: lines.join('\n')
  };
}

/** 「提出一覧」で始まるタブを返す（削除対象の列挙だけに使う）。 */
function listTABANESubmissionSheets_(spreadsheet) {
  if (!spreadsheet || !spreadsheet.getSheets) return [];
  return spreadsheet.getSheets().filter(function(sheet) {
    return sheet.getName().indexOf(PAPERFLOW_LEDGER_TAB_SUBMISSIONS_PREFIX) === 0;
  });
}

/** 名簿は見出し行を残し、その下のデータ行だけを空にする。 */
function clearTABANERosterDataRows_(sheet) {
  var lastRow = sheet.getLastRow();
  var lastColumn = Math.max(sheet.getLastColumn(), 1);
  if (lastRow < 2) return 0;
  var scanRows = Math.min(lastRow, 10);
  var topValues = sheet.getRange(1, 1, scanRows, lastColumn).getValues();
  var header = detectRosterHeader_(topValues);
  var firstDataRow = header ? header.rowIndex + 2 : 2;
  if (lastRow < firstDataRow) return 0;
  var count = lastRow - firstDataRow + 1;
  sheet.getRange(firstDataRow, 1, count, lastColumn).clearContent();
  return count;
}

/** 見出しが1行目の表は、2行目以降を空にする。書式は clearContent なので残る。 */
function clearTABANETableDataRows_(sheet) {
  var lastRow = sheet.getLastRow();
  var lastColumn = Math.max(sheet.getLastColumn(), 1);
  if (lastRow < 2) return 0;
  var count = lastRow - 1;
  sheet.getRange(2, 1, count, lastColumn).clearContent();
  return count;
}

/**
 * 開発用の設定だけを初期値へ戻す。
 * 名簿の参照先（別スプレッドシート）は消し、表示・出力・座席表の既定値は残す。
 * 出力フォルダの ID と作成名も消す（配布先で次に発行したときに作り直される）。
 */
function stripTABANETemplateSettings_() {
  var properties = PropertiesService.getScriptProperties();
  var raw = '';
  try {
    raw = properties.getProperty(PAPERFLOW_SETTINGS_KEY) || '';
  } catch (error) {
    raw = '';
  }
  var parsed = {};
  if (raw) {
    try {
      parsed = JSON.parse(raw) || {};
    } catch (error) {
      parsed = {};
    }
  }
  var current = readTABANELedgerSettings_();
  var hadExternalRoster = !!(
    (parsed && parsed.rosterSpreadsheetUrl) ||
    current.rosterSpreadsheetUrl
  );
  var next = {
    rosterSpreadsheetUrl: '',
    rosterSheetName: PAPERFLOW_DEFAULT_ROSTER_SHEET,
    qrCorner: current.qrCorner,
    qrBandHeightPt: current.qrBandHeightPt,
    outputFolderName: current.outputFolderName,
    // 出力フォルダの ID と作成名は開発環境のフォルダを指すため消す。
    // 消しても、配布先で次に発行したときに新しいフォルダが作られる。
    outputFolderId: '',
    outputFolderCreatedName: '',
    seatGridRows: current.seatGridRows,
    seatGridCols: current.seatGridCols
  };
  properties.setProperty(PAPERFLOW_SETTINGS_KEY, JSON.stringify(next));
  return {
    settings: sanitizeTABANELedgerSettings_(next),
    hadExternalRoster: hadExternalRoster,
    resetFields: ['名簿スプレッドシートのURL', '名簿タブ名'],
    keptFields: [
      '未予約原稿のQR位置',
      '未予約原稿の帯の高さ',
      '出力フォルダ名',
      '座席表の行数',
      '座席表の列数'
    ]
  };
}

/**
 * 名簿タブを用意する。新規なら生徒IDを含む見出しを作り、
 * 既存なら不足している生徒ID・座席の行・座席の列だけを末尾に足す（データ行は変更しない）。
 */
function ensureRosterSheet_(spreadsheet) {
  var name = PAPERFLOW_LEDGER_TAB_ROSTER;
  var sheet = spreadsheet.getSheetByName(name);
  var created = false;
  var addedHeaders = [];
  if (!sheet) {
    sheet = spreadsheet.insertSheet(name);
    created = true;
  }
  var lastRow = sheet.getLastRow();
  if (lastRow === 0) {
    var headerRange = sheet.getRange(1, 1, 1, PAPERFLOW_ROSTER_HEADERS.length);
    headerRange.setValues([PAPERFLOW_ROSTER_HEADERS]);
    try { headerRange.setFontWeight('bold'); } catch (error) { /* 書式は任意 */ }
    return { sheet: sheet, created: created, addedHeaders: [] };
  }
  var lastColumn = Math.max(sheet.getLastColumn(), 1);
  var scanRows = Math.min(lastRow, 10);
  var topValues = sheet.getRange(1, 1, scanRows, lastColumn).getValues();
  var header = detectRosterHeader_(topValues);
  if (!header) return { sheet: sheet, created: created, addedHeaders: [] };
  var headerRowNumber = header.rowIndex + 1;
  var headerRow = (topValues[header.rowIndex] || []).slice(0, lastColumn).map(normalizeHeader_);
  // 既存の列を動かさず、不足している任意列だけを末尾に足す。
  var appended = appendMissingRosterHeaders_(sheet, lastColumn, headerRow, headerRowNumber);
  if (appended.addedHeaders.length) {
    try { sheet.getRange(headerRowNumber, 1, 1, appended.lastColumn).setFontWeight('bold'); } catch (error) { /* 書式は任意 */ }
  }
  return { sheet: sheet, created: created, addedHeaders: appended.addedHeaders };
}

/** 名簿の任意列（生徒ID・座席の行・座席の列）の不足分を末尾に足す。 */
function appendMissingRosterHeaders_(sheet, lastColumn, headerRow, headerRowNumber) {
  var column = lastColumn;
  var rowNumber = headerRowNumber || 1;
  var normalized = headerRow.slice();
  var added = [];
  ['生徒ID', '座席の行', '座席の列'].forEach(function(header) {
    if (normalized.indexOf(normalizeHeader_(header)) !== -1) return;
    column += 1;
    sheet.getRange(rowNumber, column).setValue(header);
    normalized.push(normalizeHeader_(header));
    added.push(header);
  });
  return { lastColumn: column, headerRow: normalized, addedHeaders: added };
}

function ensureTableSheet_(spreadsheet, name, headers) {
  var sheet = spreadsheet.getSheetByName(name);
  var created = false;
  if (!sheet) {
    sheet = spreadsheet.insertSheet(name);
    created = true;
  }
  if (sheet.getLastRow() === 0) {
    var headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setValues([headers]);
    try { headerRange.setFontWeight('bold'); } catch (error) { /* 書式は任意 */ }
  }
  return { sheet: sheet, created: created };
}

function ensureIssueFormSheet_(spreadsheet, created, kept) {
  var name = PAPERFLOW_LEDGER_TAB_ISSUE_FORM;
  var sheet = spreadsheet.getSheetByName(name);
  var wasCreated = false;
  if (!sheet) {
    sheet = spreadsheet.insertSheet(name);
    wasCreated = true;
    created.push(name);
  } else {
    kept.push(name);
  }
  // 既存台帳の移行経路: 旧レイアウトなら新しい2入力のレイアウトへ書き換える。
  // 新レイアウトのままなら、出力欄の値に触れない。
  if (!issueFormLayoutMatches_(sheet)) writeIssueFormLayout_(sheet);
  return { sheet: sheet, created: wasCreated };
}

function issueFormLayoutMatches_(sheet) {
  if (sheet.getLastRow() < PAPERFLOW_ISSUE_FORM_ROWS.length) return false;
  var labels = sheet.getRange(1, 1, PAPERFLOW_ISSUE_FORM_ROWS.length, 1).getValues();
  for (var i = 0; i < PAPERFLOW_ISSUE_FORM_ROWS.length; i += 1) {
    var actual = labels[i][0] === null || labels[i][0] === undefined ? '' : String(labels[i][0]).trim();
    if (actual !== PAPERFLOW_ISSUE_FORM_ROWS[i][0]) return false;
  }
  return true;
}

/**
 * 「QR発行」タブを新レイアウトで書き直す。
 * B2（原稿DocのURL）とB3（配布物名）は新旧で位置が同じなので引き継ぐ。
 */
function writeIssueFormLayout_(sheet) {
  var lastRow = sheet.getLastRow();
  var sourceDocumentUrl = lastRow >= 2 ? sheet.getRange(2, 2).getValue() : '';
  var title = lastRow >= 3 ? sheet.getRange(3, 2).getValue() : '';
  var rows = PAPERFLOW_ISSUE_FORM_ROWS.map(function(row) { return row.slice(); });
  rows[1][1] = sourceDocumentUrl === null || sourceDocumentUrl === undefined ? '' : sourceDocumentUrl;
  rows[2][1] = title === null || title === undefined ? '' : title;
  sheet.getRange(1, 1, rows.length, 2).setValues(rows);
  if (lastRow > rows.length) {
    sheet.getRange(rows.length + 1, 1, lastRow - rows.length, 2).clearContent();
  }
  try {
    sheet.getRange(1, 1, 1, 2).setFontWeight('bold');
    sheet.getRange(2, 1, PAPERFLOW_ISSUE_FORM_INPUTS.length, 1).setFontWeight('bold');
  } catch (error) { /* 書式は任意 */ }
}

/** スプレッドシート／文書のURLまたはIDからIDだけを取り出す。 */
function spreadsheetIdFrom_(value) {
  return idFromUrl_(value, 'spreadsheets');
}

function documentIdFrom_(value) {
  return idFromUrl_(value, 'document');
}

function idFromUrl_(value, kind) {
  if (typeof value !== 'string') return '';
  var trimmed = value.trim();
  if (!trimmed) return '';
  var pattern = kind === 'document'
    ? /\/(?:document|docs)\/d\/([A-Za-z0-9_-]+)/
    : /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/;
  var match = trimmed.match(pattern);
  if (match) return match[1];
  return /^[A-Za-z0-9_-]{20,100}$/.test(trimmed) ? trimmed : '';
}

function openLedgerSpreadsheet_(value) {
  var id = spreadsheetIdFrom_(value);
  if (!id) throw new Error('スプレッドシートのURLまたはIDを確認してください。');
  try {
    return openSpreadsheetById_(id);
  } catch (error) {
    throw new Error('スプレッドシートを開けません。URL・共有・アクセス権を確認してください。');
  }
}

/** テストで差し替えやすいよう、openById を1か所にまとめる。 */
function openSpreadsheetById_(id) {
  return SpreadsheetApp.openById(id);
}

function readTABANELedgerSettings_() {
  try {
    return sanitizeTABANELedgerSettings_(
      JSON.parse(PropertiesService.getScriptProperties().getProperty(PAPERFLOW_SETTINGS_KEY) || '{}')
    );
  } catch (error) {
    return sanitizeTABANELedgerSettings_({});
  }
}

function sanitizeTABANELedgerSettings_(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('設定の形式が正しくありません。');
  var result = {
    rosterSpreadsheetUrl: '',
    rosterSheetName: PAPERFLOW_DEFAULT_ROSTER_SHEET,
    qrCorner: 'top-right',
    qrBandHeightPt: PAPERFLOW_DEFAULT_QR_BAND_HEIGHT_PT,
    outputFolderName: PAPERFLOW_DEFAULT_OUTPUT_FOLDER,
    outputFolderId: '',
    outputFolderCreatedName: '',
    seatGridRows: PAPERFLOW_SEAT_GRID_DEFAULT_ROWS,
    seatGridCols: PAPERFLOW_SEAT_GRID_DEFAULT_COLS
  };
  if (typeof value.rosterSpreadsheetUrl === 'string') {
    var rosterUrl = value.rosterSpreadsheetUrl.trim();
    if (rosterUrl) {
      var rosterId = spreadsheetIdFrom_(rosterUrl);
      if (!rosterId) throw new Error('名簿スプレッドシートのURLまたはIDを確認してください。');
      result.rosterSpreadsheetUrl = rosterUrl;
    }
  }
  if (typeof value.rosterSheetName === 'string')
    result.rosterSheetName = value.rosterSheetName.trim().slice(0, 80) || PAPERFLOW_DEFAULT_ROSTER_SHEET;
  if (['top-right', 'top-left', 'bottom-right', 'bottom-left'].indexOf(value.qrCorner) !== -1)
    result.qrCorner = value.qrCorner;
  if (isIntegral_(value.qrBandHeightPt) && value.qrBandHeightPt >= PAPERFLOW_MIN_QR_BAND_HEIGHT_PT && value.qrBandHeightPt <= PAPERFLOW_MAX_QR_BAND_HEIGHT_PT)
    result.qrBandHeightPt = value.qrBandHeightPt;
  if (typeof value.outputFolderName === 'string')
    result.outputFolderName = value.outputFolderName.trim().slice(0, 120) || PAPERFLOW_DEFAULT_OUTPUT_FOLDER;
  // 出力フォルダの ID と作成名は内部項目。設定ダイアログには出さない。
  if (typeof value.outputFolderId === 'string') {
    var outputFolderId = value.outputFolderId.trim();
    if (/^[A-Za-z0-9_-]{5,200}$/.test(outputFolderId)) result.outputFolderId = outputFolderId;
  }
  if (typeof value.outputFolderCreatedName === 'string')
    result.outputFolderCreatedName = value.outputFolderCreatedName.trim().slice(0, 120);
  if (isIntegral_(value.seatGridRows) && value.seatGridRows >= PAPERFLOW_SEAT_GRID_MIN && value.seatGridRows <= PAPERFLOW_SEAT_GRID_MAX)
    result.seatGridRows = value.seatGridRows;
  if (isIntegral_(value.seatGridCols) && value.seatGridCols >= PAPERFLOW_SEAT_GRID_MIN && value.seatGridCols <= PAPERFLOW_SEAT_GRID_MAX)
    result.seatGridCols = value.seatGridCols;
  return result;
}

function saveTABANELedgerSettings(value) {
  var input = value || {};
  // 設定ダイアログは出力フォルダ名しか送らない。内部項目（ID・作成名）は保存済みの値から引き継ぐ。
  try {
    var current = readTABANELedgerSettings_();
    if (input.outputFolderId === undefined) input.outputFolderId = current.outputFolderId;
    if (input.outputFolderCreatedName === undefined)
      input.outputFolderCreatedName = current.outputFolderCreatedName;
  } catch (error) {
    /* 既存設定が壊れていても、送られた値だけで保存する。 */
  }
  var clean = sanitizeTABANELedgerSettings_(input);
  PropertiesService.getScriptProperties().setProperty(PAPERFLOW_SETTINGS_KEY, JSON.stringify(clean));
  // グリッドの大きさが変わったときは座席表を引き直す。名簿がまだ無い場合は何もしない。
  try {
    var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    if (spreadsheet && spreadsheet.getSheetByName(PAPERFLOW_LEDGER_TAB_SEATS))
      redrawTABANESeatChart_();
  } catch (error) {
    /* 設定の保存自体は成功させる。再描画はメニューからやり直せる。 */
  }
  return clean;
}

function getTABANELedgerSettings() {
  return readTABANELedgerSettings_();
}

function normalizeHeader_(value) {
  if (value === null || value === undefined) return '';
  return String(value).normalize('NFKC').toLowerCase()
    .replace(/[\s　_・:：()（）\[\]【】]/g, '');
}

function toPositiveInt_(value) {
  if (typeof value === 'number' && isFinite(value) && Math.floor(value) === value && value >= 1) return value;
  if (typeof value !== 'string') return null;
  var text = value.normalize('NFKC').replace(/[\s　]/g, '');
  if (!/^\d{1,3}$/.test(text)) return null;
  var number = Number(text);
  return number >= 1 ? number : null;
}

function isIntegral_(value) {
  return typeof value === 'number' && isFinite(value) && Math.floor(value) === value;
}

function paperFlowTimestamp_(date) {
  var now = date || new Date();
  function pad(value) { return ('0' + value).slice(-2); }
  return now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '-' + pad(now.getHours()) + pad(now.getMinutes());
}

function paperFlowCompactTimestamp_(date) {
  var now = date || new Date();
  function pad(value) { return ('0' + value).slice(-2); }
  return now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '-' +
    pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
}

/** シート名に使えない文字を置き換え、100文字以内に収める。 */
function sanitizeSheetName_(value) {
  var name = String(value === null || value === undefined ? '' : value)
    .replace(/[\\/?*\[\]:]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name) name = '無題';
  return name.slice(0, 90);
}

function uniqueSheetName_(spreadsheet, base) {
  var name = sanitizeSheetName_(base);
  if (!spreadsheet.getSheetByName(name)) return name;
  for (var index = 2; index < 100; index += 1) {
    var suffix = '_' + index;
    var candidate = sanitizeSheetName_(base.slice(0, 90 - suffix.length)) + suffix;
    if (!spreadsheet.getSheetByName(candidate)) return candidate;
  }
  throw new Error('提出一覧のタブ名を決められません。既存のタブを整理してください。');
}

/**
 * 見出し行から列を判定する。見出しが欠けていればエラーで停止し、
 * 既存の形式を壊さない。
 */
function ledgerHeaderIndex_(headerRow, expectedHeaders, tabName) {
  var normalized = headerRow.map(normalizeHeader_);
  var index = {};
  expectedHeaders.forEach(function(header) {
    var column = normalized.indexOf(normalizeHeader_(header));
    if (column === -1)
      throw new Error('台帳の「' + tabName + '」タブに「' + header + '」列がありません。既存の形式を壊さないため停止しました。');
    index[header] = column;
  });
  return index;
}

function ensureLedgerSheet_(spreadsheet, name, expectedHeaders) {
  var sheet = spreadsheet.getSheetByName(name);
  if (!sheet) sheet = spreadsheet.insertSheet(name);
  var lastRow = sheet.getLastRow();
  var width = expectedHeaders.length;
  if (lastRow === 0) {
    sheet.getRange(1, 1, 1, width).setValues([expectedHeaders]);
    return { sheet: sheet, index: ledgerHeaderIndex_(expectedHeaders, expectedHeaders, name), width: width };
  }
  var lastColumn = Math.max(sheet.getLastColumn(), width);
  var headerRow = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
  return { sheet: sheet, index: ledgerHeaderIndex_(headerRow, expectedHeaders, name), width: lastColumn };
}

function buildLedgerRow_(ledger, headers, values) {
  var row = [];
  for (var i = 0; i < ledger.width; i += 1) row.push('');
  headers.forEach(function(header, position) {
    var value = values[position];
    row[ledger.index[header]] = value === undefined || value === null ? '' : value;
  });
  return row;
}

function appendLedgerRow_(ledger, headers, values) {
  var rowNumber = ledger.sheet.getLastRow() + 1;
  ledger.sheet.getRange(rowNumber, 1, 1, ledger.width).setValues([buildLedgerRow_(ledger, headers, values)]);
  return rowNumber;
}

function setLedgerField_(ledger, rowNumber, header, value) {
  var column = ledger.index[header];
  if (column === undefined) return;
  ledger.sheet.getRange(rowNumber, column + 1).setValue(value === undefined || value === null ? '' : value);
}

function readLedgerRecords_(ledger, headers) {
  var lastRow = ledger.sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = ledger.sheet.getRange(2, 1, lastRow - 1, ledger.width).getValues();
  return values.map(function(row, offset) {
    var record = { __rowNumber: offset + 2 };
    headers.forEach(function(header) {
      record[header] = row[ledger.index[header]];
    });
    return record;
  });
}

/**
 * 出力フォルダを解決する。
 *
 * drive.file スコープではフォルダの名前検索を呼べないため、
 * 初回にフォルダを作って ID を設定へ保存し、以後は ID で開く。
 * ID で追うので、先生が Drive 上でフォルダを移動・改名しても同じフォルダへ出し続ける。
 *
 * 分岐:
 *   a. 設定のフォルダ名が「作成時に使ったフォルダ名」と違う → 新しい名前で作成し直す
 *   b. ID があり、getFolderById で開けてゴミ箱でもない → そのフォルダを使う
 *   c. ID がない／開けない／ゴミ箱 → 作成して ID と作成名を保存する
 */
function getOutputFolder_(settings) {
  var current = settings || readTABANELedgerSettings_();
  var folderName = current.outputFolderName || PAPERFLOW_DEFAULT_OUTPUT_FOLDER;
  if (current.outputFolderCreatedName !== folderName)
    return createOutputFolder_(current, folderName);
  if (current.outputFolderId) {
    var existing = openOutputFolderById_(current.outputFolderId);
    if (existing) return existing;
  }
  return createOutputFolder_(current, folderName);
}

/** ID から出力フォルダを開く。開けない・ゴミ箱の場合は null。 */
function openOutputFolderById_(id) {
  try {
    var folder = DriveApp.getFolderById(id);
    if (!folder) return null;
    if (typeof folder.isTrashed === 'function' && folder.isTrashed()) return null;
    return folder;
  } catch (error) {
    return null;
  }
}

/** 出力フォルダを作り、ID と作成時の名前を設定へ保存する。 */
function createOutputFolder_(settings, name) {
  var folder = DriveApp.createFolder(name);
  settings.outputFolderId = folder.getId();
  settings.outputFolderCreatedName = name;
  try {
    PropertiesService.getScriptProperties().setProperty(PAPERFLOW_SETTINGS_KEY, JSON.stringify(settings));
  } catch (error) {
    /* 保存できなくても今回の発行は続ける。次回は作り直しになる。 */
  }
  return folder;
}
