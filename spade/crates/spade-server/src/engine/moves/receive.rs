//! The machine a bot moves to (ADR 0187): inbox requests with `op: "move"`, through the
//! daemons. `begin` opens a staging folder and says which parts it already has, `part` stores
//! one, `commit` writes and checks everything (see `arrive`), `status` and `abort` answer the
//! source after a lost answer or when it gives up. Every step can come twice.

use std::sync::Arc;

use serde_json::{Value, json};
use spade_store::{Store, StoredMove};

use super::{
    ABORTED, COMMITTED, Engine, FORMAT, IN, IN_ENDED, PLACING, RECEIVING, VERSION, detail, lock,
};
use crate::engine::inbox::{InboxAnswer, Sender};

/// Most agents (a bot and its workers) and parts one move may bring.
const MOST_AGENTS: usize = 1_000;
const MOST_PARTS: u64 = 4_000_000;
/// A move that stopped sending this long ago is given up here.
const STALE_MS: i64 = 24 * 60 * 60_000;

fn refuse(status: u16, error: &str) -> InboxAnswer {
    (status, json!({ "error": error }))
}

pub(super) fn valid_id(id: &str) -> bool {
    (1..=160).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-'))
}

/// The manifest's agents, the bot first, each a valid id; `None` when they aren't.
pub(super) fn manifest_agents(manifest: &Value) -> Option<Vec<String>> {
    let agents: Vec<String> = manifest["agents"]
        .as_array()?
        .iter()
        .map(|v| v.as_str().filter(|id| valid_id(id)).map(str::to_owned))
        .collect::<Option<_>>()?;
    let first = agents.first()?;
    (first == manifest["bot"]["id"].as_str()? && agents.len() <= MOST_AGENTS).then_some(agents)
}

impl Engine {
    fn staging(&self, id: &str) -> std::path::PathBuf {
        self.moves_dir(id).join("in")
    }

