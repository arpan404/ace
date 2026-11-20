//! Asks to bots of other machines (ADR 0132): stored in the outbox before they are sent, sent
//! through the daemon until that machine's Spade takes them, then their answers read back by
//! key. The receiver keeps each key with the message it delivered, so a retry never delivers
//! twice. Each open entry has one worker task, also after a restart.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use spade_store::{OutboxEntry, StoreError};
use tokio::sync::Notify;

use super::Engine;
use crate::teams::{Machine, Outcome, Remote, RemoteError};

/// First wait before trying an unreachable machine again; it doubles up to `LONGEST_BACKOFF`.
const FIRST_BACKOFF_MS: i64 = 2_000;
const LONGEST_BACKOFF_MS: i64 = 5 * 60_000;
/// How long an ask waits for its machine before it is given up.
pub const GIVE_UP_MS: i64 = 7 * 24 * 60 * 60_000;
/// Ended entries are kept this long, then forgotten.
const KEEP_ENDED_MS: i64 = 30 * 24 * 60 * 60_000;
/// One long poll for an answer there.
const ANSWER_POLL_MS: u64 = 20_000;

impl Engine {
    /// Sets how Spade reaches other machines (once ace's address is known) and starts the
    /// workers of entries still open.
    pub fn set_remote(self: &Arc<Self>, remote: Arc<dyn Remote>) {
        *self.teams.remote.lock().unwrap_or_else(|p| p.into_inner()) = Some(remote);
        if let Ok(open) = self.store.open_outbox() {
            for entry in open {
                self.run_outbox(&entry.key);
            }
        }
        // Moves a restart left open carry on (ADR 0187).
        self.resume_moves();
    }

    pub(crate) fn remote(&self) -> Option<Arc<dyn Remote>> {
        self.teams
            .remote
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    /// The linked machines, as the daemon lists them now; remembered for `machine_online`.
    pub(crate) async fn machines(&self) -> Result<Vec<Machine>, RemoteError> {
        let remote = self.remote().ok_or(RemoteError::Offline)?;
        let machines = remote.machines().await?;
        *self
            .teams
            .machines
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = machines.clone();
        Ok(machines)
    }

    /// Whether `host` was online when the machines were last listed.
    pub(crate) fn machine_online(&self, host: &str) -> bool {
        self.teams
            .machines
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .any(|m| m.host_id == host && m.online)
    }

    /// A machine's name, as last listed; its host id when it never was.
    pub(crate) fn machine_name(&self, host: &str) -> String {
        self.teams
            .machines
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .find(|m| m.host_id == host)
            .map_or_else(|| host.to_owned(), |m| m.name.clone())
    }

    /// The bots of another machine, as its Spade lists them.
    pub(crate) async fn remote_bots(&self, host: &str) -> Result<Vec<Value>, RemoteError> {
        let remote = self.remote().ok_or(RemoteError::Offline)?;
        let call = remote.call(host, json!({ "op": "bots" }));
        let (status, body) = tokio::time::timeout(Duration::from_secs(5), call)
            .await
            .map_err(|_| RemoteError::Offline)??;
        if status != 200 {
            return Err(RemoteError::Refused(error_of(&body)));
        }
        Ok(body["bots"].as_array().cloned().unwrap_or_default())
    }

    /// Stores an ask for another machine and starts sending it. A key already stored keeps its
    /// first request.
    pub(crate) fn send_remote(
        self: &Arc<Self>,
        key: &str,
        machine: &str,
        machine_name: &str,
        request: Value,
    ) -> Result<(), String> {
        let now = self.now_ms();
        let _ = self.store.prune_outbox(now - KEEP_ENDED_MS);
        if self.store.outbox(key).map_err(|e| e.to_string())?.is_none()
            && self.store.open_outbox_count().map_err(|e| e.to_string())?
                >= self.limits.remote_asks_waiting
        {
            return Err(format!(
                "{} asks to other machines are already waiting; try again once some are answered.",
                self.limits.remote_asks_waiting
            ));
        }
        self.store
            .insert_outbox(&OutboxEntry {
                key: key.to_owned(),
                machine: machine.to_owned(),
                machine_name: machine_name.to_owned(),
                request: request.to_string(),
                state: "queued".to_owned(),
                answer: None,
                attempts: 0,
                next_ms: now,
                stop: false,
                created_ms: now,
            })
            .map_err(|e| e.to_string())?;
        self.run_outbox(key);
        Ok(())
    }

    /// Asks the worker of `key` to withdraw or stop it.
    pub(crate) fn stop_remote(&self, key: &str) -> Result<(), StoreError> {
        self.store.stop_outbox(key, self.now_ms())?;
        self.wake_outbox(key);
        Ok(())
    }

    fn wake_outbox(&self, key: &str) {
        if let Some(wake) = self
            .teams
            .outbox
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(key)
        {
            wake.notify_one();
        }
    }

    /// Waits until the entry of `key` ends; `seen` is told each state it passes through.
    pub(crate) async fn wait_remote(
        &self,
        key: &str,
        mut seen: impl FnMut(&OutboxEntry),
    ) -> Outcome {
        let mut changed = self.teams.outbox_changed.subscribe();
        loop {
            match self.store.outbox(key) {
                Ok(Some(entry)) => {
                    seen(&entry);
                    if let Some(outcome) = ended(&entry) {
                        return outcome;
                    }
                }
                Ok(None) => return Outcome::Failed("The ask was lost.".to_owned()),
                Err(_) => {}
            }
            let _ = tokio::time::timeout(Duration::from_secs(5), changed.recv()).await;
        }
    }

    /// Starts the worker of `key` unless one runs.
    fn run_outbox(self: &Arc<Self>, key: &str) {
        let wake = Arc::new(Notify::new());
        {
            let mut running = self.teams.outbox.lock().unwrap_or_else(|p| p.into_inner());
            if running.contains_key(key) {
                return;
            }
            running.insert(key.to_owned(), wake.clone());
        }
        let engine = self.clone();
        let key = key.to_owned();
        tokio::spawn(async move {
            engine.outbox_worker(&key, &wake).await;
            engine
                .teams
                .outbox
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&key);
            let _ = engine.teams.outbox_changed.send(key);
        });
    }

