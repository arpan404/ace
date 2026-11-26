// SPDX-License-Identifier: Apache-2.0
//! The OpenCode translator (`packages/adapter-opencode/src/translator.ts`).
//! Frames in, facts out, never an error: a failed decode is a diagnostic
//! plus a signal fact, as the TypeScript does. Keys stay namespaced per
//! provider process; the fact JSON matches the TypeScript field for field.

use crate::translate::data::Num;
use crate::translate::data::{fields, s_in};
use crate::translate::state::{NativeState, Out, StateError};
use ace_json::{Map, Value};
use serde::Serialize;
use std::collections::HashSet;

pub(crate) const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

/// A diagnostic kept outside the transcript until the shell drains it.
pub(crate) struct Diagnostic {
    pub(crate) typ: String,
    pub(crate) data: OwnedDatum,
}

pub(crate) enum OwnedDatum {
    /// The frame's redacted encoding, kept as produced without re-encoding.
    Verbatim(String),
    /// Sanitized evidence, owned after redaction.
    Owned(Value),
}

impl Serialize for OwnedDatum {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            OwnedDatum::Verbatim(text) => match ace_json::Raw::from_json(text) {
                Ok(raw) => raw.serialize(serializer),
                Err(_) => serializer.serialize_none(),
            },
            OwnedDatum::Owned(value) => value.serialize(serializer),
        }
    }
}

#[derive(Serialize)]
pub(crate) struct DiagnosticJson<'a> {
    #[serde(rename = "type")]
    pub(crate) typ: &'a str,
    pub(crate) data: &'a OwnedDatum,
}

/// The OpenCode translator: native session state plus retry tracking.
pub struct Translator {
    pub(crate) state: NativeState,
    pub(crate) retrying: HashSet<String>,
    pub(crate) diagnostics: Vec<Diagnostic>,
}

impl Translator {
    pub fn new(root_key: String) -> Self {
        Self {
            state: NativeState::new(root_key),
            retrying: HashSet::new(),
            diagnostics: Vec::new(),
        }
    }

    /// Translate one frame, appending the facts array to the shared buffer.
    /// Never fails on provider data: a failed decode becomes the
    /// disconnected fact, as the TypeScript `catch` does.
    pub fn translate_json(
        &mut self,
        frame_json: &str,
        data_json: &str,
        now: f64,
        out: &mut String,
    ) {
        out.push('[');
        let root_value: Value = ace_json::parse(frame_json).unwrap_or(Value::Null);
        let root = fields(&root_value);
        let channel = s_in(root, "channel").to_owned();
        let dir = s_in(root, "dir").to_owned();
        let data_value: Value = ace_json::parse(data_json).unwrap_or(Value::Null);
        let data = fields(&data_value);
        self.diagnostics = vec![Diagnostic {
            typ: if s_in(data, "type").is_empty() {
                channel.clone()
            } else {
                s_in(data, "type").to_owned()
            },
            data: OwnedDatum::Verbatim(data_json.to_owned()),
        }];
        let failed = {
            let mut emitter = Out::new(out);
            self.frame(&channel, &dir, &data_value, None, now, &mut emitter)
                .is_err()
        };
        if failed {
            // The agent reads as disconnected, which already tells the
            // person; the detail is ace's own and goes to the daemon's log
            // with the frame it couldn't read.
            self.state.disconnected = true;
            self.diagnostics.push(Diagnostic {
                typ: String::from("adapter.warning"),
                data: OwnedDatum::Owned(Value::Object({
                    let mut warning = Map::new();
                    warning.insert(
                        String::from("event"),
                        Value::from(String::from("translation-failed")),
                    );
                    warning.insert(
                        String::from("detail"),
                        Value::from(String::from(
                            "OpenCode data could not be translated; execution remains uncertain.",
                        )),
                    );
                    warning.insert(
                        String::from("frame"),
                        Value::from(if s_in(data, "type").is_empty() {
                            channel
                        } else {
                            s_in(data, "type").to_owned()
                        }),
                    );
                    warning
                })),
            });
            let root = self.state.root_key.clone();
            let mut emitter = Out::new(out);
            let _ = emitter.fact(&AgentGone {
                typ: "agent.disconnected",
                agent: &root,
            });
        }
        out.push(']');
    }

    /// Facts implied by time passing: none for OpenCode.
    pub fn tick_json(&mut self, _now: f64, out: &mut String) {
        out.push_str("[]");
    }

    /// Drain the diagnostics since the last translation.
    pub fn take_diagnostics_json(&mut self, out: &mut String) {
        out.push('[');
        let mut first = true;
        for diagnostic in &self.diagnostics {
            if !first {
                out.push(',');
            }
            first = false;
            let json = DiagnosticJson {
                typ: &diagnostic.typ,
                data: &diagnostic.data,
            };
            match ace_json::ser::to_string(&json) {
                Ok(text) => out.push_str(&text),
                Err(_) => break,
            }
        }
        self.diagnostics.clear();
        out.push(']');
    }

