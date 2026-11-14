// SPDX-License-Identifier: Apache-2.0
//! D3D11 textures as pipeline pictures, rings of them, and the counted CPU↔GPU copies.
use super::com::Ctx;
use super::device::MfDevice;
use media_codec::{
    CodecError, CpuPicture, Picture, PixelFormat, Plane, PlatformPicture, PlatformSurface, Size,
};
use std::any::Any;
use std::sync::Arc;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_RENDER_TARGET, D3D11_CPU_ACCESS_READ, D3D11_CPU_ACCESS_WRITE, D3D11_MAP_READ,
    D3D11_MAP_WRITE, D3D11_MAPPED_SUBRESOURCE, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
    D3D11_USAGE_STAGING, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_NV12, DXGI_SAMPLE_DESC,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MfFormat {
    Nv12,
    Bgra,
}
impl MfFormat {
    pub(crate) fn dxgi(self) -> DXGI_FORMAT {
        match self {
            Self::Nv12 => DXGI_FORMAT_NV12,
            Self::Bgra => DXGI_FORMAT_B8G8R8A8_UNORM,
        }
    }
    pub(crate) fn pixel(self) -> PixelFormat {
        match self {
            Self::Nv12 => PixelFormat::Nv12,
            Self::Bgra => PixelFormat::Bgra8,
        }
    }
}

/// One D3D11 texture (or one slice of a texture array) holding a picture. Holds its
/// device, so the texture never outlives it. `lease` tells a ring the texture is in use.
pub struct MfSurface {
    pub(crate) texture: ID3D11Texture2D,
    pub(crate) subresource: u32,
    pub(crate) device: MfDevice,
    pub(crate) format: MfFormat,
    pub(crate) size: Size,
    pub(crate) lease: Arc<()>,
}
// SAFETY: D3D11 resources are free-threaded, and the device that owns this one is
// multithread-protected (see `device.rs`), so the texture may be used and released anywhere.
unsafe impl Send for MfSurface {}
impl PlatformSurface for MfSurface {
    fn as_any(&self) -> &dyn Any {
        self
    }
}
impl MfSurface {
    pub fn of(picture: &Picture) -> Option<&Self> {
        match picture {
            Picture::Platform(p) => p.surface.as_any().downcast_ref(),
            Picture::Cpu(_) => None,
        }
    }
    pub fn size(&self) -> Size {
        self.size
    }
    pub fn format(&self) -> MfFormat {
        self.format
    }
    pub fn texture(&self) -> &ID3D11Texture2D {
        &self.texture
    }
    /// Another handle to the same texture, sharing its lease.
    pub fn share(&self) -> Self {
        Self {
            texture: self.texture.clone(),
            subresource: self.subresource,
            device: self.device.clone(),
            format: self.format,
            size: self.size,
            lease: self.lease.clone(),
        }
    }
    pub fn into_picture(self, pts_us: u64) -> Picture {
        Picture::Platform(PlatformPicture {
            size: self.size,
            format: self.format.pixel(),
            pts_us,
            surface: Box::new(self),
        })
    }
}

pub(crate) fn texture(
    device: &MfDevice,
    size: Size,
    format: MfFormat,
    staging: bool,
) -> Result<ID3D11Texture2D, CodecError> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: size.width,
        Height: size.height,
        MipLevels: 1,
        ArraySize: 1,
        Format: format.dxgi(),
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: if staging {
            D3D11_USAGE_STAGING
        } else {
            D3D11_USAGE_DEFAULT
        },
        BindFlags: if staging {
            0
        } else {
            D3D11_BIND_RENDER_TARGET.0 as u32
        },
        CPUAccessFlags: if staging {
            (D3D11_CPU_ACCESS_READ.0 | D3D11_CPU_ACCESS_WRITE.0) as u32
        } else {
            0
        },
        MiscFlags: 0,
    };
    let mut texture = None;
    // SAFETY: A valid descriptor and no initial data.
    unsafe {
        device
            .0
            .device
            .CreateTexture2D(&desc, None, Some(&mut texture))
    }
    .ctx("CreateTexture2D")?;
    texture.ok_or_else(|| CodecError::Backend("CreateTexture2D returned nothing".into()))
}

/// A fixed set of same-sized textures, reused once nothing holds them.
pub(crate) struct Ring {
    device: MfDevice,
    size: Size,
    format: MfFormat,
    slots: Vec<(ID3D11Texture2D, Arc<()>)>,
    capacity: usize,
}
impl Ring {
    pub fn new(device: &MfDevice, size: Size, format: MfFormat, capacity: usize) -> Self {
        Self {
            device: device.clone(),
            size,
            format,
            slots: Vec::with_capacity(capacity),
            capacity,
        }
    }
    pub fn fits(&self, size: Size, format: MfFormat) -> bool {
        self.size == size && self.format == format
    }
    /// A free texture; a new one while under capacity; otherwise backpressure.
    pub fn acquire(&mut self) -> Result<MfSurface, CodecError> {
        let free = self
            .slots
            .iter()
            .find(|(_, lease)| Arc::strong_count(lease) == 1);
        let (texture, lease) = match free {
            Some((texture, lease)) => (texture.clone(), lease.clone()),
            None if self.slots.len() < self.capacity => {
                let texture = texture(&self.device, self.size, self.format, false)?;
                let lease = Arc::new(());
                self.slots.push((texture.clone(), lease.clone()));
                (texture, lease)
            }
            None => return Err(CodecError::Backpressure),
        };
        Ok(MfSurface {
            texture,
            subresource: 0,
            device: self.device.clone(),
            format: self.format,
            size: self.size,
            lease,
        })
    }
}

