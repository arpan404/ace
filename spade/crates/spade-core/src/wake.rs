//! Wakes (ADR 0160): every timed or event-driven resume of a bot's work. A bot sleeps until a
//! time or waits for an event; a turn waits out its endpoint's outage; a background job that
//! failed for a while is parked for a retry; a task waits for a spending cap's reset or for its
//! check of done to reach its model (ADR 0158). Each is a `wake_set` event; it stays open until
//! a `wake_fired` or a `wake_cancelled` names it. Which wakes are open, which event settles
//! which, what the model reads when one fires and when a retry or a check-in is due are all
//! decided here. Pure.

mod retry;

pub use retry::{
    Ended, ended, legacy_turn_wait, next_job_attempt, next_outage_attempt, next_park_attempt,
    next_reply_attempt, open_outage, retry_after_ms,
};

use serde::{Deserialize, Serialize};

use crate::event::{Event, Known};

pub const SLEEP_UNTIL: &str = "sleep_until";
pub const WAIT_FOR: &str = "wait_for";
pub const WAKE_CANCEL: &str = "wake_cancel";

/// The longest a bot may sleep or wait in one go.
pub const LONGEST_MS: i64 = 366 * DAY_MS;
const DAY_MS: i64 = 24 * HOUR_MS;
const HOUR_MS: i64 = 60 * MINUTE_MS;
const MINUTE_MS: i64 = 60_000;

/// What a wake is for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Purpose {
    /// `sleep_until`: the bot wakes at a time.
    Sleep,
    /// `wait_for`: the bot wakes on an event, or at its timeout.
    Wait,
    /// A background job that failed for a while runs its call again (`attempt` counts from 1).
    /// With no `job` it is a closed reply's retry stored by an earlier build, which opens a reply
    /// with a note when it fires; replies now wait in their turn instead ([`Purpose::Outage`]).
    Retry {
        attempt: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        job: Option<String>,
        /// What went wrong, in a few words.
        #[serde(default)]
        error: String,
    },
    /// The open reply (the wake's `reply`) waits out its endpoint's outage and sends its step
    /// again when this fires. The reply stays open; nothing is added for the model to read.
    Outage {
        attempt: u32,
        /// What went wrong, in a few words.
        #[serde(default)]
        error: String,
    },
    /// The bot's task waits before its next step or its check of done: for a spending cap's
    /// reset, or for the check's model to answer again. When it fires the task carries on; the
    /// wake's `reason` is what the person reads.
    Park {
        reason: ParkReason,
        #[serde(default)]
        attempt: u32,
    },
}

/// Why a task waits ([`Purpose::Park`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParkReason {
    /// A spending cap: the service's, or one of the bot's own.
    Cap,
    /// The check of done could not reach its model for a while.
    Check,
    /// A kind a later build adds.
    #[serde(other)]
    Other,
}

/// What a `wait_for` waits for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Condition {
    /// A background job of this conversation ends.
    Job { job: String },
    /// An owned service prints a line matching `pattern` (a regex).
    ServiceLine { service: String, pattern: String },
    /// An owned service exits.
    ServiceExit { service: String },
    /// A path in the workspace changes. `stamp` is how it was when the wait was set (size and
    /// modified time; `absent` when it did not exist), so a change while Spade was down counts.
    File {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stamp: Option<String>,
    },
    /// A loopback URL answers with a status below 500.
    Url { url: String },
    /// A delegated ace thread is done, failed or needs the person.
    Thread { thread: String },
    /// Another bot writes: any, or the one with this id or name.
    BotMessage {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bot: Option<String>,
    },
    /// The person writes.
    Person,
    /// A worker of this bot reports (ADR 0161): finishes, needs the person, fails, parks or
    /// stops. Any worker, or the one with this id.
    Worker {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        worker: Option<String>,
    },
    /// This worker's budget is raised (ADR 0161). Spade sets it when a subtree reaches its
    /// budget, so the worker waits instead of failing.
    Budget,
}

impl Condition {
    /// The condition in a few words, for the person and the bot.
    pub fn words(&self) -> String {
        match self {
            Self::Job { job } => format!("job {job} to finish"),
            Self::ServiceLine { service, pattern } => {
                format!("service {service} to print a line matching {pattern}")
            }
            Self::ServiceExit { service } => format!("service {service} to exit"),
            Self::File { path, .. } => format!("{path} to change"),
            Self::Url { url } => format!("{url} to answer"),
            Self::Thread { thread } => format!("ace thread {thread} to settle"),
            Self::BotMessage { bot: Some(bot) } => format!("a message from {bot}"),
            Self::BotMessage { bot: None } => "a message from another bot".to_owned(),
            Self::Person => "the person to write".to_owned(),
            Self::Worker {
                worker: Some(worker),
            } => format!("worker {worker} to report"),
            Self::Worker { worker: None } => "a worker to report".to_owned(),
            Self::Budget => "more budget".to_owned(),
        }
    }
}

