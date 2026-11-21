// SPDX-License-Identifier: Apache-2.0
//! Layers drawn in order on a canvas, source over (Porter–Duff), in premultiplied alpha.
use crate::decode::{Decoded, Target, decode};
use crate::error::{Failed, Result};
use crate::limits::check_output;
use crate::raster::{Raster, premultiply, unpremultiply};
use crate::{Input, fit, font};
use media_wire::image::{Layer, LayerFit, SourceFormat};

pub struct Canvas {
    width: u32,
    height: u32,
    /// Premultiplied RGBA.
    data: Vec<u8>,
}

impl Canvas {
    pub fn new(width: u32, height: u32, background: [u8; 4], max_pixels: u32) -> Result<Self> {
        check_output(width, height)?;
        if u64::from(width) * u64::from(height) > u64::from(max_pixels) {
            return Err(Failed::too_large(format!(
                "A {width} × {height} canvas is more than the {max_pixels} pixels allowed."
            )));
        }
        let mut data = Raster::filled(width, height, background).data;
        premultiply(&mut data);
        Ok(Self {
            width,
            height,
            data,
        })
    }

    /// `pixel` (premultiplied) over the canvas at (x, y), if it is on the canvas.
    fn blend(&mut self, x: i64, y: i64, pixel: [u8; 4]) {
        if x < 0 || y < 0 || x >= i64::from(self.width) || y >= i64::from(self.height) {
            return;
        }
        let at = (y as usize * self.width as usize + x as usize) * 4;
        let keep = 255 - u32::from(pixel[3]);
        for (below, above) in self.data[at..at + 4].iter_mut().zip(pixel) {
            *below = (u32::from(above) + (u32::from(*below) * keep + 127) / 255).min(255) as u8;
        }
    }

    /// A straight-alpha raster with its top left at (left, top).
    fn draw(&mut self, raster: &Raster, left: i64, top: i64) {
        for y in 0..raster.height as usize {
            for x in 0..raster.width as usize {
                let at = (y * raster.width as usize + x) * 4;
                let mut p = [0; 4];
                p.copy_from_slice(&raster.data[at..at + 4]);
                premultiply(&mut p);
                if p[3] > 0 {
                    self.blend(left + x as i64, top + y as i64, p);
                }
            }
        }
    }

    pub fn layer(&mut self, inputs: &[Input], layer: &Layer, max_pixels: u32) -> Result<()> {
        match layer {
            Layer::Image {
                input,
                left,
                top,
                width,
                height,
                fit,
                mask,
            } => {
                check_output(*width, *height)?;
                let natural = decode(nth(inputs, *input)?, Target::Natural, max_pixels)?;
                // What the input fills: the whole box, or its shape fitted inside it.
                let (w, h, dx, dy) = match fit {
                    LayerFit::Fill => (*width, *height, 0, 0),
                    LayerFit::Contain => {
                        let r = &natural.raster;
                        let (w, h) = fit::inside(r.width, r.height, *width, *height, true);
                        (w, h, (*width - w) / 2, (*height - h) / 2)
                    }
                };
                let mut raster = drawn(nth(inputs, *input)?, natural, w, h, max_pixels)?;
                if let Some(mask) = mask {
                    let source = nth(inputs, *mask)?;
                    let natural = decode(source, Target::Natural, max_pixels)?;
                    let mask = drawn(source, natural, w, h, max_pixels)?;
                    for (p, m) in raster
                        .data
                        .chunks_exact_mut(4)
                        .zip(mask.data.chunks_exact(4))
                    {
                        p[3] = ((u32::from(p[3]) * u32::from(m[3]) + 127) / 255) as u8;
                    }
                }
                self.draw(
                    &raster,
                    i64::from(*left) + i64::from(dx),
                    i64::from(*top) + i64::from(dy),
                );
            }
            Layer::Text {
                text,
                left,
                top,
                size,
                color,
            } => {
                let mut p = *color;
                premultiply(&mut p);
                for (x, y) in font::coverage(text, *size) {
                    self.blend(
                        i64::from(*left) + i64::from(x),
                        i64::from(*top) + i64::from(y),
                        p,
                    );
                }
            }
        }
        Ok(())
    }

    pub fn finish(self) -> Result<Raster> {
        let mut data = self.data;
        unpremultiply(&mut data);
        Raster::new(self.width, self.height, data)
    }
}

fn nth<'a, 'b>(inputs: &'a [Input<'b>], index: u32) -> Result<&'a Input<'b>> {
    inputs.get(index as usize).ok_or_else(|| {
        Failed::invalid(format!(
            "Layer input {index} isn't one of the job's inputs."
        ))
    })
}

/// An input at exactly `width` × `height`: a vector drawn there, a raster scaled to it.
fn drawn(
    input: &Input,
    natural: Decoded,
    width: u32,
    height: u32,
    max_pixels: u32,
) -> Result<Raster> {
    if natural.source.format == SourceFormat::Svg {
        return Ok(decode(input, Target::Exact { width, height }, max_pixels)?.raster);
    }
    natural.raster.resize(width, height)
}
