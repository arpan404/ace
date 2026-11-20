//! Archived bots (ADR 0197; ADR 0161, amendment 1). Undo archives a made bot that had already
//! acted: it is kept, stopped, its routines paused, and marked under `archived:{id}` with the
//! routines that were on. Unarchive takes the mark off any archived bot: the routines that were
//! on come back on from their next slot (nothing they missed catches up), the rest stay paused,
//! and nothing is deleted.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use spade_store::{HEARTBEAT, ROUTINE, StoreError};

use super::Engine;

/// The per-bot mark of an archived bot.
fn archived_key(agent: &str) -> String {
    format!("archived:{agent}")
}

/// What the mark keeps. A mark an earlier build wrote (`1`) reads as no routines on.
#[derive(Debug, Default, Serialize, Deserialize)]
struct Archived {
    at_ms: i64,
    /// The routines (and heartbeat) that were on when it was archived, by id.
    #[serde(default)]
    routines_on: Vec<String>,
}

impl Engine {
    /// Whether `agent` is archived.
    pub(crate) fn archived(&self, agent: &str) -> bool {
        self.store
            .setting(&archived_key(agent))
            .ok()
            .flatten()
            .is_some()
    }

    /// Archives `agent`, whose conversation is `conversation`: its work stops, each routine that
    /// is on is paused, and the mark keeps which were, so Unarchive turns those back on.
    pub(super) fn archive_bot(
        self: &Arc<Self>,
        agent: &str,
        conversation: &str,
    ) -> Result<(), StoreError> {
        let _ = self.stop(conversation);
        let mut routines_on = Vec::new();
        for kind in [ROUTINE, HEARTBEAT] {
            for routine in self.store.routines_of(agent, kind)? {
                if !routine.paused {
                    routines_on.push(routine.id.clone());
                }
            }
        }
        // The mark first: a crash after it still knows which routines to turn back on.
        let mark = Archived {
            at_ms: self.now_ms(),
            routines_on,
        };
        let text = serde_json::to_string(&mark).unwrap_or_else(|_| "{}".to_owned());
        self.store.set_setting(&archived_key(agent), Some(&text))?;
        for kind in [ROUTINE, HEARTBEAT] {
            for mut routine in self.store.routines_of(agent, kind)? {
                if !routine.paused {
                    routine.paused = true;
                    routine.next_due_ms = None;
                    self.store.update_routine(&routine)?;
                }
            }
        }
        self.announce(conversation);
        Ok(())
    }

    /// The person unarchives `agent`. `None` for no such bot; else whether it was archived.
    pub fn unarchive_agent(self: &Arc<Self>, agent: &str) -> Result<Option<bool>, StoreError> {
        let Some(found) = self.store.agent(agent)? else {
            return Ok(None);
        };
        let Some(raw) = self.store.setting(&archived_key(agent))? else {
            return Ok(Some(false));
        };
        let mark: Archived = serde_json::from_str(&raw).unwrap_or_default();
        for id in &mark.routines_on {
            let Some(routine) = self.store.routine(id)? else {
                continue;
            };
            if routine.agent_id != agent {
                continue;
            }
            if let Err(error) = crate::routines::turn_on(self, routine) {
                tracing::warn!(%error, %agent, routine = %id, "a routine stays paused after unarchive");
            }
        }
        // The mark goes last: a crash before it leaves the bot archived, and unarchiving again
        // finds the routines it turned on already on.
        self.store.set_setting(&archived_key(agent), None)?;
        self.announce(&found.conversation);
        Ok(Some(true))
    }
}
