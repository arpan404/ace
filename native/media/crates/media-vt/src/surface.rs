// SPDX-License-Identifier: Apache-2.0
//! IOSurface-backed `CVPixelBuffer`s: the platform picture, its pools, and the
//! counted CPU upload and readback.
#![allow(unsafe_code)]
use crate::cf::{self, dictionary, number};
use media_codec::{
    CodecError, CpuPicture, Picture, PixelFormat, Plane, PlatformPicture, PlatformSurface, Size,
};
use objc2_core_foundation::{CFRetained, CFType};
use objc2_core_video::*;
use std::any::Any;
use std::ptr::NonNull;

/// Pixel layouts the backend keeps on the GPU. `Nv12` is video range (`420v`),
/// what ScreenCaptureKit delivers and the encoders take without conversion.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum VtFormat {
    Nv12,
    Bgra,
}
impl VtFormat {
    pub(crate) fn os_type(self) -> u32 {
        match self {
            Self::Nv12 => kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
            Self::Bgra => kCVPixelFormatType_32BGRA,
        }
    }
    pub(crate) fn from_os_type(value: u32) -> Option<Self> {
        if value == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
            || value == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
        {
            Some(Self::Nv12)
        } else if value == kCVPixelFormatType_32BGRA {
            Some(Self::Bgra)
        } else {
            None
        }
    }
    pub fn pixel_format(self) -> PixelFormat {
        match self {
            Self::Nv12 => PixelFormat::Nv12,
            Self::Bgra => PixelFormat::Bgra8,
        }
    }
}

/// An owned `CVPixelBuffer`, the `PlatformPicture` surface of this backend.
pub struct VtSurface {
    buffer: CFRetained<CVPixelBuffer>,
}
// SAFETY: CVPixelBuffer is a reference-counted CF object whose retain/release
// are thread-safe. The surface only hands out shared references; pixel access
// goes through lock/unlock, which CoreVideo serialises.
unsafe impl Send for VtSurface {}
impl PlatformSurface for VtSurface {
    fn as_any(&self) -> &dyn Any {
        self
    }
}
impl VtSurface {
    pub fn new(buffer: CFRetained<CVPixelBuffer>) -> Self {
        Self { buffer }
    }
    /// Another owner of the same buffer (a retain, not a copy).
    pub fn share(&self) -> Self {
        Self {
            buffer: self.buffer.clone(),
        }
    }
    pub fn buffer(&self) -> &CVPixelBuffer {
        &self.buffer
    }
    pub fn size(&self) -> Size {
        Size {
            width: CVPixelBufferGetWidth(&self.buffer) as u32,
            height: CVPixelBufferGetHeight(&self.buffer) as u32,
        }
    }
    pub fn format(&self) -> Option<VtFormat> {
        VtFormat::from_os_type(CVPixelBufferGetPixelFormatType(&self.buffer))
    }
    /// True when the pixels live in an IOSurface the GPU and VideoToolbox share.
    pub fn is_io_surface(&self) -> bool {
        CVPixelBufferGetIOSurface(Some(&self.buffer)).is_some()
    }
    /// Wraps the buffer as a picture; fails for pixel layouts this backend doesn't map.
    pub fn into_picture(self, pts_us: u64) -> Result<Picture, CodecError> {
        let format = self
            .format()
            .ok_or_else(|| CodecError::Unsupported("pixel buffer layout".into()))?;
        Ok(Picture::Platform(PlatformPicture {
            size: self.size(),
            format: format.pixel_format(),
            pts_us,
            surface: Box::new(self),
        }))
    }
    /// The surface of a picture this backend made (or any `VtSurface`).
    pub fn of(picture: &Picture) -> Option<&VtSurface> {
        match picture {
            Picture::Platform(platform) => platform.surface.as_any().downcast_ref(),
            Picture::Cpu(_) => None,
        }
    }
}

/// IOSurface-backed attributes for a buffer of `size` and `format`.
pub(crate) fn buffer_attributes(
    size: Option<Size>,
    format: VtFormat,
) -> CFRetained<objc2_core_foundation::CFDictionary> {
    let io_surface = dictionary(&[]);
    let format_number = number(i64::from(format.os_type()));
    let mut entries: Vec<(&objc2_core_foundation::CFString, &CFType)> = Vec::with_capacity(5);
    // SAFETY: Reading immutable framework key constants.
    unsafe {
        entries.push((kCVPixelBufferPixelFormatTypeKey, format_number.as_ref()));
        entries.push((kCVPixelBufferIOSurfacePropertiesKey, io_surface.as_ref()));
        entries.push((
            kCVPixelBufferMetalCompatibilityKey,
            cf::boolean(true).as_ref(),
        ));
    }
    let (width, height) = match size {
        Some(size) => (
            number(i64::from(size.width)),
            number(i64::from(size.height)),
        ),
        None => (number(0), number(0)),
    };
    if size.is_some() {
        // SAFETY: As above.
        unsafe {
            entries.push((kCVPixelBufferWidthKey, width.as_ref()));
            entries.push((kCVPixelBufferHeightKey, height.as_ref()));
        }
    }
    dictionary(&entries)
}

