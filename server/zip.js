'use strict';

// Just enough of the .zip format for UI packs and CAN bundles: read an
// uploaded archive (stored or deflated files, no encryption) and write one.
// Every size is checked against limits before anything is inflated, and each
// file is inflated to at most its declared size and checked against its CRC.
// Zip64 (APPNOTE 4.3.9, 4.4.1.4, 4.5.3) is written only when it is needed: a
// file or an offset of 4 GiB or more, or 65,535 files or more; an archive
// without any of those is the classic format, byte for byte as before.

const zlib = require('zlib');

class ZipError extends Error {}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const DESCRIPTOR = 0x08074b50;
const ZIP64_END = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
const MAX16 = 0xffff;
const MAX32 = 0xffffffff;

/** A Zip64 extended information extra field (0x0001) holding these 8-byte values. */
function zip64Extra(values) {
  const b = Buffer.alloc(4 + 8 * values.length);
  b.writeUInt16LE(0x0001, 0);
  b.writeUInt16LE(8 * values.length, 2);
  values.forEach((v, i) => b.writeBigUInt64LE(BigInt(v), 4 + 8 * i));
  return b;
}

/**
 * A local file header and its name. `zip64`: both sizes are 0xFFFFFFFF and
 * the extra field holds them, uncompressed first (APPNOTE 4.5.3: the local
 * one always has both); with a data descriptor (flag 8) they are zeros there,
 * and the descriptor after the data has 8-byte sizes (4.3.9.2).
 */
function localHeader({ nameBuf, flags, method, time, date, crc = 0, csize = 0, usize = 0, zip64 = false }) {
  const extra = zip64 ? zip64Extra([usize, csize]) : Buffer.alloc(0);
  const head = Buffer.alloc(30);
  head.writeUInt32LE(LOCAL, 0);
  head.writeUInt16LE(zip64 ? 45 : 20, 4);
  head.writeUInt16LE(flags, 6);
  head.writeUInt16LE(method, 8);
  head.writeUInt16LE(time, 10);
  head.writeUInt16LE(date, 12);
  head.writeUInt32LE(crc >>> 0, 14);
  head.writeUInt32LE(zip64 ? MAX32 : csize, 18);
  head.writeUInt32LE(zip64 ? MAX32 : usize, 22);
  head.writeUInt16LE(nameBuf.length, 26);
  head.writeUInt16LE(extra.length, 28);
  return Buffer.concat([head, nameBuf, extra]);
}

/**
 * A central directory record and its name. A size or offset of 0xFFFFFFFF or
 * more is written as 0xFFFFFFFF and its value goes in a Zip64 extra field,
 * which holds only those, in APPNOTE order (uncompressed, compressed, offset).
 */
function centralRecord({ nameBuf, flags, method, time, date, crc, csize, usize, offset }) {
  const big = [usize, csize, offset].filter((v) => v >= MAX32);
  const extra = big.length ? zip64Extra(big) : Buffer.alloc(0);
  const version = big.length ? 45 : 20;
  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(CENTRAL, 0);
  entry.writeUInt16LE(version, 4); // made by (MS-DOS attributes, none set)
  entry.writeUInt16LE(version, 6); // needed: 4.5 for Zip64
  entry.writeUInt16LE(flags, 8);
  entry.writeUInt16LE(method, 10);
  entry.writeUInt16LE(time, 12);
  entry.writeUInt16LE(date, 14);
  entry.writeUInt32LE(crc >>> 0, 16);
  entry.writeUInt32LE(Math.min(csize, MAX32), 20);
  entry.writeUInt32LE(Math.min(usize, MAX32), 24);
  entry.writeUInt16LE(nameBuf.length, 28);
  entry.writeUInt16LE(extra.length, 30);
  entry.writeUInt32LE(Math.min(offset, MAX32), 42);
  return Buffer.concat([entry, nameBuf, extra]);
}

/**
 * The end of the archive, for `count` files and a central directory of
 * `cdSize` bytes at `cdAt`. When one of them does not fit the classic end
 * record, the Zip64 end record and its locator come first (on one disk: the
 * locator says 1 disk in all, which Windows needs), and each classic field
 * that does not fit is 0xFFFF or 0xFFFFFFFF.
 */
