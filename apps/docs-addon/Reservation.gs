/**
 * 原稿DocへのQR帯の予約。
 *
 * 予約情報は次の2か所に同じマーカー文字列として保持する。
 *   1. タブの名前付き範囲（名前そのものに予約パラメータを埋め込む）
 *   2. ヘッダーのガイド段落（本文と一緒にコピー・共有される控え）
 * 名前付き範囲だけではヘッダー要素をアンカーにできないため、
 * ヘッダー本文にも同じマーカーを持たせてコピー時の取りこぼしに備える。
 *
 * マーカー形式（現行）:
 *   PFQR1_<tr|tl|br|bl>_<帯の高さpt>_<予約前の上余白pt>_<base64urlラベル>
 * ラベルはUTF-8のbase64urlで符号化し、名前付き範囲に使える文字だけにする。
 * ラベルが空でも4セグメント目を空にして同じ形式を使う。
 * 旧形式（ラベルなしの3セグメント）も読み取れる。
 */

var PAPERFLOW_QR_RESERVATION_PREFIX = 'PFQR1_';
var PAPERFLOW_QR_GUIDE_TEXT = 'ここにQRコードが入ります';
var PAPERFLOW_DEFAULT_QR_BAND_HEIGHT_PT = 96;
var PAPERFLOW_MIN_QR_BAND_HEIGHT_PT = 48;
var PAPERFLOW_MAX_QR_BAND_HEIGHT_PT = 180;
var PAPERFLOW_MAX_DOC_MARGIN_PT = 432;
var PAPERFLOW_MAX_QR_LABEL_LENGTH = 30;

function activeDocumentTab_(doc) {
  var tabs = doc.getTabs();
  if (!tabs || tabs.length !== 1 || tabs[0].getChildTabs().length !== 0)
    throw new Error('単一タブのGoogle Docsを使用してください。タブの内容を勝手に統合しません。');
  return tabs[0].asDocumentTab();
}

function qrCornerCode_(corner) {
  return { 'top-right': 'tr', 'top-left': 'tl', 'bottom-right': 'br', 'bottom-left': 'bl' }[corner] || '';
}

function qrCornerFromCode_(code) {
  return { tr: 'top-right', tl: 'top-left', br: 'bottom-right', bl: 'bottom-left' }[code] || '';
}

function sanitizeQrLabel_(label) {
  if (typeof label !== 'string') return '';
  return label.replace(/[\r\n\t]+/g, ' ').trim().slice(0, PAPERFLOW_MAX_QR_LABEL_LENGTH);
}

function encodeQrReservationLabel_(label) {
  var text = sanitizeQrLabel_(label);
  if (!text) return '';
  // 名前付き範囲に使える文字だけにするため、パディングの = は落とす。
  return Utilities.base64EncodeWebSafe(Utilities.newBlob(text).getBytes()).replace(/=+$/, '');
}

function decodeQrReservationLabel_(encoded) {
  if (!encoded) return '';
  try {
    var normalized = String(encoded);
    var remainder = normalized.length % 4;
    if (remainder) normalized += remainder === 2 ? '==' : remainder === 3 ? '=' : '===';
    var bytes = Utilities.base64DecodeWebSafe(normalized);
    return sanitizeQrLabel_(Utilities.newBlob(bytes).getDataAsString('UTF-8'));
  } catch (error) {
    return '';
  }
}

function encodeQrReservationMarker_(corner, bandHeightPt, originalTopMarginPt, label) {
  var code = qrCornerCode_(corner);
  var band = Number(bandHeightPt);
  var original = Number(originalTopMarginPt);
  if (!code) throw new Error('QRの配置コーナーが正しくありません。');
  if (!isFinite(band) || !isIntegral_(band) || band < PAPERFLOW_MIN_QR_BAND_HEIGHT_PT || band > PAPERFLOW_MAX_QR_BAND_HEIGHT_PT)
    throw new Error('QR帯の高さは' + PAPERFLOW_MIN_QR_BAND_HEIGHT_PT + '〜' + PAPERFLOW_MAX_QR_BAND_HEIGHT_PT + 'ptで指定してください。');
  if (!isFinite(original) || !isIntegral_(original) || original < 0 || original > PAPERFLOW_MAX_DOC_MARGIN_PT)
    throw new Error('予約前の上余白を確認できません。');
  return PAPERFLOW_QR_RESERVATION_PREFIX + code + '_' + band + '_' + original + '_' + encodeQrReservationLabel_(label);
}