    /// The parts the staging folder holds, by index.
    fn staged(&self, id: &str) -> Vec<u64> {
        let Ok(entries) = std::fs::read_dir(self.staging(id).join("parts")) else {
            return Vec::new();
        };
        let mut have: Vec<u64> = entries
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().to_str()?.strip_suffix(".json")?.parse().ok())
            .collect();
        have.sort_unstable();
        have
    }

    /// One `op: "move"` inbox request. `connectors` is the person's apps here, for the bot's
    /// choices among them.
    pub(crate) async fn inbox_move(
        self: &Arc<Self>,
        sender: &Sender,
        body: &Value,
        connectors: Option<Arc<spade_connect::Connectors>>,
    ) -> InboxAnswer {
        let Some(id) = body["move"].as_str().filter(|id| valid_id(id)) else {
            return refuse(400, "a move needs its id");
        };
        let entry = match self.store.stored_move(id) {
            Ok(entry) => entry,
            Err(error) => return refuse(500, &error.to_string()),
        };
        if entry.as_ref().is_some_and(|e| e.direction != IN) {
            return refuse(409, "that move is this machine's own");
        }
        match body["step"].as_str() {
            Some("begin") => self.move_begin(sender, id, entry, &body["manifest"]),
            Some("part") => self.move_part(id, entry, body),
            Some("commit") => self.move_commit(id, entry, &body["host"], connectors).await,
            Some("status") => match entry {
                Some(entry) => (
                    200,
                    json!({ "state": entry.state, "arrival": detail(&entry)["arrival"] }),
                ),
                None => (
                    404,
                    json!({ "state": "unknown", "error": "no such move here" }),
                ),
            },
            Some("abort") => self.move_abort(entry),
            _ => refuse(400, "unknown step"),
        }
    }

    fn move_begin(
        &self,
        sender: &Sender,
        id: &str,
        entry: Option<StoredMove>,
        manifest: &Value,
    ) -> InboxAnswer {
        let host = self.host_record().ok().flatten().map(|r| r.to_json());
        if let Some(entry) = entry {
            return match entry.state.as_str() {
                COMMITTED => (200, json!({ "have": [], "state": COMMITTED, "host": host })),
                ABORTED => refuse(409, "this move was given up here; start it again"),
                _ => (
                    200,
                    json!({ "have": self.staged(id), "state": entry.state, "host": host }),
                ),
            };
        }
        if manifest["format"] != FORMAT || manifest["version"] != VERSION {
            return refuse(400, "this is not a move Spade here can read");
        }
        if manifest["schema"].as_u64() != Some(Store::schema_version() as u64) {
            return refuse(
                409,
                "the two machines run different versions of Spade; update both, then move it",
            );
        }
        let Some(agents) = manifest_agents(manifest) else {
            return refuse(400, "the move's bots are not named right");
        };
        if manifest["parts"]
            .as_u64()
            .is_none_or(|parts| parts > MOST_PARTS)
        {
            return refuse(400, "the move's parts are not counted right");
        }
        let main = manifest["bot"]["main"] == json!(true);
        let name = manifest["bot"]["name"].as_str().unwrap_or("The bot");
        for agent in &agents {
            match self.store.agent(agent) {
                // Spade's own quiet copy from an earlier stay here is replaced.
                Ok(Some(held)) if main && held.kind == super::MAIN => {}
                Ok(Some(_)) => return refuse(409, &format!("{name} is already on this machine")),
                Ok(None) => {}
                Err(error) => return refuse(500, &error.to_string()),
            }
        }
        // An earlier move of the same bot that never finished is given up.
        if let Ok(open) = self.store.open_moves(IN, IN_ENDED) {
            for older in open.into_iter().filter(|e| e.agent_id == agents[0]) {
                if older.state == RECEIVING {
                    self.drop_staging(&older, "a newer move of the same bot started");
                }
            }
        }
        if let Err(error) = std::fs::create_dir_all(self.staging(id).join("parts")) {
            return refuse(500, &error.to_string());
        }
        let now = self.now_ms();
        let stored = StoredMove {
            id: id.to_owned(),
            direction: IN.to_owned(),
            agent_id: agents[0].clone(),
            agent_name: name.to_owned(),
            peer: manifest["from"].as_str().unwrap_or_default().to_owned(),
            peer_name: sender.name.clone(),
            main,
            state: RECEIVING.to_owned(),
            detail: json!({ "manifest": manifest, "sender": sender.host }).to_string(),
            created_ms: now,
            updated_ms: now,
        };
        if let Err(error) = self.store.insert_move(&stored) {
            return refuse(500, &error.to_string());
        }
        (200, json!({ "have": [], "state": RECEIVING, "host": host }))
    }

    fn move_part(&self, id: &str, entry: Option<StoredMove>, body: &Value) -> InboxAnswer {
        let Some(entry) = entry else {
            return refuse(404, "no such move here");
        };
        if entry.state != RECEIVING {
            return if entry.state == ABORTED {
                refuse(409, "this move was given up here")
            } else {
                (200, json!({}))
            };
        }
        let total = detail(&entry)["manifest"]["parts"].as_u64().unwrap_or(0);
        let Some(index) = body["index"].as_u64().filter(|i| *i < total) else {
            return refuse(400, "that part is not one of the move's");
        };
        let part = &body["part"];
        if !matches!(
            part["kind"].as_str(),
            Some("rows" | "piece" | "image" | "file")
        ) {
            return refuse(400, "that part is not one Spade here can read");
        }
        let dir = self.staging(id).join("parts");
        let path = dir.join(format!("{index:06}.json"));
        if !path.exists() {
            let tmp = dir.join(format!(".{index:06}.tmp"));
            let written =
                std::fs::write(&tmp, part.to_string()).and_then(|()| std::fs::rename(&tmp, &path));
            if let Err(error) = written {
                return refuse(500, &error.to_string());
            }
        }
        let _ = self
            .store
            .set_move(id, RECEIVING, &entry.detail, self.now_ms());
        (200, json!({}))
    }

    async fn move_commit(
        self: &Arc<Self>,
        id: &str,
        entry: Option<StoredMove>,
        host: &Value,
        connectors: Option<Arc<spade_connect::Connectors>>,
    ) -> InboxAnswer {
        let Some(entry) = entry else {
            return refuse(404, "no such move here");
        };
        match entry.state.as_str() {
            COMMITTED => {
                return (
                    200,
                    json!({ "committed": true, "arrival": detail(&entry)["arrival"] }),
                );
            }
            ABORTED => return refuse(409, "this move was given up here; start it again"),
            _ => {}
        }
        let total = detail(&entry)["manifest"]["parts"].as_u64().unwrap_or(0);
        let have = self.staged(id);
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
        // One commit at a time per move: a second waits for the first's answer.
        if !lock(&self.moves.driving).insert(format!("in:{id}")) {
            return refuse(503, "this move is being written; ask again in a moment");
        }
        let (engine, host) = (self.clone(), host.clone());
        let written = tokio::task::spawn_blocking(move || {
            engine.arrive(&entry, &host, connectors.as_deref())
        })
        .await;
        lock(&self.moves.driving).remove(&format!("in:{id}"));
        match written {
            Ok(Ok(arrival)) => (200, json!({ "committed": true, "arrival": arrival })),
            Ok(Err(problem)) => refuse(422, &problem),
            Err(error) => refuse(500, &error.to_string()),
        }
    }

    fn move_abort(&self, entry: Option<StoredMove>) -> InboxAnswer {
        match entry {
            Some(entry) if entry.state == RECEIVING => {
                self.drop_staging(&entry, "the other machine gave the move up");
                (200, json!({ "state": ABORTED }))
            }
            Some(entry) if matches!(entry.state.as_str(), PLACING | COMMITTED) => {
                refuse(409, "the move already took here")
            }
            _ => (200, json!({ "state": ABORTED })),
        }
    }

    /// Gives a move to here up: its staging goes, and it is remembered as given up.
    pub(super) fn drop_staging(&self, entry: &StoredMove, why: &str) {
        let _ = std::fs::remove_dir_all(self.moves_dir(&entry.id));
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
    /// source stopped sending a day ago is given up.
    pub(super) fn resume_arrivals(self: &Arc<Self>) {
        let Ok(open) = self.store.open_moves(IN, IN_ENDED) else {
            return;
        };
        let now = self.now_ms();
        for entry in open {
            if entry.state == PLACING {
                let engine = self.clone();
                tokio::task::spawn_blocking(move || engine.finish_placing(&entry));
            } else if now - entry.updated_ms > STALE_MS {
                self.drop_staging(&entry, "the other machine stopped sending");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{manifest_agents, valid_id};

    #[test]
    fn a_manifest_names_its_bot_first_and_only_plain_ids() {
        let ok = json!({ "bot": { "id": "a_1" }, "agents": ["a_1", "a_2"] });
        assert_eq!(manifest_agents(&ok), Some(vec!["a_1".into(), "a_2".into()]));
        for bad in [
            json!({ "bot": { "id": "a_1" }, "agents": ["a_2", "a_1"] }),
            json!({ "bot": { "id": "a_1" }, "agents": [] }),
            json!({ "bot": { "id": "a_1" }, "agents": ["a_1", "../x"] }),
        ] {
            assert_eq!(manifest_agents(&bad), None, "{bad}");
        }
        assert!(!valid_id("a b"));
    }
}
