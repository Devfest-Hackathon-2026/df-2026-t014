/**
 * 原稿Docの予約マーカーの検出（台帳側）。
 *
 * 予約の作成・解除は Docs アドオン（apps/docs-addon）が行う。台帳側は
 * 発行時に「予約済みか」「どのコーナー・帯の高さか」を知るためだけに読む。
 *
 * マーカー形式:
 *   PFQR1_<tr|tl|br|bl>_<帯の高さpt>_<予約前の上余白pt>_<base64urlラベル>
 * ラベルはUTF-8のbase64url。空ラベルでも4セグメント目を空にして同じ形式を使う。
 * 旧形式（ラベルなしの3セグメント）も読み取れる。
 * 保持先: タブの名前付き範囲の名前、およびヘッダーのガイド段落の文字。
 */

var PAPERFLOW_QR_RESERVATION_PREFIX = 'PFQR1_';
var PAPERFLOW_QR_GUIDE_TEXT = 'ここにQRコードが入ります';
var PAPERFLOW_DEFAULT_QR_BAND_HEIGHT_PT = 96;
var PAPERFLOW_MIN_QR_BAND_HEIGHT_PT = 48;
var PAPERFLOW_MAX_QR_BAND_HEIGHT_PT = 180;
var PAPERFLOW_MAX_DOC_MARGIN_PT = 432;
var PAPERFLOW_MAX_QR_LABEL_LENGTH = 30;

function singleDocumentTab_(doc) {
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
  if (!isIntegral_(band) || band < PAPERFLOW_MIN_QR_BAND_HEIGHT_PT || band > PAPERFLOW_MAX_QR_BAND_HEIGHT_PT)
    throw new Error('QR帯の高さは' + PAPERFLOW_MIN_QR_BAND_HEIGHT_PT + '〜' + PAPERFLOW_MAX_QR_BAND_HEIGHT_PT + 'ptで指定してください。');
  if (!isIntegral_(original) || original < 0 || original > PAPERFLOW_MAX_DOC_MARGIN_PT)
    throw new Error('予約前の上余白を確認できません。');
  return PAPERFLOW_QR_RESERVATION_PREFIX + code + '_' + band + '_' + original + '_' + encodeQrReservationLabel_(label);
}

function decodeQrReservationMarker_(marker) {
  if (typeof marker !== 'string') return null;
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

/** 開いた原稿Docから予約を検出する。未予約は null。 */
function getQrReservationFromDocument_(doc) {
  if (!doc) return null;
  var tab = singleDocumentTab_(doc);
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
