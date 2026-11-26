// SPDX-License-Identifier: Apache-2.0
//! The body ace draws around an emulator skin's display: the graphite band, the black glass and
//! the screen's clipped shape. Pure: the opening's geometry and the images' measured alpha in.

use super::super::chrome::{Body, Chrome, Cutout, Rect, svg_url};
use super::super::jsnum;
use super::{BEZEL_SHARE, FALLBACK_RADIUS_SHARE, METAL_SHARE, Opening, SkinImage, corner_radius};

/// The body drawn around a screen.
pub struct DrawnBody {
    pub width: f64,
    pub height: f64,
    pub bezel: f64,
    pub image: String,
}

/// The body around a screen of `width` × `height` with corners of `radius`: one thin, even bezel
/// of black glass inside a graphite band with a soft lit edge, concentric with the screen's
/// corners. All the real hardware shows from the front; the screen itself is cut out.
pub fn drawn_body(width: f64, height: f64, radius: f64) -> DrawnBody {
    let short = width.min(height);
    let bezel = jsnum::round(short * BEZEL_SHARE).max(4.0);
    let metal = jsnum::round(short * METAL_SHARE).max(2.0);
    let edge = (short * 0.0018).max(1.0);
    let w = width + 2.0 * bezel;
    let h = height + 2.0 * bezel;
    let r = radius + bezel;
    let svg = [
        format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {} {}\" width=\"{}\" height=\"{}\">",
            jsnum::text(w),
            jsnum::text(h),
            jsnum::text(w),
            jsnum::text(h)
        ),
        "<defs><linearGradient id=\"band\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">".to_string(),
        "<stop offset=\"0\" stop-color=\"#55555b\"/><stop offset=\"0.5\" stop-color=\"#2c2c30\"/><stop offset=\"1\" stop-color=\"#46464b\"/>".to_string(),
        "</linearGradient></defs>".to_string(),
        format!(
            "<rect width=\"{}\" height=\"{}\" rx=\"{}\" fill=\"url(#band)\"/>",
            jsnum::text(w),
            jsnum::text(h),
            rounded(r)
        ),
        format!(
            "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" rx=\"{}\" fill=\"none\" stroke=\"#ffffff\" stroke-opacity=\"0.18\" stroke-width=\"{}\"/>",
            rounded(edge / 2.0),
            rounded(edge / 2.0),
            rounded(w - edge),
            rounded(h - edge),
            rounded(r - edge / 2.0),
            rounded(edge)
        ),
        format!(
            "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" rx=\"{}\" fill=\"#050506\"/>",
            jsnum::text(metal),
            jsnum::text(metal),
            jsnum::text(w - 2.0 * metal),
            jsnum::text(h - 2.0 * metal),
            rounded(r - metal)
        ),
        "</svg>".to_string(),
    ]
    .join("");
    DrawnBody {
        width: w,
        height: h,
        bezel,
        image: svg_url(&svg),
    }
}

/// The screen's shape: a rounded rectangle the live picture is clipped to.
fn screen_mask(width: f64, height: f64, radius: f64) -> String {
    svg_url(&format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {} {}\" preserveAspectRatio=\"none\"><rect width=\"{}\" height=\"{}\" rx=\"{}\" fill=\"#000\"/></svg>",
        jsnum::text(width),
        jsnum::text(height),
        jsnum::text(width),
        jsnum::text(height),
        rounded(radius)
    ))
}

/// The skin's upright look: the body drawn from the skin's real geometry, the screen clipped to
/// its corners, and the skin's mask drawn over the display as a cutout.
pub fn android_skin_chrome(
    opening: &Opening,
    backdrop: &SkinImage,
    mask: Option<&SkinImage>,
) -> Chrome {
    let limit = opening.short / 2.0;
    let radius = mask
        .and_then(|image| corner_radius(&image.scan, limit))
        .filter(|radius| *radius != 0.0)
        .or_else(|| corner_radius(&backdrop.scan, limit).filter(|radius| *radius != 0.0))
        .unwrap_or(opening.short * FALLBACK_RADIUS_SHARE);
    let body = drawn_body(opening.width, opening.height, radius);
    let screen = Rect {
        x: body.bezel,
        y: body.bezel,
        width: opening.width,
        height: opening.height,
    };
    Chrome {
        body: Body {
            width: body.width,
            height: body.height,
            image: body.image,
        },
        screen,
        mask: Some(screen_mask(opening.width, opening.height, radius)),
        cutout: mask.map(|image| Cutout {
            rect: screen,
            image: image.url.clone(),
        }),
        buttons: Vec::new(),
    }
}

/// `Math.round(value * 100) / 100`, formatted as the picture spells it.
fn rounded(value: f64) -> String {
    jsnum::rounded(value, 2)
}
