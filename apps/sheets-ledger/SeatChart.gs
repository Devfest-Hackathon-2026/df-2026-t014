/**
 * 座席表タブ。
 *
 * 正本は名簿タブの「座席の行」「座席の列」。座席表はその配置図ビュー兼エディタで、
 * セルへの入力（編集トリガー）を名簿へ書き戻す。名簿側の直接編集も座席表へ反映する。
 *
 * シートの固定位置:
 *   1行目 = タイトル、2行目 = 説明（グリッド外の生徒の警告もここ）、3行目 = 列番号、
 *   4行目以降のB列以降 = 席。席(row, col) は (3+row, 1+col)。
 */

function seatChartLayout_(rows, cols) {
  return {
    rows: rows,
    cols: cols,
    titleRow: 1,
    infoRow: 2,
    headerRow: PAPERFLOW_SEAT_CHART_HEADER_ROW,
    firstDataRow: PAPERFLOW_SEAT_CHART_FIRST_DATA_ROW,
    firstDataCol: PAPERFLOW_SEAT_CHART_FIRST_DATA_COL,
    lastRow: PAPERFLOW_SEAT_CHART_HEADER_ROW + rows,
    lastColumn: PAPERFLOW_SEAT_CHART_FIRST_DATA_COL - 1 + cols
  };
}

function paperFlowSeatDisplay_(student) {
  return String(student.number) + ' ' + String(student.name);
}

function seatChartCellText_(students) {
  if (!students || !students.length) return '';
  return students.slice()
    .sort(function(a, b) {
      return a.number - b.number || String(a.studentId).localeCompare(String(b.studentId));
    })
    .map(paperFlowSeatDisplay_)
    .join('\n');
}

function isSeatInsideGrid_(seat, rows, cols) {
  return !!(seat && isIntegral_(seat.row) && isIntegral_(seat.col) &&
    seat.row >= 1 && seat.col >= 1 && seat.row <= rows && seat.col <= cols);
}

function isSeatOutsideGrid_(seat, rows, cols) {
  return !!(seat && isIntegral_(seat.row) && isIntegral_(seat.col) &&
    (seat.row > rows || seat.col > cols));
}

function normalizeSeatChartInput_(value) {
  return String(value === null || value === undefined ? '' : value)
    .normalize('NFKC')
    .replace(/[\s　]+/g, ' ')
    .trim();
}

function normalizeSeatName_(value) {
  return String(value === null || value === undefined ? '' : value)
    .normalize('NFKC')
    .replace(/[\s　]+/g, '');
}

/**
 * セル入力を生徒へ解決する。
 * 1. 出席番号の完全一致（全角数字は正規化）
 * 2. 氏名の前方一致。候補が1人だけなら確定。
 * 表示形式「3 田中大希」で貼り付け直した場合も出席番号として扱う。
 */
function resolveTABANESeatInput_(value, students) {
  var list = students || [];
  var text = normalizeSeatChartInput_(value);
  if (!text) return { status: 'none', candidates: [], by: 'empty' };

  var numberMatch = text.match(/^(\d{1,3})$/);
  if (!numberMatch) numberMatch = text.match(/^(\d{1,3})[ ](.+)$/);
  if (numberMatch) {
    var number = Number(numberMatch[1]);
    var byNumber = list.filter(function(student) { return Number(student.number) === number; });
    if (byNumber.length === 1) return { status: 'matched', student: byNumber[0], candidates: byNumber, by: 'number' };
    if (byNumber.length > 1) return { status: 'ambiguous', candidates: byNumber, by: 'number' };
    // 番号が該当しないときは氏名の前方一致へ進む。
  }

  var needle = normalizeSeatName_(text);
  if (!needle) return { status: 'none', candidates: [], by: 'name' };
  var candidates = list.filter(function(student) {
    return normalizeSeatName_(student.name).indexOf(needle) === 0;
  });
  if (candidates.length === 1) return { status: 'matched', student: candidates[0], candidates: candidates, by: 'name' };
  if (candidates.length > 1) return { status: 'ambiguous', candidates: candidates, by: 'name' };
  return { status: 'none', candidates: [], by: 'name' };
}

