//! The observation the model gets: app, windows, the chosen window's outline, focus, menu
//! bar, and optionally a screenshot tagged with ids (X11 directly, Wayland through the
//! ScreenCast portal).
use crate::computer::bus::Bus;
use crate::computer::capture;
use crate::computer::element::{self, COORD_WINDOW};
use crate::computer::error::{CuError, CuResult, clip};
use crate::computer::image::{self, Rgb};
use crate::computer::outline::{Node, Rect, content_offset};
use crate::computer::screencast::ScreenCast;
use crate::computer::session::{AppSession, WindowEntry};
use crate::computer::walk::FrameMap;
use crate::computer::xdisplay::XDisplay;
use serde_json::{Value, json};
use std::time::Duration;

pub const WAYLAND_SCREENSHOT: &str = "Screenshots are not available in this Wayland session: the desktop offers no screen-sharing portal (xdg-desktop-portal with ScreenCast). Work from the outline; it lists every element with its text and id.";

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
    cast: Option<&mut ScreenCast>,
    options: &Options,
) -> Value {
    let xid = x.and_then(|x| session.x_window(x));
    let wayland_marks = x.is_none() && cast.is_some() && options.screenshot && options.marks;
    let frames = match (x, xid) {
        (Some(x), Some(xid)) if options.outline => session.frame_map(bus, x, xid).await,
        // Wayland: window-relative extents, placed once the frame's size is known.
        (None, _) if options.outline && wayland_marks => Some(FrameMap {
            coord: COORD_WINDOW,
            dx: 0.0,
            dy: 0.0,
        }),
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
        let marks = options.marks && options.outline;
        let picture = match (x, cast) {
            (Some(x), _) => screenshot(x, xid, session, marks).await,
            (None, Some(cast)) => portal_screenshot(bus, cast, session, marks).await,
            (None, None) => Err(WAYLAND_SCREENSHOT.into()),
        };
        match picture {
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

async fn screenshot(x: &XDisplay, xid: Option<u32>, session: &mut AppSession, marks: bool) -> Result<Value, String> {
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
    let logical = (f64::from(picture.width), f64::from(picture.height));
    let nodes = if marks { Some(&session.nodes) } else { None };
    let (value, scale) = encode(picture, logical, nodes).map_err(|e| e.message)?;
    session.scale = scale;
    Ok(value)
}

/// Wayland: one frame of the app's window through the ScreenCast portal.
async fn portal_screenshot(
    bus: &Bus,
    cast: &mut ScreenCast,
    session: &mut AppSession,
    marks: bool,
) -> Result<Value, String> {
    let window = session
        .window
        .clone()
        .ok_or_else(|| format!("{} has no window to capture.", session.name))?;
    if window.minimized {
        return Err("The window is minimized, so it can't be captured. Use the outline.".into());
    }
    let frame = cast.capture(&session.id, &session.name).await?;
    let logical = (f64::from(frame.logical.0), f64::from(frame.logical.1));
    // A window frame shows exactly the window, its content centred in it. A monitor frame
    // can't be related to window-relative positions, so it gets no marks.
    let content = if marks && frame.window {
        session.content(bus).await
    } else {
        None
    };
    let placed: Option<Vec<Node>> = content.map(|content| {
        let (dx, dy) = content_offset(logical, content);
        session
            .nodes
            .iter()
            .map(|node| {
                let mut node = node.clone();
                node.frame = node.frame.map(|f| Rect {
                    x: f.x - dx,
                    y: f.y - dy,
                    ..f
                });
                node
            })
            .collect()
    });
    let (value, scale) = encode(frame.picture, logical, placed.as_ref()).map_err(|e| e.message)?;
    session.scale = scale;
    Ok(value)
}

/// Fits, marks and encodes a picture. `logical` is the size node frames are measured in.
/// Returns the screenshot and its pixels per logical pixel.
fn encode(picture: Rgb, logical: (f64, f64), nodes: Option<&Vec<Node>>) -> CuResult<(Value, f64)> {
    let (width, height) = image::fit(picture.width, picture.height);
    let scale = f64::from(width) / logical.0.max(1.0);
    let mut scaled = image::downscale(&picture, width, height);
    if let Some(nodes) = nodes {
        image::draw_marks(&mut scaled, &image::marks(nodes, logical, scale));
    }
    let mut jpeg = Vec::new();
    jpeg_encoder::Encoder::new(&mut jpeg, 80)
        .encode(
            &scaled.pixels,
            width as u16,
            height as u16,
            jpeg_encoder::ColorType::Rgb,
        )
        .map_err(|e| CuError::new("internal", format!("Could not encode the screenshot: {e}")))?;
    Ok((
        json!({"jpeg": image::base64(&jpeg), "width": width, "height": height}),
        scale,
    ))
}
