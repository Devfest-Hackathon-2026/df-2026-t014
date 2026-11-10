/**
 * 名簿の読み取り。
 *
 * 名簿タブの見出しは列順を問わない。出席番号・氏名を必須とし、
 * あれば座席の行・列（または「3行2列」「3-2」形式の座席）とクラス名を読む。
 */

function findRosterSheet_(spreadsheet, sheetName) {
  var name = sheetName || PAPERFLOW_DEFAULT_ROSTER_SHEET;
  var named = spreadsheet.getSheetByName(name);
  if (named) return named;
  var sheets = spreadsheet.getSheets();
  if (sheets.length === 1) return sheets[0];
  return null;
}

function readRosterValues_(sheet) {
  var lastRow = sheet.getLastRow();
  var lastColumn = sheet.getLastColumn();
  if (lastRow < 2 || lastColumn < 2)
    throw new Error('「' + sheet.getName() + '」タブに見出し行と1人以上の名簿を用意してください。');
  if (lastRow > 2000 || lastColumn > 60)
    throw new Error('名簿タブは2000行・60列以内にしてください。途中で切り捨てて取り込みません。');
  return sheet.getRange(1, 1, lastRow, lastColumn).getValues();
}

/**
 * 見出し行から列を判定する。想定は
 * 出席番号 / 氏名 / （あれば）座席の行・列 / クラス名。列順は問わない。
 */
function detectRosterColumns_(row) {
  var columns = { number: -1, name: -1, studentId: -1, seatRow: -1, seatCol: -1, seat: -1, className: -1 };
  for (var i = 0; i < row.length; i += 1) {
    var header = normalizeHeader_(row[i]);
    if (!header) continue;
    if (header.indexOf('出席') !== -1) {
      if (columns.number === -1) columns.number = i;
      continue;
    }
    if (columns.number === -1 && (header === '番号' || header.indexOf('生徒番号') !== -1 || header === 'no' || header === 'no.' || header === 'number')) {
      columns.number = i;
      continue;
    }
    if (columns.studentId === -1 && (header === '生徒id' || header === 'studentid' || header === 'id' ||
      header === 'classroomid' || header === 'classroomuserid')) {
      columns.studentId = i;
      continue;
    }
    if (columns.name === -1 && header.indexOf('保護者') === -1 && header.indexOf('フリガナ') === -1 && header.indexOf('ふりがな') === -1 &&
      (header.indexOf('氏名') !== -1 || header.indexOf('名前') !== -1 || header.indexOf('生徒名') !== -1 || header === 'name')) {
      columns.name = i;
      continue;
    }
    if (columns.className === -1 && (header.indexOf('クラス') !== -1 || header === '組' || header === 'class' || header === 'classname')) {
      columns.className = i;
      continue;
    }
    if (header.indexOf('座席') !== -1 || header === '席' || header.indexOf('席次') !== -1) {
      if (header.indexOf('行') !== -1) columns.seatRow = columns.seatRow === -1 ? i : columns.seatRow;
      else if (header.indexOf('列') !== -1) columns.seatCol = columns.seatCol === -1 ? i : columns.seatCol;
      else if (columns.seat === -1) columns.seat = i;
      continue;
    }
    if (columns.seatRow === -1 && (header === '行' || header === 'row' || header === 'seatrow')) { columns.seatRow = i; continue; }
    if (columns.seatCol === -1 && (header === '列' || header === 'col' || header === 'column' || header === 'seatcol')) { columns.seatCol = i; continue; }
  }
  return columns;
}

function parseSeat_(row, columns) {
  var seatRow = columns.seatRow === -1 ? null : toPositiveInt_(row[columns.seatRow]);
  var seatCol = columns.seatCol === -1 ? null : toPositiveInt_(row[columns.seatCol]);
  if (seatRow !== null && seatCol !== null) return { row: seatRow, col: seatCol };
  if (columns.seat === -1) return null;
  var combined = row[columns.seat];
  if (typeof combined !== 'string' && typeof combined !== 'number') return null;
  var text = String(combined).normalize('NFKC').replace(/[　\s]/g, '');
  var match = text.match(/^(\d{1,2})行(\d{1,2})列$/) || text.match(/^(\d{1,2})[-ー−–/／,，](\d{1,2})$/);
  if (!match) return null;
  var parsedRow = toPositiveInt_(match[1]);
  var parsedCol = toPositiveInt_(match[2]);
  if (parsedRow === null || parsedCol === null) return null;
  return { row: parsedRow, col: parsedCol };
}

