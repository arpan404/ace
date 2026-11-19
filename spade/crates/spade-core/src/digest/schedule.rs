//! When digests are made (ADR 0165): every day by default, set by the person globally and per
//! bot. A worker gets digests of its own only when the person set `every` on it; otherwise it is
//! part of its root's.

use serde::{Deserialize, Serialize};

const HOUR_MS: i64 = 3_600_000;
/// The default period: a day.
pub const DEFAULT_EVERY: &str = "1d";
const SHORTEST_MS: i64 = HOUR_MS;
const LONGEST_MS: i64 = 30 * 24 * HOUR_MS;

/// One scope's settings as stored and as the API takes them: `None` inherits.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Settings {
    /// A duration from `1h` to `30d`, or `off`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub every: Option<String>,
    /// Rewrite the text with the cheap role's model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub polish: Option<bool>,
}

/// What applies to one bot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Schedule {
    /// `None`: no scheduled digests.
    pub every_ms: Option<i64>,
    pub polish: bool,
}

/// Reads `every`: `off`, or a duration such as `12h` or `1d` between an hour and 30 days.
pub fn parse_every(every: &str) -> Result<Option<i64>, String> {
    let every = every.trim();
    if every.eq_ignore_ascii_case("off") {
        return Ok(None);
    }
    let ms = crate::wake::parse_after(&serde_json::Value::String(every.to_owned()))
        .map_err(|why| format!("every: {why}"))?;
    if !(SHORTEST_MS..=LONGEST_MS).contains(&ms) {
        return Err("every is between 1h and 30d, or off".to_owned());
    }
    Ok(Some(ms))
}

/// Checks settings the person sends.
pub fn check(settings: &Settings) -> Result<(), String> {
    match &settings.every {
        Some(every) => parse_every(every).map(|_| ()),
        None => Ok(()),
    }
}

/// The schedule of a bot from the global settings and its own. A worker inherits nothing for
/// `every`: its digest is part of its root's unless the person set one on it.
pub fn resolve(global: &Settings, bot: &Settings, worker: bool) -> Schedule {
    let read = |s: &Settings| s.every.as_deref().and_then(|e| parse_every(e).ok());
    let every_ms = match (&bot.every, worker) {
        (Some(_), _) => read(bot).flatten(),
        (None, true) => None,
        (None, false) => match &global.every {
            Some(_) => read(global).flatten(),
            None => parse_every(DEFAULT_EVERY).ok().flatten(),
        },
    };
    Schedule {
        every_ms,
        polish: bot.polish.or(global.polish).unwrap_or(false),
    }
}

/// When the next digest is due: `every` after the last one ended, or after the bot was made.
pub fn due_at(schedule: Schedule, since_ms: i64) -> Option<i64> {
    schedule
        .every_ms
        .map(|every| since_ms.saturating_add(every))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn every(e: &str) -> Settings {
        Settings {
            every: Some(e.to_owned()),
            polish: None,
        }
    }

    #[test]
    fn every_reads_durations_between_an_hour_and_thirty_days_or_off() {
        assert_eq!(parse_every("1d"), Ok(Some(24 * HOUR_MS)));
        assert_eq!(parse_every("12h"), Ok(Some(12 * HOUR_MS)));
        assert_eq!(parse_every(" OFF "), Ok(None));
        assert!(parse_every("30m").is_err());
        assert!(parse_every("31d").is_err());
        assert!(parse_every("soon").is_err());
    }

    #[test]
    fn a_bot_inherits_the_global_schedule_and_a_worker_only_its_own() {
        let none = Settings::default();
        let day = Some(24 * HOUR_MS);
        assert_eq!(resolve(&none, &none, false).every_ms, day);
        assert_eq!(
            resolve(&every("12h"), &none, false).every_ms,
            Some(12 * HOUR_MS)
        );
        assert_eq!(resolve(&every("12h"), &every("off"), false).every_ms, None);
        assert_eq!(
            resolve(&every("off"), &every("2d"), false).every_ms,
            Some(48 * HOUR_MS)
        );
        assert_eq!(resolve(&none, &none, true).every_ms, None);
        assert_eq!(resolve(&every("12h"), &every("1d"), true).every_ms, day);
    }

    #[test]
    fn polish_is_off_unless_set_and_a_bot_overrides_the_global() {
        let on = Settings {
            every: None,
            polish: Some(true),
        };
        let off = Settings {
            every: None,
            polish: Some(false),
        };
        assert!(!resolve(&Settings::default(), &Settings::default(), false).polish);
        assert!(resolve(&on, &Settings::default(), false).polish);
        assert!(!resolve(&on, &off, false).polish);
    }

    #[test]
    fn the_next_digest_is_due_a_period_after_the_last_one_ended() {
        let daily = resolve(&Settings::default(), &Settings::default(), false);
        assert_eq!(due_at(daily, 1_000), Some(1_000 + 24 * HOUR_MS));
        let off = resolve(&every("off"), &Settings::default(), false);
        assert_eq!(due_at(off, 1_000), None);
    }
}
