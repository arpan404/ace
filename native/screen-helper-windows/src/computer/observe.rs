//! The observation the model gets: app, windows, the chosen window's outline, focus, menu bar,
//! and optionally a screenshot of the window with element ids tagged on it.
use super::apps::{self, TopWindow};
use super::capture;
use super::error::clip;
use super::geometry::{logical, Shot};
use super::image;
use super::menus;
use super::session::AppSession;
use super::uia::Uia;
use serde_json::{json, Value};
use std::time::Duration;
use windows::Win32::UI::{Accessibility::*, HiDpi::GetDpiForWindow};

pub struct Options {
    pub screenshot: bool,
    pub outline: bool,
    pub marks: bool,
}

/// The focused text element's selection, so the model sees what a copy or a typed key affects.
fn selected_text(element: &IUIAutomationElement) -> Option<String> {
    unsafe {
        let pattern = element
            .GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
            .ok()?;
        let ranges = pattern.GetSelection().ok()?;
        if ranges.Length().ok()? < 1 {
            return None;
        }
        let text = ranges.GetElement(0).ok()?.GetText(400).ok()?.to_string();
        clip(&text, 200)
    }
}

pub fn observation(
    uia: &Uia,
    session: &mut AppSession,
    all: &[TopWindow],
    options: &Options,
) -> Value {
    if options.outline {
        session.walk(uia, Duration::from_secs(4));
    } else {
        session.nodes.clear();
    }
    let mine = session.windows(all);
    let current = session.window;
    let pid = mine
        .iter()
        .find(|w| Some(w.hwnd) == current)
        .or(mine.first())
        .map_or(0, |w| w.pid);
    let mut result = json!({
        "app": {
            "name": session.name,
            "bundleId": session.id,
            "pid": pid,
            "active": mine.iter().any(|w| apps::is_foreground(w.hwnd)),
            "hidden": false,
        },
        "windows": mine.iter().enumerate().map(|(i, w)| {
            let mut entry = json!({"index": i + 1, "title": w.title, "onScreen": !w.minimized && !w.other_desktop});
            if w.minimized { entry["minimized"] = json!(true); }
            if w.other_desktop { entry["otherSpace"] = json!(true); }
            if Some(w.hwnd) == current { entry["current"] = json!(true); }
            entry
        }).collect::<Vec<_>>(),
        "nodes": session.nodes.iter().map(|n| n.json()).collect::<Vec<_>>(),
        "truncated": session.truncated,
    });
    if session.not_responding {
        result["notResponding"] = json!(true);
    }
    let Some(window) = current.and_then(|hwnd| mine.iter().find(|w| w.hwnd == hwnd)) else {
        return result;
    };
    let hwnd = window.hwnd;
    let mut bar = menus::bar_titles(hwnd);
    if bar.is_empty() {
        // Toolkits without a Win32 menu bar expose it as a menu bar element.
        if let Some(index) = session.nodes.iter().position(|n| n.role == "menu bar") {
            let depth = session.nodes[index].depth;
            bar = session.nodes[index + 1..]
                .iter()
                .take_while(|n| n.depth > depth)
                .filter(|n| n.depth == depth + 1)
                .filter_map(|n| n.name.as_deref().and_then(|name| clip(name, 40)))
                .collect();
        }
    }
    result["menuBar"] = json!(bar);
    let dpi = unsafe { GetDpiForWindow(hwnd) };
    let size = capture::frame(hwnd).map_or((0.0, 0.0), |f| (logical(f.w, dpi), logical(f.h, dpi)));
    result["window"] = json!({
        "title": window.title,
        "width": size.0.round() as i64,
        "height": size.1.round() as i64,
        "onScreen": !window.minimized && !window.other_desktop,
    });
    let focus = session
        .agent_focus
        .and_then(|id| session.node(id))
        .map(|node| (Some(node.id), node.role.clone(), node.name.clone()))
        .or_else(|| {
            session
                .focus
                .as_ref()
                .map(|f| (f.id, f.role.clone(), f.name.clone()))
        });
    if let Some((id, role, name)) = focus {
        let mut entry = json!({"role": role});
        if let Some(id) = id {
            entry["id"] = json!(id);
            let text_input = matches!(
                role.as_str(),
                "text field" | "text area" | "document" | "combo box"
            );
            if text_input {
                if let Some(selected) = session.ids.get(id).and_then(selected_text) {
                    entry["selectedText"] = json!(selected);
                }
            }
        }
        if let Some(name) = name {
            entry["name"] = json!(name);
        }
        result["focused"] = entry;
    }
    if options.screenshot {
        match screenshot(session, hwnd, options.marks && options.outline) {
            Ok(picture) => result["screenshot"] = picture,
            Err(message) => result["screenshotError"] = json!(message),
        }
    }
    result
}

fn screenshot(
    session: &mut AppSession,
    hwnd: windows::Win32::Foundation::HWND,
    marks: bool,
) -> Result<Value, String> {
    let (picture, frame) = capture::window(hwnd, &session.name)?;
    let (width, height) = image::fit(picture.width, picture.height);
    let scale = f64::from(width) / f64::from(picture.width.max(1));
    let mut scaled = image::downscale_bgra(
        &picture.bgra,
        (picture.width, picture.height),
        picture.stride,
        width,
        height,
    );
    if marks {
        let found = image::marks(
            &session.nodes,
            (f64::from(picture.width), f64::from(picture.height)),
            scale,
        );
        image::draw_marks(&mut scaled, &found);
    }
    let jpeg = image::jpeg(&scaled)?;
    session.shot = Some((
        hwnd,
        Shot {
            origin_x: frame.x,
            origin_y: frame.y,
            scale,
            width,
            height,
        },
    ));
    Ok(json!({"jpeg": image::base64(&jpeg), "width": width, "height": height}))
}