function decodeQrReservationMarker_(marker) {
  if (typeof marker !== 'string') return null;
  // 4セグメント目（ラベル）は省略可能にして旧形式も読む。
  var match = marker.match(/PFQR1_(tr|tl|br|bl)_(\d{1,3})_(\d{1,3})(?:_([A-Za-z0-9_-]*))?/);
  if (!match) return null;
  var corner = qrCornerFromCode_(match[1]);
  var band = Number(match[2]);
  var original = Number(match[3]);
  if (!corner) return null;
  if (!isIntegral_(band) || band < PAPERFLOW_MIN_QR_BAND_HEIGHT_PT || band > PAPERFLOW_MAX_QR_BAND_HEIGHT_PT) return null;
  if (!isIntegral_(original) || original < 0 || original > PAPERFLOW_MAX_DOC_MARGIN_PT) return null;
  return {
    corner: corner,
    bandHeightPt: band,
    originalTopMarginPt: original,
    label: decodeQrReservationLabel_(match[4] || ''),
    marker: match[0]
  };
}

function isIntegral_(value) {
  return typeof value === 'number' && isFinite(value) && Math.floor(value) === value;
}

function findGuideParagraph_(header) {
  if (!header) return null;
  var paragraphs = header.getParagraphs() || [];
  for (var i = 0; i < paragraphs.length; i += 1) {
    var text = paragraphs[i].getText() || '';
    if (text.indexOf(PAPERFLOW_QR_GUIDE_TEXT) !== -1 || text.indexOf(PAPERFLOW_QR_RESERVATION_PREFIX) !== -1) return paragraphs[i];
  }
  return null;
}

function findReservationNamedRange_(tab) {
  var ranges = tab.getNamedRanges() || [];
  for (var i = 0; i < ranges.length; i += 1) {
    var name = ranges[i].getName() || '';
    if (name.indexOf(PAPERFLOW_QR_RESERVATION_PREFIX) === 0) return ranges[i];
  }
  return null;
}

function getQrReservation_(doc) {
  doc = doc || DocumentApp.getActiveDocument();
  if (!doc) return null;
  var tab = activeDocumentTab_(doc);
  var namedRange = findReservationNamedRange_(tab);
  var header = tab.getHeader();
  var guide = findGuideParagraph_(header);
  var fromRange = namedRange ? decodeQrReservationMarker_(namedRange.getName()) : null;
  var fromGuide = guide ? decodeQrReservationMarker_(guide.getText()) : null;
  var reservation = fromRange || fromGuide;
  if (!reservation) return null;
  return {
    corner: reservation.corner,
    bandHeightPt: reservation.bandHeightPt,
    originalTopMarginPt: reservation.originalTopMarginPt,
    label: reservation.label || '',
    marker: reservation.marker,
    currentTopMarginPt: tab.getBody().getMarginTop(),
    guideFound: !!guide,
    namedRangeFound: !!namedRange
  };
}

function removeQrReservationArtifacts_(tab) {
  var ranges = tab.getNamedRanges() || [];
  for (var i = 0; i < ranges.length; i += 1) {
    var name = ranges[i].getName() || '';
    if (name.indexOf(PAPERFLOW_QR_RESERVATION_PREFIX) === 0) ranges[i].remove();
  }
  var header = tab.getHeader();
  if (!header) return;
  var paragraphs = header.getParagraphs() || [];
  for (var j = paragraphs.length - 1; j >= 0; j -= 1) {
    var text = paragraphs[j].getText() || '';
    // 目印の入った自分たちの段落だけを消す。既存のヘッダー文言は消さない。
    if (text.indexOf(PAPERFLOW_QR_RESERVATION_PREFIX) !== -1) {
      if (paragraphs[j].removeFromParent) paragraphs[j].removeFromParent();
      else if (header.removeChild) header.removeChild(paragraphs[j]);
    }
  }
}

function guideParagraphText_(label) {
  var clean = sanitizeQrLabel_(label);
  return clean ? PAPERFLOW_QR_GUIDE_TEXT + ' 名前「' + clean + '」' : PAPERFLOW_QR_GUIDE_TEXT;
}

function appendGuideParagraph_(tab, marker, label) {
  var header = tab.getHeader() || tab.addHeader();
  var guide = header.appendParagraph(guideParagraphText_(label));
  guide.setFontSize(9).setForegroundColor('#9aa8a0').setItalic(true);
  var text = guide.editAsText();
  text.appendText(' ' + marker).setFontSize(6).setForegroundColor('#c2ccc6');
  return guide;
}

function addReservationNamedRange_(tab, marker) {
  var builder = tab.newRange();
  var anchored = false;
  var header = tab.getHeader();
  var guide = findGuideParagraph_(header);
  if (guide) {
    try {
      builder.addElement(guide);
      anchored = true;
    } catch (error) {
      anchored = false;
    }
  }
  if (!anchored) {
    var body = tab.getBody();
    if (body.getNumChildren() > 0) {
      try {
        builder.addElement(body.getChild(0));
        anchored = true;
      } catch (error) {
        anchored = false;
      }
    }
  }
  if (!anchored) throw new Error('予約の目印を文書内に作成できません。本文が空でないか確認してください。');
  tab.addNamedRange(marker, builder.build());
}

