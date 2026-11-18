//! The machine a bot moves from (ADR 0187): one driver per move packs it, sends `begin` and
//! every part the other machine lacks, then `commit`, and finishes only on that machine's
//! answer. Unreachable means wait and try again; a refusal before the commit gives the move up
//! and leaves the bot here, untouched. After a restart the driver picks up where it was.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use spade_store::{Selection, StoredMove};

use super::host::HostRecord;
use super::paths;
use super::{
    CANCELLED, COMMITTING, DONE, Engine, FAILED, FINISHING, MOVED, PACKING, SENDING, detail, lock,
    strings,
};
use crate::teams::RemoteError;

/// How long one request to the other machine may take.
const CALL: Duration = Duration::from_secs(60);
/// Waits between tries while the other machine is away: doubling, at most the second.
const FIRST_WAIT: Duration = Duration::from_millis(500);
const LONGEST_WAIT: Duration = Duration::from_secs(30);
/// How long a move waits for the person's say on the other machine.
const AWAIT_SAY_MS: i64 = 30 * 60_000;

/// What a step leaves the move to.
enum Next {
    /// The stored state moved on (or should be read again).
    Again,
    Fail(String),
    Cancel,
}

fn error_of(body: &Value) -> String {
    body["error"]
        .as_str()
        .unwrap_or("the other machine refused the move")
        .to_owned()
}

impl Engine {
    /// The notice that wakes move `id`'s driver.
    fn wake_of(&self, id: &str) -> Arc<tokio::sync::Notify> {
        lock(&self.moves.wakes)
            .entry(id.to_owned())
            .or_default()
            .clone()
    }

    /// Starts the driver of move `id`, once.
    pub(super) fn drive_move(self: &Arc<Self>, id: &str) {
        if !lock(&self.moves.driving).insert(id.to_owned()) {
            return;
        }
        let (engine, id) = (self.clone(), id.to_owned());
        tokio::spawn(async move {
            engine.run_move(&id).await;
            lock(&engine.moves.driving).remove(&id);
            lock(&engine.moves.wakes).remove(&id);
        });
    }

    async fn run_move(self: &Arc<Self>, id: &str) {
        loop {
            let entry = match self.store.stored_move(id) {
                Ok(Some(entry)) => entry,
                Ok(None) => return,
                Err(error) => {
                    tracing::error!(%error, "a move's state could not be read");
                    return;
                }
            };
            // Before its commit a move has a deadline, retries and disconnects included: past
            // it the move gives up and the bot carries on here.
            let pre_commit = matches!(entry.state.as_str(), PACKING | SENDING);
            if pre_commit && self.past_deadline(&entry) {
                let why = format!("it took too long to reach {}", entry.peer_name);
                return self.give_up(&entry, FAILED, Some(why)).await;
            }
            let next = match entry.state.as_str() {
                PACKING => self.step_pack(&entry).await,
                SENDING => self.step_send(&entry).await,
                COMMITTING => self.step_commit(&entry).await,
                FINISHING => self.step_finish(&entry).await,
                _ => return,
            };
            match next {
                Next::Again => {}
                Next::Fail(problem) => return self.give_up(&entry, FAILED, Some(problem)).await,
                Next::Cancel => return self.give_up(&entry, CANCELLED, None).await,
            }
        }
    }

    fn update(&self, entry: &StoredMove, state: &str, change: impl FnOnce(&mut Value)) {
        let mut kept = self
            .store
            .stored_move(&entry.id)
            .ok()
            .flatten()
            .map_or_else(|| detail(entry), |now| detail(&now));
        change(&mut kept);
        if let Err(error) = self
            .store
            .set_move(&entry.id, state, &kept.to_string(), self.now_ms())
        {
            tracing::error!(%error, "a move's state could not be stored");
        }
    }

    fn cancelled(&self, id: &str) -> bool {
        lock(&self.moves.cancelled).contains(id)
    }

    fn past_deadline(&self, entry: &StoredMove) -> bool {
        let deadline = self
            .store
            .stored_move(&entry.id)
            .ok()
            .flatten()
            .map_or_else(|| detail(entry), |now| detail(&now))["deadline"]
            .as_i64();
        deadline.is_some_and(|deadline| self.now_ms() > deadline)
    }

