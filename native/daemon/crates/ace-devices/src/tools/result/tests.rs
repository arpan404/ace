// SPDX-License-Identifier: Apache-2.0
//! The `sim_*` tools' results (`sim-tools.ts`): the summary, the no-video answer,
//! the how-to's placement, the screenshot's note and the public failure body.
//!
//! `sim-tools.process` (a) proves the tools end to end; these cases cover the
//! decisions the shell renders.

use super::{
    android_without_video, arguments_body, failure_body, public_failure, public_words,
    screenshot_note, summary, with_guidance, without_video,
};
use crate::error::{DeviceErrorCode, DeviceFailure};
use ace_json::{JsString, Number, Value, json};

const IOS: &str = "ios:00000000-0000-4000-8000-000000000001";

fn valid_state() -> Value {
    json!({
        "device": {
            "id": IOS,
            "name": "iPhone 17 Pro",
            "state": "booted",
            "platform": "ios"
        },
        "enabled": true,
        "lifecycle": "live",
        "controller": "agent",
        "posture": "open",
        "streamId": "screen-1"
    })
}

#[test]
fn a_start_or_stop_answers_with_the_summary_not_the_whole_state() {
    let reduced = summary(&valid_state());
    assert_eq!(
        reduced,
        json!({
            "simId": IOS,
            "name": "iPhone 17 Pro",
            "state": "booted",
            "lifecycle": "live",
            "controller": "agent",
            "posture": "open"
        })
    );

    let folded = json!({
        "device": {
            "id": IOS,
            "name": "iPhone",
            "state": "booted",
            "platform": "ios"
        },
        "lifecycle": "live",
        "controller": "none"
    });
    assert_eq!(
        summary(&folded),
        json!({
            "simId": IOS, "name": "iPhone", "state": "booted",
            "lifecycle": "live", "controller": "none"
        })
    );

    let invalid_device = json!({
        "device": { "id": "ios:AAAA", "name": "n", "state": "booted" },
        "lifecycle": "live",
        "controller": "none"
    });
    assert_eq!(summary(&invalid_device), invalid_device);

    let invalid_posture = json!({
        "device": {
            "id": IOS,
            "name": "iPhone",
            "state": "booted",
            "platform": "ios"
        },
        "lifecycle": "live",
        "controller": "none",
        "posture": { "kind": "folded" }
    });
    assert_eq!(summary(&invalid_posture), invalid_posture);

    assert_eq!(summary(&json!("raw")), json!("raw"));
}

#[test]
fn an_invalid_android_id_and_device_fields_are_returned_intact_not_reduced() {
    let non_ascii = json!({
        "device": {
            "id": "android:émulator",
            "name": "Phone",
            "state": "booted",
            "platform": "android"
        },
        "lifecycle": "live",
        "controller": "none"
    });
    assert_eq!(summary(&non_ascii), non_ascii);

    let mut numeric_runtime = valid_state();
    let Value::Object(object) = &mut numeric_runtime else {
        panic!("expected a device state object");
    };
    let Some(Value::Object(device)) = object.get_mut("device") else {
        panic!("expected a device");
    };
    device.insert("runtime".to_owned(), Value::Number(Number::from(42)));
    assert_eq!(summary(&numeric_runtime), numeric_runtime);

    let long_model = json!({
        "device": {
            "id": IOS,
            "name": "Phone",
            "state": "booted",
            "platform": "ios",
            "model": "m".repeat(257)
        },
        "lifecycle": "live",
        "controller": "none"
    });
    assert_eq!(summary(&long_model), long_model);

    let numeric_serial = json!({
        "device": {
            "id": IOS,
            "name": "Phone",
            "state": "booted",
            "platform": "ios",
            "serial": 42
        },
        "lifecycle": "live",
        "controller": "none"
    });
    assert_eq!(summary(&numeric_serial), numeric_serial);

    // Zod counts code points: 257 emoji are over the optional fields' cap.
    let long_serial = json!({
        "device": {
            "id": IOS,
            "name": "Phone",
            "state": "booted",
            "platform": "ios",
            "serial": "📱".repeat(257)
        },
        "lifecycle": "live",
        "controller": "none"
    });
    assert_eq!(summary(&long_serial), long_serial);
}

