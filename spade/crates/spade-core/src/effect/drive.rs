//! Where a driving step acts, resolved right before it, and whether that place is the person's
//! alone (ADR 0171, amendment 3). A `browser_*`, `screen_*` or `sim_*` call ace doesn't mark
//! read-only goes to the reviewer; to the person in mail, chat, money, passwords, settings,
//! sign-in pages, social sites or a browser driven through the screen, and wherever Spade can't
//! tell where it acts. The place is never inferred from earlier answers: a page is the tab the
//! step runs in as ace lists it now, an app is every app ace could open for the name given.
//! The engine asks ace ([`lookup`]) and this module reads the answer ([`read`]). Pure.

pub mod address;
pub mod sensitive;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

/// Where a step acts, as resolved right before it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Place {
    /// An app on the computer, by its id as ace lists it.
    App { id: String, name: String },
    /// A web page.
    Site {
        host: String,
        path: String,
        #[serde(default)]
        fragment: String,
    },
    /// An app a device is told to open (`sim_act open_app`).
    DeviceApp { device: String, app: String },
    /// A device itself (start, stop, install, record, posture).
    Device { device: String },
}

impl Place {
    /// How the request names it.
    pub fn shown(&self) -> &str {
        match self {
            Self::App { name, id } if name.is_empty() => id,
            Self::App { name, .. } => name,
            Self::Site { host, .. } => host,
            Self::DeviceApp { app, .. } => app,
            Self::Device { device } => device,
        }
    }

    /// The grant a "for this bot" answer would make: an app or a site, never a device.
    pub fn grant(&self) -> Option<crate::grant::Scope> {
        use crate::grant::Scope;
        match self {
            Self::App { id, .. } => Some(Scope::DriveApp { app: id.clone() }),
            Self::Site { host, .. } => Some(Scope::DriveSite { host: host.clone() }),
            Self::DeviceApp { .. } | Self::Device { .. } => None,
        }
    }
}

/// A step's place, or why Spade can't tell, and why it is the person's when it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Step {
    pub place: Result<Place, &'static str>,
    pub sensitive: Option<&'static str>,
}

impl Step {
    fn at(place: Place) -> Self {
        let sensitive = sensitive(&place);
        Self {
            place: Ok(place),
            sensitive,
        }
    }

    fn nowhere(why: &'static str) -> Self {
        Self {
            place: Err(why),
            sensitive: None,
        }
    }
}

pub const NO_TAB: &str = "It acts in a browser tab Spade can't find right now, so you decide.";
pub const LOADING: &str = "It acts in a page that is still loading, so you decide.";
pub const NOT_WEB: &str = "It acts in a page that isn't a web address, so you decide.";
pub const NO_APP: &str = "It acts in an app Spade can't tell apart from others, so you decide.";
pub const DEVICE_INPUT: &str =
    "It acts on a device and Spade can't tell which app is open there, so you decide.";
pub const UNPLACED: &str =
    "It acts in a page or app as you and Spade can't tell which, so you decide.";

/// Whether a tool is one of ace's driving families.
pub fn drives(name: &str) -> bool {
    ["browser_", "screen_", "sim_"]
        .iter()
        .any(|prefix| name.starts_with(prefix))
}

/// How to find where a step acts.
#[derive(Debug, Clone, PartialEq)]
pub enum Lookup {
    /// The step names its place itself.
    Named(Step),
    /// Ask ace with `tool` and `arguments` now, then [`read`] its answer.
    Ask {
        tool: &'static str,
        arguments: Value,
    },
}

