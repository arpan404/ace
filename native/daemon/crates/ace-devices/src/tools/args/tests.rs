// SPDX-License-Identifier: Apache-2.0
//! The `sim_*` arguments (`sim-schemas.ts`): the same acceptance, the same bounds
//! and the same `invalid_arguments` issues as the Zod schemas.
//!
//! `sim-tools.process` (a) is the family's proof through MCP; these cases are the
//! decoding's own, including the rejection cases the schemas pin.

use ace_json::{Value, json};

use super::{ActAction, ActKey, ActPosture, ActValue, Args, SimTool, decode};

fn act(args: Value) -> Result<super::ActArgs, super::ArgumentError> {
    match decode(SimTool::Act, &args) {
        Ok(Args::Act(args)) => Ok(args),
        Ok(other) => panic!("expected act args, got {other:?}"),
        Err(error) => Err(error),
    }
}

fn issue_paths(error: &super::ArgumentError) -> Vec<(&str, &str)> {
    error
        .issues
        .iter()
        .map(|issue| (issue.path.as_str(), issue.expected.as_str()))
        .collect()
}

const IOS: &str = "ios:0F0E0D0C-0B0A-4908-8706-050403020100";

#[test]
fn every_tool_decodes_its_smallest_valid_call() {
    assert_eq!(decode(SimTool::List, &json!({})), Ok(Args::List));
    assert_eq!(
        decode(SimTool::Start, &json!({ "simId": IOS })),
        Ok(Args::Start(super::StartArgs {
            sim_id: IOS.to_owned(),
            boot: true
        }))
    );
    assert_eq!(
        decode(SimTool::Stop, &json!({ "simId": IOS })),
        Ok(Args::Stop(super::DeviceArgs {
            sim_id: IOS.to_owned()
        }))
    );
    assert_eq!(
        decode(SimTool::Screenshot, &json!({ "simId": IOS })),
        Ok(Args::Screenshot(super::DeviceArgs {
            sim_id: IOS.to_owned()
        }))
    );
    // The read's own defaults (`uiReadShape`).
    assert_eq!(
        decode(SimTool::Ui, &json!({ "simId": IOS })),
        Ok(Args::Ui(super::UiArgs {
            sim_id: IOS.to_owned(),
            role: None,
            name: None,
            text: None,
            limit: 16,
            max_depth: 8,
            max_nodes: 128
        }))
    );
    assert_eq!(
        decode(SimTool::Logs, &json!({ "simId": IOS })),
        Ok(Args::Logs(super::LogsArgs {
            sim_id: IOS.to_owned(),
            limit: 100
        }))
    );
    // An Android name is an id too.
    assert_eq!(
        decode(SimTool::Stop, &json!({ "simId": "android:emulator-5554" })),
        Ok(Args::Stop(super::DeviceArgs {
            sim_id: String::from("android:emulator-5554")
        }))
    );
}

#[test]
fn a_device_id_must_name_a_platform() {
    for bad in ["", "Pixel 9", "ios:not-a-uuid", "android:", "android:a b"] {
        let error = decode(SimTool::Stop, &json!({ "simId": bad })).expect_err(bad);
        assert!(
            error.issues.iter().any(|issue| issue.path == "simId"),
            "{bad}"
        );
    }
    // The longest Android name the schema allows.
    let longest = format!("android:{}", "a".repeat(200));
    decode(SimTool::Stop, &json!({ "simId": longest })).expect("200 units");
    let longer = format!("android:{}", "a".repeat(201));
    decode(SimTool::Stop, &json!({ "simId": longer })).expect_err("201 units");
}

#[test]
fn an_unknown_field_names_the_fields_here() {
    let error = decode(SimTool::Stop, &json!({ "simId": IOS, "machine": "m1" })).expect_err("x");
    assert!(error.shape, "an unknown field is a shape issue");
    assert_eq!(
        issue_paths(&error),
        [("machine", "no such field; fields here: simId")]
    );
    // The act object takes every field it declares; the action decides which are used.
    let error = act(json!({ "simId": IOS, "action": "record_start", "text": "x" })).expect_err("x");
    assert!(!error.shape, "a declared field is not a shape issue");
    assert_eq!(
        issue_paths(&error),
        [("text", "Not used when action is record_start")]
    );
}

#[test]
fn a_missing_field_is_required() {
    let error = decode(SimTool::Start, &json!({})).expect_err("no simId");
    assert_eq!(issue_paths(&error), [("simId", "required string, missing")]);
    let error = act(json!({ "simId": IOS })).expect_err("no action");
    assert_eq!(
        issue_paths(&error),
        [("action", "required string, missing")]
    );
}

#[test]
fn a_point_is_an_integer_in_range() {
    for good in [0.0, 12.0, 16_384.0] {
        act(json!({ "simId": IOS, "action": "tap", "x": good, "y": good })).expect("in range");
    }
    let error =
        act(json!({ "simId": IOS, "action": "tap", "x": 16_385, "y": 0 })).expect_err("big");
    assert!(
        error
            .issues
            .iter()
            .any(|issue| issue.path == "x" && issue.expected == "number <= 16384")
    );
    let error =
        act(json!({ "simId": IOS, "action": "tap", "x": 1.5, "y": 0 })).expect_err("fraction");
    assert!(
        error
            .issues
            .iter()
            .any(|issue| issue.path == "x" && issue.expected == "number")
    );
    // A duration is 1 to 10,000.
    let error = act(json!({
        "simId": IOS, "action": "long_press", "x": 1, "y": 1, "durationMs": 0
    }))
    .expect_err("zero");
    assert!(
        error
            .issues
            .iter()
            .any(|issue| issue.path == "durationMs" && issue.expected == "number >= 1")
    );
}

