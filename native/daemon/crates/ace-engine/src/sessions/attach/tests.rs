// SPDX-License-Identifier: Apache-2.0
//! The open flow's engine half: the request a provider is handed, the frame it becomes, and the
//! process exit its observer reports. Moved from `open-failure.process`'s exit and resume shapes.

use super::{OpenRequest, channel_is_sdk, direction_name, exit_facts, frame_of};
use ace_adapter_api::{FrameDirection, SessionExit, SessionFrame};
use ace_json::{Raw, Value};

fn frame(seq: u64) -> SessionFrame {
    SessionFrame {
        seq,
        t: 42,
        dir: FrameDirection::Recv,
        channel: "sdk".to_owned(),
        data: Raw::from_json("{\"type\":\"x\"}").expect("json"),
    }
}

#[test]
fn the_open_request_carries_everything_the_provider_is_told() {
    let request = OpenRequest {
        thread_id: "t".to_owned(),
        cwd: "/repo".to_owned(),
        model: Some("model".to_owned()),
        instance_id: Some("account".to_owned()),
        env: vec![("ACE_THREAD_ID".to_owned(), "t".to_owned())],
        executable: Some("/bin/pi".to_owned()),
        instance_home_dir: Some("/home/a".to_owned()),
        store_generation: Some(3),
        resume_native_session_id: Some("native".to_owned()),
    };
    let context = request.context();
    assert_eq!(context.thread_id, "t");
    assert_eq!(context.cwd, "/repo");
    assert_eq!(context.model.as_deref(), Some("model"));
    assert_eq!(context.instance_id.as_deref(), Some("account"));
    assert_eq!(context.env, [("ACE_THREAD_ID".to_owned(), "t".to_owned())]);
    assert_eq!(context.executable.as_deref(), Some("/bin/pi"));
    assert_eq!(context.instance_home_dir.as_deref(), Some("/home/a"));
    assert_eq!(context.store_generation, Some(3));
    assert_eq!(
        context.resume_native_session_id.as_deref(),
        Some("native"),
        "a resume names the native session it continues"
    );
}

#[test]
fn a_session_frame_becomes_the_intakes_typed_frame() {
    let typed = frame_of(frame(7));
    assert_eq!(typed.seq, 7);
    assert_eq!(typed.t, 42);
    assert_eq!(typed.dir, FrameDirection::Recv);
    assert_eq!(typed.channel, "sdk");
    assert_eq!(typed.data.get(), "{\"type\":\"x\"}");
    assert!(channel_is_sdk(&typed.channel));
    assert!(!channel_is_sdk("stdio"));
}

#[test]
fn a_deliberate_exit_marks_the_process_as_ace_closed() {
    let facts = exit_facts(&SessionExit {
        deliberate: true,
        message: "closed".to_owned(),
    });
    assert_eq!(facts.len(), 1);
    assert_eq!(
        ace_json::to_string(&facts[0]),
        "{\"type\":\"process.exited\",\"deliberate\":true}"
    );
    let facts = exit_facts(&SessionExit {
        deliberate: false,
        message: "Pi process exit, code 1".to_owned(),
    });
    assert_eq!(
        facts[0].get("deliberate"),
        Some(&Value::Bool(false)),
        "an unexpected exit is not deliberate"
    );
    assert_eq!(
        facts[0].get("message").and_then(Value::as_str),
        Some("Pi process exit, code 1")
    );
}

#[test]
fn directions_keep_their_names() {
    assert_eq!(direction_name(FrameDirection::Send), "send");
    assert_eq!(direction_name(FrameDirection::Recv), "recv");
    assert_eq!(direction_name(FrameDirection::Stderr), "stderr");
    assert_eq!(direction_name(FrameDirection::Note), "note");
}
