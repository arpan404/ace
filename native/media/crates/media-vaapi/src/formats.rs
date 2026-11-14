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

/// `DRM_FORMAT_MOD_LINEAR`.
pub const DRM_FORMAT_MOD_LINEAR: u64 = 0;

/// One plane of a DMA-BUF: the object it lives in, where, and its row pitch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PlaneLayout {
    pub object: u32,
    pub offset: u32,
    pub pitch: u32,
}

/// One memory object: its size in bytes (0 when the producer didn't say) and modifier.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ObjectLayout {
    pub size: u32,
    pub modifier: u64,
}

fn refuse(what: &str) -> media_codec::CodecError {
    media_codec::CodecError::InvalidInput(format!("DMA-BUF: {what}"))
}

/// Checks a DMA-BUF's geometry before any driver sees it, and gives its surface format.
///
/// - The format is one VA imports here (XRGB/ARGB/XBGR/ABGR 8888, NV12).
/// - Every object has an explicit modifier, the same for all: `DRM_FORMAT_MOD_INVALID`
///   (an implicit layout) is refused, because importing it as linear would misread a tiled
///   buffer. Captures negotiate explicit modifiers from `vaQuerySurfaceAttributes`.
/// - The plane count is the format's (RGB 1, NV12 2), or twice that for a non-linear
///   modifier, whose extra planes are compression metadata.
/// - Each main plane's pitch holds a row (width × bytes per sample), and when the object's
///   size is known, `offset + pitch × rows` fits inside it. Metadata planes start inside
///   their object.
pub fn check_dmabuf(
    size: media_codec::Size,
    drm_format: u32,
    objects: &[ObjectLayout],
    planes: &[PlaneLayout],
) -> Result<SurfaceFormat, media_codec::CodecError> {
    size.validate()?;
    let format = from_drm(drm_format).ok_or_else(|| {
        media_codec::CodecError::Unsupported("DMA-BUF format VA can't import".into())
    })?;
    if objects.is_empty() || objects.len() > 4 {
        return Err(refuse("needs one to four memory objects"));
    }
    let modifier = objects[0].modifier;
    if modifier == DRM_FORMAT_MOD_INVALID {
        return Err(refuse("implicit modifier (DRM_FORMAT_MOD_INVALID)"));
    }
    if objects.iter().any(|o| o.modifier != modifier) {
        return Err(refuse("objects with different modifiers"));
    }
    let (w, h) = (u64::from(size.width), u64::from(size.height));
    // (row bytes, rows) per main plane.
    let main: &[(u64, u64)] = match format.pixel {
        PixelFormat::Nv12 => {
            if w % 2 != 0 || h % 2 != 0 {
                return Err(refuse("NV12 needs even sizes"));
            }
            &[(w, h), (w, h / 2)]
        }
        _ => &[(w * 4, h)],
    };
    let expected = if modifier == DRM_FORMAT_MOD_LINEAR {
        main.len()
    } else {
        main.len() * 2
    };
    if planes.len() != main.len() && planes.len() != expected {
        return Err(refuse("plane count doesn't match the format"));
    }
    for (i, plane) in planes.iter().enumerate() {
        let object = objects
            .get(plane.object as usize)
            .ok_or_else(|| refuse("plane names no object"))?;
        let known = u64::from(object.size);
        let offset = u64::from(plane.offset);
        if let Some(&(row, rows)) = main.get(i) {
            let pitch = u64::from(plane.pitch);
            if pitch < row {
                return Err(refuse("pitch shorter than a row"));
            }
            if known != 0 && offset + pitch * rows > known {
                return Err(refuse("plane runs past its object"));
            }
        } else if known != 0 && offset >= known {
            return Err(refuse("metadata plane outside its object"));
        }
    }
    Ok(format)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fourccs_are_little_endian_character_codes() {
        assert_eq!(VA_FOURCC_NV12, 0x3231_564e);
        assert_eq!(DRM_FORMAT_XRGB8888, 0x3432_5258);
    }

    const LINEAR: ObjectLayout = ObjectLayout {
        size: 0,
        modifier: DRM_FORMAT_MOD_LINEAR,
    };

    fn plane(object: u32, offset: u32, pitch: u32) -> PlaneLayout {
        PlaneLayout {
            object,
            offset,
            pitch,
        }
    }

    const HD: media_codec::Size = media_codec::Size {
        width: 1920,
        height: 1080,
    };

    #[test]
    fn well_formed_captures_are_accepted() {
        let sized = ObjectLayout {
            size: 7680 * 1080,
            modifier: DRM_FORMAT_MOD_LINEAR,
        };
        assert_eq!(
            check_dmabuf(HD, DRM_FORMAT_XRGB8888, &[sized], &[plane(0, 0, 7680)]),
            Ok(BGRX)
        );
        let nv12 = ObjectLayout {
            size: 2048 * 1080 * 3 / 2,
            modifier: DRM_FORMAT_MOD_LINEAR,
        };
        assert_eq!(
            check_dmabuf(
                HD,
                DRM_FORMAT_NV12,
                &[nv12],
                &[plane(0, 0, 2048), plane(0, 2048 * 1080, 2048)]
            ),
            Ok(NV12)
        );
        // A tiled, compressed buffer: two main planes and their metadata planes.
        let tiled = ObjectLayout {
            size: 0,
            modifier: 0x0100_0000_0000_0006,
        };
        let planes = [plane(0, 0, 7680), plane(0, 1 << 24, 512)];
        assert_eq!(
            check_dmabuf(HD, DRM_FORMAT_ARGB8888, &[tiled], &planes),
            Ok(BGRX)
        );
    }

    #[test]
    fn malformed_geometry_is_refused_before_the_driver() {
        let refused = |objects: &[ObjectLayout], planes: &[PlaneLayout], format: u32| {
            matches!(
                check_dmabuf(HD, format, objects, planes),
                Err(media_codec::CodecError::InvalidInput(_))
            )
        };
        let x = DRM_FORMAT_XRGB8888;
        let implicit = ObjectLayout {
            size: 0,
            modifier: DRM_FORMAT_MOD_INVALID,
        };
        assert!(
            refused(&[implicit], &[plane(0, 0, 7680)], x),
            "implicit modifier"
        );
        assert!(refused(&[LINEAR], &[plane(0, 0, 7676)], x), "short pitch");
        assert!(
            refused(&[LINEAR], &[plane(0, 0, 7680), plane(0, 0, 7680)], x),
            "RGB with two planes"
        );
        assert!(
            refused(&[LINEAR], &[plane(0, 0, 1920)], DRM_FORMAT_NV12),
            "NV12 with one plane"
        );
        assert!(
            refused(&[LINEAR], &[plane(1, 0, 7680)], x),
            "plane names a missing object"
        );
        let small = ObjectLayout {
            size: 7680 * 1079,
            modifier: DRM_FORMAT_MOD_LINEAR,
        };
        assert!(
            refused(&[small], &[plane(0, 0, 7680)], x),
            "plane past its object"
        );
        let huge = ObjectLayout {
            size: u32::MAX,
            modifier: DRM_FORMAT_MOD_LINEAR,
        };
        assert!(
            refused(&[huge], &[plane(0, u32::MAX, u32::MAX)], x),
            "offset + pitch × rows overflow"
        );
        let other = ObjectLayout {
            size: 0,
            modifier: 2,
        };
        assert!(
            refused(&[LINEAR, other], &[plane(0, 0, 7680)], x),
            "mixed modifiers"
        );
        assert!(refused(&[], &[plane(0, 0, 7680)], x), "no objects");
        let odd = media_codec::Size {
            width: 1919,
            height: 1080,
        };
        assert!(
            check_dmabuf(
                odd,
                DRM_FORMAT_NV12,
                &[LINEAR],
                &[plane(0, 0, 2048), plane(0, 0, 2048)]
            )
            .is_err(),
            "odd NV12"
        );
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
