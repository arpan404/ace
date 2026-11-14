// SPDX-License-Identifier: Apache-2.0
//! GPU pictures NVENC takes without a copy: a GL texture (Linux) or a D3D11 texture
//! (Windows), in 32-bit RGB that NVENC converts to YUV itself.
#![allow(unsafe_code)]
use media_codec::PlatformSurface;
use std::any::Any;
use std::ffi::c_void;

/// A GL texture on the context that is current while `NvEncoder` encodes. `owner` is whatever
/// keeps the texture alive (the helper's EGLImage and texture wrapper); dropping it releases
/// the texture.
pub struct GlTexture {
    pub(crate) texture: u32,
    pub(crate) target: u32,
    _owner: Box<dyn Any + Send>,
}

impl GlTexture {
    /// `target` is `GL_TEXTURE_2D` or `GL_TEXTURE_RECTANGLE`.
    pub fn new(texture: u32, target: u32, owner: Box<dyn Any + Send>) -> Self {
        Self {
            texture,
            target,
            _owner: owner,
        }
    }
}

impl PlatformSurface for GlTexture {
    fn as_any(&self) -> &dyn Any {
        self
    }
}

/// An `ID3D11Texture2D` on the device the encoder was opened with.
pub struct D3d11Texture {
    pub(crate) texture: *mut c_void,
    _owner: Box<dyn Any + Send>,
}

impl D3d11Texture {
    /// # Safety
    /// `texture` must be an `ID3D11Texture2D*` that stays valid while `owner` is alive, on a
    /// device created multithread-protected, so it may be used from any thread.
    pub unsafe fn new(texture: *mut c_void, owner: Box<dyn Any + Send>) -> Self {
        Self {
            texture,
            _owner: owner,
        }
    }
}

// SAFETY: `new`'s contract: the texture lives as long as `owner` and its device is
// multithread-protected.
unsafe impl Send for D3d11Texture {}

impl PlatformSurface for D3d11Texture {
    fn as_any(&self) -> &dyn Any {
        self
    }
}
