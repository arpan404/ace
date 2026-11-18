//! Moving a bot to another of the person's machines (ADR 0187, docs/agents.md "Moving a bot").
//! The machine the bot is on does the work: it freezes the bot, writes it out as numbered parts
//! (`pack`), sends them to the other machine's Spade through the daemons (`send`), which stages
//! them, writes and checks them in one transaction (`receive`), and only then archives its own
//! copy. Both sides keep the move's state, so a restart carries it on.

mod arrive;
mod files;
mod host;
mod pack;
mod receive;
mod send;

pub use host::HostRecord;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use spade_store::{StoreError, StoredMove};

use super::Engine;
use super::agents::MAIN;
use super::roster::State;

/// A move from here, and one to here.
const OUT: &str = "out";
const IN: &str = "in";

// The source's states, in order; it ends `done`, `failed` or `cancelled`.
const PACKING: &str = "packing";
const SENDING: &str = "sending";
const COMMITTING: &str = "committing";
const FINISHING: &str = "finishing";
const DONE: &str = "done";
const FAILED: &str = "failed";
const CANCELLED: &str = "cancelled";
const OUT_ENDED: &[&str] = &[DONE, FAILED, CANCELLED];

// The target's: it receives, then writes and places, then has it; or it gave the move up.
const RECEIVING: &str = "receiving";
const PLACING: &str = "placing";
const COMMITTED: &str = "committed";
const ABORTED: &str = "aborted";
const IN_ENDED: &[&str] = &[COMMITTED, ABORTED];

/// What a move's export says it is.
pub const FORMAT: &str = "spade-move";
pub const VERSION: u64 = 1;

/// Settings: where a bot that moved away went, and what a bot that arrived needs.
const MOVED: &str = "moved";
const ARRIVED: &str = "arrived";