/// A staging texture for counted copies, kept while the size and format hold.
#[derive(Default)]
pub(crate) struct Staging(Option<(Size, MfFormat, ID3D11Texture2D)>);
impl Staging {
    fn get(
        &mut self,
        device: &MfDevice,
        size: Size,
        format: MfFormat,
    ) -> Result<ID3D11Texture2D, CodecError> {
        if let Some((s, f, t)) = &self.0
            && *s == size
            && *f == format
        {
            return Ok(t.clone());
        }
        let t = texture(device, size, format, true)?;
        self.0 = Some((size, format, t.clone()));
        Ok(t)
    }
}

fn rows(format: MfFormat, size: Size) -> [(usize, usize); 2] {
    let (w, h) = (size.width as usize, size.height as usize);
    match format {
        MfFormat::Nv12 => [(w, h), (w, h / 2)],
        MfFormat::Bgra => [(w * 4, h), (0, 0)],
    }
}

/// One GPU→CPU copy of a texture into a CPU picture.
pub fn read_back(surface: &MfSurface, pts_us: u64) -> Result<CpuPicture, CodecError> {
    read_back_with(&mut Staging::default(), surface, pts_us)
}

pub(crate) fn read_back_with(
    staging: &mut Staging,
    surface: &MfSurface,
    pts_us: u64,
) -> Result<CpuPicture, CodecError> {
    let device = &surface.device;
    let copy = staging.get(device, surface.size, surface.format)?;
    let context = &device.0.context;
    // SAFETY: Same-sized, same-format resources on one device; the source subresource exists.
    unsafe {
        context.CopySubresourceRegion(
            &copy,
            0,
            0,
            0,
            0,
            &surface.texture,
            surface.subresource,
            None,
        );
    }
    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    // SAFETY: A staging texture with CPU read access, mapped and unmapped here.
    unsafe { context.Map(&copy, 0, D3D11_MAP_READ, 0, Some(&mut mapped)) }.ctx("Map")?;
    let pitch = mapped.RowPitch as usize;
    let layout = rows(surface.format, surface.size);
    let mut planes = Vec::with_capacity(2);
    let mut offset = 0;
    for (row, count) in layout.into_iter().filter(|(row, _)| *row > 0) {
        let mut data = vec![0u8; row * count];
        for y in 0..count {
            // SAFETY: Rows lie inside the mapped region: the planes of a mapped NV12
            // subresource follow each other at `RowPitch`, the UV plane after `height` rows.
            let src = unsafe {
                std::slice::from_raw_parts(mapped.pData.cast::<u8>().add(offset + y * pitch), row)
            };
            data[y * row..(y + 1) * row].copy_from_slice(src);
        }
        offset += count * pitch;
        planes.push(Plane { data, stride: row });
    }
    // SAFETY: Balances the Map above.
    unsafe { context.Unmap(&copy, 0) };
    CpuPicture::new(surface.size, surface.format.pixel(), planes, pts_us)
}

/// One CPU→GPU copy of an NV12 or BGRA picture into a new texture.
pub fn upload(device: &MfDevice, picture: &CpuPicture) -> Result<MfSurface, CodecError> {
    let format = match picture.format() {
        PixelFormat::Nv12 => MfFormat::Nv12,
        PixelFormat::Bgra8 => MfFormat::Bgra,
        other => return Err(CodecError::Unsupported(format!("upload of {other:?}"))),
    };
    let mut ring = Ring::new(device, picture.size(), format, 1);
    let target = ring.acquire()?;
    upload_into(&mut Staging::default(), picture, &target)?;
    Ok(target)
}

pub(crate) fn upload_into(
    staging: &mut Staging,
    picture: &CpuPicture,
    target: &MfSurface,
) -> Result<(), CodecError> {
    if picture.size() != target.size || picture.format() != target.format.pixel() {
        return Err(CodecError::InvalidInput(
            "upload target differs from picture".into(),
        ));
    }
    let device = &target.device;
    let copy = staging.get(device, target.size, target.format)?;
    let context = &device.0.context;
    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    // SAFETY: A staging texture with CPU write access, mapped and unmapped here.
    unsafe { context.Map(&copy, 0, D3D11_MAP_WRITE, 0, Some(&mut mapped)) }.ctx("Map")?;
    let pitch = mapped.RowPitch as usize;
    let mut offset = 0;
    for (plane, (row, count)) in picture
        .planes()
        .iter()
        .zip(rows(target.format, target.size))
    {
        for y in 0..count {
            let src = &plane.data[y * plane.stride..y * plane.stride + row];
            // SAFETY: As in `read_back_with`: each row lies inside the mapped region.
            let dst = unsafe {
                std::slice::from_raw_parts_mut(
                    mapped.pData.cast::<u8>().add(offset + y * pitch),
                    row,
                )
            };
            dst.copy_from_slice(src);
        }
        offset += count * pitch;
    }
    // SAFETY: Balances the Map above; then a same-sized, same-format GPU copy.
    unsafe {
        context.Unmap(&copy, 0);
        context.CopySubresourceRegion(&target.texture, target.subresource, 0, 0, 0, &copy, 0, None);
    }
    Ok(())
}
