// SPDX-License-Identifier: Apache-2.0
//! The Pi translator, mirroring `translator.ts` with its helpers.

pub mod context_usage;
pub mod dialogs;
pub mod facts;
pub mod lifecycle;
pub mod messages;
pub mod native;
pub mod tool_handlers;
pub mod tools;
pub mod turn_boundary;

use self::facts::{
    Activity, AgentOnly, InteractionClosed, ProcessExited, QueueChanged, Retry, push_fact,
};
use self::messages::{MessageOutcome, message_facts};
use self::native::{
    bool_field, envelope_type, extract_item, field, list_len, number_field, parse_object, str_field,
};
use ace_adapter_api::{Frame, FrameDirection, Translator};
use ace_core::Fact;
use indexmap::IndexMap;

#[derive(Debug, thiserror::Error)]
pub enum PiError {
    #[error("invalid dialog")]
    InvalidDialog,
}

pub(crate) struct ToolEntry {
    pub(crate) name: String,
    pub(crate) args: Option<ace_json::Raw>,
    pub(crate) length: usize,
    pub(crate) surviving: bool,
}

pub struct PiTranslator {
    pub(crate) agent: String,
    pub(crate) diagnostics: Vec<String>,
    pub(crate) run: u64,
    pub(crate) active: bool,
    pub(crate) message: u64,
    pub(crate) outcome: String,
    pub(crate) last_answer: Option<String>,
    pub(crate) poisoned: bool,
    pub(crate) settled: bool,
    pub(crate) retrying: bool,
    pub(crate) prefix: String,
    pub(crate) deadline: Option<i64>,
    /// JavaScript `Map`s in the TypeScript: insertion order is iteration order.
    pub(crate) tools: IndexMap<String, ToolEntry>,
    pub(crate) dialogs: IndexMap<String, Option<i64>>,
}

impl PiTranslator {
    pub fn new(root_key: String) -> Self {
        Self {
            agent: root_key,
            diagnostics: Vec::new(),
            run: 0,
            active: false,
            message: 0,
            outcome: "completed".to_owned(),
            last_answer: None,
            poisoned: false,
            settled: false,
            retrying: false,
            prefix: "pi".to_owned(),
            deadline: None,
            tools: IndexMap::new(),
            dialogs: IndexMap::new(),
        }
    }

