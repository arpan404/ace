// SPDX-License-Identifier: Apache-2.0
//! Which format bytes are, from their first bytes (never from a name or a MIME type).
use media_wire::image::SourceFormat;

const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

pub fn sniff(bytes: &[u8]) -> Option<SourceFormat> {
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some(SourceFormat::Jpeg);
    }
    if bytes.starts_with(PNG) {
        return Some(SourceFormat::Png);
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some(SourceFormat::Gif);
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some(SourceFormat::Webp);
    }
    if bytes.len() >= 6 && bytes[..4] == [0, 0, 1, 0] && (bytes[4] != 0 || bytes[5] != 0) {
        return Some(SourceFormat::Ico);
    }
    if bytes.len() >= 26 && bytes.starts_with(b"BM") {
        let info = u32::from_le_bytes([bytes[14], bytes[15], bytes[16], bytes[17]]);
        if matches!(info, 12 | 40 | 52 | 56 | 64 | 108 | 124) {
            return Some(SourceFormat::Bmp);
        }
    }
    if bytes.starts_with(b"II*\0") || bytes.starts_with(b"MM\0*") {
        return Some(SourceFormat::Tiff);
    }
    if crate::heif::sniff(bytes) {
        return Some(SourceFormat::Heic);
    }
    svg(bytes).then_some(SourceFormat::Svg)
}

/// SVG markup: an `<svg` root after a byte-order mark, white space, an XML declaration,
/// comments or a doctype.
fn svg(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(4096)];
    let head = head.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(head);
    let text = String::from_utf8_lossy(head);
    let mut rest = text.trim_start();
    loop {
        let skipped = if rest.starts_with("<?") {
            rest.find("?>").map(|end| &rest[end + 2..])
        } else if rest.starts_with("<!--") {
            rest.find("-->").map(|end| &rest[end + 3..])
        } else if rest
            .as_bytes()
            .get(..9)
            .is_some_and(|b| b.eq_ignore_ascii_case(b"<!doctype"))
        {
            rest.find('>').map(|end| &rest[end + 1..])
        } else {
            break;
        };
        match skipped {
            Some(next) => rest = next.trim_start(),
            None => return false,
        }
    }
    let b = rest.as_bytes();
    b.len() >= 4
        && b[..4].eq_ignore_ascii_case(b"<svg")
        && b.get(4)
            .is_none_or(|c| c.is_ascii_whitespace() || *c == b'>' || *c == b'/')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_come_from_the_bytes() {
        assert_eq!(sniff(&[0xff, 0xd8, 0xff, 0xe0]), Some(SourceFormat::Jpeg));
        assert_eq!(sniff(PNG), Some(SourceFormat::Png));
        assert_eq!(sniff(b"GIF89a...."), Some(SourceFormat::Gif));
        assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8 "), Some(SourceFormat::Webp));
        assert_eq!(sniff(&[0, 0, 1, 0, 1, 0]), Some(SourceFormat::Ico));
        assert_eq!(
            sniff(b"\xef\xbb\xbf<?xml version='1.0'?><!-- a --><!DOCTYPE svg><svg width='1'/>"),
            Some(SourceFormat::Svg)
        );
        assert_eq!(sniff(b"  <svg>"), Some(SourceFormat::Svg));
        assert_eq!(sniff("<své".as_bytes()), None);
        assert_eq!(sniff(b"<svgx>"), None);
        assert_eq!(sniff(b"<html><svg></svg></html>"), None);
        assert_eq!(sniff(&[0, 0, 1, 0, 0, 0]), None);
        let mut bmp = b"BM".to_vec();
        bmp.extend([0; 12]);
        bmp.extend(40u32.to_le_bytes());
        bmp.extend([0; 8]);
        assert_eq!(sniff(&bmp), Some(SourceFormat::Bmp));
        assert_eq!(sniff(b"BM not a bitmap header at all"), None);
        assert_eq!(sniff(b"II*\0\x08\0\0\0"), Some(SourceFormat::Tiff));
        assert_eq!(sniff(b"MM\0*\0\0\0\x08"), Some(SourceFormat::Tiff));
        assert_eq!(
            sniff(b"\0\0\0\x18ftypheic\0\0\0\0mif1heic"),
            Some(SourceFormat::Heic)
        );
        assert_eq!(sniff(b""), None);
    }
}
