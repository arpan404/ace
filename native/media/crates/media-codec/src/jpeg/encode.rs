// SPDX-License-Identifier: Apache-2.0
//! Baseline JPEG encode from planar Y/Cb/Cr (4:2:0) or Y alone. Forward DCT
//! and quantisation use libjpeg-turbo-rs's runtime-selected SIMD kernel; the
//! entropy coder writes straight into the caller's buffer. Quantiser and
//! Huffman tables are rebuilt only when quality changes.
use super::decode::Ycc;
use crate::resample::Layout;
use crate::{CodecError, Size};
use libjpeg_turbo_rs::common::tables::{
    AC_CHROMINANCE_BITS, AC_CHROMINANCE_VALUES, AC_LUMINANCE_BITS, AC_LUMINANCE_VALUES,
    DC_CHROMINANCE_BITS, DC_CHROMINANCE_VALUES, DC_LUMINANCE_BITS, DC_LUMINANCE_VALUES,
    STD_CHROMINANCE_QUANT_TABLE, STD_LUMINANCE_QUANT_TABLE, ZIGZAG_ORDER,
};
use libjpeg_turbo_rs::encode::huffman_encode::{HuffTable, build_huff_table};
use libjpeg_turbo_rs::encode::marker_writer as marker;
use libjpeg_turbo_rs::encode::tables::quality_scale_quant_table;
use libjpeg_turbo_rs::simd::{EncoderSimdRoutines, QuantDivisors};

/// Output capacity that holds any 4:2:0 baseline JPEG this encoder writes
/// for natural images: three bytes per padded pixel plus headers.
/// Saturates rather than overflowing for sizes no encoder accepts.
pub fn jpeg_capacity(size: Size) -> usize {
    let padded = |side: u32| (side as usize).div_ceil(16).checked_mul(16);
    padded(size.width)
        .zip(padded(size.height))
        .and_then(|(w, h)| w.checked_mul(h))
        .and_then(|pixels| pixels.checked_mul(3))
        .and_then(|bytes| bytes.checked_add(2048))
        .unwrap_or(usize::MAX)
}

/// Reciprocal division by `d` for the SIMD quantiser: for 0 <= x < 2^15,
/// ((x + correction) * reciprocal) >> (16 + shift) == round(x / d), and
/// the AVX2 form replaces the shift with a second high multiply by `scale`.
fn reciprocal(d: u16) -> (u16, u16, u16, i16) {
    if d <= 1 {
        return (1, 0, 1, -16);
    }
    let mut r = 16 + (15 - d.leading_zeros()); // 16 + floor(log2 d)
    let q = (1_u32 << r) / u32::from(d);
    let rem = (1_u32 << r) % u32::from(d);
    let mut correction = d / 2;
    let recip = if rem == 0 {
        // Power of two: 2^r / d is exactly 2^16, one bit too wide.
        r -= 1;
        q >> 1
    } else if rem <= u32::from(d) / 2 {
        correction += 1;
        q
    } else {
        q + 1
    };
    (
        recip as u16,
        correction,
        (1_u32 << (32 - r)) as u16,
        (r - 16) as i16,
    )
}

fn divisors(quant: &[u16; 64]) -> QuantDivisors {
    let mut d = QuantDivisors {
        divisors: [0; 64],
        reciprocals: [0; 64],
        corrections: [0; 64],
        shifts: [0; 64],
        scales: [0; 64],
        divisors_zigzag: [0; 64],
        reciprocals_zigzag: [0; 64],
        corrections_zigzag: [0; 64],
        shifts_zigzag: [0; 64],
        scales_zigzag: [0; 64],
        float_divisors: [0.0; 64],
        float_divisors_zigzag: [0.0; 64],
    };
    for (i, q) in quant.iter().enumerate() {
        // The integer FDCT output is scaled by eight.
        let divisor = q * 8;
        let (recip, corr, scale, shift) = reciprocal(divisor);
        d.divisors[i] = divisor;
        d.reciprocals[i] = recip;
        d.corrections[i] = corr;
        d.scales[i] = scale;
        d.shifts[i] = shift;
        d.float_divisors[i] = 1.0 / f32::from(divisor);
    }
    for (zz, natural) in ZIGZAG_ORDER.iter().enumerate() {
        d.divisors_zigzag[zz] = d.divisors[*natural];
        d.reciprocals_zigzag[zz] = d.reciprocals[*natural];
        d.corrections_zigzag[zz] = d.corrections[*natural];
        d.scales_zigzag[zz] = d.scales[*natural];
        d.shifts_zigzag[zz] = d.shifts[*natural];
        d.float_divisors_zigzag[zz] = d.float_divisors[*natural];
    }
    d
}

