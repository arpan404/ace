// SPDX-License-Identifier: Apache-2.0
//! CPU repacking into WIC's 24-bit BGR, for the JPEG encoder's input. Pure.
//! NV12 is read as BT.709 studio range, which is what the video processor writes.
use media_codec::{CodecError, CpuPicture, PixelFormat};

/// Writes `picture` as tightly packed BGR rows into `out`. Returns the row stride.
pub fn to_bgr24(picture: &CpuPicture, out: &mut Vec<u8>) -> Result<usize, CodecError> {
    let size = picture.size();
    let (w, h) = (size.width as usize, size.height as usize);
    let stride = w * 3;
    out.clear();
    out.resize(stride * h, 0);
    let planes = picture.planes();
    match picture.format() {
        PixelFormat::Rgb8 | PixelFormat::Rgba8 | PixelFormat::Bgra8 => {
            let (step, swap) = match picture.format() {
                PixelFormat::Rgb8 => (3, true),
                PixelFormat::Rgba8 => (4, true),
                _ => (4, false),
            };
            let plane = &planes[0];
            for y in 0..h {
                let row = &plane.data[y * plane.stride..];
                for x in 0..w {
                    let px = &row[x * step..x * step + 3];
                    let at = y * stride + x * 3;
                    if swap {
                        out[at..at + 3].copy_from_slice(&[px[2], px[1], px[0]]);
                    } else {
                        out[at..at + 3].copy_from_slice(px);
                    }
                }
            }
        }
        PixelFormat::Nv12 => {
            let (luma, chroma) = (&planes[0], &planes[1]);
            for y in 0..h {
                for x in 0..w {
                    let l = i32::from(luma.data[y * luma.stride + x]) - 16;
                    let c = (y / 2) * chroma.stride + (x & !1);
                    let u = i32::from(chroma.data[c]) - 128;
                    let v = i32::from(chroma.data[c + 1]) - 128;
                    // BT.709 limited → full range, 16-bit fixed point.
                    let r = (76_309 * l + 117_489 * v + 32_768) >> 16;
                    let g = (76_309 * l - 13_975 * u - 34_925 * v + 32_768) >> 16;
                    let b = (76_309 * l + 138_438 * u + 32_768) >> 16;
                    let at = y * stride + x * 3;
                    out[at] = b.clamp(0, 255) as u8;
                    out[at + 1] = g.clamp(0, 255) as u8;
                    out[at + 2] = r.clamp(0, 255) as u8;
                }
            }
        }
    }
    Ok(stride)
}

#[cfg(test)]
mod tests {
    use super::*;
    use media_codec::{Plane, Size};

    fn nv12(y: u8, u: u8, v: u8) -> CpuPicture {
        let size = Size {
            width: 2,
            height: 2,
        };
        let planes = [
            Plane {
                data: vec![y; 4],
                stride: 2,
            },
            Plane {
                data: vec![u, v],
                stride: 2,
            },
        ];
        match CpuPicture::new(size, PixelFormat::Nv12, planes, 0) {
            Ok(p) => p,
            Err(e) => panic!("{e}"),
        }
    }

    #[test]
    fn studio_range_nv12_maps_to_full_range_bgr() {
        let mut out = Vec::new();
        for (yuv, bgr) in [
            ((16, 128, 128), [0, 0, 0]),
            ((235, 128, 128), [255, 255, 255]),
            // BT.709 red (R'G'B' 255,0,0) is Y 63, Cb 102, Cr 240.
            ((63, 102, 240), [0, 0, 255]),
        ] {
            let stride = to_bgr24(&nv12(yuv.0, yuv.1, yuv.2), &mut out);
            assert_eq!(stride, Ok(6));
            for px in out.chunks(3) {
                for (got, want) in px.iter().zip(bgr) {
                    assert!(got.abs_diff(want) <= 2, "{yuv:?} gave {px:?}, want {bgr:?}");
                }
            }
        }
    }

    #[test]
    fn packed_rgb_formats_come_out_as_bgr_without_padding() {
        let size = Size {
            width: 1,
            height: 2,
        };
        let rgba = CpuPicture::new(
            size,
            PixelFormat::Rgba8,
            [Plane {
                data: vec![1, 2, 3, 9, 0, 0, 0, 0, 4, 5, 6, 9, 0, 0, 0, 0],
                stride: 8,
            }],
            0,
        );
        let Ok(rgba) = rgba else {
            panic!("bad picture");
        };
        let mut out = Vec::new();
        assert_eq!(to_bgr24(&rgba, &mut out), Ok(3));
        assert_eq!(out, vec![3, 2, 1, 6, 5, 4]);
    }
}
