//! The process model (ADR 0200 §6): a bot's state with everything under it rolled up, `paused`
//! among them, and the task manager's one read, folded from facts the engine gathers. Pure: the
//! engine reads the store, the tree, the wakes and the egress log; this decides what each row
//! says and in which order rows come.

use serde::Serialize;

use crate::event::{Event, FailureKind, Known};
use crate::transcript::Transcript;

/// What a bot is doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Idle,
    Working,
    /// Needs the person: an approval or a question is open.
    Waiting,
    /// Sleeps or waits on a wake (ADR 0160): not idle, not done. A turn waiting out an outage
    /// and a task parked for its check read this way too.
    Sleeping,
    /// The person paused it (ADR 0200 §6.1): nothing of it fires until they resume it.
    Paused,
}

impl State {
    pub const fn name(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Working => "working",
            Self::Waiting => "waiting",
            Self::Sleeping => "sleeping",
            Self::Paused => "paused",
        }
    }

    /// From the folded transcript: waiting beats working, and background jobs count as working,
    /// so an agent is never shown idle while any of its work runs. Never `Paused`: that is the
    /// person's, not the transcript's (see [`held`]).
    pub fn of(transcript: &Transcript) -> Self {
        // A helper waiting on the person (ADR 0152) counts, even after the reply that started it.
        if transcript.waiting_on_you() {
            Self::Waiting
        } else if transcript.outage.is_some() && transcript.jobs.is_empty() {
            // The open turn waits out its endpoint's outage (ADR 0158): not done, not running.
            Self::Sleeping
        } else if transcript.open_reply().is_some() || !transcript.jobs.is_empty() {
            Self::Working
        } else if !transcript.wakes.is_empty() {
            Self::Sleeping
        } else {
            Self::Idle
        }
    }

    /// How strongly a state shows through the one above it: waiting, then working, sleeping,
    /// paused, idle (ADR 0200 §6.2).
    const fn rank(self) -> u8 {
        match self {
            Self::Idle => 0,
            Self::Paused => 1,
            Self::Sleeping => 2,
            Self::Working => 3,
            Self::Waiting => 4,
        }
    }
}

/// The state a node reads with something under it: the stronger of the two, so a bot never reads
/// idle (or done) while anything under it works or waits on the person (ace's priority 1).
pub fn rolled(own: State, under: State) -> State {
    if under.rank() > own.rank() {
        under
    } else {
        own
    }
}

/// A bot's own state once its pause is counted: a paused bot reads paused, its held wakes
/// included, unless it still waits on the person (a question its stopped work left open) or
/// something of it is still being stopped.
pub fn held(own: State, paused: bool) -> State {
    match own {
        State::Waiting | State::Working => own,
        _ if paused => State::Paused,
        _ => own,
    }
}

/// Why the bot's latest reply failed, in a few words, while that is the latest way one ended.
/// `None` once a later reply finished, stopped or was cut off.
pub fn failure<'a, I>(events: I) -> Option<String>
where
    I: IntoIterator<Item = &'a Event>,
    I::IntoIter: DoubleEndedIterator,
{
    events.into_iter().rev().find_map(|event| match event {
        Event::Known(Known::ReplyFailed { error, kind, .. }) => Some(failure_words(*kind, error)),
        Event::Known(
            Known::ReplyFinished { .. }
            | Known::ReplyStopped { .. }
            | Known::ReplyInterrupted { .. },
        ) => Some(None),
        _ => None,
    })?
}

/// The longest failure reason a row quotes, in characters.
pub const REASON_CHARS: usize = 120;

fn failure_words(kind: FailureKind, error: &str) -> Option<String> {
    let words = match kind {
        FailureKind::Unreachable => "its endpoint couldn't be reached",
        FailureKind::Key => "its endpoint refused the key",
        FailureKind::RateLimited => "its endpoint is rate limiting",
        FailureKind::Model => "the model failed while answering",
        FailureKind::NoModel => "it has no model to use",
        // Retired caps: such a reply counts as finished (ADR 0166).
        FailureKind::Cap => return None,
        FailureKind::Other => return Some(cut(error.trim(), REASON_CHARS)),
    };
    Some(words.to_owned())
}

