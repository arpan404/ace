// SPDX-License-Identifier: Apache-2.0
//! One `sim_act` call's refusals and labels (`sim-act.ts`): nothing reaches the
//! device until the ref has been re-read.
//!
//! `sim_act` itself is proven by `sim-tools.process` (a); these cases cover the
//! decisions beside it.

use super::{
    Tap, centre, label, takes_no_ref, tap, ui_needs_ref, unknown_ref, unsupported_ui_action,
    vanished,
};
use crate::error::DeviceErrorCode;
use crate::service::cowork::Point;
use crate::service::sim_refs::{Bounds, SimElement};
use crate::service::words;
use ace_json::JsString;

fn element(name: &str, actions: &[&str]) -> SimElement {
    SimElement {
        reference: String::from("r1"),
        role: JsString::from("Button"),
        name: JsString::from(name),
        bounds: Bounds {
            x: 10.0,
            y: 20.0,
            w: 101.0,
            h: 50.0,
        },
        actions: actions.iter().map(|action| (*action).to_owned()).collect(),
    }
}

#[test]
fn a_ui_action_without_a_ref_is_refused() {
    let refused = ui_needs_ref();
    assert_eq!(refused, words::refusal("uiNeedsRef"));
    assert_eq!(refused.code(), DeviceErrorCode::NotSupported);
}

#[test]
fn an_unknown_ref_is_stale_and_names_the_read() {
    let refused = unknown_ref("@e9", "ios:AAAA");
    assert_eq!(refused.code(), DeviceErrorCode::StaleRef);
    let crate::error::DeviceError::Coded { message, hint, .. } = &refused else {
        panic!("a coded refusal");
    };
    assert_eq!(
        message.as_str(),
        "@e9 is not a ref from your sim_ui reads of ios:AAAA"
    );
    assert_eq!(hint.as_str(), words::tool_hint("simRefUnknownHint"));
}

#[test]
fn a_vanished_element_is_stale_and_names_itself() {
    let refused = vanished("@e3", &element("Save", &["press"]));
    assert_eq!(refused.code(), DeviceErrorCode::StaleRef);
    let crate::error::DeviceError::Coded { message, hint, .. } = &refused else {
        panic!("a coded refusal");
    };
    assert_eq!(
        message.as_str(),
        "@e3 (Button \"Save\") is no longer on screen"
    );
    assert_eq!(hint.as_str(), words::tool_hint("simStaleRefHint"));
}

#[test]
fn a_ui_action_the_element_lacks_names_what_it_supports() {
    let refused = unsupported_ui_action("@e3", &element("Save", &["press", "focus"]), "scroll");
    assert_eq!(refused.code(), DeviceErrorCode::NotSupported);
    let crate::error::DeviceError::Coded { message, hint, .. } = &refused else {
        panic!("a coded refusal");
    };
    assert_eq!(
        message.as_str(),
        "@e3 (Button \"Save\") supports press, focus, not scroll"
    );
    assert_eq!(hint.as_str(), words::tool_hint("simActionUnsupportedHint"));
}

#[test]
fn an_action_that_takes_no_ref_is_refused() {
    let refused = takes_no_ref("open_app");
    assert_eq!(refused.code(), DeviceErrorCode::NotSupported);
    let crate::error::DeviceError::Coded { message, hint, .. } = &refused else {
        panic!("a coded refusal");
    };
    assert_eq!(message.as_str(), "open_app does not take a ref");
    assert_eq!(hint.as_str(), words::tool_hint("simActionNoRefHint"));
}

#[test]
fn a_tap_presses_when_it_can_else_taps_the_middle() {
    assert_eq!(tap(&element("Save", &["press", "focus"])), Tap::Press);
    // The middle is rounded and never negative.
    assert_eq!(
        tap(&element("Save", &["focus"])),
        Tap::Point(Point { x: 61.0, y: 45.0 })
    );
    let offscreen = SimElement {
        bounds: Bounds {
            x: -100.0,
            y: -100.0,
            w: 10.0,
            h: 10.0,
        },
        ..element("Save", &[])
    };
    assert_eq!(tap(&offscreen), Tap::Point(Point { x: 0.0, y: 0.0 }));
    assert_eq!(centre(&element("Save", &[])), Point { x: 61.0, y: 45.0 });
}

#[test]
fn the_label_names_the_element_with_its_name_cut_to_sixty() {
    assert_eq!(label("@e3", &element("Save", &[])), "@e3 (Button \"Save\")");
    // An unnamed element is its role alone.
    assert_eq!(label("e4", &element("", &[])), "@e4 (Button)");
    // A name is cut in UTF-16 units, and a quote is escaped as JSON does.
    let long = format!("{}\"quote", "a".repeat(60));
    let labelled = label("@e5", &element(&long, &[]));
    assert!(labelled.starts_with("@e5 (Button \""));
    assert!(labelled.ends_with("\")"));
    assert_eq!(labelled.matches('a').count(), 60, "cut to sixty units");
}
