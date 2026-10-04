import zlib from 'node:zlib';

/**
 * Small dependency-free PNG writer for tests and demo data: a horizontal
 * gradient between two RGB colours.
 */
export function makePng(width, height, from = [8, 100, 172], to = [95, 168, 232]) {
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) {
    const t = width > 1 ? x / (width - 1) : 0;
    for (let c = 0; c < 3; c++) row[1 + x * 3 + c] = Math.round(from[c] + (to[c] - from[c]) * t);
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
