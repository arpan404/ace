// SPDX-License-Identifier: Apache-2.0
//! The Pi translator, mirroring `translator.ts` with its helpers.

pub mod context_usage;
pub mod dialogs;
pub mod facts;
pub mod inner;
pub mod lifecycle;
pub mod messages;
pub mod native;
pub mod tool_handlers;
pub mod tools;
pub mod turn_boundary;

use self::facts::{InteractionClosed, push_fact};
use ace_adapter_api::{Frame, Translator};
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
