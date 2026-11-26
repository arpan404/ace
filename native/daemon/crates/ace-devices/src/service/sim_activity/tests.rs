// SPDX-License-Identifier: Apache-2.0
//! What a viewer is told about one agent action (`sim-activity.ts`): a point, a
//! ref, a label, never the typed text.
//!
//! `sim-activity.ts` has no test file of its own (behaviour.md §5 lists none),
//! so these cases are the module's only guard.

use super::{SimAct, sim_activity};
use crate::service::cowork::Point;
use crate::service::sim_refs::{Bounds, SimElement};
use ace_json::JsString;

fn element(name: &str) -> SimElement {
    SimElement {
        reference: String::from("r1"),
        role: JsString::from("Button"),
        name: JsString::from(name),
        bounds: Bounds {
            x: 10.0,
            y: 20.0,
            w: 100.0,
            h: 50.0,
        },
        actions: vec![String::from("press")],
    }
}

fn act(action: &str) -> SimAct {
    SimAct {
        action: action.to_owned(),
        reference: None,
        ui_action: None,
        x: None,
        y: None,
        to_x: None,
        to_y: None,
        key: None,
    }
}

#[test]
fn an_element_ref_reports_its_centre_and_label() {
    let mut args = act("tap");
    args.reference = Some(String::from("@e3"));
    let activity = sim_activity(&args, Some(&element("Save"))).expect("an activity");
    assert_eq!(activity.action.as_str(), "tap");
    assert_eq!(activity.point, Some(Point { x: 60.0, y: 45.0 }));
    assert_eq!(
        activity.reference.as_ref().map(JsString::as_str),
        Some("e3")
    );
    assert_eq!(activity.label.as_ref().map(JsString::as_str), Some("Save"));

    // A UI action names itself; `ui` defaults to press.
    let mut ui = act("ui");
    ui.reference = Some(String::from("e3"));
    assert_eq!(
        sim_activity(&ui, Some(&element("Save"))).map(|a| a.action.as_str().to_owned()),
        Some(String::from("press"))
    );
    ui.ui_action = Some(String::from("setValue"));
    assert_eq!(
        sim_activity(&ui, Some(&element("Save"))).map(|a| a.action.as_str().to_owned()),
        Some(String::from("setValue"))
    );

    // An unnamed element carries no label.
    let activity = sim_activity(&args, Some(&element(""))).expect("an activity");
    assert_eq!(activity.label, None);
}

#[test]
fn typed_text_is_never_in_the_activity() {
    let mut args = act("type");
    args.reference = Some(String::from("@e3"));
    let activity = sim_activity(&args, Some(&element("Password"))).expect("an activity");
    assert_eq!(activity.action.as_str(), "type");
    assert_eq!(
        activity.label.as_ref().map(JsString::as_str),
        Some("Password")
    );
    // The typed text is not a field at all, so it cannot leak.
    assert_eq!(activity.key, None);

    let mut plain = act("type");
    plain.reference = None;
    let activity = sim_activity(&plain, None).expect("an activity");
    assert_eq!(activity.action.as_str(), "type");
    assert_eq!(activity.point, None);
}

#[test]
fn a_coordinate_tap_and_swipe_report_their_points() {
    let mut tap = act("tap");
    tap.x = Some(12.0);
    tap.y = Some(34.0);
    let activity = sim_activity(&tap, None).expect("an activity");
    assert_eq!(activity.point, Some(Point { x: 12.0, y: 34.0 }));
    assert_eq!(activity.to, None);

    // A long press shows as `longPress`.
    let mut press = act("long_press");
    press.x = Some(1.0);
    press.y = Some(2.0);
    assert_eq!(
        sim_activity(&press, None).map(|a| a.action.as_str().to_owned()),
        Some(String::from("longPress"))
    );

    let mut swipe = act("swipe");
    swipe.x = Some(1.0);
    swipe.y = Some(2.0);
    swipe.to_x = Some(30.0);
    swipe.to_y = Some(40.0);
    let activity = sim_activity(&swipe, None).expect("an activity");
    assert_eq!(activity.point, Some(Point { x: 1.0, y: 2.0 }));
    assert_eq!(activity.to, Some(Point { x: 30.0, y: 40.0 }));

    // One end without the other is no end.
    swipe.to_y = None;
    assert_eq!(sim_activity(&swipe, None).and_then(|a| a.to), None);
}

#[test]
fn a_half_located_or_app_level_action_shows_nothing() {
    let mut tap = act("tap");
    tap.x = Some(1.0);
    assert_eq!(
        sim_activity(&tap, None),
        None,
        "a tap needs both coordinates"
    );

    for action in [
        "open_app",
        "open_url",
        "install",
        "record_start",
        "clipboard_get",
    ] {
        assert_eq!(sim_activity(&act(action), None), None, "{action}");
    }
    // A key press shows its key.
    let mut key = act("key");
    key.key = Some(String::from("home"));
    assert_eq!(
        sim_activity(&key, None)
            .and_then(|a| a.key)
            .map(|k| k.as_str().to_owned()),
        Some(String::from("home"))
    );
    assert_eq!(
        sim_activity(&act("key"), None),
        None,
        "a key press needs its key"
    );
}

#[test]
fn a_long_label_is_cut_in_utf16_units() {
    // 127 units, then an emoji: `.slice(0, 128)` keeps its high surrogate.
    let name = format!("{}😀tail", "a".repeat(127));
    let mut args = act("tap");
    args.reference = Some(String::from("@e3"));
    let activity = sim_activity(&args, Some(&element(&name))).expect("an activity");
    let label = activity.label.expect("a label");
    assert_eq!(label.len_utf16(), 128);
}
