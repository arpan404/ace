// SPDX-License-Identifier: Apache-2.0
//! The saved mode, model and effort a launch applies before its open settles.

use super::{ack_writes, sent_json_messages, settlements};
use crate::session::core::{AcpCore, AcpCoreConfig, AcpEffect};
use crate::session::quirks::AcpSessionQuirks;
use ace_json::{Value, json};

/// A launch's saved mode, model and effort each apply, in that order, before the
/// open settles; only then does the daemon hear what runs (`session.ts:495`–`:509`).
#[test]
fn open_applies_saved_mode_model_and_effort_before_it_settles() {
    let mut config = AcpCoreConfig::new("t-saved", "/work", AcpSessionQuirks::generic());
    config.permission_mode = Some("plan".to_owned());
    config.model = Some("model-b".to_owned());
    let (mut core, opened, mut effects) = open_with_saved(config, 21);
    assert!(
        settlements(&effects, 21).is_empty(),
        "the open waits for its saved options"
    );
    let sent = sent_json_messages(&opened);
    assert_eq!(
        sent[0].get("method").and_then(Value::as_str),
        Some("session/set_mode")
    );
    assert_eq!(
        sent[0].pointer("/params/modeId").and_then(Value::as_str),
        Some("plan")
    );

    let mode_ok =
        json!({ "jsonrpc": "2.0", "id": 3, "result": { "modes": { "currentModeId": "plan" } } });
    let mut after_mode = core.stdout_bytes(format!("{}\n", mode_ok.to_json()).as_bytes());
    ack_writes(&mut core, &mut after_mode);
    effects.extend(after_mode.clone());
    assert!(settlements(&after_mode, 21).is_empty());
    let sent = sent_json_messages(&after_mode);
    assert_eq!(
        sent[0].get("method").and_then(Value::as_str),
        Some("session/set_model")
    );
    assert_eq!(
        sent[0].pointer("/params/modelId").and_then(Value::as_str),
        Some("model-b")
    );

    let model_ok = json!({ "jsonrpc": "2.0", "id": 4, "result": { "models": { "currentModelId": "model-b" } } });
    let settled = core.stdout_bytes(format!("{}\n", model_ok.to_json()).as_bytes());
    let done = settlements(&settled, 21);
    assert_eq!(
        done.len(),
        1,
        "the open settles after its last saved option"
    );
    let parsed = ace_json::parse(done[0].as_ref().map(String::as_str).unwrap_or("null"))
        .unwrap_or(Value::Null);
    assert_eq!(parsed.get("refusedOptions"), Some(&json!([])));
    assert_eq!(
        parsed.get("nativeSessionId").and_then(Value::as_str),
        Some("sess-1")
    );
}

/// A saved option the agent no longer lists is reported refused, never failed:
/// the start goes on and the daemon records what runs instead (`session.ts:496`).
#[test]
fn open_reports_saved_options_the_agent_no_longer_lists_as_refused() {
    let mut config = AcpCoreConfig::new("t-refused", "/work", AcpSessionQuirks::generic());
    config.permission_mode = Some("plan".to_owned());
    config.model = Some("model-b".to_owned());
    config.effort = Some("high".to_owned());
    let reply = json!({ "jsonrpc": "2.0", "id": 2, "result": { "sessionId": "sess-1" } });
    let (_core, _opened, effects) = open_with_saved_reply(config, 22, &reply);
    let done = settlements(&effects, 22);
    assert_eq!(done.len(), 1);
    let parsed = ace_json::parse(done[0].as_ref().map(String::as_str).unwrap_or("null"))
        .unwrap_or(Value::Null);
    assert_eq!(
        parsed.get("refusedOptions"),
        Some(&json!(["permissionMode", "model", "effort"]))
    );
}