#[test]
fn an_optional_field_at_the_code_point_cap_passes_validation() {
    // 256 emoji are 256 code points but 512 UTF-16 units: the cap is code points.
    let serial = "📱".repeat(256);
    assert_eq!(serial.chars().count(), 256);
    let state = json!({
        "device": {
            "id": IOS,
            "name": "Phone",
            "state": "booted",
            "platform": "ios",
            "serial": serial
        },
        "lifecycle": "live",
        "controller": "agent"
    });
    let reduced = summary(&state);
    let Value::Object(object) = reduced else {
        panic!("expected a summary");
    };
    assert_eq!(object.get("simId").and_then(Value::as_str), Some(IOS));
    assert_eq!(
        object.get("serial"),
        None,
        "the summary carries no optional fields"
    );
}

#[test]
fn a_name_at_the_code_point_cap_passes_validation() {
    let emoji = "📱";
    let prefix = "x".repeat(255);
    let name = format!("{prefix}{emoji}");
    assert_eq!(name.chars().count(), 256);
    let state = json!({
        "device": {
            "id": IOS,
            "name": name,
            "state": "booted",
            "platform": "ios"
        },
        "lifecycle": "live",
        "controller": "agent"
    });
    let reduced = summary(&state);
    if let Value::Object(object) = reduced {
        assert_eq!(
            object.get("name").and_then(Value::as_str),
            Some(name.as_str())
        );
    } else {
        panic!("expected a summary");
    }
}

#[test]
fn a_summary_keeps_the_original_js_string_bytes_for_a_lone_surrogate() {
    let name = Value::String(JsString::from_units(&[0xD800]));
    let mut state = valid_state();
    let Value::Object(object) = &mut state else {
        panic!("expected a device state object");
    };
    let Some(Value::Object(device)) = object.get_mut("device") else {
        panic!("expected a device");
    };
    device.insert("name".to_owned(), name.clone());
    let reduced = summary(&state);
    if let Value::Object(object) = reduced {
        assert_eq!(object.get("name"), Some(&name));
    } else {
        panic!("expected summary object");
    }
}

#[test]
fn a_live_view_refusal_on_an_android_device_keeps_control() {
    assert!(android_without_video(
        DeviceErrorCode::NotSupported,
        "android:emulator-5554"
    ));
    assert!(!android_without_video(
        DeviceErrorCode::NotSupported,
        "ios:AAAA"
    ));
    assert!(!android_without_video(
        DeviceErrorCode::Busy,
        "android:emulator-5554"
    ));

    let answer = without_video(
        "android:emulator-5554",
        &JsString::from("Android has no live video"),
        &JsString::from("Install scrcpy-server"),
    );
    assert_eq!(
        answer,
        json!({
            "simId": "android:emulator-5554",
            "liveView": "unavailable",
            "reason": "Android has no live video",
            "hint": "Install scrcpy-server",
            "stillWorks": ["sim_act input", "sim_screenshot", "sim_ui"]
        })
    );
}

#[test]
fn the_how_to_spreads_over_an_object_array_or_null_as_typescript_does() {
    // `{ ...started, guide }`: an array spreads to its index keys, and `typeof null` is
    // "object", so null becomes an object holding only the guide.
    let guide = "Driving ios:AAAA.";
    assert_eq!(
        ace_json::to_string(&with_guidance(json!(["a", "b"]), true, guide)),
        "{\"0\":\"a\",\"1\":\"b\",\"guide\":\"Driving ios:AAAA.\"}"
    );
    assert_eq!(
        ace_json::to_string(&with_guidance(json!(null), true, guide)),
        "{\"guide\":\"Driving ios:AAAA.\"}"
    );

    // Without a first start the spread still happens; only the guide is left out.
    assert_eq!(
        with_guidance(json!(["a"]), false, guide),
        json!({ "0": "a" })
    );
    assert_eq!(
        with_guidance(Value::Null, false, guide),
        json!({}),
        "`{{...null}}` is an empty object"
    );
    // A value that is not an object is returned as it is, with or without one.
    for raw in [json!("raw"), json!(3), json!(true)] {
        assert_eq!(with_guidance(raw.clone(), true, guide), raw);
    }
}

#[test]
fn the_how_to_rides_on_the_first_start_only() {
    let started = json!({ "simId": IOS, "state": "booted" });
    let guided = with_guidance(started.clone(), true, "Driving ios:AAAA.");
    assert_eq!(
        guided,
        json!({ "simId": IOS, "state": "booted", "guide": "Driving ios:AAAA." })
    );
    assert_eq!(
        with_guidance(started.clone(), false, "Driving ios:AAAA."),
        started
    );
    assert_eq!(with_guidance(json!("raw"), true, "x"), json!("raw"));
}