struct Writer<'a> {
    out: &'a mut Vec<u8>,
    acc: u64,
    bits: u32,
}
impl Writer<'_> {
    #[inline(always)]
    fn put(&mut self, code: u32, size: u32) {
        self.acc = (self.acc << size) | u64::from(code);
        self.bits += size;
        if self.bits >= 32 {
            self.bits -= 32;
            let word = (self.acc >> self.bits) as u32;
            // A 0xFF byte needs a stuffed zero. The test may also flag 0xFE
            // after a carry, which only takes the slower exact path.
            if (word & 0x8080_8080) & !word.wrapping_add(0x0101_0101) != 0 {
                for byte in word.to_be_bytes() {
                    self.byte(byte);
                }
            } else {
                self.out.extend_from_slice(&word.to_be_bytes());
            }
        }
    }
    #[inline(always)]
    fn byte(&mut self, byte: u8) {
        self.out.push(byte);
        if byte == 0xFF {
            self.out.push(0);
        }
    }
    fn finish(mut self) {
        let pad = (8 - self.bits % 8) % 8;
        self.put((1 << pad) - 1, pad);
        while self.bits >= 8 {
            self.bits -= 8;
            self.byte((self.acc >> self.bits) as u8);
        }
    }
}

/// (size category, low bits) of a coefficient, as JPEG codes magnitudes.
#[inline(always)]
fn magnitude(v: i32) -> (u32, u32) {
    let size = 32 - v.unsigned_abs().leading_zeros();
    let bits = if v < 0 { v - 1 } else { v } as u32 & ((1_u32 << size) - 1);
    (size, bits)
}

struct Tables {
    dc: HuffTable,
    ac: HuffTable,
}
#[inline(always)]
fn emit(w: &mut Writer<'_>, t: &HuffTable, symbol: usize) {
    w.put(u32::from(t.ehufco[symbol]), u32::from(t.ehufsi[symbol]));
}
/// A Huffman code followed by its magnitude bits, in one write (at most 27 bits).
#[inline(always)]
fn emit_value(w: &mut Writer<'_>, t: &HuffTable, symbol: usize, bits: u32, size: u32) {
    let len = u32::from(t.ehufsi[symbol]);
    w.put((u32::from(t.ehufco[symbol]) << size) | bits, len + size);
}
fn encode_block(w: &mut Writer<'_>, zz: &[i16; 64], prev: &mut i16, t: &Tables) {
    let (size, bits) = magnitude(i32::from(zz[0]) - i32::from(*prev));
    *prev = zz[0];
    emit_value(w, &t.dc, size as usize, bits, size);
    let mut nonzero = 0_u64;
    for (k, v) in zz.iter().enumerate().skip(1) {
        nonzero |= u64::from(*v != 0) << k;
    }
    let mut last = 0;
    while nonzero != 0 {
        let k = nonzero.trailing_zeros();
        nonzero &= nonzero - 1;
        let mut run = k - last - 1;
        while run > 15 {
            emit(w, &t.ac, 0xF0);
            run -= 16;
        }
        // Standard tables code AC magnitudes up to ten bits.
        let (size, bits) = magnitude(i32::from(zz[k as usize]).clamp(-1023, 1023));
        emit_value(w, &t.ac, ((run << 4) | size) as usize, bits, size);
        last = k;
    }
    if last != 63 {
        emit(w, &t.ac, 0x00);
    }
}

