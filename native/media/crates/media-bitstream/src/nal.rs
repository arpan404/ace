// SPDX-License-Identifier: Apache-2.0
//! NAL unit framing: emulation prevention (H.264 §7.4.1, H.265 §7.4.2), Annex B byte streams
//! and the length-prefixed form of ISO/IEC 14496-15.
use crate::BitstreamError;

/// RBSP → NAL payload: inserts `emulation_prevention_three_byte` after two zero bytes when the
/// next byte is 0–3, and after a final zero byte.
pub fn escape_into(rbsp: &[u8], out: &mut Vec<u8>) {
    let mut zeros = 0;
    for &byte in rbsp {
        if zeros >= 2 && byte <= 3 {
            out.push(3);
            zeros = 0;
        }
        out.push(byte);
        zeros = if byte == 0 { zeros + 1 } else { 0 };
    }
    if rbsp.last() == Some(&0) {
        out.push(3);
    }
}

/// NAL payload → RBSP: drops each `0x03` that follows two zero bytes.
pub fn unescape(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len());
    let mut zeros = 0;
    for &byte in payload {
        if zeros >= 2 && byte == 3 {
            zeros = 0;
            continue;
        }
        out.push(byte);
        zeros = if byte == 0 { zeros + 1 } else { 0 };
    }
    out
}

/// The NAL units of an Annex B byte stream, without start codes or trailing zero bytes.
pub fn annex_b_units(stream: &[u8]) -> AnnexBUnits<'_> {
    let start = find_start_code(stream, 0).map_or(stream.len(), |(_, end)| end);
    AnnexBUnits {
        stream,
        next: start,
    }
}

pub struct AnnexBUnits<'a> {
    stream: &'a [u8],
    next: usize,
}

impl<'a> Iterator for AnnexBUnits<'a> {
    type Item = &'a [u8];
    fn next(&mut self) -> Option<&'a [u8]> {
        while self.next < self.stream.len() {
            let begin = self.next;
            let (end, after) = find_start_code(self.stream, begin)
                .unwrap_or((self.stream.len(), self.stream.len()));
            self.next = after;
            let mut unit = &self.stream[begin..end];
            while let [rest @ .., 0] = unit {
                unit = rest;
            }
            if !unit.is_empty() {
                return Some(unit);
            }
        }
        None
    }
}

/// `(start of the 00 00 01, first byte after it)`.
fn find_start_code(data: &[u8], from: usize) -> Option<(usize, usize)> {
    let mut i = from;
    while i + 3 <= data.len() {
        match data[i + 2] {
            1 if data[i] == 0 && data[i + 1] == 0 => return Some((i, i + 3)),
            0 => i += 1,
            _ => i += 3,
        }
    }
    None
}

/// The NAL units of a length-prefixed sample (AVCC/HVCC), with `length_size` of 1, 2 or 4.
pub fn length_prefixed_units(
    sample: &[u8],
    length_size: usize,
) -> Result<Vec<&[u8]>, BitstreamError> {
    if !matches!(length_size, 1 | 2 | 4) {
        return Err(BitstreamError::Invalid("length size must be 1, 2 or 4"));
    }
    let mut units = Vec::new();
    let mut rest = sample;
    while !rest.is_empty() {
        let (head, tail) = rest
            .split_at_checked(length_size)
            .ok_or(BitstreamError::Truncated)?;
        let len = head.iter().fold(0usize, |n, b| (n << 8) | usize::from(*b));
        let (unit, tail) = tail
            .split_at_checked(len)
            .ok_or(BitstreamError::Truncated)?;
        units.push(unit);
        rest = tail;
    }
    Ok(units)
}

/// Annex B → length-prefixed, appended to `out` (cleared first) so callers can reuse it.
pub fn annex_b_to_length_prefixed(
    stream: &[u8],
    length_size: usize,
    out: &mut Vec<u8>,
) -> Result<(), BitstreamError> {
    if !matches!(length_size, 1 | 2 | 4) {
        return Err(BitstreamError::Invalid("length size must be 1, 2 or 4"));
    }
    out.clear();
    for unit in annex_b_units(stream) {
        let len = unit.len();
        if length_size < 4 && len >> (length_size * 8) != 0 {
            return Err(BitstreamError::Invalid(
                "NAL unit too long for the length size",
            ));
        }
        let len = u32::try_from(len).map_err(|_| BitstreamError::Invalid("NAL unit too long"))?;
        out.extend_from_slice(&len.to_be_bytes()[4 - length_size..]);
        out.extend_from_slice(unit);
    }
    Ok(())
}

/// Length-prefixed → Annex B with four-byte start codes, into `out` (cleared first).
pub fn length_prefixed_to_annex_b(
    sample: &[u8],
    length_size: usize,
    out: &mut Vec<u8>,
) -> Result<(), BitstreamError> {
    let units = length_prefixed_units(sample, length_size)?;
    out.clear();
    for unit in units {
        out.extend_from_slice(&[0, 0, 0, 1]);
        out.extend_from_slice(unit);
    }
    Ok(())
}

