//! Spend alerts (ADR 0166's amendment): information when a bot spends unusually fast, never a
//! limit. A bot's last hour is unusual when it is above the floor and above `factor` times its
//! trailing hourly median. One alert per episode: the episode ends once the last hour is back
//! under half of what counts as unusual, so a rate hovering at the line doesn't alert again.

use super::settings::SpendAlerts;
use crate::oversight::dollars;

/// The trailing hours the median is taken over.
pub const TRAILING_HOURS: usize = 24;

/// The median of `hours` (each one hour's spend), 0 for none.
pub fn median(hours: &[u64]) -> u64 {
    if hours.is_empty() {
        return 0;
    }
    let mut sorted = hours.to_vec();
    sorted.sort_unstable();
    let middle = sorted.len() / 2;
    if sorted.len() % 2 == 1 {
        sorted[middle]
    } else {
        sorted[middle - 1].midpoint(sorted[middle])
    }
}

/// What counts as unusual for a bot whose usual hour is `median`.
pub fn line(rule: SpendAlerts, median: u64) -> u64 {
    rule.floor_micros
        .max(median.saturating_mul(u64::from(rule.factor)))
}

/// What a check of one bot comes to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Check {
    /// Tell the person now.
    pub alert: bool,
    /// The bot is in an unusual episode after this check.
    pub episode: bool,
    pub median: u64,
}

/// Checks a bot's `last_hour` against its `trailing` hours (oldest first), given whether it is
/// already in an episode.
pub fn check(rule: SpendAlerts, last_hour: u64, trailing: &[u64], episode: bool) -> Check {
    let median = median(trailing);
    if !rule.on {
        return Check {
            alert: false,
            episode: false,
            median,
        };
    }
    let unusual_line = line(rule, median);
    let unusual = last_hour > unusual_line;
    let calm = last_hour <= unusual_line / 2;
    Check {
        alert: unusual && !episode,
        episode: unusual || (episode && !calm),
        median,
    }
}

/// The alert's words: "Spent $4.20 in the last hour, about 6× its usual $0.70 an hour."
pub fn alert_text(last_hour: u64, median: u64) -> String {
    let spent = dollars(last_hour);
    if median == 0 {
        return format!("Spent {spent} in the last hour, far above its usual.");
    }
    let times = last_hour / median.max(1);
    format!(
        "Spent {spent} in the last hour, about {times}× its usual {} an hour.",
        dollars(median)
    )
}
