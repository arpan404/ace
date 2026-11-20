//! How the person wants Spade to reach them (ADR 0194): notifications on or off, do not disturb,
//! a daily quiet window, the interruption budget, the morning brief (ADR 0165's amendment) and
//! spend alerts (ADR 0166's amendment). Stored as JSON; every field has a default, so a setting
//! an older build stored reads.

use serde::{Deserialize, Serialize};

/// The most interruptions a budget may allow in its period.
pub const MOST_BUDGET: u32 = 1_000;
/// The highest spend floor an alert may have: $1,000 an hour.
pub const MOST_FLOOR_MICROS: u64 = 1_000_000_000;
/// The most bots a brief may name.
pub const MOST_BRIEF_BOTS: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Settings {
    /// Spade notifies at all. Off, nothing reaches the person outside Spade's page.
    #[serde(default = "on")]
    pub notify: bool,
    /// Do not disturb, now: proactive notices wait until it is turned off.
    #[serde(default)]
    pub dnd: bool,
    /// A daily quiet window in the person's zone; proactive notices wait through it.
    #[serde(default)]
    pub quiet: Option<Window>,
    #[serde(default)]
    pub budget: Budget,
    #[serde(default)]
    pub brief: Brief,
    #[serde(default)]
    pub spend: SpendAlerts,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            notify: true,
            dnd: false,
            quiet: None,
            budget: Budget::default(),
            brief: Brief::default(),
            spend: SpendAlerts::default(),
        }
    }
}

/// Minutes after local midnight; `from > to` wraps past midnight.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Window {
    pub from: u16,
    pub to: u16,
}

impl Window {
    /// Whether `minute` (after local midnight) falls inside the window.
    pub fn holds(self, minute: u16) -> bool {
        if self.from < self.to {
            minute >= self.from && minute < self.to
        } else {
            minute >= self.from || minute < self.to
        }
    }
}

/// At most this many proactive interruptions in the last hour and the last day; `None` sets no
/// bound. What goes past it waits for the next digest or brief.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Budget {
    #[serde(default = "per_hour")]
    pub per_hour: Option<u32>,
    #[serde(default = "per_day")]
    pub per_day: Option<u32>,
}

impl Default for Budget {
    fn default() -> Self {
        Self {
            per_hour: per_hour(),
            per_day: per_day(),
        }
    }
}

/// The morning brief: opt-in, once a day at `at` in the person's zone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Brief {
    #[serde(default)]
    pub on: bool,
    /// Minutes after local midnight.
    #[serde(default = "eight")]
    pub at: u16,
    /// The bots and clubs it covers, by id; `None` covers every bot that isn't a worker.
    #[serde(default)]
    pub bots: Option<Vec<String>>,
    /// Rewrite the plain text once with the fast (`title`) role's model.
    #[serde(default)]
    pub polish: bool,
}

impl Default for Brief {
    fn default() -> Self {
        Self {
            on: false,
            at: eight(),
            bots: None,
            polish: false,
        }
    }
}

/// An alert when a bot spends unusually fast: the last hour above `factor` times its trailing
/// hourly median and above `floor_micros`. Information only (ADR 0166): nothing stops.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpendAlerts {
    #[serde(default = "on")]
    pub on: bool,
    #[serde(default = "five")]
    pub factor: u32,
    #[serde(default = "dollar")]
    pub floor_micros: u64,
}

impl Default for SpendAlerts {
    fn default() -> Self {
        Self {
            on: true,
            factor: five(),
            floor_micros: dollar(),
        }
    }
}

/// One bot's own choice; `None` follows the global switch.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentReach {
    #[serde(default)]
    pub notify: Option<bool>,
}

fn on() -> bool {
    true
}
fn per_hour() -> Option<u32> {
    Some(6)
}
fn per_day() -> Option<u32> {
    Some(30)
}
fn eight() -> u16 {
    8 * 60
}
fn five() -> u32 {
    5
}
fn dollar() -> u64 {
    1_000_000
}

/// Why a setting can't be saved, in words the app shows.
pub fn check(settings: &Settings) -> Result<(), String> {
    if let Some(window) = settings.quiet {
        if window.from >= 1440 || window.to >= 1440 {
            return Err("Quiet hours are minutes of the day, under 1440.".to_owned());
        }
        if window.from == window.to {
            return Err("Quiet hours start and end at the same time.".to_owned());
        }
    }
    for bound in [settings.budget.per_hour, settings.budget.per_day]
        .into_iter()
        .flatten()
    {
        if bound == 0 || bound > MOST_BUDGET {
            return Err(format!(
                "An interruption budget is between 1 and {MOST_BUDGET}."
            ));
        }
    }
    if settings.brief.at >= 1440 {
        return Err("The brief's time is a minute of the day, under 1440.".to_owned());
    }
    if settings
        .brief
        .bots
        .as_ref()
        .is_some_and(|bots| bots.len() > MOST_BRIEF_BOTS)
    {
        return Err(format!("A brief covers at most {MOST_BRIEF_BOTS} bots."));
    }
    if !(2..=100).contains(&settings.spend.factor) {
        return Err("A spend alert's factor is between 2 and 100.".to_owned());
    }
    if settings.spend.floor_micros > MOST_FLOOR_MICROS {
        return Err("A spend alert's floor is at most $1,000 an hour.".to_owned());
    }
    Ok(())
}