/// Why a wake fired.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Cause {
    /// Its time came.
    Time,
    /// A wait's timeout passed first.
    Timeout,
    /// What it waited for happened.
    Condition,
    /// The person woke it early.
    Person,
    /// A message settled it (the message itself is what the bot reads).
    Message,
    /// A cause a newer Spade stored.
    #[serde(other)]
    Other,
}

impl Cause {
    pub fn name(self) -> &'static str {
        match self {
            Self::Time => "time",
            Self::Timeout => "timeout",
            Self::Condition => "condition",
            Self::Person => "person",
            Self::Message => "message",
            Self::Other => "other",
        }
    }
}

/// Who cancelled a wake.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CancelledBy {
    Person,
    Bot,
    Stop,
    #[serde(other)]
    Other,
}

/// A wake still waiting to fire.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Open {
    pub wake: String,
    /// The reply that set it (empty for a retry Spade set after a reply closed).
    pub reply: String,
    pub purpose: Purpose,
    /// When it fires by time: a sleep's time, a wait's timeout, a retry's next try.
    pub due_ms: Option<i64>,
    pub condition: Option<Condition>,
    pub reason: String,
}

/// The open wakes, oldest first.
pub fn open<'a>(events: impl IntoIterator<Item = &'a Event>) -> Vec<Open> {
    let mut open: Vec<Open> = Vec::new();
    for event in events {
        let Event::Known(known) = event else { continue };
        match known {
            Known::WakeSet {
                wake,
                reply,
                purpose,
                due_ms,
                condition,
                reason,
            } => {
                if !open.iter().any(|o| &o.wake == wake) {
                    open.push(Open {
                        wake: wake.clone(),
                        reply: reply.clone(),
                        purpose: purpose.clone(),
                        due_ms: *due_ms,
                        condition: condition.clone(),
                        reason: reason.clone(),
                    });
                }
            }
            Known::WakeFired { wake, .. } | Known::WakeCancelled { wake, .. } => {
                open.retain(|o| &o.wake != wake);
            }
            _ => {}
        }
    }
    open
}

/// Whether `wake` is still open.
pub fn is_open(events: &[Event], wake: &str) -> bool {
    open(events).iter().any(|o| o.wake == wake)
}

/// Whether background job `job` is parked for a retry: it is not running, and not lost.
pub fn parked(events: &[Event], job: &str) -> bool {
    open(events)
        .iter()
        .any(|o| matches!(&o.purpose, Purpose::Retry { job: Some(j), .. } if j == job))
}

/// The `wake_fired` events (with no note) that `event`, about to be delivered, settles: a job's
/// end settles the waits on it; the person's message settles waits for the person and a turn
/// waiting out an outage (its step is sent again now, with the message); any message settles a
/// parked task (the reply it opens carries the task on); another bot's message settles the waits
/// for it. The model reads `event` itself, so these say nothing more.
pub fn settled_by(events: &[Event], event: &Event) -> Vec<Event> {
    let Event::Known(known) = event else {
        return Vec::new();
    };
    let settles = |o: &Open| -> bool {
        match (known, &o.condition, &o.purpose) {
            (Known::JobFinished { job, .. }, Some(Condition::Job { job: waited }), _) => {
                job == waited
            }
            (
                Known::UserMessage {
                    from_agent: None,
                    from_routine: None,
                    from_group: None,
                    ..
                },
                condition,
                purpose,
            ) => {
                matches!(condition, Some(Condition::Person))
                    || matches!(
                        purpose,
                        Purpose::Retry { job: None, .. }
                            | Purpose::Outage { .. }
                            | Purpose::Park { .. }
                    )
            }
            // Any message opens a reply, which meets the cap again if it still holds.
            (Known::UserMessage { .. }, _, Purpose::Park { .. }) => true,
            (
                Known::UserMessage {
                    from_agent: Some(from),
                    ..
                },
                Some(Condition::BotMessage { bot }),
                _,
            ) => bot
                .as_deref()
                .is_none_or(|bot| bot == from.id || bot.eq_ignore_ascii_case(&from.name)),
            // A worker's report is what the bot reads (ADR 0161).
            // Not while an ace child is only being stopped: it has not settled.
            (Known::WorkerReported(report), Some(Condition::Worker { worker }), _)
                if report.state != crate::tree::ReportState::Stopping =>
            {
                worker
                    .as_deref()
                    .is_none_or(|w| w == report.worker || w.eq_ignore_ascii_case(&report.name))
            }
            _ => false,
        }
    };
    let cause = match known {
        Known::JobFinished { .. } | Known::WorkerReported(_) => Cause::Condition,
        _ => Cause::Message,
    };
    open(events)
        .iter()
        .filter(|o| settles(o))
        .map(|o| fired(&o.wake, cause, None, Vec::new()))
        .collect()
}