/// A `CVPixelBufferPool` of IOSurface buffers at one size and layout. Released
/// buffers return to the pool, so steady-state frames reuse memory.
pub struct PixelPool {
    pool: CFRetained<CVPixelBufferPool>,
    size: Size,
    format: VtFormat,
}
// SAFETY: CVPixelBufferPool is documented thread-safe for buffer creation and
// is only reached through &self.
unsafe impl Send for PixelPool {}
impl PixelPool {
    pub fn new(size: Size, format: VtFormat, minimum: usize) -> Result<Self, CodecError> {
        size.validate()?;
        let attributes = buffer_attributes(Some(size), format);
        let minimum = number(minimum as i64);
        // SAFETY: Reading an immutable framework key constant.
        let pool_attributes = dictionary(&[(
            unsafe { kCVPixelBufferPoolMinimumBufferCountKey },
            minimum.as_ref(),
        )]);
        let mut pool: *mut CVPixelBufferPool = std::ptr::null_mut();
        // SAFETY: Both dictionaries hold the documented key types; the out
        // pointer receives a +1 pool.
        let status = unsafe {
            CVPixelBufferPool::create(
                None,
                Some(&pool_attributes),
                Some(&attributes),
                NonNull::from(&mut pool),
            )
        };
        cf::check(status, "pixel buffer pool")?;
        let pool = NonNull::new(pool)
            .ok_or_else(|| CodecError::Backend("CoreVideo returned no pool".into()))?;
        Ok(Self {
            // SAFETY: Create rule: we own the returned reference.
            pool: unsafe { CFRetained::from_raw(pool) },
            size,
            format,
        })
    }
    pub fn size(&self) -> Size {
        self.size
    }
    pub fn format(&self) -> VtFormat {
        self.format
    }
    pub fn acquire(&self) -> Result<VtSurface, CodecError> {
        let mut buffer: *mut CVPixelBuffer = std::ptr::null_mut();
        // SAFETY: The out pointer receives a +1 buffer on success.
        let status = unsafe {
            CVPixelBufferPool::create_pixel_buffer(None, &self.pool, NonNull::from(&mut buffer))
        };
        cf::check(status, "pixel buffer")?;
        let buffer = NonNull::new(buffer)
            .ok_or_else(|| CodecError::Backend("CoreVideo returned no buffer".into()))?;
        // SAFETY: Create rule.
        Ok(VtSurface::new(unsafe { CFRetained::from_raw(buffer) }))
    }
    /// One CPU→GPU copy of `picture` into a pooled buffer.
    pub fn upload(&self, picture: &CpuPicture) -> Result<Picture, CodecError> {
        if picture.size() != self.size {
            return Err(CodecError::InvalidInput(
                "upload size differs from pool".into(),
            ));
        }
        let surface = self.acquire()?;
        write_pixels(&surface, picture)?;
        surface.into_picture(picture.pts_us)
    }
}

struct Locked<'a> {
    buffer: &'a CVPixelBuffer,
    flags: CVPixelBufferLockFlags,
}
impl<'a> Locked<'a> {
    fn new(buffer: &'a CVPixelBuffer, read_only: bool) -> Result<Self, CodecError> {
        let flags = if read_only {
            CVPixelBufferLockFlags::ReadOnly
        } else {
            CVPixelBufferLockFlags::empty()
        };
        // SAFETY: Paired with the unlock in Drop using the same flags.
        cf::check(
            unsafe { CVPixelBufferLockBaseAddress(buffer, flags) },
            "lock",
        )?;
        Ok(Self { buffer, flags })
    }
    /// The base address, row stride and row count of plane `index`.
    fn plane(&self, index: usize) -> Result<(*mut u8, usize, usize), CodecError> {
        let (base, stride, rows) = if CVPixelBufferIsPlanar(self.buffer) {
            (
                CVPixelBufferGetBaseAddressOfPlane(self.buffer, index),
                CVPixelBufferGetBytesPerRowOfPlane(self.buffer, index),
                CVPixelBufferGetHeightOfPlane(self.buffer, index),
            )
        } else if index == 0 {
            (
                CVPixelBufferGetBaseAddress(self.buffer),
                CVPixelBufferGetBytesPerRow(self.buffer),
                CVPixelBufferGetHeight(self.buffer),
            )
        } else {
            (std::ptr::null_mut(), 0, 0)
        };
        if base.is_null() {
            return Err(CodecError::Backend("pixel buffer plane missing".into()));
        }
        Ok((base.cast(), stride, rows))
    }
}
impl Drop for Locked<'_> {
    fn drop(&mut self) {
        // SAFETY: Matches the lock taken in `new`.
        unsafe { CVPixelBufferUnlockBaseAddress(self.buffer, self.flags) };
    }
}