    async fn step_pack(self: &Arc<Self>, entry: &StoredMove) -> Next {
        let (engine, packing) = (self.clone(), entry.clone());
        let packed = tokio::task::spawn_blocking(move || engine.pack(&packing)).await;
        match packed {
            Ok(Ok(manifest)) => {
                let total = manifest["parts"].as_u64().unwrap_or(0);
                // What the person accepts on the other machine: this manifest, by its hash.
                let digest = super::receive::manifest_sha(&manifest);
                // Which device the other machine knows this one by: what the person's say
                // binds every step of the move to.
                let hello = json!({ "op": "whoami" });
                let via = match self.call_peer(entry, hello, true).await {
                    Ok((200, body)) => body["sender"].as_str().map(str::to_owned),
                    Ok(_) => None,
                    Err(next) => return next,
                };
                let Some(via) = via.filter(|via| super::paths::plain_id(via)) else {
                    return Next::Fail(format!(
                        "{} didn't say how it knows this machine",
                        entry.peer_name
                    ));
                };
                self.update(entry, SENDING, |kept| {
                    kept["total"] = json!(total);
                    kept["digest"] = json!(digest);
                    kept["via"] = json!(via);
                    kept["awaiting"] = json!(true);
                });
                if self.cancelled(&entry.id) {
                    Next::Cancel
                } else {
                    Next::Again
                }
            }
            Ok(Err(problem)) => Next::Fail(problem),
            Err(error) => Next::Fail(error.to_string()),
        }
    }

    /// One request to the move's machine, tried again while it is away. `cancellable` lets the
    /// person's Cancel end the wait.
    async fn call_peer(
        &self,
        entry: &StoredMove,
        request: Value,
        cancellable: bool,
    ) -> Result<(u16, Value), Next> {
        let mut wait = FIRST_WAIT;
        let mut waiting = false;
        let wake = self.wake_of(&entry.id);
        loop {
            if cancellable && self.cancelled(&entry.id) {
                return Err(Next::Cancel);
            }
            if cancellable && self.past_deadline(entry) {
                return Err(Next::Fail(format!(
                    "it took too long to reach {}",
                    entry.peer_name
                )));
            }
            let answer = match self.remote() {
                Some(remote) => {
                    tokio::time::timeout(CALL, remote.call(&entry.peer, request.clone()))
                        .await
                        .unwrap_or(Err(RemoteError::Disconnected))
                }
                None => Err(RemoteError::Offline),
            };
            match answer {
                Ok(answer) => {
                    if waiting {
                        self.update(entry, &entry.state, |kept| kept["waiting"] = json!(false));
                    }
                    return Ok(answer);
                }
                Err(error) if error.retry() => {
                    if !waiting {
                        waiting = true;
                        self.update(entry, &entry.state, |kept| kept["waiting"] = json!(true));
                    }
                    // The person's Check again asks now.
                    tokio::select! {
                        () = tokio::time::sleep(wait) => wait = (wait * 2).min(LONGEST_WAIT),
                        () = wake.notified() => wait = FIRST_WAIT,
                    }
                }
                Err(error) => return Err(Next::Fail(error.to_string())),
            }
        }
    }

    async fn step_send(self: &Arc<Self>, entry: &StoredMove) -> Next {
        let manifest = match self.pack(entry) {
            Ok(manifest) => manifest,
            Err(problem) => return Next::Fail(problem),
        };
        let begin =
            json!({ "op": "move", "step": "begin", "move": entry.id, "manifest": manifest });
        let (status, body) = match self.call_peer(entry, begin, true).await {
            Ok(answer) => answer,
            Err(next) => return next,
        };
        // Not accepted there yet: the person's say is on its way, from the app or the CLI.
        if status == 403 && body["awaiting"] == json!(true) {
            let since = detail(entry)["awaiting_since"].as_i64();
            let now = self.now_ms();
            if since.is_some_and(|since| now - since > AWAIT_SAY_MS) {
                return Next::Fail(format!(
                    "your say on {} never came; accept the move there",
                    entry.peer_name
                ));
            }
            self.update(entry, SENDING, |kept| {
                kept["awaiting"] = json!(true);
                kept["awaiting_since"] = json!(since.unwrap_or(now));
            });
            tokio::time::sleep(FIRST_WAIT).await;
            return Next::Again;
        }
        if status != 200 {
            return Next::Fail(error_of(&body));
        }
        self.update(entry, SENDING, |kept| kept["awaiting"] = json!(false));
        let held = body["host"].clone();
        let have: Vec<u64> = body["have"]
            .as_array()
            .map(|list| list.iter().filter_map(Value::as_u64).collect())
            .unwrap_or_default();
        let total = manifest["parts"].as_u64().unwrap_or(0);
        let sent = have.len() as u64;
        self.update(entry, SENDING, |kept| {
            kept["sent"] = json!(sent);
            kept["peer_host"] = held;
        });
        let missing = (0..total).filter(|i| !have.contains(i));
        for (done, index) in (sent + 1..).zip(missing) {
            let part = match self.packed_part(&entry.id, index) {
                Ok(part) => part,
                Err(problem) => return Next::Fail(problem),
            };
            let request = json!({
                "op": "move", "step": "part", "move": entry.id, "index": index, "part": part,
            });
            let (status, body) = match self.call_peer(entry, request, true).await {
                Ok(answer) => answer,
                Err(next) => return next,
            };
            match status {
                200 => {}
                // That machine dropped its staging: begin again.
                404 => return Next::Again,
                _ => return Next::Fail(error_of(&body)),
            }
            self.update(entry, SENDING, |kept| kept["sent"] = json!(done));
        }
        if self.cancelled(&entry.id) {
            return Next::Cancel;
        }
        self.update(entry, COMMITTING, |_| {});
        Next::Again
    }

