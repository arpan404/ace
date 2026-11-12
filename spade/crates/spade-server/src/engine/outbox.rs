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
    }

    fn remote(&self) -> Option<Arc<dyn Remote>> {
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
    ) -> Result<(), StoreError> {
        let now = self.now_ms();
        self.store.insert_outbox(&OutboxEntry {
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
        })?;
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
    pub(crate) async fn wait_remote(&self, key: &str, mut seen: impl FnMut(&OutboxEntry)) -> Outcome {
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
            let wait = entry.next_ms - self.now_ms();
            if wait > 0 && !entry.stop {
                let _ = tokio::time::timeout(Duration::from_millis(wait as u64), wake.notified())
                    .await;
                continue;
            }
            let Some(remote) = self.remote() else {
                // ace isn't known yet: look again shortly.
                let _ = tokio::time::timeout(Duration::from_secs(5), wake.notified()).await;
                continue;
            };
            match entry.state.as_str() {
                "queued" => self.offer(&*remote, &entry).await,
                _ => self.collect(&*remote, &entry).await,
            }
            let _ = self.teams.outbox_changed.send(key.to_owned());
        }
    }

    /// Sends a queued entry; it moves to `sent` once that machine's Spade has taken it.
    async fn offer(&self, remote: &dyn Remote, entry: &OutboxEntry) {
        let now = self.now_ms();
        if entry.stop {
            let answer = json!({ "status": "stopped", "text": "Stopped before it was sent." });
            self.advance(entry, "withdrawn", Some(answer), entry.attempts, now);
            return;
        }
        let request: Value = serde_json::from_str(&entry.request).unwrap_or(Value::Null);
        match remote.call(&entry.machine, request).await {
            Ok((200, _)) => self.advance(entry, "sent", None, entry.attempts, now),
            Ok((_, body)) => {
                let answer = json!({ "status": "failed", "text": error_of(&body) });
                self.advance(entry, "failed", Some(answer), entry.attempts + 1, now);
            }
            Err(error) if error.retry() => self.later(entry, now),
            Err(RemoteError::UnknownMachine(_)) if now - entry.created_ms < GIVE_UP_MS => {
                self.later(entry, now)
            }
            Err(error) => {
                let answer = json!({ "status": "failed", "text": error.to_string() });
                self.advance(entry, "failed", Some(answer), entry.attempts + 1, now);
            }
        }
    }

    /// Reads a sent entry's answer there (a long poll); sends `stop` first when asked to.
    async fn collect(&self, remote: &dyn Remote, entry: &OutboxEntry) {
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
        let poll = json!({ "op": "answer", "key": entry.key, "wait_ms": wait_ms });
        match remote.call(&entry.machine, poll).await {
            Ok((200, body)) => {
                let status = body["status"].as_str().unwrap_or("unknown");
                let state = match status {
                    "pending" if entry.stop => "stopped",
                    "pending" => {
                        // Read again at once; a reachable machine resets the backoff.
                        self.advance(entry, "sent", None, 0, now);
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
            let text = format!("{} did not come back online within 7 days.", entry.machine_name);
            let answer = json!({ "status": "gave_up", "text": text });
            self.advance(entry, "gave_up", Some(answer), entry.attempts, now);
            return;
        }
        let attempts = entry.attempts + 1;
        let backoff = FIRST_BACKOFF_MS
            .saturating_mul(1 << attempts.saturating_sub(1).min(20))
            .min(LONGEST_BACKOFF_MS);
        if let Err(error) = self.store.advance_outbox(
            &entry.key,
            &entry.state,
            None,
            attempts,
            now + backoff,
            now,
        ) {
            tracing::warn!(%error, "could not record an outbox retry");
        }
    }

    fn advance(&self, entry: &OutboxEntry, state: &str, answer: Option<Value>, attempts: u32, now: i64) {
        let answer = answer.map(|a| a.to_string());
        if let Err(error) =
            self.store
                .advance_outbox(&entry.key, state, answer.as_deref(), attempts, now, now)
        {
            tracing::warn!(%error, "could not record an outbox step");
        }
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