/// A model's reply can reset the mode: the mode ace set is restored before the open
/// settles, and a restore the agent refuses is swallowed, not reported (`session.ts:577`).
#[test]
fn open_restores_the_saved_mode_a_model_reply_reset() {
    let mut config = AcpCoreConfig::new("t-restore", "/work", AcpSessionQuirks::generic());
    config.permission_mode = Some("plan".to_owned());
    config.model = Some("model-b".to_owned());
    let reply = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "result": {
            "sessionId": "sess-1",
            "configOptions": [
                option("model", "model", "model-a"),
                option("mode", "mode", "default")
            ]
        }
    });
    let (mut core, _opened, mut effects) = open_with_saved_reply(config, 23, &reply);

    let mode_ok = json!({
        "jsonrpc": "2.0",
        "id": 3,
        "result": { "configOptions": [option("model", "model", "model-a"), option("mode", "mode", "plan")] }
    });
    let mut after_mode = core.stdout_bytes(format!("{}\n", mode_ok.to_json()).as_bytes());
    ack_writes(&mut core, &mut after_mode);
    effects.extend(after_mode);

    // The model's reply carries fresh options, with the mode back at its default.
    let model_reset = json!({
        "jsonrpc": "2.0",
        "id": 4,
        "result": { "configOptions": [option("model", "model", "model-b"), option("mode", "mode", "default")] }
    });
    let mut after_model = core.stdout_bytes(format!("{}\n", model_reset.to_json()).as_bytes());
    ack_writes(&mut core, &mut after_model);
    effects.extend(after_model.clone());
    assert!(settlements(&after_model, 23).is_empty());
    let sent = sent_json_messages(&after_model);
    assert_eq!(
        sent[0].pointer("/params/configId").and_then(Value::as_str),
        Some("mode")
    );
    assert_eq!(
        sent[0].pointer("/params/value").and_then(Value::as_str),
        Some("plan")
    );

    // The agent refuses the restore: the open still succeeds, nothing is refused, and
    // the daemon hears the mode that runs instead (`session.ts:577`-`:585`).
    let restore_err = json!({
        "jsonrpc": "2.0",
        "id": 5,
        "error": { "code": -32603, "message": "mode locked" }
    });
    let settled = core.stdout_bytes(format!("{}\n", restore_err.to_json()).as_bytes());
    let done = settlements(&settled, 23);
    assert_eq!(done.len(), 1);
    let Ok(open_json) = &done[0] else {
        panic!("a refused restore never fails the start: {done:?}");
    };
    let parsed = ace_json::parse(open_json).unwrap_or(Value::Null);
    assert_eq!(parsed.get("refusedOptions"), Some(&json!([])));
    let announced = settled.iter().find_map(|effect| match effect {
        AcpEffect::Callback { name, json } if *name == "onPermissionMode" => {
            ace_json::parse(json).ok()
        }
        _ => None,
    });
    assert_eq!(
        announced,
        Some(json!(["default"])),
        "a refused restore announces the mode that runs"
    );
}

/// A model's reply can drop the mode it reported: ace asks for the mode it wanted even
/// though nothing runs now (`session.ts:577`-`:585`, `undefined !== wantedMode`).
#[test]
fn open_restores_the_saved_mode_a_model_reply_cleared() {
    let mut config = AcpCoreConfig::new("t-cleared", "/work", AcpSessionQuirks::generic());
    config.permission_mode = Some("plan".to_owned());
    config.model = Some("model-b".to_owned());
    let reply = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "result": {
            "sessionId": "sess-1",
            "configOptions": [
                option("model", "model", "model-a"),
                option("mode", "mode", "default")
            ]
        }
    });
    let (mut core, _opened, _effects) = open_with_saved_reply(config, 25, &reply);

    let mode_ok = json!({
        "jsonrpc": "2.0",
        "id": 3,
        "result": { "configOptions": [option("model", "model", "model-a"), option("mode", "mode", "plan")] }
    });
    let mut after_mode = core.stdout_bytes(format!("{}\n", mode_ok.to_json()).as_bytes());
    ack_writes(&mut core, &mut after_mode);

    // The model's reply clears the mode it reports, while the agent still lists it.
    let model_cleared = json!({
        "jsonrpc": "2.0",
        "id": 4,
        "result": { "configOptions": [
            option("model", "model", "model-b"),
            {
                "id": "mode",
                "category": "mode",
                "type": "select",
                "options": [{ "value": "plan" }, { "value": "default" }]
            }
        ] }
    });
    let mut after_model = core.stdout_bytes(format!("{}\n", model_cleared.to_json()).as_bytes());
    ack_writes(&mut core, &mut after_model);
    assert!(settlements(&after_model, 25).is_empty());
    let sent = sent_json_messages(&after_model);
    assert_eq!(
        sent[0].pointer("/params/configId").and_then(Value::as_str),
        Some("mode"),
        "a cleared mode is restored, not only announced"
    );
    assert_eq!(
        sent[0].pointer("/params/value").and_then(Value::as_str),
        Some("plan")
    );

    let restored = json!({
        "jsonrpc": "2.0",
        "id": 5,
        "result": { "configOptions": [
            option("model", "model", "model-b"),
            option("mode", "mode", "plan")
        ] }
    });
    let settled = core.stdout_bytes(format!("{}\n", restored.to_json()).as_bytes());
    let done = settlements(&settled, 25);
    assert_eq!(done.len(), 1);
    assert!(done[0].is_ok(), "the restore settles the open: {done:?}");
}

