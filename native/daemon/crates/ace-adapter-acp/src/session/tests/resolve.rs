// SPDX-License-Identifier: Apache-2.0
//! Answers to the agent's requests (`session.ts:820`-`:841`, `interactions.ts:273`).

use ace_json::{JsString, Value, json};
use ace_supervisor::jsonrpc::RpcId;

use super::{ack_writes, sent_json_messages};
use crate::session::core::{AcpCore, AcpCoreConfig, AcpEffect};
use crate::session::quirks::AcpSessionQuirks;
use crate::session::resolve::validate_resolution;
use crate::translate::approval::interaction_key;

fn session_core(thread: &str) -> AcpCore {
    let (mut core, _) = AcpCore::new(AcpCoreConfig::new(
        thread,
        "/work",
        AcpSessionQuirks::generic(),
    ));
    core.native_session_id = JsString::from("sess-1");
    core.routing.bind_root(JsString::from("sess-1"));
    core.shells.set_root(JsString::from("sess-1"));
    core
}

/// The agent's permission request, held until the person answers it.
fn ask(core: &mut AcpCore) {
    let request = json!({
        "jsonrpc": "2.0",
        "id": 7,
        "method": "session/request_permission",
        "params": {
            "sessionId": "sess-1",
            "toolCall": { "toolCallId": "sh-1", "kind": "execute", "title": "Run ls" },
            "options": [
                { "optionId": "allow", "name": "Allow", "kind": "allow_once" },
                { "optionId": "reject", "name": "Reject", "kind": "reject_once" }
            ]
        }
    });
    let mut effects = core.stdout_bytes(format!("{}\n", request.to_json()).as_bytes());
    ack_writes(core, &mut effects);
    assert_eq!(core.pending.len(), 1);
}

fn key() -> JsString {
    interaction_key(&crate::translate::data::RpcId::FloatBits(7.0_f64.to_bits()))
}

fn answer(effects: &[AcpEffect]) -> Option<Value> {
    sent_json_messages(effects)
        .into_iter()
        .find(|message| message.get("id").and_then(Value::as_f64) == Some(7.0))
        .and_then(|message| message.get("result").cloned())
}

#[test]
fn an_allow_answers_the_agents_request_and_starts_the_tool() {
    let mut core = session_core("t-resolve-allow");
    ask(&mut core);
    let mut effects = Vec::new();
    let result = core.resolve(
        key().as_str(),
        &json!({ "kind": "approval", "optionId": "allow" }),
        &mut effects,
    );
    ack_writes(&mut core, &mut effects);
    assert!(result.is_ok(), "{result:?}");
    assert!(core.pending.is_empty(), "the request is answered once");
    assert_eq!(
        answer(&effects),
        Some(json!({ "outcome": { "outcome": "selected", "optionId": "allow" } }))
    );
    assert!(
        core.shells
            .knows(&JsString::from("sess-1"), &JsString::from("sh-1")),
        "an allow starts the tool"
    );
}

#[test]
fn a_denial_answers_the_request_and_settles_its_tool() {
    let mut core = session_core("t-resolve-deny");
    ask(&mut core);
    let mut effects = Vec::new();
    let result = core.resolve(
        key().as_str(),
        &json!({ "kind": "approval", "optionId": "reject" }),
        &mut effects,
    );
    assert!(result.is_ok(), "{result:?}");
    assert_eq!(
        answer(&effects),
        Some(json!({ "outcome": { "outcome": "selected", "optionId": "reject" } }))
    );
    assert!(
        !core
            .shells
            .knows(&JsString::from("sess-1"), &JsString::from("sh-1")),
        "a refusal settles the tool"
    );
}

#[test]
fn an_answer_to_an_expired_request_is_refused() {
    let mut core = session_core("t-resolve-gone");
    let mut effects = Vec::new();
    let result = core.resolve(
        key().as_str(),
        &json!({ "kind": "approval", "optionId": "allow" }),
        &mut effects,
    );
    assert_eq!(
        result.err().map(|error| error.message),
        Some("ACP interaction is no longer pending".to_owned())
    );
    assert!(sent_json_messages(&effects).is_empty());
}

#[test]
fn a_resolution_is_validated_against_the_request_it_answers() {
    let approval = json!({
        "kind": "approval",
        "title": "Run ls",
        "options": [
            { "id": "allow", "label": "Allow", "kind": "allow_once" },
            { "id": "reject", "label": "Reject", "kind": "deny" }
        ]
    });
    assert_eq!(
        validate_resolution(&approval, &json!({ "kind": "question", "answers": {} }))
            .err()
            .map(|error| error.message),
        Some("Interaction resolution kind does not match".to_owned())
    );
    assert_eq!(
        validate_resolution(
            &approval,
            &json!({ "kind": "approval", "optionId": "other" })
        )
        .err()
        .map(|error| error.message),
        Some("Unknown approval option".to_owned())
    );
    assert_eq!(
        validate_resolution(&approval, &json!({ "kind": "approval" }))
            .err()
            .map(|error| error.message),
        Some("Invalid interaction resolution".to_owned())
    );

    let question = json!({
        "kind": "question",
        "questions": [{
            "id": "q1",
            "text": "Which?",
            "options": [{ "id": "a", "label": "A" }, { "id": "b", "label": "B" }],
            "multiSelect": false,
            "allowOther": false
        }]
    });
    assert_eq!(
        validate_resolution(
            &question,
            &json!({ "kind": "question", "answers": { "nope": ["a"] } })
        )
        .err()
        .map(|error| error.message),
        Some("Unknown question ID".to_owned())
    );
    assert_eq!(
        validate_resolution(
            &question,
            &json!({ "kind": "question", "answers": { "q1": ["a", "b"] } })
        )
        .err()
        .map(|error| error.message),
        Some("Invalid question answer".to_owned())
    );
    assert!(
        validate_resolution(
            &question,
            &json!({ "kind": "question", "answers": { "q1": ["a"] } })
        )
        .is_ok()
    );
    assert!(
        validate_resolution(
            &question,
            &json!({ "kind": "question", "answers": {}, "dismissed": true })
        )
        .is_ok(),
        "a dismissed question needs no answers"
    );
}

#[test]
fn the_interaction_key_of_a_request_id_is_the_sessions_own() {
    let core = session_core("t-interaction-key");
    assert_eq!(core.interaction_key_of(&RpcId::Number(7.0)), key());
}
