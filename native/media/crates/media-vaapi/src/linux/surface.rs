// SPDX-License-Identifier: Apache-2.0
//! VA surfaces as media-codec platform pictures: owned or pooled, uploaded from and read back
//! to CPU pictures, and imported from DMA-BUFs without a copy.
use super::device::Device;
use super::ffi::*;
use crate::formats::{self, SurfaceFormat};
use media_codec::{
    CodecError, CpuPicture, Picture, PixelFormat, Plane, PlatformPicture, PlatformSurface, Size,
};
use std::any::Any;
use std::os::fd::{AsRawFd, BorrowedFd};
use std::sync::{Arc, Mutex};

/// A VA surface. Dropping it destroys it, or returns it to its pool.
pub struct Surface {
    device: Arc<Device>,
    id: VASurfaceID,
    size: Size,
    format: SurfaceFormat,
    pool: Option<Arc<PoolInner>>,
}

impl Surface {
    pub fn id(&self) -> VASurfaceID {
        self.id
    }
    pub fn size(&self) -> Size {
        self.size
    }
    pub fn format(&self) -> SurfaceFormat {
        self.format
    }
    pub fn device(&self) -> &Arc<Device> {
        &self.device
    }

    /// Owned surfaces of one format and size.
    pub fn create(
        device: &Arc<Device>,
        format: SurfaceFormat,
        size: Size,
        count: usize,
    ) -> Result<Vec<Self>, CodecError> {
        size.validate()?;
        let ids = device.create_surfaces(format, size, count, &mut Vec::new())?;
        Ok(ids
            .into_iter()
            .map(|id| Self {
                device: Arc::clone(device),
                id,
                size,
                format,
                pool: None,
            })
            .collect())
    }

    /// This surface as a media-codec picture.
    pub fn into_picture(self, pts_us: u64) -> Picture {
        Picture::Platform(PlatformPicture {
            size: self.size,
            format: self.format.pixel,
            pts_us,
            surface: Box::new(self),
        })
    }

    /// The VA surface inside a platform picture made by this backend.
    pub fn of(picture: &PlatformPicture) -> Option<&Surface> {
        picture.surface.as_any().downcast_ref::<Surface>()
    }

    /// Copies a CPU picture of the same size and format into the surface.
    pub fn upload(&self, picture: &CpuPicture) -> Result<(), CodecError> {
        if picture.size() != self.size || formats::for_pixel(picture.format()) != Some(self.format)
        {
            return Err(CodecError::InvalidInput(
                "upload needs a picture of the surface's size and format".into(),
            ));
        }
        let image = Image::new(&self.device, self.format, self.size)?;
        image.write(picture)?;
        self.device.put_image(self.id, &image.image, self.size)
    }

    /// One readback: the surface's pixels as a CPU picture (NV12 or packed RGB).
    pub fn read(&self, pts_us: u64) -> Result<CpuPicture, CodecError> {
        self.device.sync(self.id)?;
        let image = Image::new(&self.device, self.format, self.size)?;
        self.device.get_image(self.id, &image.image, self.size)?;
        image.read(self.format.pixel, pts_us)
    }
}

impl Drop for Surface {
    fn drop(&mut self) {
        if let Some(pool) = &self.pool {
            let mut state = pool.lock();
            if state.open {
                state.free.push(self.id);
                return;
            }
        }
        self.device.destroy_surface(self.id);
    }
}

impl PlatformSurface for Surface {
    fn as_any(&self) -> &dyn Any {
        self
    }
}

struct PoolState {
    free: Vec<VASurfaceID>,
    /// False once the pool is dropped: surfaces coming back are destroyed instead.
    open: bool,
}

struct PoolInner(Mutex<PoolState>);

impl PoolInner {
    fn lock(&self) -> std::sync::MutexGuard<'_, PoolState> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// Surfaces of one format and size, reused: a steady stream allocates none.
pub struct SurfacePool {
    device: Arc<Device>,
    format: SurfaceFormat,
    size: Size,
    inner: Arc<PoolInner>,
}

impl SurfacePool {
    pub fn new(
        device: &Arc<Device>,
        format: SurfaceFormat,
        size: Size,
    ) -> Result<Self, CodecError> {
        size.validate()?;
        Ok(Self {
            device: Arc::clone(device),
            format,
            size,
            inner: Arc::new(PoolInner(Mutex::new(PoolState {
                free: Vec::new(),
                open: true,
            }))),
        })
    }

    pub fn size(&self) -> Size {
        self.size
    }

