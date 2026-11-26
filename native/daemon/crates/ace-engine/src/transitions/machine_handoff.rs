// SPDX-License-Identifier: Apache-2.0
//! `machine-handoff.ts` (E5.9): a thread's history carried to another machine (ADR 0101).
//!
//! The capture is the same bounded, conversation-first handoff a provider switch builds
//! (`transition-history.ts`'s `handoff`), and the target keeps it waiting on the new thread so it
//! goes in front of the person's next message there. Cases ported from
//! `context-handoff.process.test.ts` and `machine-handoff` rows of `workspace-change.process`.

use ace_json::Value;

use crate::transitions::handoff::{self, Model, PortableHandoff};
use crate::transitions::history::{self, HandoffOptions};
use crate::{EngineError, EngineStore, State};

/// About 8k tokens, as a cross-provider switch carries (`machine-handoff.ts:13`).
pub const MACHINE_HANDOFF_BYTES: usize = 32_768;

/// `machineHandoffNote` (`:33`): what the new agent is told beyond the excerpts.
pub fn machine_handoff_note(machine: &str) -> String {
    format!(
        "This thread continues one from {machine}. The handoff above was carried from there: \
         its earlier items, full tool output and attachments stayed on {machine} and can't be read from this machine."
    )
}

/// `handoff:<commandId>`: the transcript marker a carried handoff waits behind (`:47`).
pub fn machine_handoff_marker(command_id: &str) -> String {
    format!("handoff:{command_id}")
}

/// `captureMachineHandoff` (`:17`): the source's bounded handoff for the move.
pub fn capture_machine_handoff(
    store: &EngineStore,
    state: &mut State,
    id: &str,
    provider: &str,
) -> Result<PortableHandoff, EngineError> {
    let through = store.head_seq()? as i64;
    history::handoff(
        store,
        state,
        id,
        through,
        MACHINE_HANDOFF_BYTES as i64,
        provider,
        HandoffOptions {
            since: None,
            exclude: &[],
        },
    )
}

/// What a move carries to the target (`adoptMachineHandoff`'s input).
pub struct MachineAdoption {
    pub handoff: PortableHandoff,
    pub command_id: String,
    pub machine: String,
    pub provider: String,
    pub model: Option<String>,
    pub at: f64,
}

/// `adoptMachineHandoff` (`:40`): the target keeps the carried context waiting behind the
/// command's marker, in front of the person's next message there.
pub fn adopt_machine_handoff(
    store: &EngineStore,
    state: &mut State,
    id: &str,
    input: MachineAdoption,
) -> Result<(), EngineError> {
    let carried = &input.handoff;
    let from = carried
        .origin
        .as_ref()
        .map(|origin| origin.provider.clone())
        .unwrap_or_else(|| input.provider.clone());
    let marker = machine_handoff_marker(&input.command_id);
    let note = machine_handoff_note(&input.machine);
    store.atomic(|_tx| {
        let previous = state.transition_get(store, id)?;
        let mut context = previous.context.clone();
        context.push(note.clone());
        let mut metadata = crate::transitions::metadata::metadata_json(&previous);
        metadata.insert("handoff", handoff_value(carried));
        metadata.insert("marker", Value::from(marker.as_str()));
        metadata.insert(
            "context",
            Value::Array(context.into_iter().map(Value::from).collect()),
        );
        state.transition_set(store, id, &Value::Object(metadata))?;
        let sources: Vec<Value> = if carried.sources.is_empty() {
            vec![model_value(&Model {
                provider: from.clone(),
                model: None,
            })]
        } else {
            carried.sources.iter().map(model_value).collect()
        };
        let mut to = ace_json::Map::new();
        to.insert("provider", Value::from(input.provider.as_str()));
        if let Some(model) = &input.model {
            to.insert("model", Value::from(model.as_str()));
        }
        let mut origin = ace_json::Map::new();
        origin.insert("kind", Value::from("handoff"));
        let mut from_value = ace_json::Map::new();
        from_value.insert("provider", Value::from(from.as_str()));
        origin.insert("from", Value::Object(from_value));
        origin.insert("to", Value::Object(to));
        origin.insert("sources", Value::Array(sources.into()));
        origin.insert("lossy", Value::Bool(true));
        state.synthetic_input(
            store,
            id,
            &marker,
            &handoff::render_handoff(carried),
            &Value::Object(origin),
            input.at,
        )
    })
}

