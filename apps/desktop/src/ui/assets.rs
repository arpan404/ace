use gpui::{AssetSource, Result, SharedString};
use std::borrow::Cow;

#[derive(Clone, Copy, Debug, Default)]
pub struct DesktopAssets;

impl AssetSource for DesktopAssets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        if !path.starts_with("icons/") || !path.ends_with(".svg") {
            return Ok(None);
        }
        Ok(Some(Cow::Owned(icon_svg(path).into_bytes())))
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        if path == "icons" {
            Ok(ICON_FILES.iter().copied().map(Into::into).collect())
        } else {
            Ok(Vec::new())
        }
    }
}

const ICON_FILES: &[&str] = &[
    "add.svg",
    "arrow-up.svg",
    "bot.svg",
    "box.svg",
    "browser.svg",
    "chevron-down.svg",
    "chevron-left.svg",
    "chevron-right.svg",
    "circle-x.svg",
    "code-2.svg",
    "corner-focus.svg",
    "delete.svg",
    "editor.svg",
    "environment.svg",
    "flask-conical.svg",
    "folder.svg",
    "folder-closed.svg",
    "github.svg",
    "globe.svg",
    "maximise.svg",
    "maximize.svg",
    "menu.svg",
    "message.svg",
    "minus.svg",
    "panel-bottom-closed.svg",
    "panel-bottom-open.svg",
    "panel-left-closed.svg",
    "panel-left-close.svg",
    "panel-left-open.svg",
    "panel-right.svg",
    "panel-right-closed.svg",
    "panel-right-open.svg",
    "pin.svg",
    "pin-filled.svg",
    "pinned-off.svg",
    "plus.svg",
    "review.svg",
    "rocket.svg",
    "search.svg",
    "settings.svg",
    "square-terminal.svg",
    "star.svg",
    "summary.svg",
    "tabler-archive.svg",
    "tabler-settings.svg",
    "tabler-terminal.svg",
    "terminal.svg",
    "triangle-alert.svg",
];

