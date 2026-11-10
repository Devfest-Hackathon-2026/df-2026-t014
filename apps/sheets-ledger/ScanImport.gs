/**
 * QR読み取り結果（CSV）の取り込みと提出一覧の作成。
 *
 * CSV はスキャン側との接合部。形式はこのファイルの
 * PAPERFLOW_SCAN_HEADERS が正本:
 *   scan_id,scanned_at,source_file,page,token,status,note
 *
 * 取り込みはダイアログで先生のPCからCSVを直接アップロードする。
 * Drive を経由しないため Drive スコープは要求しない。
 */

var PAPERFLOW_SCAN_HEADERS = ['scan_id', 'scanned_at', 'source_file', 'page', 'token', 'status', 'note'];
var PAPERFLOW_SCAN_STATUSES = ['ok', 'unreadable', 'duplicate'];

/** RFC 4180（引用符・CRLF/LF）に対応した最小のCSVパーサ。 */
function parseCsvText_(text) {
  if (typeof text !== 'string') throw new Error('CSVの内容が正しくありません。');
  if (text.length > PAPERFLOW_MAX_SCAN_BYTES) throw new Error('CSVが大きすぎます。5MiB以下に分けてください。');
  var source = text.replace(/^\uFEFF/, '');
  var records = [];
  var cells = [];
  var field = '';
  var inQuotes = false;
  var line = 1;
  var recordLine = 1;
  for (var i = 0; i < source.length; i += 1) {
    var character = source.charAt(i);
    if (inQuotes) {
      if (character === '"') {
        if (source.charAt(i + 1) === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += character;
        if (character === '\n') line += 1;
      }
      continue;
    }
    if (character === '"') {
      if (!field.length) inQuotes = true;
      else field += '"';
    } else if (character === ',') {
      cells.push(field);
      field = '';
    } else if (character === '\r' || character === '\n') {
      if (character === '\r' && source.charAt(i + 1) === '\n') i += 1;
      cells.push(field);
      records.push({ cells: cells, line: recordLine });
      cells = [];
      field = '';
      line += 1;
      recordLine = line;
    } else {
      field += character;
    }
  }
  if (inQuotes) throw new Error('CSVの引用符が閉じていません。ファイルを確認してください。');
  if (field.length || cells.length) {
    cells.push(field);
    records.push({ cells: cells, line: recordLine });
  }
  return records;
}

function parseTABANEScanCsv(text) {
  var records = parseCsvText_(text);
  if (!records.length) throw new Error('CSVが空です。');
  var headerCells = records[0].cells.map(function(value) { return cellText_(value); });
  if (!headerCells.join('')) throw new Error('CSVの1行目にヘッダーがありません。');
  var normalizedActual = headerCells.map(normalizeHeader_);
  var normalizedExpected = PAPERFLOW_SCAN_HEADERS.map(normalizeHeader_);
  var seen = {};
  var missing = [];
  var extra = [];
  headerCells.forEach(function(header, index) {
    var normalized = normalizedActual[index];
    if (seen[normalized]) throw new Error('CSVのヘッダー「' + header + '」が重複しています。');
    seen[normalized] = true;
    if (normalizedExpected.indexOf(normalized) === -1) extra.push(header);
  });
  PAPERFLOW_SCAN_HEADERS.forEach(function(header, index) {
    if (normalizedActual.indexOf(normalizedExpected[index]) === -1) missing.push(header);
  });
  if (missing.length || extra.length) {
    throw new Error(
      'CSVのヘッダーが仕様と一致しません。必要な列: ' + PAPERFLOW_SCAN_HEADERS.join(',') +
      (missing.length ? ' / 不足: ' + missing.join(',') : '') +
      (extra.length ? ' / 余分: ' + extra.join(',') : '')
    );
  }
  var index = {};
  PAPERFLOW_SCAN_HEADERS.forEach(function(header) {
    index[header] = normalizedActual.indexOf(normalizeHeader_(header));
  });

  var rows = [];
  var broken = [];
  for (var recordIndex = 1; recordIndex < records.length; recordIndex += 1) {
    var record = records[recordIndex];
    var cells = record.cells;
    if (cells.length === 1 && !cellText_(cells[0])) continue;
    if (cells.length !== PAPERFLOW_SCAN_HEADERS.length) {
      broken.push({ rowNumber: record.line, reason: '列数が' + PAPERFLOW_SCAN_HEADERS.length + 'ではありません（' + cells.length + '列）' });
      continue;
    }
    function cell(header) { return cellText_(cells[index[header]]); }
    var scanId = cell('scan_id');
    var scannedAt = cell('scanned_at');
    var sourceFile = cell('source_file');
    var pageText = cell('page');
    var token = cell('token');
    var status = cell('status').toLowerCase();
    var note = cell('note');
    if (!scanId) { broken.push({ rowNumber: record.line, reason: 'scan_idが空です' }); continue; }
    if (!scannedAt || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(scannedAt) || isNaN(new Date(scannedAt).getTime())) {
      broken.push({ rowNumber: record.line, reason: 'scanned_atがISO 8601の日時ではありません' });
      continue;
    }
    if (!sourceFile) { broken.push({ rowNumber: record.line, reason: 'source_fileが空です' }); continue; }
    if (!/^\d{1,6}$/.test(pageText) || Number(pageText) < 1) {
      broken.push({ rowNumber: record.line, reason: 'pageが1始まりの整数ではありません' });
      continue;
    }
    if (PAPERFLOW_SCAN_STATUSES.indexOf(status) === -1) {
      broken.push({ rowNumber: record.line, reason: 'statusがok/unreadable/duplicateではありません' });
      continue;
    }
    if (status === 'ok' && !token) {
      broken.push({ rowNumber: record.line, reason: 'status=okなのにtokenが空です' });
      continue;
    }
    rows.push({
      scanId: scanId,
      scannedAt: scannedAt,
      sourceFile: sourceFile,
      page: Number(pageText),
      token: token,
      status: status,
      note: note,
      rowNumber: record.line
    });
  }
  return { rows: rows, broken: broken };
}

function receiptCompositeKey_(record) {
  return [record.scanId, record.sourceFile, record.pageNumber, record.token, record.status]
    .map(function(value) { return value === null || value === undefined ? '' : String(value); })
    .join('\u0000');
}

function reviewLabel_(kind) {
  return {
    unknown: '対応表にないトークン',
    unreadable: '読み取り不可',
    duplicate: '重複（要確認）'
  }[kind] || kind;
}

/**
 * CSVを取り込み、回収記録を追記して提出一覧タブを作る。
 * 入力: { text: string, fileName?: string }
 */
function importTABANEScanCsv(input) {
  var value = input || {};
  if (typeof value.text !== 'string' || !value.text.trim()) throw new Error('CSVファイルを選んでください。');
  var fileName = cellText_(value.fileName) || 'scan.csv';
  var parsed = parseTABANEScanCsv(value.text);
  if (!parsed.rows.length) {
    throw new Error('取り込める行がありません。壊れた行: ' + parsed.broken.length + '件');
  }

  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error('台帳スプレッドシートを開いてから実行してください。');
  var tokenLedger = ensureLedgerSheet_(spreadsheet, PAPERFLOW_LEDGER_TAB_TOKENS, PAPERFLOW_TOKEN_HEADERS);
  var receiptLedger = ensureLedgerSheet_(spreadsheet, PAPERFLOW_LEDGER_TAB_RECEIPTS, PAPERFLOW_RECEIPT_HEADERS);

  var tokenRecords = readLedgerRecords_(tokenLedger, PAPERFLOW_TOKEN_HEADERS);
  var tokenIndex = {};
  tokenRecords.forEach(function(record) {
    if (record.token) tokenIndex[String(record.token)] = record;
  });
  var receipts = readLedgerRecords_(receiptLedger, PAPERFLOW_RECEIPT_HEADERS);

  var okTokens = {};
  var composite = {};
  receipts.forEach(function(record) {
    if (String(record.status) === 'ok' && record.token) okTokens[String(record.token)] = true;
    composite[receiptCompositeKey_(record)] = true;
  });

  var importedAt = new Date().toISOString();
  var counts = { ok: 0, unknown: 0, unreadable: 0, duplicate: 0, already: 0 };
  var collectionIds = {};
  var reviews = [];
  var newRows = [];

  parsed.rows.forEach(function(row) {
    var tokenRecord = row.token ? tokenIndex[row.token] : null;
    var storedStatus = row.status;
    if (row.status === 'ok') storedStatus = tokenRecord ? 'ok' : 'unknown';
    var note = row.note;
    if (storedStatus !== 'ok' && row.token && !tokenRecord)
      note = ['対応表にないトークン', row.note].filter(Boolean).join(' / ');
    var collectionId = tokenRecord ? String(tokenRecord.collectionId) : '';
    if (collectionId) collectionIds[collectionId] = true;

    // 要確認の行は、取り込み済みで記録を増やさない場合でも提出一覧に出す。
    if (storedStatus !== 'ok') {
      reviews.push({
        kind: storedStatus,
        token: row.token,
        page: row.page,
        sourceFile: row.sourceFile,
        scanId: row.scanId,
        note: note,
        collectionId: collectionId
      });
    }

    if (storedStatus === 'ok') {
      if (okTokens[row.token]) { counts.already += 1; return; }
    } else {
      var key = receiptCompositeKey_({
        scanId: row.scanId,
        sourceFile: row.sourceFile,
        pageNumber: row.page,
        token: row.token,
        status: storedStatus
      });
      if (composite[key]) { counts.already += 1; return; }
      composite[key] = true;
    }

    var record = {
      token: row.token,
      collectionId: tokenRecord ? tokenRecord.collectionId : '',
      studentId: tokenRecord ? tokenRecord.studentId : '',
      studentNumber: tokenRecord ? tokenRecord.studentNumber : '',
      studentName: tokenRecord ? tokenRecord.studentName : '',
      pageNumber: row.page,
      status: storedStatus,
      scanId: row.scanId,
      scannedAt: row.scannedAt,
      sourceFile: row.sourceFile,
      importedAt: importedAt,
      note: note
    };
    newRows.push(buildLedgerRow_(receiptLedger, PAPERFLOW_RECEIPT_HEADERS, [
      record.token, record.collectionId, record.studentId, record.studentNumber, record.studentName,
      record.pageNumber, record.status, record.scanId, record.scannedAt,
      record.sourceFile, record.importedAt, record.note
    ]));
    receipts.push(record);

    if (storedStatus === 'ok') {
      okTokens[row.token] = true;
      counts.ok += 1;
    } else if (storedStatus === 'unknown') counts.unknown += 1;
    else if (storedStatus === 'unreadable') counts.unreadable += 1;
    else if (storedStatus === 'duplicate') counts.duplicate += 1;
  });

  if (newRows.length)
    receiptLedger.sheet.getRange(receiptLedger.sheet.getLastRow() + 1, 1, newRows.length, receiptLedger.width).setValues(newRows);

  var tabs = [];
  Object.keys(collectionIds).forEach(function(collectionId) {
    var collectionReviews = reviews.filter(function(review) { return String(review.collectionId) === collectionId; });
    var tab = buildSubmissionSheet_(spreadsheet, collectionId, tokenRecords, receipts, collectionReviews, importedAt);
    if (tab) tabs.push(tab.name);
  });
  var unclassified = reviews.filter(function(review) { return !review.collectionId; });
  if (unclassified.length) {
    var fallback = buildUnclassifiedSheet_(spreadsheet, unclassified, importedAt);
    tabs.push(fallback.name);
  }

  var imported = counts.ok + counts.unknown + counts.unreadable + counts.duplicate;
  var brokenMessage = '';
  if (parsed.broken.length) {
    brokenMessage = '壊れた行のためスキップ: ' + parsed.broken.length + '件';
    if (parsed.broken[0]) brokenMessage += '（例: ' + parsed.broken[0].rowNumber + '行目 ' + parsed.broken[0].reason + '）';
  }
  return {
    ok: true,
    fileName: fileName,
    totalRows: parsed.rows.length + parsed.broken.length,
    importedRows: imported,
    okRows: counts.ok,
    unknownTokens: counts.unknown,
    unreadableRows: counts.unreadable,
    duplicateRows: counts.duplicate,
    alreadyImported: counts.already,
    brokenRows: parsed.broken.length,
    brokenExamples: parsed.broken.slice(0, 5),
    reviewCount: reviews.length,
    tabs: tabs,
    message: [
      fileName + ' を読み取りました。',
      '取り込み ' + imported + '件（回収 ' + counts.ok + '件 / 対応表にないトークン ' + counts.unknown + '件 / 読み取り不可 ' + counts.unreadable + '件 / 重複 ' + counts.duplicate + '件）',
      counts.already ? '取り込み済みのためスキップ: ' + counts.already + '件' : '',
      brokenMessage,
      '作成したタブ: ' + tabs.join('、')
    ].filter(Boolean).join('\n')
  };
}

function padRow_(row, width) {
  var result = row.slice();
  while (result.length < width) result.push('');
  return result;
}

function buildSubmissionSheet_(spreadsheet, collectionId, tokenRecords, receiptRecords, reviews, importedAt) {
  var tokens = tokenRecords.filter(function(record) { return String(record.collectionId) === collectionId; });
  if (!tokens.length) return null;

  var title = cellText_(tokens[0].title) || '無題';

  var students = {};
  tokens.forEach(function(record) {
    var studentId = String(record.studentId);
    if (!students[studentId]) {
      students[studentId] = {
        studentId: studentId,
        number: Number(record.studentNumber) || 0,
        name: cellText_(record.studentName),
        tokens: []
      };
    }
    if (record.token) students[studentId].tokens.push(String(record.token));
  });
  var studentList = Object.keys(students).map(function(id) { return students[id]; });
  studentList.sort(function(a, b) { return a.number - b.number || a.studentId.localeCompare(b.studentId); });

  var received = {};
  receiptRecords.forEach(function(record) {
    if (String(record.collectionId) === collectionId && String(record.status) === 'ok' && record.token)
      received[String(record.token)] = record;
  });

  var header = ['出席番号', '氏名', 'まとめ'];

  var rows = [];
  rows.push(['配布物', title]);
  rows.push(['取り込み日時', importedAt]);
  rows.push([]);
  rows.push(header);
  var summary = { submitted: 0, missing: 0 };

  studentList.forEach(function(student) {
    var isReceived = student.tokens.some(function(token) { return !!received[token]; });
    var statusLabel = isReceived ? '提出済み' : '未提出';
    if (isReceived) summary.submitted += 1;
    else summary.missing += 1;
    rows.push([student.number, student.name, statusLabel]);
  });

  rows.push([]);
  rows.push(['集計', '提出済み ' + summary.submitted + '人 / 未提出 ' + summary.missing + '人']);
  rows.push([]);
  rows.push(['要確認', '種別', 'トークン', 'ページ', '元ファイル', '理由']);
  reviews.forEach(function(review) {
    rows.push(['', reviewLabel_(review.kind), review.token, review.page, review.sourceFile, review.note]);
  });

  var width = header.length;
  rows.forEach(function(row) { if (row.length > width) width = row.length; });
  var padded = rows.map(function(row) { return padRow_(row, width); });

  var name = uniqueSheetName_(spreadsheet, '提出一覧_' + title + '_' + paperFlowCompactTimestamp_(new Date(importedAt)));
  var sheet = spreadsheet.insertSheet(name);
  sheet.getRange(1, 1, padded.length, width).setValues(padded);
  try {
    sheet.getRange(1, 1, 1, width).setFontWeight('bold');
    sheet.getRange(4, 1, 1, width).setFontWeight('bold');
  } catch (error) { /* 書式は任意 */ }
  return {
    name: name,
    studentCount: studentList.length,
    submitted: summary.submitted,
    missing: summary.missing
  };
}

function buildUnclassifiedSheet_(spreadsheet, reviews, importedAt) {
  var rows = [];
  rows.push(['配布物', '未分類（対応表で特定できませんでした）']);
  rows.push(['取り込み日時', importedAt]);
  rows.push([]);
  rows.push(['要確認', '種別', 'トークン', 'ページ', '元ファイル', '理由']);
  reviews.forEach(function(review) {
    rows.push(['', reviewLabel_(review.kind), review.token, review.page, review.sourceFile, review.note]);
  });
  var width = 6;
  var padded = rows.map(function(row) { return padRow_(row, width); });
  var name = uniqueSheetName_(spreadsheet, '提出一覧_' + PAPERFLOW_LEDGER_TAB_UNCLASSIFIED + '_' + paperFlowCompactTimestamp_(new Date(importedAt)));
  var sheet = spreadsheet.insertSheet(name);
  sheet.getRange(1, 1, padded.length, width).setValues(padded);
  try { sheet.getRange(1, 1, 1, width).setFontWeight('bold'); } catch (error) { /* 書式は任意 */ }
  return { name: name };
}
