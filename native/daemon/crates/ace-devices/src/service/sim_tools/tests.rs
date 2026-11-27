// SPDX-License-Identifier: Apache-2.0
//! The `sim_*` tools' results (`sim-tools.ts`): the summary, the no-video answer,
//! the how-to's placement, the screenshot's note and the public failure.
//!
//! `sim-tools.process` (a) proves the tools end to end; these cases cover the
//! decisions the shell renders.

use super::{
    android_without_video, public_failure, screenshot_note, summary, with_guidance, without_video,
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
