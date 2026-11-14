// SPDX-License-Identifier: Apache-2.0
//! Huffman entropy decoding for one baseline scan. Only bytes that really
//! precede the next marker count as data: running out of them, meeting a
//! marker early, leftover data before a restart, a wrong RSTn or a missing EOI
//! are all errors. Coefficients are checked against baseline 8-bit limits
//! before narrowing.
use super::header::HuffDecode;
use crate::CodecError;
use libjpeg_turbo_rs::common::tables::ZIGZAG_ORDER;

const FAST: u32 = 9;
/// Baseline 8-bit category limits (ITU T.81 F.1.2.1 and F.1.2.2).
const MAX_DC_CATEGORY: u8 = 11;
const MAX_AC_CATEGORY: u8 = 10;
/// The DC coefficient of 8-bit samples needs at most eleven bits plus sign.
const DC_RANGE: std::ops::RangeInclusive<i32> = -2048..=2047;
/// Level-shifted 8-bit samples give |F(u,v)| <= 1024 for every DCT
/// coefficient, and rounding to a quantiser adds at most half a step. Twice
/// that bound still rejects values no 8-bit picture can produce, which IDCTs
/// would only overflow on.
const MAX_DEQUANTISED: i32 = 2048;

/// Largest quantised magnitude allowed per natural-order coefficient.
pub(crate) fn coefficient_limits(quant: &[u16; 64]) -> [i32; 64] {
    let mut limits = [0; 64];
    for (limit, q) in limits.iter_mut().zip(quant) {
        *limit = MAX_DEQUANTISED / i32::from((*q).max(1));
    }
    limits
}

pub(crate) fn corrupt(what: &str) -> CodecError {
    CodecError::InvalidInput(format!("corrupt JPEG scan: {what}"))
}

pub(crate) struct Bits<'a> {
    data: &'a [u8],
    pos: usize,
    acc: u64,
    /// Real data bits held in `acc`; lower bits are zero and never consumed.
    count: u32,
}
impl<'a> Bits<'a> {
    pub(crate) fn new(data: &'a [u8], pos: usize) -> Self {
        Self {
            data,
            pos,
            acc: 0,
            count: 0,
        }
    }

    /// Top up `acc` with whole bytes, stopping at a marker or the end.
    #[inline(always)]
    fn refill(&mut self) {
        // Eight bytes with no 0xFF need no unstuffing or marker check.
        if let Some(chunk) = self.data.get(self.pos..self.pos + 8) {
            let word = u64::from_be_bytes(chunk.try_into().unwrap_or([0xFF; 8]));
            let inverted = !word;
            let has_ff =
                inverted.wrapping_sub(0x0101_0101_0101_0101) & !inverted & 0x8080_8080_8080_8080;
            let take = (64 - self.count) / 8;
            if has_ff == 0 && take > 0 {
                let bits = take * 8;
                self.acc |= (word >> (64 - bits)) << (64 - bits - self.count);
                self.count += bits;
                self.pos += take as usize;
                return;
            }
        }
        while self.count <= 56 {
            let Some(&b) = self.data.get(self.pos) else {
                return;
            };
            let byte = if b != 0xFF {
                self.pos += 1;
                b
            } else if self.data.get(self.pos + 1) == Some(&0) {
                self.pos += 2;
                0xFF
            } else {
                // A marker (or fill before one) ends the entropy data.
                return;
            };
            self.acc |= u64::from(byte) << (56 - self.count);
            self.count += 8;
        }
    }
    #[inline(always)]
    fn consume(&mut self, n: u32) -> Result<(), CodecError> {
        if n > self.count {
            return Err(corrupt("entropy data ends early"));
        }
        self.acc <<= n;
        self.count -= n;
        Ok(())
    }
    #[inline(always)]
    fn symbol(&mut self, t: &HuffDecode) -> Result<u8, CodecError> {
        if self.count < 16 {
            self.refill();
        }
        let entry = t.fast[(self.acc >> (64 - FAST)) as usize];
        if entry != 0 {
            self.consume(u32::from(entry >> 8))?;
            return Ok(entry as u8);
        }
        let mut len = FAST as usize + 1;
        while len <= 16 {
            let code = (self.acc >> (64 - len)) as i32;
            if code <= t.maxcode[len] {
                self.consume(len as u32)?;
                return t
                    .values
                    .get((t.offset[len] + code) as usize)
                    .copied()
                    .ok_or_else(|| corrupt("Huffman code"));
            }
            len += 1;
        }
        Err(corrupt("Huffman code"))
    }
    /// Receive `n` bits and sign-extend them (JPEG's EXTEND).
    #[inline(always)]
    fn value(&mut self, n: u8) -> Result<i32, CodecError> {
        if n == 0 {
            return Ok(0);
        }
        let n = u32::from(n);
        if self.count < n {
            self.refill();
        }
        let v = (self.acc >> (64 - n)) as i32;
        self.consume(n)?;
        Ok(if v < 1 << (n - 1) {
            v - (1 << n) + 1
        } else {
            v
        })
    }

