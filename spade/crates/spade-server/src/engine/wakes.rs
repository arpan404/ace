//! Wakes (ADR 0160): setting, firing and cancelling them, and the timer that fires them by time.
//! Which wakes are open is the fold `spade_core::wake::open`; this keeps them armed in memory
//! (re-armed from the fold when Spade opens) and stores each firing under the record lock only
//! while its wake is still open, so it lands once whoever fires it first: the timer, an event,
//! the person.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use spade_core::event::Known;
use spade_core::wake::{self, CancelledBy, Cause, Condition, Open, Purpose};
use spade_core::{Event, Transcript};
use spade_store::StoreError;
use tokio::sync::Notify;

use super::Engine;

/// The longest the timer sleeps between looks at the clock, so wakes a sleeping machine missed
/// fire within a minute of it waking.
const LONGEST_SLEEP: Duration = Duration::from_secs(60);

/// An open wake as armed: with its pattern compiled once.
pub(super) struct Armed {
    pub(super) open: Open,
    pub(super) pattern: Option<regex::Regex>,
}

/// What keeps a wake's event source alive: a file watcher or a URL poll. Dropping it ends it.
pub(super) enum Source {
    Watcher(#[allow(dead_code)] notify::RecommendedWatcher),
    Poll(tokio::task::AbortHandle),
}

impl Drop for Source {
    fn drop(&mut self) {
        if let Self::Poll(task) = self {
            task.abort();
        }
    }
}

/// The wakes armed now, by conversation, and their sources, by wake.
#[derive(Default)]
pub(crate) struct Shared {
    pub(super) armed: Mutex<HashMap<String, Vec<Armed>>>,
    pub(super) sources: Mutex<HashMap<String, Source>>,
    /// Wakes the timer to look again (a wake set, a test moving its clock).
    kick: Arc<Notify>,
    /// The open wakes were armed from storage and the timer started.
    restored: AtomicBool,
    /// The services marked `keep` were started again.
    pub(super) services_restored: AtomicBool,
}

impl Shared {
    /// Whether Spade has opened for work and armed the wakes.
    pub(super) fn restored_once(&self) -> bool {
        self.restored.load(Ordering::SeqCst)
    }
}

pub(super) fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Engine {
    /// Stores a new wake for conversation `id` and arms it. `reply` empty means the open reply's.
    pub(crate) fn set_wake(
        self: &Arc<Self>,
        id: &str,
        purpose: Purpose,
        due_ms: Option<i64>,
        condition: Option<Condition>,
        reason: &str,
    ) -> Result<String, StoreError> {
        let wake = self.ids.next("w");
        let reply = Transcript::fold(self.load(id)?.iter())
            .open_reply()
            .and_then(|m| m.reply.clone())
            .unwrap_or_default();
        let event = Event::Known(Known::WakeSet {
            wake: wake.clone(),
            reply: reply.clone(),
            purpose: purpose.clone(),
            due_ms,
            condition: condition.clone(),
            reason: reason.to_owned(),
        });
        self.record(id, &event)?;
        self.arm(
            id,
            Open {
                wake: wake.clone(),
                reply,
                purpose,
                due_ms,
                condition,
                reason: reason.to_owned(),
            },
        );
        self.announce(id);
        Ok(wake)
    }

    /// `wait_for` from conversation `id`: checks `condition` can happen, fixes what it needs
    /// (a file's stamp), and sets the wait; its id.
    pub(crate) fn wait_for(
        self: &Arc<Self>,
        id: &str,
        condition: Condition,
        timeout_ms: Option<i64>,
        reason: &str,
    ) -> Result<String, String> {
        let events = self.load(id).map_err(|e| e.to_string())?;
        let condition = match condition {
            Condition::Job { job } => {
                if !Transcript::fold(events.iter()).jobs.contains(&job) {
                    return Err(format!(
                        "Job {job} is not running, so there is nothing to wait for."
                    ));
                }
                Condition::Job { job }
            }
            Condition::ServiceLine { service, pattern } => {
                running_service(&events, &service)?;
                regex::RegexBuilder::new(&pattern)
                    .size_limit(1 << 20)
                    .build()
                    .map_err(|e| format!("The pattern is not a valid regex: {e}"))?;
                Condition::ServiceLine { service, pattern }
            }
            Condition::ServiceExit { service } => {
                running_service(&events, &service)?;
                Condition::ServiceExit { service }
            }
            Condition::File { path, .. } => {
                let (target, _) = self
                    .workspace_file(id, &path)
                    .ok_or_else(|| format!("{path} is not a path in your workspace."))?;
                let stamp = Some(super::wake_sources::stamp(&target));
                Condition::File { path, stamp }
            }
            Condition::Url { url } => {
                if !loopback(&url) {
                    return Err(
                        "wait_for polls only this machine's own addresses (localhost, 127.0.0.1,                          [::1]); use web_fetch for anything else."
                            .to_owned(),
                    );
                }
                Condition::Url { url }
            }
            Condition::Thread { thread } if thread.trim().is_empty() => {
                return Err("Name the ace thread by its id.".to_owned());
            }
            other => other,
        };
        let due = timeout_ms.map(|ms| self.now_ms() + ms.clamp(0, wake::LONGEST_MS));
        self.set_wake(id, Purpose::Wait, due, Some(condition), reason)
            .map_err(|e| e.to_string())
    }

    /// Arms `open`: in the timer's list, and with its event source when it has one.
    pub(super) fn arm(self: &Arc<Self>, id: &str, open: Open) {
        let pattern = match &open.condition {
            Some(Condition::ServiceLine { pattern, .. }) => regex::Regex::new(pattern).ok(),
            _ => None,
        };
        let condition = open.condition.clone();
        let wake_id = open.wake.clone();
        {
            let mut armed = lock(&self.wakes.armed);
            let list = armed.entry(id.to_owned()).or_default();
            if list.iter().any(|a| a.open.wake == open.wake) {
                return;
            }
            list.push(Armed { open, pattern });
        }
        match condition {
            Some(Condition::File { path, stamp }) => {
                self.watch_file(id, &wake_id, &path, stamp.as_deref());
            }
            Some(Condition::Url { url }) => self.poll_url(id, &wake_id, &url),
            _ => {}
        }
        self.wakes.kick.notify_one();
    }

    pub(super) fn disarm(&self, id: &str, wake: &str) {
        if let Some(list) = lock(&self.wakes.armed).get_mut(id) {
            list.retain(|a| a.open.wake != wake);
        }
        lock(&self.wakes.sources).remove(wake);
    }

    /// Forgets every armed wake of a deleted conversation.
    pub(super) fn forget_wakes(&self, id: &str) {
        let gone = lock(&self.wakes.armed).remove(id).unwrap_or_default();
        let mut sources = lock(&self.wakes.sources);
        for armed in gone {
            sources.remove(&armed.open.wake);
        }
    }

    /// Fires `wake` for `cause`, once: stored only while it is still open. `what` says what
    /// happened, `data` is untrusted text that came with it. Answers whether this stored it.
    pub(crate) fn fire_wake(
        self: &Arc<Self>,
        id: &str,
        wake: &str,
        cause: Cause,
        what: Option<&str>,
        data: Vec<String>,
    ) -> bool {
        let open = self.load(id).ok().and_then(|events| {
            wake::open(events.iter())
                .into_iter()
                .find(|o| o.wake == wake)
        });
        let Some(open) = open else {
            self.disarm(id, wake);
            return false;
        };
        let note = wake::note(&open, cause, what);
        let data = if note.is_some() { data } else { Vec::new() };
        let event = wake::fired(wake, cause, note.clone(), data);
        let stored = if note.is_some() {
            // Like a job's result: it steers the open turn or opens a reply. The engine's
            // delivery stores it only while the wake is open.
            matches!(
                self.deliver_as(id, &event, None),
                Ok(spade_store::Delivered::Stored(_))
            )
        } else {
            self.record_if_open(id, wake, &event)
        };
        self.disarm(id, wake);
        if stored {
            if let Purpose::Retry { job: Some(job), .. } = &open.purpose {
                super::jobs::rerun(self, id, job);
            }
            self.announce(id);
        }
        stored
    }

    /// Stores `event` if `wake` is still open; whether it did.
    fn record_if_open(&self, id: &str, wake: &str, event: &Event) -> bool {
        let _order = lock(&self.record_lock);
        let open = self
            .load(id)
            .is_ok_and(|events| wake::is_open(&events, wake));
        open && self.append(id, event).is_ok()
    }

    /// Cancels `wake` (a parked job's cancel ends that job); whether it was open.
    pub fn cancel_wake(
        self: &Arc<Self>,
        id: &str,
        wake: &str,
        by: CancelledBy,
    ) -> Result<bool, StoreError> {
        let cancelled = {
            let _order = lock(&self.record_lock);
            let events = self.load(id)?;
            let Some(open) = wake::open(events.iter())
                .into_iter()
                .find(|o| o.wake == wake)
            else {
                drop(_order);
                self.disarm(id, wake);
                return Ok(false);
            };
            let mut batch = vec![Event::Known(Known::WakeCancelled {
                wake: wake.to_owned(),
                by,
            })];
            if let Purpose::Retry { job: Some(job), .. } = &open.purpose {
                batch.push(Event::Known(Known::JobFinished {
                    job: job.clone(),
                    name: job_name(&events, job),
                    content: "Its retry was cancelled, so it did not run again.".to_owned(),
                    is_error: true,
                    uncertain: false,
                    files: Vec::new(),
                    untrusted: false,
                    cost_micros: None,
                }));
            }
            self.append_events(id, &batch)?;
            true
        };
        self.disarm(id, wake);
        self.announce(id);
        Ok(cancelled)
    }

    /// The person wakes `wake` now; whether it was open.
    pub fn wake_now(self: &Arc<Self>, id: &str, wake: &str) -> bool {
        self.fire_wake(id, wake, Cause::Person, None, Vec::new())
    }

    /// The conversation's open wakes, oldest first.
    pub fn wakes(&self, id: &str) -> Result<Vec<Open>, StoreError> {
        Ok(wake::open(self.load(id)?.iter()))
    }

    /// Agent `agent`'s open wakes as the API shows them; `None` for no such agent.
    pub fn agent_wakes(&self, agent: &str) -> Result<Option<Vec<serde_json::Value>>, StoreError> {
        let Some(agent) = self.store.agent(agent)? else {
            return Ok(None);
        };
        Ok(Some(
            self.wakes(&agent.conversation)?
                .iter()
                .map(|open| self.wake_json(open))
                .collect(),
        ))
    }

    /// The person wakes agent `agent` now from `wake`; `None` for no such agent.
    pub fn agent_wake_now(
        self: &Arc<Self>,
        agent: &str,
        wake: &str,
    ) -> Result<Option<bool>, StoreError> {
        let Some(agent) = self.store.agent(agent)? else {
            return Ok(None);
        };
        Ok(Some(self.wake_now(&agent.conversation, wake)))
    }

    /// The person cancels agent `agent`'s `wake`; `None` for no such agent.
    pub fn agent_cancel_wake(
        self: &Arc<Self>,
        agent: &str,
        wake: &str,
    ) -> Result<Option<bool>, StoreError> {
        let Some(agent) = self.store.agent(agent)? else {
            return Ok(None);
        };
        self.cancel_wake(&agent.conversation, wake, CancelledBy::Person)
            .map(Some)
    }

    /// Stop: every open wake is cancelled and every service stopped. Whether there were any.
    pub(super) fn stop_wakes(self: &Arc<Self>, id: &str) -> bool {
        let open = self.wakes(id).unwrap_or_default();
        let mut any = false;
        for o in open {
            match self.cancel_wake(id, &o.wake, CancelledBy::Stop) {
                Ok(true) => any = true,
                Ok(false) => {}
                Err(error) => tracing::warn!(%error, "Stop could not cancel a wake"),
            }
        }
        self.stop_services(id) || any
    }

    /// A reply failed for a while after its retries: parked, it is tried again later.
    pub(super) fn park_reply(self: &Arc<Self>, id: &str, error: &str) {
        if self.helper_of(id).is_some() || self.deleting(id) {
            return;
        }
        let Ok(events) = self.load(id) else { return };
        let attempt = wake::next_reply_attempt(&events);
        let due = self.now_ms() + wake::retry_after_ms(attempt, None);
        let purpose = Purpose::Retry {
            attempt,
            job: None,
            error: short(error),
        };
        if let Err(error) = self.set_wake(id, purpose, Some(due), None, "") {
            tracing::error!(%error, "could not park a failed reply for a retry");
        }
    }

    /// A background job failed for a while: parked, the same call runs again later. Whether it
    /// was parked (else its failure is stored as its result).
    pub(super) fn park_job(self: &Arc<Self>, id: &str, job: &str, error: &str) -> bool {
        let Ok(events) = self.load(id) else {
            return false;
        };
        if spade_core::turn::job_stopped(&events, job) || self.deleting(id) {
            return false;
        }
        let attempt = wake::next_job_attempt(&events, job);
        let due = self.now_ms() + wake::retry_after_ms(attempt, None);
        let purpose = Purpose::Retry {
            attempt,
            job: Some(job.to_owned()),
            error: short(error),
        };
        self.set_wake(id, purpose, Some(due), None, "").is_ok()
    }

    /// Makes the timer look again now (a test that moved its clock).
    pub fn kick_wakes(&self) {
        self.wakes.kick.notify_one();
    }

    /// Fires every armed wake whose time has come, and the check-ins due; answers when the next
    /// is due.
    pub(crate) fn wake_tick(self: &Arc<Self>) -> Option<i64> {
        let now = self.now_ms();
        let due: Vec<(String, String, Cause)> = lock(&self.wakes.armed)
            .iter()
            .flat_map(|(id, list)| {
                list.iter()
                    .filter(|a| a.open.due_ms.is_some_and(|due| due <= now))
                    .map(|a| {
                        let cause = match a.open.purpose {
                            Purpose::Wait => Cause::Timeout,
                            _ => Cause::Time,
                        };
                        (id.clone(), a.open.wake.clone(), cause)
                    })
                    .collect::<Vec<_>>()
            })
            .collect();
        for (id, wake, cause) in due {
            self.fire_wake(&id, &wake, cause, None, Vec::new());
        }
        let next_check = self.check_in_jobs(now);
        let next_wake = lock(&self.wakes.armed)
            .values()
            .flatten()
            .filter_map(|a| a.open.due_ms)
            .min();
        [next_wake, next_check].into_iter().flatten().min()
    }

    /// When Spade opens for work: arms every open wake from storage (one already due fires on
    /// the timer's first look), starts the timer, and starts `keep` services again. Once.
    pub(super) fn restore_wakes(self: &Arc<Self>) {
        if self.wakes.restored.swap(true, Ordering::SeqCst) {
            return;
        }
        match self.store.conversations() {
            Ok(conversations) => {
                for conversation in conversations {
                    for open in self.wakes(&conversation.id).unwrap_or_default() {
                        self.arm(&conversation.id, open);
                    }
                }
            }
            Err(error) => tracing::error!(%error, "could not arm the bots' wakes"),
        }
        start_timer(self);
        self.restore_services();
    }

    /// An ace thread changed (`state`: done, failed, needs_you): the waits on it fire.
    pub(crate) fn wake_on_thread(self: &Arc<Self>, thread: &str, state: &str, title: &str) {
        let hits = self.armed_where(
            |a| matches!(&a.open.condition, Some(Condition::Thread { thread: t }) if t == thread),
        );
        let what = format!("ace thread {thread} is {}", state.replace('_', " "));
        let title: String = title
            .chars()
            .filter(|c| !c.is_control())
            .take(120)
            .collect();
        for (id, wake) in hits {
            self.fire_wake(
                &id,
                &wake,
                Cause::Condition,
                Some(&what),
                vec![title.clone()],
            );
        }
    }

    /// A line `name`'s service printed: the waits whose pattern it matches fire, with the line
    /// as untrusted data.
    pub(crate) fn wake_on_service_line(self: &Arc<Self>, id: &str, name: &str, line: &str) {
        let hits: Vec<(String, String)> = lock(&self.wakes.armed)
            .get(id)
            .map(|list| {
                list.iter()
                    .filter(|a| {
                        matches!(&a.open.condition,
                            Some(Condition::ServiceLine { service, .. }) if service == name)
                            && a.pattern.as_ref().is_some_and(|p| p.is_match(line))
                    })
                    .map(|a| (id.to_owned(), a.open.wake.clone()))
                    .collect()
            })
            .unwrap_or_default();
        let what = format!("service {name} printed a matching line");
        let line: String = line.chars().take(1000).collect();
        for (id, wake) in hits {
            self.fire_wake(
                &id,
                &wake,
                Cause::Condition,
                Some(&what),
                vec![line.clone()],
            );
        }
    }

    /// `name`'s service ended (`how`: "exited with code 1", "was stopped"): the waits for its
    /// exit fire, and so do the waits for a line it never printed.
    pub(super) fn wake_on_service_end(self: &Arc<Self>, id: &str, name: &str, how: &str) {
        let hits: Vec<(String, String)> = lock(&self.wakes.armed)
            .get(id)
            .map(|list| {
                list.iter()
                    .filter(|a| match &a.open.condition {
                        Some(Condition::ServiceExit { service })
                        | Some(Condition::ServiceLine { service, .. }) => service == name,
                        _ => false,
                    })
                    .map(|a| (id.to_owned(), a.open.wake.clone()))
                    .collect()
            })
            .unwrap_or_default();
        let what = format!("service {name} {how}");
        for (id, wake) in hits {
            self.fire_wake(&id, &wake, Cause::Condition, Some(&what), Vec::new());
        }
    }

    /// The armed wakes `keep` accepts, as (conversation, wake).
    fn armed_where(&self, keep: impl Fn(&Armed) -> bool) -> Vec<(String, String)> {
        lock(&self.wakes.armed)
            .iter()
            .flat_map(|(id, list)| {
                list.iter()
                    .filter(|a| keep(a))
                    .map(|a| (id.clone(), a.open.wake.clone()))
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    /// An open wake as the API shows it.
    pub fn wake_json(&self, open: &Open) -> serde_json::Value {
        let purpose = match &open.purpose {
            Purpose::Sleep => "sleep",
            Purpose::Wait => "wait",
            Purpose::Retry { .. } => "retry",
        };
        let (attempt, job, error) = match &open.purpose {
            Purpose::Retry {
                attempt,
                job,
                error,
            } => (Some(*attempt), job.clone(), Some(error.clone())),
            _ => (None, None, None),
        };
        serde_json::json!({
            "id": open.wake,
            "purpose": purpose,
            "due_at": open.due_ms,
            "condition": open.condition,
            "reason": open.reason,
            "words": wake::words(open, |ms| self.short_time(ms)),
            "attempt": attempt,
            "job": job,
            "error": error,
        })
    }

    /// A time for the person: `14:05` today, else `Mon 14:05`, in their zone.
    pub(super) fn short_time(&self, ms: i64) -> String {
        let zone = self.zone();
        let (Ok(at), Ok(now)) = (
            jiff::Timestamp::from_millisecond(ms),
            jiff::Timestamp::from_millisecond(self.now_ms()),
        ) else {
            return ms.to_string();
        };
        let (at, now) = (at.to_zoned(zone.clone()), now.to_zoned(zone));
        if at.date() == now.date() {
            at.strftime("%H:%M").to_string()
        } else {
            at.strftime("%a %d %b %H:%M").to_string()
        }
    }
}

/// The timer: fires wakes as their times come, until the engine is gone.
fn start_timer(engine: &Arc<Engine>) {
    let weak = Arc::downgrade(engine);
    tokio::spawn(async move {
        loop {
            let Some(engine) = weak.upgrade() else { return };
            let next = engine.wake_tick();
            let wait = next.map_or(LONGEST_SLEEP, |at| {
                let ms = u64::try_from(at.saturating_sub(engine.now_ms())).unwrap_or(0);
                Duration::from_millis(ms).min(LONGEST_SLEEP)
            });
            let kick = engine.wakes.kick.clone();
            drop(engine);
            tokio::select! {
                () = tokio::time::sleep(wait) => {}
                () = kick.notified() => {}
            }
        }
    });
}

/// The running service named `name`, or why there is none.
fn running_service(events: &[Event], name: &str) -> Result<(), String> {
    if spade_core::service::running(events.iter())
        .iter()
        .any(|s| s.name == name || s.service == name)
    {
        Ok(())
    } else {
        Err(format!(
            "No service named {name} is running; service_status lists yours."
        ))
    }
}

/// Whether `url` is http(s) on this machine's loopback.
fn loopback(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return false;
    }
    let Some(host) = parsed.host_str() else {
        return false;
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

/// An error in a few words for a retry's record.
fn short(error: &str) -> String {
    let line: String = error.split_whitespace().collect::<Vec<_>>().join(" ");
    line.chars().take(160).collect()
}

pub(super) fn job_name(events: &[Event], job: &str) -> String {
    events
        .iter()
        .find_map(|event| match event {
            Event::Known(Known::JobStarted { job: j, name, .. }) if j == job => Some(name.clone()),
            _ => None,
        })
        .unwrap_or_default()
}
