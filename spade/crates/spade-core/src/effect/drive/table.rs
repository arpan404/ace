//! Where each operation of ace's driving tools acts, as ace's own implementation decides it
//! (ADR 0171, amendment 3; the table in spade/docs/autonomy.md). One row per tool and operation:
//! what the gate reads to find the place, and whether ace must hold the step there. The gate
//! reads only the fields its row names, so a field an operation ignores (a `url` on a tab's
//! close) can't steer it. A tool or operation not in the table has no place. Pure.

use serde_json::Value;

/// How the gate finds where one operation acts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Finds {
    /// The tab the call names (`tabId`), else the caller's current tab, as ace lists them now.
    Tab,
    /// The caller's current tab, whatever the call names (the operation ignores `tabId`).
    CurrentTab,
    /// The tab the call names (`tabId`); without one, no place.
    NamedTab,
    /// The tab whose dialog the call answers (`dialogId`): ace sends the answer there.
    DialogTab,
    /// The address it opens (`url`); without one, no place.
    Opens,
    /// The address it opens (`url`), else the tab it reports (`tabId`, else current).
    OpensElseTab,
    /// The tab it selects (`tabId`), or the address it then opens there (`url`).
    SelectsTab,
    /// Every app ace could open for the name the call gives (`app`).
    App,
    /// The app an older screen tool opens, by its id (`bundleId`).
    AppById,
    /// The whole browser and every tab in it: always the person's.
    Browser,
    /// A simulator or device itself (`simId`).
    Device,
    /// The app a device is told to open (`simId`, `appId`).
    DeviceApp,
    /// The address a device is told to open (`simId`, `url`).
    DeviceUrl,
    /// No place Spade can name; the line says why.
    Nowhere(&'static str),
}

/// One tool's operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Operation {
    pub tool: &'static str,
    /// The value of the tool's operation field ([`OP_FIELDS`]); `None` for a tool with one
    /// operation, or the row a missing field defaults to.
    pub op: Option<&'static str>,
    pub finds: Finds,
    /// It sends input to the page or app, or picks a tab to change, so ace must hold it to
    /// the place the gate found before only the reviewer may let it run.
    pub holds: bool,
}

const fn row(tool: &'static str, op: Option<&'static str>, finds: Finds, holds: bool) -> Operation {
    Operation {
        tool,
        op,
        finds,
        holds,
    }
}

pub const CLOSES_BROWSER: &str = "It closes the whole browser and every tab in it, so you decide.";
pub const STOPS_RECORDING: &str =
    "It stops the browser's recording wherever it runs, so you decide.";
pub const WHOLE_BROWSER: &str = "It acts on the whole browser, not one tab, so you decide.";
pub const LEGACY_SCREEN: &str =
    "It acts through an older screen tool Spade can't tell the app of, so you decide.";
pub const NO_URL: &str = "It opens a tab with no address yet, so you decide.";

/// The field that names a tool's operation, and the operation a missing field means.
pub const OP_FIELDS: &[(&str, &str, Option<&str>)] = &[
    ("browser_act", "action", None),
    ("browser_tabs", "action", Some("list")),
    ("browser_history", "direction", Some("list")),
    ("browser_settings", "action", None),
    ("sim_act", "action", None),
];

use Finds::*;