#[test]
fn the_screenshot_note_names_the_frame_and_its_scale() {
    assert_eq!(
        screenshot_note(IOS, 7.0, 1206.0, 2622.0, 3.0),
        "ios:00000000-0000-4000-8000-000000000001 frame 7, 1206x2622. Divide image pixels by scale 3 for sim_act points; prefer sim_ui refs."
    );
    assert_eq!(
        screenshot_note(IOS, 8.0, 402.0, 874.0, 1.5),
        "ios:00000000-0000-4000-8000-000000000001 frame 8, 402x874. Divide image pixels by scale 1.5 for sim_act points; prefer sim_ui refs."
    );
}

#[test]
fn a_public_failure_keeps_the_code_and_ace_keeps_its_message() {
    let failure = DeviceFailure {
        code: DeviceErrorCode::StaleRef,
        message: JsString::from("@e3 is no longer on screen"),
        hint: JsString::from(crate::service::words::tool_hint("simStaleRefHint")),
        permission: None,
        platform: None,
    };
    let public = public_failure(&failure, true);
    assert_eq!(public.code, "stale_ref");
    assert_eq!(
        public.message.as_ref().map(JsString::as_str),
        Some("@e3 is no longer on screen")
    );

    let public = public_failure(&failure, false);
    assert_eq!(public.code, "stale_ref");
    assert_eq!(public.message, None);
}

#[test]
fn a_failure_body_takes_the_catalog_words_and_ace_s_detail() {
    let failure = crate::error::DeviceFailure {
        code: crate::error::DeviceErrorCode::StaleRef,
        message: JsString::from("@e3 is no longer on screen"),
        hint: JsString::from(crate::service::words::tool_hint("simStaleRefHint")),
        permission: None,
        platform: None,
    };
    let body = failure_body(&failure, true);
    // The public catalog's words, not the device failure's own.
    assert_eq!(
        body.get("code").and_then(ace_json::Value::as_str),
        Some("stale_ref")
    );
    assert!(
        body.get("message")
            .and_then(ace_json::Value::as_str)
            .is_some()
    );
    assert!(body.get("hint").and_then(ace_json::Value::as_str).is_some());
    // ace's own detail rides along last, and only when ace wrote the failure.
    assert_eq!(
        body.get("detail").and_then(ace_json::Value::as_str),
        Some("@e3 is no longer on screen")
    );
    assert!(failure_body(&failure, false).get("detail").is_none());
}

#[test]
fn a_detail_keeps_utf16_units_and_is_left_out_when_empty() {
    let body = |message: JsString| {
        failure_body(
            &DeviceFailure {
                code: DeviceErrorCode::StaleRef,
                message,
                hint: JsString::from("hint"),
                permission: None,
                platform: None,
            },
            true,
        )
    };

    // A lone surrogate is not a control character: `PublicToolError` keeps it, and the
    // wire carries it back as `\ud800`, never as U+FFFD.
    let detail = body(JsString::from_units(&[0xd800]));
    assert_eq!(
        ace_json::to_string(detail.get("detail").expect("a detail")),
        "\"\\ud800\""
    );

    // A pair cut at the 256-unit cap keeps its high half, as `slice(0, 256)` does.
    let mut units = vec![0x78; 255];
    units.extend("😀".encode_utf16());
    let detail = body(JsString::from_units(&units));
    assert_eq!(
        ace_json::to_string(detail.get("detail").expect("a detail")),
        format!("\"{}\\ud83d\"", "x".repeat(255))
    );

    // An empty message leaves no detail key at all.
    assert!(body(JsString::empty().clone()).get("detail").is_none());
}

#[test]
fn a_permission_refusal_takes_its_hint_from_the_shared_error_catalog() {
    // Both permission hints are authored once, in the MCP catalog the TypeScript and
    // Rust share, so a settings path cannot drift between the backends.
    let catalog =
        ace_json::parse(include_str!("../../../../../catalog/errors.json")).expect("errors.json");
    let hints = catalog
        .get("permissionHints")
        .and_then(Value::as_object)
        .expect("errors.json names the permission hints");
    for (permission, key) in [
        (
            crate::error::DevicePermission::ScreenRecording,
            "screenRecording",
        ),
        (
            crate::error::DevicePermission::Accessibility,
            "accessibility",
        ),
    ] {
        let expected = hints
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("errors.json names no {key} hint"));
        let failure = DeviceFailure {
            code: DeviceErrorCode::PermissionDenied,
            message: JsString::from("the helper said something private"),
            hint: JsString::from("a device hint"),
            permission: Some(permission),
            platform: None,
        };
        let body = failure_body(&failure, true);
        assert_eq!(
            body.get("hint").and_then(Value::as_str),
            Some(expected),
            "{key}"
        );
    }
}

