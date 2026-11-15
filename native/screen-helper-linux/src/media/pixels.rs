//! PipeWire's raw video formats as the encoders name them, and a shared-memory picture's
//! visible region copied out as the CPU picture an encoder takes. Pure.
use media_codec::{CodecError, CpuPicture, PixelFormat, Plane, Size};

/// `SPA_VIDEO_FORMAT_*` values this helper negotiates.
pub const SPA_RGBX: u32 = 7;
pub const SPA_BGRX: u32 = 8;
pub const SPA_RGBA: u32 = 11;
pub const SPA_BGRA: u32 = 12;

const fn fourcc(code: &[u8; 4]) -> u32 {
    u32::from_le_bytes(*code)
}

/// The packed format in memory: SPA names bytes in memory order, as media-codec does.
pub fn pixel_format(spa: u32) -> Option<PixelFormat> {
    match spa {
        SPA_RGBX | SPA_RGBA => Some(PixelFormat::Rgba8),
        SPA_BGRX | SPA_BGRA => Some(PixelFormat::Bgra8),
        _ => None,
    }
}

/// The DRM fourcc of a DMA-BUF in that format. DRM names a little-endian word from its high
/// byte, so memory B, G, R, X is `XRGB8888`.
pub fn drm_format(spa: u32) -> Option<u32> {
    match spa {
        SPA_BGRX => Some(fourcc(b"XR24")),
        SPA_BGRA => Some(fourcc(b"AR24")),
        SPA_RGBX => Some(fourcc(b"XB24")),
        SPA_RGBA => Some(fourcc(b"AB24")),
        _ => None,
    }
}

/// The `(left, top, width, height)` region of a mapped buffer as a packed CPU picture. One copy:
/// the buffer goes back to the desktop after the callback, the picture outlives it.
pub fn region_picture(
    bytes: &[u8],
    stride: usize,
    spa: u32,
    (left, top, width, height): (u32, u32, u32, u32),
    pts_us: u64,
) -> Result<CpuPicture, CodecError> {
    let format = pixel_format(spa).ok_or_else(|| CodecError::Unsupported("pixel format".into()))?;
    let row = width as usize * 4;
    let mut data = Vec::with_capacity(row * height as usize);
    for y in top..top + height {
        let start = y as usize * stride + left as usize * 4;
        let line = bytes
            .get(start..start + row)
            .ok_or_else(|| CodecError::InvalidInput("region outside the buffer".into()))?;
        data.extend_from_slice(line);
    }
    CpuPicture::new(
        Size { width, height },
        format,
        [Plane { data, stride: row }],
        pts_us,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spa_formats_map_to_the_drm_fourccs_va_and_egl_import() {
        assert_eq!(drm_format(SPA_BGRX), Some(0x3432_5258));
        assert_eq!(drm_format(SPA_RGBA), Some(0x3432_4241));
        assert_eq!(drm_format(99), None);
        assert_eq!(pixel_format(SPA_BGRA), Some(PixelFormat::Bgra8));
    }

    #[test]
    fn only_the_visible_region_is_copied_row_by_row() {
        // 4×3 buffer with 4 bytes of row padding; each pixel's bytes are its index.
        let stride = 4 * 4 + 4;
        let mut bytes = vec![0u8; stride * 3];
        for y in 0..3 {
            for x in 0..4 {
                let at = y * stride + x * 4;
                bytes[at..at + 4].fill((y * 4 + x) as u8);
            }
        }
        let picture = region_picture(&bytes, stride, SPA_BGRX, (1, 1, 2, 2), 9).unwrap();
        assert_eq!(
            picture.size(),
            Size {
                width: 2,
                height: 2
            }
        );
        let plane = &picture.planes()[0];
        let firsts: Vec<u8> = plane.data.chunks(4).map(|p| p[0]).collect();
        assert_eq!(firsts, [5, 6, 9, 10]);
    }

    #[test]
    fn a_region_past_the_buffer_is_refused() {
        assert!(region_picture(&[0; 64], 16, SPA_BGRX, (0, 0, 4, 5), 0).is_err());
    }
}