    async fn outbox_worker(&self, key: &str, wake: &Notify) {
        loop {
            let Ok(Some(entry)) = self.store.outbox(key) else {
                return;
            };
            if ended(&entry).is_some() {
                return;
            }
            // A Stop sets the entry due now and wakes this; a stop not yet answered there waits
            // out its backoff like any try.
            let wait = entry.next_ms - self.now_ms();
            if wait > 0 {
                let _ =
                    tokio::time::timeout(Duration::from_millis(wait as u64), wake.notified()).await;
                continue;
            }
            let Some(remote) = self.remote() else {
                // ace isn't known yet: look again shortly.
                let _ = tokio::time::timeout(Duration::from_secs(5), wake.notified()).await;
                continue;
            };
            match entry.state.as_str() {
                "queued" => self.offer(&*remote, &entry).await,
                _ => self.collect(&*remote, &entry, wake).await,
            }
            let _ = self.teams.outbox_changed.send(key.to_owned());
        }
    }

    /// Sends a queued entry; it moves to `sent` once that machine's Spade has taken it. Before
    /// each send the entry is marked as maybe there (stored first, so a crash mid-send keeps
    /// it): a lost answer or a crash can leave a request that machine took, so a Stop then
    /// withdraws it only once that machine says it never had it.
    async fn offer(&self, remote: &dyn Remote, entry: &OutboxEntry) {
        let now = self.now_ms();
        if entry.stop {
            if maybe_there(entry) {
                self.cancel_there(remote, entry, now).await;
            } else {
                let answer = json!({ "status": "stopped", "text": "Stopped before it was sent." });
                self.advance(entry, "withdrawn", Some(answer), entry.attempts, now);
            }
            return;
        }
        let before = maybe_there(entry);
        let marked = OutboxEntry {
            answer: Some(MAYBE_THERE.to_string()),
            ..entry.clone()
        };
        if !matches!(
            self.store.advance_outbox(
                &entry.key,
                "queued",
                marked.answer.as_deref(),
                entry.attempts,
                entry.next_ms,
                now,
            ),
            Ok(true)
        ) {
            // Ended or unreadable meanwhile: nothing is sent unmarked.
            return;
        }
        let request: Value = serde_json::from_str(&entry.request).unwrap_or(Value::Null);
        let sent = remote.call(&entry.machine, request.clone()).await;
        // A Stop that came while it was on its way finds the mark, and cancels it there.
        let entry = &marked;
        match sent {
            Ok((200, _)) => self.advance(entry, "sent", None, entry.attempts, now),
            // The bot moved to another machine (ADR 0187): ask it there.
            Ok((410, body))
                if body["moved_to"]
                    .as_str()
                    .is_some_and(|to| to != entry.machine) =>
            {
                let to = body["moved_to"].as_str().unwrap_or_default();
                let name = body["name"]
                    .as_str()
                    .filter(|n| !n.is_empty())
                    .unwrap_or(to);
                let agent = request["to"].as_str().unwrap_or_default();
                if let Err(error) = self.store.retarget_outbox(&entry.key, agent, to, name, now) {
                    tracing::warn!(%error, "could not send an ask on to where its bot moved");
                }
            }
            Ok((_, body)) => {
                let answer = json!({ "status": "failed", "text": error_of(&body) });
                self.advance(entry, "failed", Some(answer), entry.attempts + 1, now);
            }
            // Lost after sending: it may be there, so it stays marked.
            Err(RemoteError::Disconnected) => self.later(entry, now),
            // Never sent: the mark goes back to what earlier tries left.
            Err(RemoteError::Offline) => self.later(&unmarked(entry, before), now),
            Err(RemoteError::UnknownMachine(_)) if now - entry.created_ms < GIVE_UP_MS => {
                self.later(&unmarked(entry, before), now)
            }
            Err(error) => {
                let answer = json!({ "status": "failed", "text": error.to_string() });
                self.advance(entry, "failed", Some(answer), entry.attempts + 1, now);
            }
        }
    }

