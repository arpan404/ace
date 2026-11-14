// SPDX-License-Identifier: Apache-2.0
//! Colour conversion and scaling between `CVPixelBuffer`s with
//! `VTPixelTransferSession`, into pooled destination buffers.
#![allow(unsafe_code)]
use crate::Copies;
use crate::cf;
use crate::surface::{PixelPool, VtFormat, VtSurface};
use media_codec::*;
use objc2_core_foundation::CFRetained;
use objc2_video_toolbox::VTPixelTransferSession;
use std::ptr::NonNull;

pub struct VtScaler {
    session: CFRetained<VTPixelTransferSession>,
    format: VtFormat,
    destination: Option<PixelPool>,
    uploads: Option<PixelPool>,
    copies: Copies,
}
// SAFETY: The transfer session is used one call at a time through &mut self.
unsafe impl Send for VtScaler {}
impl VtScaler {
    /// Output pictures use `format`; NV12 ↔ BGRA conversion happens in the transfer.
    pub fn new(format: VtFormat) -> Result<Self, CodecError> {
        let mut raw: *mut VTPixelTransferSession = std::ptr::null_mut();
        // SAFETY: The out pointer receives a +1 session on success.
        let status = unsafe { VTPixelTransferSession::create(None, NonNull::from(&mut raw)) };
        cf::check(status, "open pixel transfer")?;
        let raw = NonNull::new(raw)
            .ok_or_else(|| CodecError::Backend("no pixel transfer session".into()))?;
        Ok(Self {
            // SAFETY: Create rule.
            session: unsafe { CFRetained::from_raw(raw) },
            format,
            destination: None,
            uploads: None,
            copies: Copies::default(),
        })
    }
    pub fn last_copies(&self) -> Copies {
        self.copies
    }
    /// Converts and scales into a buffer from this scaler's pool.
    pub fn transfer(
        &mut self,
        source: &VtSurface,
        size: Size,
        pts_us: u64,
    ) -> Result<Picture, CodecError> {
        size.validate()?;
        if self
            .destination
            .as_ref()
            .is_none_or(|pool| pool.size() != size)
        {
            self.destination = Some(PixelPool::new(size, self.format, 3)?);
        }
        let pool = self.destination.as_ref().ok_or(CodecError::NotConfigured)?;
        let target = pool.acquire()?;
        // SAFETY: Both buffers are valid, distinct pixel buffers.
        let status = unsafe {
            self.session
                .transfer_image(source.buffer(), target.buffer())
        };
        cf::check(status, "pixel transfer")?;
        target.into_picture(pts_us)
    }
}
impl Drop for VtScaler {
    fn drop(&mut self) {
        // SAFETY: Valid session, invalidated once before release.
        unsafe { self.session.invalidate() };
    }
}
impl Scaler for VtScaler {
    fn scale(&mut self, picture: &Picture, width: u32, height: u32) -> Result<Picture, CodecError> {
        let size = Size { width, height };
        if let Some(surface) = VtSurface::of(picture) {
            self.copies = Copies::default();
            return self.transfer(surface, size, picture.pts_us());
        }
        let Picture::Cpu(cpu) = picture else {
            return Err(CodecError::InvalidInput(
                "not a CVPixelBuffer picture".into(),
            ));
        };
        let format = match cpu.format() {
            PixelFormat::Nv12 => VtFormat::Nv12,
            _ => VtFormat::Bgra,
        };
        if self
            .uploads
            .as_ref()
            .is_none_or(|pool| pool.size() != cpu.size() || pool.format() != format)
        {
            self.uploads = Some(PixelPool::new(cpu.size(), format, 2)?);
        }
        let pool = self.uploads.as_ref().ok_or(CodecError::NotConfigured)?;
        let uploaded = pool.upload(cpu)?;
        let surface = VtSurface::of(&uploaded).ok_or(CodecError::NotConfigured)?;
        let out = self.transfer(surface, size, cpu.pts_us);
        self.copies = Copies {
            readbacks: 0,
            uploads: 1,
        };
        out
    }
}