/// A `wake_fired` event.
pub fn fired(wake: &str, cause: Cause, note: Option<String>, data: Vec<String>) -> Event {
    Event::Known(Known::WakeFired {
        wake: wake.to_owned(),
        cause,
        note,
        data,
    })
}

/// What the bot reads when `open` fires for `cause`. `what` says what happened when a condition
/// fired it (`service web printed a line matching ready`). `None` for a parked job's retry, which
/// runs the job again and tells the model nothing until its result, for a turn's outage wait,
/// whose step is simply sent again, and for a parked task, which carries on with its own note.
pub fn note(open: &Open, cause: Cause, what: Option<&str>) -> Option<String> {
    let reason = if open.reason.is_empty() {
        String::new()
    } else {
        format!(" You gave this reason: {}.", open.reason)
    };
    let body = match (&open.purpose, cause) {
        (
            Purpose::Retry { job: Some(_), .. } | Purpose::Outage { .. } | Purpose::Park { .. },
            _,
        ) => return None,
        (Purpose::Retry { attempt, error, .. }, _) => format!(
            "Your last reply failed ({error}), so Spade parked it and is trying again \
             (attempt {attempt}). Carry on where you left off."
        ),
        (_, Cause::Person) => format!("The person woke you early.{reason} Carry on."),
        (Purpose::Sleep, _) => format!("Your sleep is over.{reason} Carry on."),
        (Purpose::Wait, Cause::Timeout) => format!(
            "You waited for {}, and your timeout passed first.{reason} Decide what to do next.",
            open.condition
                .as_ref()
                .map_or_else(String::new, Condition::words)
        ),
        (Purpose::Wait, _) => format!(
            "What you waited for happened: {}.{reason} Carry on.",
            what.map_or_else(
                || open
                    .condition
                    .as_ref()
                    .map_or_else(String::new, Condition::words),
                str::to_owned
            )
        ),
    };
    Some(format!(
        "<wake id=\"{}\" cause=\"{}\" from=\"spade\">\n{body}\n</wake>",
        open.wake,
        cause.name()
    ))
}

/// A fired wake as the model reads it: Spade's note, then any untrusted data (a service's line,
/// a thread's title) quoted as JSON. `None` when it carries no note.
pub fn shown(note: Option<&str>, data: &[String]) -> Option<String> {
    let mut text = note?.to_owned();
    if !data.is_empty() {
        let quoted = serde_json::to_string_pretty(data).unwrap_or_default();
        text.push_str(&format!(
            "\n<wake_data untrusted=\"true\">\n{quoted}\n</wake_data>"
        ));
    }
    Some(text)
}

/// Whether `event` is something from Spade the model reads as it arrives: a wake's note or a
/// job's check-in. Like a job's result it steers an open turn or opens a reply.
pub fn is_note(event: &Known) -> bool {
    matches!(
        event,
        Known::WakeFired { note: Some(_), .. }
            | Known::JobProgress { .. }
            | Known::WorkerReported(_)
    )
}

/// The text of a note event ([`is_note`]).
pub fn note_text(event: &Known) -> Option<String> {
    match event {
        Known::WakeFired { note, data, .. } => shown(note.as_deref(), data),
        Known::JobProgress {
            job,
            name,
            minutes,
            tail,
            ..
        } => Some(progress_text(job, name, *minutes, tail)),
        Known::WorkerReported(report) => Some(crate::tree::report_text(report)),
        _ => None,
    }
}

/// Whether a note event carries untrusted text.
pub fn untrusted(event: &Known) -> bool {
    match event {
        Known::WakeFired { data, .. } => !data.is_empty(),
        Known::JobProgress { tail, .. } => !tail.is_empty(),
        Known::WorkerReported(report) => report.words.is_some(),
        _ => false,
    }
}

