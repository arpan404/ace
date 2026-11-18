//! The machine a bot moves to (ADR 0187): inbox requests with `op: "move"`, through the
//! daemons. A move begins only if the person accepted it here (`accept_move`), for that bot;
//! `begin` binds it to the machine that sent it and to its manifest, by hash, so neither can
//! change afterwards. `part` stores one part, `commit` writes and checks everything (`arrive`),
//! `status` and `abort` answer the source after a lost answer or when it gives up. Every step
//! can come twice.

use std::sync::Arc;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use spade_store::{Store, StoredMove};

use super::paths::{self, plain_id};
use super::{
    ABORTED, ACCEPTED, ACTIVATING, COMMITTED, Engine, FORMAT, IN, PLACING, RECEIVING, VERSION,
    budget, detail, lock,
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

    /// One `op: "move"` inbox request. `connectors` is the person's apps here, whose access
    /// for the arriving bot starts empty.
    pub(crate) async fn inbox_move(
        self: &Arc<Self>,
        sender: &Sender,
        body: &Value,
        connectors: Option<Arc<spade_connect::Connectors>>,
    ) -> InboxAnswer {
        let Some(id) = body["move"].as_str().filter(|id| plain_id(id)) else {
            return refuse(400, "a move is named by a plain id");
        };
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
        // Once begun, a move hears only from the machine that began it.
        if let Some(from) = kept["sender"].as_str()
            && from != sender.host
        {
            return refuse(403, "this move is another machine's");
        }
        match body["step"].as_str() {
            Some("begin") => self.move_begin(sender, entry, &body["manifest"]),
            Some("part") => self.move_part(entry, body),
            Some("commit") => self.move_commit(entry, &body["host"], connectors).await,
            Some("status") => (
                200,
                json!({ "state": entry.state, "arrival": kept["arrival"] }),
            ),
            Some("abort") => self.move_abort(entry),
            _ => refuse(400, "unknown step"),
        }
    }

    fn move_begin(&self, sender: &Sender, entry: StoredMove, manifest: &Value) -> InboxAnswer {
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
        if let Some((status, problem)) = manifest_problem(manifest, &entry.agent_id) {
            return refuse(status, problem);
        }
        if main && self.main_enabled().unwrap_or(true) {
            return refuse(409, "Spade is in use on this machine; it can't be replaced");
        }
        let declared = match budget::declared(manifest) {
            Ok(declared) => declared,
            Err(problem) => return refuse(413, &problem),
        };
        if let Some(free) = budget::free_bytes(&self.data_dir())
            && free < budget::room_needed(declared)
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
                // Spade's own quiet copy from an earlier stay here is replaced.
                Ok(Some(held))
                    if main && held.kind == super::MAIN && !self.main_enabled().unwrap_or(true) => {
                }
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
        begun["sender"] = json!(sender.host);
        begun["from_name"] = json!(sender.name);
        begun["staged"] = json!(0);
        begun["listed"] = json!(0);
        let now = self.now_ms();
        let stored = self
            .store
            .set_move(&entry.id, RECEIVING, &begun.to_string(), now)
            .and_then(|()| {
                self.store.set_move_peer(
                    &entry.id,
                    manifest["from"].as_str().unwrap_or_default(),
                    &sender.name,
                )
            });
        if let Err(error) = stored {
            return refuse(500, &error.to_string());
        }
        let _ = self.store.set_move_identity(&entry.id, &name, main);
        (200, json!({ "have": [], "state": RECEIVING, "host": host }))
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
            Some("rows" | "piece" | "image" | "file" | "inventory")
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
        let _ = self
            .store
            .set_move(&entry.id, RECEIVING, &kept.to_string(), self.now_ms());
        (200, json!({}))
    }

    async fn move_commit(
        self: &Arc<Self>,
        entry: StoredMove,
        host: &Value,
        connectors: Option<Arc<spade_connect::Connectors>>,
    ) -> InboxAnswer {
        let id = entry.id.clone();
        match entry.state.as_str() {
            COMMITTED => {
                return (
                    200,
                    json!({ "committed": true, "arrival": detail(&entry)["arrival"] }),
                );
            }
            ABORTED => return refuse(409, "this move was given up here; start it again"),
            ACCEPTED => return refuse(409, "this move hasn't begun"),
            ACTIVATING => return refuse(503, "this move is being written; ask again in a moment"),
            _ => {}
        }
        if entry.state == RECEIVING {
            let total = detail(&entry)["manifest"]["parts"].as_u64().unwrap_or(0);
            let have = self.staged(&id);
            let missing: Vec<u64> = (0..total)
                .filter(|i| have.binary_search(i).is_err())
                .take(20)
                .collect();
            if !missing.is_empty() {
                return (
                    409,
                    json!({ "error": "parts are missing", "missing": missing }),
                );
            }
        }
        // One commit at a time per move: a second waits for the first's answer.
        if !lock(&self.moves.driving).insert(format!("in:{id}")) {
            return refuse(503, "this move is being written; ask again in a moment");
        }
        let (engine, host) = (self.clone(), host.clone());
        let written = tokio::task::spawn_blocking(move || {
            if entry.state == PLACING {
                // Its rows are written: only its files are left to place.
                engine.finish_placing(&entry)
            } else {
                engine.arrive(&entry, &host, connectors.as_deref())
            }
        })
        .await;
        lock(&self.moves.driving).remove(&format!("in:{id}"));
        match written {
            Ok(Ok(arrival)) => (200, json!({ "committed": true, "arrival": arrival })),
            Ok(Err(super::arrive::Failed::Refused(problem))) => refuse(422, &problem),
            Ok(Err(super::arrive::Failed::Placing(problem))) => (
                503,
                json!({ "state": PLACING, "error": format!("its files aren't placed yet: {problem}") }),
            ),
            Err(error) => refuse(500, &error.to_string()),
        }
    }

    fn move_abort(&self, entry: StoredMove) -> InboxAnswer {
        match entry.state.as_str() {
            RECEIVING | ACCEPTED => {
                self.drop_staging(&entry, "the other machine gave the move up");
                (200, json!({ "state": ABORTED }))
            }
            PLACING | COMMITTED => refuse(409, "the move already took here"),
            _ => (200, json!({ "state": ABORTED })),
        }
    }

    /// Gives a move to here up: its staging goes, and it is remembered as given up.
    pub(super) fn drop_staging(&self, entry: &StoredMove, why: &str) {
        if let Err(error) = paths::remove_child(&self.data_dir().join("moves"), &entry.id) {
            tracing::warn!(%error, "a given-up move's staging could not be removed");
        }
        let mut kept = detail(entry);
        kept["problem"] = json!(why);
        if let Err(error) =
            self.store
                .set_move(&entry.id, ABORTED, &kept.to_string(), self.now_ms())
        {
            tracing::error!(%error, "a given-up move could not be stored");
        }
    }

    /// After a restart: a move whose rows were written finishes placing its files; one whose
    /// source stopped sending a day ago, or that the person accepted and nobody began, is
    /// given up.
    pub(super) fn resume_arrivals(self: &Arc<Self>) {
        let Ok(open) = self.store.open_moves(IN) else {
            return;
        };
        let now = self.now_ms();
        for entry in open {
            if entry.state == ACTIVATING {
                // Cut off while its rows were being copied in: they come out again, and the
                // source's next commit writes them afresh.
                let engine = self.clone();
                tokio::task::spawn_blocking(move || engine.undo_activation(&entry));
            } else if entry.state == PLACING {
                self.freeze(&entry.id, &super::strings(&detail(&entry)["conversations"]));
                let engine = self.clone();
                tokio::task::spawn_blocking(move || {
                    if let Err(error) = engine.finish_placing(&entry) {
                        tracing::error!(?error, "a moved bot's files could not be placed");
                    }
                });
            } else if now - entry.updated_ms > STALE_MS {
                self.drop_staging(&entry, "the other machine stopped sending");
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
