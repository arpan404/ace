//! Pause and resume (ADR 0200 §6.1). Pause is Stop, then hold: the bot's turn, jobs and workers
//! end now, its services stop, and from then on nothing of it fires. A due wake stays open and
//! armed, a routine's due slot stays due, a message to it is stored and waits. Resume ends the
//! hold: each wake that came due fires once, each routine catches up once, and what waited is
//! answered in order. The pause is stored before anything stops, so it holds through a restart;
//! so is each wake met while it holds, in the same record, so a restart before Resume loses none.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use spade_core::wake::{CancelledBy, Cause, Purpose};
use spade_store::StoreError;

use super::Engine;

/// The setting the paused bots are kept in: `{agent: {"at_ms", "held"}}`.
const PAUSED_BOTS: &str = "paused_bots";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Stored {
    at_ms: i64,
    /// Wakes met while it was paused, fired once on Resume.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    held: Vec<Met>,
}

#[derive(Debug, Clone)]
struct Paused {
    conversation: String,
    at_ms: i64,
}

/// A wake its condition met (or the person woke) while its bot was paused: fired on resume.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Met {
    wake: String,
    cause: Cause,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    what: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    data: Vec<String>,
}

/// The paused bots, read from the setting the first time they are needed.
#[derive(Default)]
pub(super) struct Shared {
    paused: Mutex<Option<HashMap<String, Paused>>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

impl Engine {
    fn stored_pauses(&self) -> Result<HashMap<String, Stored>, StoreError> {
        Ok(self
            .store
            .setting(PAUSED_BOTS)?
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default())
    }

    /// The paused bots, folded from the setting once; a bot that is gone is left out.
    fn pauses(&self) -> MutexGuard<'_, Option<HashMap<String, Paused>>> {
        let mut paused = lock(&self.pause_hold.paused);
        if paused.is_none() {
            match self.stored_pauses() {
                Ok(stored) => {
                    let mut folded = HashMap::new();
                    for (agent, stored) in stored {
                        if let Ok(Some(found)) = self.store.agent(&agent) {
                            folded.insert(
                                agent,
                                Paused {
                                    conversation: found.conversation,
                                    at_ms: stored.at_ms,
                                },
                            );
                        }
                    }
                    *paused = Some(folded);
                }
                // Not remembered, so the next look reads again.
                Err(error) => tracing::error!(%error, "could not read the paused bots"),
            }
        }
        paused
    }

    /// Whether the bot of `conversation` is paused.
    pub(crate) fn paused(&self, conversation: &str) -> bool {
        self.pauses()
            .as_ref()
            .is_some_and(|p| p.values().any(|p| p.conversation == conversation))
    }

    /// When the person paused `agent`; `None` while it isn't paused.
    pub(crate) fn paused_since(&self, agent: &str) -> Option<i64> {
        self.pauses().as_ref()?.get(agent).map(|p| p.at_ms)
    }

    /// The conversations of every paused bot.
    pub(super) fn paused_conversations(&self) -> Vec<String> {
        self.pauses()
            .as_ref()
            .map(|p| p.values().map(|p| p.conversation.clone()).collect())
            .unwrap_or_default()
    }

    /// Whether no turn of `id` may start now: the person has its computer, or paused it.
    pub(super) fn closed(&self, id: &str) -> bool {
        self.held(id) || self.paused(id)
    }

    /// Changes the stored pauses with `change`, read and written under the agent lock in one
    /// write: what it changes lands whole, or not at all.
    fn change_pauses(
        &self,
        change: impl FnOnce(&mut HashMap<String, Stored>),
    ) -> Result<(), StoreError> {
        let _held = lock(&self.agent_lock);
        let mut stored = self.stored_pauses()?;
        change(&mut stored);
        let raw = (!stored.is_empty())
            .then(|| serde_json::to_string(&stored).unwrap_or_else(|_| "{}".to_owned()));
        self.store.set_setting(PAUSED_BOTS, raw.as_deref())
    }

    /// Forgets the folded pauses, so they are read from storage again.
    fn forget_pauses(&self) {
        *lock(&self.pause_hold.paused) = None;
    }

