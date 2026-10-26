//! One picture of one X window. With Composite the window is redirected to an offscreen
//! pixmap, so covered windows still capture; without it, the visible part is read.
use crate::computer::error::{CuError, CuResult};
use crate::computer::image::Rgb;
use crate::computer::xdisplay::XDisplay;
use x11rb::connection::Connection;
use x11rb::protocol::composite::{self, ConnectionExt as _};
use x11rb::protocol::xproto::*;

fn failed(e: impl std::fmt::Display) -> CuError {
    CuError::new(
        "capture_failed",
        format!("The window could not be captured ({e}). Use the outline instead."),
    )
}

/// Redirects the window to offscreen storage once. True when it was redirected just now, so
/// the app needs a moment to repaint before the first capture.
pub fn redirect(x: &XDisplay, window: u32) -> bool {
    if x.conn
        .composite_query_version(0, 4)
        .ok()
        .and_then(|c| c.reply().ok())
        .is_none()
    {
        return false;
    }
    x.conn
        .composite_redirect_window(window, composite::Redirect::AUTOMATIC)
        .ok()
        .and_then(|c| c.check().ok())
        .is_some()
}

pub fn grab(x: &XDisplay, window: u32, composited: bool) -> CuResult<Rgb> {
    if !x.is_viewable(window) {
        return Err(CuError::new(
            "window_hidden",
            "The window is minimized or hidden, so it can't be captured. Use the outline, or a window restore step.",
        ));
    }
    let geometry = x.conn.get_geometry(window).map_err(failed)?.reply().map_err(|_| {
        CuError::new(
            "window_gone",
            "The window closed or can't be captured. Observe the app again.",
        )
    })?;
    let (w, h) = (geometry.width, geometry.height);
    if w == 0 || h == 0 || u32::from(w) * u32::from(h) > 16_777_216 {
        return Err(failed("unusual size"));
    }
    let visual = x
        .conn
        .get_window_attributes(window)
        .map_err(failed)?
        .reply()
        .map_err(failed)?
        .visual;
    let mut image = None;
    if composited {
        if let Ok(pixmap) = x.conn.generate_id() {
            if x.conn
                .composite_name_window_pixmap(window, pixmap)
                .ok()
                .and_then(|c| c.check().ok())
                .is_some()
            {
                image = x
                    .conn
                    .get_image(ImageFormat::Z_PIXMAP, pixmap, 0, 0, w, h, !0)
                    .ok()
                    .and_then(|c| c.reply().ok());
                let _ = x.conn.free_pixmap(pixmap);
            }
        }
    }
    let image = match image {
        Some(image) => image,
        None => x
            .conn
            .get_image(ImageFormat::Z_PIXMAP, window, 0, 0, w, h, !0)
            .map_err(failed)?
            .reply()
            .map_err(failed)?,
    };
    to_rgb(x, &image.data, w, h, image.depth, visual)
}

fn to_rgb(x: &XDisplay, data: &[u8], w: u16, h: u16, depth: u8, visual: u32) -> CuResult<Rgb> {
    let setup = x.conn.setup();
    let format = setup
        .pixmap_formats
        .iter()
        .find(|f| f.depth == depth)
        .ok_or_else(|| failed("unknown pixel format"))?;
    if format.bits_per_pixel != 32 {
        return Err(failed("only 24- and 32-bit displays are supported"));
    }
    let visual = setup
        .roots
        .iter()
        .flat_map(|s| &s.allowed_depths)
        .flat_map(|d| &d.visuals)
        .find(|v| v.visual_id == visual)
        .copied()
        .ok_or_else(|| failed("unknown visual"))?;
    let stride = data.len() / usize::from(h).max(1);
    if stride < usize::from(w) * 4 {
        return Err(failed("short image"));
    }
    let little = setup.image_byte_order == ImageOrder::LSB_FIRST;
    let masks = [visual.red_mask, visual.green_mask, visual.blue_mask];
    let mut pixels = Vec::with_capacity(usize::from(w) * usize::from(h) * 3);
    for row in data.chunks(stride).take(usize::from(h)) {
        for px in row[..usize::from(w) * 4].chunks_exact(4) {
            let bytes = [px[0], px[1], px[2], px[3]];
            let pixel = if little {
                u32::from_le_bytes(bytes)
            } else {
                u32::from_be_bytes(bytes)
            };
            for mask in masks {
                let shift = mask.trailing_zeros();
                let max = (mask >> shift).max(1);
                pixels.push((((pixel & mask) >> shift) * 255 / max) as u8);
            }
        }
    }
    Ok(Rgb {
        width: u32::from(w),
        height: u32::from(h),
        pixels,
    })
}
