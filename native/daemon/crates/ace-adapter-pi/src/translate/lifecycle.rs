// SPDX-License-Identifier: Apache-2.0
//! Turn lifecycle helpers for the Pi translator.

use super::PiTranslator;
use super::facts::{AgentOnly, TurnEnded, TurnStarted, push_fact};
use super::native::raw_type_of;
use ace_core::RawFact;

impl PiTranslator {
    pub(super) fn refresh_deadline(&mut self) {
        let mut best: Option<i64> = None;
        for due in self.dialogs.values().flatten() {
            best = Some(match best {
                Some(current) => current.min(*due),
                None => *due,
            });
        }
        self.deadline = best;
    }

    pub(super) fn raw_diag(&self, data: &serde_json::value::RawValue) -> String {
        super::facts::raw_json(&raw_type_of(data, "unknown"), data)
            .unwrap_or_else(|| "{\"type\":\"unknown\"}".to_owned())
    }

    pub(super) fn notice(
        &self,
        seq: u64,
        data: &serde_json::value::RawValue,
        text: &str,
        level: &str,
    ) -> Option<RawFact> {
        let draft = super::facts::NoticeDraft {
            draft_type: "notice".to_owned(),
            complete: true,
            text: text.to_owned(),
            level: level.to_owned(),
            raw: vec![super::facts::RawPayload {
                payload_type: raw_type_of(data, "unknown"),
                data,
            }],
        };
        let upsert = super::facts::ItemUpsertNotice {
            fact_type: "item.upsert".to_owned(),
            agent: self.agent.clone(),
            item: format!("{}:notice:{seq}", self.prefix),
            draft,
        };
        super::facts::make_fact("item.upsert", &upsert)
    }

    pub(super) fn start(&mut self) -> Vec<RawFact> {
        self.settled = false;
        if self.active {
            return Vec::new();
        }
        self.active = true;
        self.outcome = "completed".to_owned();
        self.run += 1;
        let mut out = Vec::new();
        push_fact(
            &mut out,
            "turn.started",
            &TurnStarted {
                fact_type: "turn.started".to_owned(),
                agent: self.agent.clone(),
                native_turn_id: format!("{}:run:{}", self.prefix, self.run),
                trigger: "unknown".to_owned(),
            },
        );
        out
    }

    pub(super) fn recovered(&mut self) -> Vec<RawFact> {
        if !self.retrying {
            return Vec::new();
        }
        self.retrying = false;
        let mut out = Vec::new();
        push_fact(
            &mut out,
            "retry.cleared",
            &AgentOnly {
                fact_type: "retry.cleared".to_owned(),
                agent: self.agent.clone(),
            },
        );
        out
    }

    pub(super) fn unanswerable(
        &mut self,
        seq: u64,
        data: &serde_json::value::RawValue,
    ) -> Vec<RawFact> {
        self.poisoned = true;
        let mut out = Vec::new();
        if let Some(fact) = self.notice(
            seq,
            data,
            "Pi live state cannot be represented; completion is uncertain",
            "error",
        ) {
            out.push(fact);
        }
        push_fact(
            &mut out,
            "agent.disconnected",
            &AgentOnly {
                fact_type: "agent.disconnected".to_owned(),
                agent: self.agent.clone(),
            },
        );
        out
    }

    pub(super) fn finish(&mut self) -> Vec<RawFact> {
        if !self.active || !self.settled || self.poisoned || !self.dialogs.is_empty() {
            return Vec::new();
        }
        self.active = false;
        self.retrying = false;
        let mut out = Vec::new();
        push_fact(
            &mut out,
            "retry.cleared",
            &AgentOnly {
                fact_type: "retry.cleared".to_owned(),
                agent: self.agent.clone(),
            },
        );
        push_fact(
            &mut out,
            "turn.ended",
            &TurnEnded {
                fact_type: "turn.ended".to_owned(),
                agent: self.agent.clone(),
                native_turn_id: format!("{}:run:{}", self.prefix, self.run),
                outcome: self.outcome.clone(),
            },
        );
        out
    }
}