/// Every operation of ace's driving tools that isn't read-only, and where it acts.
pub const TABLE: &[Operation] = &[
    row("browser_open", None, OpensElseTab, false),
    row("browser_tabs", Some("list"), CurrentTab, false),
    row("browser_tabs", Some("open"), Opens, false),
    row("browser_tabs", Some("select"), SelectsTab, true),
    row("browser_tabs", Some("keep"), NamedTab, true),
    row("browser_tabs", Some("close"), NamedTab, true),
    row("browser_act", Some("dialog"), DialogTab, true),
    row("browser_act", Some("click"), Tab, true),
    row("browser_act", Some("type"), Tab, true),
    row("browser_act", Some("fill_form"), Tab, true),
    row("browser_act", Some("press"), Tab, true),
    row("browser_act", Some("hover"), Tab, true),
    row("browser_act", Some("select"), Tab, true),
    row("browser_act", Some("check"), Tab, true),
    row("browser_act", Some("uncheck"), Tab, true),
    row("browser_act", Some("drag"), Tab, true),
    row("browser_act", Some("focus"), Tab, true),
    row("browser_act", Some("upload"), Tab, true),
    row("browser_act", Some("scroll"), Tab, true),
    row("browser_evaluate", None, Tab, true),
    row("browser_history", Some("back"), Tab, true),
    row("browser_history", Some("forward"), Tab, true),
    row("browser_history", Some("reload"), Tab, true),
    row("browser_history", Some("stop"), Tab, true),
    row("browser_history", Some("list"), Tab, false),
    row("browser_measure", None, Tab, true),
    row("browser_settings", Some("resize"), Tab, false),
    row("browser_settings", Some("emulate"), Tab, false),
    row("browser_settings", Some("record_start"), Tab, false),
    // ace stops the session's recording and lists the browser's extensions whatever tab the
    // call names: neither acts in one tab.
    row(
        "browser_settings",
        Some("record_stop"),
        Nowhere(STOPS_RECORDING),
        false,
    ),
    row(
        "browser_settings",
        Some("extensions"),
        Nowhere(WHOLE_BROWSER),
        false,
    ),
    row("browser_settings", Some("close"), Browser, false),
    row("browser_request_help", None, NamedTab, false),
    row("screen_state", None, App, true),
    row("screen_act", None, App, true),
    row("screen_open_app", None, AppById, false),
    row("screen_ui_act", None, Nowhere(LEGACY_SCREEN), false),
    row("screen_input", None, Nowhere(LEGACY_SCREEN), false),
    row("screen_measure", None, Nowhere(LEGACY_SCREEN), false),
    row("sim_start", None, Device, false),
    row("sim_stop", None, Device, false),
    row("sim_act", Some("open_app"), DeviceApp, false),
    row("sim_act", Some("open_url"), DeviceUrl, false),
    row("sim_act", Some("install"), Device, false),
    row("sim_act", Some("record_start"), Device, false),
    row("sim_act", Some("record_stop"), Device, false),
    row("sim_act", Some("posture"), Device, false),
    row("sim_act", Some("ui"), Nowhere(super::DEVICE_INPUT), false),
    row("sim_act", Some("tap"), Nowhere(super::DEVICE_INPUT), false),
    row(
        "sim_act",
        Some("long_press"),
        Nowhere(super::DEVICE_INPUT),
        false,
    ),
    row(
        "sim_act",
        Some("swipe"),
        Nowhere(super::DEVICE_INPUT),
        false,
    ),
    row("sim_act", Some("type"), Nowhere(super::DEVICE_INPUT), false),
    row("sim_act", Some("key"), Nowhere(super::DEVICE_INPUT), false),
    row(
        "sim_act",
        Some("clipboard_get"),
        Nowhere(super::DEVICE_INPUT),
        false,
    ),
    row(
        "sim_act",
        Some("clipboard_set"),
        Nowhere(super::DEVICE_INPUT),
        false,
    ),
];

/// The row for this call: its tool, and the operation its operation field names (or the one
/// a missing field means). `None` for a tool or operation the table doesn't know.
pub fn operation(tool: &str, arguments: &Value) -> Option<&'static Operation> {
    let op = match OP_FIELDS.iter().find(|(name, ..)| *name == tool) {
        Some((_, field, default)) => match arguments.get(*field) {
            Some(Value::String(op)) => Some(op.as_str()),
            None | Some(Value::Null) => *default,
            // An operation that isn't a word: none the table knows.
            Some(_) => return None,
        },
        None => None,
    };
    TABLE.iter().find(|row| row.tool == tool && row.op == op)
}