fn write_pixels(surface: &VtSurface, picture: &CpuPicture) -> Result<(), CodecError> {
    let format = surface
        .format()
        .ok_or_else(|| CodecError::Unsupported("pixel buffer layout".into()))?;
    let width = picture.size().width as usize;
    let locked = Locked::new(surface.buffer(), false)?;
    match (format, picture.format()) {
        (VtFormat::Nv12, PixelFormat::Nv12) => {
            for (index, source) in picture.planes().iter().enumerate() {
                let (base, stride, rows) = locked.plane(index)?;
                for row in 0..rows {
                    let from = source
                        .data
                        .get(row * source.stride..row * source.stride + width)
                        .ok_or_else(|| CodecError::InvalidInput("short plane".into()))?;
                    // SAFETY: The locked plane has `rows` rows of `stride` bytes,
                    // and stride ≥ width bytes for an 8-bit luma or CbCr row.
                    let to =
                        unsafe { std::slice::from_raw_parts_mut(base.add(row * stride), width) };
                    to.copy_from_slice(from);
                }
            }
        }
        (VtFormat::Bgra, PixelFormat::Bgra8 | PixelFormat::Rgba8 | PixelFormat::Rgb8) => {
            let source = picture
                .planes()
                .first()
                .ok_or_else(|| CodecError::InvalidInput("missing plane".into()))?;
            let (base, stride, rows) = locked.plane(0)?;
            for row in 0..rows {
                // SAFETY: Each BGRA row holds at least width × 4 bytes.
                let to =
                    unsafe { std::slice::from_raw_parts_mut(base.add(row * stride), width * 4) };
                let start = row * source.stride;
                convert_row(picture.format(), source.data.get(start..), to)?;
            }
        }
        _ => {
            return Err(CodecError::Unsupported(
                "upload needs NV12 into NV12 or RGB into BGRA".into(),
            ));
        }
    }
    Ok(())
}

fn convert_row(format: PixelFormat, from: Option<&[u8]>, to: &mut [u8]) -> Result<(), CodecError> {
    let from = from.ok_or_else(|| CodecError::InvalidInput("short plane".into()))?;
    let short = || CodecError::InvalidInput("short plane".into());
    match format {
        PixelFormat::Bgra8 => to.copy_from_slice(from.get(..to.len()).ok_or_else(short)?),
        PixelFormat::Rgba8 => {
            let from = from.get(..to.len()).ok_or_else(short)?;
            for (out, rgba) in to.chunks_exact_mut(4).zip(from.chunks_exact(4)) {
                out.copy_from_slice(&[rgba[2], rgba[1], rgba[0], 255]);
            }
        }
        PixelFormat::Rgb8 => {
            let from = from.get(..to.len() / 4 * 3).ok_or_else(short)?;
            for (out, rgb) in to.chunks_exact_mut(4).zip(from.chunks_exact(3)) {
                out.copy_from_slice(&[rgb[2], rgb[1], rgb[0], 255]);
            }
        }
        PixelFormat::Nv12 => return Err(CodecError::Unsupported("NV12 into BGRA".into())),
    }
    Ok(())
}

/// One GPU→CPU copy of a platform picture into tightly packed planes.
pub fn read_back(picture: &Picture) -> Result<CpuPicture, CodecError> {
    read_back_into(picture, Vec::new())
}

