// SPDX-License-Identifier: Apache-2.0
//! Pixel format codes: VA fourccs (`va.h`), the DRM fourccs PipeWire hands over with a
//! DMA-BUF (`drm_fourcc.h`), and the render-target formats surfaces are created with.
use media_codec::PixelFormat;

pub const fn fourcc(code: &[u8; 4]) -> u32 {
    (code[0] as u32) | ((code[1] as u32) << 8) | ((code[2] as u32) << 16) | ((code[3] as u32) << 24)
}

pub const VA_FOURCC_NV12: u32 = fourcc(b"NV12");
pub const VA_FOURCC_BGRA: u32 = fourcc(b"BGRA");
pub const VA_FOURCC_BGRX: u32 = fourcc(b"BGRX");
pub const VA_FOURCC_RGBA: u32 = fourcc(b"RGBA");
pub const VA_FOURCC_RGBX: u32 = fourcc(b"RGBX");
pub const VA_FOURCC_IMC3: u32 = fourcc(b"IMC3");
pub const VA_FOURCC_422H: u32 = fourcc(b"422H");
pub const VA_FOURCC_444P: u32 = fourcc(b"444P");
pub const VA_FOURCC_Y800: u32 = fourcc(b"Y800");

pub const DRM_FORMAT_XRGB8888: u32 = fourcc(b"XR24");
pub const DRM_FORMAT_ARGB8888: u32 = fourcc(b"AR24");
pub const DRM_FORMAT_XBGR8888: u32 = fourcc(b"XB24");
pub const DRM_FORMAT_ABGR8888: u32 = fourcc(b"AB24");
pub const DRM_FORMAT_NV12: u32 = fourcc(b"NV12");
/// `DRM_FORMAT_MOD_INVALID`: the producer gave no explicit modifier.
pub const DRM_FORMAT_MOD_INVALID: u64 = 0x00ff_ffff_ffff_ffff;

pub const VA_RT_FORMAT_YUV420: u32 = 0x1;
pub const VA_RT_FORMAT_YUV422: u32 = 0x2;
pub const VA_RT_FORMAT_YUV444: u32 = 0x4;
pub const VA_RT_FORMAT_YUV400: u32 = 0x10;
pub const VA_RT_FORMAT_RGB32: u32 = 0x20000;

/// A surface format ace creates or imports.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SurfaceFormat {
    pub va_fourcc: u32,
    pub rt_format: u32,
    pub pixel: PixelFormat,
}

pub const NV12: SurfaceFormat = SurfaceFormat {
    va_fourcc: VA_FOURCC_NV12,
    rt_format: VA_RT_FORMAT_YUV420,
    pixel: PixelFormat::Nv12,
};
pub const BGRX: SurfaceFormat = SurfaceFormat {
    va_fourcc: VA_FOURCC_BGRX,
    rt_format: VA_RT_FORMAT_RGB32,
    pixel: PixelFormat::Bgra8,
};
pub const RGBX: SurfaceFormat = SurfaceFormat {
    va_fourcc: VA_FOURCC_RGBX,
    rt_format: VA_RT_FORMAT_RGB32,
    pixel: PixelFormat::Rgba8,
};

/// The VA surface format for a DMA-BUF's DRM format. Alpha is ignored: screens are opaque.
pub fn from_drm(drm_format: u32) -> Option<SurfaceFormat> {
    match drm_format {
        DRM_FORMAT_XRGB8888 | DRM_FORMAT_ARGB8888 => Some(BGRX),
        DRM_FORMAT_XBGR8888 | DRM_FORMAT_ABGR8888 => Some(RGBX),
        DRM_FORMAT_NV12 => Some(NV12),
        _ => None,
    }
}

/// The VA surface format a CPU picture is uploaded into. RGB without padding has no VA
/// surface format; the caller converts it first.
pub fn for_pixel(format: PixelFormat) -> Option<SurfaceFormat> {
    match format {
        PixelFormat::Nv12 => Some(NV12),
        PixelFormat::Bgra8 => Some(BGRX),
        PixelFormat::Rgba8 => Some(RGBX),
        PixelFormat::Rgb8 => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fourccs_are_little_endian_character_codes() {
        assert_eq!(VA_FOURCC_NV12, 0x3231_564e);
        assert_eq!(DRM_FORMAT_XRGB8888, 0x3432_5258);
    }

    #[test]
    fn screen_capture_formats_map_to_surfaces_without_alpha() {
        assert_eq!(from_drm(DRM_FORMAT_ARGB8888), Some(BGRX));
        assert_eq!(from_drm(DRM_FORMAT_XBGR8888), Some(RGBX));
        assert_eq!(from_drm(DRM_FORMAT_NV12), Some(NV12));
        assert_eq!(from_drm(fourcc(b"YUYV")), None);
        assert_eq!(for_pixel(PixelFormat::Rgb8), None);
    }
}
