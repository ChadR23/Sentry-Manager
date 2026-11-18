//! The CAN Bridge's `canbridge-columns-xz/2` body (after `xz -dc`) back to
//! the exact candump text a `/1` log of the same frames holds: a port of
//! server/canColumns.js (the bridge's own tools/columns-to-candump.js), with
//! the same checks and the same error texts.

pub const MAGIC: &[u8] = b"CANBRIDGE-COLUMNS/2\n";
const MAX_KEYS: usize = 65536;
const MAX_KEY_BYTES: usize = 64;
const MAX_DATA: u8 = 64;
const MAX_LINE: usize = 65536;
const MAX_TIME_US: u128 = 999_999_999_999_999_999;

pub fn is_columns(buf: &[u8]) -> bool {
    buf.len() >= MAGIC.len() && &buf[..MAGIC.len()] == MAGIC
}

struct R<'a> {
    b: &'a [u8],
    pos: usize,
}

type E = String;

impl<'a> R<'a> {
    fn byte(&mut self) -> Result<u8, E> {
        if self.pos >= self.b.len() {
            return Err("cut off".into());
        }
        self.pos += 1;
        Ok(self.b[self.pos - 1])
    }
    /// unsigned LEB128, up to 64 bits (and the 10th byte's extra bits, as the BigInt reader keeps them)
    fn varint(&mut self) -> Result<u128, E> {
        let mut v: u128 = 0;
        let mut shift = 0u32;
        loop {
            if shift > 63 {
                return Err("varint too long".into());
            }
            let c = self.byte()?;
            v |= ((c & 0x7f) as u128) << shift;
            if c & 0x80 == 0 {
                return Ok(v);
            }
            shift += 7;
        }
    }
    fn small(&mut self) -> Result<f64, E> {
        let mut v = 0f64;
        let mut mul = 1f64;
        for i in 0.. {
            if i > 7 {
                return Err("number too large".into());
            }
            let c = self.byte()?;
            v += (c & 0x7f) as f64 * mul;
            if c & 0x80 == 0 {
                return Ok(v);
            }
            mul *= 128.0;
        }
        unreachable!()
    }
    fn count(&mut self, max: f64) -> Result<usize, E> {
        let n = self.small()?;
        if n > max {
            return Err(format!("count {} out of range", crate::can::json::num_str(n)));
        }
        Ok(n as usize)
    }
    fn bytes(&mut self, n: usize) -> Result<&'a [u8], E> {
        if n > self.b.len() - self.pos {
            return Err("cut off".into());
        }
        let s = &self.b[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }
}

/// The frame count a body's header says it holds (canColumnsWorker.js frameCount), or -1.
pub fn frame_count(b: &[u8]) -> f64 {
    let mut pos = MAGIC.len();
    let small = |pos: &mut usize| -> f64 {
        let mut v = 0f64;
        let mut mul = 1f64;
        for _ in 0..8 {
            if *pos >= b.len() {
                return -1.0;
            }
            let c = b[*pos];
            *pos += 1;
            v += (c & 0x7f) as f64 * mul;
            if c & 0x80 == 0 {
                return v;
            }
            mul *= 128.0;
        }
        -1.0
    };
    let keys = small(&mut pos);
    if keys < 0.0 {
        return -1.0;
    }
    for _ in 0..keys as u64 {
        let n = small(&mut pos);
        if n < 0.0 || n > (b.len() - pos) as f64 {
            return -1.0;
        }
        pos += n as usize;
    }
    let notes = small(&mut pos);
    if notes < 0.0 {
        return -1.0;
    }
    for _ in 0..notes as u64 {
        if small(&mut pos) < 0.0 {
            return -1.0;
        }
        let n = small(&mut pos);
        if n < 0.0 || n > (b.len() - pos) as f64 {
            return -1.0;
        }
        pos += n as usize;
    }
    small(&mut pos)
}

