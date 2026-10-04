/**
 * Image inspection from the file bytes (never from the file name or the
 * client's Content-Type): detects JPEG / PNG / WEBP and reads the pixel size.
 */

const ascii = (buf, start, end) => buf.toString('latin1', start, end);

function png(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || ascii(buf, 12, 16) !== 'IHDR') return null;
  return { type: 'png', mime: 'image/png', ext: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xd9 || marker === 0xda) return null; // end / start of scan before a frame header
    const size = buf.readUInt16BE(i + 2);
    // SOF0–SOF15 carry the dimensions (except DHT 0xC4, JPG 0xC8, DAC 0xCC).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { type: 'jpeg', mime: 'image/jpeg', ext: 'jpg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + size;
  }
  return null;
}

function webp(buf) {
  if (buf.length < 30 || ascii(buf, 0, 4) !== 'RIFF' || ascii(buf, 8, 12) !== 'WEBP') return null;
  const chunk = ascii(buf, 12, 16);
  const base = { type: 'webp', mime: 'image/webp', ext: 'webp' };
  if (chunk === 'VP8 ') return { ...base, width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') {
    const b = buf.readUInt32LE(21);
    return { ...base, width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') return { ...base, width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  return null;
}

/** `{ type, mime, ext, width, height }` or null when not a supported image. */
export function inspectImage(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  const info = png(buf) ?? jpeg(buf) ?? webp(buf);
  return info && info.width > 0 && info.height > 0 ? info : null;
}
