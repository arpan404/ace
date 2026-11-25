// SPDX-License-Identifier: Apache-2.0
//! Interrupts, selections and the close (`session.ts:536`-`:590`, `:856`-`:940`).

use ace_adapter_api::session::{CloseReason, InterruptTarget};
use ace_json::{JsString, Value, json};

use super::{ack_writes, sent_json_messages, settlements};
use crate::session::core::{AcpCore, AcpCoreConfig, AcpEffect};
use crate::session::input::InputSend;
use crate::session::quirks::AcpSessionQuirks;
use crate::translate::keys::native_agent_key;
use ace_adapter_api::session::Delivery;

fn text(value: &str) -> Value {
    json!({ "type": "text", "text": value })
}

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

fn send(core: &mut AcpCore, operation: u64) -> Vec<AcpEffect> {
    let input = vec![text("hello")];
    let mut effects = Vec::new();
    core.send(
        InputSend {
            operation,
            input: &input,
            delivery: Delivery::Queue,
            command_id: None,
            origin: None,
            fence: None,
        },
        &mut effects,
    );
    ack_writes(core, &mut effects);
    effects
}

fn sent_id(effects: &[AcpEffect], method: &str) -> Option<Value> {
    sent_json_messages(effects)
        .into_iter()
        .find(|message| message.get("method").and_then(Value::as_str) == Some(method))
        .and_then(|message| message.get("id").cloned())
}

/// A mode select the session reports through a `config_option_update`.
fn mode_option(current: &str) -> Value {
    json!({
        "sessionId": "sess-1",
        "update": {
            "sessionUpdate": "config_option_update",
            "configOptions": [{
                "id": "mode",
                "category": "mode",
                "type": "select",
                "currentValue": current,
                "options": [{ "value": "plan" }, { "value": "default" }]
            }]
        }
    })
}

fn mode_and_model_options(mode: &str, model: &str) -> Value {
    json!({
        "sessionId": "sess-1",
        "update": {
            "sessionUpdate": "config_option_update",
            "configOptions": [
                {
                    "id": "model",
                    "category": "model",
                    "type": "select",
                    "currentValue": "model-a",
                    "options": [{ "value": "model-a" }, { "value": "model-b" }]
                },
                {
                    "id": "mode",
                    "category": "mode",
                    "type": "select",
                    "currentValue": mode,
                    "options": [{ "value": "plan" }, { "value": "default" }]
                },
                {
                    "id": "model_current",
                    "category": "model",
                    "type": "select",
                    "currentValue": model,
                    "options": [{ "value": "model-a" }, { "value": "model-b" }]
                }
            ]
        }
    })
}

fn notify(core: &mut AcpCore, params: &Value) {
    core.stdout_bytes(
        format!(
            "{}\n",
            json!({ "jsonrpc": "2.0", "method": "session/update", "params": params }).to_json()
        )
        .as_bytes(),
    );
}

#[test]
fn interrupting_the_root_cancels_the_turn_and_arms_its_grace() {
    let mut core = session_core("t-interrupt");
    send(&mut core, 1);
    let mut effects = Vec::new();
    let result = core.interrupt(
        InterruptTarget {
            agent: None,
            cascade: false,
        },
        &mut effects,
    );
    ack_writes(&mut core, &mut effects);
    assert!(result.is_ok());
    let sent = sent_json_messages(&effects);
    assert_eq!(
        sent[0].get("method").and_then(Value::as_str),
        Some("session/cancel")
    );
    assert_eq!(
        sent[0].pointer("/params/sessionId").and_then(Value::as_str),
        Some("sess-1")
    );
    assert!(
        core.deadlines.wire_key("root").is_some(),
        "a stop the agent never answers recovers by restarting"
    );
}

#[test]
fn interrupting_an_unknown_agent_key_is_refused() {
    let mut core = session_core("t-unknown-key");
    let result = core.interrupt(
        InterruptTarget {
            agent: Some("elsewhere".to_owned()),
            cascade: false,
        },
        &mut Vec::new(),
    );
    assert_eq!(
        result.err().map(|error| error.message),
        Some("Unknown ACP agent key".to_owned())
    );
}