/** 名簿の見出し行を先頭10行から探す。見つからなければ null。 */
function detectRosterHeader_(values) {
  var limit = Math.min(values.length, 10);
  for (var i = 0; i < limit; i += 1) {
    var candidate = detectRosterColumns_(values[i] || []);
    if (candidate.number !== -1 && candidate.name !== -1)
      return { rowIndex: i, columns: candidate };
  }
  return null;
}

function parseRosterValues_(values) {
  if (!Array.isArray(values) || values.length < 2)
    throw new Error('名簿タブの見出しと名簿の行を確認してください。');
  var header = detectRosterHeader_(values);
  if (!header)
    throw new Error('名簿タブの見出し行に「出席番号」と「氏名」の列が必要です。');
  var headerRowIndex = header.rowIndex;
  var columns = header.columns;

  var students = [];
  var seenNumbers = {};
  var seenIds = {};
  for (var rowIndex = headerRowIndex + 1; rowIndex < values.length; rowIndex += 1) {
    var row = values[rowIndex] || [];
    var name = row[columns.name] === null || row[columns.name] === undefined ? '' : String(row[columns.name]).trim();
    var rawNumber = row[columns.number];
    if (!name && (rawNumber === '' || rawNumber === null || rawNumber === undefined)) continue;
    var number = toPositiveInt_(rawNumber);
    if (number === null)
      throw new Error((rowIndex + 1) + '行目の出席番号を確認してください。数値の出席番号が必要です。');
    if (number < 1 || number > 999)
      throw new Error((rowIndex + 1) + '行目の出席番号は1〜999で指定してください。');
    if (!name)
      throw new Error((rowIndex + 1) + '行目の氏名が空です。');
    if (seenNumbers[number])
      throw new Error('出席番号' + number + 'が重複しています。名簿を確認してください。');
    seenNumbers[number] = true;
    var customId = columns.studentId === -1 || row[columns.studentId] === null || row[columns.studentId] === undefined
      ? '' : String(row[columns.studentId]).trim();
    var studentId = customId || defaultTABANEStudentId_(number);
    if (seenIds[studentId]) throw new Error('生徒IDが重複しています。名簿を確認してください。');
    seenIds[studentId] = true;
    students.push({
      studentId: studentId,
      number: number,
      name: name.slice(0, 120),
      seat: parseSeat_(row, columns),
      className: columns.className === -1 || row[columns.className] === null || row[columns.className] === undefined
        ? '' : String(row[columns.className]).trim().slice(0, 120)
    });
  }
  if (!students.length) throw new Error('名簿タブに生徒が1人もいません。');
  return { students: students, headerRowNumber: headerRowIndex + 1 };
}

/** 生徒ID未指定のときの従来の決め方（出席番号由来）。 */
function defaultTABANEStudentId_(number) {
  return 'n' + ('000' + number).slice(-3);
}

/**
 * 印刷の並び順（確定版）。
 * 1. 座席のある生徒を先に、行→列の昇順
 * 2. 座席のない生徒を後ろに、出席番号の昇順
 * 3. 全員に座席がなければ出席番号順
 * 4. 同じ行・列は出席番号で安定させる（エラーにしない）
 */
function orderStudentsForIssuance_(students) {
  var list = students.slice();
  list.sort(function(a, b) {
    var aSeated = !!(a.seat && isIntegral_(a.seat.row) && isIntegral_(a.seat.col));
    var bSeated = !!(b.seat && isIntegral_(b.seat.row) && isIntegral_(b.seat.col));
    if (aSeated !== bSeated) return aSeated ? -1 : 1;
    if (aSeated) {
      var bySeat = a.seat.row - b.seat.row || a.seat.col - b.seat.col;
      if (bySeat) return bySeat;
    }
    return a.number - b.number || String(a.studentId).localeCompare(String(b.studentId));
  });
  return list;
}

/** 設定された名簿用スプレッドシート（未設定なら台帳本体）から名簿を読む。 */
function loadTABANERoster_(settings) {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var source = spreadsheet;
  if (settings && settings.rosterSpreadsheetUrl) source = openLedgerSpreadsheet_(settings.rosterSpreadsheetUrl);
  var sheet = findRosterSheet_(source, settings && settings.rosterSheetName);
  if (!sheet)
    throw new Error('名簿タブがありません。名簿タブを1つ用意するか、設定で名簿の参照先を指定してください。');
  var roster = parseRosterValues_(readRosterValues_(sheet));
  return { roster: roster, sheetName: sheet.getName(), spreadsheetId: source.getId() };
}

var PAPERFLOW_ROSTER_CSV_MESSAGE = '名簿CSVは1行目に見出し、必須列「出席番号」「氏名」、任意列「生徒ID」「行」「列」（1始まり）です。';

/**
 * 名簿CSVを読み、行ごとのエラーを集める。1件でもエラーがあれば呼び出し側で全体を止める。
 * 見出しの判定は名簿タブと同じ detectRosterColumns_ を使う。
 */
