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
        assert_eq!(sniff(b""), None);
    }
}
