// SPDX-License-Identifier: Apache-2.0
//! Standard base64 (RFC 4648 §4), as Chrome's screencast frames carry their JPEG. Pure and
//! bounded: text past [`MAX_TEXT`] is refused before anything is allocated.

/// The longest text decoded: the normal lane's 8 MiB frame bound.
pub const MAX_TEXT: usize = 8 << 20;

fn value(c: u8) -> Option<u32> {
    Some(u32::from(match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' => 62,
        b'/' => 63,
        _ => return None,
    }))
}

/// The bytes `text` encodes, or `None` for text that isn't padded standard base64.
pub fn decode(text: &[u8]) -> Option<Vec<u8>> {
    if text.len() > MAX_TEXT || !text.len().is_multiple_of(4) {
        return None;
    }
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let quads = text.len() / 4;
    for (index, quad) in text.chunks_exact(4).enumerate() {
        let padding = match (quad[2], quad[3]) {
            (b'=', b'=') => 2,
            (_, b'=') => 1,
            _ => 0,
        };
        if padding > 0 && index + 1 != quads {
            return None;
        }
        let mut bits = 0u32;
        for &c in &quad[..4 - padding] {
            bits = bits << 6 | value(c)?;
        }
        bits <<= 6 * padding as u32;
        let bytes = [(bits >> 16) as u8, (bits >> 8) as u8, bits as u8];
        out.extend_from_slice(&bytes[..3 - padding]);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc_4648_test_vectors_decode() {
        let cases: [(&str, &str); 7] = [
            ("", ""),
            ("Zg==", "f"),
            ("Zm8=", "fo"),
            ("Zm9v", "foo"),
            ("Zm9vYg==", "foob"),
            ("Zm9vYmE=", "fooba"),
            ("Zm9vYmFy", "foobar"),
        ];
        for (text, bytes) in cases {
            assert_eq!(decode(text.as_bytes()).as_deref(), Some(bytes.as_bytes()));
        }
    }

    #[test]
    fn text_that_is_not_padded_standard_base64_is_refused() {
        for text in ["Zm9", "Zm9v!A==", "Zg==Zm9v", "Zm-v", "Z==="] {
            assert_eq!(decode(text.as_bytes()), None, "{text}");
        }
    }
}
