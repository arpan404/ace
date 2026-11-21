// SPDX-License-Identifier: Apache-2.0
//! Windows icons: a directory of sizes, each an embedded PNG or a bitmap (a 24 or 32-bit
//! bottom-up DIB followed by a 1-bit transparency mask). Palette bitmaps are left out.
use crate::error::{Failed, Result};
use crate::raster::Raster;

const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

pub struct Entry<'a> {
    /// The size its own image says it is (an embedded PNG's IHDR, a bitmap's header), which
    /// must agree with the directory's.
    pub width: u32,
    pub height: u32,
    pub image: &'a [u8],
}

impl Entry<'_> {
    pub fn png(&self) -> bool {
        self.image.starts_with(PNG)
    }
}

fn u16_at(b: &[u8], at: usize) -> Option<u16> {
    b.get(at..at + 2).map(|s| u16::from_le_bytes([s[0], s[1]]))
}
fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    b.get(at..at + 4)
        .map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

/// An entry's own size, read from its header without decoding: an embedded PNG's IHDR, or a
/// bitmap's info header (its height counts the mask too).
fn embedded_size(image: &[u8]) -> Option<(u32, u32)> {
    if image.starts_with(PNG) {
        if image.get(12..16)? != b"IHDR" {
            return None;
        }
        let be = |at: usize| {
            image
                .get(at..at + 4)
                .map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
        };
        return Some((be(16)?, be(20)?));
    }
    let width = i32::from_le_bytes(image.get(4..8)?.try_into().ok()?);
    let height = i32::from_le_bytes(image.get(8..12)?.try_into().ok()?) / 2;
    (width > 0 && height > 0).then_some((width as u32, height as u32))
}

/// Whether an entry's own size is the one its directory gives (0 there means 256 or more).
fn agrees(directory: (u8, u8), embedded: (u32, u32)) -> bool {
    let side = |d: u8, e: u32| if d == 0 { e >= 256 } else { e == u32::from(d) };
    side(directory.0, embedded.0) && side(directory.1, embedded.1)
}

/// Entries in the order to try them for a picture `want` px wide: the largest that isn't
/// wider, then the smallest of those that are. An entry whose image disagrees with the
/// directory about its size is left out: it can't hide a larger picture behind a small entry.
pub fn entries(bytes: &[u8], want: u32) -> Result<Vec<Entry<'_>>> {
    let bad = || Failed::decode("ICO", "its directory is cut short");
    let count = usize::from(u16_at(bytes, 4).ok_or_else(bad)?);
    if count == 0 || count > 64 {
        return Err(Failed::decode("ICO", "its directory has no usable count"));
    }
    if bytes.len() < 6 + 16 * count {
        return Err(Failed::truncated("ICO"));
    }
    let mut entries = Vec::new();
    for index in 0..count {
        let at = 6 + 16 * index;
        let length = u32_at(bytes, at + 8).ok_or_else(bad)? as usize;
        let offset = u32_at(bytes, at + 12).ok_or_else(bad)? as usize;
        let Some(image) = bytes.get(offset..offset.saturating_add(length)) else {
            continue;
        };
        if length < 40 || offset < 6 + 16 * count {
            continue;
        }
        let Some((width, height)) = embedded_size(image) else {
            continue;
        };
        if !agrees((bytes[at], bytes[at + 1]), (width, height)) {
            continue;
        }
        entries.push(Entry {
            width,
            height,
            image,
        });
    }
    if entries.is_empty() {
        return Err(Failed::truncated("ICO"));
    }
    entries.sort_by_key(|e| {
        let fits = e.width <= want;
        (!fits, if fits { u32::MAX - e.width } else { e.width })
    });
    Ok(entries)
}

/// A bitmap entry as RGBA, or `None` for a layout ace doesn't draw.
pub fn bitmap(image: &[u8]) -> Option<Raster> {
    if u32_at(image, 0)? != 40 || u32_at(image, 16)? != 0 {
        return None;
    }
    let width = i32::from_le_bytes(image.get(4..8)?.try_into().ok()?);
    let height = i32::from_le_bytes(image.get(8..12)?.try_into().ok()?) / 2;
    let bits = u16_at(image, 14)?;
    if !(1..=256).contains(&width) || height != width || !matches!(bits, 24 | 32) {
        return None;
    }
    let (w, h) = (width as usize, height as usize);
    let stride = (w * usize::from(bits)).div_ceil(32) * 4;
    let mask_stride = w.div_ceil(32) * 4;
    let mask = 40 + stride * h;
    let pixels = image.get(40..mask)?;
    let mut data = vec![0; w * h * 4];
    let step = usize::from(bits / 8);
    let mut any_alpha = false;
    for y in 0..h {
        let row = &pixels[stride * (h - 1 - y)..];
        for x in 0..w {
            let p = &row[x * step..];
            let to = (y * w + x) * 4;
            let alpha = if bits == 32 { p[3] } else { 255 };
            any_alpha |= bits == 32 && alpha != 0;
            data[to..to + 4].copy_from_slice(&[p[2], p[1], p[0], alpha]);
        }
    }
    // 24-bit bitmaps, and 32-bit ones whose alpha is all zero, take transparency from the mask.
    if bits == 24 || !any_alpha {
        if let Some(mask) = image.get(mask..mask + mask_stride * h) {
            for y in 0..h {
                let row = &mask[mask_stride * (h - 1 - y)..];
                for x in 0..w {
                    let clear = (row[x >> 3] >> (7 - (x & 7))) & 1 == 1;
                    data[(y * w + x) * 4 + 3] = if clear { 0 } else { 255 };
                }
            }
        }
    }
    Raster::new(w as u32, h as u32, data).ok()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// An ICO whose entries are `(directory size, image)`.
    pub(crate) fn ico(entries: &[(u8, Vec<u8>)]) -> Vec<u8> {
        let mut out = vec![0, 0, 1, 0];
        out.extend((entries.len() as u16).to_le_bytes());
        let mut offset = 6 + 16 * entries.len();
        for (size, image) in entries {
            out.extend([*size, *size, 0, 0, 1, 0, 32, 0]);
            out.extend((image.len() as u32).to_le_bytes());
            out.extend((offset as u32).to_le_bytes());
            offset += image.len();
        }
        for (_, image) in entries {
            out.extend(image);
        }
        out
    }
    /// A PNG's signature and IHDR saying `width` × `height`, padded past 40 bytes; no pixels.
    pub(crate) fn png_header(width: u32, height: u32) -> Vec<u8> {
        let mut png = PNG.to_vec();
        png.extend(13u32.to_be_bytes());
        png.extend(b"IHDR");
        png.extend(width.to_be_bytes());
        png.extend(height.to_be_bytes());
        png.extend([8, 6, 0, 0, 0, 0, 0, 0, 0]);
        png.resize(64, 0);
        png
    }

    #[test]
    fn an_entry_whose_image_disagrees_with_its_directory_is_left_out() -> Result<()> {
        // A 16 px entry hiding a 4000 px PNG, beside an honest 48 px one.
        let bytes = ico(&[(16, png_header(4000, 4000)), (48, png_header(48, 48))]);
        let found = entries(&bytes, 16)?;
        assert_eq!(
            found
                .iter()
                .map(|e| (e.width, e.height))
                .collect::<Vec<_>>(),
            [(48, 48)]
        );
        // A large PNG listed as 256 (0) is what it says.
        let big = ico(&[(0, png_header(512, 512))]);
        assert_eq!(entries(&big, 64)?.first().map(|e| e.width), Some(512));
        Ok(())
    }
}