fn cut(text: &str, longest: usize) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= longest {
        return line;
    }
    line.chars().take(longest - 1).collect::<String>() + "…"
}

/// What a bot holds open now.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Uses {
    /// A reply is open: a model call or a tool runs.
    pub answering: bool,
    /// Background jobs.
    pub jobs: usize,
    /// Workers under it that work, wait or sleep (ADR 0161).
    pub workers: usize,
    /// Owned services running (ADR 0160).
    pub services: usize,
    /// Ace coding agents it started may still run.
    pub agents: bool,
}

/// What a bot spent, against the line its spend alert draws (ADR 0166's amendment). Information
/// only: nothing stops for it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Spend {
    pub today_micros: u64,
    pub month_micros: u64,
    pub last_hour_micros: u64,
    /// The hourly spend above which the person is told; `None` while spend alerts are off.
    pub alert_line_micros: Option<u64>,
    /// Its last hour is above that line.
    pub unusual: bool,
}

/// One connection the egress log kept, as [`network_today`] reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Egress<'a> {
    pub at_ms: i64,
    pub host: &'a str,
    pub allowed: bool,
    pub sent: u64,
    pub received: u64,
}

/// A bot's network use today, from its egress log.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Network {
    pub sent_bytes: u64,
    pub received_bytes: u64,
    /// The hosts it reached, most bytes first.
    pub hosts: Vec<String>,
    /// Connections the policy refused.
    pub refused: usize,
}

/// The most hosts a row names.
pub const HOSTS: usize = 8;

/// What `entries` (any order) add up to from `day_start_ms` on.
pub fn network_today<'a>(
    entries: impl IntoIterator<Item = Egress<'a>>,
    day_start_ms: i64,
) -> Network {
    let mut by_host: Vec<(&str, u64)> = Vec::new();
    let mut network = Network::default();
    for entry in entries.into_iter().filter(|e| e.at_ms >= day_start_ms) {
        if !entry.allowed {
            network.refused += 1;
            continue;
        }
        network.sent_bytes = network.sent_bytes.saturating_add(entry.sent);
        network.received_bytes = network.received_bytes.saturating_add(entry.received);
        let bytes = entry.sent.saturating_add(entry.received);
        match by_host.iter_mut().find(|(host, _)| *host == entry.host) {
            Some((_, total)) => *total = total.saturating_add(bytes),
            None => by_host.push((entry.host, bytes)),
        }
    }
    by_host.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    network.hosts = by_host
        .into_iter()
        .take(HOSTS)
        .map(|(host, _)| host.to_owned())
        .collect();
    network
}

/// When a bot next does something by itself: a wake or a routine's slot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NextWake {
    pub at_ms: i64,
    /// What fires then: the wake's reason or the routine's name.
    pub what: String,
}

/// The sooner of `a` and `b`.
pub fn sooner(a: Option<NextWake>, b: Option<NextWake>) -> Option<NextWake> {
    match (a, b) {
        (Some(a), Some(b)) => Some(if b.at_ms < a.at_ms { b } else { a }),
        (a, b) => a.or(b),
    }
}

/// A worker under a bot, as its row lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Worker {
    pub id: String,
    pub name: String,
    pub state: State,
    pub doing: String,
}

/// What the engine knows of one bot, to fold into its row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Facts {
    pub id: String,
    pub name: String,
    /// `main` (Spade itself) or `bot`: listed alike.
    pub kind: String,
    pub conversation: String,
    /// Its face as the API shows it, passed through as it is.
    pub avatar: serde_json::Value,
    /// Rolled up over everything under it, its pause counted.
    pub state: State,
    /// The roster's words for what it does now, while it isn't idle.
    pub status: Option<String>,
    /// What it waits on the person for: `approval`, `question` or `worker`.
    pub waiting_for: Option<String>,
    /// Why its latest reply failed, while that is how the latest one ended.
    pub failure: Option<String>,
    pub paused_at_ms: Option<i64>,
    pub uses: Uses,
    pub spend: Spend,
    pub network: Network,
    pub next_wake: Option<NextWake>,
    pub workers: Vec<Worker>,
    /// A development bot: linked to a package folder on this machine (`ace bot dev`).
    pub development: bool,
}