    /// A free surface, or a new one.
    pub fn take(&self) -> Result<Surface, CodecError> {
        let reused = self.inner.lock().free.pop();
        let id = match reused {
            Some(id) => id,
            None => self
                .device
                .create_surfaces(self.format, self.size, 1, &mut Vec::new())?[0],
        };
        Ok(Surface {
            device: Arc::clone(&self.device),
            id,
            size: self.size,
            format: self.format,
            pool: Some(Arc::clone(&self.inner)),
        })
    }
}

impl Drop for SurfacePool {
    fn drop(&mut self) {
        let ids = {
            let mut state = self.inner.lock();
            state.open = false;
            std::mem::take(&mut state.free)
        };
        for id in ids {
            self.device.destroy_surface(id);
        }
    }
}

/// A `VAImage` and its buffer, for copies between CPU memory and a surface.
struct Image<'a> {
    device: &'a Device,
    image: VAImage,
    size: Size,
}

impl<'a> Image<'a> {
    fn new(device: &'a Arc<Device>, format: SurfaceFormat, size: Size) -> Result<Self, CodecError> {
        let (bits, depth) = if format.pixel == PixelFormat::Nv12 {
            (12, 8)
        } else {
            (32, 24)
        };
        let f = VAImageFormat {
            fourcc: format.va_fourcc,
            byte_order: VA_LSB_FIRST,
            bits_per_pixel: bits,
            depth,
            ..Default::default()
        };
        let image = device.take_image(&f, size)?;
        Ok(Self {
            device,
            image,
            size,
        })
    }

    fn planes(&self, format: PixelFormat) -> Vec<(usize, usize, usize, usize)> {
        let w = self.size.width as usize;
        let h = self.size.height as usize;
        let i = &self.image;
        match format {
            PixelFormat::Nv12 => vec![
                (i.offsets[0] as usize, i.pitches[0] as usize, w, h),
                (i.offsets[1] as usize, i.pitches[1] as usize, w, h / 2),
            ],
            _ => vec![(i.offsets[0] as usize, i.pitches[0] as usize, w * 4, h)],
        }
    }

    /// Plane `(offset, pitch, row bytes, rows)` all inside the image's data.
    fn checked_planes(
        &self,
        format: PixelFormat,
    ) -> Result<Vec<(usize, usize, usize, usize)>, CodecError> {
        let planes = self.planes(format);
        let size = self.image.data_size as usize;
        let fits = planes.iter().all(|(offset, pitch, row, rows)| {
            *row <= *pitch
                && rows
                    .checked_sub(1)
                    .is_none_or(|r| offset + r * pitch + row <= size)
        });
        if !fits {
            return Err(CodecError::Backend(
                "VA image smaller than its planes".into(),
            ));
        }
        Ok(planes)
    }

    fn write(&self, picture: &CpuPicture) -> Result<(), CodecError> {
        let layout = self.checked_planes(picture.format())?;
        let base = self.device.map_id(self.image.buf)?.cast::<u8>();
        for ((offset, pitch, row, rows), plane) in layout.into_iter().zip(picture.planes()) {
            for y in 0..rows {
                let src = &plane.data[y * plane.stride..y * plane.stride + row];
                // SAFETY: `checked_planes` keeps every row inside the mapped `data_size`.
                unsafe {
                    std::ptr::copy_nonoverlapping(src.as_ptr(), base.add(offset + y * pitch), row);
                }
            }
        }
        self.device.unmap_id(self.image.buf)
    }

    fn read(&self, format: PixelFormat, pts_us: u64) -> Result<CpuPicture, CodecError> {
        let layout = self.checked_planes(format)?;
        let base = self.device.map_id(self.image.buf)?.cast::<u8>();
        let mut planes = Vec::with_capacity(layout.len());
        for (offset, pitch, row, rows) in layout {
            let mut data = vec![0u8; row * rows];
            for y in 0..rows {
                // SAFETY: as in `write`.
                unsafe {
                    std::ptr::copy_nonoverlapping(
                        base.add(offset + y * pitch),
                        data[y * row..].as_mut_ptr(),
                        row,
                    );
                }
            }
            planes.push(Plane { data, stride: row });
        }
        self.device.unmap_id(self.image.buf)?;
        CpuPicture::new(self.size, format, planes, pts_us)
    }
}

impl Drop for Image<'_> {
    fn drop(&mut self) {
        self.device.give_image(self.image);
    }
}

/// One memory object of a DMA-BUF: its fd (borrowed for the import only), size and
/// format modifier.
#[derive(Clone, Copy, Debug)]
pub struct DmaBufObject<'fd> {
    pub fd: BorrowedFd<'fd>,
    pub size: u32,
    pub modifier: u64,
}

