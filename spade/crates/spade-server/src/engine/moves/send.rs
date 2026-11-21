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
use super::states::{self, Then};
use super::{
    CANCELLED, COMMITTING, DONE, Engine, FAILED, FINISHING, MOVED, PACKING, SENDING,
    SOURCE_ABORTING, detail, lock, strings,
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
            let pre_commit = matches!(entry.state.as_str(), PACKING | SENDING)
                && detail(&entry)["commit_sent"] != json!(true);
            let next = if pre_commit && self.past_deadline(&entry) {
                Next::Fail(format!("it took too long to reach {}", entry.peer_name))
            } else {
                match entry.state.as_str() {
                    PACKING => self.step_pack(&entry).await,
                    SENDING => self.step_send(&entry).await,
                    COMMITTING => self.step_commit(&entry).await,
                    SOURCE_ABORTING => self.step_abort(&entry).await,
                    FINISHING => self.step_finish(&entry).await,
                    _ => return,
                }
            };
            match next {
                Next::Again => {}
                Next::Fail(problem) => self.stop_move(&entry, false, Some(problem)).await,
                Next::Cancel => self.stop_move(&entry, true, None).await,
            }
        }
    }

    /// Moves `entry` on to `state` (or keeps it there) with `change`, durably, only from the
    /// state it was read in and only as the source's table allows: answers whether it did.
    fn persist(
        &self,
        entry: &StoredMove,
        state: &str,
        change: impl FnOnce(&mut Value),
    ) -> Result<bool, String> {
        let held = self
            .store
            .stored_move(&entry.id)
            .map_err(|e| e.to_string())?
            .ok_or("the move is gone")?;
        if held.state != entry.state {
            return Ok(false);
        }
        if held.state != state && !states::SOURCE.contains(&(held.state.as_str(), state)) {
            return Err(format!("a move doesn't go from {} to {state}", held.state));
        }
        let mut kept = detail(&held);
        change(&mut kept);
        // The other machine holds it now: a shared bot's move is on the log with this step.
        let entries = if state == FINISHING && held.state != FINISHING {
            self.moved_entries(&held, &kept)
        } else {
            Vec::new()
        };
        self.store
            .advance_move_audited(
                &entry.id,
                Some(&[held.state.as_str()]),
                state,
                &kept.to_string(),
                self.now_ms(),
                &entries,
            )
            .map_err(|e| e.to_string())
    }

    /// `persist`, where a failure is only said.
    fn update(&self, entry: &StoredMove, state: &str, change: impl FnOnce(&mut Value)) {
        if let Err(error) = self.persist(entry, state, change) {
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
        // That machine can't take it just now (others arriving, or it can't yet ask this one
        // about the move): wait and begin again, within the move's deadline.
        if matches!(status, 429 | 503) {
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

    /// The host choice the move's manifest began with (Spade, the main bot, only).
    fn began_host(&self, entry: &StoredMove) -> Option<HostRecord> {
        let manifest = std::fs::read_to_string(self.packed(&entry.id).ok()?.join("manifest.json"))
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())?;
        HostRecord::parse(&manifest["host"])
    }

    async fn step_commit(self: &Arc<Self>, entry: &StoredMove) -> Next {
        let kept = detail(entry);
        if kept["commit_sent"] != json!(true) {
            // Spade's host choice made again since the move began (elsewhere, by the person):
            // the move is stale, and given up before anything can take.
            if entry.main {
                let began = self.began_host(entry);
                let held = self.host_record().ok().flatten();
                if held
                    .is_some_and(|held| began.as_ref().is_none_or(|began| held.newer_than(began)))
                {
                    return Next::Fail(
                        "Spade's host was chosen again since this move began; start it again"
                            .to_owned(),
                    );
                }
            }
            // On disk before the commit leaves: from here only the other machine's word lets
            // the bot go.
            match self.persist(entry, COMMITTING, |kept| kept["commit_sent"] = json!(true)) {
                Ok(true) => {}
                _ => {
                    tokio::time::sleep(FIRST_WAIT).await;
                    return Next::Again;
                }
            }
        }
        let request = json!({ "op": "move", "step": "commit", "move": entry.id });
        let answer = self.call_peer(entry, request, false).await;
        // A machine that left the fleet: the person may keep the bot here (Keep it here),
        // until it answers again.
        let gone = matches!(answer, Err(Next::Fail(_)));
        if gone != (detail(entry)["peer_gone"] == json!(true)) {
            self.update(entry, COMMITTING, |kept| kept["peer_gone"] = json!(gone));
        }
        let answer = answer.ok();
        let heard = states::hear(answer.as_ref().map(|(status, body)| (*status, body)));
        let body = answer.map(|(_, body)| body).unwrap_or(Value::Null);
        match states::committing(&heard) {
            Then::Finish => {
                // The choice the other machine made as it took Spade, and only that: it names
                // that machine, exactly one version on from the choice the move began with.
                // Any other answer is asked again; none is ever made up here.
                let expected = self.began_host(entry).map_or(0, |r| r.version) + 1;
                let host = HostRecord::parse(&body["host"]).filter(|record| {
                    record.host == entry.peer && record.version == expected && record.by == "move"
                });
                if entry.main && host.is_none() {
                    return self.retry(entry, COMMITTING).await;
                }
                let arrival = body["arrival"].clone();
                self.update(entry, FINISHING, |kept| {
                    kept["arrival"] = arrival;
                    kept["host"] = host.as_ref().map_or(Value::Null, HostRecord::to_json);
                });
                Next::Again
            }
            Then::Thaw => {
                self.give_up(entry, FAILED, Some(error_of(&body))).await;
                Next::Again
            }
            Then::Resend => {
                self.update(entry, SENDING, |_| {});
                Next::Again
            }
            Then::Retry | Then::Abort => self.retry(entry, COMMITTING).await,
        }
    }

    /// The commit was sent, and the move is being stopped: the other machine is asked to give it
    /// up, and the bot is let go only once it says it has (or archived, if it took after all).
    async fn step_abort(self: &Arc<Self>, entry: &StoredMove) -> Next {
        let request = json!({ "op": "move", "step": "abort", "move": entry.id });
        let answer = self.call_peer(entry, request, false).await;
        // A machine that left the fleet: the person may keep the bot here (Keep it here),
        // until it answers again.
        let gone = matches!(answer, Err(Next::Fail(_)));
        if gone != (detail(entry)["peer_gone"] == json!(true)) {
            self.update(entry, SOURCE_ABORTING, |kept| {
                kept["peer_gone"] = json!(gone)
            });
        }
        let answer = answer.ok();
        let heard = states::hear(answer.as_ref().map(|(status, body)| (*status, body)));
        match states::aborting(&heard) {
            // It took after all: the commit's answer, asked again, says how.
            Then::Finish => {
                self.update(entry, COMMITTING, |_| {});
                Next::Again
            }
            Then::Thaw => {
                let kept = detail(entry);
                let state = if kept["stopped"] == "cancelled" {
                    CANCELLED
                } else {
                    FAILED
                };
                let problem = kept["problem"].as_str().map(str::to_owned);
                self.give_up(entry, state, problem).await;
                Next::Again
            }
            _ => self.retry(entry, SOURCE_ABORTING).await,
        }
    }

    /// Stays in `state`, says it waits, and asks again after a while.
    async fn retry(&self, entry: &StoredMove, state: &str) -> Next {
        self.update(entry, state, |kept| kept["waiting"] = json!(true));
        let wake = self.wake_of(&entry.id);
        tokio::select! {
            () = tokio::time::sleep(LONGEST_WAIT.min(FIRST_WAIT * 8)) => {}
            () = wake.notified() => {}
        }
        Next::Again
    }

    /// The move is stopped (`problem`, or the person's cancel) before it took: with no commit
    /// sent the bot carries on here; once one was, the other machine is asked to give it up first.
    async fn stop_move(
        self: &Arc<Self>,
        entry: &StoredMove,
        cancelled: bool,
        problem: Option<String>,
    ) {
        let sent = detail(entry)["commit_sent"] == json!(true);
        match states::stopping(sent) {
            Then::Abort => {
                let stopped = if cancelled { "cancelled" } else { "failed" };
                self.update(entry, SOURCE_ABORTING, |kept| {
                    kept["stopped"] = json!(stopped);
                    kept["problem"] = json!(problem);
                });
            }
            _ => {
                let state = if cancelled { CANCELLED } else { FAILED };
                self.give_up(entry, state, problem).await;
            }
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
        if entry.main {
            let stored = match HostRecord::parse(&kept["host"]) {
                Some(host) => self.offer_host(&host).map_err(|e| e.to_string()),
                None => Err("the other machine's host choice isn't known yet".to_owned()),
            };
            if let Err(error) = stored {
                tracing::error!(%error, "a moved Spade's host choice could not be stored yet");
                tokio::time::sleep(LONGEST_WAIT).await;
                return Next::Again;
            }
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
            tracing::error!(%error, "a quiet Spade could not be made here yet");
            tokio::time::sleep(LONGEST_WAIT).await;
            return Next::Again;
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
        // `moved/<move>/workspace`, each folder on the way linked in on disk first.
        paths::make_dirs(&kept_files)?;
        let workspaces = self.data_dir().join("workspace");
        for agent in &agents {
            let folder = paths::child(&workspaces, agent)?;
            if folder.exists() {
                std::fs::rename(&folder, paths::child(&kept_files, agent)?)
                    .map_err(|e| e.to_string())?;
                paths::sync_dir(&kept_files)?;
                paths::sync_dir(&workspaces)?;
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
            paths::sync_dir(&archive)?;
        }
        paths::remove_child(&self.data_dir().join("moves"), &entry.id)?;
        let list = |name: &str| strings(&kept["selection"][name]);
        let selection = Selection {
            agents: list("agents"),
            conversations: list("conversations"),
            groups: list("groups"),
        };
        self.store
            .move_members(&agents, &entry.peer)
            .map_err(|e| e.to_string())?;
        // A paused bot's pause went with it.
        self.forget_moved_pauses(&agents)
            .map_err(|e| e.to_string())?;
        self.forget_moved(&selection)?;
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

    /// Drops the rows of a bot that moved away, and what this Spade remembered of them. A
    /// failure is said, so the move isn't done (nor the bot let go) until they are gone.
    fn forget_moved(&self, selection: &Selection) -> Result<(), String> {
        {
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            self.store
                .move_forget(selection)
                .map_err(|e| e.to_string())?;
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
        Ok(())
    }

    /// Ends the move without it taking: tells the other machine to drop what it has, removes
    /// the parts, and lets the bot carry on here.
    async fn give_up(self: &Arc<Self>, entry: &StoredMove, state: &str, problem: Option<String>) {
        if let Some(remote) = self.remote() {
            let abort = json!({ "op": "move", "step": "abort", "move": entry.id });
            let _ = tokio::time::timeout(Duration::from_secs(10), remote.call(&entry.peer, abort))
                .await;
        }
        let kept = detail(entry);
        // The bot is let go only once the move's end is on disk.
        let ended = self.persist(entry, state, |kept| {
            kept["problem"] = json!(problem);
            kept["waiting"] = json!(false);
        });
        if !matches!(ended, Ok(true)) {
            tracing::error!(
                ?ended,
                "a stopped move couldn't be stored; the bot stays frozen"
            );
            return;
        }
        let _ = paths::remove_child(&self.data_dir().join("moves"), &entry.id);
        self.thaw(&entry.id, &strings(&kept["conversations"]));
        lock(&self.moves.cancelled).remove(&entry.id);
        for conversation in strings(&kept["conversations"]) {
            self.forget_activity(&conversation);
        }
    }
}
