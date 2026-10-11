//! Identity of a packed PipeWire frame; row padding is not pixel content.
#[derive(Default)]
pub struct FrameIdentity {
    pixels: Vec<u8>,
    geometry: Option<(u32, u32, u32)>,
}
impl FrameIdentity {
    pub fn update(
        &mut self,
        source: &[u8],
        width: u32,
        height: u32,
        stride: usize,
        format: u32,
    ) -> bool {
        let row = width as usize * 4;
        let size = row * height as usize;
        let changed = self.geometry != Some((width, height, format))
            || self.pixels.len() != size
            || (0..height as usize).any(|y| {
                self.pixels[y * row..(y + 1) * row] != source[y * stride..y * stride + row]
            });
        if changed {
            self.geometry = Some((width, height, format));
            self.pixels.resize(size, 0);
            for y in 0..height as usize {
                self.pixels[y * row..(y + 1) * row]
                    .copy_from_slice(&source[y * stride..y * stride + row]);
            }
        }
        changed
    }
}