function parseTABANERosterCsv_(text) {
  var records = parseCsvText_(text);
  if (!records.length) throw new Error('CSVが空です。');
  var headerCells = records[0].cells.map(function(value) { return cellText_(value); });
  if (!headerCells.join('')) throw new Error('CSVの1行目に見出しがありません。' + PAPERFLOW_ROSTER_CSV_MESSAGE);
  var columns = detectRosterColumns_(headerCells);
  if (columns.number === -1 || columns.name === -1)
    throw new Error('名簿CSVの見出しに「出席番号」と「氏名」の列が必要です。' + PAPERFLOW_ROSTER_CSV_MESSAGE);

  var rows = [];
  var errors = [];
  var seenNumbers = {};
  var seenIds = {};
  for (var recordIndex = 1; recordIndex < records.length; recordIndex += 1) {
    var record = records[recordIndex];
    var cells = record.cells;
    var blank = true;
    for (var cellIndex = 0; cellIndex < cells.length; cellIndex += 1) {
      if (cellText_(cells[cellIndex])) { blank = false; break; }
    }
    if (blank) continue;

    var rowErrors = [];
    var name = cellText_(cells[columns.name]);
    var rawNumber = cells[columns.number];
    var number = toPositiveInt_(rawNumber);
    if (rawNumber === null || rawNumber === undefined || cellText_(rawNumber) === '') rowErrors.push('出席番号が空です');
    else if (number === null) rowErrors.push('出席番号が整数ではありません');
    else if (number < 1 || number > 999) rowErrors.push('出席番号は1〜999で指定してください');
    else if (seenNumbers[number]) rowErrors.push('出席番号' + number + 'が重複しています');
    if (!name) rowErrors.push('氏名が空です');

    var customId = '';
    if (columns.studentId !== -1) {
      customId = cellText_(cells[columns.studentId]).slice(0, 200);
    }
    var studentId = customId || (number === null ? '' : defaultTABANEStudentId_(number));
    if (studentId && seenIds[studentId]) rowErrors.push('生徒ID「' + studentId + '」が重複しています');

    var seat = null;
    if (columns.seatRow !== -1 || columns.seatCol !== -1) {
      var seatRowText = columns.seatRow === -1 ? '' : cellText_(cells[columns.seatRow]);
      var seatColText = columns.seatCol === -1 ? '' : cellText_(cells[columns.seatCol]);
      if (seatRowText || seatColText) {
        var seatRow = toPositiveInt_(seatRowText);
        var seatCol = toPositiveInt_(seatColText);
        if (seatRow === null || seatCol === null)
          rowErrors.push('座席の行・列は1以上の整数で指定してください');
        else seat = { row: seatRow, col: seatCol };
      }
    } else if (columns.seat !== -1 && cellText_(cells[columns.seat])) {
      seat = parseSeat_(cells, columns);
      if (!seat) rowErrors.push('座席は「3行2列」または「3-2」の形式で指定してください');
    }

    if (rowErrors.length) {
      errors.push({ rowNumber: record.line, reason: rowErrors.join(' / ') });
      continue;
    }
    seenNumbers[number] = true;
    seenIds[studentId] = true;
    rows.push({
      rowNumber: record.line,
      number: number,
      name: name.slice(0, 120),
      studentId: customId,
      seat: seat,
      className: columns.className === -1 ? '' : cellText_(cells[columns.className]).slice(0, 120)
    });
  }
  return { rows: rows, errors: errors, headerCells: headerCells };
}

function formatTABANERosterCsvErrors_(errors) {
  var lines = ['名簿CSVに' + errors.length + '件のエラーがあるため、取り込みませんでした。'];
  errors.slice(0, 5).forEach(function(error) {
    lines.push('・' + error.rowNumber + '行目: ' + error.reason);
  });
  if (errors.length > 5) lines.push('・ほか ' + (errors.length - 5) + '件');
  lines.push('CSVを直してからもう一度実行してください。');
  return lines.join('\n');
}

/** ダイアログの確認用。取り込みはせず、件数とエラーを返す。 */
function previewTABANERosterCsv(text) {
  var parsed = parseTABANERosterCsv_(text);
  var seated = parsed.rows.filter(function(row) { return !!row.seat; }).length;
  var withId = parsed.rows.filter(function(row) { return !!row.studentId; }).length;
  return {
    ok: parsed.rows.length > 0 && !parsed.errors.length,
    count: parsed.rows.length,
    errorCount: parsed.errors.length,
    errors: parsed.errors.slice(0, 5),
    seatedCount: seated,
    unseatedCount: parsed.rows.length - seated,
    studentIdCount: withId,
    message: parsed.errors.length
      ? formatTABANERosterCsvErrors_(parsed.errors)
      : '名簿 ' + parsed.rows.length + '人を読み取りました（座席あり ' + seated + '人 / 座席なし ' + (parsed.rows.length - seated) + '人 / 生徒IDあり ' + withId + '人）。'
  };
}