/** 名簿が空でも落ちない読み取り。名簿に問題があれば例外を投げ、呼び出し側で知らせる。 */
function readRosterStudentsForSeatChart_(rosterSheet) {
  var lastRow = rosterSheet.getLastRow();
  var lastColumn = Math.max(rosterSheet.getLastColumn(), 1);
  if (lastRow < 1) return { students: [], values: [], header: null, lastColumn: lastColumn };
  var values = rosterSheet.getRange(1, 1, lastRow, lastColumn).getValues();
  var header = detectRosterHeader_(values);
  if (!header) return { students: [], values: values, header: null, lastColumn: lastColumn };
  if (values.length <= header.rowIndex + 1)
    return { students: [], values: values, header: header, lastColumn: lastColumn };
  var parsed = parseRosterValues_(values);
  return { students: parsed.students, values: values, header: header, lastColumn: lastColumn };
}

function findRosterSheetRow_(values, header, number) {
  if (!header || header.rowIndex === undefined) return -1;
  for (var i = header.rowIndex + 1; i < values.length; i += 1) {
    if (toPositiveInt_((values[i] || [])[header.columns.number]) === Number(number)) return i + 1;
  }
  return -1;
}

/** 値が変わらないときは書かない（編集トリガーの連鎖を避ける）。 */
function setValueIfChanged_(range, value) {
  var next = value === undefined || value === null ? '' : value;
  var current = range.getValue();
  var currentText = current === null || current === undefined ? '' : String(current);
  if (currentText === String(next)) return false;
  range.setValue(next);
  return true;
}

function seatChartRange_(seatSheet, layout, row, col) {
  return seatSheet.getRange(layout.firstDataRow + row - 1, layout.firstDataCol + col - 1);
}

function writeSeatChartCell_(seatSheet, layout, row, col, text) {
  if (row < 1 || col < 1 || row > layout.rows || col > layout.cols) return;
  var range = seatChartRange_(seatSheet, layout, row, col);
  setValueIfChanged_(range, text || '');
  try { range.setBackground(null); } catch (error) { /* 書式は任意 */ }
  try { range.setNote(''); } catch (error) { /* 書式は任意 */ }
}

function markSeatChartCell_(seatSheet, layout, row, col, note) {
  if (row < 1 || col < 1 || row > layout.rows || col > layout.cols) return;
  var range = seatChartRange_(seatSheet, layout, row, col);
  try { range.setBackground('#f9d2d2'); } catch (error) { /* 書式は任意 */ }
  try { range.setNote(String(note || '').slice(0, 500)); } catch (error) { /* 書式は任意 */ }
}

function readSeatChartGrid_(seatSheet, layout) {
  if (!seatSheet) return [];
  return seatSheet.getRange(layout.firstDataRow, layout.firstDataCol, layout.rows, layout.cols).getValues();
}

/** 同じ生徒の確定表示が、対象セル以外のどこかにあるか（重複検出）。 */
function findSeatChartDuplicateCells_(seatSheet, layout, student, excludeRow, excludeCol) {
  var values = readSeatChartGrid_(seatSheet, layout);
  var target = paperFlowSeatDisplay_(student);
  var found = [];
  for (var r = 0; r < values.length; r += 1) {
    for (var c = 0; c < values[r].length; c += 1) {
      var lines = String(values[r][c] === null || values[r][c] === undefined ? '' : values[r][c]).split('\n');
      if (lines.indexOf(target) === -1) continue;
      if (r + 1 === excludeRow && c + 1 === excludeCol) continue;
      found.push({ row: r + 1, col: c + 1 });
    }
  }
  return found;
}

function renderSeatChartCell_(seatSheet, layout, students, row, col) {
  if (row < 1 || col < 1 || row > layout.rows || col > layout.cols) return;
  var atSeat = (students || []).filter(function(student) {
    return student.seat && student.seat.row === row && student.seat.col === col;
  });
  writeSeatChartCell_(seatSheet, layout, row, col, seatChartCellText_(atSeat));
}

function paperFlowToast_(message) {
  try {
    var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    if (spreadsheet && spreadsheet.toast)
      spreadsheet.toast(String(message).slice(0, 220), PAPERFLOW_SEAT_CHART_TITLE, 5);
  } catch (error) { /* 通知できなくても処理は続ける */ }
}

