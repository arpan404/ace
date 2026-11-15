// SPDX-License-Identifier: Apache-2.0
//! Separable triangle-filter resampling. Taps are fixed-point i16, rebuilt only
//! when geometry changes; scratch rows are retained, so a repeated size pair
//! allocates nothing. The vertical pass runs first over whole rows, then the
//! horizontal pass reads at most eight taps per output sample.
use crate::CodecError;

const BITS: u32 = 14;
const ONE: i32 = 1 << BITS;
const ROUND: i32 = 1 << (BITS - 1);
/// Outputs whose taps fit eight source samples use the fixed-width kernel.
const FIXED: usize = 8;

/// The vector instruction set the resampling loops were compiled for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SimdKernel {
    Neon,
    Avx2,
    Scalar,
}
impl SimdKernel {
    /// NEON is architectural on aarch64; AVX2 is detected at run time.
    pub fn detect() -> Self {
        #[cfg(target_arch = "aarch64")]
        {
            Self::Neon
        }
        #[cfg(target_arch = "x86_64")]
        {
            if std::arch::is_x86_feature_detected!("avx2") {
                Self::Avx2
            } else {
                Self::Scalar
            }
        }
        #[cfg(not(any(target_arch = "aarch64", target_arch = "x86_64")))]
        {
            Self::Scalar
        }
    }
}

/// One axis: for each output sample, a start index and weights summing to ONE.
#[derive(Default)]
pub(crate) struct Taps {
    key: Option<(u32, u64, u32)>,
    /// Start of each output's eight-sample window (fixed layout) or taps.
    starts: Vec<u32>,
    /// Offset of the first nonzero tap within the window, and the tap count.
    spans: Vec<(u32, u32)>,
    weights: Vec<i16>,
    stride: usize,
    raw: Vec<f64>,
}
impl Taps {
    /// Map `out_len` samples onto `extent` source samples, of which `in_len`
    /// exist. Extent may be fractional (subsampled chroma); taps never read
    /// past `in_len`.
    pub(crate) fn plan(&mut self, in_len: u32, extent: f64, out_len: u32) {
        let key = (in_len, extent.to_bits(), out_len);
        if self.key == Some(key) {
            return;
        }
        let scale = extent / f64::from(out_len);
        let support = scale.max(1.0);
        let window = (support.ceil() as usize) * 2 + 1;
        let fixed = window <= FIXED && in_len as usize >= FIXED;
        self.stride = if fixed { FIXED } else { window };
        self.starts.clear();
        self.spans.clear();
        self.weights.clear();
        for out in 0..out_len {
            let center = (f64::from(out) + 0.5) * scale;
            let mut lo = ((center - support).floor().max(0.0) as u32).min(in_len - 1);
            let hi = ((center + support).ceil().max(0.0) as u32).clamp(lo + 1, in_len);
            self.raw.clear();
            let mut sum = 0.0;
            for x in lo..hi {
                let w = (1.0 - ((f64::from(x) + 0.5 - center) / support).abs()).max(0.0);
                self.raw.push(w);
                sum += w;
            }
            if sum <= 0.0 {
                lo = (center as u32).min(in_len - 1);
                self.raw.clear();
                self.raw.push(1.0);
                sum = 1.0;
            }
            // Trim zero weights at both ends; the triangle is zero at its support.
            let first = self.raw.iter().position(|w| *w > 0.0).unwrap_or(0);
            let last = self.raw.iter().rposition(|w| *w > 0.0).unwrap_or(0);
            let count = last + 1 - first;
            lo += first as u32;
            let start = if fixed {
                lo.min(in_len - FIXED as u32)
            } else {
                lo
            };
            let lead = (lo - start) as usize;
            let base = self.weights.len();
            self.weights.resize(base + self.stride, 0);
            let mut total = 0;
            let mut peak = base + lead;
            for (i, w) in self.raw[first..=last].iter().enumerate() {
                let q = (w / sum * f64::from(ONE)).round() as i32;
                let slot = base + lead + i;
                self.weights[slot] = q as i16;
                total += q;
                if q > i32::from(self.weights[peak]) {
                    peak = slot;
                }
            }
            // Exact unity gain: flat areas stay flat after rounding.
            self.weights[peak] = (i32::from(self.weights[peak]) + ONE - total) as i16;
            self.starts.push(start);
            self.spans.push((lead as u32, count as u32));
        }
        self.key = Some(key);
    }
    /// The nonzero taps of one output: first source index and weights.
    #[inline(always)]
    fn get(&self, out: usize) -> (usize, &[i16]) {
        let (lead, count) = self.spans[out];
        let base = out * self.stride + lead as usize;
        (
            (self.starts[out] + lead) as usize,
            &self.weights[base..base + count as usize],
        )
    }
}

