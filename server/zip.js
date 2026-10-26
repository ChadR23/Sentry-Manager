'use strict';

// Just enough of the .zip format for UI packs: read an uploaded archive
// (stored or deflated files, no encryption, no zip64) and write one. Every
// size is checked against limits before anything is inflated, and each file
// is inflated to at most its declared size and checked against its CRC.

const zlib = require('zlib');

class ZipError extends Error {}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/**
 * The files in a .zip (a Buffer): [{ name, data }]. Folders and symbolic
 * links are left out. Throws ZipError on anything it cannot read safely.
 */
function readZip(buf, { maxFiles = 5000, maxTotal = 256 * 1024 * 1024, maxFile = 64 * 1024 * 1024 } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new ZipError('That is not a .zip file.');
  // the end record is in the last 22 bytes plus a comment of up to 64 KiB
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) { end = i; break; }
  }
  if (end < 0) throw new ZipError('That is not a .zip file.');
  const count = buf.readUInt16LE(end + 10);
  const cdSize = buf.readUInt32LE(end + 12);
  const cdOffset = buf.readUInt32LE(end + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipError('Zip64 archives are not supported: make a smaller pack.');
  if (count > maxFiles) throw new ZipError(`Too many files (over ${maxFiles}).`);
  if (cdOffset + cdSize > end) throw new ZipError('The .zip file is damaged.');
  const files = [];
  let total = 0;
  let at = cdOffset;
  for (let n = 0; n < count; n++) {
    if (at + 46 > end || buf.readUInt32LE(at) !== CENTRAL) throw new ZipError('The .zip file is damaged.');
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const csize = buf.readUInt32LE(at + 20);
    const usize = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const madeBy = buf.readUInt16LE(at + 4) >> 8;
    const attrs = buf.readUInt32LE(at + 38);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    // (a Unix symbolic link: its target is the content)
    if (madeBy === 3 && ((attrs >>> 16) & 0o170000) === 0o120000) continue;
    if (flags & 1) throw new ZipError('Encrypted .zip files are not supported.');
    if (method !== 0 && method !== 8) throw new ZipError(`"${name}" is packed in a way that is not supported (use normal zip compression).`);
    if (usize > maxFile) throw new ZipError(`"${name}" is too large.`);
    total += usize;
    if (total > maxTotal) throw new ZipError('The pack is too large when unpacked.');
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOCAL) throw new ZipError('The .zip file is damaged.');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + csize > buf.length) throw new ZipError('The .zip file is damaged.');
    const raw = buf.subarray(start, start + csize);
    let data;
    try {
      data = method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, usize) });
    } catch {
      throw new ZipError(`"${name}" is damaged.`);
    }
    if (data.length !== usize || zlib.crc32(data) !== crc) throw new ZipError(`"${name}" is damaged.`);
    files.push({ name, data });
  }
  return files;
}

/** A .zip (Buffer) of [{ name, data }], deflated. */
function writeZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  // 1 January 2026, 00:00 (DOS date and time)
  const time = 0;
  const date = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const packed = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(LOCAL, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x800, 6);
    head.writeUInt16LE(8, 8);
    head.writeUInt16LE(time, 10);
    head.writeUInt16LE(date, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    parts.push(head, nameBuf, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(CENTRAL, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);
    offset += head.length + nameBuf.length + packed.length;
  }
  const cd = Buffer.concat(central);
  const tail = Buffer.alloc(22);
  tail.writeUInt32LE(EOCD, 0);
  tail.writeUInt16LE(files.length, 8);
  tail.writeUInt16LE(files.length, 10);
  tail.writeUInt32LE(cd.length, 12);
  tail.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, tail]);
}

module.exports = { readZip, writeZip, ZipError };
