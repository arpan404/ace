// SPDX-License-Identifier: Apache-2.0
//! Every event as `JSON.stringify` writes it: `type` first, then the fields in the order of the
//! TypeScript object literal that built the event (`packages/core/src/reduce.ts` and the modules
//! it calls), optional fields omitted. Events are persisted, so their bytes must match the
//! TypeScript's exactly; a serde-tagged enum would order fields by declaration, which drifts.
//!
//! A `usage.updated` or `context.sampled` event spreads the validated fact's own fields (the
//! TypeScript's `...usage`), so their order is the adapter's and is spliced from the fact.

use serde::Serialize;

use crate::emit::Event;

/// Builds one JSON object by appending members, all in one buffer.
pub struct Object<'o> {
    out: &'o mut String,
    wrote: bool,
}

impl<'o> Object<'o> {
    fn new(out: &'o mut String) -> Object<'o> {
        out.push('{');
        Object { out, wrote: false }
    }

    fn key(&mut self, key: &str) {
        if std::mem::replace(&mut self.wrote, true) {
            self.out.push(',');
        }
        ace_json::write_str(self.out, key);
        self.out.push(':');
    }

    fn str(&mut self, key: &str, value: &str) {
        self.key(key);
        ace_json::write_str(self.out, value);
    }

    /// A JavaScript string: a lone surrogate writes as its `\uXXXX` escape.
    fn js_str(&mut self, key: &str, value: &ace_json::JsString) {
        self.key(key);
        ace_json::write_js_string(self.out, value);
    }

    fn number(&mut self, key: &str, value: f64) {
        self.key(key);
        ace_json::write_number(self.out, value);
    }

    fn bool(&mut self, key: &str, value: bool) {
        self.key(key);
        self.out.push_str(if value { "true" } else { "false" });
    }

    /// A nested value, serialized with JavaScript numbers and spliced in place.
    fn value<T: Serialize + ?Sized>(&mut self, key: &str, value: &T) {
        self.key(key);
        // A value this crate built cannot fail to serialize.
        let _ = ace_json::ser::write_into(self.out, value);
    }

    fn null(&mut self, key: &str) {
        self.key(key);
        self.out.push_str("null");
    }

    /// A field that distinguishes absent (the outer `None`) from an explicit `null`.
    fn opt_opt_str(&mut self, key: &str, value: &Option<Option<String>>) {
        match value {
            None => {}
            Some(None) => self.null(key),
            Some(Some(text)) => self.str(key, text),
        }
    }

    fn opt_str(&mut self, key: &str, value: Option<&str>) {
        if let Some(value) = value {
            self.str(key, value);
        }
    }

    fn opt_number(&mut self, key: &str, value: Option<i64>) {
        if let Some(value) = value {
            self.number(key, value as f64);
        }
    }

    fn opt_bool(&mut self, key: &str, value: Option<bool>) {
        if let Some(value) = value {
            self.bool(key, value);
        }
    }

    fn opt_value<T: Serialize + ?Sized>(&mut self, key: &str, value: Option<&T>) {
        if let Some(value) = value {
            self.value(key, value);
        }
    }

    /// Splice members of an object that is already serialized (`{"k":v,...}` members only).
    fn members(&mut self, members: &str) {
        if members.is_empty() {
            return;
        }
        if std::mem::replace(&mut self.wrote, true) {
            self.out.push(',');
        }
        self.out.push_str(members);
    }

    fn finish(self) {
        self.out.push('}');
    }
}

impl Event {
    /// Append this event's `JSON.stringify` text.
    pub fn write_json(&self, out: &mut String) {
        let mut object = Object::new(out);
        match self {
            Event::AgentCreated { agent } => {
                object.str("type", "agent.created");
                object.value("agent", agent);
            }
            Event::AgentStatus {
                agent_id,
                status,
                completion_relevant,
            } => {
                object.str("type", "agent.status");
                object.str("agentId", agent_id);
                object.value("status", status);
                object.bool("completionRelevant", *completion_relevant);
            }
            Event::AgentUpdated {
                agent_id,
                parent_id,
                origin,
                lineage,
                fidelity,
                native,
                cwd,
                name,
                role,
                model,
                background,
                machine,
                child_thread_id,
                spawned_by,
            } => {
                object.str("type", "agent.updated");
                object.str("agentId", agent_id);
                object.opt_opt_str("parentId", parent_id);
                object.opt_str("origin", origin.as_deref());
                object.opt_value("lineage", lineage.as_ref());
                object.opt_str("fidelity", fidelity.as_deref());
                object.opt_value("native", native.as_ref());
                object.opt_str("cwd", cwd.as_deref());
                object.opt_str("name", name.as_deref());
                object.opt_str("role", role.as_deref());
                object.opt_str("model", model.as_deref());
                object.opt_bool("background", *background);
                object.opt_value("machine", machine.as_ref());
                object.opt_str("childThreadId", child_thread_id.as_deref());
                object.opt_opt_str("spawnedBy", spawned_by);
            }
            Event::InputAdmitted {
                agent_id,
                native_input_id,
                command_id,
            } => {
                object.str("type", "input.admitted");
                object.str("agentId", agent_id);
                object.str("nativeInputId", native_input_id);
                object.opt_str("commandId", command_id.as_deref());
            }
            Event::RunStarted { run } => {
                object.str("type", "run.started");
                object.value("run", run);
            }
            Event::RunEnded {
                run_id,
                state,
                ended_by,
                ended_at,
                trigger,
            } => {
                object.str("type", "run.ended");
                object.str("runId", run_id);
                object.str("state", state);
                object.opt_str("endedBy", ended_by.as_deref());
                object.number("endedAt", *ended_at as f64);
                object.opt_str("trigger", trigger.as_deref());
            }
            Event::ItemCreated { item } => {
                object.str("type", "item.created");
                object.value("item", item);
            }
            Event::ItemUpdated { item } => {
                object.str("type", "item.updated");
                object.value("item", item);
            }
            Event::ItemDelta {
                item_id,
                agent_id,
                field,
                append,
            } => {
                object.str("type", "item.delta");
                object.str("itemId", item_id);
                object.str("agentId", agent_id);
                object.str("field", field);
                object.js_str("append", append);
            }
            Event::InteractionOpened { interaction } => {
                object.str("type", "interaction.opened");
                object.value("interaction", interaction);
            }
            Event::InteractionClosed {
                interaction_id,
                state,
                closed_at,
                resolution,
                resolved_by,
                auto_reviewed,
            } => {
                object.str("type", "interaction.closed");
                object.str("interactionId", interaction_id);
                object.str("state", state);
                object.number("closedAt", *closed_at as f64);
                object.opt_value("resolution", resolution.as_ref());
                object.opt_str("resolvedBy", resolved_by.as_deref());
                object.opt_bool("autoReviewed", *auto_reviewed);
            }
            Event::BackgroundTaskStarted { task } => {
                object.str("type", "background_task.started");
                object.value("task", task);
            }
            Event::BackgroundTaskUpdated {
                task_id,
                status,
                ended_at,
            } => {
                object.str("type", "background_task.updated");
                object.str("taskId", task_id);
                object.str("status", status);
                object.opt_number("endedAt", *ended_at);
            }
            Event::UsageUpdated { agent_id, body } => {
                object.str("type", "usage.updated");
                object.str("agentId", agent_id);
                object.members(body);
            }
            Event::ContextSampled { agent_id, body } => {
                object.str("type", "context.sampled");
                object.str("agentId", agent_id);
                object.members(body);
            }
            Event::ThreadUpdated { status } => {
                object.str("type", "thread.updated");
                object.value("status", status);
            }
        }
        object.finish();
    }
}

/// Append a JSON array of events, each in its own `JSON.stringify` text: one buffer, no
/// per-event copy of a payload a provider streamed.
pub fn write_events(events: &[Event], out: &mut String) {
    out.push('[');
    for (index, event) in events.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        event.write_json(out);
    }
    out.push(']');
}

/// Under a serde serializer, an event is its own `JSON.stringify` text, spliced verbatim.
impl Serialize for Event {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut text = String::new();
        self.write_json(&mut text);
        serializer.serialize_newtype_struct("$ace_json::Raw", &text)
    }
}
