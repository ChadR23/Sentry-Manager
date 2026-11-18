//! src/main/converter/teslaSei.js: the one canonical Tesla H.264 SEI NAL
//! (type-5 user data with the 42..42 69 marker, nothing else in it) and the
//! SHA-256 fingerprint of its payload.

use sha2::{Digest, Sha256};

/// Strict: an escape that is not followed by 0..3, or 00 00 0x (x <= 2), is invalid (None).
pub fn remove_emulation_prevention_bytes(buf: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(buf.len());
    let mut zeros = 0;
    for i in 0..buf.len() {
        let b = buf[i];
        if zeros >= 2 && b == 0x03 {
            if i + 1 >= buf.len() || buf[i + 1] > 0x03 {
                return None;
            }
            zeros = 0;
            continue;
        }
        if zeros >= 2 && b <= 0x02 {
            return None;
        }
        out.push(b);
        zeros = if b == 0 { zeros + 1 } else { 0 };
    }
    Some(out)
}

/// readSeiField: ff-extended value at `cursor`, None at the end.
pub fn read_sei_field(rbsp: &[u8], cursor: &mut usize) -> Option<usize> {
    let mut value = 0usize;
    while *cursor < rbsp.len() && rbsp[*cursor] == 0xff {
        value += 0xff;
        *cursor += 1;
    }
    if *cursor >= rbsp.len() {
        return None;
    }
    value += rbsp[*cursor] as usize;
    *cursor += 1;
    Some(value)
}

/// teslaPayload(h264Sei): the payload after the marker, or None.
pub fn tesla_payload(sei: &[u8]) -> Option<Vec<u8>> {
    if sei.len() < 5 || sei[0] != 0x06 {
        return None;
    }
    let rbsp = remove_emulation_prevention_bytes(&sei[1..])?;
    if rbsp.first() != Some(&5) {
        return None;
    }
    let mut c = 0;
    let typ = read_sei_field(&rbsp, &mut c);
    let size = read_sei_field(&rbsp, &mut c);
    let (Some(5), Some(size)) = (typ, size) else { return None };
    if size > rbsp.len() - c {
        return None;
    }
    let end = c + size;
    if end + 1 != rbsp.len() || rbsp[end] != 0x80 {
        return None;
    }
    let payload = &rbsp[c..end];
    let mut m = 0;
    while m < payload.len() && payload[m] == 0x42 {
        m += 1;
    }
    if m == 0 || m >= payload.len() || payload[m] != 0x69 {
        return None;
    }
    Some(payload[m + 1..].to_vec())
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex(&Sha256::digest(data))
}

pub fn hex(bytes: &[u8]) -> String {
    const D: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(D[(b >> 4) as usize] as char);
        s.push(D[(b & 15) as usize] as char);
    }
    s
}

/// fingerprint(payload)
pub fn fingerprint(payload: &[u8]) -> String {
    sha256_hex(payload)
}

/// A canonical Tesla SEI NAL around `payload` (for tests and fixtures).
pub fn build_sei(payload: &[u8]) -> Vec<u8> {
    let mut rbsp = vec![5u8];
    let mut n = payload.len() + 4;
    while n >= 0xff {
        rbsp.push(0xff);
        n -= 0xff;
    }
    rbsp.push(n as u8);
    rbsp.extend_from_slice(&[0x42, 0x42, 0x42, 0x69]);
    rbsp.extend_from_slice(payload);
    rbsp.push(0x80);
    let mut out = vec![0x06];
    let mut zeros = 0;
    for b in rbsp {
        if zeros >= 2 && b <= 3 {
            out.push(3);
            zeros = 0;
        }
        out.push(b);
        zeros = if b == 0 { zeros + 1 } else { 0 };
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_record_and_refusals() {
        let p = [0x08, 0x00, 0x00, 0x01, 0x10, 0x20];
        assert_eq!(tesla_payload(&build_sei(&p)).unwrap(), p.to_vec());
        let mut long = vec![0x11u8; 600];
        long[0] = 0;
        assert_eq!(tesla_payload(&build_sei(&long)).unwrap(), long);
        let mut bad = build_sei(&p);
        *bad.last_mut().unwrap() = 0x81;
        assert!(tesla_payload(&bad).is_none());
        let mut no_marker = build_sei(&p);
        no_marker[3] = 0x41;
        assert!(tesla_payload(&no_marker).is_none());
        assert!(tesla_payload(&[0x06, 5, 1, 0x42]).is_none());
        assert!(remove_emulation_prevention_bytes(&[0, 0, 3, 9]).is_none());
        assert!(remove_emulation_prevention_bytes(&[0, 0, 2]).is_none());
        assert_eq!(remove_emulation_prevention_bytes(&[0, 0, 3, 1]).unwrap(), vec![0, 0, 1]);
    }
}
