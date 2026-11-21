// SPDX-License-Identifier: Apache-2.0
//! The orientation tag (0x0112) of an EXIF block (TIFF 6.0 layout, EXIF 2.3 §4.6.4).

/// `tiff` is the APP1 payload after `Exif\0\0`. 1 when there is no readable tag.
pub fn orientation(tiff: &[u8]) -> u8 {
    read(tiff).filter(|o| (1..=8).contains(o)).unwrap_or(1)
}

fn read(tiff: &[u8]) -> Option<u8> {
    let little = match tiff.get(..4)? {
        [b'I', b'I', 42, 0] => true,
        [b'M', b'M', 0, 42] => false,
        _ => return None,
    };
    let u16_at = |at: usize| -> Option<u16> {
        let b = tiff.get(at..at + 2)?;
        Some(if little {
            u16::from_le_bytes([b[0], b[1]])
        } else {
            u16::from_be_bytes([b[0], b[1]])
        })
    };
    let u32_at = |at: usize| -> Option<u32> {
        let b = tiff.get(at..at + 4)?;
        Some(if little {
            u32::from_le_bytes([b[0], b[1], b[2], b[3]])
        } else {
            u32::from_be_bytes([b[0], b[1], b[2], b[3]])
        })
    };
    let ifd = u32_at(4)? as usize;
    let count = u16_at(ifd)? as usize;
    for index in 0..count.min(512) {
        let entry = ifd + 2 + index * 12;
        // SHORT (3), count 1: the value sits in the first two bytes of the value field.
        if u16_at(entry)? == 0x0112 && u16_at(entry + 2)? == 3 && u32_at(entry + 4)? == 1 {
            return u8::try_from(u16_at(entry + 8)?).ok();
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn block(little: bool, value: u16) -> Vec<u8> {
        let u16b = |v: u16| {
            if little {
                v.to_le_bytes()
            } else {
                v.to_be_bytes()
            }
        };
        let u32b = |v: u32| {
            if little {
                v.to_le_bytes()
            } else {
                v.to_be_bytes()
            }
        };
        let mut b = if little {
            b"II".to_vec()
        } else {
            b"MM".to_vec()
        };
        b.extend(u16b(42));
        b.extend(u32b(8));
        b.extend(u16b(2));
        // An unrelated tag first, then the orientation.
        b.extend(u16b(0x010f));
        b.extend(u16b(2));
        b.extend(u32b(4));
        b.extend(u32b(0));
        b.extend(u16b(0x0112));
        b.extend(u16b(3));
        b.extend(u32b(1));
        b.extend(u16b(value));
        b.extend([0, 0]);
        b.extend(u32b(0));
        b
    }

    #[test]
    fn orientation_reads_either_byte_order_and_ignores_nonsense() {
        assert_eq!(orientation(&block(true, 6)), 6);
        assert_eq!(orientation(&block(false, 8)), 8);
        assert_eq!(orientation(&block(true, 9)), 1);
        assert_eq!(orientation(&block(true, 6)[..20]), 1);
        assert_eq!(orientation(b"nonsense"), 1);
    }
}