    fn inner(
        &mut self,
        seq: u64,
        dir: &FrameDirection,
        data: &ace_json::Raw,
        now: i64,
    ) -> (Vec<Fact>, bool) {
        let mut retained = false;
        let mut out: Vec<Fact> = Vec::new();
        let map = parse_object(data).unwrap_or_default();
        let type_name = match envelope_type(data) {
            Some(value) => value,
            None => return (out, retained),
        };
        if *dir == FrameDirection::Note {
            if type_name == "started" {
                let pid = str_field(&map, "processId");
                self.prefix = if pid.is_empty() {
                    "pi".to_owned()
                } else {
                    format!("pi:{pid}")
                };
                push_fact(
                    &mut out,
                    "process.started",
                    &self::facts::TypeOnly {
                        fact_type: "process.started".to_owned(),
                    },
                );
                return (out, retained);
            }
            if type_name == "exited" {
                self.tools.clear();
                self.dialogs.clear();
                self.deadline = None;
                self.active = false;
                self.settled = false;
                self.retrying = false;
                push_fact(
                    &mut out,
                    "process.exited",
                    &ProcessExited {
                        fact_type: "process.exited".to_owned(),
                        deliberate: bool_field(&map, "deliberate").unwrap_or(false),
                        message: str_field(&map, "message"),
                    },
                );
                return (out, retained);
            }
            if type_name == "dialog_expired" {
                let id = str_field(&map, "id");
                if self.dialogs.shift_remove(&id).is_none() {
                    return (out, retained);
                }
                self.refresh_deadline();
                push_fact(
                    &mut out,
                    "interaction.closed",
                    &InteractionClosed {
                        fact_type: "interaction.closed".to_owned(),
                        interaction: id,
                        state: "expired".to_owned(),
                    },
                );
                out.extend(self.finish());
                return (out, retained);
            }
        }
        if *dir == FrameDirection::Send {
            if type_name == "extension_ui_response" {
                let id = str_field(&map, "id");
                if self.dialogs.shift_remove(&id).is_none() {
                    return (out, retained);
                }
                self.refresh_deadline();
                let cancelled = bool_field(&map, "cancelled").unwrap_or(false);
                push_fact(
                    &mut out,
                    "interaction.closed",
                    &InteractionClosed {
                        fact_type: "interaction.closed".to_owned(),
                        interaction: id,
                        state: if cancelled {
                            "cancelled".to_owned()
                        } else {
                            "resolved".to_owned()
                        },
                    },
                );
                out.extend(self.finish());
            }
            return (out, retained);
        }
        if *dir != FrameDirection::Recv {
            return (out, retained);
        }
        match type_name.as_str() {
            "agent_start" => out.extend(self.start()),
            "agent_end" => {}
            "agent_settled" => self.on_settled(&mut out),
            "message_start" => self.message += 1,
            "message_update" => self.on_message_update(&map, &mut out),
            "message_end" => {
                let result = message_facts(&self.agent, &self.prefix, self.message, data);
                for fact in &result.facts {
                    if fact.fact_type == "item.upsert"
                        && fact.data.get().contains("\"role\":\"assistant\"")
                        && let Some(item) = extract_item(&fact.data)
                    {
                        self.last_answer = Some(item);
                    }
                }
                if result
                    .facts
                    .iter()
                    .any(|fact| fact.fact_type == "item.upsert")
                {
                    retained = true;
                }
                if let Some(outcome) = result.outcome {
                    self.outcome = match outcome {
                        MessageOutcome::Completed => "completed",
                        MessageOutcome::Failed => "failed",
                        MessageOutcome::Interrupted => "interrupted",
                    }
                    .to_owned();
                }
                out.extend(result.facts);
            }
            "tool_execution_start" => {
                retained |= self.on_tool_start(seq, &map, data, now, &mut out);
            }
            "tool_execution_update" | "tool_execution_end" => {
                retained |= self.on_tool_update(
                    seq,
                    &map,
                    data,
                    now,
                    type_name == "tool_execution_end",
                    &mut out,
                );
            }
            "extension_ui_request" => {
                retained |= self.on_dialog(seq, &map, data, now, &mut out);
            }
            "queue_update" => {
                push_fact(
                    &mut out,
                    "queue.changed",
                    &QueueChanged {
                        fact_type: "queue.changed".to_owned(),
                        source: "provider".to_owned(),
                        count: list_len(&map, "steering") + list_len(&map, "followUp"),
                    },
                );
            }
            "compaction_start" => {
                out.extend(self.start());
                push_fact(
                    &mut out,
                    "activity",
                    &Activity {
                        fact_type: "activity".to_owned(),
                        agent: self.agent.clone(),
                        activity: "compacting".to_owned(),
                    },
                );
            }
            "compaction_end" => {}
            "auto_retry_start" | "summarization_retry_scheduled" => {
                self.retrying = true;
                out.extend(self.start());
                let attempt = match number_field(&map, "attempt") {
                    Some(value) if value.is_finite() && value.fract() == 0.0 => Some(value as i64),
                    _ => None,
                };
                push_fact(
                    &mut out,
                    "retry",
                    &Retry {
                        fact_type: "retry".to_owned(),
                        agent: self.agent.clone(),
                        on: "upstream".to_owned(),
                        message: str_field(&map, "errorMessage"),
                        attempt,
                    },
                );
            }
            "auto_retry_end" => {
                if !bool_field(&map, "success").unwrap_or(true) {
                    self.outcome = "failed".to_owned();
                    return (out, retained);
                }
                out.extend(self.recovered());
            }
            "summarization_retry_finished" => {
                self.retrying = false;
                push_fact(
                    &mut out,
                    "retry.cleared",
                    &AgentOnly {
                        fact_type: "retry.cleared".to_owned(),
                        agent: self.agent.clone(),
                    },
                );
            }
            "extension_error" => {
                let text = {
                    let error = str_field(&map, "error");
                    if error.is_empty() {
                        "Pi operation failed".to_owned()
                    } else {
                        error
                    }
                };
                if let Some(fact) = self.notice(seq, data, &text, "error") {
                    out.push(fact);
                }
                retained = true;
            }
            "response" if !bool_field(&map, "success").unwrap_or(true) => {
                let text = {
                    let error = str_field(&map, "error");
                    if error.is_empty() {
                        "Pi operation failed".to_owned()
                    } else {
                        error
                    }
                };
                if let Some(fact) = self.notice(seq, data, &text, "error") {
                    out.push(fact);
                }
                retained = true;
            }
            "entry_appended" | "session_info_changed" | "thinking_level_changed" => {}
            "turn_start" => self.last_answer = None,
            "turn_end" => {}
            _ => {}
        }
        (out, retained)
    }

