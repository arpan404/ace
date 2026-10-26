//! What the person picked in the portal's sharing dialog. The stream says whether it is a
//! window or a screen; which app a window belongs to is only known when the desktop records
//! it with the restore token. GNOME's portal records a shared window as its app id and title
//! (xdg-desktop-portal-gnome `remotedesktop.c`, restore data `(xxuba(uuv))`); other desktops
//! record nothing readable and the window stays unnamed.
use serde_json::{Value as Json, json};
use zbus::{
    Connection, Proxy,
    zvariant::{OwnedValue, Value},
};

/// ScreenCast source types (`AvailableSourceTypes`, stream `source_type`).
pub const SOURCE_MONITOR: u32 = 1;
pub const SOURCE_WINDOW: u32 = 2;

#[derive(Clone, Debug, PartialEq)]
pub struct Recorded {
    /// The desktop-file id, as computer use names apps (`org.gnome.Calculator`).
    pub app_id: String,
    pub title: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Picked {
    /// A whole screen rather than one window.
    pub display: bool,
    pub app: Option<Recorded>,
}
impl Picked {
    /// `kind` is the stream's `source_type` when the portal gives it: a window, a screen, or
    /// a virtual source, which is the window when only windows were offered (Hyprland's portal
    /// reports a shared window so) and a screen otherwise. Without it a dialog that offered only
    /// windows shared one, and a dialog that offered both shared a window only when the desktop
    /// recorded one. Unsure means a screen, which is view-only.
    pub fn new(kind: Option<u32>, offered: u32, recorded: Option<Recorded>) -> Self {
        let display = match kind {
            Some(SOURCE_WINDOW) => false,
            Some(SOURCE_MONITOR) => true,
            Some(_) | None => offered != SOURCE_WINDOW && recorded.is_none(),
        };
        Self {
            display,
            app: if display { None } else { recorded },
        }
    }
    pub fn json(&self) -> Json {
        match &self.app {
            Some(app) => {
                json!({"source":"window","bundleId":app.app_id,"title":app.title})
            }
            None => json!({"source": if self.display { "display" } else { "window" }}),
        }
    }
}

/// The app id a desktop records: GNOME's shell names apps by their `.desktop` file.
pub fn desktop_id(app_id: &str) -> Option<String> {
    let id = app_id.trim();
    let id = id.strip_suffix(".desktop").unwrap_or(id);
    (!id.is_empty() && id.len() <= 256).then(|| id.to_owned())
}

/// Reads the window a GNOME restore record describes: `("GNOME", version, (…, a(uuv)))` where
/// a window stream is `(id, 2, (app_id, title))`. Anything else is not understood.
pub fn parse_recorded(data: &Value<'_>) -> Option<Recorded> {
    let outer = unwrap(data);
    let Value::Structure(outer) = outer else {
        return None;
    };
    let fields = outer.fields();
    if !matches!(fields.first().map(unwrap), Some(Value::Str(s)) if s.as_str() == "GNOME") {
        return None;
    }
    let Value::Structure(restore) = unwrap(fields.get(2)?) else {
        return None;
    };
    let streams = restore
        .fields()
        .iter()
        .find_map(|field| match unwrap(field) {
            Value::Array(array) => Some(array),
            _ => None,
        })?;
    for stream in streams.iter() {
        let Value::Structure(stream) = unwrap(stream) else {
            continue;
        };
        let parts = stream.fields();
        if !matches!(parts.get(1).map(unwrap), Some(Value::U32(SOURCE_WINDOW))) {
            continue;
        }
        let Some(Value::Structure(window)) = parts.get(2).map(unwrap) else {
            continue;
        };
        if let [app, title, ..] = window.fields() {
            if let (Value::Str(app), Value::Str(title)) = (unwrap(app), unwrap(title)) {
                return Some(Recorded {
                    app_id: desktop_id(app.as_str())?,
                    title: title.as_str().chars().take(1024).collect(),
                });
            }
        }
    }
    None
}

fn unwrap<'a>(value: &'a Value<'a>) -> &'a Value<'a> {
    match value {
        Value::Value(inner) => unwrap(inner),
        other => other,
    }
}

/// What the desktop recorded with this restore token, read from the permission store's
/// `table` (`remote-desktop` or `screencast`) the portal keeps it in. Best effort: a desktop
/// without such a record gives `None`.
pub async fn recorded_choice(conn: &Connection, table: &str, token: &str) -> Option<Recorded> {
    let store = Proxy::new(
        conn,
        "org.freedesktop.impl.portal.PermissionStore",
        "/org/freedesktop/impl/portal/PermissionStore",
        "org.freedesktop.impl.portal.PermissionStore",
    )
    .await
    .ok()?;
    let args = (table, token);
    let lookup = store.call::<_, _, (std::collections::HashMap<String, Vec<String>>, OwnedValue)>(
        "Lookup", &args,
    );
    let (_, data) = tokio::time::timeout(std::time::Duration::from_secs(2), lookup)
        .await
        .ok()?
        .ok()?;
    parse_recorded(&data)
}

#[cfg(test)]
#[path = "portal_choice_tests.rs"]
mod tests;