/// Appends one NAL unit to an Annex B stream: start code, header bytes, escaped RBSP.
pub fn push_annex_b(out: &mut Vec<u8>, header: &[u8], rbsp: &[u8]) {
    out.extend_from_slice(&[0, 0, 0, 1]);
    out.extend_from_slice(header);
    escape_into(rbsp, out);
}

/// H.264 NAL unit types used here (Table 7-1).
pub mod h264 {
    pub const SLICE: u8 = 1;
    pub const IDR: u8 = 5;
    pub const SEI: u8 = 6;
    pub const SPS: u8 = 7;
    pub const PPS: u8 = 8;
    pub const AUD: u8 = 9;

    pub fn unit_type(unit: &[u8]) -> Option<u8> {
        unit.first().map(|b| b & 0x1f)
    }
    pub fn is_key(unit: &[u8]) -> bool {
        unit_type(unit) == Some(IDR)
    }
    /// `forbidden_zero_bit`, `nal_ref_idc` and `nal_unit_type` as one byte.
    pub fn header(ref_idc: u8, unit_type: u8) -> u8 {
        ((ref_idc & 3) << 5) | (unit_type & 0x1f)
    }
}

/// H.265 NAL unit types used here (Table 7-1).
pub mod hevc {
    pub const TRAIL_N: u8 = 0;
    pub const TRAIL_R: u8 = 1;
    pub const BLA_W_LP: u8 = 16;
    pub const IDR_W_RADL: u8 = 19;
    pub const IDR_N_LP: u8 = 20;
    pub const CRA: u8 = 21;
    pub const VPS: u8 = 32;
    pub const SPS: u8 = 33;
    pub const PPS: u8 = 34;
    pub const AUD: u8 = 35;
    pub const PREFIX_SEI: u8 = 39;

    pub fn unit_type(unit: &[u8]) -> Option<u8> {
        unit.first().map(|b| (b >> 1) & 0x3f)
    }
    /// IRAP pictures: BLA, IDR and CRA (types 16–21).
    pub fn is_irap_type(unit_type: u8) -> bool {
        (BLA_W_LP..=CRA).contains(&unit_type)
    }
    pub fn is_idr_type(unit_type: u8) -> bool {
        unit_type == IDR_W_RADL || unit_type == IDR_N_LP
    }
    pub fn is_key(unit: &[u8]) -> bool {
        unit_type(unit).is_some_and(is_irap_type)
    }
    /// The two-byte header with layer 0 and the given temporal id.
    pub fn header(unit_type: u8, temporal_id: u8) -> [u8; 2] {
        [(unit_type & 0x3f) << 1, (temporal_id & 7) + 1]
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn emulation_prevention_guards_every_start_code_prefix() {
        let rbsp = [0, 0, 0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0];
        let mut escaped = Vec::new();
        escape_into(&rbsp, &mut escaped);
        assert_eq!(
            escaped,
            [
                0, 0, 3, 0, 0, 3, 0, 1, 0, 0, 3, 2, 0, 0, 3, 3, 0, 0, 4, 0, 3
            ]
        );
        assert!(
            !escaped
                .windows(3)
                .any(|w| w[0] == 0 && w[1] == 0 && w[2] <= 2)
        );
        assert_eq!(unescape(&escaped)[..rbsp.len()], rbsp);
    }

    #[test]
    fn annex_b_splits_on_three_and_four_byte_start_codes() {
        let stream = [
            0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 0, 1, 0x65, 9, 0,
        ];
        let units: Vec<&[u8]> = annex_b_units(&stream).collect();
        assert_eq!(units, vec![&[0x67, 1, 2][..], &[0x68, 3], &[0x65, 9]]);
        assert!(h264::is_key(units[2]));
        assert_eq!(h264::unit_type(units[0]), Some(h264::SPS));
    }

    #[test]
    fn annex_b_and_length_prefixed_convert_both_ways() {
        let stream = [0, 0, 0, 1, 0x40, 1, 0, 0, 1, 0x42, 1, 7];
        let mut avcc = Vec::new();
        annex_b_to_length_prefixed(&stream, 4, &mut avcc).unwrap();
        assert_eq!(avcc, [0, 0, 0, 2, 0x40, 1, 0, 0, 0, 3, 0x42, 1, 7]);
        let mut back = Vec::new();
        length_prefixed_to_annex_b(&avcc, 4, &mut back).unwrap();
        assert_eq!(back, [0, 0, 0, 1, 0x40, 1, 0, 0, 0, 1, 0x42, 1, 7]);
        assert_eq!(hevc::unit_type(&[0x40, 1]), Some(hevc::VPS));
    }

    #[test]
    fn a_truncated_length_prefixed_sample_is_an_error() {
        assert_eq!(
            length_prefixed_units(&[0, 0, 0, 9, 1, 2], 4),
            Err(BitstreamError::Truncated)
        );
        assert!(length_prefixed_units(&[0, 0], 3).is_err());
        let mut out = Vec::new();
        assert!(annex_b_to_length_prefixed(&[0, 0, 1, 1, 2], 3, &mut out).is_err());
    }

    #[test]
    fn hevc_keyframes_are_the_irap_types() {
        for t in 0..64u8 {
            let unit = hevc::header(t, 0);
            assert_eq!(hevc::is_key(&unit), (16..=21).contains(&t), "type {t}");
        }
    }
}