function endRecords(count, cdSize, cdAt) {
  const tail = Buffer.alloc(22);
  tail.writeUInt32LE(EOCD, 0);
  tail.writeUInt16LE(Math.min(count, MAX16), 8);
  tail.writeUInt16LE(Math.min(count, MAX16), 10);
  tail.writeUInt32LE(Math.min(cdSize, MAX32), 12);
  tail.writeUInt32LE(Math.min(cdAt, MAX32), 16);
  if (count < MAX16 && cdSize < MAX32 && cdAt < MAX32) return tail;
  const end64 = Buffer.alloc(56);
  end64.writeUInt32LE(ZIP64_END, 0);
  end64.writeBigUInt64LE(44n, 4); // the size of the rest of this record
  end64.writeUInt16LE(45, 12); // made by
  end64.writeUInt16LE(45, 14); // needed
  // (this disk and the one the central directory starts on: 0)
  end64.writeBigUInt64LE(BigInt(count), 24);
  end64.writeBigUInt64LE(BigInt(count), 32);
  end64.writeBigUInt64LE(BigInt(cdSize), 40);
  end64.writeBigUInt64LE(BigInt(cdAt), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(ZIP64_LOCATOR, 0);
  locator.writeBigUInt64LE(BigInt(cdAt + cdSize), 8); // where the Zip64 end record is
  locator.writeUInt32LE(1, 16); // disks in all
  return Buffer.concat([end64, locator, tail]);
}

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
  let count = buf.readUInt16LE(end + 10);
  let cdSize = buf.readUInt32LE(end + 12);
  let cdOffset = buf.readUInt32LE(end + 16);
  let cdEnd = end;
  if ((count === MAX16 || cdSize === MAX32 || cdOffset === MAX32) && end >= 20 && buf.readUInt32LE(end - 20) === ZIP64_LOCATOR) {
    // Zip64: the counts and the central directory's place are in the Zip64 end record
    const at = Number(buf.readBigUInt64LE(end - 12));
    if (at + 56 > end - 20 || buf.readUInt32LE(at) !== ZIP64_END) throw new ZipError('The .zip file is damaged.');
    count = Number(buf.readBigUInt64LE(at + 32));
    cdSize = Number(buf.readBigUInt64LE(at + 40));
    cdOffset = Number(buf.readBigUInt64LE(at + 48));
    cdEnd = at;
  }
  if (count > maxFiles) throw new ZipError(`Too many files (over ${maxFiles}).`);
  if (cdOffset + cdSize > cdEnd) throw new ZipError('The .zip file is damaged.');
  const files = [];
  let total = 0;
  let at = cdOffset;
  for (let n = 0; n < count; n++) {
    if (at + 46 > cdEnd || buf.readUInt32LE(at) !== CENTRAL) throw new ZipError('The .zip file is damaged.');
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    let csize = buf.readUInt32LE(at + 20);
    let usize = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const madeBy = buf.readUInt16LE(at + 4) >> 8;
    const attrs = buf.readUInt32LE(at + 38);
    let local = buf.readUInt32LE(at + 42);
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', at + 46, at + 46 + nameLen);
    if (at + 46 + nameLen + extraLen + commentLen > cdEnd) throw new ZipError('The .zip file is damaged.');
    if (usize === MAX32 || csize === MAX32 || local === MAX32) {
      // the Zip64 extra field holds the fields set to 0xFFFFFFFF, in this order
      let x = at + 46 + nameLen;
      const xEnd = x + extraLen;
      while (x + 4 <= xEnd && buf.readUInt16LE(x) !== 0x0001) x += 4 + buf.readUInt16LE(x + 2);
      if (x + 4 > xEnd) throw new ZipError('The .zip file is damaged.');
      let v = x + 4;
      const fieldEnd = Math.min(xEnd, v + buf.readUInt16LE(x + 2));
      const next = () => {
        if (v + 8 > fieldEnd) throw new ZipError('The .zip file is damaged.');
        v += 8;
        return Number(buf.readBigUInt64LE(v - 8));
      };
      if (usize === MAX32) usize = next();
      if (csize === MAX32) csize = next();
      if (local === MAX32) local = next();
    }
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
    const rec = { nameBuf, flags: 0x800, method: 8, time, date, crc: zlib.crc32(data), csize: packed.length, usize: data.length };
    const head = localHeader({ ...rec, zip64: packed.length >= MAX32 || data.length >= MAX32 });
    parts.push(head, packed);
    central.push(centralRecord({ ...rec, offset }));
    offset += head.length + packed.length;
  }
  const cd = Buffer.concat(central);
  return Buffer.concat([...parts, cd, endRecords(files.length, cd.length, offset)]);
}

