//! Moving a bot to another of the person's machines (ADR 0187, docs/agents.md "Moving a bot").
//! The person accepts the move on the machine it goes to (`accept_move`, with their stamp), then
//! starts it on the machine the bot is on, which does the work: it reserves the move, freezes the
//! bot, writes it out as numbered parts with an inventory (`pack`) and sends them through the
//! daemons (`send`). The other machine takes them only for the move the person accepted, stages
//! and checks them (`receive`), writes them in one transaction and places its files (`arrive`);
//! only then does the source archive its copy. Both sides keep the move's state, so a restart
//! carries it on.

mod arrive;
mod consent;
mod files;
mod host;
mod pack;
mod paths;
mod receive;
mod send;

pub use host::HostRecord;

use std::collections::HashMap;
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
const RESERVED: &str = "reserved";
const PACKING: &str = "packing";
const SENDING: &str = "sending";
const COMMITTING: &str = "committing";
const FINISHING: &str = "finishing";
const DONE: &str = "done";
const FAILED: &str = "failed";
const CANCELLED: &str = "cancelled";

// The target's: the person accepted it, it receives, writes and places, then has it; or it was
// given up.
const ACCEPTED: &str = "accepted";
const RECEIVING: &str = "receiving";
const PLACING: &str = "placing";
const COMMITTED: &str = "committed";
const ABORTED: &str = "aborted";

/// What a move's export says it is.
pub const FORMAT: &str = "spade-move";
pub const VERSION: u64 = 2;

/// Settings: where a bot that moved away went, and what a bot that arrived needs.
const MOVED: &str = "moved";
const ARRIVED: &str = "arrived";

/// How long the person's acceptance waits for the move to begin.
const ACCEPT_FOR_MS: i64 = 60 * 60_000;
/// How long a moved-away bot's archive is kept.
const KEEP_ARCHIVE_MS: i64 = 30 * 24 * 60 * 60_000;

