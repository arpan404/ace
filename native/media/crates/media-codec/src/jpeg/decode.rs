// SPDX-License-Identifier: Apache-2.0
//! Baseline Huffman decode straight into Y/Cb/Cr planes, with no colour
//! conversion or chroma upsampling. Full-size blocks use libjpeg-turbo-rs's
//! runtime-selected SIMD IDCT; 1/2, 1/4 and 1/8 outputs use a reduced IDCT
//! over the low-frequency coefficients. Planes keep their capacity.
use super::header::{self, Frame, HuffDecode, Tables};
use crate::resample::Layout;
use crate::{CodecError, Size};
use libjpeg_turbo_rs::common::tables::ZIGZAG_ORDER;
use libjpeg_turbo_rs::simd::SimdRoutines;

const FAST: u32 = 9;

fn corrupt() -> CodecError {
    CodecError::InvalidInput("corrupt JPEG entropy data".into())
}

/// Planar YCbCr samples. `extents` give each plane's coverage in its own
/// samples, which is fractional for odd-sized subsampled chroma.
#[derive(Default)]
pub(crate) struct Ycc {
    pub planes: [Vec<u8>; 3],
    pub layouts: [Layout; 3],
    pub extents: [(f64, f64); 3],
    pub count: usize,
}

/// The DCT-scaled decode size for a target: the smallest of 1/8, 1/4 and 1/2
/// that still covers the target on both axes, otherwise full size.
pub fn dct_scaled_size(source: Size, target: Size) -> Size {
    let n = reduction(source, target);
    Size {
        width: (source.width * n).div_ceil(8),
        height: (source.height * n).div_ceil(8),
    }
}
fn reduction(source: Size, target: Size) -> u32 {
    [1, 2, 4]
        .into_iter()
        .find(|n| source.width * n >= target.width * 8 && source.height * n >= target.height * 8)
        .unwrap_or(8)
}

struct Bits<'a> {
    data: &'a [u8],
    pos: usize,
    acc: u64,
    count: u32,
}
impl Bits<'_> {
    #[inline(always)]
    fn refill(&mut self) {
        // Fast path: eight bytes with no 0xFF need no unstuffing or marker check.
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
            let mut byte = 0;
            if let Some(&b) = self.data.get(self.pos) {
                if b != 0xFF {
                    byte = b;
                    self.pos += 1;
                } else if self.data.get(self.pos + 1) == Some(&0) {
                    byte = 0xFF;
                    self.pos += 2;
                }
                // Any other 0xFF is a marker: feed zeros without consuming it.
            }
            self.acc |= u64::from(byte) << (56 - self.count);
            self.count += 8;
        }
    }
    #[inline(always)]
    fn consume(&mut self, n: u32) {
        self.acc <<= n;
        self.count -= n;
    }
    #[inline(always)]
    fn symbol(&mut self, t: &HuffDecode) -> Result<u8, CodecError> {
        if self.count < 16 {
            self.refill();
        }
        let entry = t.fast[(self.acc >> (64 - FAST)) as usize];
        if entry != 0 {
            self.consume(u32::from(entry >> 8));
            return Ok(entry as u8);
        }
        let mut len = FAST as usize + 1;
        let mut code = (self.acc >> (64 - len)) as i32;
        while code > t.maxcode[len] {
            len += 1;
            code = (self.acc >> (64 - len.min(16))) as i32;
        }
        if len > 16 {
            return Err(corrupt());
        }
        self.consume(len as u32);
        t.values
            .get((t.offset[len] + code) as usize)
            .copied()
            .ok_or_else(corrupt)
    }
    /// Receive `n` bits and sign-extend them (JPEG's EXTEND).
    #[inline(always)]
    fn value(&mut self, n: u8) -> Result<i32, CodecError> {
        if n == 0 {
            return Ok(0);
        }
        if n > 16 {
            return Err(corrupt());
        }
        let n = u32::from(n);
        if self.count < n {
            self.refill();
        }
        let v = (self.acc >> (64 - n)) as i32;
        self.consume(n);
        Ok(if v < 1 << (n - 1) {
            v - (1 << n) + 1
        } else {
            v
        })
    }
    /// Discard padding and step over the next RSTn marker.
    fn restart(&mut self) {
        self.acc = 0;
        self.count = 0;
        let rest = self.data.get(self.pos..).unwrap_or_default();
        // Usually the marker is next. Otherwise resynchronise at the next one;
        // with none left, stay at the end so later restarts cost nothing.
        self.pos += rest
            .windows(2)
            .position(|w| w[0] == 0xFF && (0xD0..=0xD7).contains(&w[1]))
            .map_or(rest.len(), |i| i + 2);
    }
}