/// Decodes a whole body and calls on_line for each line (latin1 bytes, without its LF), in order.
/// on_line returns false to stop early (Ok then).
pub fn decode(body: &[u8], mut on_line: impl FnMut(&[u8]) -> bool) -> Result<(), E> {
    if !is_columns(body) {
        return Err("not a columns log".into());
    }
    let mut r = R { b: body, pos: MAGIC.len() };
    let key_count = r.count(MAX_KEYS as f64)?;
    let mut keys: Vec<&[u8]> = Vec::with_capacity(key_count);
    for _ in 0..key_count {
        let n = r.count(MAX_KEY_BYTES as f64)?;
        keys.push(r.bytes(n)?);
    }
    let note_count = r.count(body.len() as f64)?;
    let mut note_pos = Vec::with_capacity(note_count.min(1 << 20));
    let mut notes: Vec<&[u8]> = Vec::with_capacity(note_count.min(1 << 20));
    for j in 0..note_count {
        let p = r.small()?;
        if j > 0 && p < note_pos[j - 1] {
            return Err("notes out of order".into());
        }
        note_pos.push(p);
        let n = r.count(MAX_LINE as f64)?;
        notes.push(r.bytes(n)?);
    }
    let frames = r.count(((body.len() - r.pos) / 3) as f64)?;
    if note_count > 0 && note_pos[note_count - 1] > frames as f64 {
        return Err("note after the last frame".into());
    }
    let mut times: Vec<u128> = Vec::with_capacity(frames);
    let mut t: i128 = 0;
    for _ in 0..frames {
        let z = r.varint()? as i128;
        t += if z & 1 == 1 { -((z >> 1) + 1) } else { z >> 1 };
        if t < 0 || t as u128 > MAX_TIME_US {
            return Err("time out of range".into());
        }
        times.push(t as u128);
    }
    let mut key_of = vec![0u32; frames];
    for k in key_of.iter_mut() {
        let x = r.small()?;
        if x >= key_count as f64 {
            return Err("bad key index".into());
        }
        *k = x as u32;
    }
    // frames grouped by key, in their order within each key
    let mut start = vec![0usize; key_count + 1];
    for &k in &key_of {
        start[k as usize + 1] += 1;
    }
    for k in 0..key_count {
        start[k + 1] += start[k];
    }
    let mut fill = start[..key_count].to_vec();
    let mut order = vec![0u32; frames];
    for (f, &k) in key_of.iter().enumerate() {
        order[fill[k as usize]] = f as u32;
        fill[k as usize] += 1;
    }
    let mut lens = vec![0u8; frames];
    for x in 0..frames {
        let n = r.byte()?;
        if n > MAX_DATA {
            return Err("data too long".into());
        }
        lens[order[x] as usize] = n;
    }
    let mut at = vec![0usize; frames];
    let mut total = 0usize;
    for f in 0..frames {
        at[f] = total;
        total += lens[f] as usize;
    }
    if total > body.len() - r.pos {
        return Err("data cut off".into());
    }
    let mut data = vec![0u8; total];
    for k in 0..key_count {
        let mut longest = 0u8;
        for x in start[k]..start[k + 1] {
            longest = longest.max(lens[order[x] as usize]);
        }
        for j in 0..longest {
            for x in start[k]..start[k + 1] {
                let f = order[x] as usize;
                if lens[f] > j {
                    data[at[f] + j as usize] = r.byte()?;
                }
            }
        }
    }
    if r.pos != body.len() {
        return Err("trailing bytes".into());
    }
    const HEX: &[u8] = b"0123456789ABCDEF";
    let mut note = 0usize;
    let mut line = Vec::with_capacity(160);
    for f in 0..=frames {
        while note < note_count && note_pos[note] == f as f64 {
            if !on_line(notes[note]) {
                return Ok(());
            }
            note += 1;
        }
        if f == frames {
            break;
        }
        line.clear();
        let us = times[f];
        line.push(b'(');
        line.extend_from_slice((us / 1_000_000).to_string().as_bytes());
        line.push(b'.');
        line.extend_from_slice(format!("{:06}", us % 1_000_000).as_bytes());
        line.extend_from_slice(b") ");
        line.extend_from_slice(keys[key_of[f] as usize]);
        line.push(b'#');
        for j in 0..lens[f] as usize {
            let v = data[at[f] + j];
            line.push(HEX[(v >> 4) as usize]);
            line.push(HEX[(v & 15) as usize]);
        }
        if !on_line(&line) {
            return Ok(());
        }
    }
    Ok(())
}
