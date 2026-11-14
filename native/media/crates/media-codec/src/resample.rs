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
        dispatch(kernel, || {
            vertical(src, from.stride, row_bytes, &self.vertical, &mut self.rows);
            for (y, out) in dst
                .chunks_mut(to.stride)
                .take(to.height as usize)
                .enumerate()
            {
                let row = &self.rows[y * row_bytes..][..row_bytes];
                match pack {
                    Pack::Plane => horizontal_plane(row, &self.horizontal, out),
                    Pack::Rgb => {
                        horizontal_pixels::<3, 3>(row, &self.horizontal, out, [0, 1, 2, 3])
                    }
                    Pack::Rgba => {
                        horizontal_pixels::<4, 4>(row, &self.horizontal, out, [0, 1, 2, 3])
                    }
                    Pack::BgraToRgb => {
                        horizontal_pixels::<4, 3>(row, &self.horizontal, out, [2, 1, 0, 3])
                    }
                }
            }
        });
        Ok(())
    }
}

#[cfg(target_arch = "x86_64")]
#[allow(unsafe_code)]
fn dispatch(kernel: SimdKernel, work: impl FnOnce()) {
    #[target_feature(enable = "avx2")]
    fn avx2(work: impl FnOnce()) {
        work()
    }
    if kernel == SimdKernel::Avx2 && std::arch::is_x86_feature_detected!("avx2") {
        // SAFETY: AVX2 support was confirmed on this CPU immediately above.
        unsafe { avx2(work) }
    } else {
        work()
    }
}
#[cfg(not(target_arch = "x86_64"))]
fn dispatch(_kernel: SimdKernel, work: impl FnOnce()) {
    work()
}

#[inline(always)]
fn clamp(acc: i32) -> u8 {
    (acc >> BITS).clamp(0, 255) as u8
}

#[inline(always)]
fn vertical(src: &[u8], stride: usize, row_bytes: usize, taps: &Taps, rows: &mut [u8]) {
    const LANES: usize = 32;
    for (y, out) in rows.chunks_exact_mut(row_bytes).enumerate() {
        let (start, weights) = taps.get(y);
        let mut x = 0;
        while x + LANES <= row_bytes {
            let mut acc = [ROUND; LANES];
            for (k, w) in weights.iter().enumerate() {
                let w = i32::from(*w);
                let line: &[u8; LANES] = src[(start + k) * stride + x..][..LANES]
                    .try_into()
                    .unwrap_or(&[0; LANES]);
                for (a, s) in acc.iter_mut().zip(line) {
                    *a += i32::from(*s) * w;
                }
            }
            for (o, a) in out[x..x + LANES].iter_mut().zip(acc) {
                *o = clamp(a);
            }
            x += LANES;
        }
        for (i, o) in out[x..].iter_mut().enumerate() {
            let mut acc = ROUND;
            for (k, w) in weights.iter().enumerate() {
                acc += i32::from(src[(start + k) * stride + x + i]) * i32::from(*w);
            }
            *o = clamp(acc);
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
}