/// What to ask ace, right before the step, to know where it acts.
pub fn lookup(tool: &str, arguments: &Value) -> Lookup {
    let text = |key: &str| arguments.get(key).and_then(Value::as_str);
    // Where the call runs: another machine, or the person's own Chrome.
    let routed = |mut asked: Map<String, Value>| {
        for key in ["machine", "browser"] {
            if let Some(value) = arguments.get(key) {
                asked.insert(key.to_owned(), value.clone());
            }
        }
        Value::Object(asked)
    };
    if tool.starts_with("sim_") {
        return Lookup::Named(device(tool, arguments));
    }
    if tool.starts_with("browser_") {
        // Opening an address: the page is the one it opens. Anything else acts in a tab as it
        // is now.
        if let Some(url) = text("url") {
            return Lookup::Named(site(url));
        }
        let mut asked = Map::new();
        asked.insert("action".to_owned(), json!("list"));
        return Lookup::Ask {
            tool: "browser_tabs",
            arguments: routed(asked),
        };
    }
    if tool.starts_with("screen_") {
        return match text("app").map(str::trim).filter(|app| !app.is_empty()) {
            Some(app) => {
                let mut asked = Map::new();
                asked.insert("query".to_owned(), json!(app));
                Lookup::Ask {
                    tool: "screen_apps",
                    arguments: routed(asked),
                }
            }
            None => Lookup::Named(Step::nowhere(UNPLACED)),
        };
    }
    Lookup::Named(Step::nowhere(UNPLACED))
}

/// Where the step acts, from ace's `answer` to [`lookup`]'s question (`None`: ace couldn't
/// answer). A [`Lookup::Named`] step reads the same as it was named.
pub fn read(tool: &str, arguments: &Value, answer: Option<&str>) -> Step {
    let ask = match lookup(tool, arguments) {
        Lookup::Named(step) => return step,
        Lookup::Ask { tool: asked, .. } => asked,
    };
    let given = arguments.get("app").and_then(Value::as_str).unwrap_or("");
    match (ask, answer) {
        ("browser_tabs", Some(answer)) => tab(answer, arguments.get("tabId")),
        ("browser_tabs", None) => Step::nowhere(NO_TAB),
        ("screen_apps", answer) => app(given, answer),
        _ => Step::nowhere(UNPLACED),
    }
}

/// The page of the tab a step runs in: its `tabId`, else the caller's current tab, as ace
/// lists them now. A tab that is loading, private or missing has no place yet.
fn tab(answer: &str, wanted: Option<&Value>) -> Step {
    let Ok(listed) = serde_json::from_str::<Value>(answer) else {
        return Step::nowhere(NO_TAB);
    };
    let tabs = listed.get("tabs").and_then(Value::as_array);
    let found = tabs.into_iter().flatten().find(|tab| match wanted {
        Some(wanted) => tab.get("tabId").map(scalar) == Some(scalar(wanted)),
        None => tab.get("current").and_then(Value::as_bool) == Some(true),
    });
    let Some(found) = found else {
        return Step::nowhere(NO_TAB);
    };
    let flag = |key: &str| found.get(key).and_then(Value::as_bool) == Some(true);
    if flag("loading") {
        return Step::nowhere(LOADING);
    }
    if flag("private") {
        return Step::nowhere(NO_TAB);
    }
    match found.get("url").and_then(Value::as_str) {
        Some(url) => site(url),
        None => Step::nowhere(NO_TAB),
    }
}

