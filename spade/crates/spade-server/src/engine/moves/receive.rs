//! The machine a bot moves to (ADR 0187): inbox requests with `op: "move"`, through the
//! daemons, each from the device the person accepted. A move begins only if the person
//! accepted it here (`accept_move`), for that bot, and the machine it names vouches for that
//! device over this machine's own link to it; `begin` binds it to its manifest, by hash. `part`
//! stores one part, `commit` writes and checks everything (`arrive`), `status` and `abort`
//! answer the source after a lost answer or when it gives up. Every step can come twice, and
//! each holds the move's lock while it works.

use std::sync::Arc;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use spade_store::{Store, StoredMove};

use super::paths::{self, plain_id};
use super::{
    ABORTED, ABORTING, ACCEPTED, ACTIVATING, COMMITTED, Engine, FORMAT, IN, PLACING, RECEIVING,
    UNDOING, VERSION, budget, detail,
};
use crate::engine::inbox::{InboxAnswer, Sender};

/// Most agents (a bot and its workers) one move may bring.
const MOST_AGENTS: usize = 1_000;
/// A move that stopped sending this long ago is given up here.
const STALE_MS: i64 = 24 * 60 * 60_000;

fn refuse(status: u16, error: &str) -> InboxAnswer {
    (status, json!({ "error": error }))
}

/// The manifest's agents, the bot first, each a plain id; `None` when they aren't.
pub(super) fn manifest_agents(manifest: &Value) -> Option<Vec<String>> {
    let agents: Vec<String> = manifest["agents"]
        .as_array()?
        .iter()
        .map(|v| v.as_str().filter(|id| plain_id(id)).map(str::to_owned))
        .collect::<Option<_>>()?;
    let first = agents.first()?;
    let unique = agents
        .iter()
        .enumerate()
        .all(|(at, id)| !agents[..at].contains(id));
    (first == manifest["bot"]["id"].as_str()? && agents.len() <= MOST_AGENTS && unique)
        .then_some(agents)
}

