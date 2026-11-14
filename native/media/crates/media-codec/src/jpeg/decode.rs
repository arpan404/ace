// SPDX-License-Identifier: Apache-2.0
//! Baseline Huffman decode straight into Y/Cb/Cr planes, with no colour
//! conversion or chroma upsampling. Full-size blocks use libjpeg-turbo-rs's
//! runtime-selected SIMD IDCT; 1/2, 1/4 and 1/8 outputs use a reduced IDCT
//! over the low-frequency coefficients. Planes keep their capacity.
use super::entropy::{Bits, block, coefficient_limits, corrupt};
use super::header::{self, Frame, Tables};
use crate::resample::Layout;
use crate::{CodecError, Size};
use libjpeg_turbo_rs::simd::SimdRoutines;

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
/// Arithmetic is widened, so any u32 sizes are safe.
pub fn dct_scaled_size(source: Size, target: Size) -> Size {
    let n = u64::from(reduction(source, target));
    let scaled = |side: u32| (u64::from(side) * n).div_ceil(8) as u32;
    Size {
        width: scaled(source.width),
        height: scaled(source.height),
    }
}
fn reduction(source: Size, target: Size) -> u32 {
    let covers =
        |side: u32, want: u32, n: u32| u64::from(side) * u64::from(n) >= u64::from(want) * 8;
    [1, 2, 4]
        .into_iter()
        .find(|&n| covers(source.width, target.width, n) && covers(source.height, target.height, n))
        .unwrap_or(8)
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
        // Every block costs at least two bits (a DC code and an EOB or AC
        // code). Reject a payload too small for the declared size before
        // sizing planes for it.
        let blocks: usize = f.components[..f.count]
            .iter()
            .map(|c| c.h * c.v)
            .sum::<usize>()
            * mcus_x
            * mcus_y;
        if blocks.saturating_mul(2) > jpeg.len().saturating_sub(f.scan).saturating_mul(8) {
            return Err(corrupt("payload too small for the frame"));
        }
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
        let mut bits = Bits::new(jpeg, f.scan);
        let mut preds = [0_i32; 3];
        let mut until_restart = f.restart;
        let mut next_restart = 0_u8;
        let mut coeffs = [0_i16; 64];
        let mut limits = [[0_i32; 64]; 4];
        for (limit, quant) in limits.iter_mut().zip(&self.tables.quant) {
            *limit = coefficient_limits(quant);
        }
        let mut pixels = [0_u8; 64];
        for my in 0..mcus_y {
            for mx in 0..mcus_x {
                if f.restart > 0 {
                    if until_restart == 0 {
                        bits.restart(next_restart)?;
                        next_restart = (next_restart + 1) & 7;
                        preds = [0; 3];
                        until_restart = f.restart;
                    }
                    until_restart -= 1;
                }
                // Blocks arrive in SOS order; planes stay in SOF order.
                for &ci in &f.order[..f.count] {
                    let c = &f.components[ci];
                    let dc = &self.tables.dc[c.dc];
                    let ac = &self.tables.ac[c.ac];
                    let quant = &self.tables.quant[c.quant];
                    let stride = out.layouts[ci].stride;
                    let plane = &mut out.planes[ci];
                    for by in 0..c.v {
                        for bx in 0..c.h {
                            block(
                                &mut bits,
                                dc,
                                ac,
                                &limits[c.quant],
                                &mut preds[ci],
                                &mut coeffs,
                            )?;
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
        bits.finish()
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
