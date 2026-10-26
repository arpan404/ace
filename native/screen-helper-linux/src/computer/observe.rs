//! The observation the model gets: app, windows, the chosen window's outline, focus, menu
//! bar, and optionally a screenshot tagged with ids, taken through the ScreenCast portal.
use crate::computer::bus::Bus;
use crate::computer::element::{self, COORD_WINDOW};
use crate::computer::guard::SessionStatus;
use crate::computer::error::{CuError, CuResult, clip};
use crate::computer::image::{self, Rgb};
use crate::computer::outline::{Node, Rect, content_offset};
use crate::computer::screencast::ScreenCast;
use crate::computer::session::{AppSession, WindowEntry};
use crate::computer::walk::FrameMap;
use serde_json::{Value, json};
use std::time::Duration;

pub const NO_SCREENSHOT: &str = "Screenshots are not available in this session: the desktop offers no screen-sharing portal (xdg-desktop-portal with ScreenCast). Work from the outline; it lists every element with its text and id.";

#[derive(Clone, Copy)]
pub struct Options {
    pub screenshot: bool,
    pub outline: bool,
    pub marks: bool,
}

impl Options {
    /// No screenshot while the screen is locked or the session is away: the portal would show
    /// the lock screen, or nothing.
    pub fn for_status(&self, status: SessionStatus) -> Options {
        Options {
            screenshot: self.screenshot && status == SessionStatus::Active,
            ..*self
        }
    }
}

/// A Chromium-based app running without accessibility shows only its window: say why, and how
/// to fix it.
pub fn mark_accessibility(result: &mut Value, pid: u32, name: &str) {
    let proc_root = std::path::Path::new("/proc");
    if crate::computer::chromium::is_chromium_process(proc_root, pid) && !crate::computer::chromium::has_flag(proc_root, pid) {
        result["accessibilityNote"] = json!(crate::computer::chromium::inaccessible_note(name));
    }
}

/// The session state every observation carries, and why a screenshot it asked for is missing.
pub fn mark_status(result: &mut Value, status: SessionStatus, asked: &Options) {
    result["sessionState"] = json!(status.as_str());
    result["screenLocked"] = json!(status == SessionStatus::Locked);
    if asked.screenshot && status != SessionStatus::Active {
        result["screenshotError"] = json!(match status {
            SessionStatus::Locked => "The screen is locked, so there is no screenshot. Work from the outline; observe again after the person unlocks it.",
            _ => "The desktop session is not in front, so there is no screenshot.",
        });
    }
}

pub async fn observation(
    bus: &Bus,
    session: &mut AppSession,
    windows: &[WindowEntry],
    cast: Option<&mut ScreenCast>,
    options: &Options,
) -> Value {
    // Marks use window-relative extents, placed once the frame's size is known.
    let marked = cast.is_some() && options.screenshot && options.marks && options.outline;
    let frames = marked.then_some(FrameMap {
        coord: COORD_WINDOW,
        dx: 0.0,
        dy: 0.0,
    });
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
        let size = element::extents(bus, &window.obj, COORD_WINDOW)
            .await
            .ok()
            .flatten()
            .map(|r| (r.w, r.h));
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
        let picture = match cast {
            Some(cast) => portal_screenshot(bus, cast, session, marks).await,
            None => Err(NO_SCREENSHOT.into()),
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

/// One frame of the app's window through the ScreenCast portal.
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
    session.shot_offset = None;
    let placed: Option<Vec<Node>> = content.map(|content| {
        let (dx, dy) = content_offset(logical, content);
        session.shot_offset = Some((dx, dy));
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
