use super::*;
use serde_json::json;

#[test]
fn known_events_round_trip_through_json() {
    let event = Event::Known(Known::ReplyFinished {
        reply: "r1".into(),
        text: "Hi".into(),
        input_tokens: Some(11),
        output_tokens: None,
        cost_micros: 42,
    });
    assert_eq!(Event::from_json(event.to_json()), event);
    assert_eq!(event.to_json()["type"], "reply_finished");
}

#[test]
fn an_event_from_a_newer_spade_is_kept_not_dropped() {
    let raw = json!({ "type": "tool_called", "tool": "web_search" });
    assert_eq!(Event::from_json(raw.clone()), Event::Unknown(raw.clone()));
    assert_eq!(Event::from_json(raw.clone()).to_json(), raw);
}

#[test]
fn a_reply_to_round_trips_and_one_that_cant_be_read_leaves_the_message_readable() {
    let raw = json!({ "type": "user_message", "text": "That one",
                      "reply_to": { "id": "m12", "text": "Tuesday?", "mine": false } });
    let Event::Known(Known::UserMessage { reply_to, .. }) = Event::from_json(raw.clone()) else {
        panic!("a reply is a message");
    };
    let to = reply_to.unwrap_or_else(|| panic!("its quote"));
    assert_eq!(
        (to.id.as_str(), to.text.as_str(), to.mine),
        ("m12", "Tuesday?", false)
    );
    assert_eq!(Event::from_json(raw.clone()).to_json(), raw);
    for broken in [json!("m12"), json!({ "id": 12 }), json!(null)] {
        let raw = json!({ "type": "group_message", "run": "r", "text": "Hi",
                          "reply_to": broken });
        assert!(matches!(
            Event::from_json(raw),
            Event::Known(Known::GroupMessage { reply_to: None, .. })
        ));
    }
    assert!(
        Event::user_message("Hi")
            .to_json()
            .get("reply_to")
            .is_none()
    );
}

fn failed_kind(raw: Value) -> Option<FailureKind> {
    match Event::from_json(raw) {
        Event::Known(Known::ReplyFailed { kind, .. }) => Some(kind),
        _ => None,
    }
}

#[test]
fn a_failed_reply_stored_before_kinds_existed_or_with_a_newer_kind_reads_as_other() {
    let old = json!({ "type": "reply_failed", "reply": "r1", "text": "", "error": "boom" });
    assert_eq!(failed_kind(old), Some(FailureKind::Other));
    let newer = json!({ "type": "reply_failed", "reply": "r1", "text": "", "error": "boom",
                        "kind": "solar_flare" });
    assert_eq!(failed_kind(newer), Some(FailureKind::Other));
    let known = json!({ "type": "reply_failed", "reply": "r1", "text": "", "error": "boom",
                        "kind": "rate_limited", "endpoint": "fake" });
    assert_eq!(failed_kind(known), Some(FailureKind::RateLimited));
}

#[test]
fn a_call_that_never_got_an_answer_is_unreachable_and_a_refused_key_is_the_keys() {
    use spade_models::ModelError;
    let refused = |status: Option<u16>| ModelError::Unanswered {
        model: "fake/m".into(),
        message: String::new(),
        transient: false,
        retry_after: None,
        status,
    };
    assert_eq!(FailureKind::of(&refused(None)), FailureKind::Unreachable);
    assert_eq!(FailureKind::of(&refused(Some(401))), FailureKind::Key);
    assert_eq!(
        FailureKind::of(&refused(Some(429))),
        FailureKind::RateLimited
    );
    assert_eq!(FailureKind::of(&refused(Some(500))), FailureKind::Model);
    let missing = ModelError::MissingKey {
        endpoint: "fake".into(),
        var: None,
    };
    assert_eq!(FailureKind::of(&missing), FailureKind::Key);
}

#[test]
fn a_reply_without_a_usable_model_fails_as_no_model_and_says_what_to_do() {
    use spade_models::ModelError;
    let unchosen = ModelError::UnknownModel(String::new());
    assert_eq!(FailureKind::of(&unchosen), FailureKind::NoModel);
    assert!(
        unchosen
            .to_string()
            .contains("no model is chosen yet: choose one")
    );
    let gone = ModelError::UnknownModel("old/m".into());
    assert_eq!(FailureKind::of(&gone), FailureKind::NoModel);
    assert_eq!(
        gone.to_string(),
        "old/m is not a model on one of your endpoints"
    );
    let stored = Event::Known(Known::ReplyFailed {
        reply: "r1".into(),
        text: String::new(),
        error: unchosen.to_string(),
        kind: FailureKind::NoModel,
        endpoint: None,
    })
    .to_json();
    assert_eq!(stored["kind"], "no_model");
}