/// A check-in on a long background job.
pub fn progress_text(job: &str, name: &str, minutes: u32, tail: &str) -> String {
    let mut text = format!(
        "<job_progress job=\"{job}\" tool=\"{name}\" minutes=\"{minutes}\" from=\"spade\">\n\
         This job has been running for {minutes} minutes. Read what it shows: if it is still \
         making progress, end your reply and its result will arrive; if it is stuck, stop it or \
         try another way.\n</job_progress>"
    );
    if tail.is_empty() {
        text.push_str("\n(It shows no output Spade can read.)");
    } else {
        let quoted = serde_json::to_string(tail).unwrap_or_default();
        text.push_str(&format!(
            "\n<job_output untrusted=\"true\">\n{quoted}\n</job_output>"
        ));
    }
    text
}

/// When a job's check-in `check` (from 1) is due, in minutes after it started: 15, 30, 60, 120,
/// then every two hours.
pub fn check_in_minutes(check: u32) -> u32 {
    match check {
        0 | 1 => 15,
        2 => 30,
        3 => 60,
        n => 120 * (n - 3),
    }
}

/// The check-ins already stored for `job`.
pub fn checks_done(events: &[Event], job: &str) -> u32 {
    let done = events
        .iter()
        .filter(|e| matches!(e, Event::Known(Known::JobProgress { job: j, .. }) if j == job))
        .count();
    u32::try_from(done).unwrap_or(u32::MAX)
}

/// Reads `after`: whole seconds, or a duration such as `90s`, `15m`, `2h`, `1d`, `1h30m`.
/// Answers milliseconds.
pub fn parse_after(after: &serde_json::Value) -> Result<i64, String> {
    if let Some(seconds) = after.as_i64() {
        return if seconds >= 0 {
            Ok(seconds.saturating_mul(1000))
        } else {
            Err("after cannot be negative".to_owned())
        };
    }
    let text = after
        .as_str()
        .ok_or("after is seconds or a duration such as 15m, 2h or 1d")?
        .trim()
        .to_ascii_lowercase();
    if text.is_empty() {
        return Err("after is empty".to_owned());
    }
    let mut total: i64 = 0;
    let mut number = String::new();
    for c in text.chars() {
        if c.is_ascii_digit() {
            number.push(c);
            continue;
        }
        if c.is_whitespace() {
            continue;
        }
        let unit = match c {
            's' => 1000,
            'm' => MINUTE_MS,
            'h' => HOUR_MS,
            'd' => DAY_MS,
            _ => return Err(format!("{text} is not a duration such as 15m, 2h or 1d")),
        };
        let n: i64 = number
            .parse()
            .map_err(|_| format!("{text} is not a duration such as 15m, 2h or 1d"))?;
        total = total.saturating_add(n.saturating_mul(unit));
        number.clear();
    }
    if !number.is_empty() {
        let n: i64 = number
            .parse()
            .map_err(|_| format!("{text} is not a duration"))?;
        total = total.saturating_add(n.saturating_mul(1000));
    }
    Ok(total)
}

/// What the person reads about the open wake `open` (the roster's status line). `at` formats a
/// time for the person.
pub fn words(open: &Open, at: impl Fn(i64) -> String) -> String {
    let reason = if open.reason.is_empty() {
        String::new()
    } else {
        format!(": {}", open.reason)
    };
    match (&open.purpose, open.due_ms) {
        (Purpose::Retry { error, .. }, Some(due)) => {
            format!("Trying again at {} ({error})", at(due))
        }
        (Purpose::Retry { error, .. } | Purpose::Outage { error, .. }, None) => {
            format!("Waiting to try again ({error})")
        }
        (Purpose::Outage { error, .. }, Some(due)) => {
            format!(
                "The model is not answering; trying again at {} ({error})",
                at(due)
            )
        }
        (
            Purpose::Park {
                reason: ParkReason::Check,
                ..
            },
            Some(due),
        ) => format!("Checking the work again at {} ({})", at(due), open.reason),
        (Purpose::Park { .. }, _) if !open.reason.is_empty() => open.reason.clone(),
        (Purpose::Park { .. }, Some(due)) => format!("Waiting until {}", at(due)),
        (Purpose::Park { .. }, None) => "Waiting".to_owned(),
        (Purpose::Sleep, Some(due)) => format!("Sleeping until {}{reason}", at(due)),
        (Purpose::Sleep, None) => format!("Sleeping{reason}"),
        (Purpose::Wait, _) => format!(
            "Waiting for {}{reason}",
            open.condition
                .as_ref()
                .map_or_else(String::new, Condition::words)
        ),
    }
}

/// The open wake the person should see first: the soonest by time, else the oldest.
pub fn soonest(open: &[Open]) -> Option<&Open> {
    open.iter()
        .filter(|o| o.due_ms.is_some())
        .min_by_key(|o| o.due_ms)
        .or_else(|| open.first())
}

#[cfg(test)]
mod tests;
