// SPDX-License-Identifier: Apache-2.0
use crate::*;
use fast_image_resize::{
    FilterType, PixelType, ResizeAlg, ResizeOptions, Resizer,
    images::{Image, ImageRef},
};
use std::borrow::Cow;

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

/// Packs rows and removes alpha. GPU surfaces and NV12 need the platform's
/// colour converter/readback, rather than a silent CPU conversion with wrong range.
pub(crate) fn rgb(p: &CpuPicture) -> Result<Cow<'_, [u8]>, CodecError> {
    if p.format() == PixelFormat::Nv12 {
        return Err(CodecError::Unsupported(
            "CPU stills need RGB, RGBA or BGRA".into(),
        ));
    }
    let channels = if p.format() == PixelFormat::Rgb8 {
        3
    } else {
        4
    };
    let plane = &p.planes()[0];
    if p.format() == PixelFormat::Rgb8 && plane.stride == p.size().width as usize * 3 {
        return Ok(Cow::Borrowed(
            &plane.data[..plane.stride * p.size().height as usize],
        ));
    }
    let mut out = Vec::with_capacity(p.size().width as usize * p.size().height as usize * 3);
    for row in plane
        .data
        .chunks(plane.stride)
        .take(p.size().height as usize)
    {
        for px in row[..p.size().width as usize * channels].chunks_exact(channels) {
            if p.format() == PixelFormat::Bgra8 {
                out.extend_from_slice(&[px[2], px[1], px[0]]);
            } else {
                out.extend_from_slice(&px[..3]);
            }
        }
    }
    Ok(Cow::Owned(out))
}
#[derive(Default)]
pub struct CpuScaler {
    resizer: Resizer,
}
impl Scaler for CpuScaler {
    fn scale(&mut self, picture: &Picture, width: u32, height: u32) -> Result<Picture, CodecError> {
        self.scale_reusing(picture, width, height, Vec::new())
    }
}
impl CpuScaler {
    /// Runtime-selected SIMD extension; no unsafe override of CPU detection.
    pub fn cpu_extensions(&self) -> fast_image_resize::CpuExtensions {
        self.resizer.cpu_extensions()
    }
    pub fn scale_reusing(
        &mut self,
        picture: &Picture,
        width: u32,
        height: u32,
        mut buffer: Vec<u8>,
    ) -> Result<Picture, CodecError> {
        let size = Size { width, height };
        size.validate()?;
        let Picture::Cpu(p) = picture else {
            return Err(CodecError::Unsupported(
                "platform surface needs platform scaler/readback".into(),
            ));
        };
        let (packed, pixel_type, format, channels) = if p.format() == PixelFormat::Rgba8
            && p.planes()[0].stride == p.size().width as usize * 4
        {
            (
                Cow::Borrowed(p.planes()[0].data.as_slice()),
                PixelType::U8x4,
                PixelFormat::Rgba8,
                4,
            )
        } else {
            (rgb(p)?, PixelType::U8x3, PixelFormat::Rgb8, 3)
        };
        let src = ImageRef::new(p.size().width, p.size().height, &packed, pixel_type)
            .map_err(|e| CodecError::InvalidInput(e.to_string()))?;
        buffer.resize(width as usize * height as usize * channels, 0);
        let mut dst = Image::from_vec_u8(width, height, buffer, pixel_type)
            .map_err(|e| CodecError::InvalidInput(e.to_string()))?;
        self.resizer
            .resize(
                &src,
                &mut dst,
                &ResizeOptions::new()
                    .resize_alg(ResizeAlg::Convolution(FilterType::Bilinear))
                    .use_alpha(false),
            )
            .map_err(|e| CodecError::Backend(e.to_string()))?;
        Ok(Picture::Cpu(CpuPicture::new(
            size,
            format,
            [Plane {
                data: dst.into_vec(),
                stride: width as usize * channels,
            }],
            p.pts_us,
        )?))
    }
}