#[test]
fn a_cascading_interrupt_reaches_each_live_child() {
    let mut core = session_core("t-cascade");
    send(&mut core, 1);
    notify(
        &mut core,
        &json!({
            "sessionId": "sess-1",
            "update": { "sessionUpdate": "subagent_spawned", "subagentSessionId": "child-1", "state": "running" }
        }),
    );
    assert!(
        core.routing
            .by_key(&native_agent_key("t-cascade", &JsString::from("child-1")))
            .is_some()
    );

    let mut effects = Vec::new();
    let result = core.interrupt(
        InterruptTarget {
            agent: None,
            cascade: true,
        },
        &mut effects,
    );
    ack_writes(&mut core, &mut effects);
    assert!(result.is_ok());
    let messages = sent_json_messages(&effects);
    let ids: Vec<&str> = messages
        .iter()
        .filter(|message| message.get("method").and_then(Value::as_str) == Some("session/cancel"))
        .filter_map(|message| message.pointer("/params/sessionId").and_then(Value::as_str))
        .collect();
    assert_eq!(ids, vec!["sess-1", "child-1"]);
    // The root's own turn owes the grace; a child's is armed when it is the target.
    assert!(core.deadlines.wire_key("root").is_some());
}

#[test]
fn interrupting_a_child_arms_its_own_grace() {
    let mut core = session_core("t-child-interrupt");
    notify(
        &mut core,
        &json!({
            "sessionId": "sess-1",
            "update": { "sessionUpdate": "subagent_spawned", "subagentSessionId": "child-1", "state": "running" }
        }),
    );
    let key = native_agent_key("t-child-interrupt", &JsString::from("child-1"));
    let mut effects = Vec::new();
    let result = core.interrupt(
        InterruptTarget {
            agent: Some(key),
            cascade: false,
        },
        &mut effects,
    );
    ack_writes(&mut core, &mut effects);
    assert!(result.is_ok());
    let messages = sent_json_messages(&effects);
    let ids: Vec<&str> = messages
        .iter()
        .filter(|message| message.get("method").and_then(Value::as_str) == Some("session/cancel"))
        .filter_map(|message| message.pointer("/params/sessionId").and_then(Value::as_str))
        .collect();
    assert_eq!(ids, vec!["child-1"]);
    assert!(
        core.deadlines.wire_key("child:child-1").is_some(),
        "a silent child is given up at the same grace"
    );
    assert!(
        core.cancelling_children
            .contains(&JsString::from("child-1"))
    );
}

#[test]
fn stop_task_is_refused() {
    let mut core = session_core("t-stop-task");
    assert_eq!(
        core.stop_task("task-1").err().map(|error| error.message),
        Some("ACP does not expose individual background task control".to_owned())
    );
}

#[test]
fn set_mode_requests_the_mode_and_settles_on_its_reply() {
    let mut core = session_core("t-set-mode");
    notify(&mut core, &mode_option("default"));
    let mut effects = Vec::new();
    core.set_mode(30, "plan", &mut effects);
    ack_writes(&mut core, &mut effects);
    let sent = sent_json_messages(&effects);
    assert_eq!(
        sent[0].pointer("/params/configId").and_then(Value::as_str),
        Some("mode")
    );
    assert_eq!(
        sent[0].pointer("/params/value").and_then(Value::as_str),
        Some("plan")
    );
    let id = sent_id(&effects, "session/set_config_option").unwrap_or_default();
    let reply = json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": { "configOptions": [{
            "id": "mode", "category": "mode", "type": "select",
            "currentValue": "plan",
            "options": [{ "value": "plan" }, { "value": "default" }]
        }] }
    });
    let settled = core.stdout_bytes(format!("{}\n", reply.to_json()).as_bytes());
    let done = settlements(&settled, 30);
    assert_eq!(done.len(), 1);
    assert!(done[0].is_ok());
    assert_eq!(core.wanted_mode.as_deref(), Some("plan"));
}

#[test]
fn set_model_is_refused_while_a_turn_runs() {
    let mut core = session_core("t-model-busy");
    send(&mut core, 1);
    let mut effects = Vec::new();
    core.set_model(31, "model-b", &mut effects);
    assert_eq!(
        settlements(&effects, 31),
        vec![Err((
            "ACE_ACP_RPC_ERROR".to_owned(),
            "ACP selectors require a settled session".to_owned()
        ))]
    );
    assert!(sent_json_messages(&effects).is_empty());
}

