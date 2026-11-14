// SPDX-License-Identifier: Apache-2.0
use crate::CodecError;
use std::any::Any;

/// Allocation bound for untrusted image input, independent of encode policy.
pub const MAX_DIMENSION: u32 = 8192;
pub const MAX_PIXELS: u64 = 32 * 1024 * 1024;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Size {
    pub width: u32,
    pub height: u32,
}
impl Size {
    pub fn validate(self) -> Result<(), CodecError> {
        if self.width == 0
            || self.height == 0
            || self.width > MAX_DIMENSION
            || self.height > MAX_DIMENSION
            || u64::from(self.width) * u64::from(self.height) > MAX_PIXELS
        {
            return Err(CodecError::InvalidInput(
                "image dimensions exceed limits".into(),
            ));
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PixelFormat {
    Rgb8,
    Rgba8,
    Bgra8,
    Nv12,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plane {
    pub data: Vec<u8>,
    pub stride: usize,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CpuPicture {
    size: Size,
    format: PixelFormat,
    planes: Vec<Plane>,
    pub pts_us: u64,
}
impl CpuPicture {
    /// Packed formats use one plane. NV12 uses Y then interleaved UV, with
    /// even dimensions. Each plane may include row padding.
    pub fn new(
        size: Size,
        format: PixelFormat,
        planes: Vec<Plane>,
        pts_us: u64,
    ) -> Result<Self, CodecError> {
        size.validate()?;
        let w = size.width as usize;
        let h = size.height as usize;
        let layouts = match format {
            PixelFormat::Rgb8 => vec![(w * 3, h)],
            PixelFormat::Rgba8 | PixelFormat::Bgra8 => vec![(w * 4, h)],
            PixelFormat::Nv12 if w.is_multiple_of(2) && h.is_multiple_of(2) => {
                vec![(w, h), (w, h / 2)]
            }
            _ => {
                return Err(CodecError::InvalidInput(
                    "NV12 requires even dimensions".into(),
                ));
            }
        };
        if planes.len() != layouts.len()
            || planes.iter().zip(layouts).any(|(p, (row, rows))| {
                p.stride < row
                    || p.stride
                        .checked_mul(rows)
                        .is_none_or(|len| p.data.len() < len)
            })
        {
            return Err(CodecError::InvalidInput(
                "invalid pixel planes or strides".into(),
            ));
        }
        Ok(Self {
            size,
            format,
            planes,
            pts_us,
        })
    }
    pub fn size(&self) -> Size {
        self.size
    }
    pub fn format(&self) -> PixelFormat {
        self.format
    }
    pub fn planes(&self) -> &[Plane] {
        &self.planes
    }
}

/// Backends store their owning CVPixelBuffer, D3D11 texture or VA surface
/// wrapper here. Drop releases the resource; no unowned integer handles.
/// A wrapper must uphold Send, including any required device-thread dispatch.
pub trait PlatformSurface: Any + Send {
    fn as_any(&self) -> &dyn Any;
}
pub struct PlatformPicture {
    pub size: Size,
    pub format: PixelFormat,
    pub pts_us: u64,
    pub surface: Box<dyn PlatformSurface>,
}
pub enum Picture {
    Cpu(CpuPicture),
    Platform(PlatformPicture),
}
impl Picture {
    pub fn size(&self) -> Size {
        match self {
            Self::Cpu(p) => p.size(),
            Self::Platform(p) => p.size,
        }
    }
    pub fn pts_us(&self) -> u64 {
        match self {
            Self::Cpu(p) => p.pts_us,
            Self::Platform(p) => p.pts_us,
        }
    }
}