    /// The record that names the move's machine as Spade's host: one version above the newest
    /// either side holds.
    fn next_host(&self, entry: &StoredMove) -> HostRecord {
        let kept = detail(entry);
        let theirs = HostRecord::parse(&kept["peer_host"]).map_or(0, |r| r.version);
        let ours = self.host_record().ok().flatten().map_or(0, |r| r.version);
        HostRecord {
            host: entry.peer.clone(),
            version: ours.max(theirs) + 1,
            at: self.now_ms(),
            by: "move".to_owned(),
        }
    }

    async fn step_commit(self: &Arc<Self>, entry: &StoredMove) -> Next {
        let kept = detail(entry);
        let host = match HostRecord::parse(&kept["host"]) {
            Some(host) => host,
            None if entry.main => {
                let host = self.next_host(entry);
                let shown = host.to_json();
                self.update(entry, COMMITTING, |kept| kept["host"] = shown);
                host
            }
            None => HostRecord {
                host: entry.peer.clone(),
                version: 0,
                at: 0,
                by: String::new(),
            },
        };
        let mut request = json!({ "op": "move", "step": "commit", "move": entry.id });
        if entry.main {
            request["host"] = host.to_json();
        }
        // Only the other machine knows whether a commit took: from here on the bot waits for
        // its answer, however long that machine is away.
        let (status, body) = match self.call_peer(entry, request, false).await {
            Ok(answer) => answer,
            Err(Next::Fail(_)) => {
                let status = json!({ "op": "move", "step": "status", "move": entry.id });
                match self.call_peer(entry, status, false).await {
                    Ok((200, body)) if body["state"] == "committed" => (200, body),
                    Ok((_, body)) if body["state"] == "receiving" || body["state"] == "placing" => {
                        tokio::time::sleep(FIRST_WAIT).await;
                        return Next::Again;
                    }
                    Ok((_, body)) => return Next::Fail(error_of(&body)),
                    Err(next) => return next,
                }
            }
            Err(next) => return next,
        };
        match status {
            200 => {
                let arrival = body["arrival"].clone();
                self.update(entry, FINISHING, |kept| kept["arrival"] = arrival);
                Next::Again
            }
            // Parts went missing there: send them again.
            409 if body["missing"].is_array() => {
                self.update(entry, SENDING, |_| {});
                Next::Again
            }
            // Written there but its files are still being placed, or that machine stumbled:
            // only it knows when the move took, so ask again.
            500..=599 => {
                self.update(entry, COMMITTING, |kept| kept["waiting"] = json!(true));
                tokio::time::sleep(LONGEST_WAIT.min(FIRST_WAIT * 8)).await;
                Next::Again
            }
            _ => Next::Fail(error_of(&body)),
        }
    }

