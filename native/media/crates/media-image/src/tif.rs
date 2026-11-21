// SPDX-License-Identifier: Apache-2.0
//! TIFF (the first image: gray, RGB, CMYK, each with or without alpha, at 8 or 16 bits; none,
//! LZW, Deflate, PackBits or JPEG compression), through the `tiff` crate. The first directory
//! says where every strip or tile is, so a file cut short is refused from it before any pixel
//! is decoded.
use crate::error::{Failed, Result};
use crate::limits::{MAX_DECODE_BYTES, check_input};
use crate::raster::Raster;
use std::io::Cursor;
use tiff::decoder::{Decoder, DecodingResult, Limits};
use tiff::tags::Tag;
use tiff::{ColorType, TiffError};

fn failed(error: TiffError) -> Failed {
    match error {
        TiffError::IoError(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
            Failed::truncated("TIFF")
        }
        TiffError::LimitsExceeded | TiffError::IntSizeError => {
            Failed::too_large("The TIFF needs more memory than ace allows.")
        }
        TiffError::UnsupportedError(e) => Failed::new(
            crate::ImageFailure::Unsupported,
            format!("The TIFF uses something ace doesn't draw: {e}."),
        ),
        other => Failed::decode("TIFF", other),
    }
}

fn unsupported(what: &str) -> Failed {
    Failed::new(
        crate::ImageFailure::Unsupported,
        format!("The TIFF's pixels are {what}, which ace doesn't draw."),
    )
}

fn reader(bytes: &[u8]) -> Result<Decoder<Cursor<&[u8]>>> {
    let mut limits = Limits::default();
    limits.decoding_buffer_size = MAX_DECODE_BYTES;
    limits.intermediate_buffer_size = MAX_DECODE_BYTES;
    Ok(Decoder::new(Cursor::new(bytes))
        .map_err(failed)?
        .with_limits(limits))
}

/// The first image's size and EXIF-style orientation, its pixel layout, and that every strip
/// or tile it names lies inside the file.
struct Header {
    width: u32,
    height: u32,
    orientation: u8,
    color: ColorType,
    /// Alpha stored premultiplied (`ExtraSamples` 1, associated).
    premultiplied: bool,
}

fn read_header(decoder: &mut Decoder<Cursor<&[u8]>>, length: u64) -> Result<Header> {
    let (width, height) = decoder.dimensions().map_err(failed)?;
    let color = decoder.colortype().map_err(failed)?;
    let planar = decoder
        .find_tag_unsigned::<u16>(Tag::PlanarConfiguration)
        .map_err(failed)?;
    if planar == Some(2) {
        return Err(unsupported("stored a plane at a time"));
    }
    let (offsets, counts) = if decoder
        .find_tag(Tag::TileOffsets)
        .map_err(failed)?
        .is_some()
    {
        (Tag::TileOffsets, Tag::TileByteCounts)
    } else {
        (Tag::StripOffsets, Tag::StripByteCounts)
    };
    let starts = decoder
        .find_tag_unsigned_vec::<u64>(offsets)
        .map_err(failed)?
        .unwrap_or_default();
    let sizes = decoder
        .find_tag_unsigned_vec::<u64>(counts)
        .map_err(failed)?
        .unwrap_or_default();
    if starts.is_empty() || starts.len() != sizes.len() {
        return Err(Failed::decode("TIFF", "its strips aren't listed"));
    }
    for (start, size) in starts.iter().zip(&sizes) {
        if start.checked_add(*size).is_none_or(|end| end > length) {
            return Err(Failed::truncated("TIFF"));
        }
    }
    let orientation = decoder
        .find_tag_unsigned::<u16>(Tag::Orientation)
        .map_err(failed)?
        .filter(|o| (1..=8).contains(o))
        .unwrap_or(1) as u8;
    let premultiplied = decoder
        .find_tag_unsigned_vec::<u16>(Tag::ExtraSamples)
        .map_err(failed)?
        .is_some_and(|extra| extra.first() == Some(&1));
    Ok(Header {
        width,
        height,
        orientation,
        color,
        premultiplied,
    })
}

/// The first image's stored size and orientation, from its directory alone.
pub fn header(bytes: &[u8]) -> Result<(u32, u32, u8)> {
    let mut decoder = reader(bytes)?;
    let h = read_header(&mut decoder, bytes.len() as u64)?;
    Ok((h.width, h.height, h.orientation))
}

/// Samples a pixel has, and whether the last is alpha, for the layouts ace draws.
fn samples(color: ColorType) -> Result<(usize, bool)> {
    match color {
        ColorType::Gray(8 | 16) => Ok((1, false)),
        ColorType::GrayA(8 | 16) => Ok((2, true)),
        ColorType::RGB(8 | 16) => Ok((3, false)),
        ColorType::RGBA(8 | 16) => Ok((4, true)),
        ColorType::CMYK(8 | 16) => Ok((4, false)),
        ColorType::CMYKA(8 | 16) => Ok((5, true)),
        other => Err(unsupported(&format!("{other:?}"))),
    }
}

