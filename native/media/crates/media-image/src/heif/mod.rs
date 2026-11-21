// SPDX-License-Identifier: Apache-2.0
//! HEIC and HEIF stills (ADR 0208 §2), decoded by the operating system's own decoder: ImageIO
//! on macOS, WIC on Windows where the HEIF and HEVC extensions are installed. ace ships no HEVC
//! decoder of its own (the open ones are LGPL), so elsewhere a HEIC is `unsupported`: it stays
//! an opaque file, never a preview.
//!
//! The container is checked here first, whatever the OS: every top-level box must be whole, so
//! a file cut short is refused `truncated` from its boxes before the system decoder sees it.
use crate::error::{Failed, Result};
use crate::limits::check_input;
use crate::raster::Raster;

#[cfg(target_os = "macos")]
#[path = "macos.rs"]
mod system;
#[cfg(windows)]
#[path = "windows.rs"]
mod system;
#[cfg(not(any(target_os = "macos", windows)))]
mod system {
    use crate::error::{Failed, Result};
    use crate::raster::Raster;

    fn none() -> Failed {
        Failed::new(
            crate::ImageFailure::Unsupported,
            "HEIC images need the system's decoder, and this OS has none ace uses.",
        )
    }
    pub fn header(_: &[u8]) -> Result<(u32, u32, u8)> {
        Err(none())
    }
    pub fn decode(_: &[u8], _: (u32, u32)) -> Result<Raster> {
        Err(none())
    }
}

/// Major brands of HEIF stills and sequences (ISO/IEC 23008-12), HEVC-coded or not.
const BRANDS: [&[u8; 4]; 8] = [
    b"heic", b"heix", b"heim", b"heis", b"hevc", b"hevx", b"mif1", b"msf1",
];

/// A HEIF file: an `ftyp` box first, with one of `BRANDS` as its major brand.
pub fn sniff(bytes: &[u8]) -> bool {
    bytes.len() >= 12 && &bytes[4..8] == b"ftyp" && BRANDS.iter().any(|b| &bytes[8..12] == *b)
}

/// The top-level boxes (ISO/IEC 14496-12 §4.2), each whole, with a `meta` box among them.
fn whole(bytes: &[u8]) -> Result<()> {
    let length = bytes.len() as u64;
    let mut at: u64 = 0;
    let mut meta = false;
    while at < length {
        let head = |from: u64, n: u64| {
            bytes
                .get(from as usize..(from + n) as usize)
                .ok_or_else(|| Failed::truncated("HEIC"))
        };
        let b = head(at, 8)?;
        let size = u64::from(u32::from_be_bytes([b[0], b[1], b[2], b[3]]));
        meta |= &b[4..8] == b"meta";
        let (size, header) = match size {
            // The last box, to the end of the file.
            0 => (length - at, 8),
            1 => {
                let large = head(at + 8, 8)?;
                let mut wide = [0; 8];
                wide.copy_from_slice(large);
                (u64::from_be_bytes(wide), 16)
            }
            n => (n, 8),
        };
        if size < header {
            return Err(Failed::decode("HEIC", "a box is shorter than its header"));
        }
        let end = at.checked_add(size).ok_or_else(|| Failed::truncated("HEIC"))?;
        if end > length {
            return Err(Failed::truncated("HEIC"));
        }
        at = end;
    }
    if meta {
        Ok(())
    } else {
        Err(Failed::truncated("HEIC"))
    }
}

/// The primary image's stored size and orientation, from its metadata alone.
pub fn header(bytes: &[u8]) -> Result<(u32, u32, u8)> {
    whole(bytes)?;
    system::header(bytes)
}

/// The primary image as RGBA in sRGB, at its stored size and not turned, with its orientation.
pub fn decode(bytes: &[u8], max_pixels: u32) -> Result<(Raster, u8)> {
    let (width, height, orientation) = header(bytes)?;
    check_input(width, height, max_pixels)?;
    let raster = system::decode(bytes, (width, height))?;
    Ok((raster, orientation))
}

