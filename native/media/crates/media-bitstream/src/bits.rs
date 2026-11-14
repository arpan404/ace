// SPDX-License-Identifier: Apache-2.0
//! Bit-level reading and writing of RBSP data: fixed-length fields and the exp-Golomb codes of
//! H.264 §9.1 and H.265 §9.2.
use crate::BitstreamError;

/// Writes bits most significant first. Holds the RBSP, before emulation prevention.
#[derive(Default, Clone, Debug)]
pub struct BitWriter {
    bytes: Vec<u8>,
    current: u8,
    used: u8,
}

impl BitWriter {
    pub fn new() -> Self {
        Self::default()
    }

    /// `u(n)` for `n` up to 32. Bits above `n` are ignored.
    pub fn bits(&mut self, value: u32, n: u8) {
        debug_assert!(n <= 32);
        for i in (0..n).rev() {
            self.bit((value >> i) & 1 == 1);
        }
    }

    pub fn bit(&mut self, set: bool) {
        self.current = (self.current << 1) | u8::from(set);
        self.used += 1;
        if self.used == 8 {
            self.bytes.push(self.current);
            self.current = 0;
            self.used = 0;
        }
    }

    /// `ue(v)`: unsigned exp-Golomb.
    pub fn ue(&mut self, value: u32) {
        let code = u64::from(value) + 1;
        let len = 63 - code.leading_zeros() as u8; // floor(log2(code))
        for _ in 0..len {
            self.bit(false);
        }
        for i in (0..=len).rev() {
            self.bit((code >> i) & 1 == 1);
        }
    }

    /// `se(v)`: signed exp-Golomb (positive values map to odd code numbers).
    pub fn se(&mut self, value: i32) {
        let code = if value > 0 {
            (i64::from(value) * 2 - 1) as u32
        } else {
            (-i64::from(value) * 2) as u32
        };
        self.ue(code);
    }

    /// `rbsp_trailing_bits()`: a stop bit, then zeros to the byte boundary.
    pub fn trailing(&mut self) {
        self.bit(true);
        self.align_zero();
    }

    /// Zero bits up to the next byte boundary.
    pub fn align_zero(&mut self) {
        while self.used != 0 {
            self.bit(false);
        }
    }

    pub fn is_aligned(&self) -> bool {
        self.used == 0
    }

    pub fn bit_len(&self) -> usize {
        self.bytes.len() * 8 + usize::from(self.used)
    }

    /// The bytes written; a partial last byte is padded with zeros.
    pub fn into_bytes(mut self) -> Vec<u8> {
        if self.used != 0 {
            let pad = 8 - self.used;
            self.bytes.push(self.current << pad);
        }
        self.bytes
    }
}

