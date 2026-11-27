// SPDX-License-Identifier: Apache-2.0
//! The deadline index (E5.3, `persistence.ts:212`-`:239`), over `ace-core`'s `DeadlineIndex`.

use ace_core::deadlines::DeadlineIndex;
use ace_json::Value;

use super::Snapshot;

impl Snapshot {
    /// `deadline` (`:213`): built lazily over the state.
    pub fn deadline(&mut self, provider_deadline: Option<i64>) -> Option<i64> {
        if self.deadlines.is_none() {
            self.deadlines = Some(DeadlineIndex::new(&self.state));
        }
        self.deadlines
            .as_ref()
            .and_then(|index| index.next(provider_deadline))
    }

    /// `setSilenceMs` (`:217`): a changed silence rebuilds the index.
    pub fn set_silence_ms(&mut self, silence_ms: f64) -> bool {
        if self.state.config.silence_ms == silence_ms {
            return false;
        }
        self.state.config.silence_ms = silence_ms;
        self.deadlines = None;
        true
    }

    /// `updateDeadlines` (`:223`): a pure-delta batch signals the agents it names, anything
    /// else rebuilds, and a clock that went backwards (a rollback) rebuilds.
    pub fn update_deadlines(&mut self, facts: &[Value], events: &[Value], now: i64) {
        let rolled_back = self.deadline_observed_at.is_some_and(|at| now < at);
        self.deadline_observed_at = Some(now);
        let Some(index) = &mut self.deadlines else {
            return;
        };
        let kind = |value: &Value| {
            value
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        let pure = !rolled_back
            && facts
                .iter()
                .all(|fact| matches!(kind(fact).as_str(), "item.delta" | "signal"))
            && events.iter().all(|event| kind(event) == "item.delta");
        if !pure {
            index.rebuild(&self.state);
            return;
        }
        let mut agents: Vec<Option<String>> = Vec::new();
        let mut global = false;
        for fact in facts {
            match fact.get("agent") {
                Some(Value::String(agent)) => {
                    let agent = agent.as_str().to_owned();
                    if !agents
                        .iter()
                        .any(|seen| seen.as_deref() == Some(agent.as_str()))
                    {
                        agents.push(Some(agent));
                    }
                }
                _ => global = true,
            }
        }
        let silence = self.state.config.silence_ms;
        if global {
            index.signal(None, now, silence);
        } else {
            for agent in agents {
                index.signal(agent.as_deref(), now, silence);
            }
        }
    }
}