    /// End an interval: only one-bit padding may remain before the marker.
    fn end_interval(&mut self) -> Result<(), CodecError> {
        self.refill();
        if self.count >= 8 {
            return Err(corrupt("data continues past the interval"));
        }
        if self.count > 0 && self.acc >> (64 - self.count) != (1 << self.count) - 1 {
            return Err(corrupt("padding bits"));
        }
        self.acc = 0;
        self.count = 0;
        while self.data.get(self.pos..self.pos + 2) == Some(&[0xFF, 0xFF]) {
            self.pos += 1;
        }
        Ok(())
    }
    fn marker(&mut self, marker: u8) -> Result<(), CodecError> {
        if self.data.get(self.pos..self.pos + 2) != Some(&[0xFF, marker]) {
            return Err(corrupt(if marker == 0xD9 {
                "missing EOI"
            } else {
                "missing or out-of-order RSTn"
            }));
        }
        self.pos += 2;
        Ok(())
    }
    /// Expect RST`index` (0..8) after the current interval.
    pub(crate) fn restart(&mut self, index: u8) -> Result<(), CodecError> {
        self.end_interval()?;
        self.marker(0xD0 + (index & 7))
    }
    /// The scan must end exactly at EOI.
    pub(crate) fn finish(&mut self) -> Result<(), CodecError> {
        self.end_interval()?;
        self.marker(0xD9)
    }
}

/// Decode one block into natural order, validating every coefficient.
#[inline(always)]
pub(crate) fn block(
    bits: &mut Bits<'_>,
    dc: &HuffDecode,
    ac: &HuffDecode,
    limits: &[i32; 64],
    pred: &mut i32,
    coeffs: &mut [i16; 64],
) -> Result<(), CodecError> {
    *coeffs = [0; 64];
    let s = bits.symbol(dc)?;
    if s > MAX_DC_CATEGORY {
        return Err(corrupt("DC category"));
    }
    let dc_value = *pred + bits.value(s)?;
    if !DC_RANGE.contains(&dc_value) || dc_value.abs() > limits[0] {
        return Err(corrupt("DC coefficient out of range"));
    }
    *pred = dc_value;
    coeffs[0] = dc_value as i16;
    let mut k = 1;
    while k < 64 {
        let rs = bits.symbol(ac)?;
        let (run, size) = (usize::from(rs >> 4), rs & 15);
        if size == 0 {
            match run {
                0 => break,
                // ZRL: sixteen zeros, then a coefficient must still fit.
                15 if k + 16 <= 63 => {
                    k += 16;
                    continue;
                }
                _ => return Err(corrupt("AC run")),
            }
        }
        if size > MAX_AC_CATEGORY {
            return Err(corrupt("AC category"));
        }
        k += run;
        let natural = *ZIGZAG_ORDER.get(k).ok_or_else(|| corrupt("AC run"))?;
        // Ten bits keep the value within ±1023, well inside i16.
        let value = bits.value(size)?;
        if value.abs() > limits[natural] {
            return Err(corrupt("coefficient outside the 8-bit range"));
        }
        coeffs[natural] = value as i16;
        k += 1;
    }
    Ok(())
}