    /// The move took: the main bot goes quiet here as the record names the other machine; any
    /// other bot is archived to `moved/<move>/` and leaves this machine's roster.
    async fn step_finish(self: &Arc<Self>, entry: &StoredMove) -> Next {
        let kept = detail(entry);
        let conversations = strings(&kept["conversations"]);
        // Spade, the main bot: the choice names the other machine first, so this one's main
        // goes quiet; then its copy is archived like any bot's, and a new, quiet main takes its
        // place here, so Spade can come back later without meeting its old self.
        if entry.main
            && let Some(host) = HostRecord::parse(&kept["host"])
            && let Err(error) = self.offer_host(&host)
        {
            tracing::error!(%error, "a moved Spade's host choice could not be stored");
        }
        let (engine, finishing) = (self.clone(), entry.clone());
        let archived = tokio::task::spawn_blocking(move || engine.archive(&finishing)).await;
        match archived {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                tracing::error!(%error, "a moved bot's copy here could not be archived");
                tokio::time::sleep(LONGEST_WAIT).await;
                return Next::Again;
            }
            Err(error) => return Next::Fail(error.to_string()),
        }
        if entry.main
            && let Err(error) = self.ensure_main()
        {
            tracing::error!(%error, "a quiet Spade could not be made here");
        }
        self.update(entry, DONE, |_| {});
        self.thaw(&entry.id, &conversations);
        Next::Again
    }

    /// Moves this machine's copy aside and forgets it: each step can run again.
    fn archive(&self, entry: &StoredMove) -> Result<(), String> {
        let kept = detail(entry);
        let agents = strings(&kept["agents"]);
        let archive = paths::child(&self.data_dir().join("moved"), &entry.id)?;
        let kept_files = paths::child(&archive, "workspace")?;
        std::fs::create_dir_all(&kept_files).map_err(|e| e.to_string())?;
        let workspaces = self.data_dir().join("workspace");
        for agent in &agents {
            let folder = paths::child(&workspaces, agent)?;
            if folder.exists() {
                std::fs::rename(&folder, paths::child(&kept_files, agent)?)
                    .map_err(|e| e.to_string())?;
            }
            let moved = json!({ "to": entry.peer, "name": entry.peer_name, "at": self.now_ms() });
            self.store
                .set_setting(&format!("{MOVED}:{agent}"), Some(&moved.to_string()))
                .map_err(|e| e.to_string())?;
        }
        // The parts hold no secret: webhook secrets never leave a machine, keys never enter one.
        let parts = self.packed(&entry.id)?;
        if parts.exists() {
            std::fs::rename(&parts, paths::child(&archive, "parts")?).map_err(|e| e.to_string())?;
        }
        paths::remove_child(&self.data_dir().join("moves"), &entry.id)?;
        let selection = self
            .store
            .move_selection(&agents)
            .map_err(|e| e.to_string())?;
        self.store
            .move_members(&agents, &entry.peer)
            .map_err(|e| e.to_string())?;
        self.forget_moved(&selection);
        for agent in &agents {
            if let Some(plugins) = self.plugins() {
                plugins.forget(agent);
            }
            if let Some(security) = self.security() {
                security.forget(agent);
            }
        }
        Ok(())
    }

    /// Drops the rows of a bot that moved away, and what this Spade remembered of them.
    fn forget_moved(&self, selection: &Selection) {
        {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            if let Err(error) = self.store.move_forget(selection) {
                tracing::error!(%error, "a moved bot's rows could not be removed");
            }
            for conversation in &selection.conversations {
                self.forget_activity(conversation);
            }
        }
        let mut live = self.live.lock().unwrap_or_else(|p| p.into_inner());
        for conversation in &selection.conversations {
            live.remove(conversation);
        }
        drop(live);
        self.forget_tree();
    }

    /// Ends the move without it taking: tells the other machine to drop what it has, removes
    /// the parts, and lets the bot carry on here.
    async fn give_up(self: &Arc<Self>, entry: &StoredMove, state: &str, problem: Option<String>) {
        if let Some(remote) = self.remote() {
            let abort = json!({ "op": "move", "step": "abort", "move": entry.id });
            let _ = tokio::time::timeout(Duration::from_secs(10), remote.call(&entry.peer, abort))
                .await;
        }
        let _ = paths::remove_child(&self.data_dir().join("moves"), &entry.id);
        let kept = detail(entry);
        self.update(entry, state, |kept| {
            kept["problem"] = json!(problem);
            kept["waiting"] = json!(false);
        });
        self.thaw(&entry.id, &strings(&kept["conversations"]));
        lock(&self.moves.cancelled).remove(&entry.id);
        for conversation in strings(&kept["conversations"]) {
            self.forget_activity(&conversation);
        }
    }
}
