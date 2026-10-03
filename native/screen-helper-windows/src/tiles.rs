use crate::{
    coordinates::Bounds,
    errors::{Code, Error, Result},
};
#[derive(Default)]
pub struct Tiles {
    width: u32,
    height: u32,
    hashes: Vec<u64>,
}
impl Tiles {
    pub fn changed(&mut self, rgb: &[u8], width: u32, height: u32) -> Result<Vec<Bounds>> {
        if width == 0
            || width > 3840
            || height == 0
            || height > 2160
            || rgb.len() != width as usize * height as usize * 3
        {
            return Err(Error::new(Code::Bounds, "Invalid tile buffer"));
        }
        let resized = self.width != width || self.height != height;
        let cols = width.div_ceil(64);
        let rows = height.div_ceil(64);
        if resized {
            self.hashes = vec![0; (cols * rows) as usize];
            self.width = width;
            self.height = height;
        }
        let mut changed = Vec::new();
        for ty in 0..rows {
            for tx in 0..cols {
                let x = tx * 64;
                let y = ty * 64;
                let w = 64.min(width - x);
                let h = 64.min(height - y);
                let mut hasher = xxhash_rust::xxh3::Xxh3::new();
                for row in y..y + h {
                    let start = (row as usize * width as usize + x as usize) * 3;
                    hasher.update(&rgb[start..start + w as usize * 3]);
                }
                let hash = hasher.digest();
                let index = (ty * cols + tx) as usize;
                if resized || self.hashes[index] != hash {
                    changed.push(Bounds {
                        x: x as f64,
                        y: y as f64,
                        w: w as f64,
                        h: h as f64,
                    });
                }
                self.hashes[index] = hash;
            }
        }
        // Bound wire metadata even when every tile changes.
        if changed.len() > 32 {
            Ok(vec![Bounds {
                x: 0.0,
                y: 0.0,
                w: width as f64,
                h: height as f64,
            }])
        } else {
            Ok(changed)
        }
    }
}