/// How a row reads, in the order rows sort.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reads {
    NeedsYou,
    Working,
    Failed,
    Sleeping,
    Paused,
    Idle,
}

/// One row of the task manager.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Row {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub conversation: String,
    pub avatar: serde_json::Value,
    pub state: State,
    pub reads: Reads,
    /// Its state in words: "Checking fares", "Waiting on you: a question", "Paused".
    pub doing: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paused_at_ms: Option<i64>,
    pub uses: Uses,
    pub spend: Spend,
    pub network: Network,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_wake: Option<NextWake>,
    pub workers: Vec<Worker>,
    /// A development bot (ADR 0200 §9): the row says "Development".
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub development: bool,
    /// What the person may do now: `stop`, `pause`, `resume`.
    pub actions: Vec<&'static str>,
}

/// How a bot in `state` reads, with its latest reply's failure.
pub fn reads(state: State, failure: Option<&str>) -> Reads {
    match state {
        State::Waiting => Reads::NeedsYou,
        State::Working => Reads::Working,
        State::Sleeping => Reads::Sleeping,
        State::Paused => Reads::Paused,
        State::Idle if failure.is_some() => Reads::Failed,
        State::Idle => Reads::Idle,
    }
}

/// Its state in words, as its row says it.
pub fn doing(
    reads: Reads,
    status: Option<&str>,
    waiting_for: Option<&str>,
    failure: Option<&str>,
) -> String {
    match reads {
        Reads::NeedsYou => match waiting_for {
            Some("approval") => "Waiting on you: an approval".to_owned(),
            Some("question") => "Waiting on you: a question".to_owned(),
            Some("worker") => "Waiting on you: a worker asks".to_owned(),
            _ => "Waiting on you".to_owned(),
        },
        Reads::Working => status.unwrap_or("Working").to_owned(),
        Reads::Sleeping => status.unwrap_or("Sleeping").to_owned(),
        Reads::Paused => "Paused".to_owned(),
        Reads::Failed => format!("Failed: {}", failure.unwrap_or("something went wrong")),
        Reads::Idle => "Idle".to_owned(),
    }
}

/// What the person may do to a bot that reads `reads`: Stop while anything of it runs, then
/// Resume while it is paused (whatever it reads, a paused bot waiting on the person included),
/// else Pause.
pub fn actions(reads: Reads, uses: &Uses, paused: bool) -> Vec<&'static str> {
    let running = matches!(reads, Reads::NeedsYou | Reads::Working | Reads::Sleeping)
        || uses.answering
        || uses.jobs > 0
        || uses.workers > 0
        || uses.services > 0
        || uses.agents;
    let mut actions = Vec::new();
    if running {
        actions.push("stop");
    }
    actions.push(if paused { "resume" } else { "pause" });
    actions
}

/// Every bot's row: needs you first, then working, failed, sleeping, paused and idle, each by
/// name. Spade's own bot is an ordinary row among them.
pub fn rows(facts: Vec<Facts>) -> Vec<Row> {
    let mut rows: Vec<Row> = facts.into_iter().map(row).collect();
    rows.sort_by(|a, b| {
        a.reads
            .cmp(&b.reads)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.id.cmp(&b.id))
    });
    rows
}

fn row(facts: Facts) -> Row {
    let reads = reads(facts.state, facts.failure.as_deref());
    let doing = doing(
        reads,
        facts.status.as_deref(),
        facts.waiting_for.as_deref(),
        facts.failure.as_deref(),
    );
    let actions = actions(reads, &facts.uses, facts.paused_at_ms.is_some());
    Row {
        id: facts.id,
        name: facts.name,
        kind: facts.kind,
        conversation: facts.conversation,
        avatar: facts.avatar,
        state: facts.state,
        reads,
        doing,
        failure: facts.failure.filter(|_| reads == Reads::Failed),
        paused_at_ms: facts.paused_at_ms,
        uses: facts.uses,
        spend: facts.spend,
        network: facts.network,
        next_wake: facts.next_wake,
        workers: facts.workers,
        development: facts.development,
        actions,
    }
}

#[cfg(test)]
mod tests;
