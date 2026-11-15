//! Wakes (ADR 0160): a bot sleeps until a time, waits for an event, or has a failed step parked
//! for a retry. Each is a `wake_set` event; it stays open until a `wake_fired` or a
//! `wake_cancelled` names it. Which wakes are open, which event settles which wait, what the
//! model reads when one fires and when a retry or a check-in is due are all decided here. Pure.

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
    /// A step that failed for a while is tried again (`attempt` counts from 1): the reply when
    /// `job` is `None`, else that background job's call.
    Retry {
        attempt: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        job: Option<String>,
        /// What went wrong, in a few words.
        #[serde(default)]
        error: String,
    },
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
/// end settles the waits on it; the person's message settles waits for the person and a parked
/// reply retry (their message opens a reply anyway); another bot's message settles the waits for
/// it. The model reads `event` itself, so these say nothing more.
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
                    || matches!(purpose, Purpose::Retry { job: None, .. })
            }
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
            _ => false,
        }
    };
    let cause = match known {
        Known::JobFinished { .. } => Cause::Condition,
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
/// runs the job again and tells the model nothing until its result.
pub fn note(open: &Open, cause: Cause, what: Option<&str>) -> Option<String> {
    let reason = if open.reason.is_empty() {
        String::new()
    } else {
        format!(" You gave this reason: {}.", open.reason)
    };
    let body = match (&open.purpose, cause) {
        (Purpose::Retry { job: Some(_), .. }, _) => return None,
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
        Known::WakeFired { note: Some(_), .. } | Known::JobProgress { .. }
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
        _ => None,
    }
}

/// Whether a note event carries untrusted text.
pub fn untrusted(event: &Known) -> bool {
    match event {
        Known::WakeFired { data, .. } => !data.is_empty(),
        Known::JobProgress { tail, .. } => !tail.is_empty(),
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

/// When a parked retry's attempt `attempt` (from 1) is tried: 1, 2, 4 … minutes after the
/// failure, at most an hour, or later if the endpoint asked for longer.
pub fn retry_after_ms(attempt: u32, asked_ms: Option<i64>) -> i64 {
    let backoff = MINUTE_MS
        .saturating_mul(1_i64 << attempt.saturating_sub(1).min(10))
        .min(HOUR_MS);
    asked_ms.map_or(backoff, |asked| backoff.max(asked.min(HOUR_MS)))
}

/// The attempt a new parked reply retry is: one more than the parked retries fired since the
/// last reply that finished.
pub fn next_reply_attempt(events: &[Event]) -> u32 {
    let since = events
        .iter()
        .rposition(|e| matches!(e, Event::Known(Known::ReplyFinished { .. })))
        .map_or(0, |at| at + 1);
    let retries: Vec<&str> = events[since..]
        .iter()
        .filter_map(|e| match e {
            Event::Known(Known::WakeSet {
                wake,
                purpose: Purpose::Retry { job: None, .. },
                ..
            }) => Some(wake.as_str()),
            _ => None,
        })
        .collect();
    u32::try_from(retries.len())
        .unwrap_or(u32::MAX)
        .saturating_add(1)
}

/// The attempt a new retry of parked job `job` is.
pub fn next_job_attempt(events: &[Event], job: &str) -> u32 {
    let tries = events
        .iter()
        .filter(|e| {
            matches!(e, Event::Known(Known::WakeSet {
                purpose: Purpose::Retry { job: Some(j), .. }, ..
            }) if j == job)
        })
        .count();
    u32::try_from(tries).unwrap_or(u32::MAX).saturating_add(1)
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
        (Purpose::Retry { error, .. }, None) => format!("Waiting to try again ({error})"),
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
