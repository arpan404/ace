//! A paused bot moving to another machine (ADR 0187, ADR 0200 §6.1). Its pause goes with it:
//! the move's manifest carries each moving bot's stored pause, the wakes met meanwhile, the
//! services Pause stopped and the routine slots it held (each routine that was on, with its due
//! slot). The other machine writes them into its own pauses in the cutover's transaction, so the
//! bot arrives paused; Resume there fires each held wake once, starts the services again and
//! turns those routines back on at their held slot, so each slot that came due catches up once.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use spade_store::{HEARTBEAT, ROUTINE, StoreError};

use super::super::Engine;
use super::{Stored, lock};

/// A routine slot a paused bot held as it moved: the routine was on, and its next slot was
/// `due_ms`. The move's arrival pauses every routine; Resume turns this one on at that slot.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(in crate::engine) struct HeldSlot {
    pub(in crate::engine) routine: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(in crate::engine) due_ms: Option<i64>,
}

/// The arriving bots' pauses (`moving`, as the manifest carries them) written into the pauses
/// held here (`held`, the setting's text): only bots the move brings, each read leniently, one
/// that can't be read left out. Pure.
pub(in crate::engine) fn merged(held: Option<&str>, moving: &Value, agents: &[String]) -> String {
    let mut all: HashMap<String, Value> = held
        .and_then(|text| serde_json::from_str(text).ok())
        .unwrap_or_default();
    if let Some(moving) = moving.as_object() {
        for (agent, pause) in moving {
            if !agents.contains(agent) {
                continue;
            }
            if let Ok(pause) = serde_json::from_value::<Stored>(pause.clone()) {
                all.insert(
                    agent.clone(),
                    serde_json::to_value(pause).unwrap_or_default(),
                );
            }
        }
    }
    serde_json::to_string(&all).unwrap_or_else(|_| "{}".to_owned())
}

impl Engine {
    /// The pauses of the bots in `agents` that are paused, as a move carries them: each with
    /// the wakes met meanwhile (those still being written too) and the routine slots it holds.
    /// `None` when none of them is paused.
    pub(in crate::engine) fn pauses_to_move(
        &self,
        agents: &[String],
    ) -> Result<Option<Value>, StoreError> {
        let mut stored = self.stored_pauses()?;
        let unsaved = lock(&self.pause_hold.unsaved).clone();
        let mut moving = serde_json::Map::new();
        for agent in agents {
            let Some(mut pause) = stored.remove(agent) else {
                continue;
            };
            for met in unsaved.get(agent).into_iter().flatten() {
                if !pause.held.iter().any(|m| m.wake == met.wake) {
                    pause.held.push(met.clone());
                }
            }
            for kind in [ROUTINE, HEARTBEAT] {
                for routine in self.store.routines_of(agent, kind)? {
                    if !routine.paused && !pause.routines.iter().any(|s| s.routine == routine.id) {
                        pause.routines.push(HeldSlot {
                            routine: routine.id.clone(),
                            due_ms: routine.next_due_ms,
                        });
                    }
                }
            }
            moving.insert(
                agent.clone(),
                serde_json::to_value(&pause).unwrap_or_default(),
            );
        }
        Ok((!moving.is_empty()).then_some(Value::Object(moving)))
    }

    /// The bots in `agents` moved away: their pauses here go with them.
    pub(in crate::engine) fn forget_moved_pauses(
        &self,
        agents: &[String],
    ) -> Result<(), StoreError> {
        self.change_pauses(|stored| {
            for agent in agents {
                stored.remove(agent);
            }
        })?;
        let mut unsaved = lock(&self.pause_hold.unsaved);
        for agent in agents {
            unsaved.remove(agent);
        }
        drop(unsaved);
        self.forget_pauses();
        Ok(())
    }

    /// Resume: each routine slot the pause held as it moved comes back on at that slot, so one
    /// that came due runs once (`caught_up`). A routine the person changed since, or removed,
    /// is left as it is.
    pub(super) fn turn_on_held_slots(&self, agent: &str, slots: &[HeldSlot]) {
        for slot in slots {
            let routine = match self.store.routine(&slot.routine) {
                Ok(Some(routine)) if routine.agent_id == agent && routine.paused => routine,
                Ok(_) => continue,
                Err(error) => {
                    tracing::warn!(%error, %agent, "a held routine slot could not be read");
                    continue;
                }
            };
            if let Err(error) = crate::routines::turn_on_at(self, routine, slot.due_ms) {
                tracing::warn!(%error, %agent, "a held routine stays paused after resume");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::merged;

    #[test]
    fn only_the_moving_bots_readable_pauses_join_the_ones_held_here() {
        let held = r#"{"a_here":{"at_ms":1}}"#;
        let moving = json!({
            "a_moved": { "at_ms": 5, "held": [{ "wake": "w1", "cause": "condition" }],
                         "routines": [{ "routine": "r1", "due_ms": 9 }] },
            "a_stranger": { "at_ms": 6 },
            "a_broken": { "at_ms": "soon" },
        });
        let agents = ["a_moved".to_owned(), "a_broken".to_owned()];
        let all: serde_json::Value =
            serde_json::from_str(&merged(Some(held), &moving, &agents)).unwrap_or_default();
        assert_eq!(all["a_here"]["at_ms"], 1);
        assert_eq!(all["a_moved"]["at_ms"], 5);
        assert_eq!(all["a_moved"]["held"][0]["wake"], "w1");
        assert_eq!(all["a_moved"]["routines"][0]["due_ms"], 9);
        assert!(all["a_stranger"].is_null(), "not a bot this move brings");
        assert!(all["a_broken"].is_null(), "not readable");
    }
}
