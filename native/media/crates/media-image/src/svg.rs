// SPDX-License-Identifier: Apache-2.0
//! Static SVG through resvg: no scripts, no text, no raster images and nothing outside the
//! document (every image reference resolves to nothing).
use crate::error::{Failed, Result};
use crate::limits::{SVG_MAX_BYTES, SVG_MAX_SIDE};
use crate::raster::{Raster, unpremultiply};
use resvg::{tiny_skia, usvg};

pub struct Svg {
    tree: usvg::Tree,
}

impl Svg {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > SVG_MAX_BYTES {
            return Err(Failed::too_large(format!(
                "The SVG is {} bytes, more than {SVG_MAX_BYTES}.",
                bytes.len()
            )));
        }
        let options = usvg::Options {
            image_href_resolver: usvg::ImageHrefResolver {
                resolve_data: Box::new(|_, _, _| None),
                resolve_string: Box::new(|_, _| None),
            },
            ..usvg::Options::default()
        };
        let tree = usvg::Tree::from_data(bytes, &options).map_err(|e| Failed::decode("SVG", e))?;
        Ok(Self { tree })
    }

    /// Its own size in user units.
    pub fn size(&self) -> (f64, f64) {
        let size = self.tree.size();
        (f64::from(size.width()), f64::from(size.height()))
    }

    /// The size it would be drawn at, `scale` pixels per unit, at least one pixel a side.
    pub fn pixels(&self, scale: f64) -> (u32, u32) {
        let (w, h) = self.size();
        (
            ((w * scale).round() as u32).max(1),
            ((h * scale).round() as u32).max(1),
        )
    }

    /// Drawn stretched to exactly `width` × `height`.
    pub fn render(&self, width: u32, height: u32) -> Result<Raster> {
        if width > SVG_MAX_SIDE || height > SVG_MAX_SIDE {
            return Err(Failed::too_large(format!(
                "An SVG drawn at {width} × {height} is past {SVG_MAX_SIDE} px a side."
            )));
        }
        let mut pixmap = tiny_skia::Pixmap::new(width, height)
            .ok_or_else(|| Failed::invalid("An SVG needs at least one pixel a side."))?;
        let (w, h) = self.size();
        let transform = tiny_skia::Transform::from_scale(
            (f64::from(width) / w) as f32,
            (f64::from(height) / h) as f32,
        );
        resvg::render(&self.tree, transform, &mut pixmap.as_mut());
        let mut data = pixmap.take();
        unpremultiply(&mut data);
        Raster::new(width, height, data)
    }
}