#[derive(Default)]
pub(crate) struct Shared {
    /// Conversations frozen by a move, each with the move holding it. Nothing is delivered to
    /// them and nothing of them starts; only that move lets them go.
    frozen: Mutex<HashMap<String, String>>,
    /// Moves with a running driver.
    driving: Mutex<std::collections::HashSet<String>>,
    /// Moves the person cancelled, for their driver to see.
    cancelled: Mutex<std::collections::HashSet<String>>,
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
    /// Only the person, through ace, can accept a bot onto this machine.
    #[error("{0}")]
    PersonOnly(&'static str),
    #[error(transparent)]
    Store(#[from] StoreError),
}

/// What a refused acceptance tells the caller.
const ACCEPT_PERSON_ONLY: &str = "Only the person can accept a bot moving here: do it in ace, on this computer or a paired device.";

/// A move's detail as this machine keeps it.
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

    /// `moves/<id>`, checked: the id is one plain name and nothing on the way is a link.
    fn moves_dir(&self, id: &str) -> Result<PathBuf, String> {
        paths::child(&self.data_dir().join("moves"), id)
    }

    /// Whether a move holds `conversation` frozen.
    pub(crate) fn frozen(&self, conversation: &str) -> bool {
        lock(&self.moves.frozen).contains_key(conversation)
    }

    /// Freezes `conversations` for move `id`; one another move holds stays that move's.
    fn freeze(&self, id: &str, conversations: &[String]) {
        let mut frozen = lock(&self.moves.frozen);
        for conversation in conversations {
            frozen
                .entry(conversation.clone())
                .or_insert_with(|| id.to_owned());
        }
    }

    /// Lets go of what move `id` froze, and nothing another move holds.
    fn thaw(&self, id: &str, conversations: &[String]) {
        let mut frozen = lock(&self.moves.frozen);
        for conversation in conversations {
            if frozen.get(conversation).is_some_and(|holder| holder == id) {
                frozen.remove(conversation);
            }
        }
    }

    /// The bot frozen by a move from here and the machine it is moving to, for a refusal.
    pub(crate) fn moving_to(&self, conversation: &str) -> Option<(String, String)> {
        let id = lock(&self.moves.frozen).get(conversation).cloned()?;
        let entry = self.store.stored_move(&id).ok()??;
        (entry.direction == OUT).then_some((entry.agent_name, entry.peer_name))
    }

    /// The person accepts, on this machine, the bot `bot` arriving by the move `id` (with their
    /// stamp from ace's daemon). A machine of the fleet alone can't push a bot here: `begin`
    /// needs this.
    pub fn accept_move(&self, id: &str, bot: &str, stamp: Option<&str>) -> Result<(), MoveError> {
        if !paths::plain_id(id) || !paths::plain_id(bot) {
            return Err(MoveError::Invalid(
                "a move and a bot are named by plain ids".to_owned(),
            ));
        }
        let says = self.security().is_some_and(|security| {
            security.person_says(stamp, &format!("move:{id}"), &format!("accept:{bot}"))
        });
        if !says {
            return Err(MoveError::PersonOnly(ACCEPT_PERSON_ONLY));
        }
        if let Some(entry) = self.store.stored_move(id)? {
            return if entry.direction == IN && entry.agent_id == bot {
                Ok(())
            } else {
                Err(MoveError::Refused("that move is another one".to_owned()))
            };
        }
        // An earlier acceptance of the same bot that never began is replaced.
        for older in self
            .store
            .open_moves(IN)?
            .into_iter()
            .filter(|e| e.agent_id == bot)
        {
            if matches!(older.state.as_str(), ACCEPTED | RECEIVING) {
                self.drop_staging(&older, "the person accepted a newer move of the same bot");
            }
        }
        let now = self.now_ms();
        let accepted = StoredMove {
            id: id.to_owned(),
            direction: IN.to_owned(),
            agent_id: bot.to_owned(),
            agent_name: String::new(),
            peer: String::new(),
            peer_name: String::new(),
            main: false,
            state: ACCEPTED.to_owned(),
            detail: json!({ "until": now + ACCEPT_FOR_MS }).to_string(),
            created_ms: now,
            updated_ms: now,
        };
        if self.store.insert_move(&accepted)? {
            Ok(())
        } else {
            Err(MoveError::Refused(
                "a move of this bot is already arriving here".to_owned(),
            ))
        }
    }

    /// Starts moving `agent` (and the workers under it) to the machine `to` (a host id) as the
    /// move `id`, which the person accepted there. `connectors` is the person's apps here, to
    /// name the ones the bot used. The move is reserved before anything is awaited, so a second
    /// start of the same bot is refused. Answers the move.
    pub async fn start_move(
        self: &Arc<Self>,
        agent_id: &str,
        to: &str,
        id: &str,
        connectors: Option<&spade_connect::Connectors>,
    ) -> Result<Value, MoveError> {
        if !paths::plain_id(id) {
            return Err(MoveError::Invalid(
                "a move is named by a plain id".to_owned(),
            ));
        }
        let agent = self.store.agent(agent_id)?.ok_or(MoveError::NotFound)?;
        if !paths::plain_id(&agent.id) {
            return Err(MoveError::Refused(format!(
                "{} has an id Spade can't move",
                agent.name
            )));
        }
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
        let tree = self.worker_subtree(&agent.conversation);
        let mut agents = Vec::with_capacity(tree.len());
        for conversation in &tree {
            if let Some(member) = self.store.agent_for_conversation(conversation)? {
                agents.push(member.id);
            }
        }
        let selection = self.store.move_selection(&agents)?;
        let chosen = connector_choices(connectors, &agents, agent_id, main);
        let now = self.now_ms();
        let entry = StoredMove {
            id: id.to_owned(),
            direction: OUT.to_owned(),
            agent_id: agent.id.clone(),
            agent_name: agent.name.clone(),
            peer: to.to_owned(),
            peer_name: to.to_owned(),
            main,
            state: RESERVED.to_owned(),
            detail: json!({
                "from": here,
                "agents": agents,
                "conversations": selection.conversations,
                "extras": { "connectors": chosen },
                "sent": 0,
                "total": 0,
            })
            .to_string(),
            created_ms: now,
            updated_ms: now,
        };
        // Reserved before anything is awaited: the database holds the bot to one open move.
        if !self.store.insert_move(&entry)? {
            return Err(MoveError::Refused(format!(
                "{} is already moving.",
                agent.name
            )));
        }
        {
            // Frozen under the lock every delivery takes, then checked still.
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            self.freeze(id, &selection.conversations);
        }
        let release = |error: MoveError| {
            self.thaw(id, &selection.conversations);
            let _ = self
                .store
                .set_move(id, CANCELLED, &entry.detail, self.now_ms());
            Err(error)
        };
        if let Err(refusal) = self.still(&agent.name, &tree) {
            return release(refusal);
        }
        let machines = match self.machines().await {
            Ok(machines) => machines,
            Err(_) => {
                return release(MoveError::Refused(
                    "Your other machines can't be reached right now.".to_owned(),
                ));
            }
        };
        let Some(target) = machines.into_iter().find(|m| m.host_id == to) else {
            return release(MoveError::Invalid(
                "None of your machines has that id.".to_owned(),
            ));
        };
        if !target.online {
            return release(MoveError::Refused(format!("{} is offline.", target.name)));
        }
        self.store
            .set_move_peer(id, &target.host_id, &target.name)?;
        self.store
            .set_move(id, PACKING, &entry.detail, self.now_ms())?;
        self.drive_move(id);
        let started = self.store.stored_move(id)?.ok_or(MoveError::NotFound)?;
        Ok(move_json(&started))
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
            RESERVED | PACKING | SENDING => {
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
    /// finishes or gives up those to here; archives past their time go. Runs once ace is
    /// reachable.
    pub(crate) fn resume_moves(self: &Arc<Self>) {
        match self.store.open_moves(OUT) {
            Ok(open) => {
                for entry in open {
                    if entry.state == RESERVED {
                        // Cut off while it was being started: it never began.
                        let conversations = strings(&detail(&entry)["conversations"]);
                        let _ =
                            self.store
                                .set_move(&entry.id, CANCELLED, &entry.detail, self.now_ms());
                        self.thaw(&entry.id, &conversations);
                        continue;
                    }
                    self.freeze(&entry.id, &strings(&detail(&entry)["conversations"]));
                    self.drive_move(&entry.id);
                }
            }
            Err(error) => tracing::error!(%error, "could not read the open moves"),
        }
        self.resume_arrivals();
        self.forget_old_archives();
    }

    /// Removes the archives and leftovers of moves that ended more than `KEEP_ARCHIVE_MS` ago.
    fn forget_old_archives(&self) {
        let Ok(old) = self
            .store
            .ended_moves_before(self.now_ms() - KEEP_ARCHIVE_MS)
        else {
            return;
        };
        let data = self.data_dir();
        for entry in old {
            for root in ["moved", "moves"] {
                if let Err(error) = paths::remove_child(&data.join(root), &entry.id) {
                    tracing::warn!(%error, "an old move's folder could not be removed");
                }
            }
        }
    }
}

/// Which of the person's apps each moving bot used, by name; the other machine starts them on
/// none and names them, since the person's consent stays here.
fn connector_choices(
    connectors: Option<&spade_connect::Connectors>,
    agents: &[String],
    root: &str,
    main: bool,
) -> serde_json::Map<String, Value> {
    let Some(hub) = connectors else {
        return serde_json::Map::new();
    };
    agents
        .iter()
        .map(|agent| {
            let access = match hub.access(agent, main && agent == root) {
                spade_connect::Access::All => json!("all"),
                spade_connect::Access::Only(ids) => json!(ids),
            };
            (agent.clone(), access)
        })
        .collect()
}

/// A move as the app reads it.
fn move_json(entry: &StoredMove) -> Value {
    let kept = detail(entry);
    json!({
        "id": entry.id,
        "to": { "host": entry.peer, "name": entry.peer_name },
        "state": if entry.state == RESERVED { PACKING } else { entry.state.as_str() },
        "sent": kept["sent"].as_u64().unwrap_or(0),
        "total": kept["total"].as_u64().unwrap_or(0),
        "waiting": kept["waiting"].as_bool().unwrap_or(false),
        "problem": kept["problem"],
        "can_cancel": matches!(entry.state.as_str(), RESERVED | PACKING | SENDING),
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