/// One plane: which object, and where in it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DmaBufPlane {
    pub object: u32,
    pub offset: u32,
    pub pitch: u32,
}

/// A DMA-BUF as PipeWire describes it (`SPA_DATA_DmaBuf`): a DRM format, its objects and
/// planes. `size` 0 on an object means the producer didn't give one. See
/// [`formats::check_dmabuf`] for what is accepted.
#[derive(Clone, Debug)]
pub struct DmaBuf<'fd> {
    pub size: Size,
    pub drm_format: u32,
    pub objects: Vec<DmaBufObject<'fd>>,
    pub planes: Vec<DmaBufPlane>,
}

impl Surface {
    /// Imports a DMA-BUF as a surface (`VA_SURFACE_ATTRIB_MEM_TYPE_DRM_PRIME_2`): the
    /// driver maps the same memory, nothing is copied. The fds may be closed afterwards.
    pub fn import(device: &Arc<Device>, buf: &DmaBuf<'_>) -> Result<Self, CodecError> {
        let objects: Vec<formats::ObjectLayout> = buf
            .objects
            .iter()
            .map(|o| formats::ObjectLayout {
                size: o.size,
                modifier: o.modifier,
            })
            .collect();
        let planes: Vec<formats::PlaneLayout> = buf
            .planes
            .iter()
            .map(|p| formats::PlaneLayout {
                object: p.object,
                offset: p.offset,
                pitch: p.pitch,
            })
            .collect();
        // Geometry is checked here, never left to the driver to misread.
        let format = formats::check_dmabuf(buf.size, buf.drm_format, &objects, &planes)?;
        let mut desc = VADRMPRIMESurfaceDescriptor {
            fourcc: format.va_fourcc,
            width: buf.size.width,
            height: buf.size.height,
            num_objects: buf.objects.len() as u32,
            num_layers: 1,
            ..Default::default()
        };
        for (slot, o) in desc.objects.iter_mut().zip(&buf.objects) {
            *slot = VADRMPRIMEObject {
                fd: o.fd.as_raw_fd(),
                size: o.size,
                drm_format_modifier: o.modifier,
            };
        }
        let layer = &mut desc.layers[0];
        layer.drm_format = buf.drm_format;
        layer.num_planes = buf.planes.len() as u32;
        for (i, p) in buf.planes.iter().enumerate() {
            if p.object as usize >= buf.objects.len() {
                return Err(CodecError::InvalidInput(
                    "DMA-BUF plane names no object".into(),
                ));
            }
            layer.object_index[i] = p.object;
            layer.offset[i] = p.offset;
            layer.pitch[i] = p.pitch;
        }
        let mut attribs = vec![
            VASurfaceAttrib::int(
                surface_attrib::MEMORY_TYPE,
                VA_SURFACE_ATTRIB_MEM_TYPE_DRM_PRIME_2 as i32,
            ),
            VASurfaceAttrib::pointer(
                surface_attrib::EXTERNAL_BUFFER_DESCRIPTOR,
                (&mut desc as *mut VADRMPRIMESurfaceDescriptor).cast(),
            ),
        ];
        let ids = device.create_surfaces(format, buf.size, 1, &mut attribs)?;
        Ok(Self {
            device: Arc::clone(device),
            id: ids[0],
            size: buf.size,
            format,
            pool: None,
        })
    }
}

/// Whether a config's surfaces can be imported from DMA-BUFs.
pub fn imports_dmabuf(attribs: &[VASurfaceAttrib]) -> bool {
    attribs.iter().any(|a| {
        a.type_ == surface_attrib::MEMORY_TYPE
            && a.value.type_ == VA_GENERIC_VALUE_TYPE_INTEGER
            // SAFETY: an integer-typed generic value holds `i`.
            && unsafe { a.value.value.i } as u32 & VA_SURFACE_ATTRIB_MEM_TYPE_DRM_PRIME_2 != 0
    })
}

/// The largest surface a config takes, from its attributes.
pub fn max_size(attribs: &[VASurfaceAttrib]) -> Option<Size> {
    let int = |t| {
        attribs
            .iter()
            .find(|a| a.type_ == t && a.value.type_ == VA_GENERIC_VALUE_TYPE_INTEGER)
            // SAFETY: an integer-typed generic value holds `i`.
            .map(|a| unsafe { a.value.value.i }.max(0) as u32)
    };
    Some(Size {
        width: int(surface_attrib::MAX_WIDTH)?,
        height: int(surface_attrib::MAX_HEIGHT)?,
    })
}