/**
 * 名簿CSVの内容で名簿タブのデータ行を置き換える（見出しは保持）。
 * エラー行が1件でもあれば全体を取り込まない。
 */
function importTABANERosterCsv(input) {
  var value = input || {};
  if (typeof value.text !== 'string' || !value.text.trim()) throw new Error('CSVファイルを選んでください。');
  var parsed = parseTABANERosterCsv_(value.text);
  if (parsed.errors.length) throw new Error(formatTABANERosterCsvErrors_(parsed.errors));
  if (!parsed.rows.length) throw new Error('取り込める名簿がありません。CSVに1人以上の名簿を入れてください。');
  if (value.confirmReplace !== true)
    throw new Error('名簿タブのデータ行を置き換える確認がありません。ダイアログから実行してください。');

  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error('台帳スプレッドシートを開いてから実行してください。');
  var settings = readTABANELedgerSettings_();
  var source = spreadsheet;
  if (settings.rosterSpreadsheetUrl) source = openLedgerSpreadsheet_(settings.rosterSpreadsheetUrl);
  var sheet = findRosterSheet_(source, settings.rosterSheetName);
  if (!sheet)
    throw new Error('名簿タブがありません。メニューの「初期設定」を実行するか、設定で名簿の参照先を指定してください。');

  var lastRow = sheet.getLastRow();
  if (lastRow < 1)
    throw new Error('名簿タブに見出し行がありません。メニューの「初期設定」を実行してください。');
  var lastColumn = Math.max(sheet.getLastColumn(), 1);
  var values = sheet.getRange(1, 1, lastRow, lastColumn).getValues();
  var header = detectRosterHeader_(values);
  if (!header)
    throw new Error('名簿タブの見出し行に「出席番号」と「氏名」の列がありません。メニューの「初期設定」で形式を確認してください。');
  var headerRowIndex = header.rowIndex;
  var headerRow = (values[headerRowIndex] || []).slice(0, lastColumn).map(normalizeHeader_);
  var appended = appendMissingRosterHeaders_(sheet, lastColumn, headerRow, headerRowIndex + 1);
  lastColumn = appended.lastColumn;
  if (appended.addedHeaders.length) {
    try { sheet.getRange(headerRowIndex + 1, 1, 1, lastColumn).setFontWeight('bold'); } catch (error) { /* 書式は任意 */ }
  }
  var columns = detectRosterColumns_(appended.headerRow);

  var firstDataRow = headerRowIndex + 2;
  var oldRowCount = lastRow - (headerRowIndex + 1);
  if (oldRowCount > 0)
    sheet.getRange(firstDataRow, 1, oldRowCount, lastColumn).clearContent();

  var rows = parsed.rows.map(function(row) {
    var cells = [];
    for (var i = 0; i < lastColumn; i += 1) cells.push('');
    cells[columns.number] = row.number;
    cells[columns.name] = row.name;
    if (columns.studentId !== -1) cells[columns.studentId] = row.studentId || '';
    if (row.seat) {
      if (columns.seatRow !== -1) cells[columns.seatRow] = row.seat.row;
      if (columns.seatCol !== -1) cells[columns.seatCol] = row.seat.col;
      if (columns.seat !== -1 && columns.seatRow === -1) cells[columns.seat] = row.seat.row + '行' + row.seat.col + '列';
    }
    if (columns.className !== -1) cells[columns.className] = row.className || '';
    return cells;
  });
  if (rows.length)
    sheet.getRange(firstDataRow, 1, rows.length, lastColumn).setValues(rows);
  try { sheet.getRange(firstDataRow, 1, rows.length, lastColumn).setNumberFormat('@'); } catch (formatError) { /* 書式は任意 */ }

  return {
    ok: true,
    fileName: cellText_(value.fileName) || 'roster.csv',
    students: rows.length,
    replacedRows: Math.max(0, oldRowCount),
    seatedCount: parsed.rows.filter(function(row) { return !!row.seat; }).length,
    message: [
      (cellText_(value.fileName) || 'roster.csv') + ' を読み取りました。',
      '名簿 ' + rows.length + '人でデータ行を置き換えました（元のデータ行 ' + Math.max(0, oldRowCount) + '行）。見出しは保持しています。',
      '座席あり ' + parsed.rows.filter(function(row) { return !!row.seat; }).length + '人。'
    ].join('\n')
  };
}
