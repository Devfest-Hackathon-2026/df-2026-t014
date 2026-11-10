/** @OnlyCurrentDoc */

var PAPERFLOW_SETTINGS_KEY = 'PAPERFLOW_LAST_SETTINGS_V1';

function onOpen() {
  DocumentApp.getUi().createAddonMenu()
    .addItem('TABANEを開く', 'openTABANE')
    .addToUi();
}
function onInstall() { onOpen(); }

function openTABANE() {
  DocumentApp.getUi().showSidebar(
    HtmlService.createHtmlOutputFromFile('Sidebar').setTitle('TABANE — QRの予約')
  );
}

function readTABANESettings_() {
  try { return sanitizeTABANESettings_(JSON.parse(PropertiesService.getUserProperties().getProperty(PAPERFLOW_SETTINGS_KEY) || '{}')); }
  catch (error) { return {}; }
}

function sanitizeTABANESettings_(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('設定の形式が正しくありません。');
  var result = {};
  // 予約に必要な項目だけを残す。
  if (['top-right', 'top-left', 'bottom-right', 'bottom-left'].indexOf(value.qrCorner) !== -1)
    result.qrCorner = value.qrCorner;
  var band = Number(value.qrBandHeightPt);
  if (isIntegral_(band) && band >= PAPERFLOW_MIN_QR_BAND_HEIGHT_PT && band <= PAPERFLOW_MAX_QR_BAND_HEIGHT_PT)
    result.qrBandHeightPt = band;
  if (typeof value.qrLabel === 'string') result.qrLabel = sanitizeQrLabel_(value.qrLabel);
  return result;
}

function saveTABANESettings(value) {
  var clean = sanitizeTABANESettings_(value);
  var properties = PropertiesService.getUserProperties();
  var merged = readTABANESettings_();
  Object.keys(clean).forEach(function(key) { merged[key] = clean[key]; });
  properties.setProperty(PAPERFLOW_SETTINGS_KEY, JSON.stringify(merged));
  return merged;
}

function getTABANESidebarState() {
  var state = {
    defaults: readTABANESettings_(),
    defaultQrBandHeightPt: PAPERFLOW_DEFAULT_QR_BAND_HEIGHT_PT
  };
  var reservationState = getTABANEReservationState_();
  state.reservation = reservationState.reservation;
  if (reservationState.reservationError) state.reservationError = reservationState.reservationError;
  return state;
}
