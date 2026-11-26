// SPDX-License-Identifier: Apache-2.0
//! What a viewer is told about one agent action (`packages/devices/src/sim-activity.ts`),
//! before the session numbers it. Typed text is never included: it may be a
//! password.

use super::cowork::Point;
use super::sim_refs::SimElement;
use ace_json::JsString;

/// The `sim_act` fields this module reads.
#[derive(Debug, Clone, PartialEq)]
pub struct SimAct {
    pub action: String,
    pub reference: Option<String>,
    pub ui_action: Option<String>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub to_x: Option<f64>,
    pub to_y: Option<f64>,
    pub key: Option<String>,
}

/// One agent action as viewers see it (`DeviceActivity` without its sequence).
#[derive(Debug, Clone, PartialEq)]
pub struct Activity {
    pub action: JsString,
    pub point: Option<Point>,
    pub to: Option<Point>,
    pub reference: Option<JsString>,
    pub label: Option<JsString>,
    pub key: Option<JsString>,
}

/// The action name a `sim_act` action shows (`sim-activity.ts:11`-`:17`).
fn action_name(action: &str) -> Option<&'static str> {
    Some(match action {
        "tap" => "tap",
        "long_press" => "longPress",
        "swipe" => "swipe",
        "type" => "type",
        "key" => "key",
        _ => return None,
    })
}

/// `centre`: the element's middle, in device points.
fn centre(element: &SimElement) -> Point {
    Point {
        x: element.bounds.x + element.bounds.w / 2.0,
        y: element.bounds.y + element.bounds.h / 2.0,
    }
}

/// `simActivity`: the activity a successful `sim_act` shows a viewer. App-level
/// actions (opening apps or URLs, installs, recordings) show nothing.
pub fn sim_activity(args: &SimAct, element: Option<&SimElement>) -> Option<Activity> {
    if let (Some(element), Some(reference)) = (element, args.reference.as_deref()) {
        let action = if args.action == "ui" {
            args.ui_action.as_deref().unwrap_or("press")
        } else {
            action_name(&args.action)?
        };
        return Some(Activity {
            action: slice_utf16(action, 32),
            point: Some(centre(element)),
            to: None,
            reference: Some(slice_utf16(super::sim_refs::bare(reference), 64)),
            label: non_empty(&element.name).map(|name| slice_utf16(&name, 128)),
            key: None,
        });
    }
    match args.action.as_str() {
        "tap" | "long_press" => {
            let (x, y) = (args.x?, args.y?);
            Some(Activity {
                action: JsString::from(action_name(&args.action)?),
                point: Some(Point { x, y }),
                to: None,
                reference: None,
                label: None,
                key: None,
            })
        }
        "swipe" => {
            let (x, y) = (args.x?, args.y?);
            Some(Activity {
                action: JsString::from("swipe"),
                point: Some(Point { x, y }),
                to: match (args.to_x, args.to_y) {
                    (Some(to_x), Some(to_y)) => Some(Point { x: to_x, y: to_y }),
                    _ => None,
                },
                reference: None,
                label: None,
                key: None,
            })
        }
        "type" => Some(Activity {
            action: JsString::from("type"),
            point: None,
            to: None,
            reference: None,
            label: None,
            key: None,
        }),
        "key" => {
            let key = args.key.as_deref()?;
            Some(Activity {
                action: JsString::from("key"),
                point: None,
                to: None,
                reference: None,
                label: None,
                key: Some(JsString::from(key)),
            })
        }
        _ => None,
    }
}

/// A `JsString`'s text when it is not empty (`element.name ? … : …`).
fn non_empty(value: &JsString) -> Option<JsString> {
    (!value.as_str().is_empty()).then(|| value.clone())
}

/// `.slice(0, units)` in UTF-16 units, keeping a lone high surrogate as it is.
fn slice_utf16(text: &str, units: usize) -> JsString {
    let js = JsString::from(text);
    if js.len_utf16() <= units {
        return js;
    }
    JsString::from_units(&js.units().take(units).collect::<Vec<_>>())
}

#[cfg(test)]
mod tests;
