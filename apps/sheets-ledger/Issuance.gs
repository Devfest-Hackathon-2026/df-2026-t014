/**
 * 台帳側の発行処理。
 *
 * 流れ:
 *   「QR発行」タブの入力を読む
 *   → 原稿DocをURLから開き、予約マーカーを検出
 *   → 名簿を並び順ルール（座席あり先→行・列、座席なしは出席番号順）で読む
 *   → 生徒1人につき1個のトークンを発行し、対応表へ逐次記録
 *   → QRをPNG化して印刷用Docを組み立て、PDFをDriveへ保存
 *   → 発行記録と「QR発行」タブの出力欄を更新
 *
 * 中断時は「発行記録」が完了以外のまま残る。発行済みトークンと作成済みの印刷用Docは
 * 同じjobIdで再開すると再利用する（トークンの二重発行・Docの作り直しをしない）。
 */

function readIssuanceForm_(spreadsheet) {
  var sheet = spreadsheet.getSheetByName(PAPERFLOW_LEDGER_TAB_ISSUE_FORM);
  if (!sheet)
    throw new Error('「' + PAPERFLOW_LEDGER_TAB_ISSUE_FORM + '」タブがありません。メニューの「初期設定」を実行してください。');
  // 旧レイアウトのまま発行すると出力欄が別の項目の隣に出るため、先に新レイアウトへ移行する。
  if (!issueFormLayoutMatches_(sheet)) writeIssueFormLayout_(sheet);
  var labels = sheet.getRange(2, 1, PAPERFLOW_ISSUE_FORM_INPUTS.length, 1).getValues()
    .map(function(row) { return String(row[0] === null || row[0] === undefined ? '' : row[0]).trim(); });
  PAPERFLOW_ISSUE_FORM_INPUTS.forEach(function(expected, index) {
    if (labels[index] !== expected)
      throw new Error('「QR発行」タブのA' + (index + 2) + 'は「' + expected + '」にしてください。行を移動した場合はメニューの「初期設定」でレイアウトを確認してください。');
  });
  var values = sheet.getRange(2, 2, PAPERFLOW_ISSUE_FORM_INPUTS.length, 1).getValues()
    .map(function(row) { return row[0]; });
  return {
    sheet: sheet,
    sourceDocumentUrl: cellText_(values[0]),
    title: cellText_(values[1])
  };
}