/// Straight alpha from premultiplied, in place: ImageIO draws premultiplied, and so may a TIFF
/// store its pixels.
pub(crate) fn unpremultiply(data: &mut [u8]) {
    for p in data.chunks_exact_mut(4) {
        let a = u16::from(p[3]);
        if a == 0 || a == 255 {
            continue;
        }
        for c in &mut p[..3] {
            *c = ((u16::from(*c) * 255 + a / 2) / a).min(255) as u8;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use media_wire::image::ImageFailure;

    fn of(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut out = ((8 + body.len()) as u32).to_be_bytes().to_vec();
        out.extend(kind);
        out.extend(body);
        out
    }

    #[test]
    fn heif_is_known_by_its_major_brand() {
        assert!(sniff(&of(b"ftyp", b"heic\0\0\0\0mif1")));
        assert!(sniff(&of(b"ftyp", b"mif1\0\0\0\0heic")));
        assert!(!sniff(&of(b"ftyp", b"avif\0\0\0\0mif1")));
        assert!(!sniff(&of(b"ftyp", b"isom\0\0\0\0mp41")));
    }

    #[test]
    fn a_heif_cut_inside_a_box_or_without_its_metadata_is_truncated() {
        let file = [of(b"ftyp", b"heic\0\0\0\0mif1"), of(b"meta", &[0; 32])].concat();
        assert_eq!(whole(&file), Ok(()));
        let cut = &file[..file.len() - 1];
        assert_eq!(
            whole(cut).err().map(|f| f.reason),
            Some(ImageFailure::Truncated)
        );
        let no_meta = of(b"ftyp", b"heic\0\0\0\0mif1");
        assert_eq!(
            header(&no_meta).err().map(|f| f.reason),
            Some(ImageFailure::Truncated)
        );
    }

    #[test]
    fn premultiplied_pixels_come_back_straight() {
        let mut pixels = [64, 32, 0, 128, 10, 20, 30, 255, 0, 0, 0, 0];
        unpremultiply(&mut pixels);
        assert_eq!(pixels, [128, 64, 0, 128, 10, 20, 30, 255, 0, 0, 0, 0]);
    }

    /// The fixture the attachments' tests share: a 320 × 240 picture `sips` made.
    fn fixture() -> Option<Vec<u8>> {
        std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../vectors/image/inputs/colours-320x240.heic"
        ))
        .ok()
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn a_heic_decodes_through_imageio_at_its_header_size() -> std::result::Result<(), String> {
        let bytes = fixture().ok_or("the HEIC fixture is missing")?;
        assert_eq!(header(&bytes).map_err(|f| f.message.clone())?, (320, 240, 1));
        let (raster, orientation) = decode(&bytes, 1 << 20).map_err(|f| f.message)?;
        assert_eq!((raster.width, raster.height, orientation), (320, 240, 1));
        assert!(raster.data.chunks_exact(4).any(|p| p[..3] != [0, 0, 0]));
        assert_eq!(
            decode(&bytes, 1000).err().map(|f| f.reason),
            Some(ImageFailure::TooLarge)
        );
        Ok(())
    }

    #[test]
    #[cfg(windows)]
    fn a_heic_decodes_through_wic_or_is_unsupported_without_its_extension()
    -> std::result::Result<(), String> {
        let bytes = fixture().ok_or("the HEIC fixture is missing")?;
        match header(&bytes) {
            Ok(size) => {
                assert_eq!(size, (320, 240, 1));
                let (raster, _) = decode(&bytes, 1 << 20).map_err(|f| f.message)?;
                assert_eq!((raster.width, raster.height), (320, 240));
            }
            Err(failed) => assert_eq!(failed.reason, ImageFailure::Unsupported),
        }
        Ok(())
    }

    #[test]
    #[cfg(not(any(target_os = "macos", windows)))]
    fn a_heic_is_unsupported_without_a_system_decoder() -> std::result::Result<(), String> {
        let bytes = fixture().ok_or("the HEIC fixture is missing")?;
        assert_eq!(
            header(&bytes).err().map(|f| f.reason),
            Some(ImageFailure::Unsupported)
        );
        Ok(())
    }
}