    /// Stop on an entry that may be at that machine already: `stop` is sent there under its key
    /// until that machine answers. One it never had is withdrawn; one it had is read as sent, so
    /// its stopped (or meanwhile finished) end is read back.
    async fn cancel_there(&self, remote: &dyn Remote, entry: &OutboxEntry, now: i64) {
        let stop = json!({ "op": "stop", "key": entry.key });
        match remote.call(&entry.machine, stop).await {
            Ok((200, body)) if body["status"] == "unknown" => {
                let answer = json!({ "status": "stopped", "text": "Stopped before it arrived." });
                self.advance(entry, "withdrawn", Some(answer), entry.attempts, now);
            }
            Ok((200, _)) => self.advance(entry, "sent", None, entry.attempts, now),
            // Not answered yet: tried again after the backoff, for as long as any ask waits.
            _ => self.later(entry, now),
        }
    }

    /// Reads a sent entry's answer there (a long poll); sends `stop` first when asked to.
    async fn collect(&self, remote: &dyn Remote, entry: &OutboxEntry, wake: &Notify) {
        let now = self.now_ms();
        if entry.stop {
            let stop = json!({ "op": "stop", "key": entry.key });
            if let Err(error) = remote.call(&entry.machine, stop).await
                && error.retry()
            {
                self.later(entry, now);
                return;
            }
        }
        let wait_ms = if entry.stop { 0 } else { ANSWER_POLL_MS };
        // A contract call's answer also comes back early when its callee starts or stops
        // waiting on the person, so the caller reads waiting meanwhile (ADR 0200 §6.2).
        let waiting = super::contracts_remote::waiting_of(entry);
        let poll =
            json!({ "op": "answer", "key": entry.key, "wait_ms": wait_ms, "waiting": waiting });
        // A Stop meanwhile ends the wait at once, so the stop reaches that machine now.
        let polled = tokio::select! {
            polled = remote.call(&entry.machine, poll) => polled,
            () = wake.notified() => return,
        };
        match polled {
            Ok((200, body)) => {
                let status = body["status"].as_str().unwrap_or("unknown");
                let state = match status {
                    "pending" if entry.stop => "stopped",
                    "pending" => {
                        // Read again at once; a reachable machine resets the backoff. A call
                        // keeps whether its callee waits on the person, and its caller is told.
                        let now_waiting = body["waiting"].as_bool() == Some(true);
                        let kept = super::contracts_remote::is_call(&entry.key)
                            .then(|| json!({ "status": "pending", "waiting": now_waiting }));
                        let call = kept.is_some();
                        self.advance(entry, "sent", kept, 0, now);
                        if call && now_waiting != waiting {
                            self.announce_caller(&entry.key);
                        }
                        return;
                    }
                    "answered" => "answered",
                    "stopped" => "stopped",
                    "unknown" => "failed",
                    _ => "failed",
                };
                let answer = if status == "unknown" {
                    json!({ "status": "failed", "text": "That machine has no record of the ask." })
                } else if status == "pending" {
                    json!({ "status": "stopped", "text": "" })
                } else {
                    body
                };
                self.advance(entry, state, Some(answer), entry.attempts, now);
            }
            Ok((_, body)) => {
                let answer = json!({ "status": "failed", "text": error_of(&body) });
                self.advance(entry, "failed", Some(answer), entry.attempts, now);
            }
            Err(_) => self.later(entry, now),
        }
    }