/// Geometry of one 8-bit sample buffer: `channels` interleaved samples per pixel.
#[derive(Clone, Copy, Default)]
pub(crate) struct Layout {
    pub width: u32,
    pub height: u32,
    pub stride: usize,
}

/// Sample packing in and out of a resample.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Pack {
    Plane,
    Rgb,
    Rgba,
    /// BGRA in, RGB out.
    BgraToRgb,
}
impl Pack {
    fn channels(self) -> (usize, usize) {
        match self {
            Self::Plane => (1, 1),
            Self::Rgb => (3, 3),
            Self::Rgba => (4, 4),
            Self::BgraToRgb => (4, 3),
        }
    }
}

#[derive(Default)]
pub(crate) struct Resampler {
    horizontal: Taps,
    vertical: Taps,
    rows: Vec<u8>,
    acc: Vec<i32>,
}
impl Resampler {
    /// Resample `src`, covering `extent` source samples per axis, into `dst`.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn run(
        &mut self,
        kernel: SimdKernel,
        pack: Pack,
        src: &[u8],
        from: Layout,
        extent: (f64, f64),
        dst: &mut [u8],
        to: Layout,
    ) -> Result<(), CodecError> {
        let (channels, out_channels) = pack.channels();
        let row_bytes = from.width as usize * channels;
        if from.width == 0
            || from.height == 0
            || to.width == 0
            || to.height == 0
            || from.stride < row_bytes
            || src.len() < from.stride * (from.height as usize - 1) + row_bytes
            || to.stride < to.width as usize * out_channels
            || dst.len() < to.stride * (to.height as usize - 1) + to.width as usize * out_channels
        {
            return Err(CodecError::InvalidInput("resample geometry".into()));
        }
        self.vertical.plan(from.height, extent.1, to.height);
        self.horizontal.plan(from.width, extent.0, to.width);
        self.rows.resize(row_bytes * to.height as usize, 0);
        let pass = Pass {
            pack,
            src,
            src_stride: from.stride,
            row_bytes,
            vertical: &self.vertical,
            horizontal: &self.horizontal,
            rows: &mut self.rows,
            acc: &mut self.acc,
            dst,
            dst_stride: to.stride,
            dst_rows: to.height as usize,
        };
        run_passes(kernel, pass);
        Ok(())
    }
}

/// Everything both passes touch, so one call carries it into the
/// feature-specific copy.
struct Pass<'a> {
    pack: Pack,
    src: &'a [u8],
    src_stride: usize,
    row_bytes: usize,
    vertical: &'a Taps,
    horizontal: &'a Taps,
    rows: &'a mut Vec<u8>,
    acc: &'a mut Vec<i32>,
    dst: &'a mut [u8],
    dst_stride: usize,
    dst_rows: usize,
}

