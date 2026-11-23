//! The person's asks in the engine (ADR 0215). The rules are `spade_core::asks`; this keeps each
//! conversation's ledger advanced in memory, answers `asks` calls and runs the stop check.

use serde_json::Value;
use spade_core::Event;
use spade_core::asks::{self, Ledger};
use spade_core::event::Known;
use spade_core::maintenance::{Point, halts};
use spade_core::turn::stop_requested;
use spade_store::StoreError;

use super::Engine;
use crate::tools::ToolOutput;

impl Engine {
    /// The conversation's ledger as of `events`: the one kept from the last read, advanced over
    /// the events stored since, so a step reads only what is new. Folded from the latest
    /// compaction when none is kept (the first read since Spade started).
    pub(super) fn asks_of(&self, id: &str, events: &[Event]) -> Ledger {
        let live = self.live(id);
        let mut kept = live.asks.lock().unwrap_or_else(|p| p.into_inner());
        let ledger = match kept.take() {
            Some(mut ledger) if ledger.through <= events.len() => {
                ledger.advance(events);
                ledger
            }
            _ => Ledger::of(events),
        };
        *kept = Some(ledger.clone());
        ledger
    }

    /// Answers an `asks` call: stores what it accepted with its result, or gives the refusal as
    /// the result. Checked and stored under the lock every write holds, so several calls in one
    /// step each see the ones before. `None` when the person stopped the reply.
    pub(super) fn asks_call(
        &self,
        id: &str,
        reply: &str,
        call_id: &str,
        arguments: &Value,
        untrusted: bool,
    ) -> Result<Option<ToolOutput>, StoreError> {
        let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
        let events = self.load(id)?;
        if stop_requested(&events, reply) {
            return Ok(None);
        }
        // Stored once: a call run again after a restart answers from what it stored.
        let stored = events.iter().rev().find_map(|event| match event {
            Event::Known(Known::AsksUpdated(updated)) if updated.call_id == call_id => {
                Some(updated)
            }
            _ => None,
        });
        if let Some(updated) = stored {
            let lines: Vec<String> = updated.changes.iter().map(asks::change::line).collect();
            return Ok(Some(ToolOutput::ok(lines.join("\n"))));
        }
        let ledger = self.asks_of(id, &events);
        Ok(Some(
            match asks::change::decide(&ledger, arguments, !untrusted) {
                Ok(accepted) => {
                    let updated = asks::Updated {
                        call_id: call_id.to_owned(),
                        changes: accepted.changes,
                    };
                    self.append_events(id, &[Event::Known(Known::AsksUpdated(updated))])?;
                    ToolOutput::ok(accepted.result)
                }
                Err(why) => ToolOutput::error(why),
            },
        ))
    }
}

/// The stop check, after a step of `reply` made no calls: stores `asks_checked` and answers
/// true when the reply must take one more step. Never for a helper, a paused bot, a stopped
/// reply or while Spade pauses.
pub(super) fn check(engine: &Engine, id: &str, reply: &str) -> bool {
    if !engine.limits.asks || engine.helper_of(id).is_some() || engine.paused(id) {
        return false;
    }
    if halts(*engine.pause.borrow(), Point::Between) {
        return false;
    }
    let _order = engine.record_lock.lock().unwrap_or_else(|p| p.into_inner());
    let Ok(events) = engine.load(id) else {
        return false;
    };
    if stop_requested(&events, reply) {
        return false;
    }
    let ledger = engine.asks_of(id, &events);
    let Some(checked) = asks::check::due(&events, &ledger, reply) else {
        return false;
    };
    match engine.append_events(id, &[Event::Known(Known::AsksChecked(checked))]) {
        Ok(_) => true,
        Err(error) => {
            tracing::warn!(%error, "could not store the asks check; the reply ends");
            false
        }
    }
}
