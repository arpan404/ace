//! Coordinates. Window frames, element frames and screen points are physical pixels (the helper
//! is per-monitor DPI aware); the model sees screenshot pixels and, for window moves, logical
//! points. Pure.
use super::outline::Rect;

/// How the last screenshot maps to the screen: the window frame's top-left in physical pixels
/// and the screenshot's pixels per physical pixel.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Shot {
    pub origin_x: f64,
    pub origin_y: f64,
    pub scale: f64,
    pub width: u32,
    pub height: u32,
}

impl Shot {
    /// A screenshot pixel as a window pixel, or None outside the picture.
    pub fn window_point(&self, x: f64, y: f64) -> Option<(f64, f64)> {
        if !x.is_finite() || !y.is_finite() || x < 0.0 || y < 0.0 || self.scale <= 0.0 {
            return None;
        }
        if x >= f64::from(self.width) || y >= f64::from(self.height) {
            return None;
        }
        Some((x / self.scale, y / self.scale))
    }

    /// A window pixel on the screen.
    pub fn screen_point(&self, window: (f64, f64)) -> (i32, i32) {
        (
            (self.origin_x + window.0).round() as i32,
            (self.origin_y + window.1).round() as i32,
        )
    }
}

/// A screen pixel as SendInput's absolute coordinates over the virtual desktop (0..=65535).
pub fn absolute(point: (i32, i32), desktop: Rect) -> Option<(i32, i32)> {
    let (x, y) = (
        f64::from(point.0) - desktop.x,
        f64::from(point.1) - desktop.y,
    );
    if desktop.w <= 1.0
        || desktop.h <= 1.0
        || x < 0.0
        || y < 0.0
        || x >= desktop.w
        || y >= desktop.h
    {
        return None;
    }
    Some((
        (x * 65535.0 / (desktop.w - 1.0)).round() as i32,
        (y * 65535.0 / (desktop.h - 1.0)).round() as i32,
    ))
}

/// Where SetWindowPos must put the window rect so its visible frame (without the invisible
/// resize borders) lands at `frame`. `outer` and `visible` are the current window rect and
/// visible frame.
pub fn outer_for_frame(frame: Rect, outer: Rect, visible: Rect) -> Rect {
    let left = visible.x - outer.x;
    let top = visible.y - outer.y;
    let right = (outer.x + outer.w) - (visible.x + visible.w);
    let bottom = (outer.y + outer.h) - (visible.y + visible.h);
    Rect {
        x: frame.x - left,
        y: frame.y - top,
        w: frame.w + left + right,
        h: frame.h + top + bottom,
    }
}

/// Logical points to physical pixels at a DPI (96 is 100%).
pub fn physical(points: f64, dpi: u32) -> f64 {
    points * f64::from(dpi.max(96)) / 96.0
}

/// Physical pixels to logical points at a DPI.
pub fn logical(pixels: f64, dpi: u32) -> f64 {
    pixels * 96.0 / f64::from(dpi.max(96))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn screenshot_pixels_map_through_the_window_to_the_screen() {
        let shot = Shot {
            origin_x: -1920.0,
            origin_y: 100.0,
            scale: 0.5,
            width: 800,
            height: 600,
        };
        let point = shot.window_point(100.0, 50.0).unwrap();
        assert_eq!(point, (200.0, 100.0));
        assert_eq!(shot.screen_point(point), (-1720, 200));
        assert_eq!(shot.window_point(800.0, 10.0), None);
        assert_eq!(shot.window_point(-1.0, 10.0), None);
    }

    #[test]
    fn absolute_coordinates_span_a_virtual_desktop_with_negative_origin() {
        let desktop = Rect {
            x: -1920.0,
            y: 0.0,
            w: 3840.0,
            h: 1080.0,
        };
        assert_eq!(absolute((-1920, 0), desktop), Some((0, 0)));
        assert_eq!(absolute((1919, 1079), desktop), Some((65535, 65535)));
        assert_eq!(absolute((1920, 0), desktop), None);
    }

    #[test]
    fn moves_account_for_invisible_resize_borders() {
        let outer = Rect {
            x: 93.0,
            y: 100.0,
            w: 814.0,
            h: 607.0,
        };
        let visible = Rect {
            x: 100.0,
            y: 100.0,
            w: 800.0,
            h: 600.0,
        };
        let target = Rect {
            x: 0.0,
            y: 0.0,
            w: 1000.0,
            h: 700.0,
        };
        assert_eq!(
            outer_for_frame(target, outer, visible),
            Rect {
                x: -7.0,
                y: 0.0,
                w: 1014.0,
                h: 707.0
            }
        );
    }

    #[test]
    fn points_scale_with_dpi() {
        assert_eq!(physical(100.0, 144), 150.0);
        assert_eq!(logical(150.0, 144), 100.0);
        assert_eq!(physical(100.0, 0), 100.0);
    }
}