    /// The person pauses `agent`: stored first, so a restart holds it, then its work stops.
    /// `None` for no such bot; else whether it was running (not paused already).
    pub fn pause_agent(self: &Arc<Self>, agent: &str) -> Result<Option<bool>, StoreError> {
        let Some(found) = self.store.agent(agent)? else {
            return Ok(None);
        };
        if self.paused_since(agent).is_some() {
            return Ok(Some(false));
        }
        let at_ms = self.now_ms();
        self.change_pauses(|stored| {
            let held = Vec::new();
            stored.insert(agent.to_owned(), Stored { at_ms, held });
        })?;
        if let Some(paused) = self.pauses().as_mut() {
            paused.insert(
                agent.to_owned(),
                Paused {
                    conversation: found.conversation.clone(),
                    at_ms,
                },
            );
        }
        // Nothing new starts from here on; what runs stops, and the bot's own wakes are kept.
        self.end_work(&found.conversation, Self::hold_wakes)?;
        self.announce(&found.conversation);
        Ok(Some(true))
    }

    /// The person resumes `agent`: what came due while it was paused fires once, and what
    /// waited is answered. `None` for no such bot; else whether it was paused.
    ///
    /// The wakes met meanwhile fire before the stored pause is cleared, each once: a wake fires
    /// only while it is open. A crash in between leaves the bot paused with them still held, and
    /// resuming again finds them fired, so nothing fires twice.
    pub fn resume_agent(self: &Arc<Self>, agent: &str) -> Result<Option<bool>, StoreError> {
        let Some(found) = self.store.agent(agent)? else {
            return Ok(None);
        };
        if self.paused_since(agent).is_none() {
            return Ok(Some(false));
        }
        let held = self
            .stored_pauses()?
            .remove(agent)
            .map(|stored| stored.held)
            .unwrap_or_default();
        // Open in memory from here, so the held wakes fire and what they start runs.
        if let Some(paused) = self.pauses().as_mut() {
            paused.remove(agent);
        }
        let id = found.conversation;
        for met in held {
            self.fire_wake(&id, &met.wake, met.cause, met.what.as_deref(), met.data);
        }
        if let Err(error) = self.change_pauses(|stored| {
            stored.remove(agent);
        }) {
            // It reads paused again, as it will after a restart; Resume can be pressed again,
            // and what fired stays fired.
            self.forget_pauses();
            return Err(error);
        }
        // Wakes due by time fire on the timer's next look.
        self.kick_wakes();
        // Routine slots that came due catch up once, on the routines' next look.
        self.routines_shared().wake.notify_one();
        // Messages that waited are answered.
        self.resume(&id)?;
        self.announce(&id);
        Ok(Some(true))
    }

    /// The person stops `agent`'s work and everything under it. `None` for no such bot; else
    /// whether anything was running.
    pub fn stop_agent(self: &Arc<Self>, agent: &str) -> Result<Option<bool>, StoreError> {
        let Some(found) = self.store.agent(agent)? else {
            return Ok(None);
        };
        self.stop(&found.conversation).map(Some)
    }

    /// Pause's sweep: the stopped work's own wakes end with it (a retry, an outage, a parked
    /// step); the bot's sleeps and waits are kept, held until it resumes; its services stop.
    /// Whether anything ended.
    pub(super) fn hold_wakes(self: &Arc<Self>, id: &str) -> bool {
        let mut any = false;
        for open in self.wakes(id).unwrap_or_default() {
            if matches!(open.purpose, Purpose::Sleep | Purpose::Wait) {
                continue;
            }
            match self.cancel_wake(id, &open.wake, CancelledBy::Stop) {
                Ok(true) => any = true,
                Ok(false) => {}
                Err(error) => tracing::warn!(%error, "Pause could not end a wake"),
            }
        }
        self.stop_services(id) || any
    }

    /// While `id`'s bot is paused a wake doesn't fire. One its condition met, or the person
    /// woke, is stored with the pause, in the one write that marks it held, to fire once on
    /// Resume, after a restart too. One due by time needs nothing stored: the timer finds it
    /// again. Whether it was held.
    pub(super) fn hold_firing(
        &self,
        id: &str,
        wake: &str,
        cause: Cause,
        what: Option<&str>,
        data: &[String],
    ) -> bool {
        let agent = self.pauses().as_ref().and_then(|paused| {
            paused
                .iter()
                .find(|(_, p)| p.conversation == id)
                .map(|(agent, _)| agent.clone())
        });
        let Some(agent) = agent else {
            return false;
        };
        if matches!(cause, Cause::Time | Cause::Timeout) {
            return true;
        }
        let met = Met {
            wake: wake.to_owned(),
            cause,
            what: what.map(str::to_owned),
            data: data.to_vec(),
        };
        let held = self.change_pauses(|stored| {
            if let Some(pause) = stored.get_mut(&agent)
                && !pause.held.iter().any(|m| m.wake == met.wake)
            {
                pause.held.push(met);
            }
        });
        if let Err(error) = held {
            tracing::error!(%error, %agent, %wake, "a wake met while paused could not be held");
        }
        true
    }
}
