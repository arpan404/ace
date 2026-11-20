//! How Spade reaches the person outside its own page (ADR 0195): which notices interrupt now and
//! which wait, through do not disturb, the daily quiet window and the interruption budget, for
//! the next brief or digest. Pure: the engine passes the clock, the person's minute of the day
//! and the interruptions already sent.

pub mod brief;
pub mod notable;
pub mod settings;
pub mod spend;

use serde::{Deserialize, Serialize};

use crate::escalation::Level;
pub use settings::{AgentReach, Approvals, Settings, Window};

const HOUR_MS: i64 = 3_600_000;
const DAY_MS: i64 = 24 * HOUR_MS;
/// The person wrote to the conversation this recently: they are waiting on it.
pub const ENGAGED_MS: i64 = 30 * 60_000;

/// What a notice is about, for the app's words and the person's choices.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    /// A bot needs the person: an approval or a question.
    NeedsYou,
    /// The bot's work stopped until the person acts (`stop`).
    Escalation,
    /// A digest is ready.
    Digest,
    /// A routine or the heartbeat said something.
    Routine,
    /// A long job, a goal or a worker finished or failed.
    Finished,
    /// The morning brief.
    Brief,
    /// A bot spends unusually fast.
    Spend,
    /// What waited through quiet hours or do not disturb, in one.
    Summary,
    /// Only for the digest: a decision, a drafted goal.
    Record,
}

/// How a notice reaches the person.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reach {
    /// Notify now.
    Now,
    /// Held for the next brief or digest (and, after quiet, the summary).
    Held,
    /// Never a notification.
    None,
}

/// Why a notice doesn't reach the person now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Why {
    /// Spade's notifications are off.
    Off,
    /// This bot's notifications are off.
    BotOff,
    Dnd,
    Quiet,
    Budget,
    /// It belongs in the digest only.
    Record,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Decision {
    pub reach: Reach,
    pub why: Option<Why>,
    /// It is sent and counts against the budget.
    pub counts: bool,
}

impl Decision {
    const fn now(counts: bool) -> Self {
        Self {
            reach: Reach::Now,
            why: None,
            counts,
        }
    }
    const fn held(why: Why) -> Self {
        Self {
            reach: Reach::Held,
            why: Some(why),
            counts: false,
        }
    }
    const fn none(why: Why) -> Self {
        Self {
            reach: Reach::None,
            why: Some(why),
            counts: false,
        }
    }
}

/// What one notice's decision reads.
#[derive(Debug, Clone, Copy)]
pub struct Notice {
    pub category: Category,
    pub level: Option<Level>,
    /// The person wrote to its conversation within [`ENGAGED_MS`].
    pub engaged: bool,
    /// The bot's own switch, resolved against the global one; `true` for notices of no bot.
    pub bot_on: bool,
    /// What this bot's approvals and questions do through quiet: its own choice, else the global.
    pub approvals: Approvals,
}

/// The moment a decision is made.
#[derive(Debug, Clone, Copy)]
pub struct Moment<'a> {
    pub now_ms: i64,
    /// Minutes after midnight in the person's zone.
    pub minute: u16,
    /// When each counted interruption was sent, any order.
    pub sent: &'a [i64],
}

/// Whether `notice` interrupts the person now. A `stop` or a `block` (an approval, a question
/// the turn waits on) always gets through do not disturb, quiet hours and the budget, and so
/// does a question for later in a conversation the person is in. The brief comes at the time
/// they chose, and the summary is what quiet held. The rest is proactive. The one exception to
/// "a block gets through" is the person's own: with approvals set to wait, an approval or a
/// question a bot waits on is held through do not disturb and quiet hours (it stays in its chat,
/// and the brief and digests list it under Waiting on you). A stop never waits.
pub fn decide(settings: &Settings, notice: Notice, moment: Moment<'_>) -> Decision {
    if notice.category == Category::Record {
        return Decision::none(Why::Record);
    }
    if !settings.notify {
        return Decision::none(Why::Off);
    }
    if !notice.bot_on {
        return Decision::none(Why::BotOff);
    }
    let asks = notice.category == Category::NeedsYou;
    let waits = asks
        && notice.level == Some(Level::Block)
        && notice.approvals == Approvals::Wait
        && !notice.engaged;
    if waits && let Some(why) = quiet(settings, moment.minute) {
        return Decision::held(why);
    }
    let urgent =
        matches!(notice.level, Some(Level::Stop | Level::Block)) || (asks && notice.engaged);
    if urgent || matches!(notice.category, Category::Brief | Category::Summary) {
        return Decision::now(false);
    }
    if let Some(why) = quiet(settings, moment.minute) {
        return Decision::held(why);
    }
    if over_budget(settings, moment.now_ms, moment.sent) {
        return Decision::held(Why::Budget);
    }
    Decision::now(true)
}

/// Why proactive notices wait right now, if they do.
pub fn quiet(settings: &Settings, minute: u16) -> Option<Why> {
    if settings.dnd {
        return Some(Why::Dnd);
    }
    settings
        .quiet
        .is_some_and(|window| window.holds(minute))
        .then_some(Why::Quiet)
}

/// Whether the budget has no room left for one more.
pub fn over_budget(settings: &Settings, now_ms: i64, sent: &[i64]) -> bool {
    let within = |period: i64| {
        sent.iter()
            .filter(|at| **at > now_ms - period && **at <= now_ms)
            .count()
    };
    let full = |bound: Option<u32>, period: i64| {
        bound.is_some_and(|most| within(period) >= usize::try_from(most).unwrap_or(usize::MAX))
    };
    full(settings.budget.per_hour, HOUR_MS) || full(settings.budget.per_day, DAY_MS)
}

/// The sends still worth keeping: those inside the budget's longest period.
pub fn keep_sent(sent: &mut Vec<i64>, now_ms: i64) {
    sent.retain(|at| *at > now_ms - DAY_MS);
}

/// The one line that tells the person what waited for them, from the held notices' bot names
/// (one per notice, repeats allowed). `None` when nothing waited.
pub fn summary_text(names: &[&str]) -> Option<String> {
    let count = names.len();
    if count == 0 {
        return None;
    }
    let mut bots: Vec<&str> = Vec::new();
    for name in names {
        if !bots.contains(name) {
            bots.push(name);
        }
    }
    let things = if count == 1 { "1 update" } else { "updates" };
    let things = if count == 1 {
        things.to_owned()
    } else {
        format!("{count} {things}")
    };
    let from = match bots.as_slice() {
        [one] => (*one).to_owned(),
        [first, second] => format!("{first} and {second}"),
        [first, rest @ ..] => format!("{first} and {} others", rest.len()),
        [] => return None,
    };
    Some(format!("While you were away: {things} from {from}."))
}

#[cfg(test)]
mod tests;
