// Code-drawn maskable icons matching the tray's amber attention indicator.
const fs = require("fs"), zlib = require("zlib"), path = require("path");
function crc(bytes) { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const name = Buffer.from(type), size = Buffer.alloc(4), check = Buffer.alloc(4); size.writeUInt32BE(data.length); check.writeUInt32BE(crc(Buffer.concat([name, data]))); return Buffer.concat([size, name, data, check]); }
for (const size of [192, 512]) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size, tile = u > .23 && u < .77 && v > .23 && v < .77;
    const mark = u > .46 && u < .54 && ((v > .34 && v < .55) || (v > .61 && v < .68));
    const color = tile && !mark ? [255, 191, 0] : [23, 37, 42];
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    raw.set([...color, 255], offset);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  fs.writeFileSync(path.join(__dirname, `../src/web/icon-${size}.png`), Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}
