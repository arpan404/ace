// SPDX-License-Identifier: Apache-2.0
//! Decoded pixels: straight (not premultiplied) 8-bit RGBA, rows packed.
use crate::error::{Failed, Result};
use media_codec::Size;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Raster {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

impl Raster {
    pub fn new(width: u32, height: u32, data: Vec<u8>) -> Result<Self> {
        if width == 0 || height == 0 || data.len() != width as usize * height as usize * 4 {
            return Err(Failed::invalid(format!(
                "{} bytes are not {width} × {height} RGBA pixels.",
                data.len()
            )));
        }
        Ok(Self {
            width,
            height,
            data,
        })
    }

    /// A raster of one colour.
    pub fn filled(width: u32, height: u32, rgba: [u8; 4]) -> Self {
        let data = rgba.repeat(width as usize * height as usize);
        Self {
            width,
            height,
            data,
        }
    }

    pub fn opaque(&self) -> bool {
        self.data.chunks_exact(4).all(|p| p[3] == 255)
    }

    pub fn alpha(&self) -> Vec<u8> {
        self.data.chunks_exact(4).map(|p| p[3]).collect()
    }

    /// Turned upright from an EXIF orientation (1 to 8; anything else is upright already).
    pub fn orient(self, orientation: u8) -> Self {
        if !(2..=8).contains(&orientation) {
            return self;
        }
        let (w, h) = (self.width as usize, self.height as usize);
        let swap = orientation >= 5;
        let (ow, oh) = if swap { (h, w) } else { (w, h) };
        let mut data = vec![0; self.data.len()];
        for dy in 0..oh {
            for dx in 0..ow {
                let (sx, sy) = match orientation {
                    2 => (w - 1 - dx, dy),
                    3 => (w - 1 - dx, h - 1 - dy),
                    4 => (dx, h - 1 - dy),
                    5 => (dy, dx),
                    6 => (dy, h - 1 - dx),
                    7 => (w - 1 - dy, h - 1 - dx),
                    _ => (w - 1 - dy, dx),
                };
                let from = (sy * w + sx) * 4;
                let to = (dy * ow + dx) * 4;
                data[to..to + 4].copy_from_slice(&self.data[from..from + 4]);
            }
        }
        Self {
            width: ow as u32,
            height: oh as u32,
            data,
        }
    }

    /// Resampled to exactly `width` × `height`. Colour is weighted by alpha while it is
    /// filtered, so transparent pixels never bleed their colour into an edge. The source's own
    /// buffer is premultiplied in place: only the (smaller) output is allocated.
    pub fn resize(mut self, width: u32, height: u32) -> Result<Self> {
        if (width, height) == (self.width, self.height) {
            return Ok(self);
        }
        let opaque = self.opaque();
        if !opaque {
            premultiply(&mut self.data);
        }
        let mut data = media_codec::resample_rgba(
            &self.data,
            Size {
                width: self.width,
                height: self.height,
            },
            Size { width, height },
        )
        .map_err(|e| Failed::invalid(format!("The image could not be scaled: {e}")))?;
        drop(self);
        if !opaque {
            unpremultiply(&mut data);
        }
        Self::new(width, height, data)
    }

    /// Alpha flattened over `background`: RGB, 3 bytes a pixel.
    pub fn flatten(&self, background: [u8; 3]) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.data.len() / 4 * 3);
        for p in self.data.chunks_exact(4) {
            let a = u32::from(p[3]);
            for c in 0..3 {
                let v = (u32::from(p[c]) * a + u32::from(background[c]) * (255 - a) + 127) / 255;
                out.push(v as u8);
            }
        }
        out
    }
}

pub fn premultiply(data: &mut [u8]) {
    for p in data.chunks_exact_mut(4) {
        let a = u32::from(p[3]);
        for c in &mut p[..3] {
            *c = ((u32::from(*c) * a + 127) / 255) as u8;
        }
    }
}

pub fn unpremultiply(data: &mut [u8]) {
    for p in data.chunks_exact_mut(4) {
        let a = u32::from(p[3]);
        if a == 0 {
            p[..3].fill(0);
        } else if a < 255 {
            for c in &mut p[..3] {
                *c = ((u32::from(*c) * 255 + a / 2) / a).min(255) as u8;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 3 × 2 picture whose pixels are numbered 0 to 5 in the red channel.
    fn numbered() -> Raster {
        let data = (0..6u8).flat_map(|n| [n, 0, 0, 255]).collect();
        Raster::new(3, 2, data).unwrap_or_else(|_| Raster::filled(1, 1, [0; 4]))
    }
    fn reds(r: &Raster) -> Vec<u8> {
        r.data.chunks_exact(4).map(|p| p[0]).collect()
    }

    #[test]
    fn every_exif_orientation_turns_upright() {
        // 0 1 2
        // 3 4 5
        assert_eq!(reds(&numbered().orient(1)), [0, 1, 2, 3, 4, 5]);
        assert_eq!(reds(&numbered().orient(2)), [2, 1, 0, 5, 4, 3]);
        assert_eq!(reds(&numbered().orient(3)), [5, 4, 3, 2, 1, 0]);
        assert_eq!(reds(&numbered().orient(4)), [3, 4, 5, 0, 1, 2]);
        let six = numbered().orient(6);
        assert_eq!((six.width, six.height), (2, 3));
        assert_eq!(reds(&six), [3, 0, 4, 1, 5, 2]);
        assert_eq!(reds(&numbered().orient(8)), [2, 5, 1, 4, 0, 3]);
        assert_eq!(reds(&numbered().orient(5)), [0, 3, 1, 4, 2, 5]);
        assert_eq!(reds(&numbered().orient(7)), [5, 2, 4, 1, 3, 0]);
    }

    #[test]
    fn a_transparent_edge_keeps_its_colour_when_scaled() {
        // Opaque red beside fully transparent green: the green must not tint the red.
        let mut data = Vec::new();
        for x in 0..8 {
            data.extend_from_slice(if x < 4 {
                &[255, 0, 0, 255]
            } else {
                &[0, 255, 0, 0]
            });
        }
        let row =
            Raster::new(8, 1, data.repeat(1)).unwrap_or_else(|_| Raster::filled(1, 1, [0; 4]));
        let scaled = row
            .resize(3, 1)
            .unwrap_or_else(|_| Raster::filled(1, 1, [0; 4]));
        let middle = &scaled.data[4..8];
        assert!(middle[3] > 0 && middle[3] < 255, "{middle:?}");
        assert_eq!(middle[1], 0, "green bled into the edge: {middle:?}");
    }

    #[test]
    fn flattening_blends_over_the_background() {
        let half = Raster::filled(1, 1, [255, 255, 255, 128]);
        assert_eq!(half.flatten([0, 0, 0]), [128, 128, 128]);
    }
}