/** A date and time as a .zip keeps it (DOS, local fields taken as UTC). */
function dosTime(ms) {
  const d = new Date(Number.isFinite(ms) ? ms : Date.UTC(2026, 0, 1));
  const y = Math.max(1980, Math.min(2107, d.getUTCFullYear()));
  return { time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1), date: ((y - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate() };
}

/**
 * Wait until `out` drains, or closes or fails. Resolves true on drain,
 * false when the reader went away. Both listeners come off again either
 * way, so a long download does not pile up one per backpressure wait.
 */
function waitDrain(out) {
  return new Promise((resolve) => {
    if (out.destroyed) return resolve(false);
    const done = (ok) => () => {
      out.off('drain', onDrain);
      out.off('close', onClose);
      out.off('error', onClose);
      resolve(ok);
    };
    const onDrain = done(true);
    const onClose = done(false);
    out.on('drain', onDrain);
    out.on('close', onClose);
    out.on('error', onClose);
  });
}

/**
 * Stream a .zip to `out` (an HTTP response) without holding the files: each
 * entry is stored as it is (a .log.xz is packed already), its CRC worked out
 * while it streams and written after it (a data descriptor).
 * `entries`: [{ name, data: Buffer } | { name, size, mtime, open: () => Readable }
 * | { name, mtime, make: async () => Buffer }] (made when its turn comes, so
 * a summary can go last and the download starts at once).
 * There is no limit on sizes or the number of files: Zip64 is used where it
 * is needed. `size: null`: not known before it is read (made while it streams,
 * as a log's candump text): whatever it gives is taken. Such an entry is
 * written as Zip64 from its local header on (the sizes after it in 8 bytes)
 * unless `maxSize` says it stays under 4 GiB. Resolves when it is written;
 * rejects (out destroyed) when a file changed size or could not be read, or
 * the reader went away.
 */
async function streamZip(out, entries) {
  let offset = 0;
  const central = [];
  const write = async (buf) => {
    if (out.destroyed) throw new ZipError('The download was stopped.');
    offset += buf.length;
    if (!out.write(buf) && !(await waitDrain(out))) throw new ZipError('The download was stopped.');
  };
  for (let e of entries) {
    if (e.make) {
      const data = await e.make();
      if (out.destroyed) throw new ZipError('The download was stopped.');
      e = { ...e, data };
    }
    const nameBuf = Buffer.from(e.name, 'utf8');
    const { time, date } = dosTime(e.mtime);
    const known = e.data || e.size !== null;
    let size = e.data ? e.data.length : e.size;
    const zip64 = known ? size >= MAX32 : !(e.maxSize < MAX32);
    const at = offset;
    // UTF-8 names, sizes and CRC in the descriptor after the data; stored
    const rec = { nameBuf, flags: 0x808, method: 0, time, date };
    await write(localHeader({ ...rec, zip64 }));
    let crc = 0;
    let n = 0;
    if (e.data) {
      crc = zlib.crc32(e.data);
      n = e.data.length;
      await write(e.data);
    } else {
      const src = e.open();
      try {
        for await (const chunk of src) {
          crc = zlib.crc32(chunk, crc);
          n += chunk.length;
          if (known && n > size) break;
          if (!zip64 && n >= MAX32) throw new ZipError(`${e.name} is larger than it was said to be.`);
          await write(chunk);
        }
      } finally { src.destroy?.(); }
      if (!known) size = n;
    }
    if (n !== size) throw new ZipError(`${e.name} changed while it was being sent.`);
    const desc = Buffer.alloc(zip64 ? 24 : 16);
    desc.writeUInt32LE(DESCRIPTOR, 0);
    desc.writeUInt32LE(crc >>> 0, 4);
    if (zip64) {
      desc.writeBigUInt64LE(BigInt(size), 8);
      desc.writeBigUInt64LE(BigInt(size), 16);
    } else {
      desc.writeUInt32LE(size, 8);
      desc.writeUInt32LE(size, 12);
    }
    await write(desc);
    central.push(centralRecord({ ...rec, crc, csize: size, usize: size, offset: at }));
  }
  const cd = Buffer.concat(central);
  const cdAt = offset;
  await write(cd);
  await write(endRecords(entries.length, cd.length, cdAt));
}

// (the record builders: for tests)
module.exports = { readZip, writeZip, streamZip, waitDrain, ZipError, zipRecords: { localHeader, centralRecord, endRecords } };