/// Reads bits from an RBSP (emulation prevention already removed).
#[derive(Clone, Debug)]
pub struct BitReader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> BitReader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    pub fn position(&self) -> usize {
        self.pos
    }

    pub fn remaining(&self) -> usize {
        (self.data.len() * 8).saturating_sub(self.pos)
    }

    pub fn bit(&mut self) -> Result<bool, BitstreamError> {
        let byte = *self
            .data
            .get(self.pos / 8)
            .ok_or(BitstreamError::Truncated)?;
        let set = (byte >> (7 - self.pos % 8)) & 1 == 1;
        self.pos += 1;
        Ok(set)
    }

    pub fn flag(&mut self) -> Result<bool, BitstreamError> {
        self.bit()
    }

    /// `u(n)` for `n` up to 32.
    pub fn bits(&mut self, n: u8) -> Result<u32, BitstreamError> {
        let mut value = 0u32;
        for _ in 0..n {
            value = (value << 1) | u32::from(self.bit()?);
        }
        Ok(value)
    }

    pub fn u8(&mut self, n: u8) -> Result<u8, BitstreamError> {
        debug_assert!(n <= 8);
        Ok(self.bits(n)? as u8)
    }

    pub fn ue(&mut self) -> Result<u32, BitstreamError> {
        let mut zeros = 0u8;
        while !self.bit()? {
            zeros += 1;
            if zeros > 31 {
                return Err(BitstreamError::Invalid("exp-Golomb code too long"));
            }
        }
        let rest = u64::from(self.bits(zeros)?);
        let value = (1u64 << zeros) - 1 + rest;
        u32::try_from(value).map_err(|_| BitstreamError::Invalid("exp-Golomb value overflows"))
    }

    pub fn se(&mut self) -> Result<i32, BitstreamError> {
        let code = i64::from(self.ue()?);
        let value = if code % 2 == 1 {
            (code + 1) / 2
        } else {
            -(code / 2)
        };
        i32::try_from(value).map_err(|_| BitstreamError::Invalid("exp-Golomb value overflows"))
    }

    /// `ue(v)` bounded by `max`, as the syntax tables constrain most fields.
    pub fn ue_max(&mut self, max: u32, what: &'static str) -> Result<u32, BitstreamError> {
        let value = self.ue()?;
        if value > max {
            return Err(BitstreamError::Invalid(what));
        }
        Ok(value)
    }

    /// `more_rbsp_data()`: true while anything but the trailing stop bit and its zero padding
    /// remains.
    pub fn more_rbsp_data(&self) -> bool {
        let Some(last) = self.data.iter().rposition(|b| *b != 0) else {
            return false;
        };
        let stop = last * 8 + 7 - self.data[last].trailing_zeros() as usize;
        self.pos < stop
    }

    /// Checks `rbsp_trailing_bits()` at the current position.
    pub fn trailing(&mut self) -> Result<(), BitstreamError> {
        if !self.bit()? {
            return Err(BitstreamError::Invalid("missing RBSP stop bit"));
        }
        while !self.pos.is_multiple_of(8) {
            if self.bit()? {
                return Err(BitstreamError::Invalid("nonzero RBSP alignment bit"));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    /// H.264 Table 9-2 / H.265 Table 9-2: code numbers and their bit strings.
    #[test]
    fn exp_golomb_codes_match_the_spec_table() {
        let table: [(u32, &str); 9] = [
            (0, "1"),
            (1, "010"),
            (2, "011"),
            (3, "00100"),
            (4, "00101"),
            (5, "00110"),
            (6, "00111"),
            (7, "0001000"),
            (8, "0001001"),
        ];
        for (code, bits) in table {
            let mut w = BitWriter::new();
            w.ue(code);
            assert_eq!(w.bit_len(), bits.len(), "length of {code}");
            let bytes = w.into_bytes();
            let mut r = BitReader::new(&bytes);
            let read: String = (0..bits.len())
                .map(|_| if r.bit().unwrap() { '1' } else { '0' })
                .collect();
            assert_eq!(read, bits);
            assert_eq!(BitReader::new(&bytes).ue().unwrap(), code);
        }
    }

    /// H.264 Table 9-3: signed mapping 1 → 1, 2 → −1, 3 → 2, 4 → −2.
    #[test]
    fn signed_exp_golomb_maps_as_the_spec_table() {
        for (value, code) in [(0, 0u32), (1, 1), (-1, 2), (2, 3), (-2, 4), (3, 5)] {
            let mut w = BitWriter::new();
            w.se(value);
            let mut expect = BitWriter::new();
            expect.ue(code);
            assert_eq!(w.clone().into_bytes(), expect.into_bytes());
            assert_eq!(BitReader::new(&w.into_bytes()).se().unwrap(), value);
        }
    }

    #[test]
    fn extreme_values_round_trip() {
        let mut w = BitWriter::new();
        w.ue(u32::MAX - 1);
        w.se(i32::MIN + 1);
        w.se(i32::MAX);
        w.bits(0xdead_beef, 32);
        let bytes = w.into_bytes();
        let mut r = BitReader::new(&bytes);
        assert_eq!(r.ue().unwrap(), u32::MAX - 1);
        assert_eq!(r.se().unwrap(), i32::MIN + 1);
        assert_eq!(r.se().unwrap(), i32::MAX);
        assert_eq!(r.bits(32).unwrap(), 0xdead_beef);
    }

    #[test]
    fn trailing_bits_end_the_payload() {
        let mut w = BitWriter::new();
        w.bits(0b101, 3);
        w.trailing();
        let bytes = w.into_bytes();
        assert_eq!(bytes, [0b1011_0000]);
        let mut r = BitReader::new(&bytes);
        r.bits(3).unwrap();
        assert!(!r.more_rbsp_data());
        r.trailing().unwrap();
    }

    #[test]
    fn a_runaway_code_is_rejected_not_looped_on() {
        let zeros = [0u8; 8];
        assert!(BitReader::new(&zeros).ue().is_err());
    }
}