/// The manifest's hash: what the person accepted, and what binds the move at `begin`.
pub(super) fn manifest_sha(manifest: &Value) -> String {
    Sha256::digest(manifest.to_string())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Why a manifest can't be taken here, if it can't.
fn manifest_problem(manifest: &Value, bot: &str) -> Option<(u16, &'static str)> {
    if manifest["format"] != FORMAT || manifest["version"] != VERSION {
        return Some((400, "this is not a move Spade here can read"));
    }
    if manifest["schema"].as_u64() != Some(Store::schema_version() as u64) {
        return Some((
            409,
            "the two machines run different versions of Spade; update both, then move it",
        ));
    }
    if manifest_agents(manifest).is_none_or(|agents| agents[0] != bot) {
        return Some((
            403,
            "this move brings another bot than the one the person accepted",
        ));
    }
    let inventory = &manifest["inventory"];
    let sha_ok = inventory["sha256"]
        .as_str()
        .is_some_and(super::files::is_sha256);
    if !sha_ok || inventory["count"].as_u64().is_none() {
        return Some((400, "the move's inventory is not described right"));
    }
    None
}

impl Engine {
    fn staging(&self, id: &str) -> Result<std::path::PathBuf, String> {
        paths::child(&self.moves_dir(id)?, "in")
    }

    /// The parts the staging folder holds, by index.
    fn staged(&self, id: &str) -> Vec<u64> {
        let Ok(Some(folder)) = self
            .staging(id)
            .and_then(|staging| paths::child(&staging, "parts"))
            .map(|folder| folder.is_dir().then_some(folder))
        else {
            return Vec::new();
        };
        let Ok(entries) = std::fs::read_dir(folder) else {
            return Vec::new();
        };
        let mut have: Vec<u64> = entries
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().to_str()?.strip_suffix(".json")?.parse().ok())
            .collect();
        have.sort_unstable();
        have
    }

    /// One `op: "move"` inbox request. Every step of a move to here holds the move's lock, so
    /// no other step, recovery or sweep works on it meanwhile.
    pub(crate) async fn inbox_move(self: &Arc<Self>, sender: &Sender, body: &Value) -> InboxAnswer {
        let Some(id) = body["move"].as_str().filter(|id| plain_id(id)) else {
            return refuse(400, "a move is named by a plain id");
        };
        if body["step"] == "vouch" {
            return self.move_vouch(id);
        }
        let held = self.steps_of(id).lock_owned().await;
        let entry = match self.store.stored_move(id) {
            Ok(Some(entry)) if entry.direction == IN => entry,
            Ok(Some(_)) => return refuse(409, "that move is this machine's own"),
            Ok(None) => {
                // The source waits for the person's say here, then tries again.
                return (
                    403,
                    json!({
                        "error": "the person hasn't accepted this move here; they accept it in ace first",
                        "awaiting": true,
                    }),
                );
            }
            Err(error) => return refuse(500, &error.to_string()),
        };
        let kept = detail(&entry);
        // Every step comes from the device the person accepted the move from, as this machine's
        // daemon authenticated it: no other machine can begin, feed, commit, read or abort it.
        if kept["via"].as_str() != Some(sender.host.as_str()) {
            return refuse(403, "this move is another machine's");
        }
        match body["step"].as_str() {
            Some("begin") => self.move_begin(entry, &body["manifest"]).await,
            Some("part") => self.move_part(entry, body),
            Some("commit") => self.move_commit(held, entry).await,
            Some("status") => self.move_status(held, entry).await,
            Some("abort") => self.move_abort(held, entry).await,
            _ => refuse(400, "unknown step"),
        }
    }

    /// Asked by the machine a move goes to: which device this machine speaks through there for
    /// its move `id`, so that machine knows the device the person accepted is this one's.
    fn move_vouch(&self, id: &str) -> InboxAnswer {
        match self.store.stored_move(id) {
            Ok(Some(entry))
                if entry.direction == super::OUT && spade_store::open_state(&entry.state) =>
            {
                (200, json!({ "via": detail(&entry)["via"] }))
            }
            Ok(_) => refuse(404, "this machine sends no such move"),
            Err(error) => refuse(500, &error.to_string()),
        }
    }

    /// Moves arrival `id` on from one of `from` to `to` with `detail`, durably, checked in one
    /// transaction: answers whether it did. Each step must be in the target's table (or stay).
    fn target_to(
        &self,
        id: &str,
        from: &[&str],
        to: &str,
        detail: &str,
    ) -> Result<bool, spade_store::StoreError> {
        debug_assert!(
            from.iter()
                .all(|f| *f == to || super::states::TARGET.contains(&(*f, to))),
            "{from:?} -> {to} isn't in the target's table"
        );
        self.store
            .advance_move(id, Some(from), to, detail, self.now_ms())
    }

    /// What the move's state and the arrival read, for the source.
    fn move_answer(entry: &StoredMove) -> Value {
        let kept = detail(entry);
        json!({ "state": entry.state, "arrival": kept["arrival"], "host": kept["host"] })
    }

    async fn move_begin(&self, entry: StoredMove, manifest: &Value) -> InboxAnswer {
        if let Err(problem) = paths::moves_here() {
            return refuse(409, &problem);
        }
        let host = self.host_record().ok().flatten().map(|r| r.to_json());
        let kept = detail(&entry);
        let sha = manifest_sha(manifest);
        if entry.state != ACCEPTED {
            if kept["manifest_sha"].as_str() != Some(sha.as_str()) {
                return refuse(409, "this move began with another manifest");
            }
            return match entry.state.as_str() {
                COMMITTED => (200, json!({ "have": [], "state": COMMITTED, "host": host })),
                ABORTED => refuse(409, "this move was given up here; start it again"),
                _ => (
                    200,
                    json!({ "have": self.staged(&entry.id), "state": entry.state, "host": host }),
                ),
            };
        }
        if kept["until"]
            .as_i64()
            .is_none_or(|until| self.now_ms() > until)
        {
            self.drop_staging(&entry, "the person's acceptance ran out");
            return refuse(
                403,
                "the person's acceptance here ran out; accept the move again",
            );
        }
        // Exactly the move the person accepted: its manifest, from that machine, replacing what
        // they said it would.
        if kept["digest"].as_str() != Some(sha.as_str()) {
            return refuse(403, "this isn't the move the person accepted here");
        }
        if manifest["from"] != kept["from"] {
            return refuse(
                403,
                "this move comes from another machine than the person accepted",
            );
        }
        let main = manifest["bot"]["main"] == json!(true);
        if main != (kept["replaces"] == "main") {
            return refuse(403, "this move replaces something the person didn't accept");
        }
        // A shared bot arrives only on a host of its own organization, and a person's bot never
        // on an org host (ADR 0206 §2.3).
        let arriving = spade_core::org::Space::of(manifest["bot"]["org"].as_str());
        let here = spade_core::org::Space::of(self.org_binding().as_ref().map(|b| b.org.as_str()));
        if let Some(why) =
            spade_core::org::crossing(&arriving, &here, spade_core::org::Crossing::Move)
        {
            return refuse(403, why);
        }
        if let Some((status, problem)) = manifest_problem(manifest, &entry.agent_id) {
            return refuse(status, problem);
        }
        if main && self.main_enabled().unwrap_or(true) {
            return refuse(409, "Spade is in use on this machine; it can't be replaced");
        }
        let from = kept["from"].as_str().unwrap_or_default().to_owned();
        if main
            && super::HostRecord::parse(&manifest["host"]).is_some_and(|record| record.host != from)
        {
            return refuse(
                409,
                "Spade isn't hosted on the machine this move comes from",
            );
        }
        // Fenced by the choice it began with: one held here that is newer was made since.
        if main {
            let began = super::HostRecord::parse(&manifest["host"]);
            if self
                .host_record()
                .ok()
                .flatten()
                .is_some_and(|held| began.as_ref().is_none_or(|began| held.newer_than(began)))
            {
                return refuse(409, "Spade's host was chosen again since this move began");
            }
        }
        let declared = match budget::declared(manifest) {
            Ok(declared) => declared,
            Err(problem) => return refuse(413, &problem),
        };
        // The machine the move names, reached over this machine's own link to it, vouches that
        // the device the person accepted is the one it speaks through here; its name here is
        // the one this machine knows it by, never the one the request carries.
        let from_name = match self.vouched(&entry.id, &from, &kept["via"]).await {
            Ok(name) => name,
            Err(answer) => return answer,
        };
        // A few moves arrive at once, and together they must fit the disk.
        let arriving: Vec<StoredMove> = self
            .store
            .open_moves(IN)
            .unwrap_or_default()
            .into_iter()
            .filter(|other| other.id != entry.id && other.state != ACCEPTED)
            .collect();
        if arriving.len() >= super::MOST_ARRIVING {
            return refuse(
                429,
                "other moves are arriving here; try again once they have",
            );
        }
        let reserved: u64 = arriving
            .iter()
            .filter_map(|other| budget::declared(&detail(other)["manifest"]).ok())
            .map(budget::room_needed)
            .fold(budget::room_needed(declared), u64::saturating_add);
        if let Some(free) = budget::free_bytes(&self.data_dir())
            && free < reserved
        {
            return refuse(507, "this machine hasn't the room for this move");
        }
        let agents = manifest_agents(manifest).unwrap_or_default();
        let name: String = manifest["bot"]["name"]
            .as_str()
            .unwrap_or("The bot")
            .chars()
            .take(80)
            .collect();
        for agent in &agents {
            match self.store.agent(agent) {
                Ok(Some(_)) => return refuse(409, &format!("{name} is already on this machine")),
                Ok(None) => {}
                Err(error) => return refuse(500, &error.to_string()),
            }
        }
        let parts = self
            .staging(&entry.id)
            .and_then(|staging| paths::child(&staging, "parts"));
        if let Err(error) =
            parts.and_then(|p| std::fs::create_dir_all(p).map_err(|e| e.to_string()))
        {
            return refuse(500, &error);
        }
        let mut begun = kept.clone();
        begun["manifest"] = manifest.clone();
        begun["manifest_sha"] = json!(sha);
        begun["from_name"] = json!(from_name);
        begun["staged"] = json!(0);
        begun["listed"] = json!(0);
        let stored = self
            .target_to(&entry.id, &[ACCEPTED], RECEIVING, &begun.to_string())
            .and_then(|_| self.store.set_move_peer(&entry.id, &from, &from_name))
            // Whether it is the main bot decides how it arrives: never answered without it.
            .and_then(|()| self.store.set_move_identity(&entry.id, &name, main));
        if let Err(error) = stored {
            return refuse(500, &error.to_string());
        }
        (200, json!({ "have": [], "state": RECEIVING, "host": host }))
    }

    /// Asks the machine `from` names, over this machine's own link to it, which device it sends
    /// move `id` through: it must be `via`, the one the person accepted. Answers that machine's
    /// name as this machine knows it.
    async fn vouched(&self, id: &str, from: &str, via: &Value) -> Result<String, InboxAnswer> {
        let Some(remote) = self.remote() else {
            return Err(refuse(
                503,
                "this machine can't reach its other machines yet",
            ));
        };
        let known = remote
            .machines()
            .await
            .ok()
            .and_then(|all| all.into_iter().find(|m| m.host_id == from));
        let Some(machine) = known else {
            return Err(refuse(
                403,
                "the machine this move names isn't one of yours here",
            ));
        };
        let asked = json!({ "op": "move", "step": "vouch", "move": id });
        match remote.call(from, asked).await {
            Ok((200, answer)) if answer["via"] == *via => Ok(machine.name),
            Ok((200 | 404, _)) => Err(refuse(
                403,
                "the machine this move names doesn't send it through the device you accepted",
            )),
            _ => Err(refuse(
                503,
                &format!(
                    "{} can't be asked about this move yet; try again",
                    machine.name
                ),
            )),
        }
    }

    fn move_part(&self, entry: StoredMove, body: &Value) -> InboxAnswer {
        match entry.state.as_str() {
            RECEIVING => {}
            ABORTED => return refuse(409, "this move was given up here"),
            ACCEPTED => return refuse(409, "this move hasn't begun"),
            _ => return (200, json!({})),
        }
        let total = detail(&entry)["manifest"]["parts"].as_u64().unwrap_or(0);
        let Some(index) = body["index"].as_u64().filter(|i| *i < total) else {
            return refuse(400, "that part is not one of the move's");
        };
        let part = &body["part"];
        if !matches!(
            part["kind"].as_str(),
            Some("rows" | "piece" | "image" | "page" | "file" | "inventory")
        ) {
            return refuse(400, "that part is not one Spade here can read");
        }
        // Counted against what the manifest declared before anything is written; past it the
        // move is given up here and its staging removed.
        let mut kept = detail(&entry);
        let text = part.to_string();
        let size = text.len() as u64;
        let listed = part["entries"].as_array().map_or(0, Vec::len) as u64;
        let declared = budget::declared(&kept["manifest"]).ok();
        let staged = kept["staged"].as_u64().unwrap_or(0) + size;
        let named = kept["listed"].as_u64().unwrap_or(0) + listed;
        let over = size > budget::MOST_PART_BYTES
            || declared.is_none_or(|d| staged > d.bytes || named > d.files);
        let fresh = self
            .staging(&entry.id)
            .and_then(|staging| paths::child(&staging, "parts"))
            .is_ok_and(|dir| !dir.join(format!("{index:06}.json")).exists());
        if fresh && over {
            self.drop_staging(&entry, "the move sent more than it declared");
            return refuse(413, "the move sent more than it declared");
        }
        let written = self
            .staging(&entry.id)
            .and_then(|staging| paths::child(&staging, "parts"))
            .and_then(|dir| {
                let path = dir.join(format!("{index:06}.json"));
                if path.exists() {
                    return Ok(());
                }
                let tmp = dir.join(format!(".{index:06}.tmp"));
                std::fs::write(&tmp, &text)
                    .and_then(|()| std::fs::rename(&tmp, &path))
                    .map_err(|e| e.to_string())
            });
        if let Err(error) = written {
            return refuse(500, &error);
        }
        if fresh {
            kept["staged"] = json!(staged);
            kept["listed"] = json!(named);
        }
        let _ = self.target_to(&entry.id, &[RECEIVING], RECEIVING, &kept.to_string());
        (200, json!({}))
    }

    /// Runs `work` on a blocking thread, holding the move's lock `held` throughout.
    async fn blocking<T: Send + 'static>(
        self: &Arc<Self>,
        held: tokio::sync::OwnedMutexGuard<()>,
        work: impl FnOnce(&Engine) -> T + Send + 'static,
    ) -> Result<T, String> {
        let engine = self.clone();
        tokio::task::spawn_blocking(move || {
            let answer = work(&engine);
            drop(held);
            answer
        })
        .await
        .map_err(|e| e.to_string())
    }

    /// What the move reads here now, as stored: the only answer the source acts on. A move
    /// committed or given up answers 200; one still on its way 503 (ask again).
    fn stored_answer(&self, id: &str) -> InboxAnswer {
        match self.store.stored_move(id) {
            Ok(Some(entry)) => {
                let mut answer = Self::move_answer(&entry);
                answer["error"] = detail(&entry)["problem"].clone();
                let settled = entry.state == COMMITTED || entry.state == ABORTED;
                answer["committed"] = json!(entry.state == COMMITTED);
                (if settled { 200 } else { 503 }, answer)
            }
            _ => refuse(500, "the move's state can't be read"),
        }
    }

    async fn move_commit(
        self: &Arc<Self>,
        held: tokio::sync::OwnedMutexGuard<()>,
        entry: StoredMove,
    ) -> InboxAnswer {
        match entry.state.as_str() {
            COMMITTED | ABORTED => return self.stored_answer(&entry.id),
            ACCEPTED => return refuse(409, "this move hasn't begun"),
            _ => {}
        }
        if entry.state == RECEIVING {
            let total = detail(&entry)["manifest"]["parts"].as_u64().unwrap_or(0);
            let have = self.staged(&entry.id);
            let missing: Vec<u64> = (0..total)
                .filter(|i| have.binary_search(i).is_err())
                .take(20)
                .collect();
            if !missing.is_empty() {
                return (
                    409,
                    json!({ "error": "parts are missing", "missing": missing, "state": RECEIVING }),
                );
            }
        }
        let id = entry.id.clone();
        let done = self
            .blocking(held, move |engine| {
                // What was cut off carries on first, from what it stored: a copy comes out (and
                // runs again from its parts), a give-up finishes giving up.
                if matches!(entry.state.as_str(), ACTIVATING | UNDOING | ABORTING) {
                    engine.recover(&entry.id);
                }
                let entry = engine
                    .store
                    .stored_move(&entry.id)
                    .ok()
                    .flatten()
                    .unwrap_or(entry);
                match entry.state.as_str() {
                    RECEIVING => engine.arrive(&entry).map(|_| ()),
                    // Its rows are in: only its files and the cutover are left.
                    PLACING => engine.finish_placing(&entry).map(|_| ()),
                    _ => Ok(()),
                }
            })
            .await;
        match done {
            Ok(Err(super::arrive::Failed::Refused(problem))) => {
                tracing::warn!(%problem, "a move to here was refused");
            }
            Ok(Err(super::arrive::Failed::Placing(problem))) => {
                tracing::info!(%problem, "a move to here isn't done yet");
            }
            Err(problem) => tracing::error!(%problem, "a move to here stopped short"),
            Ok(Ok(())) => {}
        }
        self.arm_arrival(&id);
        self.stored_answer(&id)
    }

    /// A move to here committed: the open wakes of what it brought are armed, so a paused bot's
    /// waits are watched (and held) here, and fire once on its Resume. Arming twice arms once.
    fn arm_arrival(self: &Arc<Self>, id: &str) {
        let Ok(Some(entry)) = self.store.stored_move(id) else {
            return;
        };
        if entry.state != COMMITTED {
            return;
        }
        for conversation in super::strings(&detail(&entry)["conversations"]) {
            for open in self.wakes(&conversation).unwrap_or_default() {
                self.arm(&conversation, open);
            }
        }
    }

    /// The move as it stands here; one cut off mid-copy, or being given up, is carried on first,
    /// so the answer is one the source can act on.
    async fn move_status(
        self: &Arc<Self>,
        held: tokio::sync::OwnedMutexGuard<()>,
        entry: StoredMove,
    ) -> InboxAnswer {
        let id = entry.id.clone();
        if matches!(entry.state.as_str(), ACTIVATING | UNDOING | ABORTING) {
            let _ = self.blocking(held, move |engine| engine.recover(&id)).await;
        }
        self.stored_answer(&entry.id)
    }

    /// Gives the move up here, unless it took. Answers `aborted` only once that is on disk, with
    /// every file it placed and every row it inserted out again; until then 503 (ask again).
    async fn move_abort(
        self: &Arc<Self>,
        held: tokio::sync::OwnedMutexGuard<()>,
        entry: StoredMove,
    ) -> InboxAnswer {
        match entry.state.as_str() {
            RECEIVING | ACCEPTED => {
                self.drop_staging(&entry, "the other machine gave the move up");
            }
            ACTIVATING | UNDOING | PLACING | ABORTING => {
                let id = entry.id.clone();
                let _ = self
                    .blocking(held, move |engine| {
                        engine.abandon(&id, "the other machine gave the move up")
                    })
                    .await;
            }
            _ => {}
        }
        let (status, answer) = self.stored_answer(&entry.id);
        if answer["state"] == COMMITTED {
            return (409, answer);
        }
        (status, answer)
    }

    /// Gives a move to here up while nothing of it is copied in (accepted or receiving): it is
    /// remembered as given up, then its staging goes. A move that has moved on is left alone.
    pub(super) fn drop_staging(&self, entry: &StoredMove, why: &str) {
        let mut kept = detail(entry);
        kept["problem"] = json!(why);
        match self.target_to(
            &entry.id,
            &[ACCEPTED, RECEIVING],
            ABORTED,
            &kept.to_string(),
        ) {
            Ok(true) => {}
            Ok(false) => return,
            Err(error) => {
                tracing::error!(%error, "a given-up move could not be stored");
                return;
            }
        }
        if let Err(error) = paths::remove_child(&self.data_dir().join("moves"), &entry.id) {
            tracing::warn!(%error, "a given-up move's staging could not be removed");
        }
    }

    /// After a restart, each move to here under its lock: one cut off mid-copy is undone, one
    /// placing its files finishes, one whose source stopped sending a day ago is given up.
    pub(super) fn resume_arrivals(self: &Arc<Self>) {
        let Ok(open) = self.store.open_moves(IN) else {
            return;
        };
        let now = self.now_ms();
        for entry in open {
            let engine = self.clone();
            tokio::spawn(async move {
                let held = engine.steps_of(&entry.id).lock_owned().await;
                if matches!(
                    entry.state.as_str(),
                    ACTIVATING | UNDOING | ABORTING | PLACING
                ) {
                    let id = entry.id.clone();
                    let _ = engine
                        .blocking(held, move |engine| engine.recover(&id))
                        .await;
                    engine.arm_arrival(&entry.id);
                } else if now - entry.updated_ms > STALE_MS {
                    engine.drop_staging(&entry, "the other machine stopped sending");
                }
            });
        }
    }

    /// Part of the sweep, for moves to here no step works on now (their lock is free): stale
    /// staging and acceptances go; an arrival cut off mid-copy is undone; a committed one's
    /// record of its rows is forgotten. At most `most` of each.
    pub(super) fn sweep_arrivals(&self, most: usize) {
        let now = self.now_ms();
        let Ok(open) = self.store.open_moves(IN) else {
            return;
        };
        let mut done = 0;
        for entry in open {
            if done >= most {
                break;
            }
            let Ok(_held) = self.steps_of(&entry.id).try_lock_owned() else {
                continue;
            };
            let stale = match entry.state.as_str() {
                ACCEPTED => now - entry.updated_ms > super::STALE_ACCEPT_MS,
                RECEIVING => now - entry.updated_ms > super::STALE_STAGING_MS,
                _ => false,
            };
            if stale {
                self.drop_staging(&entry, "nothing came for this move for too long");
                done += 1;
            } else if matches!(entry.state.as_str(), ACTIVATING | UNDOING | ABORTING) {
                self.recover(&entry.id);
                done += 1;
            }
        }
        for id in self.store.moves_with_rows(most).unwrap_or_default() {
            if let Err(error) = self.store.move_arrive_forget(&id) {
                tracing::warn!(%error, "a moved bot's record of its rows could not be forgotten");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::manifest_agents;

    #[test]
    fn a_manifest_names_its_bot_first_once_and_only_plain_ids() {
        let ok = json!({ "bot": { "id": "a_1" }, "agents": ["a_1", "a_2"] });
        assert_eq!(manifest_agents(&ok), Some(vec!["a_1".into(), "a_2".into()]));
        for bad in [
            json!({ "bot": { "id": "a_1" }, "agents": ["a_2", "a_1"] }),
            json!({ "bot": { "id": "a_1" }, "agents": [] }),
            json!({ "bot": { "id": "a_1" }, "agents": ["a_1", "../x"] }),
            json!({ "bot": { "id": "a_1" }, "agents": ["a_1", "a_1"] }),
            json!({ "bot": { "id": ".." }, "agents": [".."] }),
        ] {
            assert_eq!(manifest_agents(&bad), None, "{bad}");
        }
    }
}
