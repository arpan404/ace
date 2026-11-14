// SPDX-License-Identifier: Apache-2.0
//! Full-range JFIF RGB to YCbCr for pictures that arrive as pixels. The JPEG
//! still path never converts; it stays planar from decode to encode.
use super::decode::Ycc;
use crate::resample::Layout;
use crate::{CodecError, CpuPicture, PixelFormat, Size};

/// Fill `out` with the encoder's 4:2:0 planes. NV12 needs the platform's
/// converter, which knows the source range and matrix.
pub(crate) fn pixels_to_ycc420(p: &CpuPicture, out: &mut Ycc) -> Result<(), CodecError> {
    let (r, g, b, bpp) = match p.format() {
        PixelFormat::Rgb8 => (0, 1, 2, 3),
        PixelFormat::Rgba8 => (0, 1, 2, 4),
        PixelFormat::Bgra8 => (2, 1, 0, 4),
        PixelFormat::Nv12 => {
            return Err(CodecError::Unsupported(
                "CPU stills need RGB, RGBA or BGRA".into(),
            ));
        }
    };
    let plane = &p.planes()[0];
    packed_to_ycc420(&plane.data, plane.stride, p.size(), [r, g, b, bpp], out);
    Ok(())
}

#[inline(always)]
fn luma(r: i32, g: i32, b: i32) -> u8 {
    ((19_595 * r + 38_470 * g + 7_471 * b + 32_768) >> 16) as u8
}
/// Chroma from RGB sums of `n` pixels (n is 1 or 4).
#[inline(always)]
fn chroma(r: i32, g: i32, b: i32, n: i32) -> (u8, u8) {
    let round = (n << 15) - 1;
    let cb = (-11_059 * r - 21_709 * g + 32_768 * b + n * (128 << 16) + round) / (n << 16);
    let cr = (32_768 * r - 27_439 * g - 5_329 * b + n * (128 << 16) + round) / (n << 16);
    (cb.clamp(0, 255) as u8, cr.clamp(0, 255) as u8)
}

fn layout(out: &mut Ycc, i: usize, width: u32, height: u32) {
    out.planes[i].resize(width as usize * height as usize, 0);
    out.layouts[i] = Layout {
        width,
        height,
        stride: width as usize,
    };
    out.extents[i] = (f64::from(width), f64::from(height));
}

/// Full-resolution luma; each chroma sample averages its 2×2 block (edges
/// repeat), the JFIF siting for 4:2:0.
fn packed_to_ycc420(
    data: &[u8],
    stride: usize,
    size: Size,
    [r, g, b, bpp]: [usize; 4],
    out: &mut Ycc,
) {
    let (w, h) = (size.width as usize, size.height as usize);
    let (cw, ch) = (w.div_ceil(2), h.div_ceil(2));
    out.count = 3;
    layout(out, 0, size.width, size.height);
    layout(out, 1, cw as u32, ch as u32);
    layout(out, 2, cw as u32, ch as u32);
    let px = |x: usize, y: usize| {
        let p = &data[y.min(h - 1) * stride + x.min(w - 1) * bpp..];
        (i32::from(p[r]), i32::from(p[g]), i32::from(p[b]))
    };
    for y in 0..h {
        for x in 0..w {
            let (rv, gv, bv) = px(x, y);
            out.planes[0][y * w + x] = luma(rv, gv, bv);
        }
    }
    let [_, cb, cr] = &mut out.planes;
    for y in 0..ch {
        for x in 0..cw {
            let mut sum = (0, 0, 0);
            for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                let (rv, gv, bv) = px(2 * x + dx, 2 * y + dy);
                sum = (sum.0 + rv, sum.1 + gv, sum.2 + bv);
            }
            (cb[y * cw + x], cr[y * cw + x]) = chroma(sum.0, sum.1, sum.2, 4);
        }
    }
}

/// Full-resolution planes, for streams that only a general decoder reads.
pub(crate) fn packed_to_ycc(
    data: &[u8],
    stride: usize,
    size: Size,
    [r, g, b, bpp]: [usize; 4],
    out: &mut Ycc,
) {
    let (w, h) = (size.width as usize, size.height as usize);
    out.count = 3;
    for i in 0..3 {
        layout(out, i, size.width, size.height);
    }
    let [yp, cb, cr] = &mut out.planes;
    for y in 0..h {
        let row = &data[y * stride..][..w * bpp];
        let range = y * w..(y + 1) * w;
        for (((px, yo), bo), ro) in row
            .chunks_exact(bpp)
            .zip(&mut yp[range.clone()])
            .zip(&mut cb[range.clone()])
            .zip(&mut cr[range])
        {
            let (rv, gv, bv) = (i32::from(px[r]), i32::from(px[g]), i32::from(px[b]));
            *yo = luma(rv, gv, bv);
            (*bo, *ro) = chroma(rv, gv, bv, 1);
        }
    }
}
