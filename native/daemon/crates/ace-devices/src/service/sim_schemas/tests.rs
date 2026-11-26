// SPDX-License-Identifier: Apache-2.0
//! The `sim_*` tools' bounds and `sim_act`'s field rules (`sim-schemas.ts`).
//!
//! The schemas' Zod decoding is D5's; these cases cover the table both the tool
//! path and the CLI read.

use super::{TOOL_NAMES, action_rule, point_issue};

#[test]
fn each_action_names_the_fields_it_requires_and_allows() {
    assert_eq!(action_rule("ui").expect("ui").required, ["ref"]);
    assert_eq!(
        action_rule("swipe").expect("swipe").required,
        ["x", "y", "toX", "toY"]
    );
    assert!(action_rule("tap").expect("tap").required.is_empty());
    assert!(
        action_rule("type")
            .expect("type")
            .required
            .contains(&"text")
    );
    assert!(
        action_rule("clipboard_set")
            .expect("set")
            .allowed
            .contains(&"text")
    );
    // The base fields are always allowed; the routed `machine` too.
    for action in ["ui", "tap", "type", "posture"] {
        let rule = action_rule(action).expect(action);
        assert!(rule.allowed.contains(&"simId"), "{action}");
        assert!(rule.allowed.contains(&"machine"), "{action}");
    }
    // A recording takes nothing.
    assert_eq!(
        action_rule("record_start").expect("start").required,
        [&[] as &[&str]; 0].concat()
    );
    assert!(action_rule("mystery").is_none());
}

#[test]
fn a_tap_or_long_press_needs_a_ref_or_both_coordinates() {
    assert_eq!(point_issue("tap", false, true, true), None);
    assert_eq!(point_issue("tap", true, false, false), None);
    assert_eq!(
        point_issue("tap", false, true, false),
        Some(String::from("tap needs either ref or both x and y"))
    );
    assert_eq!(
        point_issue("tap", true, true, true),
        Some(String::from("tap needs either ref or both x and y"))
    );
    assert_eq!(
        point_issue("long_press", false, false, false),
        Some(String::from("long_press needs either ref or both x and y"))
    );
    // Only a tap and a long press are located this way.
    assert_eq!(point_issue("type", false, false, false), None);
    assert_eq!(point_issue("swipe", false, false, false), None);
}

#[test]
fn the_seven_tool_names_are_the_family() {
    assert_eq!(
        TOOL_NAMES,
        [
            "sim_list",
            "sim_start",
            "sim_stop",
            "sim_ui",
            "sim_act",
            "sim_screenshot",
            "sim_logs"
        ]
    );
}