/// As [`read_back`], reusing `storage` for the first plane.
pub fn read_back_into(picture: &Picture, storage: Vec<u8>) -> Result<CpuPicture, CodecError> {
    let surface = VtSurface::of(picture)
        .ok_or_else(|| CodecError::InvalidInput("not a VideoToolbox picture".into()))?;
    let format = surface
        .format()
        .ok_or_else(|| CodecError::Unsupported("pixel buffer layout".into()))?;
    let size = surface.size();
    let width = size.width as usize;
    let locked = Locked::new(surface.buffer(), true)?;
    let row_bytes = match format {
        VtFormat::Nv12 => width,
        VtFormat::Bgra => width * 4,
    };
    let copy_plane = |index: usize, mut data: Vec<u8>| -> Result<Plane, CodecError> {
        let (base, stride, rows) = locked.plane(index)?;
        data.clear();
        data.reserve(row_bytes * rows);
        for row in 0..rows {
            // SAFETY: The locked plane has `rows` rows of `stride` ≥ row_bytes bytes.
            let from = unsafe { std::slice::from_raw_parts(base.add(row * stride), row_bytes) };
            data.extend_from_slice(from);
        }
        Ok(Plane {
            data,
            stride: row_bytes,
        })
    };
    let first = copy_plane(0, storage)?;
    let picture = match format {
        VtFormat::Bgra => CpuPicture::new(size, format.pixel_format(), [first], picture.pts_us()),
        VtFormat::Nv12 => {
            let second = copy_plane(1, Vec::new())?;
            CpuPicture::new(
                size,
                format.pixel_format(),
                [first, second],
                picture.pts_us(),
            )
        }
    };
    drop(locked);
    picture
}

/// One GPU→CPU copy of `surface` into packed RGB8 in `out`, converting while
/// copying: BGRA is reordered, NV12 goes through BT.709 (video or full range,
/// per the buffer's format). Reuses `out`'s capacity; returns the size.
pub(crate) fn read_back_rgb(surface: &VtSurface, out: &mut Vec<u8>) -> Result<Size, CodecError> {
    let format = surface
        .format()
        .ok_or_else(|| CodecError::Unsupported("pixel buffer layout".into()))?;
    let size = surface.size();
    let (w, h) = (size.width as usize, size.height as usize);
    out.clear();
    out.resize(w * h * 3, 0);
    let locked = Locked::new(surface.buffer(), true)?;
    match format {
        VtFormat::Bgra => {
            let (base, stride, _) = locked.plane(0)?;
            for (y, row) in out.chunks_exact_mut(w * 3).enumerate() {
                // SAFETY: Row `y` < height of a locked plane with stride ≥ 4w.
                let from = unsafe { std::slice::from_raw_parts(base.add(y * stride), w * 4) };
                for (rgb, bgra) in row.chunks_exact_mut(3).zip(from.chunks_exact(4)) {
                    rgb.copy_from_slice(&[bgra[2], bgra[1], bgra[0]]);
                }
            }
        }
        VtFormat::Nv12 => {
            let full = CVPixelBufferGetPixelFormatType(surface.buffer())
                == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange;
            let (luma, luma_stride, _) = locked.plane(0)?;
            let (chroma, chroma_stride, _) = locked.plane(1)?;
            for (y, row) in out.chunks_exact_mut(w * 3).enumerate() {
                // SAFETY: Luma row `y` and chroma row `y / 2` are within the
                // locked planes; each holds ≥ w bytes.
                let (ys, cs) = unsafe {
                    (
                        std::slice::from_raw_parts(luma.add(y * luma_stride), w),
                        std::slice::from_raw_parts(chroma.add(y / 2 * chroma_stride), w),
                    )
                };
                for (x, rgb) in row.chunks_exact_mut(3).enumerate() {
                    let c = x & !1;
                    rgb.copy_from_slice(&bt709(ys[x], cs[c], cs[c + 1], full));
                }
            }
        }
    }
    Ok(size)
}

/// BT.709 Y'CbCr → R'G'B' with 8-bit fixed-point coefficients.
fn bt709(y: u8, cb: u8, cr: u8, full: bool) -> [u8; 3] {
    let (cb, cr) = (i32::from(cb) - 128, i32::from(cr) - 128);
    // Video range folds 255/219 (luma) and 255/224 (chroma) into the factors.
    let (y, r_cr, g_cb, g_cr, b_cb) = if full {
        (i32::from(y) * 256, 403, 48, 120, 475)
    } else {
        ((i32::from(y) - 16) * 298, 459, 55, 136, 541)
    };
    let clamp = |v: i32| ((v + 128) >> 8).clamp(0, 255) as u8;
    [
        clamp(y + r_cr * cr),
        clamp(y - g_cb * cb - g_cr * cr),
        clamp(y + b_cb * cb),
    ]
}
