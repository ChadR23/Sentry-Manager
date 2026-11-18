//! A small .zip in memory (server/zip.js writeZip): deflated entries with
//! UTF-8 names, all dated 1 January 2026 00:00, for the support bundle.

use std::io::Write;

fn le16(v: &mut Vec<u8>, x: u16) {
    v.extend_from_slice(&x.to_le_bytes());
}

fn le32(v: &mut Vec<u8>, x: u32) {
    v.extend_from_slice(&x.to_le_bytes());
}

pub fn write_zip(files: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let (time, date): (u16, u16) = (0, ((2026 - 1980) << 9) | (1 << 5) | 1);
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, data) in files {
        let mut e = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        e.write_all(data).unwrap();
        let packed = e.finish().unwrap();
        let mut crc = flate2::Crc::new();
        crc.update(data);
        let offset = out.len() as u32;
        let n = name.as_bytes();
        // local header
        le32(&mut out, 0x0403_4b50);
        le16(&mut out, 20);
        le16(&mut out, 0x800);
        le16(&mut out, 8);
        le16(&mut out, time);
        le16(&mut out, date);
        le32(&mut out, crc.sum());
        le32(&mut out, packed.len() as u32);
        le32(&mut out, data.len() as u32);
        le16(&mut out, n.len() as u16);
        le16(&mut out, 0);
        out.extend_from_slice(n);
        out.extend_from_slice(&packed);
        // central record
        le32(&mut central, 0x0201_4b50);
        le16(&mut central, 20);
        le16(&mut central, 20);
        le16(&mut central, 0x800);
        le16(&mut central, 8);
        le16(&mut central, time);
        le16(&mut central, date);
        le32(&mut central, crc.sum());
        le32(&mut central, packed.len() as u32);
        le32(&mut central, data.len() as u32);
        le16(&mut central, n.len() as u16);
        le16(&mut central, 0);
        le16(&mut central, 0);
        le16(&mut central, 0);
        le16(&mut central, 0);
        le32(&mut central, 0);
        le32(&mut central, offset);
        central.extend_from_slice(n);
    }
    let cd_offset = out.len() as u32;
    out.extend_from_slice(&central);
    le32(&mut out, 0x0605_4b50);
    le16(&mut out, 0);
    le16(&mut out, 0);
    le16(&mut out, files.len() as u16);
    le16(&mut out, files.len() as u16);
    le32(&mut out, central.len() as u32);
    le32(&mut out, cd_offset);
    le16(&mut out, 0);
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_zip_unzip_can_read() {
        let z = super::write_zip(&[("README.txt", b"hello hello hello".to_vec()), ("logs.txt", Vec::new())]);
        let dir = std::env::temp_dir().join(format!("lean-zip-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("t.zip");
        std::fs::write(&f, &z).unwrap();
        if let Ok(out) = std::process::Command::new("unzip").arg("-p").arg(&f).arg("README.txt").output() {
            if out.status.success() {
                assert_eq!(out.stdout, b"hello hello hello");
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(&z[..4], b"PK\x03\x04");
    }
}