/** 座席表の値を組み立てる（テストと描画で共用）。 */
function buildSeatChartValues_(students, layout, infoText) {
  var values = [];
  for (var r = 0; r < layout.lastRow; r += 1) {
    var row = [];
    for (var c = 0; c < layout.lastColumn; c += 1) row.push('');
    values.push(row);
  }
  values[0][0] = PAPERFLOW_SEAT_CHART_TITLE;
  values[layout.infoRow - 1][0] = infoText || '';
  values[layout.headerRow - 1][0] = '席';
  for (var col = 1; col <= layout.cols; col += 1)
    values[layout.headerRow - 1][col] = col;
  for (var gridRow = 1; gridRow <= layout.rows; gridRow += 1) {
    values[layout.headerRow + gridRow - 1][0] = gridRow;
  }
  var seats = {};
  (students || []).forEach(function(student) {
    if (!isSeatInsideGrid_(student.seat, layout.rows, layout.cols)) return;
    var key = student.seat.row + '|' + student.seat.col;
    if (!seats[key]) seats[key] = [];
    seats[key].push(student);
  });
  Object.keys(seats).forEach(function(key) {
    var parts = key.split('|');
    var seatRow = Number(parts[0]);
    var seatCol = Number(parts[1]);
    values[layout.headerRow + seatRow - 1][seatCol] = seatChartCellText_(seats[key]);
  });
  return values;
}

/**
 * 座席表を描き直す。グリッド外の生徒は描けないため、2行目の説明と戻り値で知らせる。
 */
function drawTABANESeatChart_(spreadsheet, rosterSheet, students, settings) {
  if (!spreadsheet) throw new Error('台帳スプレッドシートを開いてから実行してください。');
  var sheet = spreadsheet.getSheetByName(PAPERFLOW_LEDGER_TAB_SEATS);
  if (!sheet)
    throw new Error('「' + PAPERFLOW_LEDGER_TAB_SEATS + '」タブがありません。メニューの「初期設定」を実行してください。');
  var rows = settings && isIntegral_(settings.seatGridRows) ? settings.seatGridRows : PAPERFLOW_SEAT_GRID_DEFAULT_ROWS;
  var cols = settings && isIntegral_(settings.seatGridCols) ? settings.seatGridCols : PAPERFLOW_SEAT_GRID_DEFAULT_COLS;
  var layout = seatChartLayout_(rows, cols);
  var outside = (students || []).filter(function(student) {
    return isSeatOutsideGrid_(student.seat, rows, cols);
  });
  var info = 'セルに出席番号（例: 3）または氏名の途中まで（例: 田中）を入力すると、名簿の座席を記録します。名簿タブの行・列が正本です。';
  if (outside.length) {
    info += ' グリッド外の生徒 ' + outside.length + '人: ' +
      outside.slice(0, 10).map(paperFlowSeatDisplay_).join('、') +
      (outside.length > 10 ? ' ほか' : '') +
      '（設定でグリッドを広げるか、名簿の行・列を直してください）';
  }
  var values = buildSeatChartValues_(students, layout, info);

  try {
    var oldLastRow = Math.max(sheet.getLastRow(), layout.lastRow);
    var oldLastColumn = Math.max(sheet.getLastColumn(), layout.lastColumn);
    sheet.getRange(1, 1, oldLastRow, oldLastColumn).breakApart();
  } catch (error) { /* 結合解除できない環境でも続ける */ }
  try { sheet.clear(); } catch (error) { /* 書式は任意 */ }
  sheet.getRange(1, 1, layout.lastRow, layout.lastColumn).setValues(values);

  try {
    var titleRange = sheet.getRange(1, 1, 1, layout.lastColumn);
    titleRange.merge();
    titleRange.setFontWeight('bold').setFontSize(16).setHorizontalAlignment('center');
  } catch (error) { /* 書式は任意 */ }
  try {
    var infoRange = sheet.getRange(layout.infoRow, 1, 1, layout.lastColumn);
    infoRange.merge();
    infoRange.setFontSize(9).setForegroundColor('#5d6b63').setWrap(true);
  } catch (error) { /* 書式は任意 */ }
  try {
    sheet.getRange(layout.headerRow, 1, 1, layout.lastColumn).setFontWeight('bold').setHorizontalAlignment('center').setBackground('#e6efe9');
    sheet.getRange(layout.headerRow + 1, 1, layout.rows, 1).setFontWeight('bold').setHorizontalAlignment('center').setBackground('#e6efe9');
    sheet.getRange(layout.headerRow, 1, layout.rows + 1, layout.lastColumn).setBorder(true, true, true, true, true, true);
    var dataRange = sheet.getRange(layout.firstDataRow, layout.firstDataCol, layout.rows, layout.cols);
    dataRange.setWrap(true).setHorizontalAlignment('center').setVerticalAlignment('middle').setNumberFormat('@');
  } catch (error) { /* 書式は任意 */ }
  try {
    sheet.setColumnWidth(1, 34);
    for (var col = 2; col <= layout.lastColumn; col += 1) sheet.setColumnWidth(col, 120);
    sheet.setRowHeight(1, 34);
    sheet.setRowHeight(layout.infoRow, outside.length ? 48 : 32);
    sheet.setRowHeight(layout.headerRow, 24);
    for (var row = layout.firstDataRow; row <= layout.lastRow; row += 1) sheet.setRowHeight(row, 56);
    if (sheet.setHiddenGridlines) sheet.setHiddenGridlines(true);
  } catch (error) { /* 書式は任意 */ }

  var placed = (students || []).length - outside.length;
  return {
    rows: rows,
    cols: cols,
    placed: placed,
    outside: outside,
    message: [
      '座席表を ' + rows + '行×' + cols + '列で描きました。',
      '配置した生徒: ' + placed + '人',
      outside.length
        ? 'グリッド外の生徒: ' + outside.length + '人（' + outside.slice(0, 10).map(paperFlowSeatDisplay_).join('、') + (outside.length > 10 ? ' ほか' : '') + '）'
        : ''
    ].filter(Boolean).join('\n')
  };
}