fn icon_svg(path: &str) -> String {
    let body = match path.rsplit('/').next().unwrap_or_default() {
        "arrow-up.svg" => r#"<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>"#,
        "bot.svg" => {
            r#"<rect x="5" y="8" width="14" height="10" rx="3"/><path d="M12 8V4"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/><path d="M9 18v2"/><path d="M15 18v2"/>"#
        }
        "box.svg" => {
            r#"<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>"#
        }
        "chevron-down.svg" => r#"<path d="m6 9 6 6 6-6"/>"#,
        "chevron-left.svg" => r#"<path d="m15 18-6-6 6-6"/>"#,
        "chevron-right.svg" => r#"<path d="m9 18 6-6-6-6"/>"#,
        "circle-x.svg" => {
            r#"<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>"#
        }
        "code-2.svg" => {
            r#"<path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/>"#
        }
        "delete.svg" => r#"<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/>"#,
        "folder.svg" | "folder-closed.svg" => {
            r#"<path d="M3 7h7l2 2h9v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>"#
        }
        "flask-conical.svg" => {
            r#"<path d="M10 2v7.3L4.2 19.1A2 2 0 0 0 5.9 22h12.2a2 2 0 0 0 1.7-2.9L14 9.3V2"/><path d="M8.5 2h7"/><path d="M7 16h10"/>"#
        }
        "github.svg" => {
            r#"<path d="M15 22v-4a4.8 4.8 0 0 0-1-3c3 0 6-2 6-6 0-1.2-.4-2.3-1.2-3.2.1-.4.5-2-.2-3.6 0 0-1-.3-3.3 1.2A11.4 11.4 0 0 0 12 3c-1.1 0-2.2.1-3.3.4C6.4 1.9 5.4 2.2 5.4 2.2c-.7 1.6-.3 3.2-.2 3.6A5 5 0 0 0 4 9c0 4 3 6 6 6-.5.5-.8 1.2-.9 2.1-1 .5-3.4 1.3-4.9-1.4 0 0-.9-1.6-2.7-1.7"/>"#
        }
        "globe.svg" => {
            r#"<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/>"#
        }
        "maximize.svg" | "maximise.svg" => {
            r#"<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>"#
        }
        "menu.svg" => r#"<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>"#,
        "minus.svg" => r#"<path d="M5 12h14"/>"#,
        "panel-left-close.svg" => {
            r#"<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/><path d="m15 9-3 3 3 3"/>"#
        }
        "browser.svg" => {
            return include_str!("../../../../assets/icons/browser.svg").to_string();
        }
        "editor.svg" => {
            return include_str!("../../../../assets/icons/editor.svg").to_string();
        }
        "environment.svg" => {
            return include_str!("../../../../assets/icons/environment.svg").to_string();
        }
        "panel-bottom-closed.svg" => {
            return include_str!("../../../../assets/icons/panel-bottom-closed.svg").to_string();
        }
        "panel-bottom-open.svg" => {
            return include_str!("../../../../assets/icons/panel-bottom-open.svg").to_string();
        }
        "panel-left-closed.svg" => {
            return include_str!("../../../../assets/icons/panel-left-closed.svg").to_string();
        }
        "panel-left-open.svg" => {
            return include_str!("../../../../assets/icons/panel-left-open.svg").to_string();
        }
        "panel-right.svg" => {
            r#"<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>"#
        }
        "panel-right-closed.svg" => {
            return include_str!("../../../../assets/icons/panel-right-closed.svg").to_string();
        }
        "panel-right-open.svg" => {
            return include_str!("../../../../assets/icons/panel-right-open.svg").to_string();
        }
        "pin.svg" => {
            r#"<path d="M12 17v5"/><path d="M9 10.8V5.5L7 3.5V2h10v1.5l-2 2v5.3l3 3.2v1H6v-1Z"/>"#
        }
        "pin-filled.svg" => {
            r#"<path d="M16 3v1.5l-2 2V11l3 3v1H7v-1l3-3V6.5l-2-2V3Z" fill="currentColor" stroke="none"/><path d="M12 15v7"/>"#
        }
        "pinned-off.svg" => {
            r#"<path d="m3 3 18 18"/><path d="M12 17v5"/><path d="M9 10.8V5.5L7 3.5V2h10v1.5l-2 2v3.5"/><path d="M8.6 14H6v-1l2.2-2.4"/><path d="M14.8 12.8 18 16v1h-2.8"/>"#
        }
        "review.svg" => {
            return include_str!("../../../../assets/icons/review.svg").to_string();
        }
        "summary.svg" => {
            return include_str!("../../../../assets/icons/summary.svg").to_string();
        }
        "terminal.svg" => {
            return include_str!("../../../../assets/icons/terminal.svg").to_string();
        }
        "plus.svg" => r#"<path d="M12 5v14"/><path d="M5 12h14"/>"#,
        "rocket.svg" => {
            r#"<path d="M4.5 16.5c-1.3 1.3-1.7 3.4-1.5 4 .6.2 2.7-.2 4-1.5"/><path d="M9 15 4 10l2.5-2.5c1.2-1.2 3.3-.6 3.7 1.1"/><path d="M14 10c1.7.4 2.3 2.5 1.1 3.7L12.5 16 8 11.5"/><path d="M9 15 15 9c1.8-1.8 4.4-2.7 6-2- .7 1.6- .2 4.2-2 6l-6 6"/><circle cx="15.5" cy="8.5" r="1.5"/>"#
        }
        "search.svg" => r#"<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>"#,
        "settings.svg" => {
            r#"<path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2 3-.2-.1a1.7 1.7 0 0 0-2 .2 1.7 1.7 0 0 0-.7 1.7V22h-3.8v-.2a1.7 1.7 0 0 0-2.7-1.4l-.2.1-2-3 .1-.1A1.7 1.7 0 0 0 6.6 15a1.7 1.7 0 0 0-1.5-1H5v-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1 2-3 .2.1a1.7 1.7 0 0 0 2-.2 1.7 1.7 0 0 0 .7-1.7V2h3.8v.2a1.7 1.7 0 0 0 2.7 1.4l.2-.1 2 3-.1.1A1.7 1.7 0 0 0 17.4 9a1.7 1.7 0 0 0 1.5 1h.1v4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>"#
        }
        "square-terminal.svg" => {
            r#"<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3"/><path d="M12 15h5"/>"#
        }
        "tabler-archive.svg" => {
            r#"<path d="M3 4m0 2a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2H3z"/><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>"#
        }
        "tabler-settings.svg" => {
            r#"<path d="M10.3 4.3c.4-1.7 2.9-1.7 3.4 0a1.7 1.7 0 0 0 2.5 1 1.7 1.7 0 0 1 2.4 2.4 1.7 1.7 0 0 0 1 2.5c1.7.4 1.7 2.9 0 3.4a1.7 1.7 0 0 0-1 2.5 1.7 1.7 0 0 1-2.4 2.4 1.7 1.7 0 0 0-2.5 1c-.4 1.7-2.9 1.7-3.4 0a1.7 1.7 0 0 0-2.5-1 1.7 1.7 0 0 1-2.4-2.4 1.7 1.7 0 0 0-1-2.5c-1.7-.4-1.7-2.9 0-3.4a1.7 1.7 0 0 0 1-2.5 1.7 1.7 0 0 1 2.4-2.4 1.7 1.7 0 0 0 2.5-1"/><path d="M9 12a3 3 0 1 0 6 0 3 3 0 0 0-6 0"/>"#
        }
        "tabler-terminal.svg" => r#"<path d="M5 7l5 5-5 5"/><path d="M12 19h7"/>"#,
        "star.svg" => {
            r#"<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9Z"/>"#
        }
        "triangle-alert.svg" => {
            r#"<path d="m12 3 10 18H2Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>"#
        }
        _ => r#"<circle cx="12" cy="12" r="9"/>"#,
    };

    format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">{body}</svg>"#
    )
}