#[derive(Default)]
pub(crate) struct Shared {
    /// Conversations frozen by a move: theirs, their workers' and helpers'. Nothing is delivered
    /// to them and nothing of them starts.
    frozen: Mutex<HashSet<String>>,
    /// Moves with a running driver.
    driving: Mutex<HashSet<String>>,
    /// Moves the person cancelled, for their driver to see.
    cancelled: Mutex<HashSet<String>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

#[derive(Debug, thiserror::Error)]
pub enum MoveError {
    #[error("no such bot")]
    NotFound,
    /// Not now, or not this bot: said in the person's words.
    #[error("{0}")]
    Refused(String),
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Store(#[from] StoreError),
}

/// A move's detail as the source keeps it.
fn detail(entry: &StoredMove) -> Value {
    serde_json::from_str(&entry.detail).unwrap_or_else(|_| json!({}))
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// What `state` a bot is in, in the person's words, when that keeps it from moving.
fn busy_words(name: &str, state: State) -> Option<String> {
    let doing = match state {
        State::Idle => return None,
        State::Working => "working",
        State::Waiting => "waiting on you",
        State::Sleeping => "sleeping",
    };
    Some(format!(
        "{name} is {doing}; it can move once that ends, or once you stop it."
    ))
}

impl Engine {
    /// Spade's data folder: where `images`, `workspace` and the moves' folders live.
    pub(crate) fn data_dir(&self) -> PathBuf {
        let images = self.images.dir();
        images.parent().unwrap_or(images).to_path_buf()
    }

    fn moves_dir(&self, id: &str) -> PathBuf {
        self.data_dir().join("moves").join(id)
    }

    /// Whether a move holds `conversation` frozen.
    pub(crate) fn frozen(&self, conversation: &str) -> bool {
        lock(&self.moves.frozen).contains(conversation)
    }

    fn freeze(&self, conversations: &[String]) {
        lock(&self.moves.frozen).extend(conversations.iter().cloned());
    }

    fn thaw(&self, conversations: &[String]) {
        let mut frozen = lock(&self.moves.frozen);
        for conversation in conversations {
            frozen.remove(conversation);
        }
    }

    /// The bot frozen by a move from here and the machine it is moving to, for a refusal.
    pub(crate) fn moving_to(&self, conversation: &str) -> Option<(String, String)> {
        if !self.frozen(conversation) {
            return None;
        }
        let agent = self.store.agent_for_conversation(conversation).ok()??;
        let entry = self.store.latest_move(&agent.id, OUT).ok()??;
        Some((agent.name, entry.peer_name))
    }

    /// Starts moving `agent` (and the workers under it) to the machine `to` (a host id).
    /// `connectors` is the person's apps here, for the bots' choices among them. Answers the
    /// move.
    pub async fn start_move(
        self: &Arc<Self>,
        agent_id: &str,
        to: &str,
        connectors: Option<&spade_connect::Connectors>,
    ) -> Result<Value, MoveError> {
        let agent = self.store.agent(agent_id)?.ok_or(MoveError::NotFound)?;
        if self.worker_link(&agent.conversation).is_some() {
            return Err(MoveError::Refused(
                "A worker moves with the bot that made it.".to_owned(),
            ));
        }
        let main = agent.kind == MAIN;
        if main && !self.main_enabled()? {
            return Err(MoveError::Refused(
                "Spade lives on another machine; move it from there.".to_owned(),
            ));
        }
        if let Some(open) = self.store.latest_move(agent_id, OUT)?
            && !OUT_ENDED.contains(&open.state.as_str())
        {
            return Err(MoveError::Refused(format!(
                "{} is already moving to {}.",
                agent.name, open.peer_name
            )));
        }
        let Some(here) = self.here() else {
            return Err(MoveError::Refused(
                "Spade can't reach your other machines from here yet.".to_owned(),
            ));
        };
        if to == here {
            return Err(MoveError::Invalid(format!(
                "{} is already on this machine.",
                agent.name
            )));
        }
        let machines = self.machines().await.map_err(|_| {
            MoveError::Refused("Your other machines can't be reached right now.".to_owned())
        })?;
        let Some(target) = machines.into_iter().find(|m| m.host_id == to) else {
            return Err(MoveError::Invalid(
                "None of your machines has that id.".to_owned(),
            ));
        };
        if !target.online {
            return Err(MoveError::Refused(format!("{} is offline.", target.name)));
        }
        let tree = self.worker_subtree(&agent.conversation);
        let mut agents = Vec::with_capacity(tree.len());
        for conversation in &tree {
            if let Some(member) = self.store.agent_for_conversation(conversation)? {
                agents.push(member.id);
            }
        }
        let selection = self.store.move_selection(&agents)?;
        // Which of the person's apps each may use, by name: their sign-ins stay here.
        let chosen: serde_json::Map<String, Value> = connectors
            .map(|hub| {
                agents
                    .iter()
                    .map(|agent| {
                        let is_main = main && agent == agent_id;
                        let access = match hub.access(agent, is_main) {
                            spade_connect::Access::All => json!("all"),
                            spade_connect::Access::Only(ids) => json!(ids),
                        };
                        (agent.clone(), access)
                    })
                    .collect()
            })
            .unwrap_or_default();
        let extras = json!({ "connectors": chosen });
        let id = self.ids.next("mv");
        let now = self.now_ms();
        {
            // Frozen under the lock every delivery takes, then checked still: nothing lands
            // between the check and the freeze.
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            self.freeze(&selection.conversations);
        }
        let still = self.still(&agent.name, &tree);
        if let Err(refusal) = still {
            self.thaw(&selection.conversations);
            return Err(refusal);
        }
        let entry = StoredMove {
            id: id.clone(),
            direction: OUT.to_owned(),
            agent_id: agent.id.clone(),
            agent_name: agent.name.clone(),
            peer: target.host_id.clone(),
            peer_name: target.name.clone(),
            main,
            state: PACKING.to_owned(),
            detail: json!({
                "from": here,
                "agents": agents,
                "conversations": selection.conversations,
                "extras": extras,
                "sent": 0,
                "total": 0,
            })
            .to_string(),
            created_ms: now,
            updated_ms: now,
        };
        if let Err(error) = self.store.insert_move(&entry) {
            self.thaw(&selection.conversations);
            return Err(error.into());
        }
        self.drive_move(&id);
        Ok(move_json(&entry))
    }

    /// Whether every bot in `tree` is idle and runs no service.
    fn still(&self, name: &str, tree: &[String]) -> Result<(), MoveError> {
        for conversation in tree {
            let activity = self.activity(conversation)?;
            if let Some(words) = busy_words(name, activity.state) {
                return Err(MoveError::Refused(words));
            }
            if activity.services > 0 {
                return Err(MoveError::Refused(format!(
                    "{name} runs a service; stop it first, then move it."
                )));
            }
        }
        Ok(())
    }

    /// The person's Cancel: stops a move still sending, or dismisses one that ended. A move
    /// whose commit was sent can't be stopped.
    pub fn cancel_move(&self, agent_id: &str) -> Result<Option<Value>, MoveError> {
        let Some(entry) = self.store.latest_move(agent_id, OUT)? else {
            return Ok(None);
        };
        match entry.state.as_str() {
            PACKING | SENDING => {
                lock(&self.moves.cancelled).insert(entry.id.clone());
                Ok(Some(move_json(&entry)))
            }
            COMMITTING | FINISHING => Err(MoveError::Refused(format!(
                "{} is already arriving on {}; it can't be stopped now.",
                entry.agent_name, entry.peer_name
            ))),
            _ => {
                let mut kept = detail(&entry);
                kept["dismissed"] = json!(true);
                self.store
                    .set_move(&entry.id, &entry.state, &kept.to_string(), self.now_ms())?;
                Ok(None)
            }
        }
    }

    /// The bot's move from here as its profile shows it, while one is open or ended badly and
    /// not dismissed.
    pub fn move_view(&self, agent_id: &str) -> Option<Value> {
        let entry = self.store.latest_move(agent_id, OUT).ok()??;
        let kept = detail(&entry);
        let shown =
            !matches!(entry.state.as_str(), DONE | CANCELLED) && kept["dismissed"] != json!(true);
        shown.then(|| move_json(&entry))
    }

    /// What needs the person after the bot arrived here, until they dismiss it.
    pub fn arrival_view(&self, agent_id: &str) -> Option<Value> {
        let text = self
            .store
            .setting(&format!("{ARRIVED}:{agent_id}"))
            .ok()??;
        serde_json::from_str(&text).ok()
    }

    pub fn dismiss_arrival(&self, agent_id: &str) -> Result<(), StoreError> {
        self.store
            .set_setting(&format!("{ARRIVED}:{agent_id}"), None)
    }

    /// Where a bot that moved away from here went: its host id and that machine's name.
    pub(crate) fn moved_away(&self, agent_id: &str) -> Option<(String, String)> {
        let text = self.store.setting(&format!("{MOVED}:{agent_id}")).ok()??;
        let value: Value = serde_json::from_str(&text).ok()?;
        Some((
            value["to"].as_str()?.to_owned(),
            value["name"].as_str().unwrap_or_default().to_owned(),
        ))
    }

    /// Carries on every move left open by a restart: refreezes and drives those from here, and
    /// finishes or gives up those to here. Runs once ace is reachable.
    pub(crate) fn resume_moves(self: &Arc<Self>) {
        match self.store.open_moves(OUT, OUT_ENDED) {
            Ok(open) => {
                for entry in open {
                    self.freeze(&strings(&detail(&entry)["conversations"]));
                    self.drive_move(&entry.id);
                }
            }
            Err(error) => tracing::error!(%error, "could not read the open moves"),
        }
        self.resume_arrivals();
    }
}

/// A move as the app reads it.
fn move_json(entry: &StoredMove) -> Value {
    let kept = detail(entry);
    json!({
        "id": entry.id,
        "to": { "host": entry.peer, "name": entry.peer_name },
        "state": entry.state,
        "sent": kept["sent"].as_u64().unwrap_or(0),
        "total": kept["total"].as_u64().unwrap_or(0),
        "waiting": kept["waiting"].as_bool().unwrap_or(false),
        "problem": kept["problem"],
        "can_cancel": matches!(entry.state.as_str(), PACKING | SENDING),
    })
}

#[cfg(test)]
mod tests {
    use super::{State, busy_words};

    #[test]
    fn only_an_idle_bot_is_free_to_move() {
        assert_eq!(busy_words("Research", State::Idle), None);
        for state in [State::Working, State::Waiting, State::Sleeping] {
            let words = busy_words("Research", state).unwrap_or_default();
            assert!(words.starts_with("Research is "), "{words}");
        }
    }
}
