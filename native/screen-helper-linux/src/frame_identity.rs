//! Identity of what a packed PipeWire frame shows: its visible region (the producer's crop) and
//! that region's pixels. Row padding and pixels outside the region are not content.
#[derive(Default)]
pub struct FrameIdentity {
    pixels: Vec<u8>,
    /// The region (left, top, width, height) and pixel format last seen.
    geometry: Option<((u32, u32, u32, u32), u32)>,
}
impl FrameIdentity {
    /// Whether the region `(left, top, width, height)` of a `stride`-byte-row buffer differs
    /// from the last one seen; remembers it if so.
    pub fn update(
        &mut self,
        source: &[u8],
        stride: usize,
        format: u32,
        region: (u32, u32, u32, u32),
    ) -> bool {
        let (left, top, width, height) = region;
        let row = width as usize * 4;
        let size = row * height as usize;
        let line = |y: usize| {
            let start = (top as usize + y) * stride + left as usize * 4;
            &source[start..start + row]
        };
        let changed = self.geometry != Some((region, format))
            || self.pixels.len() != size
            || (0..height as usize).any(|y| self.pixels[y * row..(y + 1) * row] != *line(y));
        if changed {
            self.geometry = Some((region, format));
            self.pixels.resize(size, 0);
            for y in 0..height as usize {
                self.pixels[y * row..(y + 1) * row].copy_from_slice(line(y));
            }
        }
        changed
    }
}