#[test]
fn every_simulator_failure_code_has_its_public_words() {
    let catalog = ace_mcp::catalog::catalog().expect("the embedded catalog parses");
    // Every code a `DeviceFailure` can carry has a catalog entry, so a body never has
    // to reach for the device's own words.
    for code in [
        DeviceErrorCode::SdkMissing,
        DeviceErrorCode::ToolMissing,
        DeviceErrorCode::NotSupported,
        DeviceErrorCode::ForegroundRequired,
        DeviceErrorCode::NotFound,
        DeviceErrorCode::NotBooted,
        DeviceErrorCode::PermissionDenied,
        DeviceErrorCode::Busy,
        DeviceErrorCode::Timeout,
        DeviceErrorCode::CommandFailed,
        DeviceErrorCode::InvalidData,
        DeviceErrorCode::LeaseRequired,
        DeviceErrorCode::StaleRef,
        DeviceErrorCode::Limit,
        DeviceErrorCode::PersonBusy,
    ] {
        let failure = DeviceFailure {
            code,
            message: JsString::from("device-private-message"),
            hint: JsString::from("device-private-hint"),
            permission: None,
            platform: None,
        };
        let public = public_failure(&failure, true).code;
        let words = catalog
            .errors
            .get(public)
            .unwrap_or_else(|| panic!("{} has no catalog entry", code.as_str()));
        let body = failure_body(&failure, true);
        assert_eq!(
            body.get("message").and_then(Value::as_str),
            Some(words.message.as_str()),
            "{}",
            code.as_str()
        );
        assert_eq!(
            body.get("hint").and_then(Value::as_str),
            Some(words.hint.as_str()),
            "{}",
            code.as_str()
        );
        assert!(!ace_json::to_string(&failure_body(&failure, false)).contains("device-private"));
    }
}

#[test]
fn a_code_the_catalog_lacks_says_the_catalog_is_incomplete() {
    let catalog = ace_mcp::catalog::catalog().expect("the embedded catalog parses");
    let words = public_words("no_such_public_code");
    assert_eq!(words, catalog.fallbacks);
    assert!(words.message.contains("catalog"));
    assert!(words.hint.contains("Reinstall"));
}

#[test]
fn a_failure_body_serializes_the_public_words_in_the_wire_order() {
    // The bytes matter: a body built from the device's own words would read differently
    // here even when an object comparison (key order, similar text) would pass.
    let catalog =
        ace_json::parse(include_str!("../../../../../catalog/errors.json")).expect("errors.json");
    let entry = |code: &str| {
        catalog
            .get("catalog")
            .and_then(Value::as_object)
            .and_then(|all| all.get(code))
            .unwrap_or_else(|| panic!("errors.json names {code}"))
    };
    let quoted = |value: &Value, key: &str| {
        ace_json::to_string(value.get(key).unwrap_or_else(|| panic!("{key}")))
    };
    let words = |code: &str| {
        let value = entry(code);
        (quoted(value, "message"), quoted(value, "hint"))
    };

    // A device's refusal carries its own private wording; the body carries the catalog's.
    let (message, hint) = words("stale_ref");
    let failure = DeviceFailure {
        code: DeviceErrorCode::StaleRef,
        message: JsString::from("@e3 is gone, the device says"),
        hint: JsString::from("the device's own hint"),
        permission: None,
        platform: None,
    };
    assert_eq!(
        ace_json::to_string(&failure_body(&failure, true)),
        format!(
            "{{\"code\":\"stale_ref\",\"message\":{message},\"hint\":{hint},\"detail\":\"@e3 is gone, the device says\"}}"
        )
    );

    // A permission refusal's hint is the catalog's hint for that permission.
    let (message, _) = words("permission_denied");
    let permission_hint = catalog
        .get("permissionHints")
        .and_then(Value::as_object)
        .and_then(|hints| hints.get("accessibility"))
        .map(ace_json::to_string)
        .expect("the accessibility hint");
    let failure = DeviceFailure {
        code: DeviceErrorCode::PermissionDenied,
        message: JsString::from("the helper says"),
        hint: JsString::from("the device's own hint"),
        permission: Some(crate::error::DevicePermission::Accessibility),
        platform: None,
    };
    assert_eq!(
        ace_json::to_string(&failure_body(&failure, true)),
        format!(
            "{{\"code\":\"permission_denied\",\"message\":{message},\"hint\":{permission_hint},\"detail\":\"the helper says\",\"permission\":\"accessibility\"}}"
        )
    );

    // An argument refusal puts its issues before the schema's pointer.
    let (message, hint) = words("invalid_arguments");
    let error = crate::tools::args::decode(
        crate::tools::args::SimTool::Stop,
        &json!({ "simId": IOS, "machine": "m" }),
    )
    .expect_err("an unknown field");
    assert_eq!(
        ace_json::to_string(&arguments_body(crate::tools::args::SimTool::Stop, &error)),
        format!(
            "{{\"code\":\"invalid_arguments\",\"message\":{message},\"hint\":{hint},\"issues\":[{{\"path\":\"machine\",\"expected\":\"no such field; fields here: simId\"}}],\"detail\":\"tools_find sim_stop returns its schema.\"}}"
        )
    );
}