function reserveTABANEQr(input) {
  var doc = DocumentApp.getActiveDocument();
  if (!doc) throw new Error('対象のGoogle Docsを開いてから実行してください。');
  var tab = activeDocumentTab_(doc);
  var value = input || {};
  var corner = value.corner;
  if (['top-right', 'top-left', 'bottom-right', 'bottom-left'].indexOf(corner) === -1)
    throw new Error('QRの配置コーナーを選択してください。');
  var bandHeightPt = Number(value.bandHeightPt);
  if (!isIntegral_(bandHeightPt) || bandHeightPt < PAPERFLOW_MIN_QR_BAND_HEIGHT_PT || bandHeightPt > PAPERFLOW_MAX_QR_BAND_HEIGHT_PT)
    throw new Error('QR帯の高さは' + PAPERFLOW_MIN_QR_BAND_HEIGHT_PT + '〜' + PAPERFLOW_MAX_QR_BAND_HEIGHT_PT + 'ptで指定してください。');
  var label = sanitizeQrLabel_(value.label);

  var body = tab.getBody();
  var existing = getQrReservation_(doc);
  var originalTopMarginPt = existing ? existing.originalTopMarginPt : body.getMarginTop();
  if (!isIntegral_(originalTopMarginPt) || originalTopMarginPt < 0 || originalTopMarginPt > PAPERFLOW_MAX_DOC_MARGIN_PT)
    throw new Error('原稿の上余白を確認できません。「ファイル → ページ設定」を確認してください。');

  // 二重予約で余白を積み上げないよう、いったん目印とガイドだけを外してから目的の値に設定する。
  removeQrReservationArtifacts_(tab);
  try {
    body.setMarginTop(originalTopMarginPt + bandHeightPt);
  } catch (marginError) {
    throw new Error('上余白を' + (originalTopMarginPt + bandHeightPt) + 'ptへ変更できません。「ファイル → ページ設定」の余白を確認してください。');
  }
  var marker = encodeQrReservationMarker_(corner, bandHeightPt, originalTopMarginPt, label);
  try {
    appendGuideParagraph_(tab, marker, label);
    addReservationNamedRange_(tab, marker);
  } catch (error) {
    // 途中で失敗したら余白を戻し、中途半端な予約を残さない。
    removeQrReservationArtifacts_(tab);
    try { body.setMarginTop(originalTopMarginPt); } catch (restoreError) { /* 元の余白を優先する */ }
    throw error;
  }
  try { saveTABANESettings({ qrCorner: corner, qrBandHeightPt: bandHeightPt, qrLabel: label }); } catch (settingsError) { /* 予約自体は成功させる */ }
  return getQrReservation_(doc);
}

/**
 * 予約済みの仮の名前だけを差し替える。余白・位置・帯の高さは変えない。
 * 名前付き範囲とヘッダーのガイドの両方を同じマーカーで更新する。
 */
function updateTABANEReservationLabel(label) {
  var doc = DocumentApp.getActiveDocument();
  if (!doc) throw new Error('対象のGoogle Docsを開いてから実行してください。');
  var tab = activeDocumentTab_(doc);
  var existing = getQrReservation_(doc);
  if (!existing) throw new Error('QRの予約がありません。先に「QRの予約」を実行してください。');
  var cleanLabel = sanitizeQrLabel_(label);
  var oldMarker = encodeQrReservationMarker_(existing.corner, existing.bandHeightPt, existing.originalTopMarginPt, existing.label);
  var newMarker = encodeQrReservationMarker_(existing.corner, existing.bandHeightPt, existing.originalTopMarginPt, cleanLabel);
  removeQrReservationArtifacts_(tab);
  try {
    appendGuideParagraph_(tab, newMarker, cleanLabel);
    addReservationNamedRange_(tab, newMarker);
  } catch (error) {
    // 差し替えに失敗したら元の名前へ戻す。
    try {
      removeQrReservationArtifacts_(tab);
      appendGuideParagraph_(tab, oldMarker, existing.label);
      addReservationNamedRange_(tab, oldMarker);
    } catch (restoreError) { /* 元に戻せない場合はそのままエラーを返す */ }
    throw error;
  }
  try { saveTABANESettings({ qrLabel: cleanLabel }); } catch (settingsError) { /* 予約自体は成功させる */ }
  return getQrReservation_(doc);
}

function releaseTABANEQr() {
  var doc = DocumentApp.getActiveDocument();
  if (!doc) throw new Error('対象のGoogle Docsを開いてから実行してください。');
  var tab = activeDocumentTab_(doc);
  var existing = getQrReservation_(doc);
  removeQrReservationArtifacts_(tab);
  if (!existing) return { released: false, reservation: null };
  tab.getBody().setMarginTop(existing.originalTopMarginPt);
  return { released: true, reservation: null, restoredTopMarginPt: existing.originalTopMarginPt };
}

function getTABANEReservationState_() {
  try {
    return { reservation: getQrReservation_() };
  } catch (error) {
    return { reservation: null, reservationError: error.message };
  }
}