function cellText_(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

/** Web側 src/domain/logic.ts と同じ 32桁の16進小文字（UUID v4由来・約122bit）。 */
function createTABANEToken_() {
  var hex = '';
  while (hex.length < 32) hex += Utilities.getUuid().replace(/-/g, '').toLowerCase();
  return hex.slice(0, 32);
}

function createUniqueTABANEToken_(used) {
  for (var attempt = 0; attempt < 10; attempt += 1) {
    var token = createTABANEToken_();
    if (!used[token]) {
      used[token] = true;
      return token;
    }
  }
  throw new Error('安全なトークンを生成できませんでした。もう一度実行してください。');
}

function openSourceDocument_(value) {
  var id = documentIdFrom_(value);
  if (!id)
    throw new Error('「QR発行」タブの「原稿DocのURL」にGoogle DocsのURLを入力してください。');
  try {
    return DocumentApp.openById(id);
  } catch (error) {
    throw new Error('原稿Docを開けません。URL・共有・アクセス権を確認してください。');
  }
}

function inspectSourceDocument_(doc) {
  var tab = singleDocumentTab_(doc);
  var body = tab.getBody();
  var width = body.getPageWidth();
  var height = body.getPageHeight();
  if (typeof width !== 'number' || typeof height !== 'number' || !isFinite(width) || !isFinite(height))
    throw new Error('原稿の用紙サイズを確認できません。「ファイル → ページ設定」でA4縦を選んでください。');
  if (Math.abs(width - 595.28) > 2 || Math.abs(height - 841.89) > 2)
    throw new Error('原稿がA4縦ではありません。「ファイル → ページ設定」で全体をA4縦にしてください。');
  return { documentId: doc.getId(), tab: tab, body: body, width: width, height: height };
}

function findIssuanceRecord_(ledger, jobId) {
  var records = readLedgerRecords_(ledger, PAPERFLOW_ISSUE_HEADERS);
  for (var i = records.length - 1; i >= 0; i -= 1) {
    if (records[i].jobId === jobId) return records[i];
  }
  return null;
}

function findResumableIssuance_(ledger, sourceDocumentId) {
  var records = readLedgerRecords_(ledger, PAPERFLOW_ISSUE_HEADERS);
  for (var i = records.length - 1; i >= 0; i -= 1) {
    var record = records[i];
    if (record.sourceDocumentId === sourceDocumentId && record.status !== '完了') return record;
  }
  return null;
}

/** 既に保存済みのファイルを開く。権限がない・消えている場合は null。 */
function findReusableDriveFile_(id) {
  if (!id) return null;
  try {
    var file = DriveApp.getFileById(String(id));
    if (typeof file.isTrashed === 'function' && file.isTrashed()) return null;
    return file;
  } catch (error) {
    return null;
  }
}

/** 作成済みの印刷用Docを開き、PDFを作り直す（再開時にDocを作り直さないため）。 */
function renderPrintDocumentPdf_(documentId) {
  var doc = DocumentApp.openById(documentId);
  try {
    return doc.getAs('application/pdf');
  } finally {
    try { doc.saveAndClose(); } catch (closeError) { /* 既に閉じている場合は無視 */ }
  }
}

function issueTABANEQr(input) {
  var value = input || {};
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error('台帳スプレッドシートを開いてから実行してください。');
  var form = readIssuanceForm_(spreadsheet);
  try {
    writeIssuanceFormOutputs_(form.sheet, {
      issuedAt: new Date().toISOString(),
      studentCount: '',
      status: '生成中',
      note: '',
      pdfUrl: '',
      documentUrl: ''
    });
  } catch (formError) {
    /* 表示欄が書けなくても発行自体は続ける */
  }
  var settings = readTABANELedgerSettings_();

  var source = openSourceDocument_(value.sourceDocumentUrl || form.sourceDocumentUrl);
  var preflight = inspectSourceDocument_(source);
  var reservation = getQrReservationFromDocument_(source);

  var issueLedger = ensureLedgerSheet_(spreadsheet, PAPERFLOW_LEDGER_TAB_ISSUES, PAPERFLOW_ISSUE_HEADERS);
  var tokenLedger = ensureLedgerSheet_(spreadsheet, PAPERFLOW_LEDGER_TAB_TOKENS, PAPERFLOW_TOKEN_HEADERS);

  var resumeJob = null;
  if (value.resumeJobId) {
    if (typeof value.resumeJobId !== 'string' || !/^[a-f0-9]{32}$/.test(value.resumeJobId))
      throw new Error('再開する発行記録のIDが正しくありません。');
    resumeJob = findIssuanceRecord_(issueLedger, value.resumeJobId);
    if (!resumeJob) throw new Error('再開する発行記録が台帳に見つかりません。');
    if (resumeJob.sourceDocumentId !== preflight.documentId)
      throw new Error('別の原稿Docの発行記録は再開できません。元の原稿DocのURLを確認してください。');
    if (resumeJob.status === '完了') throw new Error('この発行は既に完了しています。');
  } else {
    // 同じ原稿の未完了ジョブがあれば、入力を変えずにその続きから再開する。
    resumeJob = findResumableIssuance_(issueLedger, preflight.documentId);
  }

  var title = form.title;
  if (!title) throw new Error('「配布物名」を入力してください。');
  if (title.length > 80) throw new Error('配布物名は80文字以内にしてください。');

  var rosterLoad = loadTABANERoster_(settings);
  var roster = rosterLoad.roster;
  var students = orderStudentsForIssuance_(roster.students);
  if (students.length > PAPERFLOW_MAX_STUDENTS)
    throw new Error('一度に発行できるのは' + PAPERFLOW_MAX_STUDENTS + '人までです。名簿を分けてください。');

  var now = new Date().toISOString();
  var layoutMode = reservation ? 'reserved-corner' : 'management-band';
  var bandHeightPt = reservation ? reservation.bandHeightPt : settings.qrBandHeightPt;
  if (!isIntegral_(bandHeightPt) || bandHeightPt < PAPERFLOW_MIN_QR_BAND_HEIGHT_PT || bandHeightPt > PAPERFLOW_MAX_QR_BAND_HEIGHT_PT)
    bandHeightPt = PAPERFLOW_DEFAULT_QR_BAND_HEIGHT_PT;
  var qrCorner = reservation ? reservation.corner : settings.qrCorner;

  var job = resumeJob;
  var issueRowNumber;
  if (!job) {
    job = {
      jobId: createTABANEToken_(),
      collectionId: createTABANEToken_(),
      versionId: createTABANEToken_(),
      title: title,
      sourceDocumentId: preflight.documentId,
      studentCount: students.length,
      status: '生成中',
      issuedAt: now,
      updatedAt: now,
      layoutMode: layoutMode,
      qrCorner: qrCorner,
      bandHeightPt: bandHeightPt,
      tokenCount: 0,
      doneStudents: 0,
      note: ''
    };
    issueRowNumber = appendLedgerRow_(issueLedger, PAPERFLOW_ISSUE_HEADERS, [
      job.jobId, job.status, job.title, job.sourceDocumentId,
      job.collectionId, job.versionId, job.studentCount, job.doneStudents,
      job.tokenCount, job.layoutMode, job.qrCorner, job.bandHeightPt, job.issuedAt, job.updatedAt,
      '', '', '', '', job.note
    ]);
  } else {
    issueRowNumber = job.__rowNumber;
    job.title = title;
    job.studentCount = students.length;
    job.layoutMode = layoutMode;
    job.qrCorner = qrCorner;
    job.bandHeightPt = bandHeightPt;
    job.updatedAt = now;
    ['title', 'studentCount', 'layoutMode', 'qrCorner', 'bandHeightPt', 'updatedAt']
      .forEach(function(header) { setLedgerField_(issueLedger, issueRowNumber, header, job[header]); });
    setLedgerField_(issueLedger, issueRowNumber, 'status', '生成中');
    setLedgerField_(issueLedger, issueRowNumber, 'note', '');
  }

  var rosterIds = {};
  students.forEach(function(student) { rosterIds[student.studentId] = true; });

  // 再開時は発行済みトークンを再利用し、まだトークンのない生徒だけを追加する。
  var tokensByStudent = {};
  var usedTokens = {};
  var existingRecordCount = 0;
  var existingRows = readLedgerRecords_(tokenLedger, PAPERFLOW_TOKEN_HEADERS);
  existingRows.forEach(function(record) {
    if (String(record.jobId) !== job.jobId) return;
    usedTokens[String(record.token)] = true;
    var studentId = String(record.studentId);
    if (!rosterIds[studentId])
      throw new Error('再開前の名簿と現在の名簿が一致しません。トークン記録を消さずに、元の名簿を復元してください。');
    // 旧形式（生徒×ページ）の記録が残っていても、1生徒1トークンとして先頭だけを再利用する。
    if (tokensByStudent[studentId]) return;
    tokensByStudent[studentId] = String(record.token);
    existingRecordCount += 1;
  });

  var written = 0;
  for (var studentIndex = 0; studentIndex < students.length; studentIndex += 1) {
    var student = students[studentIndex];
    var rows = [];
    if (!tokensByStudent[student.studentId]) {
      var token = createUniqueTABANEToken_(usedTokens);
      tokensByStudent[student.studentId] = token;
      rows.push(buildLedgerRow_(tokenLedger, PAPERFLOW_TOKEN_HEADERS, [
        token, job.collectionId, job.versionId, student.studentId, 'content',
        student.number, student.name, job.title, job.jobId, now
      ]));
    }
    if (rows.length) {
      tokenLedger.sheet.getRange(tokenLedger.sheet.getLastRow() + 1, 1, rows.length, tokenLedger.width).setValues(rows);
      written += rows.length;
    }
    setLedgerField_(issueLedger, issueRowNumber, 'doneStudents', studentIndex + 1);
    if ((studentIndex + 1) % 5 === 0 || studentIndex + 1 === students.length) {
      setLedgerField_(issueLedger, issueRowNumber, 'tokenCount', existingRecordCount + written);
      setLedgerField_(issueLedger, issueRowNumber, 'updatedAt', new Date().toISOString());
    }
  }

  var built = null;
  var reuseWarnings = [];
  // 前回PDFまで保存できているなら、そのPDFをそのまま使う（二重保存しない）。
  var existingPdfFile = job.pdfFileId ? findReusableDriveFile_(job.pdfFileId) : null;

  if (existingPdfFile) {
    built = { id: job.printDocumentId || '', pdfBlob: null, warnings: [] };
  } else if (job.printDocumentId) {
    // PDF保存だけ失敗したジョブは、作成済みの印刷用DocからPDFを作り直して続ける。
    try {
      built = {
        id: job.printDocumentId,
        pdfBlob: renderPrintDocumentPdf_(job.printDocumentId),
        warnings: []
      };
    } catch (reuseError) {
      reuseWarnings.push('前回の印刷用Docを開けなかったため、印刷用Docを作り直しました。');
    }
  }

  if (!built) {
    try {
      built = buildPrintDocument_(preflight.tab, job, students, tokensByStudent, reservation);
    } catch (error) {
      setLedgerField_(issueLedger, issueRowNumber, 'status', '途中');
      setLedgerField_(issueLedger, issueRowNumber, 'updatedAt', new Date().toISOString());
      setLedgerField_(issueLedger, issueRowNumber, 'note', String(error.message).slice(0, 1000));
      writeIssuanceFormOutputs_(form.sheet, {
        issuedAt: now, studentCount: students.length, status: '途中',
        note: String(error.message).slice(0, 1000), pdfUrl: '', documentUrl: ''
      });
      throw new Error(error.message + ' 発行済みトークンは台帳に残しています。原因を直してもう一度「QRを発行」してください。');
    }
  }

  var warnings = built.warnings.slice().concat(reuseWarnings);
  var printDocumentUrl = built.id
    ? 'https://docs.google.com/document/d/' + built.id + '/edit'
    : (job.printDocumentUrl || '');
  var folder;
  var pdfFile = existingPdfFile;
  try {
    if (!pdfFile) {
      folder = getOutputFolder_(settings);
      try {
        DriveApp.getFileById(built.id).moveTo(folder);
      } catch (moveError) {
        warnings.push('印刷用Docを「' + (settings.outputFolderName || PAPERFLOW_DEFAULT_OUTPUT_FOLDER) + '」へ移動できませんでした。Driveのルートを確認してください。');
      }
      pdfFile = folder.createFile(built.pdfBlob);
      pdfFile.setName(job.title + ' 印刷用 ' + paperFlowTimestamp_() + '.pdf');
    }
  } catch (saveError) {
    var saveMessage = ('印刷用Docは作成しました（' + printDocumentUrl + '）が、PDFの保存に失敗しました。' + saveError.message).slice(0, 1000);
    setLedgerField_(issueLedger, issueRowNumber, 'status', '途中');
    setLedgerField_(issueLedger, issueRowNumber, 'printDocumentId', built.id || '');
    setLedgerField_(issueLedger, issueRowNumber, 'printDocumentUrl', printDocumentUrl);
    setLedgerField_(issueLedger, issueRowNumber, 'note', saveMessage);
    setLedgerField_(issueLedger, issueRowNumber, 'updatedAt', new Date().toISOString());
    writeIssuanceFormOutputs_(form.sheet, {
      issuedAt: now, studentCount: students.length, status: '途中',
      note: saveMessage, pdfUrl: '', documentUrl: printDocumentUrl
    });
    throw new Error(saveMessage + ' 発行済みトークンは台帳に残しています。原因を直してもう一度「QRを発行」してください。');
  }

  var pdfUrl = pdfFile.getUrl ? pdfFile.getUrl() : 'https://drive.google.com/file/d/' + pdfFile.getId() + '/view';
  var note = [
    'QRは各生徒の先頭ページに1つ配置しています。',
    reservation
      ? '原稿の予約帯（' + reservation.corner + '・' + reservation.bandHeightPt + 'pt）を使用。'
      : '未予約のため管理帯方式で余白を追加。'
  ].concat(warnings).join(' / ').slice(0, 1000);

  setLedgerField_(issueLedger, issueRowNumber, 'printDocumentId', built.id);
  setLedgerField_(issueLedger, issueRowNumber, 'printDocumentUrl', printDocumentUrl);
  setLedgerField_(issueLedger, issueRowNumber, 'pdfFileId', pdfFile.getId());
  setLedgerField_(issueLedger, issueRowNumber, 'pdfUrl', pdfUrl);
  setLedgerField_(issueLedger, issueRowNumber, 'note', note);
  setLedgerField_(issueLedger, issueRowNumber, 'status', '完了');
  setLedgerField_(issueLedger, issueRowNumber, 'doneStudents', students.length);
  setLedgerField_(issueLedger, issueRowNumber, 'tokenCount', existingRecordCount + written);
  setLedgerField_(issueLedger, issueRowNumber, 'updatedAt', new Date().toISOString());

  writeIssuanceFormOutputs_(form.sheet, {
    issuedAt: now,
    studentCount: students.length,
    status: '完了',
    note: note,
    pdfUrl: pdfUrl,
    documentUrl: printDocumentUrl
  });

  return {
    jobId: job.jobId,
    status: '完了',
    title: job.title,
    studentCount: students.length,
    tokenCount: existingRecordCount + written,
    resumedTokenCount: existingRecordCount,
    layoutMode: layoutMode,
    bandHeightPt: bandHeightPt,
    qrCorner: qrCorner,
    documentUrl: printDocumentUrl,
    pdfUrl: pdfUrl,
    spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/' + spreadsheet.getId() + '/edit',
    warnings: warnings,
    note: note
  };
}

function writeIssuanceFormOutputs_(sheet, values) {
  sheet.getRange(PAPERFLOW_ISSUE_FORM_OUTPUT_ROW, 2, PAPERFLOW_ISSUE_FORM_OUTPUT_COUNT, 1).setValues([
    [values.issuedAt || ''],
    [values.studentCount === undefined ? '' : values.studentCount],
    [values.status || ''],
    [values.note || ''],
    [values.pdfUrl || ''],
    [values.documentUrl || '']
  ]);
}

function copySourceBody_(sourceBody, targetBody, warnings) {
  var count = sourceBody.getNumChildren();
  for (var i = 0; i < count; i += 1) {
    var child = sourceBody.getChild(i);
    var type = String(child.getType());
    try {
      if (type === 'PARAGRAPH') targetBody.appendParagraph(child.copy());
      else if (type === 'LIST_ITEM') targetBody.appendListItem(child.copy());
      else if (type === 'TABLE') targetBody.appendTable(child.copy());
      else if (type === 'IMAGE') {
        try {
          targetBody.appendImage(child.copy());
        } catch (imageError) {
          targetBody.appendImage(child.getBlob());
        }
      } else if (type === 'HORIZONTAL_RULE') targetBody.appendHorizontalRule();
      else if (type === 'PAGE_BREAK') targetBody.appendPageBreak();
      else if (type === 'TABLE_OF_CONTENTS') warnings.push('目次要素は印刷用Docで再生成されません。');
      else warnings.push('未対応の要素（' + type + '）をコピーしませんでした。');
    } catch (error) {
      throw new Error('原稿の要素（' + type + '）を印刷用Docへコピーできませんでした。原稿の構成を確認してください。');
    }
  }
}

function appendIssuanceBand_(body, job, student, tokensByStudent) {
  var qrSize = Math.max(40, Math.min(64, job.bandHeightPt - 28));
  var table = body.appendTable();
  try {
    var attributes = {};
    attributes[DocumentApp.Attribute.BORDER_WIDTH] = 0;
    table.setAttributes(attributes);
  } catch (attributeError) {
    /* 罫線が残ってもQRの読み取りには影響しない。 */
  }

  var row = table.appendTableRow();
  var info = row.appendTableCell();
  var heading = info.appendParagraph(student.number + '番　' + student.name);
  heading.setBold(true).setFontSize(10);
  var meta = info.appendParagraph(job.title);
  meta.setFontSize(7).setForegroundColor('#5d6b63');

  var cell = row.appendTableCell();
  var token = tokensByStudent[student.studentId];
  if (!token) throw new Error('トークンが見つかりません。発行をやり直してください。');
  var image = cell.appendImage(createTABANEQrPngBlob_(token, { scale: 4 }));
  image.setWidth(qrSize).setHeight(qrSize);
}

function documentMargin_(value) {
  return isIntegral_(value) ? value : 72;
}

function buildPrintDocument_(tab, job, students, tokensByStudent, reservation) {
  var sourceBody = tab.getBody();
  var printDoc = DocumentApp.create(job.title + ' 印刷用 ' + paperFlowTimestamp_());
  var printDocId = printDoc.getId();
  var warnings = [];
  if (sourceBody.getImages && sourceBody.getImages().length)
    warnings.push('原稿内の画像は、形式によって印刷用Docへ正しくコピーされない場合があります。印刷用Docを確認してください。');
  var sourceHeader = tab.getHeader ? tab.getHeader() : null;
  if (sourceHeader && sourceHeader.getText && sourceHeader.getText().replace(PAPERFLOW_QR_GUIDE_TEXT, '').replace(new RegExp(PAPERFLOW_QR_RESERVATION_PREFIX + '[a-z]{2}_\\d+_\\d+', 'g'), '').trim())
    warnings.push('原稿のヘッダー内容は印刷用Docへ引き継いでいません。ページ上部の文言を確認してください。');
  var sourceFooter = tab.getFooter ? tab.getFooter() : null;
  if (sourceFooter && sourceFooter.getText && sourceFooter.getText().trim())
    warnings.push('原稿のフッター内容は印刷用Docへ引き継いでいません。');
  try {
    var body = printDoc.getBody();
    body.setPageWidth(sourceBody.getPageWidth());
    body.setPageHeight(sourceBody.getPageHeight());
    body.setMarginLeft(documentMargin_(sourceBody.getMarginLeft()));
    body.setMarginRight(documentMargin_(sourceBody.getMarginRight()));
    body.setMarginBottom(documentMargin_(sourceBody.getMarginBottom()));
    // 予約済みなら予約前の上余白に戻し、QR帯の実寸で本文を押し下げる。
    body.setMarginTop(reservation ? reservation.originalTopMarginPt : documentMargin_(sourceBody.getMarginTop()));
    students.forEach(function(student, index) {
      if (index > 0) body.appendPageBreak();
      appendIssuanceBand_(body, job, student, tokensByStudent);
      copySourceBody_(sourceBody, body, warnings);
    });
    // saveAndClose の前にPDF化する（閉じたDocではgetAsできないため）。
    var pdfBlob = printDoc.getAs('application/pdf');
    printDoc.saveAndClose();
    return { id: printDocId, pdfBlob: pdfBlob, warnings: warnings };
  } catch (error) {
    // 失敗した中途半端な印刷用Docを残さない（消せない環境でも処理は続ける）。
    try { DriveApp.getFileById(printDocId).setTrashed(true); } catch (trashError) { /* 手動で確認する */ }
    throw new Error('印刷用Docの組み立てに失敗しました。' + error.message);
  }
}
