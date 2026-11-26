// SPDX-License-Identifier: Apache-2.0
//! The `sim_*` tools' results (`sim-tools.ts`): the summary, the no-video answer,
//! the how-to's placement, the screenshot's note and the public failure body.
//!
//! `sim-tools.process` (a) proves the tools end to end; these cases cover the
//! decisions the shell renders.

use super::{
    android_without_video, failure_body, public_failure, screenshot_note, summary, with_guidance,
    without_video,
};
use crate::error::{DeviceErrorCode, DeviceFailure};
use ace_json::{JsString, json};

#[test]
fn a_start_or_stop_answers_with_the_summary_not_the_whole_state() {
    let state = json!({
        "device": { "id": "ios:AAAA", "name": "iPhone 17 Pro", "state": "booted", "platform": "ios" },
        "enabled": true,
        "lifecycle": "live",
        "controller": "agent",
        "posture": { "kind": "folded" },
        "streamId": "screen-1"
    });
    let reduced = summary(&state);
    assert_eq!(
        reduced,
        json!({
            "simId": "ios:AAAA",
            "name": "iPhone 17 Pro",
            "state": "booted",
            "lifecycle": "live",
            "controller": "agent",
            "posture": { "kind": "folded" }
        })
    );

    // A posture is optional.
    let folded = json!({
        "device": { "id": "ios:AAAA", "name": "iPhone", "state": "booted" },
        "lifecycle": "live",
        "controller": "none"
    });
    assert_eq!(
        summary(&folded),
        json!({
            "simId": "ios:AAAA", "name": "iPhone", "state": "booted",
            "lifecycle": "live", "controller": "none"
        })
    );

    // A value that does not parse is returned as it is.
    let odd = json!({ "device": { "id": "ios:AAAA" } });
    assert_eq!(summary(&odd), odd);
    assert_eq!(summary(&json!("raw")), json!("raw"));
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
    let started = json!({ "simId": "ios:AAAA", "state": "booted" });
    let guided = with_guidance(started.clone(), true, "Driving ios:AAAA.");
    assert_eq!(
        guided,
        json!({ "simId": "ios:AAAA", "state": "booted", "guide": "Driving ios:AAAA." })
    );
    assert_eq!(
        with_guidance(started.clone(), false, "Driving ios:AAAA."),
        started
    );
    // A value that is not an object cannot carry a guide.
    assert_eq!(with_guidance(json!("raw"), true, "x"), json!("raw"));
}

#[test]
fn the_screenshot_note_names_the_frame_and_its_scale() {
    assert_eq!(
        screenshot_note("ios:AAAA", 7.0, 1206.0, 2622.0, 3.0),
        "ios:AAAA frame 7, 1206x2622. Divide image pixels by scale 3 for sim_act points; prefer sim_ui refs."
    );
    // Numbers are written as JavaScript writes them.
    assert_eq!(
        screenshot_note("ios:AAAA", 8.0, 402.0, 874.0, 1.5),
        "ios:AAAA frame 8, 402x874. Divide image pixels by scale 1.5 for sim_act points; prefer sim_ui refs."
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

    // A failure ace did not write keeps only its code.
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
