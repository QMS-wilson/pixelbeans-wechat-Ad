const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64ToBytes(base64) {
  const clean = String(base64 || "").replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const out = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = B64_CHARS.indexOf(char);
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

function arrayBufferToUtf8(buffer) {
  const bytes = new Uint8Array(buffer);
  let output = "";
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i];
    if (byte < 0x80) {
      output += String.fromCharCode(byte);
    } else if (byte >= 0xc0 && byte < 0xe0 && i + 1 < bytes.length) {
      output += String.fromCharCode(((byte & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 1;
    } else if (byte >= 0xe0 && byte < 0xf0 && i + 2 < bytes.length) {
      output += String.fromCharCode(((byte & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f));
      i += 2;
    } else if (byte >= 0xf0 && i + 3 < bytes.length) {
      const codePoint =
        ((byte & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
      const adjusted = codePoint - 0x10000;
      output += String.fromCharCode(0xd800 + (adjusted >> 10), 0xdc00 + (adjusted & 0x3ff));
      i += 3;
    } else {
      output += String.fromCharCode(byte);
    }
  }
  return output;
}

module.exports = {
  base64ToBytes,
  arrayBufferToUtf8,
};