function ensureSeatChartSheet_(spreadsheet, rosterSheet, created, kept) {
  var name = PAPERFLOW_LEDGER_TAB_SEATS;
  var sheet = spreadsheet.getSheetByName(name);
  if (sheet) {
    kept.push(name);
    return { sheet: sheet, created: false };
  }
  sheet = spreadsheet.insertSheet(name);
  created.push(name);
  var settings = readTABANELedgerSettings_();
  var students = [];
  if (rosterSheet) {
    try { students = readRosterStudentsForSeatChart_(rosterSheet).students; }
    catch (error) { students = []; }
  }
  drawTABANESeatChart_(spreadsheet, rosterSheet, students, settings);
  return { sheet: sheet, created: true };
}

/** メニュー・設定変更後の再描画。名簿側が別スプレッドシートでも読む。 */
function redrawTABANESeatChart_() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error('台帳スプレッドシートを開いてから実行してください。');
  var settings = readTABANELedgerSettings_();
  var source = spreadsheet;
  if (settings.rosterSpreadsheetUrl) source = openLedgerSpreadsheet_(settings.rosterSpreadsheetUrl);
  var rosterSheet = findRosterSheet_(source, settings.rosterSheetName);
  if (!rosterSheet)
    throw new Error('名簿タブがありません。メニューの「初期設定」を実行するか、設定で名簿の参照先を指定してください。');
  var rosterError = '';
  var students = [];
  try {
    students = readRosterStudentsForSeatChart_(rosterSheet).students;
  } catch (error) {
    rosterError = String(error && error.message ? error.message : error);
  }
  var result = drawTABANESeatChart_(spreadsheet, rosterSheet, students, settings);
  if (rosterError) {
    result.message += '\n名簿を読めませんでした: ' + rosterError;
    result.rosterError = rosterError;
  }
  return result;
}

function redrawTABANESeatChart() {
  return redrawTABANESeatChart_();
}

/** 設定ダイアログの保存後に、グリッド外の生徒がいないかを知らせる。 */
function getTABANESeatChartStatus() {
  var settings = readTABANELedgerSettings_();
  var status = {
    rows: settings.seatGridRows,
    cols: settings.seatGridCols,
    outside: [],
    message: ''
  };
  try {
    var source = SpreadsheetApp.getActiveSpreadsheet();
    if (!source) return status;
    if (settings.rosterSpreadsheetUrl) source = openLedgerSpreadsheet_(settings.rosterSpreadsheetUrl);
    var rosterSheet = findRosterSheet_(source, settings.rosterSheetName);
    if (!rosterSheet) return status;
    var students = readRosterStudentsForSeatChart_(rosterSheet).students;
    status.outside = students.filter(function(student) {
      return isSeatOutsideGrid_(student.seat, settings.seatGridRows, settings.seatGridCols);
    }).map(paperFlowSeatDisplay_);
    status.message = status.outside.length
      ? 'グリッド外の生徒が' + status.outside.length + '人います: ' + status.outside.join('、')
      : 'すべての生徒がグリッド内に収まっています。';
  } catch (error) {
    status.message = '名簿を読めませんでした: ' + String(error && error.message ? error.message : error);
  }
  return status;
}

