// SPDX-License-Identifier: Apache-2.0
//! Box geometry: the size a picture takes to fit inside a box, keeping its shape.

/// `width` × `height` scaled to fit inside `box_w` × `box_h`, each side rounded and at least
/// one pixel. Never larger than the picture unless `enlarge`.
pub fn inside(width: u32, height: u32, box_w: u32, box_h: u32, enlarge: bool) -> (u32, u32) {
    let ratio = (f64::from(box_w) / f64::from(width)).min(f64::from(box_h) / f64::from(height));
    let ratio = if enlarge { ratio } else { ratio.min(1.0) };
    let side = |n: u32, bound: u32| ((f64::from(n) * ratio).round() as u32).clamp(1, bound.max(1));
    (side(width, box_w), side(height, box_h))
}

#[cfg(test)]
mod tests {
    use super::inside;

    #[test]
    fn a_picture_fits_its_box_keeping_its_shape() {
        assert_eq!(inside(1206, 2622, 1920, 2160, false), (994, 2160));
        assert_eq!(inside(4000, 3000, 512, 512, false), (512, 384));
        assert_eq!(inside(100, 50, 512, 512, false), (100, 50));
        assert_eq!(inside(100, 50, 512, 512, true), (512, 256));
        assert_eq!(inside(10_000, 1, 64, 64, false), (64, 1));
    }
}