    /// Tries again after the backoff, or gives up after [`GIVE_UP_MS`].
    fn later(&self, entry: &OutboxEntry, now: i64) {
        if now - entry.created_ms >= GIVE_UP_MS {
            let text = format!(
                "{} did not come back online within 7 days.",
                entry.machine_name
            );
            let answer = json!({ "status": "gave_up", "text": text });
            self.advance(entry, "gave_up", Some(answer), entry.attempts, now);
            return;
        }
        let attempts = entry.attempts + 1;
        let backoff = FIRST_BACKOFF_MS
            .saturating_mul(1 << attempts.saturating_sub(1).min(20))
            .min(LONGEST_BACKOFF_MS);
        // A queued entry keeps its mark of maybe being there; a sent one reads its answer anew.
        let kept = (entry.state == "queued")
            .then_some(entry.answer.as_deref())
            .flatten();
        if let Err(error) =
            self.store
                .advance_outbox(&entry.key, &entry.state, kept, attempts, now + backoff, now)
        {
            tracing::warn!(%error, "could not record an outbox retry");
        }
    }

    fn advance(
        &self,
        entry: &OutboxEntry,
        state: &str,
        answer: Option<Value>,
        attempts: u32,
        now: i64,
    ) {
        let answer = answer.map(|a| a.to_string());
        if let Err(error) =
            self.store
                .advance_outbox(&entry.key, state, answer.as_deref(), attempts, now, now)
        {
            tracing::warn!(%error, "could not record an outbox step");
        }
    }
}

/// What a queued entry holds once it may be at that machine: a send was tried and not known to
/// have failed before it left.
const MAYBE_THERE: &str = r#"{"status":"queued","maybe_there":true}"#;

/// Whether a queued entry may be at that machine already.
fn maybe_there(entry: &OutboxEntry) -> bool {
    entry.state == "queued"
        && entry
            .answer
            .as_deref()
            .and_then(|a| serde_json::from_str::<Value>(a).ok())
            .is_some_and(|a| a["maybe_there"] == true)
}

/// `entry` as it was before a try that never left: marked only when an earlier one may be there.
fn unmarked(entry: &OutboxEntry, before: bool) -> OutboxEntry {
    OutboxEntry {
        answer: before.then(|| MAYBE_THERE.to_owned()),
        ..entry.clone()
    }
}

/// How an entry ended, if it did.
fn ended(entry: &OutboxEntry) -> Option<Outcome> {
    let answer: Value = entry
        .answer
        .as_deref()
        .and_then(|a| serde_json::from_str(a).ok())
        .unwrap_or(Value::Null);
    let text = answer["text"].as_str().unwrap_or("").to_owned();
    match entry.state.as_str() {
        "queued" | "sent" => None,
        "answered" => Some(Outcome::Answered(text)),
        "stopped" | "withdrawn" => Some(Outcome::Stopped(text)),
        "gave_up" => Some(Outcome::GaveUp(text)),
        _ => Some(Outcome::Failed(if text.is_empty() {
            "The bot there could not answer.".to_owned()
        } else {
            text
        })),
    }
}

fn error_of(body: &Value) -> String {
    body["error"]
        .as_str()
        .unwrap_or("that machine's Spade refused it")
        .chars()
        .take(300)
        .collect()
}