    pub fn is_settled(&self) -> bool {
        self.state.settled()
    }

    /// The messages with live work for a session, oldest first.
    /// The messages with live work for a session, oldest first.
    pub fn live_messages(&self, session: &str) -> Vec<String> {
        match self.state.live_messages.get(session) {
            Some(messages) => messages.keys().cloned().collect(),
            None => Vec::new(),
        }
    }

    pub fn live_messages_json(&self, session: &str, out: &mut String) {
        let messages: Vec<&str> = match self.state.live_messages.get(session) {
            Some(messages) => messages.keys().map(String::as_str).collect(),
            None => Vec::new(),
        };
        match ace_json::ser::to_string(&messages) {
            Ok(text) => out.push_str(&text),
            Err(_) => out.push_str("[]"),
        }
    }

    pub fn task_owner(&self, task: &str) -> Option<String> {
        self.state.backgrounds.get(task).cloned()
    }

    /// Whether a native shell still holds its background task open.
    pub fn live_shell(&self, id: &str) -> bool {
        self.state.backgrounds.contains_key(&format!("shell:{id}"))
    }

    /// New execution output proves a transient retry recovered, unlike a heartbeat.
    pub(crate) fn recovered(
        &mut self,
        id: &str,
        typ: &str,
        out: &mut Out<'_>,
    ) -> Result<(), StateError> {
        if !self.retrying.contains(id) {
            return Ok(());
        }
        if !is_progress(typ) {
            return Ok(());
        }
        self.retrying.remove(id);
        let agent = self.state.key(id).to_owned();
        out.fact(&RetryCleared {
            typ: "retry.cleared",
            agent: &agent,
        })?;
        Ok(())
    }
}

pub(crate) fn is_progress(typ: &str) -> bool {
    if typ.starts_with("session.text.") || typ.starts_with("session.reasoning.") {
        return matches!(typ.rsplit('.').next(), Some("started" | "delta" | "ended"));
    }
    if typ.starts_with("session.tool.") {
        let rest = typ.trim_start_matches("session.tool.");
        return matches!(
            rest,
            "called"
                | "progress"
                | "success"
                | "failed"
                | "input.started"
                | "input.delta"
                | "input.ended"
        );
    }
    if typ.starts_with("session.step.") {
        return matches!(
            typ.trim_start_matches("session.step."),
            "streamed" | "ended"
        );
    }
    false
}

#[derive(Serialize)]
pub(crate) struct Signal {
    #[serde(rename = "type")]
    pub(crate) typ: &'static str,
}

#[derive(Serialize)]
pub(crate) struct ProcessStarted {
    #[serde(rename = "type")]
    pub(crate) typ: &'static str,
}

#[derive(Serialize)]
pub(crate) struct ProcessExited<'a> {
    #[serde(rename = "type")]
    pub(crate) typ: &'static str,
    pub(crate) deliberate: bool,
    pub(crate) message: &'a str,
}

#[derive(Serialize)]
pub(crate) struct AgentGone<'a> {
    #[serde(rename = "type")]
    pub(crate) typ: &'static str,
    pub(crate) agent: &'a str,
}

#[derive(Serialize)]
pub(crate) struct AgentBack<'a> {
    #[serde(rename = "type")]
    pub(crate) typ: &'static str,
    pub(crate) agent: &'a str,
}

#[derive(Serialize)]
pub(crate) struct RetryCleared<'a> {
    #[serde(rename = "type")]
    pub(crate) typ: &'static str,
    pub(crate) agent: &'a str,
}

#[derive(Serialize)]
pub(crate) struct NoticeDraft<'a> {
    #[serde(rename = "type")]
    pub(crate) typ: &'static str,
    pub(crate) complete: bool,
    pub(crate) level: &'static str,
    pub(crate) text: &'static str,
    pub(crate) detail: &'a str,
}

#[derive(Serialize)]
pub(crate) struct ItemUpsert<'a, D: Serialize> {
    #[serde(rename = "type")]
    pub(crate) typ: &'static str,
    pub(crate) agent: &'a str,
    pub(crate) item: String,
    pub(crate) draft: D,
}

#[derive(Serialize)]
pub(crate) struct Retry<'a> {
    #[serde(rename = "type")]
    pub(crate) typ: &'static str,
    pub(crate) agent: &'a str,
    pub(crate) on: &'static str,
    pub(crate) attempt: Num,
    pub(crate) until: Num,
    pub(crate) message: &'a str,
}

#[derive(Serialize)]
pub(crate) struct InputConsumed<'a> {
    #[serde(rename = "type")]
    pub(crate) typ: &'static str,
    pub(crate) agent: &'a str,
    #[serde(rename = "nativeInputIds")]
    pub(crate) native_input_ids: Vec<&'a str>,
}

#[derive(Serialize)]
pub(crate) struct InteractionExpired {
    #[serde(rename = "type")]
    pub(crate) typ: &'static str,
    pub(crate) interaction: String,
    pub(crate) state: &'static str,
}
