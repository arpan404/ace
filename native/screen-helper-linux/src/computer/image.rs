//! Screenshot pixels: fitting to the model's image limits, downscaling, id tags and base64.
//! Pure, on packed RGB.
use crate::computer::outline::{Node, Rect};

pub const MAX_EDGE: u32 = 1568;
pub const MAX_PIXELS: u64 = 1_150_000;

pub struct Rgb {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

/// The output size: the long edge at most 1568 px and at most ~1.15 MP, never enlarged.
pub fn fit(width: u32, height: u32) -> (u32, u32) {
    if width == 0 || height == 0 {
        return (width, height);
    }
    let edge = f64::from(MAX_EDGE) / f64::from(width.max(height));
    let area = (MAX_PIXELS as f64 / (f64::from(width) * f64::from(height))).sqrt();
    let scale = edge.min(area).min(1.0);
    (
        ((f64::from(width) * scale).floor() as u32).max(1),
        ((f64::from(height) * scale).floor() as u32).max(1),
    )
}

/// Area-averaging downscale: every source pixel counts, so text stays legible.
pub fn downscale(image: &Rgb, width: u32, height: u32) -> Rgb {
    if (width, height) == (image.width, image.height) || width == 0 || height == 0 {
        return Rgb {
            width: image.width,
            height: image.height,
            pixels: image.pixels.clone(),
        };
    }
    let (sw, sh) = (image.width as usize, image.height as usize);
    let mut pixels = vec![0u8; width as usize * height as usize * 3];
    for oy in 0..height as usize {
        let y0 = oy * sh / height as usize;
        let y1 = ((oy + 1) * sh / height as usize).max(y0 + 1).min(sh);
        for ox in 0..width as usize {
            let x0 = ox * sw / width as usize;
            let x1 = ((ox + 1) * sw / width as usize).max(x0 + 1).min(sw);
            let mut sum = [0u32; 3];
            for y in y0..y1 {
                let row = &image.pixels[(y * sw + x0) * 3..(y * sw + x1) * 3];
                for px in row.chunks_exact(3) {
                    sum[0] += u32::from(px[0]);
                    sum[1] += u32::from(px[1]);
                    sum[2] += u32::from(px[2]);
                }
            }
            let count = ((y1 - y0) * (x1 - x0)) as u32;
            let at = (oy * width as usize + ox) * 3;
            for c in 0..3 {
                pixels[at + c] = (sum[c] / count) as u8;
            }
        }
    }
    Rgb { width, height, pixels }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Mark {
    pub id: u64,
    pub rect: Rect,
}

/// Elements worth tagging: actionable, a reasonable size, visible inside the window and every
/// scroll area around them. Frames are window pixels; marks are image pixels.
pub fn marks(nodes: &[Node], window: (f64, f64), scale: f64) -> Vec<Mark> {
    let whole = Rect {
        x: 0.0,
        y: 0.0,
        w: window.0,
        h: window.1,
    };
    let window_area = window.0 * window.1;
    let mut clips: Vec<(usize, Option<Rect>)> = Vec::new();
    let mut found = Vec::new();
    for node in nodes {
        while clips.last().is_some_and(|(depth, _)| *depth >= node.depth) {
            clips.pop();
        }
        let clip = clips.last().map(|(_, rect)| *rect).unwrap_or(Some(whole));
        let own = match (node.role.as_str(), node.frame, clip) {
            ("scroll area", Some(frame), Some(clip)) => clip.intersect(&frame),
            _ => clip,
        };
        clips.push((node.depth, own));
        let (Some(frame), Some(clip)) = (node.frame, clip) else {
            continue;
        };
        if !node.actionable || frame.w < 6.0 || frame.h < 6.0 || frame.w * frame.h >= window_area * 0.4 {
            continue;
        }
        let Some(shown) = frame.intersect(&clip) else { continue };
        if shown.w < 4.0 || shown.h < 4.0 {
            continue;
        }
        found.push(Mark {
            id: node.id,
            rect: Rect {
                x: shown.x * scale,
                y: shown.y * scale,
                w: shown.w * scale,
                h: shown.h * scale,
            },
        });
        if found.len() >= 300 {
            break;
        }
    }
    found
}

const ACCENT: [u8; 3] = [255, 56, 140];

/// 3×5 digits, one row per byte, high bit first of the low three bits.
const DIGITS: [[u8; 5]; 10] = [
    [7, 5, 5, 5, 7],
    [2, 6, 2, 2, 7],
    [7, 1, 7, 4, 7],
    [7, 1, 7, 1, 7],
    [5, 5, 7, 1, 1],
    [7, 4, 7, 1, 7],
    [7, 4, 7, 5, 7],
    [7, 1, 1, 1, 1],
    [7, 5, 7, 5, 7],
    [7, 5, 7, 1, 7],
];

fn fill(image: &mut Rgb, x0: i64, y0: i64, w: i64, h: i64, color: [u8; 3]) {
    let (iw, ih) = (i64::from(image.width), i64::from(image.height));
    for y in y0.max(0)..(y0 + h).min(ih) {
        for x in x0.max(0)..(x0 + w).min(iw) {
            let at = ((y * iw + x) * 3) as usize;
            image.pixels[at..at + 3].copy_from_slice(&color);
        }
    }
}

/// Draws a thin outline and an id tag at each mark's top-left corner.
pub fn draw_marks(image: &mut Rgb, marks: &[Mark]) {
    let unit: i64 = if image.width >= 700 { 2 } else { 1 };
    for mark in marks {
        let (x, y) = (mark.rect.x.round() as i64, mark.rect.y.round() as i64);
        let (w, h) = (mark.rect.w.round() as i64, mark.rect.h.round() as i64);
        fill(image, x, y, w, 1, ACCENT);
        fill(image, x, y + h - 1, w, 1, ACCENT);
        fill(image, x, y, 1, h, ACCENT);
        fill(image, x + w - 1, y, 1, h, ACCENT);
        let digits: Vec<usize> = mark.id.to_string().bytes().map(|b| usize::from(b - b'0')).collect();
        let tag_w = (digits.len() as i64 * 4 + 1) * unit + 2;
        let tag_h = 7 * unit;
        fill(image, x, y, tag_w, tag_h, ACCENT);
        for (index, digit) in digits.iter().enumerate() {
            let left = x + 1 + unit + index as i64 * 4 * unit;
            for (row, bits) in DIGITS[*digit].iter().enumerate() {
                for col in 0..3 {
                    if bits & (4 >> col) != 0 {
                        fill(
                            image,
                            left + col * unit,
                            y + unit + row as i64 * unit,
                            unit,
                            unit,
                            [255, 255, 255],
                        );
                    }
                }
            }
        }
    }
}

pub fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(TABLE[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
#[path = "image_tests.rs"]
mod tests;