    fn on_settled(&mut self, out: &mut Vec<Fact>) {
        if !self.active || self.poisoned {
            return;
        }
        self.settled = true;
        for (id, tool) in self.tools.iter_mut() {
            if tool.surviving {
                continue;
            }
            tool.surviving = true;
            push_fact(
                out,
                "background.started",
                &self::facts::BackgroundStarted {
                    fact_type: "background.started".to_owned(),
                    agent: self.agent.clone(),
                    task: format!("{}:tool:{id}", self.prefix),
                    item: format!("{}:tool:{id}", self.prefix),
                    kind: if tool.name == "bash" {
                        "shell".to_owned()
                    } else {
                        "other".to_owned()
                    },
                    title: format!("Pi {} has no terminal result", tool.name),
                    stoppable: false,
                },
            );
        }
        out.extend(self.finish());
    }

    fn on_message_update(&mut self, map: &native::Fields, out: &mut Vec<Fact>) {
        let delta_map = match field(map, "assistantMessageEvent") {
            Some(raw) => parse_object(raw).unwrap_or_default(),
            None => return,
        };
        let kind = str_field(&delta_map, "type");
        if kind != "text_delta" && kind != "thinking_delta" {
            return;
        }
        let index = match number_field(&delta_map, "contentIndex") {
            Some(value) if value.is_finite() && value.fract() == 0.0 && value >= 0.0 => {
                value as u64
            }
            _ => 0,
        };
        let delta = str_field(&delta_map, "delta");
        out.extend(self.start());
        out.extend(self.recovered());
        push_fact(
            out,
            "item.delta",
            &self::facts::ItemDelta {
                fact_type: "item.delta".to_owned(),
                agent: self.agent.clone(),
                item: format!("{}:message:{}:{index}", self.prefix, self.message),
                field: if kind == "text_delta" {
                    "text".to_owned()
                } else {
                    "reasoning".to_owned()
                },
                append: delta,
            },
        );
    }
}

impl Translator for PiTranslator {
    fn take_diagnostics(&mut self) -> Vec<String> {
        std::mem::take(&mut self.diagnostics)
    }

    fn next_deadline(&self) -> Option<i64> {
        self.deadline
    }

    fn translate(&mut self, frame: &Frame, now_ms: i64) -> Vec<Fact> {
        self.diagnostics.clear();
        let (facts, retained) = self.inner(frame.seq, &frame.dir, &frame.data, now_ms);
        if !retained {
            let has_raw = facts.iter().any(|fact| fact.data.get().contains("\"raw\""));
            if !has_raw {
                self.diagnostics.push(self.raw_diag(&frame.data));
            }
        }
        facts
    }

    fn tick(&mut self, now_ms: i64) -> Vec<Fact> {
        let mut out = Vec::new();
        let mut expired = Vec::new();
        for (id, due) in &self.dialogs {
            if let Some(due_value) = due
                && now_ms >= *due_value
            {
                expired.push(id.clone());
            }
        }
        for id in expired {
            self.dialogs.shift_remove(&id);
            push_fact(
                &mut out,
                "interaction.closed",
                &InteractionClosed {
                    fact_type: "interaction.closed".to_owned(),
                    interaction: id,
                    state: "expired".to_owned(),
                },
            );
        }
        self.refresh_deadline();
        out.extend(self.finish());
        out
    }
}
