// SPDX-License-Identifier: Apache-2.0
use crate::resample::{Layout, Pack, Resampler, SimdKernel};
use crate::*;

/// Fit without enlargement or cropping. Round to the nearest even pixel (ties
/// up, minimum two), as video-policy does. Odd bounds round down to remain inside.
/// This is geometry only; media-core owns viewport and adaptive scale decisions.
pub fn fit_size(source: Size, bounds: Size) -> Result<Size, CodecError> {
    fit_size_with_max_pixels(source, bounds, MAX_PIXELS)
}

/// Fit a still.take request's side and pixel limits. The pixel limit must
/// accommodate the smallest even picture (2 by 2).
pub fn fit_size_with_max_pixels(
    source: Size,
    bounds: Size,
    max_pixels: u64,
) -> Result<Size, CodecError> {
    source.validate()?;
    bounds.validate()?;
    if max_pixels < 4 {
        return Err(CodecError::InvalidInput(
            "pixel budget smaller than four".into(),
        ));
    }
    if bounds.width < 2 || bounds.height < 2 {
        return Err(CodecError::InvalidInput(
            "bounds smaller than two pixels".into(),
        ));
    }
    let bw = bounds.width & !1;
    let bh = bounds.height & !1;
    let ratio = (f64::from(bw) / f64::from(source.width))
        .min(f64::from(bh) / f64::from(source.height))
        .min((max_pixels as f64 / (f64::from(source.width) * f64::from(source.height))).sqrt())
        .min(1.0);
    let even = |n: u32, bound: u32| {
        ((f64::from(n) * ratio / 2.0).round() as u32 * 2)
            .max(2)
            .min(bound)
    };
    let mut size = Size {
        width: even(source.width, bw),
        height: even(source.height, bh),
    };
    // Rounding up may cross the pixel budget. Reduce the side furthest above
    // the source aspect ratio first; never exceed the caller's budget.
    while u64::from(size.width) * u64::from(size.height) > max_pixels {
        if size.width > 2
            && (size.height == 2
                || u64::from(size.width) * u64::from(source.height)
                    >= u64::from(size.height) * u64::from(source.width))
        {
            size.width -= 2;
        } else {
            size.height -= 2;
        }
    }
    Ok(size)
}

#[derive(Default)]
pub struct CpuScaler {
    resampler: Resampler,
}
impl Scaler for CpuScaler {
    /// RGB and RGBA keep their format; BGRA becomes RGB. NV12 and platform
    /// surfaces need the platform scaler.
    fn scale(&mut self, picture: &Picture, width: u32, height: u32) -> Result<Picture, CodecError> {
        let size = Size { width, height };
        size.validate()?;
        let Picture::Cpu(p) = picture else {
            return Err(CodecError::Unsupported(
                "platform surface needs platform scaler/readback".into(),
            ));
        };
        let (pack, format, channels) = match p.format() {
            PixelFormat::Rgb8 => (Pack::Rgb, PixelFormat::Rgb8, 3),
            PixelFormat::Rgba8 => (Pack::Rgba, PixelFormat::Rgba8, 4),
            PixelFormat::Bgra8 => (Pack::BgraToRgb, PixelFormat::Rgb8, 3),
            PixelFormat::Nv12 => {
                return Err(CodecError::Unsupported(
                    "NV12 needs the platform scaler".into(),
                ));
            }
        };
        let plane = &p.planes()[0];
        let stride = width as usize * channels;
        let mut data = vec![0; stride * height as usize];
        self.resampler.run(
            SimdKernel::detect(),
            pack,
            &plane.data,
            Layout {
                width: p.size().width,
                height: p.size().height,
                stride: plane.stride,
            },
            (f64::from(p.size().width), f64::from(p.size().height)),
            &mut data,
            Layout {
                width,
                height,
                stride,
            },
        )?;
        Ok(Picture::Cpu(CpuPicture::new(
            size,
            format,
            [Plane { data, stride }],
            p.pts_us,
        )?))
    }
}