fn model_value(model: &Model) -> Value {
    let mut value = ace_json::Map::new();
    value.insert("provider", Value::from(model.provider.as_str()));
    if let Some(name) = &model.model {
        value.insert("model", Value::from(name.as_str()));
    }
    Value::Object(value)
}

fn handoff_value(handoff: &PortableHandoff) -> Value {
    handoff.to_value()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::testsupport::{Shell, header, home};

    fn history_message(conn: &std::sync::Arc<ace_store::Connection>, id: &str, seq: i64) {
        let item = format!(
            r#"{{"id":"{id}","agentId":"root","type":"message","role":"user","complete":true,"createdAt":{seq},"origin":{{"kind":"person"}},"parts":[{{"type":"text","text":"{id} carried words"}}]}}"#
        );
        conn.exec(&format!(
            "INSERT INTO history_items VALUES ('{id}', 't', {seq}, {seq});
             INSERT INTO history_item_revisions VALUES ('{id}', {seq}, {})",
            crate::repository::testsupport::sql_text(&item)
        ))
        .expect("history");
    }

    // From `context-handoff.process.test.ts`: a handoff carried to another machine says where it
    // came from, and its marker is the command's own so a retry is recognised.
    #[test]
    fn a_machine_handoff_names_the_machine_it_came_from() {
        assert_eq!(
            machine_handoff_note("studio"),
            "This thread continues one from studio. The handoff above was carried from there: \
             its earlier items, full tool output and attachments stayed on studio and can't be read from this machine."
        );
        assert_eq!(machine_handoff_marker("cmd-1"), "handoff:cmd-1");
        assert_eq!(MACHINE_HANDOFF_BYTES, 32_768);
    }

    // From `context-handoff.process.test.ts`: a move carries the same bounded handoff a provider
    // switch builds, waiting behind the command's marker.
    #[test]
    fn a_machine_handoff_is_captured_and_adopted_behind_its_marker() {
        let mut head = header("t");
        head = head.replace(
            "\"initialRoot\":{\"agent\":\"root\"",
            "\"rootKey\":\"root\",\"initialRoot\":{\"agent\":\"root\"",
        );
        head = head.replace(
            "\"agents\":{}",
            "\"agents\":{\"root\":{\"agent\":{\"id\":\"root\",\"threadId\":\"t\",\"origin\":\"root\",\"native\":{\"provider\":\"claude\"},\"fidelity\":\"full\",\"cwd\":\"/w\",\"status\":{\"state\":\"idle\"},\"createdAt\":1},\"activity\":\"idle\",\"lastSignalAt\":1}}",
        );
        let conn = home("t", &head);
        let (store, shell) = Shell::store_with_controls(&conn);
        shell.head(20.0);
        for (id, seq) in [("m1", 10), ("m2", 20)] {
            history_message(&conn, id, seq);
        }
        let mut state = State::default();
        state.repo.probe_passthrough = true;
        let carried = capture_machine_handoff(&store, &mut state, "t", "claude").expect("capture");
        assert_eq!(
            carried
                .excerpts
                .iter()
                .map(|excerpt| excerpt.item_id.as_str())
                .collect::<Vec<_>>(),
            ["m1", "m2"]
        );
        adopt_machine_handoff(
            &store,
            &mut state,
            "t",
            MachineAdoption {
                handoff: carried,
                command_id: "cmd".into(),
                machine: "studio".into(),
                provider: "codex".into(),
                model: Some("gpt".into()),
                at: 5.0,
            },
        )
        .expect("adopt");
        let metadata = state.transition_get(&store, "t").expect("metadata");
        assert_eq!(metadata.marker.as_deref(), Some("handoff:cmd"));
        assert!(metadata.handoff.is_some());
        assert_eq!(
            metadata.context.last().map(String::as_str),
            Some(machine_handoff_note("studio").as_str())
        );
    }
}
