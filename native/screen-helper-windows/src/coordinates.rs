use crate::errors::{Code, Error, Result};
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}
#[derive(Debug, Clone, Copy)]
pub struct Mapping {
    pub target: Bounds,
    pub desktop: Bounds,
    pub dpi: u32,
}
impl Mapping {
    pub fn physical(&self, x: f64, y: f64) -> Result<(i32, i32)> {
        let scale = self.dpi as f64 / 96.0;
        if !x.is_finite()
            || !y.is_finite()
            || self.dpi == 0
            || !self.target.x.is_finite()
            || !self.target.y.is_finite()
            || !self.target.w.is_finite()
            || !self.target.h.is_finite()
            || self.target.w <= 0.0
            || self.target.h <= 0.0
            || x < 0.0
            || y < 0.0
            || x * scale >= self.target.w
            || y * scale >= self.target.h
        {
            return Err(Error::new(Code::Bounds, "Point outside target"));
        }
        Ok((
            (self.target.x + x * scale)
                .round()
                .min(self.target.x + self.target.w - 1.0) as i32,
            (self.target.y + y * scale)
                .round()
                .min(self.target.y + self.target.h - 1.0) as i32,
        ))
    }
    pub fn absolute(&self, x: f64, y: f64) -> Result<(i32, i32)> {
        let (px, py) = self.physical(x, y)?;
        if self.desktop.w <= 1.0 || self.desktop.h <= 1.0 {
            return Err(Error::new(Code::Bounds, "Invalid desktop"));
        }
        let nx = px as f64 - self.desktop.x;
        let ny = py as f64 - self.desktop.y;
        if nx < 0.0 || ny < 0.0 || nx >= self.desktop.w || ny >= self.desktop.h {
            return Err(Error::new(Code::Bounds, "Point outside virtual desktop"));
        }
        Ok((
            (nx * 65535.0 / (self.desktop.w - 1.0)).round() as i32,
            (ny * 65535.0 / (self.desktop.h - 1.0)).round() as i32,
        ))
    }
}
pub fn output_size(width: u32, height: u32) -> Result<(u32, u32)> {
    if width == 0 || height == 0 || width > 32768 || height > 32768 {
        return Err(Error::new(Code::Bounds, "Invalid capture size"));
    }
    let scale = (3840.0 / width as f64).min(2160.0 / height as f64).min(1.0);
    Ok((
        (width as f64 * scale).floor().max(1.0) as u32,
        (height as f64 * scale).floor().max(1.0) as u32,
    ))
}