/** 名簿から座席の行・列を書き換える。列がなければ末尾に足す。 */
function writeRosterSeat_(rosterSheet, loaded, student, seat) {
  var columns = loaded.header ? loaded.header.columns : null;
  var lastColumn = loaded.lastColumn || Math.max(rosterSheet.getLastColumn(), 1);
  if (!columns || columns.seatRow === -1 || columns.seatCol === -1) {
    var headerRowIndex = loaded.header ? loaded.header.rowIndex : 0;
    var headerRow = ((loaded.values || [])[headerRowIndex] || []).slice(0, lastColumn).map(normalizeHeader_);
    var appended = appendMissingRosterHeaders_(rosterSheet, lastColumn, headerRow, headerRowIndex + 1);
    lastColumn = appended.lastColumn;
    columns = detectRosterColumns_(appended.headerRow);
    if (loaded.header) loaded.header.columns = columns;
    loaded.lastColumn = lastColumn;
  }
  var rowNumber = findRosterSheetRow_(loaded.values, loaded.header, student.number);
  if (rowNumber === -1) throw new Error('名簿タブに出席番号' + student.number + 'の行が見つかりません。');
  if (columns.seatRow === -1 || columns.seatCol === -1)
    throw new Error('名簿タブに「座席の行」「座席の列」を用意できませんでした。');
  setValueIfChanged_(rosterSheet.getRange(rowNumber, columns.seatRow + 1), seat ? seat.row : '');
  setValueIfChanged_(rosterSheet.getRange(rowNumber, columns.seatCol + 1), seat ? seat.col : '');
  // 「座席」1列形式の名簿でも解除・移動が効くよう、併記列もそろえる。
  if (columns.seat !== -1) {
    setValueIfChanged_(
      rosterSheet.getRange(rowNumber, columns.seat + 1),
      seat ? seat.row + '行' + seat.col + '列' : ''
    );
  }
}

function loadSeatChartRoster_(spreadsheet, settings) {
  var source = spreadsheet;
  if (settings.rosterSpreadsheetUrl) source = openLedgerSpreadsheet_(settings.rosterSpreadsheetUrl);
  var rosterSheet = findRosterSheet_(source, settings.rosterSheetName);
  if (!rosterSheet)
    throw new Error('名簿タブがありません。メニューの「初期設定」を実行するか、設定で名簿の参照先を指定してください。');
  return { sheet: rosterSheet, loaded: readRosterStudentsForSeatChart_(rosterSheet) };
}

/**
 * 座席表のセル編集。入力から生徒を解決し、名簿へ記録する。
 * 未確定・重複のときは記録せず、セルを赤くしてメモを残す。
 */