#[test]
fn a_ref_must_look_like_an_element_ref() {
    let args = act(json!({ "simId": IOS, "action": "tap", "ref": "@e3" })).expect("a ref");
    assert_eq!(args.reference.as_deref(), Some("@e3"));
    for bad in ["e0", "e01", "e12345678", "button"] {
        let error = act(json!({ "simId": IOS, "action": "tap", "ref": bad })).expect_err(bad);
        assert!(
            error.issues.iter().any(|issue| issue.path == "ref"
                && issue.expected == "a string matching ^@?e[1-9]\\d{0,6}$"),
            "{bad}: {:?}",
            error.issues
        );
    }
}

#[test]
fn an_action_takes_only_its_own_fields() {
    // A field the action does not use.
    let error = act(json!({ "simId": IOS, "action": "tap", "x": 1, "y": 1, "text": "x" }))
        .expect_err("text is not a tap field");
    assert_eq!(
        issue_paths(&error),
        [("text", "Not used when action is tap")]
    );

    // A field the action requires.
    let error =
        act(json!({ "simId": IOS, "action": "ui" })).expect_err("the ui action needs its ref");
    assert_eq!(issue_paths(&error), [("ref", "Required when action is ui")]);

    // Every required field of a swipe.
    let error = act(json!({ "simId": IOS, "action": "swipe" })).expect_err("no coordinates");
    assert_eq!(
        issue_paths(&error),
        [
            ("x", "Required when action is swipe"),
            ("y", "Required when action is swipe"),
            ("toX", "Required when action is swipe"),
            ("toY", "Required when action is swipe"),
        ]
    );
}

#[test]
fn a_tap_needs_a_ref_or_both_coordinates() {
    let error = act(json!({ "simId": IOS, "action": "tap", "x": 1 })).expect_err("half a point");
    assert_eq!(
        issue_paths(&error),
        [("ref", "tap needs either ref or both x and y")]
    );
    let error = act(json!({
        "simId": IOS, "action": "long_press", "ref": "@e3", "x": 1, "y": 1
    }))
    .expect_err("a ref and a point");
    assert_eq!(
        issue_paths(&error),
        [("ref", "long_press needs either ref or both x and y")]
    );
    // Other actions are not located this way.
    act(json!({ "simId": IOS, "action": "type", "text": "hi" })).expect("a type");
    act(json!({ "simId": IOS, "action": "record_start" })).expect("a recording");
}

#[test]
fn a_ui_read_and_a_log_limit_keep_their_bounds() {
    let error = decode(SimTool::Ui, &json!({ "simId": IOS, "limit": 65 })).expect_err("limit");
    assert_eq!(issue_paths(&error), [("limit", "number <= 64")]);
    let error = decode(SimTool::Ui, &json!({ "simId": IOS, "maxDepth": 17 })).expect_err("depth");
    assert_eq!(issue_paths(&error), [("maxDepth", "number <= 16")]);
    let error = decode(SimTool::Logs, &json!({ "simId": IOS, "limit": 0 })).expect_err("limit");
    assert_eq!(issue_paths(&error), [("limit", "number >= 1")]);
    // An empty role is below its minimum.
    let error = decode(SimTool::Ui, &json!({ "simId": IOS, "role": "" })).expect_err("empty");
    assert_eq!(issue_paths(&error), [("role", "string >= 1 in length")]);
}

#[test]
fn the_act_enums_and_values_decode() {
    let args = act(json!({
        "simId": IOS, "action": "key", "key": "volumeUp"
    }))
    .expect("a key");
    assert_eq!(args.action, ActAction::Key);
    assert_eq!(args.key, Some(ActKey::VolumeUp));

    let args = act(json!({ "simId": IOS, "action": "posture", "posture": "partiallyOpen" }))
        .expect("a posture");
    assert_eq!(args.posture, Some(ActPosture::PartiallyOpen));

    // A scroll value keeps its defaults.
    let args = act(json!({
        "simId": IOS, "action": "ui", "ref": "@e3", "uiAction": "scroll", "value": { "dy": 3 }
    }))
    .expect("a scroll");
    assert_eq!(args.value, Some(ActValue::Scroll { dx: 0, dy: 3 }));

    let args = act(json!({
        "simId": IOS, "action": "ui", "ref": "@e3", "uiAction": "setValue", "value": "hello"
    }))
    .expect("text");
    assert_eq!(args.value, Some(ActValue::Text(String::from("hello"))));

    // An unknown action names the values it could be.
    let error = act(json!({ "simId": IOS, "action": "swipee" })).expect_err("unknown");
    assert!(error.issues.iter().any(
        |issue| issue.path == "action" && issue.expected.starts_with("one of \"ui\", \"tap\"")
    ));
    // An unknown key names its values too.
    let error =
        act(json!({ "simId": IOS, "action": "key", "key": "escape" })).expect_err("unknown");
    assert!(
        error
            .issues
            .iter()
            .any(|issue| issue.path == "key" && issue.expected.starts_with("one of \"home\""))
    );
}
