// SPDX-License-Identifier: Apache-2.0
//! Turn bracketing (`native-state.ts`: turns). Every agent's work is
//! bracketed by turn.started/turn.ended; surviving tools are held first.

use crate::translate::data::{fields, get, n_in, n_in_fb, s_in, truthy};
use crate::translate::state::{NativeState, Out, StateError};
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::{Map, Value};

impl NativeState {
    /// Start a turn, unless it is already running or ended.
    pub fn start(&mut self, id: &str, turn: &str, out: &mut Out<'_>) -> Result<(), StateError> {
        self.wakes.shift_remove(id);
        if self.active.contains_key(id) || self.ended.has(turn) {
            return Ok(());
        }
        self.active.insert(id.to_owned(), turn.to_owned());
        self.turned.add(id);
        let baseline = self.idle.get(id).copied().unwrap_or(-1.0);
        self.execution_baseline.insert(id.to_owned(), baseline);
        self.execution_created.shift_remove(id);
        let trigger = match self.triggers.get(id) {
            Some(trigger) => trigger.clone(),
            None => match self.agents.get(id) {
                Some(meta) if !meta.parent.is_empty() => String::from("spawn"),
                _ => String::from("unknown"),
            },
        };
        let agent = self.key(id).to_owned();
        out.fact(&TurnStarted {
            typ: "turn.started",
            agent: &agent,
            native_turn_id: turn,
            trigger: &trigger,
        })?;
        out.fact(&RetryCleared {
            typ: "retry.cleared",
            agent: &agent,
        })?;
        Ok(())
    }

    /// Whether the snapshot's idle time proves the turn settled.
    pub fn can_settle(&self, id: &str, idle_at: f64) -> bool {
        if !self.active.contains_key(id) {
            return true;
        }
        idle_at > self.execution_baseline.get(id).copied().unwrap_or(-1.0)
            && idle_at >= self.execution_created.get(id).copied().unwrap_or(-1.0)
    }

    /// Settle an active turn from its authoritative idle snapshot.
    pub fn reconcile_outcome(
        &mut self,
        info: &Map<String, Value>,
        out: &mut Out<'_>,
    ) -> Result<(), StateError> {
        let id = s_in(info, "id");
        let idle_at = n_in(fields(get(info, "time")), "idle");
        if !self.active.contains_key(id) || !self.can_settle(id, idle_at) {
            return Ok(());
        }
        let outcome = s_in(info, "outcome");
        if outcome != "succeeded" && outcome != "failed" && outcome != "interrupted" {
            return Ok(());
        }
        self.end(
            id,
            if outcome == "failed" {
                "failed"
            } else if outcome == "interrupted" {
                "interrupted"
            } else {
                "completed"
            },
            None,
            out,
        )
    }

    /// Note a child first learned from an ancestry read that found it idle.
    pub fn probed(&mut self, info: &Map<String, Value>) {
        let id = s_in(info, "id");
        let time = fields(get(info, "time"));
        let idle_at = n_in(time, "idle");
        if !truthy(get(info, "parentID")) || self.agents.contains_key(id) || idle_at < 0.0 {
            return;
        }
        if idle_at < n_in_fb(time, "updated", f64::INFINITY) {
            return;
        }
        if self.probed_idle.len() >= 1024 {
            self.probed_idle = IndexMap::new();
        }
        self.probed_idle.insert(id.to_owned(), idle_at);
    }

    /// Settle probed children once their ancestry probe delivered its events.
    pub fn settle_probed(&mut self, out: &mut Out<'_>) -> Result<(), StateError> {
        let probed: Vec<(String, f64)> = self
            .probed_idle
            .iter()
            .map(|(id, idle)| (id.to_owned(), *idle))
            .collect();
        for (id, idle_at) in probed {
            self.settle_unstarted(
                &id,
                idle_at,
                &format!("probed:{id}:{idle_at}"),
                "completed",
                out,
            )?;
        }
        self.probed_idle = IndexMap::new();
        Ok(())
    }

    /// Record a past turn an adopted child already finished before ace saw it.
    pub fn settle_unstarted(
        &mut self,
        id: &str,
        idle_at: f64,
        turn: &str,
        outcome: &'static str,
        out: &mut Out<'_>,
    ) -> Result<(), StateError> {
        let has_parent = self
            .agents
            .get(id)
            .is_some_and(|meta| !meta.parent.is_empty());
        if !has_parent || idle_at < 0.0 || self.active.contains_key(id) || self.turned.has(id) {
            return Ok(());
        }
        self.turned.add(id);
        self.ended.add(turn);
        let agent = self.key(id).to_owned();
        out.fact(&TurnEnded {
            typ: "turn.ended",
            agent: &agent,
            native_turn_id: turn,
            outcome,
            historical: Some(true),
            error: None,
        })?;
        Ok(())
    }

    /// End a turn, holding its live tools as bookkeeping work until settled.
    pub fn end(
        &mut self,
        id: &str,
        outcome: &'static str,
        error: Option<&Value>,
        out: &mut Out<'_>,
    ) -> Result<(), StateError> {
        if !self.active.contains_key(id) {
            return Ok(());
        }
        let turn = match self.active.shift_remove(id) {
            Some(turn) => turn,
            None => return Ok(()),
        };
        self.ended.add(&turn);
        let message = match error {
            Some(error) => s_in(fields(error), "message").to_owned(),
            None => String::new(),
        };
        let message = if message.is_empty() {
            String::from("OpenCode execution failed")
        } else {
            message
        };
        self.tool_tails(id, out)?;
        let agent = self.key(id).to_owned();
        out.fact(&RetryCleared {
            typ: "retry.cleared",
            agent: &agent,
        })?;
        let failed = outcome == "failed";
        out.fact(&TurnEnded {
            typ: "turn.ended",
            agent: &agent,
            native_turn_id: &turn,
            outcome,
            historical: None,
            error: if failed {
                Some(TurnError {
                    kind: "provider",
                    message: &message,
                    code: crate::translate::data::failure_code(&message),
                })
            } else {
                None
            },
        })?;
        Ok(())
    }
}

#[derive(Serialize)]
struct TurnStarted<'a> {
    #[serde(rename = "type")]
    typ: &'static str,
    agent: &'a str,
    #[serde(rename = "nativeTurnId")]
    native_turn_id: &'a str,
    trigger: &'a str,
}

#[derive(Serialize)]
struct RetryCleared<'a> {
    #[serde(rename = "type")]
    typ: &'static str,
    agent: &'a str,
}

#[derive(Serialize)]
struct TurnError<'a> {
    kind: &'static str,
    message: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<&'static str>,
}

#[derive(Serialize)]
struct TurnEnded<'a> {
    #[serde(rename = "type")]
    typ: &'static str,
    agent: &'a str,
    #[serde(rename = "nativeTurnId")]
    native_turn_id: &'a str,
    outcome: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<TurnError<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    historical: Option<bool>,
}
