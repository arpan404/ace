//! The clipboard a paste borrowed, kept on disk until it is put back, so a helper that dies
//! mid-paste restores it when the next one starts. Pure encoding: the clipboard sequence number
//! right after the borrow (the borrow is still on the clipboard only while it matches), then each
//! saved format and its bytes.

pub type Formats = Vec<(u32, Vec<u8>)>;

/// Largest file read back; anything bigger is not a borrow this helper wrote.
const LIMIT: usize = 256 * 1024 * 1024;

pub fn encode(sequence: u32, formats: &Formats) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + formats.iter().map(|(_, b)| 8 + b.len()).sum::<usize>());
    out.extend_from_slice(b"ACB1");
    out.extend_from_slice(&sequence.to_le_bytes());
    out.extend_from_slice(&(formats.len() as u32).to_le_bytes());
    for (format, bytes) in formats {
        out.extend_from_slice(&format.to_le_bytes());
        out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        out.extend_from_slice(bytes);
    }
    out
}

pub fn decode(data: &[u8]) -> Option<(u32, Formats)> {
    if data.len() > LIMIT || data.get(..4)? != b"ACB1" {
        return None;
    }
    let word = |at: usize| -> Option<u32> {
        Some(u32::from_le_bytes(data.get(at..at + 4)?.try_into().ok()?))
    };
    let sequence = word(4)?;
    let count = word(8)? as usize;
    let mut at = 12;
    let mut formats = Vec::new();
    for _ in 0..count.min(4096) {
        let format = word(at)?;
        let length = word(at + 4)? as usize;
        let bytes = data.get(at + 8..at + 8 + length)?.to_vec();
        formats.push((format, bytes));
        at += 8 + length;
    }
    (at == data.len()).then_some((sequence, formats))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_saved_borrow_reads_back_whole() {
        let formats = vec![
            (
                13,
                "hi\0".encode_utf16().flat_map(u16::to_le_bytes).collect(),
            ),
            (49_161, vec![]),
        ];
        assert_eq!(decode(&encode(77, &formats)), Some((77, formats)));
    }

    #[test]
    fn a_torn_or_foreign_file_is_ignored() {
        let whole = encode(1, &vec![(13, vec![1, 2, 3])]);
        assert_eq!(decode(&whole[..whole.len() - 1]), None);
        assert_eq!(decode(b"something else"), None);
        let mut longer = whole.clone();
        longer.push(0);
        assert_eq!(decode(&longer), None);
    }
}
