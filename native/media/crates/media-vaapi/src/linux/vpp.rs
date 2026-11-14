// SPDX-License-Identifier: Apache-2.0
//! VA video processing (`VAEntrypointVideoProc`): converts BGRx/RGBx to NV12 and scales in
//! one pass on the GPU, implementing media-codec's [`Scaler`].
use super::device::{Config, Context, Device};
use super::ffi::*;
use super::surface::{Surface, SurfacePool};
use crate::formats::{self, NV12, SurfaceFormat};
use crate::select::{entrypoint, profile};
use media_codec::{CodecError, Picture, PixelFormat, Scaler, Size};
use std::sync::Arc;

/// Pools kept per size; a source rarely uses more than a couple.
const MAX_POOLS: usize = 4;

pub struct VaScaler {
    device: Arc<Device>,
    context: Context,
    _config: Config,
    outputs: Vec<SurfacePool>,
    uploads: Vec<(SurfaceFormat, SurfacePool)>,
}

impl VaScaler {
    pub fn new(device: &Arc<Device>) -> Result<Self, CodecError> {
        let listed = device.profiles()?;
        if !crate::select::lists(&listed, profile::NONE, entrypoint::VIDEO_PROC) {
            return Err(CodecError::Unsupported(
                "driver has no VA video processing".into(),
            ));
        }
        let config = device.create_config(profile::NONE, entrypoint::VIDEO_PROC, &[])?;
        let context = device.create_context(
            &config,
            Size {
                width: 1920,
                height: 1080,
            },
            &mut [],
        )?;
        Ok(Self {
            device: Arc::clone(device),
            context,
            _config: config,
            outputs: Vec::new(),
            uploads: Vec::new(),
        })
    }

    /// Converts and scales `input` into `output` (any sizes; NV12 or RGB on either side).
    pub fn process(&self, input: &Surface, output: &Surface) -> Result<(), CodecError> {
        let rgb_in = input.format().pixel != PixelFormat::Nv12;
        let mut params: VAProcPipelineParameterBuffer = zeroed();
        params.surface = input.id();
        params.surface_color_standard = if rgb_in {
            VA_PROC_COLOR_STANDARD_SRGB
        } else {
            VA_PROC_COLOR_STANDARD_BT709
        };
        params.output_color_standard = VA_PROC_COLOR_STANDARD_BT709;
        params.filter_flags = VA_FILTER_SCALING_HQ;
        params.input_color_properties.color_range = if rgb_in {
            VA_SOURCE_RANGE_FULL
        } else {
            VA_SOURCE_RANGE_REDUCED
        };
        // Limited range, as the encoders' VUI says.
        params.output_color_properties.color_range = VA_SOURCE_RANGE_REDUCED;
        let buffer = self
            .device
            .param(&self.context, buffer::PROC_PIPELINE_PARAMETER, &params)?;
        self.device.submit(&self.context, output.id(), &[&buffer])
    }

    /// An NV12 surface from this scaler's pool for `size`.
    pub fn output(&mut self, size: Size) -> Result<Surface, CodecError> {
        if let Some(pool) = self.outputs.iter().find(|p| p.size() == size) {
            return pool.take();
        }
        if self.outputs.len() == MAX_POOLS {
            self.outputs.remove(0);
        }
        let pool = SurfacePool::new(&self.device, NV12, size)?;
        let surface = pool.take();
        self.outputs.push(pool);
        surface
    }

    /// The surface holding `picture`: itself when it's one of this device's, else an upload.
    pub fn surface_for<'p>(&mut self, picture: &'p Picture) -> Result<Holder<'p>, CodecError> {
        match picture {
            Picture::Platform(p) => {
                let surface = Surface::of(p).ok_or_else(|| {
                    CodecError::InvalidInput("platform picture isn't a VA surface".into())
                })?;
                if !Arc::ptr_eq(surface.device(), &self.device) {
                    return Err(CodecError::InvalidInput(
                        "VA surface from another display".into(),
                    ));
                }
                Ok(Holder::Borrowed(surface))
            }
            Picture::Cpu(cpu) => {
                let format = formats::for_pixel(cpu.format()).ok_or_else(|| {
                    CodecError::Unsupported("packed RGB without padding has no VA surface".into())
                })?;
                let size = cpu.size();
                let pool = match self
                    .uploads
                    .iter()
                    .position(|(f, p)| *f == format && p.size() == size)
                {
                    Some(i) => &self.uploads[i].1,
                    None => {
                        if self.uploads.len() == MAX_POOLS {
                            self.uploads.remove(0);
                        }
                        self.uploads
                            .push((format, SurfacePool::new(&self.device, format, size)?));
                        &self.uploads[self.uploads.len() - 1].1
                    }
                };
                let surface = pool.take()?;
                surface.upload(cpu)?;
                Ok(Holder::Owned(surface))
            }
        }
    }
}

/// A surface for a picture: borrowed from it, or an upload owned for the call.
pub enum Holder<'p> {
    Borrowed(&'p Surface),
    Owned(Surface),
}

impl std::ops::Deref for Holder<'_> {
    type Target = Surface;
    fn deref(&self) -> &Surface {
        match self {
            Self::Borrowed(s) => s,
            Self::Owned(s) => s,
        }
    }
}

impl Scaler for VaScaler {
    /// Output is an NV12 VA surface of exactly `width`×`height` (even sizes).
    fn scale(&mut self, picture: &Picture, width: u32, height: u32) -> Result<Picture, CodecError> {
        let size = Size { width, height };
        size.validate()?;
        if !width.is_multiple_of(2) || !height.is_multiple_of(2) {
            return Err(CodecError::InvalidInput(
                "NV12 output needs even sizes".into(),
            ));
        }
        let input = self.surface_for(picture)?;
        let output = self.output(size)?;
        self.process(&input, &output)?;
        // An uploaded input goes back to its pool once VPP has read it, not before.
        if matches!(input, Holder::Owned(_)) {
            self.device.sync(output.id())?;
        }
        drop(input);
        Ok(output.into_picture(picture.pts_us()))
    }
}