/// A saved effort that never answers is reported refused and the start goes on: TS's
/// `selectEffort` calls `configuration.select` directly and catches every failure
/// (`session.ts:525`-`:533`), so its timeout never fails the session.
#[test]
fn a_saved_effort_that_times_out_is_refused_and_the_open_still_succeeds() {
    let mut config = AcpCoreConfig::new("t-effort-timeout", "/work", AcpSessionQuirks::generic());
    config.effort = Some("high".to_owned());
    let reply = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "result": {
            "sessionId": "sess-1",
            "configOptions": [{
                "id": "reasoning_effort",
                "category": "thought_level",
                "type": "select",
                "currentValue": "low",
                "options": [{ "value": "low" }, { "value": "high" }]
            }]
        }
    });
    let (mut core, opened, _effects) = open_with_saved_reply(config, 24, &reply);
    assert!(
        settlements(&opened, 24).is_empty(),
        "the effort selection is still pending"
    );
    let sent = sent_json_messages(&opened);
    assert_eq!(
        sent[0].pointer("/params/configId").and_then(Value::as_str),
        Some("reasoning_effort")
    );
    let Some(key) = opened.iter().find_map(|effect| match effect {
        AcpEffect::ArmTimer { key, .. } if key.starts_with("request:") => Some(key.clone()),
        _ => None,
    }) else {
        panic!("the effort request arms its deadline");
    };

    let timed_out = core.timer(&key);
    let done = settlements(&timed_out, 24);
    assert_eq!(done.len(), 1, "the open still settles: {done:?}");
    let Ok(open_json) = &done[0] else {
        panic!("a timed-out effort never fails the start: {done:?}");
    };
    let parsed = ace_json::parse(open_json).unwrap_or(Value::Null);
    assert_eq!(parsed.get("refusedOptions"), Some(&json!(["effort"])));
    assert!(!core.closed);
}

/// One `configOptions` select listing both saved values.
fn option(id: &str, category: &str, current: &str) -> Value {
    let values: Vec<Value> = if category == "model" {
        vec![json!({ "value": "model-a" }), json!({ "value": "model-b" })]
    } else {
        vec![json!({ "value": "plan" }), json!({ "value": "default" })]
    };
    json!({
        "id": id,
        "category": category,
        "type": "select",
        "currentValue": current,
        "options": values
    })
}

/// A core whose `session/new` reply lists `plan`/`default`, two models and no effort
/// level, already past `initialize`.
fn open_with_saved(
    config: AcpCoreConfig,
    facade_id: u64,
) -> (AcpCore, Vec<AcpEffect>, Vec<AcpEffect>) {
    let reply = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "result": {
            "sessionId": "sess-1",
            "modes": {
                "currentModeId": "default",
                "availableModes": [{ "id": "plan" }, { "id": "default" }]
            },
            "models": {
                "currentModelId": "model-a",
                "availableModels": [{ "modelId": "model-a" }, { "modelId": "model-b" }]
            }
        }
    });
    open_with_saved_reply(config, facade_id, &reply)
}

fn open_with_saved_reply(
    config: AcpCoreConfig,
    facade_id: u64,
    new_reply: &Value,
) -> (AcpCore, Vec<AcpEffect>, Vec<AcpEffect>) {
    let (mut core, _) = AcpCore::new(config);
    let mut effects = core.start_open(facade_id);
    ack_writes(&mut core, &mut effects);
    let mut init = core.stdout_bytes(
        b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"protocolVersion\":1,\"agentCapabilities\":{}}}\n",
    );
    ack_writes(&mut core, &mut init);
    effects.extend(init);
    let mut opened = core.stdout_bytes(format!("{}\n", new_reply.to_json()).as_bytes());
    ack_writes(&mut core, &mut opened);
    effects.extend(opened.clone());
    (core, opened, effects)
}