function handleTABANESeatChartEdit_(spreadsheet, seatSheet, range) {
  if (!range || !range.getRow) return;
  var settings = readTABANELedgerSettings_();
  var layout = seatChartLayout_(settings.seatGridRows, settings.seatGridCols);
  var row = range.getRow();
  var column = range.getColumn();
  var numRows = range.getNumRows ? range.getNumRows() : 1;
  var numCols = range.getNumColumns ? range.getNumColumns() : 1;
  if (row < layout.firstDataRow || column < layout.firstDataCol) return;
  var seatRow = row - layout.firstDataRow + 1;
  var seatCol = column - layout.firstDataCol + 1;
  if (seatRow > layout.rows || seatCol > layout.cols) return;

  var roster = loadSeatChartRoster_(spreadsheet, settings);
  var rosterSheet = roster.sheet;
  var loaded = roster.loaded;
  if (!loaded.header) {
    paperFlowToast_('名簿タブの見出しを確認できません。座席を記録しませんでした。');
    return;
  }
  var students = loaded.students;

  if (numRows > 1 || numCols > 1) {
    drawTABANESeatChart_(spreadsheet, rosterSheet, students, settings);
    paperFlowToast_('複数セルの入力は座席に反映しません。1セルずつ入力してください。');
    return;
  }

  var text = cellText_(range.getValue());
  var atSeat = students.filter(function(student) {
    return student.seat && student.seat.row === seatRow && student.seat.col === seatCol;
  });

  if (!text) {
    atSeat.forEach(function(student) {
      writeRosterSeat_(rosterSheet, loaded, student, null);
      student.seat = null;
    });
    writeSeatChartCell_(seatSheet, layout, seatRow, seatCol, '');
    if (atSeat.length) paperFlowToast_(atSeat.length + '人の座席を解除しました（' + seatRow + '行' + seatCol + '列）。');
    return;
  }

  var resolution = resolveTABANESeatInput_(text, students);
  if (resolution.status === 'ambiguous') {
    var names = resolution.candidates.map(paperFlowSeatDisplay_).join('、');
    markSeatChartCell_(seatSheet, layout, seatRow, seatCol, '候補が' + resolution.candidates.length + '人います: ' + names + '。出席番号で入力してください。');
    paperFlowToast_('候補が' + resolution.candidates.length + '人います。出席番号で入力してください。');
    return;
  }
  if (resolution.status !== 'matched') {
    markSeatChartCell_(seatSheet, layout, seatRow, seatCol, '該当する生徒がいません。出席番号か氏名の途中までを入力してください。');
    paperFlowToast_('該当する生徒がいません。座席を記録しませんでした。');
    return;
  }

  var student = resolution.student;
  var duplicates = findSeatChartDuplicateCells_(seatSheet, layout, student, seatRow, seatCol);
  var currentSeat = student.seat;
  var consistentWithRoster = duplicates.length === 1 && currentSeat &&
    duplicates[0].row === currentSeat.row && duplicates[0].col === currentSeat.col;
  if (duplicates.length && !consistentWithRoster) {
    markSeatChartCell_(seatSheet, layout, seatRow, seatCol, '同じ生徒が複数のセルにあります。座席を記録していません。');
    duplicates.forEach(function(position) {
      markSeatChartCell_(seatSheet, layout, position.row, position.col, '同じ生徒が複数のセルにあります。名簿の座席を確認してください。');
    });
    paperFlowToast_(paperFlowSeatDisplay_(student) + ' が複数のセルにあります。座席を記録しませんでした。');
    return;
  }

  var oldSeat = currentSeat ? { row: currentSeat.row, col: currentSeat.col } : null;
  writeRosterSeat_(rosterSheet, loaded, student, { row: seatRow, col: seatCol });
  student.seat = { row: seatRow, col: seatCol };
  renderSeatChartCell_(seatSheet, layout, students, seatRow, seatCol);
  if (oldSeat && (oldSeat.row !== seatRow || oldSeat.col !== seatCol))
    renderSeatChartCell_(seatSheet, layout, students, oldSeat.row, oldSeat.col);
  paperFlowToast_(
    (oldSeat ? '移動しました: ' : '座席を記録しました: ') +
    paperFlowSeatDisplay_(student) + ' → ' + seatRow + '行' + seatCol + '列'
  );
}

/** 名簿タブ側の直接編集を座席表へ反映する（名簿が台帳本体にある場合）。 */
function handleTABANERosterEdit_(spreadsheet, settings) {
  var rosterSheet = spreadsheet.getSheetByName(settings.rosterSheetName || PAPERFLOW_DEFAULT_ROSTER_SHEET);
  if (!rosterSheet) return;
  var loaded;
  try {
    loaded = readRosterStudentsForSeatChart_(rosterSheet);
  } catch (error) {
    paperFlowToast_('名簿を読めません: ' + String(error && error.message ? error.message : error));
    return;
  }
  if (!loaded.header) return;
  var result = drawTABANESeatChart_(spreadsheet, rosterSheet, loaded.students, settings);
  if (result.outside.length) {
    paperFlowToast_('グリッド外の生徒が' + result.outside.length + '人います。座席表の2行目を確認してください。');
  }
}

/**
 * 編集トリガー。座席表のセル入力と、名簿タブの直接編集の両方を扱う。
 * スクリプト自身の書き込みでは編集トリガーが動かないため、値が変わらない書き込みも避けている。
 */
function onEdit(e) {
  try {
    if (!e || !e.range) return;
    var spreadsheet = e.source || SpreadsheetApp.getActiveSpreadsheet();
    if (!spreadsheet) return;
    var range = e.range;
    var rangeSheet = range.getSheet ? range.getSheet() : null;
    var sheetName = rangeSheet && rangeSheet.getName ? rangeSheet.getName() : '';
    if (sheetName === PAPERFLOW_LEDGER_TAB_SEATS) {
      handleTABANESeatChartEdit_(spreadsheet, rangeSheet, range);
      return;
    }
    var settings = readTABANELedgerSettings_();
    if (settings.rosterSpreadsheetUrl) return;
    if (sheetName === (settings.rosterSheetName || PAPERFLOW_DEFAULT_ROSTER_SHEET))
      handleTABANERosterEdit_(spreadsheet, settings);
  } catch (error) {
    paperFlowToast_(String(error && error.message ? error.message : error));
  }
}
