//! The task list (ADR 0217 §7, §10): `GET /v1/conversations/{id}/tasks`, and what `tasks` reads.

use serde_json::{Value, json};
use spade_core::goal::ItemStatus;
use spade_core::lane::{self, State};
use spade_store::{StoreError, StoredHelper};

use super::super::Engine;

/// The ended lanes the task list shows when the caller names no number.
pub const ENDED_SHOWN: usize = 20;

/// The most of a lane's last words a row quotes, in characters.
const REPORT_CHARS: usize = 200;

impl Engine {
    /// `main`'s lanes in the list's order: needs you, running, ended, queued. Every lane that
    /// hasn't ended, and the `ended` that ended most recently; never every lane the bot ran
    /// (ADR 0170). `None` for an unknown conversation.
    pub fn lanes_view(&self, main: &str, ended: usize) -> Result<Option<Vec<Value>>, StoreError> {
        if !self.reachable(main)? {
            return Ok(None);
        }
        let mut lanes = self.live_lanes_of(main);
        lanes.extend(self.store.ended_lanes(main, ended)?);
        let mut rows: Vec<(State, i64, Value)> = Vec::new();
        for row in lanes {
            let view = self.lane_view(&row, false)?;
            rows.push((self.lane_state(&row.conversation), row.created_ms, view));
        }
        lane::order(&mut rows, |(state, started, _)| (*state, *started));
        Ok(Some(rows.into_iter().map(|(_, _, view)| view).collect()))
    }

    /// One lane as the list shows it: `{task, conversation, title, state, needs_you, progress,
    /// plan_step, started_ms, ended_ms, cost_micros, asks, moved, report}`. `detailed` adds the
    /// goal and plan, for `tasks`.
    pub(in super::super) fn lane_view(
        &self,
        row: &StoredHelper,
        detailed: bool,
    ) -> Result<Value, StoreError> {
        let events = self.load(&row.conversation)?;
        let state = lane::state(&events, self.around(&row.conversation, &events));
        let link = lane::link(&events);
        let task = spade_core::goal::view::task(&events);
        let progress = task.as_ref().map(|t| {
            json!({ "done": t.progress.items_closed, "total": t.progress.items_total,
                    "verified": t.progress.items_verified })
        });
        let plan_step = task.as_ref().and_then(|t| {
            t.items
                .iter()
                .find(|i| i.status == ItemStatus::Working)
                .or_else(|| t.items.iter().find(|i| i.status == ItemStatus::Open))
                .map(|i| i.text.clone())
        });
        let ended_ms = match state.live() {
            true => None,
            false => self
                .store
                .events(
                    &row.conversation,
                    i64::try_from(events.len()).unwrap_or(0) - 1,
                )?
                .last()
                .map(|e| e.at_ms),
        };
        let report = (!state.live())
            .then(|| spade_core::tree::last_words(&events))
            .flatten()
            .map(|words| {
                let first = words.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
                spade_core::asks::cut(first, REPORT_CHARS)
            });
        let mut view = json!({
            "task": row.conversation,
            "conversation": row.conversation,
            "title": lane::title(&events).unwrap_or_else(|| "A task".to_owned()),
            "state": state.name(),
            "needs_you": state == State::NeedsYou,
            "progress": progress,
            "plan_step": plan_step,
            "started_ms": row.created_ms,
            "ended_ms": ended_ms,
            "cost_micros": spade_core::helper::spent(&events),
            "asks": link.map(|l| l.asks.clone()).unwrap_or_default(),
            "moved": link.is_some_and(|l| l.moved_from.is_some()),
            "model": row.model,
            "report": report,
        });
        if detailed {
            view["goal"] = task.as_ref().map_or(Value::Null, |t| json!(t.goal.text));
            view["plan"] = task.as_ref().map_or(Value::Null, |t| {
                Value::Array(
                    t.items
                        .iter()
                        .map(|i| json!({ "id": i.id, "text": i.text, "status": i.status }))
                        .collect(),
                )
            });
            view["last_words"] = json!(spade_core::tree::last_words(&events));
        }
        Ok(view)
    }
}