#[test]
fn an_ios_id_of_non_ascii_digits_is_not_a_device() {
    // JavaScript's `\d` is ASCII: 36 Arabic-Indic digits are not a UDID, even
    // though Unicode calls them digits.
    let raw = json!({
        "device": {
            "id": format!("ios:{}", "٣".repeat(36)),
            "name": "iPhone",
            "state": "booted",
            "platform": "ios"
        },
        "lifecycle": "live",
        "controller": "none"
    });
    assert_eq!(summary(&raw), raw);
}

#[test]
fn an_argument_error_is_the_invalid_arguments_body() {
    let error = crate::tools::args::decode(
        crate::tools::args::SimTool::Act,
        &json!({ "simId": IOS, "action": "tap", "x": 1 }),
    )
    .expect_err("half a point");
    let body = arguments_body(crate::tools::args::SimTool::Act, &error);
    assert_eq!(
        body,
        json!({
            "code": "invalid_arguments",
            "message": "Invalid tool arguments",
            "hint": "Nothing ran. Fix each field named in issues, keep the other arguments, and call again.",
            "issues": [
                { "path": "ref", "expected": "tap needs either ref or both x and y" }
            ]
        })
    );

    // A field or variant that does not exist also points at the tool's schema.
    let error = crate::tools::args::decode(
        crate::tools::args::SimTool::Stop,
        &json!({ "simId": IOS, "machine": "m" }),
    )
    .expect_err("an unknown field");
    let body = arguments_body(crate::tools::args::SimTool::Stop, &error);
    assert_eq!(
        body,
        json!({
            "code": "invalid_arguments",
            "message": "Invalid tool arguments",
            "hint": "Nothing ran. Fix each field named in issues, keep the other arguments, and call again.",
            "issues": [
                { "path": "machine", "expected": "no such field; fields here: simId" }
            ],
            "detail": "tools_find sim_stop returns its schema."
        })
    );
}

#[test]
fn a_permission_refusal_names_its_permission_and_the_settings_hint() {
    let failure = DeviceFailure {
        code: DeviceErrorCode::PermissionDenied,
        message: JsString::from("the helper lacks screen recording"),
        hint: JsString::from(crate::service::words::tool_hint("personBusyHint")),
        permission: Some(crate::error::DevicePermission::ScreenRecording),
        platform: None,
    };
    let body = failure_body(&failure, true);
    assert_eq!(
        body,
        json!({
            "code": "permission_denied",
            "message": "Device or screen permission denied",
            "hint": "Open System Settings > Privacy & Security > Screen Recording and enable Ace Screen Helper.",
            "detail": "the helper lacks screen recording",
            "permission": "screenRecording"
        })
    );

    // A permission on any other code is not the failure's to name.
    let failure = DeviceFailure {
        code: DeviceErrorCode::CommandFailed,
        message: JsString::from("no"),
        hint: JsString::from("no"),
        permission: Some(crate::error::DevicePermission::Accessibility),
        platform: None,
    };
    assert!(failure_body(&failure, true).get("permission").is_none());
}

#[test]
fn a_detail_keeps_ace_s_words_but_not_control_characters_or_long_hex() {
    let secret = "0123456789abcdef".repeat(4);
    let message = format!("element\u{0007} named {secret} {}end", "x".repeat(300));
    let failure = DeviceFailure {
        code: DeviceErrorCode::StaleRef,
        message: JsString::from(message),
        hint: JsString::from("hint"),
        permission: None,
        platform: None,
    };
    let body = failure_body(&failure, true);
    let detail = body
        .get("detail")
        .and_then(ace_json::Value::as_str)
        .expect("a detail");
    assert!(!detail.contains('\u{0007}'));
    assert!(!detail.contains(&secret));
    assert!(detail.contains("[redacted]"));
    // The sanitized detail is cut at 256 UTF-16 units, as `PublicToolError` slices it.
    assert_eq!(detail.encode_utf16().count(), 256);
}