pub(crate) struct BaselineDecoder {
    tables: Tables,
    simd: SimdRoutines,
    /// `basis[n][i][u]`: C(u)/2 · cos((2i+1)uπ / 2N) for N = 2 and 4.
    basis: [[[f32; 4]; 4]; 2],
}
impl Default for BaselineDecoder {
    fn default() -> Self {
        let mut basis = [[[0.0; 4]; 4]; 2];
        for (table, n) in basis.iter_mut().zip([2.0_f64, 4.0]) {
            for (i, row) in table.iter_mut().enumerate().take(n as usize) {
                for (u, value) in row.iter_mut().enumerate().take(n as usize) {
                    let c = if u == 0 {
                        std::f64::consts::FRAC_1_SQRT_2
                    } else {
                        1.0
                    };
                    let angle =
                        (2.0 * i as f64 + 1.0) * u as f64 * std::f64::consts::PI / (2.0 * n);
                    *value = (c / 2.0 * angle.cos()) as f32;
                }
            }
        }
        Self {
            tables: Tables::default(),
            simd: libjpeg_turbo_rs::simd::detect(),
            basis,
        }
    }
}
impl BaselineDecoder {
    /// Decode at the DCT scale covering `target`. `Unsupported` means the
    /// stream needs a general decoder; `InvalidInput` means it is malformed.
    pub(crate) fn decode(
        &mut self,
        jpeg: &[u8],
        target: Size,
        out: &mut Ycc,
    ) -> Result<(), CodecError> {
        target.validate()?;
        let f = header::parse(jpeg, &mut self.tables)?;
        let n = reduction(f.size, target) as usize;
        let mcu_w = 8 * f.hmax;
        let mcu_h = 8 * f.vmax;
        let mcus_x = (f.size.width as usize).div_ceil(mcu_w);
        let mcus_y = (f.size.height as usize).div_ceil(mcu_h);
        out.count = f.count;
        for (i, c) in f.components[..f.count].iter().enumerate() {
            let stride = mcus_x * c.h * n;
            out.planes[i].resize(stride * mcus_y * c.v * n, 0);
            let scale_x = (c.h * n) as f64 / mcu_w as f64;
            let scale_y = (c.v * n) as f64 / mcu_h as f64;
            let extent = (
                f64::from(f.size.width) * scale_x,
                f64::from(f.size.height) * scale_y,
            );
            out.extents[i] = extent;
            out.layouts[i] = Layout {
                width: extent.0.ceil() as u32,
                height: extent.1.ceil() as u32,
                stride,
            };
        }
        self.scan(jpeg, &f, n, mcus_x, mcus_y, out)
    }

    fn scan(
        &self,
        jpeg: &[u8],
        f: &Frame,
        n: usize,
        mcus_x: usize,
        mcus_y: usize,
        out: &mut Ycc,
    ) -> Result<(), CodecError> {
        let mut bits = Bits {
            data: jpeg,
            pos: f.scan,
            acc: 0,
            count: 0,
        };
        let mut preds = [0_i32; 3];
        let mut until_restart = f.restart;
        let mut coeffs = [0_i16; 64];
        let mut pixels = [0_u8; 64];
        for my in 0..mcus_y {
            for mx in 0..mcus_x {
                if f.restart > 0 {
                    if until_restart == 0 {
                        bits.restart();
                        preds = [0; 3];
                        until_restart = f.restart;
                    }
                    until_restart -= 1;
                }
                for (ci, c) in f.components[..f.count].iter().enumerate() {
                    let dc = &self.tables.dc[c.dc];
                    let ac = &self.tables.ac[c.ac];
                    let quant = &self.tables.quant[c.quant];
                    let stride = out.layouts[ci].stride;
                    let plane = &mut out.planes[ci];
                    for by in 0..c.v {
                        for bx in 0..c.h {
                            block(&mut bits, dc, ac, &mut preds[ci], &mut coeffs)?;
                            let x = (mx * c.h + bx) * n;
                            let y = (my * c.v + by) * n;
                            let dst = &mut plane[y * stride + x..];
                            if n == 8 {
                                (self.simd.idct_islow)(&coeffs, quant, &mut pixels);
                                for (row, src) in pixels.chunks_exact(8).enumerate() {
                                    dst[row * stride..row * stride + 8].copy_from_slice(src);
                                }
                            } else {
                                self.reduced(n, &coeffs, quant, dst, stride);
                            }
                        }
                    }
                }
            }
        }
        Ok(())
    }

    fn reduced(
        &self,
        n: usize,
        coeffs: &[i16; 64],
        quant: &[u16; 64],
        dst: &mut [u8],
        stride: usize,
    ) {
        let sample = |v: f32| (v + 128.0).round().clamp(0.0, 255.0) as u8;
        if n == 1 {
            dst[0] = sample(f32::from(coeffs[0]) * f32::from(quant[0]) / 8.0);
            return;
        }
        let basis = &self.basis[usize::from(n == 4)];
        let mut rows = [[0.0_f32; 4]; 4];
        for (v, row) in rows.iter_mut().enumerate().take(n) {
            for (i, out) in row.iter_mut().enumerate().take(n) {
                *out = (0..n)
                    .map(|u| {
                        basis[i][u] * f32::from(coeffs[v * 8 + u]) * f32::from(quant[v * 8 + u])
                    })
                    .sum();
            }
        }
        for j in 0..n {
            for i in 0..n {
                let s: f32 = (0..n).map(|v| basis[j][v] * rows[v][i]).sum();
                dst[j * stride + i] = sample(s);
            }
        }
    }
}

#[inline(always)]
fn block(
    bits: &mut Bits<'_>,
    dc: &HuffDecode,
    ac: &HuffDecode,
    pred: &mut i32,
    coeffs: &mut [i16; 64],
) -> Result<(), CodecError> {
    *coeffs = [0; 64];
    let s = bits.symbol(dc)?;
    *pred = pred.wrapping_add(bits.value(s)?);
    coeffs[0] = *pred as i16;
    let mut k = 1;
    while k < 64 {
        let rs = bits.symbol(ac)?;
        let (run, size) = (usize::from(rs >> 4), rs & 15);
        if size == 0 {
            if run != 15 {
                break;
            }
            k += 16;
            continue;
        }
        k += run;
        let natural = *ZIGZAG_ORDER.get(k).ok_or_else(corrupt)?;
        coeffs[natural] = bits.value(size)? as i16;
        k += 1;
    }
    Ok(())
}