/// Both passes. `inline(always)` and closure-free, so every loop is compiled
/// inside whichever feature-enabled wrapper calls it.
#[inline(always)]
fn passes(p: Pass<'_>) {
    vertical(p.src, p.src_stride, p.row_bytes, p.vertical, p.rows, p.acc);
    let lines = p
        .dst
        .chunks_mut(p.dst_stride)
        .take(p.dst_rows)
        .zip(p.rows.chunks_exact(p.row_bytes));
    let taps = p.horizontal;
    match p.pack {
        Pack::Plane => {
            for (out, row) in lines {
                horizontal_plane(row, taps, out);
            }
        }
        Pack::Rgb => {
            for (out, row) in lines {
                horizontal_pixels::<3, 3>(row, taps, out, [0, 1, 2, 3]);
            }
        }
        Pack::Rgba => {
            for (out, row) in lines {
                horizontal_pixels::<4, 4>(row, taps, out, [0, 1, 2, 3]);
            }
        }
        Pack::BgraToRgb => {
            for (out, row) in lines {
                horizontal_pixels::<4, 3>(row, taps, out, [2, 1, 0, 3]);
            }
        }
    }
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
fn passes_avx2(p: Pass<'_>) {
    passes(p)
}

#[cfg(target_arch = "x86_64")]
#[allow(unsafe_code)]
fn run_passes(kernel: SimdKernel, p: Pass<'_>) {
    if kernel == SimdKernel::Avx2 && std::arch::is_x86_feature_detected!("avx2") {
        // SAFETY: AVX2 support was confirmed on this CPU immediately above.
        unsafe { passes_avx2(p) }
    } else {
        passes(p)
    }
}
/// NEON is architectural on aarch64, so the baseline build already uses it.
#[cfg(not(target_arch = "x86_64"))]
fn run_passes(_kernel: SimdKernel, p: Pass<'_>) {
    passes(p)
}

#[inline(always)]
fn clamp(acc: i32) -> u8 {
    (acc >> BITS).clamp(0, 255) as u8
}

#[inline(always)]
fn line(src: &[u8], stride: usize, row_bytes: usize, row: usize) -> &[u8] {
    &src[row * stride..row * stride + row_bytes]
}

/// Each output row is a weighted sum of whole source rows. Row slices are
/// bounds-checked once, so every inner loop is a plain vectorisable zip.
#[inline(always)]
fn vertical(
    src: &[u8],
    stride: usize,
    row_bytes: usize,
    taps: &Taps,
    rows: &mut [u8],
    acc: &mut Vec<i32>,
) {
    acc.resize(row_bytes, 0);
    for (y, out) in rows.chunks_exact_mut(row_bytes).enumerate() {
        let (start, weights) = taps.get(y);
        match weights.len() {
            1 => out.copy_from_slice(line(src, stride, row_bytes, start)),
            2 => {
                let (w0, w1) = (i32::from(weights[0]), i32::from(weights[1]));
                for ((o, a), b) in out
                    .iter_mut()
                    .zip(line(src, stride, row_bytes, start))
                    .zip(line(src, stride, row_bytes, start + 1))
                {
                    *o = clamp(ROUND + i32::from(*a) * w0 + i32::from(*b) * w1);
                }
            }
            3 => {
                let (w0, w1, w2) = (
                    i32::from(weights[0]),
                    i32::from(weights[1]),
                    i32::from(weights[2]),
                );
                for (((o, a), b), c) in out
                    .iter_mut()
                    .zip(line(src, stride, row_bytes, start))
                    .zip(line(src, stride, row_bytes, start + 1))
                    .zip(line(src, stride, row_bytes, start + 2))
                {
                    *o =
                        clamp(ROUND + i32::from(*a) * w0 + i32::from(*b) * w1 + i32::from(*c) * w2);
                }
            }
            4 => {
                let (w0, w1, w2, w3) = (
                    i32::from(weights[0]),
                    i32::from(weights[1]),
                    i32::from(weights[2]),
                    i32::from(weights[3]),
                );
                for ((((o, a), b), c), d) in out
                    .iter_mut()
                    .zip(line(src, stride, row_bytes, start))
                    .zip(line(src, stride, row_bytes, start + 1))
                    .zip(line(src, stride, row_bytes, start + 2))
                    .zip(line(src, stride, row_bytes, start + 3))
                {
                    *o = clamp(
                        ROUND
                            + i32::from(*a) * w0
                            + i32::from(*b) * w1
                            + i32::from(*c) * w2
                            + i32::from(*d) * w3,
                    );
                }
            }
            _ => {
                acc.fill(ROUND);
                for (k, weight) in weights.iter().enumerate() {
                    let weight = i32::from(*weight);
                    for (a, s) in acc.iter_mut().zip(line(src, stride, row_bytes, start + k)) {
                        *a += i32::from(*s) * weight;
                    }
                }
                for (o, a) in out.iter_mut().zip(acc.iter()) {
                    *o = clamp(*a);
                }
            }
        }
    }
}

#[inline(always)]
fn horizontal_plane(row: &[u8], taps: &Taps, out: &mut [u8]) {
    if taps.stride == FIXED {
        for (x, o) in out[..taps.starts.len()].iter_mut().enumerate() {
            let start = taps.starts[x] as usize;
            let s: &[u8; FIXED] = row[start..start + FIXED].try_into().unwrap_or(&[0; FIXED]);
            let w: &[i16; FIXED] = taps.weights[x * FIXED..x * FIXED + FIXED]
                .try_into()
                .unwrap_or(&[0; FIXED]);
            let mut acc = ROUND;
            for k in 0..FIXED {
                acc += i32::from(s[k]) * i32::from(w[k]);
            }
            *o = clamp(acc);
        }
        return;
    }
    for (x, o) in out[..taps.starts.len()].iter_mut().enumerate() {
        let (start, weights) = taps.get(x);
        let mut acc = ROUND;
        for (k, w) in weights.iter().enumerate() {
            acc += i32::from(row[start + k]) * i32::from(*w);
        }
        *o = clamp(acc);
    }
}

#[inline(always)]
fn horizontal_pixels<const C: usize, const O: usize>(
    row: &[u8],
    taps: &Taps,
    out: &mut [u8],
    order: [usize; 4],
) {
    for (x, o) in out[..taps.starts.len() * O].chunks_exact_mut(O).enumerate() {
        let (start, weights) = taps.get(x);
        let mut acc = [ROUND; C];
        for (k, w) in weights.iter().enumerate() {
            let w = i32::from(*w);
            let px = &row[(start + k) * C..][..C];
            for c in 0..C {
                acc[c] += i32::from(px[c]) * w;
            }
        }
        for (c, o) in o.iter_mut().enumerate() {
            *o = clamp(acc[order[c]]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn layout(width: u32, height: u32, channels: usize) -> Layout {
        Layout {
            width,
            height,
            stride: width as usize * channels,
        }
    }
    #[test]
    fn flat_planes_stay_flat_at_every_scale() {
        let mut r = Resampler::default();
        for (w, h, ow, oh) in [(1206, 2622, 722, 1568), (9, 7, 3, 2), (4, 4, 9, 9)] {
            let src = vec![77_u8; w * h];
            let mut dst = vec![0_u8; ow * oh];
            r.run(
                SimdKernel::detect(),
                Pack::Plane,
                &src,
                layout(w as u32, h as u32, 1),
                (w as f64, h as f64),
                &mut dst,
                layout(ow as u32, oh as u32, 1),
            )
            .unwrap_or_else(|e| panic!("{e}"));
            assert!(dst.iter().all(|v| *v == 77), "{w}x{h} -> {ow}x{oh}");
        }
    }
    #[test]
    fn halving_averages_neighbouring_samples() {
        let mut r = Resampler::default();
        let src = [0_u8, 100, 200, 250];
        let mut dst = [0_u8; 2];
        r.run(
            SimdKernel::detect(),
            Pack::Plane,
            &src,
            layout(4, 1, 1),
            (4.0, 1.0),
            &mut dst,
            layout(2, 1, 1),
        )
        .unwrap_or_else(|e| panic!("{e}"));
        // Radius-two triangles clipped at the edges: weights 3:3:1 and 1:3:3.
        assert_eq!(dst, [71, 207]);
    }
    #[test]
    fn vector_and_scalar_builds_resample_identically() {
        // Integer arithmetic: the AVX2/NEON build must match the scalar one
        // bit for bit. On aarch64 both run the NEON build.
        let mut seed = 0x9E37_79B9_7F4A_7C15_u64;
        let mut noise = |len: usize| -> Vec<u8> {
            (0..len)
                .map(|_| {
                    seed ^= seed << 13;
                    seed ^= seed >> 7;
                    seed ^= seed << 17;
                    seed as u8
                })
                .collect()
        };
        for (pack, channels, out_channels) in [
            (Pack::Plane, 1, 1),
            (Pack::Rgb, 3, 3),
            (Pack::Rgba, 4, 4),
            (Pack::BgraToRgb, 4, 3),
        ] {
            for (w, h, ow, oh) in [(1206, 263, 722, 157), (37, 23, 91, 7), (300, 41, 17, 40)] {
                let from = Layout {
                    width: w,
                    height: h,
                    stride: w as usize * channels + 5,
                };
                let to = layout(ow, oh, out_channels);
                let src = noise(from.stride * h as usize);
                let mut results = Vec::new();
                for kernel in [SimdKernel::detect(), SimdKernel::Scalar] {
                    let mut dst = vec![0_u8; to.stride * oh as usize];
                    Resampler::default()
                        .run(
                            kernel,
                            pack,
                            &src,
                            from,
                            (f64::from(w), f64::from(h)),
                            &mut dst,
                            to,
                        )
                        .unwrap_or_else(|e| panic!("{e}"));
                    results.push(dst);
                }
                assert!(results[0] == results[1], "{w}x{h} -> {ow}x{oh}");
            }
        }
    }
}