/// A string or number as text: a tab id is either.
fn scalar(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// A page by its address.
pub fn site(url: &str) -> Step {
    match address::parse(url) {
        Some(found) => Step::at(Place::Site {
            host: found.host,
            path: found.path,
            fragment: found.fragment,
        }),
        None => Step::nowhere(NOT_WEB),
    }
}

/// The apps ace could open for the name `given`, from its list of apps (`Name (id)` rows): every
/// one whose name or id holds the name. Sensitive if the name or any of them is; placed only
/// when it is one app (an exact name or id, or the only match).
fn app(given: &str, answer: Option<&str>) -> Step {
    let named = sensitive::app_given(given);
    let wanted = given.trim().to_lowercase();
    let rows: Vec<(String, String)> = answer
        .into_iter()
        .flat_map(str::lines)
        .filter_map(row)
        .collect();
    let matching: Vec<&(String, String)> = rows
        .iter()
        .filter(|(name, id)| {
            name.to_lowercase().contains(&wanted) || id.to_lowercase().contains(&wanted)
        })
        .collect();
    let sensitive = named.or_else(|| {
        matching.iter().find_map(|(name, id)| {
            sensitive::app_by_name(name).or_else(|| sensitive::app_by_name(id))
        })
    });
    let exact: Vec<&(String, String)> = matching
        .iter()
        .copied()
        .filter(|(name, id)| name.to_lowercase() == wanted || id.to_lowercase() == wanted)
        .collect();
    let one = match (exact.as_slice(), matching.as_slice()) {
        ([one], _) => Some(*one),
        ([], [one]) => Some(*one),
        _ => None,
    };
    let place = match one {
        Some((name, id)) => Ok(Place::App {
            id: id.clone(),
            name: name.clone(),
        }),
        None => Err(NO_APP),
    };
    Step { place, sensitive }
}

/// `Name (id)` or `Name (id), frontmost`.
fn row(line: &str) -> Option<(String, String)> {
    let line = line.trim();
    let line = line.strip_suffix(", frontmost").unwrap_or(line);
    let head = line.strip_suffix(')')?;
    let open = head.rfind(" (")?;
    let id = head[open + 2..].trim();
    let name = head[..open].trim();
    (!id.is_empty()).then(|| (name.to_owned(), id.to_owned()))
}

/// A simulator or device step. ace reports no app in the foreground of a device, so input
/// (a tap, typing, a key, the clipboard) has no place; opening an app or address is placed by
/// what it opens, and the device's own operations by the device.
fn device(tool: &str, arguments: &Value) -> Step {
    let text = |key: &str| {
        arguments
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    let device = || Place::Device {
        device: text("simId").unwrap_or("the device").to_owned(),
    };
    match (tool, text("action")) {
        ("sim_start" | "sim_stop", _) => Step::at(device()),
        ("sim_act", Some("open_app")) => match text("appId") {
            Some(app) => Step::at(Place::DeviceApp {
                device: text("simId").unwrap_or("").to_owned(),
                app: app.to_owned(),
            }),
            None => Step::nowhere(DEVICE_INPUT),
        },
        ("sim_act", Some("open_url")) => match text("url") {
            Some(url) => site(url),
            None => Step::nowhere(NOT_WEB),
        },
        ("sim_act", Some("install" | "record_start" | "record_stop" | "posture")) => {
            Step::at(device())
        }
        _ => Step::nowhere(DEVICE_INPUT),
    }
}

/// Why a place is the person's alone, as the request words it ("mail or messages, where it can
/// send in your name"); `None` where the reviewer may decide.
pub fn sensitive(place: &Place) -> Option<&'static str> {
    match place {
        Place::App { id, name } => sensitive::app_by_name(name)
            .or_else(|| sensitive::app_by_name(id))
            .or_else(|| sensitive::app_given(id)),
        Place::Site {
            host,
            path,
            fragment,
        } => sensitive::site(host, path, fragment),
        Place::DeviceApp { app, .. } => sensitive::app_given(app),
        Place::Device { .. } => None,
    }
}

/// Whether a drive grant for the app id `app` may be made: never for a sensitive one.
pub fn grantable_app(app: &str) -> Result<(), &'static str> {
    if app.trim().is_empty() {
        return Err(UNPLACED);
    }
    match sensitive::app_given(app) {
        Some(why) => Err(why),
        None => Ok(()),
    }
}

/// Whether a drive grant for the site `host` may be made: never for a sensitive one, and only
/// for a host as a browser reads it.
pub fn grantable_site(host: &str) -> Result<(), &'static str> {
    match address::parse(&format!("https://{}/", host.trim())) {
        Some(found) if found.host == host.trim() => match sensitive::site(&found.host, "", "") {
            Some(why) => Err(why),
            None => Ok(()),
        },
        _ => Err(NOT_WEB),
    }
}

#[cfg(test)]
mod tests;
