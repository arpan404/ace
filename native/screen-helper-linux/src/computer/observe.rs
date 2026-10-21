//! The observation the model gets: app, windows, the chosen window's outline, focus, menu
//! bar, and on X11 optionally a screenshot tagged with ids.
use crate::computer::bus::Bus;
use crate::computer::capture;
use crate::computer::element::{self, COORD_WINDOW};
use crate::computer::error::{CuResult, clip};
use crate::computer::image::{self, Rgb};
use crate::computer::session::{AppSession, WindowEntry};
use crate::computer::xdisplay::XDisplay;
use serde_json::{Value, json};
use std::time::Duration;

pub const WAYLAND_SCREENSHOT: &str = "Screenshots are not available in this Wayland session: capturing a window needs the desktop's screen-capture (ScreenCast portal) permission, which ace does not request yet. Work from the outline; it lists every element with its text and id.";

pub struct Options {
    pub screenshot: bool,
    pub outline: bool,
    pub marks: bool,
}

pub async fn observation(
    bus: &Bus,
    x: Option<&XDisplay>,
    session: &mut AppSession,
    windows: &[WindowEntry],
    options: &Options,
) -> Value {
    let xid = x.and_then(|x| session.x_window(x));
    let frames = match (x, xid) {
        (Some(x), Some(xid)) if options.outline => session.frame_map(bus, x, xid).await,
        _ => None,
    };
    let mut truncated = false;
    if options.outline && !session.not_responding {
        truncated = session.walk(bus, frames, Duration::from_secs(4)).await.truncated;
    } else {
        session.nodes.clear();
    }
    let current = session.window.as_ref().map(|w| w.obj.clone());
    let on_screen = |entry: &WindowEntry| !entry.minimized && entry.showing;
    let mut result = json!({
        "app": {"name": session.name, "bundleId": session.id, "pid": session.pid, "active": windows.iter().any(|w| w.active), "hidden": false},
        "windows": windows.iter().map(|w| {
            let mut entry = json!({"index": w.index, "title": w.title, "onScreen": on_screen(w)});
            if w.minimized { entry["minimized"] = json!(true); }
            if current.as_ref() == Some(&w.obj) { entry["current"] = json!(true); }
            entry
        }).collect::<Vec<_>>(),
        "nodes": session.nodes.iter().map(|n| n.json()).collect::<Vec<_>>(),
        "truncated": truncated,
    });
    if session.not_responding {
        result["notResponding"] = json!(true);
        return result;
    }
    result["menuBar"] = json!(menu_titles(bus, session).await);
    if let Some(window) = session.window.clone() {
        let size = match (x, xid) {
            (Some(x), Some(xid)) => x.geometry(xid).map(|g| (f64::from(g.2), f64::from(g.3))),
            _ => None,
        };
        let size = match size {
            Some(size) => Some(size),
            None => element::extents(bus, &window.obj, COORD_WINDOW)
                .await
                .ok()
                .flatten()
                .map(|r| (r.w, r.h)),
        };
        let (width, height) = size.unwrap_or((0.0, 0.0));
        result["window"] = json!({"title": window.title, "width": width as i64, "height": height as i64, "onScreen": on_screen(&window)});
    }
    if let Some(focused) = &session.focused {
        let mut entry = json!({"role": crate::computer::outline::role_name(&focused.role, &Default::default(), false)});
        if let Some(id) = focused.id {
            entry["id"] = json!(id);
            if let Some(node) = session.nodes.iter().find(|n| n.id == id) {
                entry["role"] = json!(node.role);
            }
        }
        if let Some(name) = &focused.name {
            entry["name"] = json!(name);
        }
        if let Some(selected) = &focused.selected_text {
            entry["selectedText"] = json!(selected);
        }
        result["focused"] = entry;
    }
    if options.screenshot {
        match screenshot(x, xid, session, options.marks && options.outline).await {
            Ok(picture) => result["screenshot"] = picture,
            Err(message) => result["screenshotError"] = json!(message),
        }
    }
    result
}

/// Top-level menu titles, the entry points for `menu` steps. Never opens a menu.
async fn menu_titles(bus: &Bus, session: &AppSession) -> Vec<String> {
    let Some(bar) = &session.menu_bar else {
        return Vec::new();
    };
    let Ok(items) = bus.children(bar).await else {
        return Vec::new();
    };
    let names =
        futures_util::future::join_all(items.iter().map(|item| bus.string_prop(item, "Accessible", "Name"))).await;
    names
        .into_iter()
        .filter_map(|name| name.ok().and_then(|n| clip(&n, 40)))
        .collect()
}

async fn screenshot(
    x: Option<&XDisplay>,
    xid: Option<u32>,
    session: &mut AppSession,
    marks: bool,
) -> Result<Value, String> {
    let Some(x) = x else {
        return Err(WAYLAND_SCREENSHOT.into());
    };
    let window = session
        .window
        .clone()
        .ok_or_else(|| format!("{} has no window to capture.", session.name))?;
    if window.minimized {
        return Err(
            "The window is minimized, so it can't be captured. Use the outline, or a window restore step.".into(),
        );
    }
    let xid = xid.ok_or_else(|| {
        format!(
            "{}'s window has no X11 window to capture (it may be a Wayland-native window). Use the outline instead.",
            session.name
        )
    })?;
    let composited = if session.redirected.contains(&xid) {
        true
    } else if capture::redirect(x, xid) {
        session.redirected.insert(xid);
        // The app repaints into its new offscreen storage; give it a moment.
        tokio::time::sleep(Duration::from_millis(150)).await;
        true
    } else {
        false
    };
    let picture = capture::grab(x, xid, composited).map_err(|e| e.message)?;
    session.scale = f64::from(image::fit(picture.width, picture.height).0) / f64::from(picture.width.max(1));
    encode(picture, if marks { Some(&session.nodes) } else { None }).map_err(|e| e.message)
}

fn encode(picture: Rgb, nodes: Option<&Vec<crate::computer::outline::Node>>) -> CuResult<Value> {
    let (width, height) = image::fit(picture.width, picture.height);
    let scale = f64::from(width) / f64::from(picture.width.max(1));
    let original = (f64::from(picture.width), f64::from(picture.height));
    let mut scaled = image::downscale(&picture, width, height);
    if let Some(nodes) = nodes {
        image::draw_marks(&mut scaled, &image::marks(nodes, original, scale));
    }
    let mut jpeg = Vec::new();
    jpeg_encoder::Encoder::new(&mut jpeg, 80)
        .encode(
            &scaled.pixels,
            width as u16,
            height as u16,
            jpeg_encoder::ColorType::Rgb,
        )
        .map_err(|e| {
            crate::computer::error::CuError::new("internal", format!("Could not encode the screenshot: {e}"))
        })?;
    Ok(json!({"jpeg": image::base64(&jpeg), "width": width, "height": height}))
}