/// One pixel's samples (each 0 to 255) as RGBA.
fn rgba(p: &[u8], samples: usize, alpha: bool) -> [u8; 4] {
    let a = if alpha { p[samples - 1] } else { 255 };
    match (samples, alpha) {
        (1, _) | (2, true) => [p[0], p[0], p[0], a],
        (3, false) | (4, true) => [p[0], p[1], p[2], a],
        // CMYK, with K applied to each ink: a plain conversion, not a colour-managed one.
        _ => {
            let k = 255 - u16::from(p[3]);
            let ink = |c: u8| ((255 - u16::from(c)) * k / 255) as u8;
            [ink(p[0]), ink(p[1]), ink(p[2]), a]
        }
    }
}

/// The first image as RGBA. Its samples come out of the decoder in one buffer, which is turned
/// into RGBA a pixel at a time.
pub fn decode(bytes: &[u8], max_pixels: u32) -> Result<(Raster, u8)> {
    let mut decoder = reader(bytes)?;
    let h = read_header(&mut decoder, bytes.len() as u64)?;
    check_input(h.width, h.height, max_pixels)?;
    let (samples, alpha) = samples(h.color)?;
    let pixels = h.width as usize * h.height as usize;
    let mut out = vec![0u8; pixels * 4];
    let mut pixel = [0u8; 5];
    match decoder.read_image().map_err(failed)? {
        DecodingResult::U8(data) => {
            if data.len() < pixels * samples {
                return Err(Failed::truncated("TIFF"));
            }
            for (to, from) in out.chunks_exact_mut(4).zip(data.chunks_exact(samples)) {
                to.copy_from_slice(&rgba(from, samples, alpha));
            }
        }
        DecodingResult::U16(data) => {
            if data.len() < pixels * samples {
                return Err(Failed::truncated("TIFF"));
            }
            for (to, from) in out.chunks_exact_mut(4).zip(data.chunks_exact(samples)) {
                for (s, v) in pixel.iter_mut().zip(from) {
                    *s = (v >> 8) as u8;
                }
                to.copy_from_slice(&rgba(&pixel[..samples], samples, alpha));
            }
        }
        _ => return Err(unsupported("not 8- or 16-bit integers")),
    }
    if alpha && h.premultiplied {
        crate::heif::unpremultiply(&mut out);
    }
    Ok((Raster::new(h.width, h.height, out)?, h.orientation))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use media_wire::image::ImageFailure;

    /// An uncompressed little-endian RGB TIFF of `width` × `height`, every pixel `rgb`, in
    /// one strip, with `orientation`.
    pub fn tiff(width: u32, height: u32, rgb: [u8; 3], orientation: u16) -> Vec<u8> {
        let pixels: Vec<u8> = (0..width * height).flat_map(|_| rgb).collect();
        let entries: [(u16, u16, u32, u32); 10] = [
            (256, 4, 1, width),
            (257, 4, 1, height),
            (258, 3, 1, 8),
            (259, 3, 1, 1),
            (262, 3, 1, 2),
            (273, 4, 1, 0),
            (274, 3, 1, u32::from(orientation)),
            (277, 3, 1, 3),
            (278, 4, 1, height),
            (279, 4, 1, pixels.len() as u32),
        ];
        let ifd_len = 2 + entries.len() * 12 + 4;
        let data_at = (8 + ifd_len) as u32;
        let mut out = b"II*\0".to_vec();
        out.extend(8u32.to_le_bytes());
        out.extend((entries.len() as u16).to_le_bytes());
        for (tag, kind, count, value) in entries {
            out.extend(tag.to_le_bytes());
            out.extend(kind.to_le_bytes());
            out.extend(count.to_le_bytes());
            let value = if tag == 273 { data_at } else { value };
            if kind == 3 {
                out.extend((value as u16).to_le_bytes());
                out.extend([0, 0]);
            } else {
                out.extend(value.to_le_bytes());
            }
        }
        out.extend(0u32.to_le_bytes());
        out.extend(pixels);
        out
    }

    #[test]
    fn a_tiff_decodes_to_its_colour_with_its_orientation() -> std::result::Result<(), String> {
        let bytes = tiff(6, 4, [10, 120, 230], 6);
        assert_eq!(header(&bytes).map_err(|f| f.message.clone())?, (6, 4, 6));
        let (raster, orientation) = decode(&bytes, 100).map_err(|f| f.message)?;
        assert_eq!((raster.width, raster.height, orientation), (6, 4, 6));
        assert_eq!(&raster.data[..4], &[10, 120, 230, 255]);
        Ok(())
    }

    #[test]
    fn a_tiff_cut_short_is_refused_from_its_directory() {
        let bytes = tiff(6, 4, [1, 2, 3], 1);
        let cut = &bytes[..bytes.len() - 1];
        assert_eq!(header(cut).err().map(|f| f.reason), Some(ImageFailure::Truncated));
        assert_eq!(
            decode(cut, 100).err().map(|f| f.reason),
            Some(ImageFailure::Truncated)
        );
    }

    #[test]
    fn a_tiff_past_the_jobs_pixels_is_refused_before_decoding() {
        let bytes = tiff(20, 20, [1, 2, 3], 1);
        assert_eq!(
            decode(&bytes, 100).err().map(|f| f.reason),
            Some(ImageFailure::TooLarge)
        );
    }

    #[test]
    fn cmyk_inks_are_drawn_as_rgb() {
        assert_eq!(rgba(&[0, 255, 255, 0], 4, false), [255, 0, 0, 255]);
        assert_eq!(rgba(&[0, 0, 0, 255], 4, false), [0, 0, 0, 255]);
    }
}
