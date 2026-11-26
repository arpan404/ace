// SPDX-License-Identifier: Apache-2.0
//! Why an account can't take work, in words an agent can pass on to the person, from
//! `packages/accounts/src/refusal-words.ts`. Pure: callers pass the clock and time zone.

use jiff::Timestamp;

use crate::scheduler::AccountRefusal;

const DAY: i64 = 86_400_000;

/// "4:10 PM CDT", or "Mon, Nov 2, 4:10 PM CST" when it is a day or more away.
pub fn reset_clock(at: i64, now: i64, time_zone: &str) -> String {
    let pattern = if at - now >= DAY {
        "%a, %b %-d, %-I:%M %p %Z"
    } else {
        "%-I:%M %p %Z"
    };
    let zoned = Timestamp::from_millisecond(at)
        .ok()
        .and_then(|instant| instant.in_tz(time_zone).ok())
        .or_else(|| {
            Timestamp::from_millisecond(at)
                .ok()
                .and_then(|instant| instant.in_tz("UTC").ok())
        });
    match zoned {
        Some(zoned) => zoned.strftime(pattern).to_string(),
        None => String::new(),
    }
}

/// One sentence saying why `name` ("Codex account 346") can't take work.
pub fn refusal_words(name: &str, refusal: AccountRefusal, now: i64, time_zone: &str) -> String {
    match refusal {
        AccountRefusal::AtLimit { until: None } => {
            format!("{name} is at its limit; the provider didn't say when it resets")
        }
        AccountRefusal::AtLimit {
            until: Some(until),
        } => format!(
            "{name} is at its limit until {}",
            reset_clock(until, now, time_zone)
        ),
        AccountRefusal::SignedOut => {
            format!("{name} is signed out; the person signs it in again in Settings")
        }
        AccountRefusal::HomeUnavailable => {
            format!("{name} can't be used: its home folder is missing or unreadable")
        }
        AccountRefusal::SignInUnconfirmed => {
            format!("{name} hasn't confirmed it is signed in yet")
        }
        AccountRefusal::OtherProvider => format!("{name} belongs to another provider"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reset_time::parse_date;

    fn at(value: &str) -> i64 {
        parse_date(value).expect("a test instant")
    }

    // packages/accounts/src/scheduler.test.ts
    // "a named account at its limit is refused, saying until when"
    #[test]
    fn a_limit_that_resets_soon_reads_as_a_clock_time_in_the_zone() {
        let now = at("2026-11-01T20:00:00Z");
        assert_eq!(
            refusal_words(
                "Codex account 346",
                AccountRefusal::AtLimit {
                    until: Some(now + 3_600_000)
                },
                now,
                "UTC"
            ),
            "Codex account 346 is at its limit until 9:00 PM UTC"
        );
    }

    #[test]
    fn a_reset_a_day_or_more_away_also_names_the_day() {
        let now = at("2026-10-30T20:00:00Z");
        assert_eq!(
            reset_clock(at("2026-11-02T22:10:00Z"), now, "America/Chicago"),
            "Mon, Nov 2, 4:10 PM CST"
        );
        assert_eq!(
            reset_clock(at("2026-10-02T21:10:00Z"), at("2026-10-02T20:00:00Z"), "America/Chicago"),
            "4:10 PM CDT"
        );
    }

    #[test]
    fn every_refusal_has_its_own_sentence_and_a_missing_reset_says_so() {
        let now = at("2026-11-01T20:00:00Z");
        assert_eq!(
            refusal_words("Claude account", AccountRefusal::AtLimit { until: None }, now, "UTC"),
            "Claude account is at its limit; the provider didn't say when it resets"
        );
        assert_eq!(
            refusal_words("Codex account", AccountRefusal::SignedOut, now, "UTC"),
            "Codex account is signed out; the person signs it in again in Settings"
        );
        assert_eq!(
            refusal_words("Codex account", AccountRefusal::HomeUnavailable, now, "UTC"),
            "Codex account can't be used: its home folder is missing or unreadable"
        );
        assert_eq!(
            refusal_words("Codex account", AccountRefusal::SignInUnconfirmed, now, "UTC"),
            "Codex account hasn't confirmed it is signed in yet"
        );
        assert_eq!(
            refusal_words("Codex account", AccountRefusal::OtherProvider, now, "UTC"),
            "Codex account belongs to another provider"
        );
    }

    #[test]
    fn an_unknown_zone_falls_back_to_utc_as_the_typescripts_intl_catch_does() {
        let now = at("2026-11-01T20:00:00Z");
        assert_eq!(reset_clock(now + 3_600_000, now, "Not/AZone"), "9:00 PM UTC");
    }
}