#[test]
fn set_model_restores_the_mode_its_reply_reset() {
    let mut core = session_core("t-model-restore");
    notify(&mut core, &mode_and_model_options("plan", "model-a"));
    core.wanted_mode = Some("plan".to_owned());

    let mut effects = Vec::new();
    core.set_model(32, "model-b", &mut effects);
    ack_writes(&mut core, &mut effects);
    let sent = sent_json_messages(&effects);
    assert_eq!(
        sent[0].pointer("/params/configId").and_then(Value::as_str),
        Some("model")
    );
    let id = sent_id(&effects, "session/set_config_option").unwrap_or_default();

    // The model's reply carries fresh options with the mode back at its default.
    let reply = json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": { "configOptions": [
            { "id": "model", "category": "model", "type": "select", "currentValue": "model-b",
              "options": [{ "value": "model-a" }, { "value": "model-b" }] },
            { "id": "mode", "category": "mode", "type": "select", "currentValue": "default",
              "options": [{ "value": "plan" }, { "value": "default" }] }
        ] }
    });
    let mut after_model = core.stdout_bytes(format!("{}\n", reply.to_json()).as_bytes());
    ack_writes(&mut core, &mut after_model);
    assert!(
        settlements(&after_model, 32).is_empty(),
        "the restore is pending"
    );
    let sent = sent_json_messages(&after_model);
    assert_eq!(
        sent[0].pointer("/params/configId").and_then(Value::as_str),
        Some("mode")
    );
    assert_eq!(
        sent[0].pointer("/params/value").and_then(Value::as_str),
        Some("plan")
    );

    let id = sent_id(&after_model, "session/set_config_option").unwrap_or_default();
    let restored = json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": { "configOptions": [
            { "id": "model", "category": "model", "type": "select", "currentValue": "model-b",
              "options": [{ "value": "model-a" }, { "value": "model-b" }] },
            { "id": "mode", "category": "mode", "type": "select", "currentValue": "plan",
              "options": [{ "value": "plan" }, { "value": "default" }] }
        ] }
    });
    let settled = core.stdout_bytes(format!("{}\n", restored.to_json()).as_bytes());
    let done = settlements(&settled, 32);
    assert_eq!(done.len(), 1);
    assert!(
        done[0].is_ok(),
        "setModel settles after its restore: {done:?}"
    );
}

#[test]
fn close_notes_the_stop_and_rejects_every_prompt_the_session_owes() {
    let mut core = session_core("t-close");
    let opened = send(&mut core, 40);
    assert!(!opened.is_empty());
    // A second send waits behind the first.
    let mut queued = Vec::new();
    let input = vec![text("later")];
    core.send(
        InputSend {
            operation: 41,
            input: &input,
            delivery: Delivery::Queue,
            command_id: None,
            origin: None,
            fence: None,
        },
        &mut queued,
    );
    assert_eq!(core.queue_len(), 1);

    let mut effects = Vec::new();
    core.close(CloseReason::User, &mut effects);
    assert!(core.closed);
    assert!(core.deliberate, "a close with no fault is deliberate");
    let notes: Vec<Value> = effects
        .iter()
        .filter_map(|effect| match effect {
            AcpEffect::Frame {
                dir: ace_adapter_api::frame::FrameDirection::Note,
                channel,
                text,
            } if channel == "recorder" => ace_json::parse(text).ok(),
            _ => None,
        })
        .collect();
    assert!(notes.contains(&json!({ "event": "stop" })));
    // The prompt that wrote is uncertain; the one still queued never ran.
    assert_eq!(
        settlements(&effects, 40),
        vec![Err((
            "ACE_ACP_RPC_ERROR".to_owned(),
            "ACP session closed".to_owned()
        ))]
    );
    assert_eq!(
        settlements(&effects, 41),
        vec![Err((
            "ACE_INPUT_REJECTED".to_owned(),
            "ACP session closed".to_owned()
        ))]
    );
    assert_eq!(core.queue_len(), 0);
}
