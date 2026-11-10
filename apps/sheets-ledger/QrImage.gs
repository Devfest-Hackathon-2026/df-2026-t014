/**
 * QRコードのPNG生成。
 *
 * 同梱した qrcode-generator（MIT）が返すモジュール行列を、
 * 8bit RGB のPNGへ自前で書き出す。外部APIには一切送信しない。
 * zlibは「無圧縮（stored）」ブロックだけを使うため、追加ライブラリは不要。
 */

function createTABANEQrPngBlob_(text, options) {
  if (typeof text !== 'string' || !text) throw new Error('QRコードにする文字列が空です。');
  var value = options || {};
  var scale = value.scale === undefined ? 4 : Number(value.scale);
  var quiet = value.quietModules === undefined ? 4 : Number(value.quietModules);
  if (!isIntegral_(scale) || scale < 1 || scale > 16)
    throw new Error('QR画像の倍率は1〜16で指定してください。');
  if (!isIntegral_(quiet) || quiet < 0 || quiet > 16)
    throw new Error('QR画像の余白モジュール数を確認してください。');

  var qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  var moduleCount = qr.getModuleCount();
  var totalModules = moduleCount + quiet * 2;
  var size = totalModules * scale;
  var raw = [];
  for (var y = 0; y < size; y += 1) {
    raw.push(0);
    var moduleRow = Math.floor(y / scale) - quiet;
    for (var x = 0; x < size; x += 1) {
      var moduleColumn = Math.floor(x / scale) - quiet;
      var dark = moduleRow >= 0 && moduleRow < moduleCount && moduleColumn >= 0 && moduleColumn < moduleCount &&
        qr.isDark(moduleRow, moduleColumn);
      var shade = dark ? 0 : 255;
      raw.push(shade, shade, shade);
    }
  }

  var png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  var ihdr = [];
  appendUint32_(ihdr, size);
  appendUint32_(ihdr, size);
  ihdr.push(8, 2, 0, 0, 0);
  pushPngChunk_(png, 'IHDR', ihdr);
  pushPngChunk_(png, 'IDAT', zlibStored_(raw));
  pushPngChunk_(png, 'IEND', []);
  return Utilities.newBlob(png, 'image/png', 'paperflow-qr.png');
}

function appendUint32_(bytes, value) {
  bytes.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function pushPngChunk_(png, type, data) {
  appendUint32_(png, data.length);
  var body = [];
  for (var i = 0; i < type.length; i += 1) body.push(type.charCodeAt(i));
  for (var j = 0; j < data.length; j += 1) body.push(data[j]);
  for (var k = 0; k < body.length; k += 1) png.push(body[k]);
  appendUint32_(png, crc32_(body));
}

function zlibStored_(raw) {
  var out = [0x78, 0x01];
  var offset = 0;
  while (offset < raw.length) {
    var length = Math.min(65535, raw.length - offset);
    var last = offset + length >= raw.length;
    out.push(last ? 1 : 0);
    out.push(length & 0xff, (length >>> 8) & 0xff, (~length) & 0xff, ((~length) >>> 8) & 0xff);
    for (var i = 0; i < length; i += 1) out.push(raw[offset + i]);
    offset += length;
  }
  var adler = adler32_(raw);
  out.push((adler >>> 24) & 0xff, (adler >>> 16) & 0xff, (adler >>> 8) & 0xff, adler & 0xff);
  return out;
}

function adler32_(bytes) {
  var a = 1;
  var b = 0;
  for (var i = 0; i < bytes.length; i += 1) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function crc32_(bytes) {
  var table = crc32Table_();
  var crc = 0xffffffff;
  for (var i = 0; i < bytes.length; i += 1) {
    crc = (crc >>> 8) ^ table[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

var PAPERFLOW_CRC32_TABLE_CACHE_ = null;
function crc32Table_() {
  if (PAPERFLOW_CRC32_TABLE_CACHE_) return PAPERFLOW_CRC32_TABLE_CACHE_;
  var table = [];
  for (var n = 0; n < 256; n += 1) {
    var c = n;
    for (var k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  PAPERFLOW_CRC32_TABLE_CACHE_ = table;
  return table;
}
