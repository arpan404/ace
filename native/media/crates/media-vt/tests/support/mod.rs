// SPDX-License-Identifier: Apache-2.0
#![allow(dead_code)]
use media_codec::*;
use media_vt::{PixelPool, VtFormat, read_back};

pub type TestResult = Result<(), Box<dyn std::error::Error>>;

/// A scrolling pattern: a diagonal ramp with a moving block grid, so frames
/// differ the way a scrolling page does.
pub fn pattern(size: Size, frame: u32) -> Result<CpuPicture, CodecError> {
    let (w, h) = (size.width as usize, size.height as usize);
    let shift = frame as usize * 4;
    let mut luma = vec![0u8; w * h];
    for y in 0..h {
        for x in 0..w {
            let ramp = (x + y) * 160 / (w + h);
            let block = if ((x + shift) / 32 + (y + shift / 2) / 32).is_multiple_of(2) {
                50
            } else {
                0
            };
            luma[y * w + x] = (16 + ramp + block) as u8;
        }
    }
    let mut chroma = vec![0u8; w * h / 2];
    for y in 0..h / 2 {
        for x in 0..w / 2 {
            chroma[y * w + 2 * x] = (96 + (x * 64 / (w / 2))) as u8;
            chroma[y * w + 2 * x + 1] = (160 - (y * 64 / (h / 2))) as u8;
        }
    }
    CpuPicture::new(
        size,
        PixelFormat::Nv12,
        [
            Plane {
                data: luma,
                stride: w,
            },
            Plane {
                data: chroma,
                stride: w,
            },
        ],
        u64::from(frame) * 16_667,
    )
}

/// `count` distinct IOSurface frames, filled once (the producer's job, as
/// ScreenCaptureKit does), then reused.
pub struct Frames {
    pub pool: PixelPool,
    pub sources: Vec<CpuPicture>,
    pub surfaces: Vec<Picture>,
}
impl Frames {
    pub fn new(size: Size, count: u32) -> Result<Self, CodecError> {
        let pool = PixelPool::new(size, VtFormat::Nv12, count as usize)?;
        let sources = (0..count)
            .map(|i| pattern(size, i))
            .collect::<Result<Vec<_>, _>>()?;
        let surfaces = sources
            .iter()
            .map(|s| pool.upload(s))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            pool,
            sources,
            surfaces,
        })
    }
    /// A picture sharing surface `index % count` (a retain, not a copy).
    pub fn picture(&self, index: u32, pts_us: u64) -> Result<Picture, CodecError> {
        let at = index as usize % self.surfaces.len();
        let surface =
            media_vt::VtSurface::of(&self.surfaces[at]).ok_or(CodecError::NotConfigured)?;
        surface.share().into_picture(pts_us)
    }
}

/// Luma PSNR in dB between a CPU NV12 source and a decoded picture of the same size.
pub fn luma_psnr(source: &CpuPicture, decoded: &Picture) -> Result<f64, CodecError> {
    let decoded = read_back(decoded)?;
    if decoded.size() != source.size() || decoded.format() != PixelFormat::Nv12 {
        return Err(CodecError::InvalidInput(
            "decoded picture differs in size or layout".into(),
        ));
    }
    let (w, h) = (source.size().width as usize, source.size().height as usize);
    let (a, b) = (&source.planes()[0], &decoded.planes()[0]);
    let mut error = 0f64;
    for y in 0..h {
        for x in 0..w {
            let d = f64::from(a.data[y * a.stride + x]) - f64::from(b.data[y * b.stride + x]);
            error += d * d;
        }
    }
    let mse = error / (w * h) as f64;
    Ok(if mse == 0.0 {
        99.0
    } else {
        10.0 * (255.0 * 255.0 / mse).log10()
    })
}

/// Encodes `frames` pictures, forcing keys at `keys`, and returns every unit.
pub fn encode_all(
    encoder: &mut dyn Encoder,
    frames: &Frames,
    range: std::ops::Range<u32>,
    keys: &[u32],
) -> Result<Vec<EncodedUnit>, CodecError> {
    let mut units = Vec::new();
    for index in range {
        loop {
            match encoder.encode(
                frames.picture(index, u64::from(index) * 16_667)?,
                keys.contains(&index),
            ) {
                Err(CodecError::Backpressure) => {
                    while let Some(unit) = encoder.poll_result()? {
                        units.push(unit);
                    }
                    std::thread::yield_now();
                }
                other => break other?,
            }
        }
        while let Some(unit) = encoder.poll_result()? {
            units.push(unit);
        }
    }
    encoder.flush()?;
    while let Some(unit) = encoder.poll_result()? {
        units.push(unit);
    }
    Ok(units)
}
