// SPDX-License-Identifier: Apache-2.0
//! BMP (Windows bitmaps: 1 to 32 bits a pixel, palettes, bit fields and RLE), through
//! `zune-bmp`. The file and info headers say where the pixels are and how many bytes they take,
//! so a file cut short is refused from its header, before anything is decoded.
use crate::error::{Failed, Result};
use crate::limits::check_input;
use crate::raster::Raster;
use zune_bmp::{BmpDecoder, BmpDecoderErrors};
use zune_core::bytestream::ZCursor;
use zune_core::colorspace::ColorSpace;
use zune_core::options::DecoderOptions;

fn failed(error: BmpDecoderErrors) -> Failed {
    match error {
        BmpDecoderErrors::IoErrors(_) => Failed::truncated("BMP"),
        BmpDecoderErrors::TooLargeDimensions(..) => {
            Failed::too_large("The BMP is too large to decode.")
        }
        other => Failed::decode("BMP", format!("{other:?}").trim()),
    }
}

fn u16_at(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?))
}

fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

/// What the headers say: the stored size, and the bytes the pixels need from the file's start.
struct Layout {
    width: u32,
    height: u32,
    end: u64,
}

/// The file and info headers (core, v3, v4, v5), read without decoding anything.
fn layout(bytes: &[u8]) -> Result<Layout> {
    let cut = || Failed::truncated("BMP");
    let offset = u32_at(bytes, 10).ok_or_else(cut)?;
    let info = u32_at(bytes, 14).ok_or_else(cut)?;
    if bytes.len() < 14 + info as usize {
        return Err(cut());
    }
    let (width, height, bits, compression, image_size) = if info == 12 {
        let w = u16_at(bytes, 18).ok_or_else(cut)?;
        let h = u16_at(bytes, 20).ok_or_else(cut)?;
        let bits = u16_at(bytes, 24).ok_or_else(cut)?;
        (u32::from(w), u32::from(h), bits, 0, 0)
    } else if info >= 40 {
        let w = u32_at(bytes, 18).ok_or_else(cut)? as i32;
        let h = u32_at(bytes, 22).ok_or_else(cut)? as i32;
        let bits = u16_at(bytes, 28).ok_or_else(cut)?;
        let compression = u32_at(bytes, 30).ok_or_else(cut)?;
        let image_size = u32_at(bytes, 34).ok_or_else(cut)?;
        if w <= 0 {
            return Err(Failed::decode("BMP", "its width isn't positive"));
        }
        (w.unsigned_abs(), h.unsigned_abs(), bits, compression, image_size)
    } else {
        return Err(Failed::decode("BMP", "its info header has an unknown size"));
    };
    let end = match compression {
        // Uncompressed rows (with or without bit fields) are padded to four bytes.
        0 | 3 | 6 => {
            let stride = (u64::from(width) * u64::from(bits)).div_ceil(32) * 4;
            u64::from(offset) + stride * u64::from(height)
        }
        // Run-length data says its own length in the info header.
        1 | 2 => {
            if image_size == 0 {
                return Err(Failed::decode(
                    "BMP",
                    "its run-length data doesn't say how long it is",
                ));
            }
            u64::from(offset) + u64::from(image_size)
        }
        _ => {
            return Err(Failed::new(
                crate::ImageFailure::Unsupported,
                "The BMP holds JPEG, PNG or another compression ace doesn't draw.",
            ));
        }
    };
    Ok(Layout { width, height, end })
}

/// The stored size, once the headers say every pixel byte is in the file.
pub fn header(bytes: &[u8]) -> Result<(u32, u32)> {
    let layout = layout(bytes)?;
    if (bytes.len() as u64) < layout.end {
        return Err(Failed::truncated("BMP"));
    }
    Ok((layout.width, layout.height))
}

/// The bitmap as RGBA, decoded into the one buffer it ends in.
pub fn decode(bytes: &[u8], max_pixels: u32) -> Result<Raster> {
    let (width, height) = header(bytes)?;
    check_input(width, height, max_pixels)?;
    let options = DecoderOptions::default()
        .set_max_width(width as usize)
        .set_max_height(height as usize);
    let mut decoder = BmpDecoder::new_with_options(ZCursor::new(bytes), options);
    decoder.decode_headers().map_err(failed)?;
    if decoder.dimensions() != Some((width as usize, height as usize)) {
        return Err(Failed::decode("BMP", "its decoder reads another size"));
    }
    let channels = match decoder.colorspace() {
        Some(ColorSpace::RGBA) => 4,
        Some(ColorSpace::RGB) => 3,
        Some(ColorSpace::Luma) => 1,
        other => {
            return Err(Failed::decode("BMP", format!("{other:?} pixels")));
        }
    };
    let pixels = width as usize * height as usize;
    let size = decoder
        .output_buf_size()
        .ok_or_else(|| Failed::too_large("The BMP is too large to decode."))?;
    if size != pixels * channels {
        return Err(Failed::decode("BMP", "its pixels don't match its size"));
    }
    let mut buffer = vec![0; pixels * 4];
    decoder.decode_into(&mut buffer[..size]).map_err(failed)?;
    if channels != 4 {
        crate::png::widen_channels(&mut buffer, pixels, channels);
    }
    Raster::new(width, height, buffer)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use media_wire::image::ImageFailure;

    /// A bottom-up 24-bit BMP of `width` × `height`, every pixel `rgb`.
    pub fn bmp(width: u32, height: u32, rgb: [u8; 3]) -> Vec<u8> {
        let stride = (width * 3).div_ceil(4) * 4;
        let size = 54 + stride * height;
        let mut out = b"BM".to_vec();
        out.extend(size.to_le_bytes());
        out.extend([0; 4]);
        out.extend(54u32.to_le_bytes());
        out.extend(40u32.to_le_bytes());
        out.extend((width as i32).to_le_bytes());
        out.extend((height as i32).to_le_bytes());
        out.extend(1u16.to_le_bytes());
        out.extend(24u16.to_le_bytes());
        out.extend([0; 24]);
        for _ in 0..height {
            let mut row: Vec<u8> = (0..width).flat_map(|_| [rgb[2], rgb[1], rgb[0]]).collect();
            row.resize(stride as usize, 0);
            out.extend(row);
        }
        out
    }

    #[test]
    fn a_bitmap_decodes_to_its_colour() -> std::result::Result<(), String> {
        let bytes = bmp(5, 3, [200, 40, 10]);
        assert_eq!(header(&bytes).map_err(|f| f.message.clone())?, (5, 3));
        let raster = decode(&bytes, 100).map_err(|f| f.message)?;
        assert_eq!((raster.width, raster.height), (5, 3));
        assert_eq!(&raster.data[..4], &[200, 40, 10, 255]);
        Ok(())
    }

    #[test]
    fn a_bitmap_cut_short_is_refused_from_its_header() {
        let bytes = bmp(5, 3, [1, 2, 3]);
        let cut = &bytes[..bytes.len() - 1];
        assert_eq!(header(cut).err().map(|f| f.reason), Some(ImageFailure::Truncated));
        assert_eq!(
            decode(cut, 100).err().map(|f| f.reason),
            Some(ImageFailure::Truncated)
        );
        assert_eq!(
            header(&bytes[..20]).err().map(|f| f.reason),
            Some(ImageFailure::Truncated)
        );
    }

    #[test]
    fn a_bitmap_past_the_jobs_pixels_is_refused_before_decoding() {
        let bytes = bmp(20, 20, [1, 2, 3]);
        assert_eq!(
            decode(&bytes, 100).err().map(|f| f.reason),
            Some(ImageFailure::TooLarge)
        );
    }
}