pub(crate) struct BaselineEncoder {
    simd: EncoderSimdRoutines,
    quality: u8,
    quant: [[u16; 64]; 2],
    divisors: [QuantDivisors; 2],
    tables: [Tables; 2],
}
impl Default for BaselineEncoder {
    fn default() -> Self {
        let tables = |dc_bits, dc_values: &[u8], ac_bits, ac_values: &[u8]| Tables {
            dc: build_huff_table(dc_bits, dc_values),
            ac: build_huff_table(ac_bits, ac_values),
        };
        Self {
            simd: libjpeg_turbo_rs::simd::detect_encoder(),
            quality: 0,
            quant: [[1; 64]; 2],
            divisors: [divisors(&[1; 64]), divisors(&[1; 64])],
            tables: [
                tables(
                    &DC_LUMINANCE_BITS,
                    &DC_LUMINANCE_VALUES,
                    &AC_LUMINANCE_BITS,
                    &AC_LUMINANCE_VALUES,
                ),
                tables(
                    &DC_CHROMINANCE_BITS,
                    &DC_CHROMINANCE_VALUES,
                    &AC_CHROMINANCE_BITS,
                    &AC_CHROMINANCE_VALUES,
                ),
            ],
        }
    }
}
impl BaselineEncoder {
    /// Encode Y (and 4:2:0 chroma when `ycc.count` is 3) into `out`, keeping
    /// its capacity. Chroma planes must cover ceil(width/2) × ceil(height/2).
    pub(crate) fn encode(
        &mut self,
        ycc: &Ycc,
        quality: u8,
        out: &mut Vec<u8>,
    ) -> Result<(), CodecError> {
        if !(1..=100).contains(&quality) {
            return Err(CodecError::InvalidInput(
                "JPEG quality outside 1..100".into(),
            ));
        }
        let luma = ycc.layouts[0];
        let size = Size {
            width: luma.width,
            height: luma.height,
        };
        size.validate()?;
        let color = ycc.count == 3;
        if color {
            for c in &ycc.layouts[1..] {
                if c.width != size.width.div_ceil(2) || c.height != size.height.div_ceil(2) {
                    return Err(CodecError::InvalidInput("chroma plane size".into()));
                }
            }
        }
        if quality != self.quality {
            self.quant = [
                quality_scale_quant_table(&STD_LUMINANCE_QUANT_TABLE, quality),
                quality_scale_quant_table(&STD_CHROMINANCE_QUANT_TABLE, quality),
            ];
            self.divisors = [divisors(&self.quant[0]), divisors(&self.quant[1])];
            self.quality = quality;
        }
        out.clear();
        out.reserve(jpeg_capacity(size));
        self.headers(size, color, out);
        let mut w = Writer {
            out,
            acc: 0,
            bits: 0,
        };
        let mut preds = [0_i16; 3];
        let mut block = [0_i16; 64];
        let mut zz = [0_i16; 64];
        let mut code =
            |w: &mut Writer<'_>, plane: usize, x: usize, y: usize, preds: &mut [i16; 3]| {
                let table = usize::from(plane > 0);
                extract(&ycc.planes[plane], ycc.layouts[plane], x, y, &mut block);
                (self.simd.fdct_quantize)(&mut block, &self.divisors[table], &mut zz);
                encode_block(w, &zz, &mut preds[plane], &self.tables[table]);
            };
        if color {
            for my in 0..(size.height as usize).div_ceil(16) {
                for mx in 0..(size.width as usize).div_ceil(16) {
                    for (dx, dy) in [(0, 0), (8, 0), (0, 8), (8, 8)] {
                        code(&mut w, 0, mx * 16 + dx, my * 16 + dy, &mut preds);
                    }
                    code(&mut w, 1, mx * 8, my * 8, &mut preds);
                    code(&mut w, 2, mx * 8, my * 8, &mut preds);
                }
            }
        } else {
            for by in 0..(size.height as usize).div_ceil(8) {
                for bx in 0..(size.width as usize).div_ceil(8) {
                    code(&mut w, 0, bx * 8, by * 8, &mut preds);
                }
            }
        }
        w.finish();
        out.extend_from_slice(&[0xFF, 0xD9]);
        Ok(())
    }

    fn headers(&self, size: Size, color: bool, out: &mut Vec<u8>) {
        marker::write_soi(out);
        marker::write_app0_jfif(out);
        marker::write_dqt(out, 0, &self.quant[0]);
        let (w, h) = (size.width as u16, size.height as u16);
        if color {
            marker::write_dqt(out, 1, &self.quant[1]);
            marker::write_sof0(out, w, h, &[(1, 2, 2, 0), (2, 1, 1, 1), (3, 1, 1, 1)]);
        } else {
            marker::write_sof0(out, w, h, &[(1, 1, 1, 0)]);
        }
        marker::write_dht(out, 0, 0, &DC_LUMINANCE_BITS, &DC_LUMINANCE_VALUES);
        marker::write_dht(out, 1, 0, &AC_LUMINANCE_BITS, &AC_LUMINANCE_VALUES);
        if color {
            marker::write_dht(out, 0, 1, &DC_CHROMINANCE_BITS, &DC_CHROMINANCE_VALUES);
            marker::write_dht(out, 1, 1, &AC_CHROMINANCE_BITS, &AC_CHROMINANCE_VALUES);
            marker::write_sos(out, &[(1, 0, 0), (2, 1, 1), (3, 1, 1)]);
        } else {
            marker::write_sos(out, &[(1, 0, 0)]);
        }
    }
}

/// Level-shifted 8×8 block; edges replicate the last row and column.
#[inline(always)]
fn extract(plane: &[u8], l: Layout, x: usize, y: usize, block: &mut [i16; 64]) {
    let (w, h) = (l.width as usize, l.height as usize);
    if x + 8 <= w && y + 8 <= h {
        for (r, out) in block.chunks_exact_mut(8).enumerate() {
            let row = &plane[(y + r) * l.stride + x..][..8];
            for (o, s) in out.iter_mut().zip(row) {
                *o = i16::from(*s) - 128;
            }
        }
        return;
    }
    for (r, out) in block.chunks_exact_mut(8).enumerate() {
        let row = &plane[(y + r).min(h - 1) * l.stride..];
        for (c, o) in out.iter_mut().enumerate() {
            *o = i16::from(row[(x + c).min(w - 1)]) - 128;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::reciprocal;
    #[test]
    fn reciprocal_quantisation_rounds_exactly_like_division() {
        for q in 1..=255_u16 {
            let d = q * 8;
            let (recip, corr, scale, shift) = reciprocal(d);
            for x in 0..=16_383_u32 {
                let expected = (x + u32::from(d) / 2) / u32::from(d);
                let product = (x + u32::from(corr)) * u32::from(recip);
                assert_eq!(product >> (16 + shift as i32), expected, "d={d} x={x}");
                assert_eq!(
                    ((product >> 16) * u32::from(scale)) >> 16,
                    expected,
                    "d={d} x={x}"
                );
            }
        }
    }
}
