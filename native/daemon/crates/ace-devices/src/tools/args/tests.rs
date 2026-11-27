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
const ID_PATTERN: &str = r"a string matching /^(?:ios:[\da-fA-F-]{36}|android:[\w.-]{1,200})$/";
const REF_PATTERN: &str = r"a string matching /^@?e[1-9]\d{0,6}$/";
const ACT_ONE_OF: &str = "one of \"ui\", \"tap\", \"long_press\", \"swipe\", \"type\", \"key\", \"open_app\", \"open_url\", \"install\", \"record_start\", \"record_stop\", \"clipboard_get\", \"clipboard_set\", \"posture\"";
const KEY_ONE_OF: &str = "one of \"home\", \"back\", \"rotate\", \"enter\", \"power\", \"recents\", \"volumeUp\", \"volumeDown\", \"action\", \"side\", \"keyboard\"";
const POSTURE_ONE_OF: &str = "one of \"closed\", \"partiallyOpen\", \"open\"";
const UI_ACTION_ONE_OF: &str = "one of \"press\", \"focus\", \"setValue\", \"scroll\", \"expand\", \"select\", \"performSecondaryAction\", \"selectText\"";

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
        decode(SimTool::Start, &json!({ "simId": IOS, "boot": false })),
        Ok(Args::Start(super::StartArgs {
            sim_id: IOS.to_owned(),
            boot: false
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
fn every_tool_refuses_a_root_that_is_not_an_object() {
    for tool in [
        SimTool::List,
        SimTool::Start,
        SimTool::Stop,
        SimTool::Ui,
        SimTool::Act,
        SimTool::Screenshot,
        SimTool::Logs,
    ] {
        for raw in [json!(null), json!([]), json!("x"), json!(3)] {
            let error = decode(tool, &raw).expect_err("not an object");
            assert_eq!(
                issue_paths(&error),
                [("(arguments)", "object")],
                "{}",
                tool.as_str()
            );
        }
    }
}

#[test]
fn a_field_sent_as_null_is_a_wrong_type_not_an_absent_one() {
    let error = decode(SimTool::Start, &json!({ "simId": IOS, "boot": null })).expect_err("null");
    assert_eq!(issue_paths(&error), [("boot", "boolean")]);
    let error = decode(SimTool::Ui, &json!({ "simId": IOS, "role": null })).expect_err("null");
    assert_eq!(issue_paths(&error), [("role", "string")]);
}

#[test]
fn an_unknown_field_names_the_fields_here_or_how_to_remove_it() {
    let error = decode(SimTool::Stop, &json!({ "simId": IOS, "machine": "m1" })).expect_err("x");
    assert!(error.shape, "an unknown field is a shape issue");
    assert_eq!(
        issue_paths(&error),
        [("machine", "no such field; fields here: simId")]
    );

    // `sim_list` has no fields at all, so it says how to remove the one sent.
    let error = decode(SimTool::List, &json!({ "simId": IOS })).expect_err("x");
    assert!(error.shape);
    assert_eq!(
        issue_paths(&error),
        [(
            "simId",
            "no such field: remove it, or check the spelling against the schema"
        )]
    );

    // Every field the act object declares is named once.
    let error =
        act(json!({ "simId": IOS, "action": "record_start", "machine": "m" })).expect_err("x");
    assert!(error.shape);
    assert_eq!(
        issue_paths(&error),
        [(
            "machine",
            "no such field; fields here: simId, action, ref, uiAction, value, name, x, y, toX, toY, durationMs, text, key, appId, url, path, posture"
        )]
    );
}

#[test]
fn an_unknown_keys_path_never_repeats_a_key_the_schema_could_not_own() {
    // `render` shows a path segment only when it looks like a field ace's schema
    // owns (`/^[\w$-]{1,64}$/`); anything else is `<field>`, so an argument cannot
    // come back out through the issue's path.
    let mut args = ace_json::Map::new();
    args.insert("", json!(true));
    args.insert("k".repeat(65), json!(true));
    args.insert("secret.token", json!(true));
    args.insert(
        ace_json::JsString::from_units(&[0x61, 0xd800, 0x62]),
        json!(true),
    );
    let error = decode(SimTool::List, &Value::Object(args)).expect_err("unknown fields");
    assert_eq!(
        error
            .issues
            .iter()
            .map(|issue| issue.path.as_str())
            .collect::<Vec<_>>(),
        ["<field>", "<field>", "<field>", "<field>"]
    );

    // A key that is a field name a schema could own is still named, up to 64 units.
    for key in ["kdash_$1".to_owned(), "k".repeat(64)] {
        let mut args = ace_json::Map::new();
        args.insert(key.as_str(), json!(true));
        let error = decode(SimTool::List, &Value::Object(args)).expect_err("unknown field");
        assert_eq!(issue_paths(&error)[0].0, key.as_str());
    }
}

#[test]
fn a_missing_field_names_the_string_or_the_values_it_could_be() {
    let error = decode(SimTool::Start, &json!({})).expect_err("no simId");
    assert_eq!(issue_paths(&error), [("simId", "required string, missing")]);

    // An enum that is absent answers with its values, as zod's enum does.
    let error = act(json!({ "simId": IOS })).expect_err("no action");
    assert_eq!(
        issue_paths(&error),
        [(
            "action",
            "one of \"ui\", \"tap\", \"long_press\", \"swipe\", \"type\", \"key\", \"open_app\", \"open_url\", \"install\", \"record_start\", \"record_stop\", \"clipboard_get\", \"clipboard_set\", \"posture\""
        )]
    );
    // The required per-action field is named by the action, after the root fields.
    let error = act(json!({ "simId": IOS, "action": "key" })).expect_err("no key");
    assert_eq!(
        issue_paths(&error),
        [("key", "Required when action is key")]
    );
}

#[test]
fn an_enum_field_set_to_anything_but_its_values_names_the_values() {
    // Zod's enum refuses a wrong type with the same list as an unknown string, so an
    // agent sees what to send either way; the per-action rules do not run after it.
    let error = act(json!({ "simId": IOS, "action": null, "x": 1 })).expect_err("null action");
    assert_eq!(issue_paths(&error), [("action", ACT_ONE_OF)]);
    assert!(!error.shape, "an enum's value is not a shape issue");
    for action in [json!(3), json!({}), json!(["tap"])] {
        let error = act(json!({ "simId": IOS, "action": action })).expect_err("not a string");
        assert_eq!(issue_paths(&error), [("action", ACT_ONE_OF)], "{action}");
    }
    for (field, expected) in [
        ("key", KEY_ONE_OF),
        ("posture", POSTURE_ONE_OF),
        ("uiAction", UI_ACTION_ONE_OF),
    ] {
        let mut args = ace_json::Map::new();
        args.insert("simId", json!(IOS));
        args.insert("action", json!("ui"));
        args.insert("ref", json!("@e3"));
        args.insert(field, json!(null));
        let error = act(Value::Object(args)).expect_err(field);
        assert!(
            error
                .issues
                .iter()
                .any(|issue| issue.path == field && issue.expected == expected),
            "{field}: {:?}",
            issue_paths(&error)
        );
    }
}

#[test]
fn a_number_past_the_safe_integer_range_reports_the_int_bound_first() {
    // Zod's `int()` is a safe integer: the safe bound, then the field's own bound,
    // and both continue so the per-action rules still read the field.
    let error = act(json!({ "simId": IOS, "action": "record_start", "x": 9_007_199_254_740_992.0 }))
        .expect_err("too big");
    assert_eq!(
        issue_paths(&error),
        [
            ("x", "int <= 9007199254740991"),
            ("x", "number <= 16384"),
            ("x", "Not used when action is record_start"),
        ]
    );
    let error =
        act(json!({ "simId": IOS, "action": "record_start", "x": -9_007_199_254_740_992.0 }))
            .expect_err("too small");
    assert_eq!(
        issue_paths(&error),
        [
            ("x", "int >= -9007199254740991"),
            ("x", "number >= 0"),
            ("x", "Not used when action is record_start"),
        ]
    );

    // A scroll offset reports both bounds at its own path.
    let error = act(json!({
        "simId": IOS, "action": "ui", "ref": "@e3",
        "value": { "dx": 9_007_199_254_740_992.0 }
    }))
    .expect_err("scroll");
    assert_eq!(
        issue_paths(&error),
        [
            ("value.dx", "int <= 9007199254740991"),
            ("value.dx", "number <= 1000"),
        ]
    );

    // A read limit too.
    let error = decode(SimTool::Ui, &json!({
        "simId": IOS, "limit": 9_007_199_254_740_992.0
    }))
    .expect_err("limit");
    assert_eq!(
        issue_paths(&error),
        [
            ("limit", "int <= 9007199254740991"),
            ("limit", "number <= 64"),
        ]
    );
    let error = decode(SimTool::Logs, &json!({
        "simId": IOS, "limit": -9_007_199_254_740_992.0
    }))
    .expect_err("negative limit");
    assert_eq!(
        issue_paths(&error),
        [
            ("limit", "int >= -9007199254740991"),
            ("limit", "number >= 1"),
        ]
    );

    // A number JSON cannot carry is not a number at all, and stops the field.
    let mut args = ace_json::Map::new();
    args.insert("simId", json!(IOS));
    args.insert("action", json!("record_start"));
    args.insert("x", Value::Number(ace_json::Number::from(f64::INFINITY)));
    let error = act(Value::Object(args)).expect_err("infinite");
    assert_eq!(issue_paths(&error), [("x", "number")]);
}

#[test]
fn a_device_id_keeps_the_schemas_length_and_pattern() {
    // An empty id passes the length bound and fails only the pattern.
    let error = decode(SimTool::Start, &json!({ "simId": "" })).expect_err("empty");
    assert_eq!(issue_paths(&error), [("simId", ID_PATTERN)]);

    // Over 256 units, both the length and the pattern are reported, in that order.
    let long = "x".repeat(257);
    let error = decode(SimTool::Start, &json!({ "simId": long })).expect_err("long");
    assert_eq!(
        issue_paths(&error),
        [("simId", "string <= 256 in length"), ("simId", ID_PATTERN)]
    );

    // The longest Android name the schema allows.
    let longest = format!("android:{}", "a".repeat(200));
    decode(SimTool::Stop, &json!({ "simId": longest })).expect("200 units");
    let longer = format!("android:{}", "a".repeat(201));
    let error = decode(SimTool::Stop, &json!({ "simId": longer })).expect_err("201 units");
    assert_eq!(issue_paths(&error), [("simId", ID_PATTERN)]);

    // JavaScript's `\w` is ASCII, and `\d` is ASCII too.
    let non_ascii_digits = format!("ios:{}", "٣".repeat(36));
    for bad in [
        "Pixel 9",
        "ios:not-a-uuid",
        "android:",
        "android:a b",
        "android:émulateur",
        non_ascii_digits.as_str(),
    ] {
        let error = decode(SimTool::Stop, &json!({ "simId": bad })).expect_err("bad id");
        assert_eq!(issue_paths(&error), [("simId", ID_PATTERN)], "{bad}");
    }
}

#[test]
fn a_ref_is_at_most_seven_digits_with_no_leading_zero() {
    for good in ["e3", "@e3", "e1234567"] {
        act(json!({ "simId": IOS, "action": "tap", "ref": good })).expect(good);
    }
    for bad in ["e0", "e01", "e12345678", "button", "", "e٣"] {
        let error = act(json!({ "simId": IOS, "action": "tap", "ref": bad })).expect_err(bad);
        assert_eq!(issue_paths(&error), [("ref", REF_PATTERN)], "{bad}");
    }
}

#[test]
fn a_point_and_a_duration_are_integers_in_range() {
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
    let error = act(json!({ "simId": IOS, "action": "tap", "x": -1, "y": 0 })).expect_err("neg");
    assert!(
        error
            .issues
            .iter()
            .any(|issue| issue.path == "x" && issue.expected == "number >= 0")
    );
    // A fraction is not an integer, and zod names the type `int`.
    let error = act(json!({ "simId": IOS, "action": "tap", "x": 1.5, "y": 0 })).expect_err("frac");
    assert_eq!(issue_paths(&error), [("x", "int")]);
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
    let error = act(json!({
        "simId": IOS, "action": "long_press", "x": 1, "y": 1, "durationMs": 10_001
    }))
    .expect_err("too long");
    assert!(
        error
            .issues
            .iter()
            .any(|issue| issue.path == "durationMs" && issue.expected == "number <= 10000")
    );
}

#[test]
fn an_action_takes_only_its_own_fields_and_keeps_checking_what_it_read() {
    // A declared field the action does not use.
    let error = act(json!({ "simId": IOS, "action": "tap", "x": 1, "y": 1, "text": "x" }))
        .expect_err("text is not a tap field");
    assert_eq!(
        issue_paths(&error),
        [("text", "Not used when action is tap")]
    );

    // A field that broke its own bound does not stop the per-action rules: zod's
    // bounds continue, so the field is still there and still unused.
    let error = act(json!({ "simId": IOS, "action": "record_start", "x": 16_385 }))
        .expect_err("x is not a record_start field");
    assert_eq!(
        issue_paths(&error),
        [
            ("x", "number <= 16384"),
            ("x", "Not used when action is record_start")
        ]
    );

    // A wrong type aborts the object parse, so the per-action rules never run.
    let error =
        act(json!({ "simId": IOS, "action": "record_start", "x": "bad" })).expect_err("wrong type");
    assert_eq!(issue_paths(&error), [("x", "number")]);
    // The same for an enum value and a union branch.
    let error =
        act(json!({ "simId": IOS, "action": "record_start", "key": "escape" })).expect_err("enum");
    assert_eq!(
        issue_paths(&error),
        [(
            "key",
            "one of \"home\", \"back\", \"rotate\", \"enter\", \"power\", \"recents\", \"volumeUp\", \"volumeDown\", \"action\", \"side\", \"keyboard\""
        )]
    );
    let error =
        act(json!({ "simId": IOS, "action": "record_start", "value": 3 })).expect_err("union");
    assert_eq!(
        issue_paths(&error),
        [("value", "string or boolean or object")]
    );
    assert!(error.shape, "a union failure is a shape issue");

    // Every required field of a swipe, in the schema's order.
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
    // And the one `ui` needs.
    let error = act(json!({ "simId": IOS, "action": "ui" })).expect_err("no ref");
    assert_eq!(issue_paths(&error), [("ref", "Required when action is ui")]);

    // Other actions take no fields at all.
    let none = act(json!({ "simId": IOS, "action": "clipboard_get" })).expect("clipboard");
    assert_eq!(none.action, ActAction::ClipboardGet);
    let error = act(json!({ "simId": IOS, "action": "clipboard_get", "x": 1 })).expect_err("x");
    assert_eq!(
        issue_paths(&error),
        [("x", "Not used when action is clipboard_get")]
    );
}

#[test]
fn a_tap_needs_a_ref_or_both_coordinates_and_never_both() {
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
    // A coordinate that broke its bound is still a coordinate for the rule.
    let error =
        act(json!({ "simId": IOS, "action": "tap", "x": 16_385 })).expect_err("big and alone");
    assert_eq!(
        issue_paths(&error),
        [
            ("x", "number <= 16384"),
            ("ref", "tap needs either ref or both x and y")
        ]
    );
    // A wrong type aborts the rules, so no point issue joins the type issue.
    let error = act(json!({ "simId": IOS, "action": "tap", "x": 1, "y": "2" })).expect_err("type");
    assert_eq!(issue_paths(&error), [("y", "number")]);
    // Other actions are not located this way.
    act(json!({ "simId": IOS, "action": "type", "text": "hi" })).expect("a type");
    act(json!({ "simId": IOS, "action": "record_start" })).expect("a recording");
}

#[test]
fn unused_fields_follow_the_schema_order_whatever_order_they_were_sent() {
    // `perAction` walks the schema's own fields, so the issues it adds do not
    // depend on the order the agent wrote its arguments in.
    let expected = [
        ("name", "Not used when action is tap"),
        ("text", "Not used when action is tap"),
        ("posture", "Not used when action is tap"),
    ];
    let first = act(json!({
        "simId": IOS, "action": "tap", "x": 1, "y": 1,
        "posture": "open", "text": "hi", "name": "n"
    }))
    .expect_err("unused fields");
    assert_eq!(issue_paths(&first), expected);
    let second = act(json!({
        "simId": IOS, "action": "tap", "y": 1,
        "name": "n", "x": 1, "posture": "open", "text": "hi"
    }))
    .expect_err("unused fields");
    assert_eq!(issue_paths(&second), expected);
}

#[test]
fn a_ui_read_and_a_log_limit_keep_their_bounds() {
    let error = decode(SimTool::Ui, &json!({ "simId": IOS, "limit": 65 })).expect_err("limit");
    assert_eq!(issue_paths(&error), [("limit", "number <= 64")]);
    let error = decode(SimTool::Ui, &json!({ "simId": IOS, "maxDepth": 17 })).expect_err("depth");
    assert_eq!(issue_paths(&error), [("maxDepth", "number <= 16")]);
    let error = decode(SimTool::Ui, &json!({ "simId": IOS, "maxNodes": 0 })).expect_err("nodes");
    assert_eq!(issue_paths(&error), [("maxNodes", "number >= 1")]);
    let error = decode(SimTool::Logs, &json!({ "simId": IOS, "limit": 0 })).expect_err("limit");
    assert_eq!(issue_paths(&error), [("limit", "number >= 1")]);
    let error = decode(SimTool::Logs, &json!({ "simId": IOS, "limit": 1.5 })).expect_err("frac");
    assert_eq!(issue_paths(&error), [("limit", "int")]);
    // An empty role is below its minimum.
    let error = decode(SimTool::Ui, &json!({ "simId": IOS, "role": "" })).expect_err("empty");
    assert_eq!(issue_paths(&error), [("role", "string >= 1 in length")]);
}

#[test]
fn the_act_enums_and_text_fields_decode() {
    let args = act(json!({
        "simId": IOS, "action": "key", "key": "volumeUp"
    }))
    .expect("a key");
    assert_eq!(args.action, ActAction::Key);
    assert_eq!(args.key, Some(ActKey::VolumeUp));

    let args = act(json!({ "simId": IOS, "action": "posture", "posture": "partiallyOpen" }))
        .expect("a posture");
    assert_eq!(args.posture, Some(ActPosture::PartiallyOpen));

    // Typed text may be empty, but not over 4,096 code points.
    let args = act(json!({ "simId": IOS, "action": "type", "text": "" })).expect("empty text");
    assert_eq!(args.text.as_deref(), Some(""));
    let long = "😀".repeat(4_096);
    act(json!({ "simId": IOS, "action": "type", "text": long })).expect("4,096 code points");
    let long = "😀".repeat(4_097);
    let error = act(json!({ "simId": IOS, "action": "type", "text": long })).expect_err("over");
    assert_eq!(issue_paths(&error), [("text", "string <= 4096 in length")]);

    // An app id and a path have a one-unit minimum.
    let error = act(json!({ "simId": IOS, "action": "open_app", "appId": "" })).expect_err("empty");
    assert_eq!(issue_paths(&error), [("appId", "string >= 1 in length")]);
    let error = act(json!({ "simId": IOS, "action": "install", "path": "" })).expect_err("empty");
    assert_eq!(issue_paths(&error), [("path", "string >= 1 in length")]);

    // An unknown action names the values it could be.
    let error = act(json!({ "simId": IOS, "action": "swipee" })).expect_err("unknown");
    assert!(error.issues.iter().any(
        |issue| issue.path == "action" && issue.expected.starts_with("one of \"ui\", \"tap\"")
    ));
    assert!(!error.shape, "an enum value is not a shape issue");
}

#[test]
fn a_ui_actions_value_is_text_a_flag_or_a_whole_scroll() {
    let args = act(json!({
        "simId": IOS, "action": "ui", "ref": "@e3", "uiAction": "setValue", "value": "hello"
    }))
    .expect("text");
    assert_eq!(args.value, Some(ActValue::Text(String::from("hello"))));

    let args = act(json!({
        "simId": IOS, "action": "ui", "ref": "@e3", "uiAction": "expand", "value": false
    }))
    .expect("a flag");
    assert_eq!(args.value, Some(ActValue::Flag(false)));

    // A scroll keeps its defaults and strips fields it does not know.
    let args = act(json!({
        "simId": IOS, "action": "ui", "ref": "@e3", "uiAction": "scroll",
        "value": { "dy": 3, "z": 2 }
    }))
    .expect("a scroll");
    assert_eq!(args.value, Some(ActValue::Scroll { dx: 0, dy: 3 }));

    // A value that is none of the three branches names them.
    let error = act(json!({ "simId": IOS, "action": "ui", "ref": "@e3", "value": 3 }))
        .expect_err("a number");
    assert_eq!(
        issue_paths(&error),
        [("value", "string or boolean or object")]
    );
    assert!(error.shape);

    // A branch that fails on a field is the union's generic refusal.
    for bad in [
        json!({ "dy": "3" }),
        json!({ "dy": 1.5 }),
        json!({ "dy": null }),
        json!({ "dx": "a", "dy": 1001 }),
    ] {
        let error = act(json!({ "simId": IOS, "action": "ui", "ref": "@e3", "value": bad }))
            .expect_err("a broken scroll");
        assert_eq!(
            issue_paths(&error),
            [("value", "one of the documented shapes for this field")],
            "{bad}"
        );
        assert!(error.shape);
    }

    // A bound that continues is reported at its own field, and the other bound
    // beside it.
    let error = act(json!({
        "simId": IOS, "action": "ui", "ref": "@e3", "value": { "dx": 1001, "dy": -1001 }
    }))
    .expect_err("out of range");
    assert_eq!(
        issue_paths(&error),
        [
            ("value.dx", "number <= 1000"),
            ("value.dy", "number >= -1000"),
        ]
    );
    assert!(!error.shape);

    // Too much text is its own bound.
    let long = format!("value {}", "x".repeat(4_096));
    let error = act(json!({
        "simId": IOS, "action": "ui", "ref": "@e3", "value": long
    }))
    .expect_err("too long");
    assert_eq!(issue_paths(&error), [("value", "string <= 4096 in length")]);
}

#[test]
fn the_argument_issues_stop_at_sixteen() {
    let mut args = ace_json::Map::new();
    args.insert("simId", json!(IOS));
    args.insert("action", json!("record_start"));
    for index in 0..20 {
        args.insert(format!("k{index}"), json!(index));
    }
    let error = act(Value::Object(args)).expect_err("many unknown fields");
    assert_eq!(error.issues.len(), 16);
    assert_eq!(error.issues[0].path, "k0");
    assert_eq!(error.issues[15].path, "k15");
}

#[test]
fn issues_follow_the_schemas_field_order_before_the_unknowns_and_refinements() {
    // The id's pattern is part of its field, before the next field's type.
    let error =
        decode(SimTool::Start, &json!({ "simId": "bad", "boot": null })).expect_err("both wrong");
    assert_eq!(
        issue_paths(&error),
        [("simId", ID_PATTERN), ("boot", "boolean")]
    );

    // The act object reports its fields in shape order, unknown keys after them,
    // and the per-action rules last.
    let error =
        act(json!({ "simId": "bad", "action": "tap", "ref": "bad", "x": "a" })).expect_err("wrong");
    assert_eq!(
        issue_paths(&error),
        [("simId", ID_PATTERN), ("ref", REF_PATTERN), ("x", "number")]
    );
    let error = act(json!({ "simId": IOS, "action": "tap", "x": 1, "zz": 2 })).expect_err("x");
    assert_eq!(
        issue_paths(&error),
        [
            (
                "zz",
                "no such field; fields here: simId, action, ref, uiAction, value, name, x, y, toX, toY, durationMs, text, key, appId, url, path, posture"
            ),
            ("ref", "tap needs either ref or both x and y"),
        ]
    );
}

#[test]
fn typed_text_keeps_a_lone_surrogate_the_agent_sent() {
    let mut args = ace_json::Map::new();
    args.insert("simId", json!(IOS));
    args.insert("action", json!("type"));
    args.insert(
        "text",
        Value::String(ace_json::JsString::from_units(&[0xd800])),
    );
    let decoded = act(Value::Object(args)).expect("a text");
    let text = decoded.text.expect("the text field");
    let exact = ace_json::JsString::from_rust_text(&text)
        .unwrap_or_else(|| ace_json::JsString::from(text.as_str()));
    assert_eq!(
        ace_json::to_string(&Value::String(exact)),
        "\"\\ud800\"",
        "the wire keeps the unpaired surrogate the agent sent"
    );
}
