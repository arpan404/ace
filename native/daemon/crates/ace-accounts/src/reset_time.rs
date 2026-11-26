// SPDX-License-Identifier: Apache-2.0
//! Reading a reset time out of a provider's usage-limit words, from
//! `packages/accounts/src/reset-time.ts`. All times are epoch milliseconds. An ambiguous or
//! missing DST clock time is never guessed: the account stays blocked until a later reading.

use jiff::civil::Date;
use jiff::tz::TimeZone;
use jiff::Timestamp;
use regex::Regex;

/// `Date.parse` for the reset strings providers report (RFC 3339).
pub fn parse_date(value: &str) -> Option<i64> {
    value.parse::<Timestamp>().ok().map(|instant| instant.as_millisecond())
}

fn timestamp(epoch: i64) -> Option<Timestamp> {
    Timestamp::from_millisecond(epoch).ok()
}

fn civil_date(epoch: i64, time_zone: &str) -> Option<Date> {
    Some(timestamp(epoch)?.in_tz(time_zone).ok()?.datetime().date())
}

/// `parseLimitReset`: an explicit ISO instant when the words carry one, else the clock time
/// after "try again at / resets at / until", in the message's own zone or the person's.
pub fn parse_limit_reset_words(message: &str, now: i64, time_zone: &str) -> Option<i64> {
    if let Some(iso) = Regex::new(
        r"(?i)(?:try again|resets?|until).*?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2}))",
    )
    .ok()
    .and_then(|pattern| pattern.captures(message))
    .and_then(|captures| captures.get(1).map(|value| value.as_str().to_string()))
    {
        // A message that names an instant never falls back to its clock words.
        return parse_date(&iso).filter(|instant| *instant > now);
    }
    parse_clock_reset(message, now, time_zone)
}

/// The clock-time branch.
pub fn parse_clock_reset(message: &str, now: i64, time_zone: &str) -> Option<i64> {
    let captures = Regex::new(
        r"(?i)(?:try again at|resets?(?: at)?|until)\s+(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b",
    )
    .ok()?
    .captures(message)?;
    let hour: i64 = captures.get(1)?.as_str().parse().ok()?;
    let minute: i64 = captures
        .get(2)
        .map_or(Some(0), |value| value.as_str().parse().ok())?;
    if !(1..=12).contains(&hour) || minute > 59 {
        return None;
    }
    let pm = captures.get(3)?.as_str().eq_ignore_ascii_case("PM");
    let wanted_hour = (hour % 12) + if pm { 12 } else { 0 };
    let zone = Regex::new(r"\(([A-Za-z_]+/[A-Za-z_/]+)\)")
        .ok()
        .and_then(|pattern| pattern.captures(message))
        .and_then(|captures| captures.get(1).map(|value| value.as_str().to_string()))
        .unwrap_or_else(|| time_zone.to_string());
    let tz = TimeZone::get(&zone).ok()?;
    let mut date = civil_date(now, &zone)?;
    for _ in 0..3 {
        let target = date.at(
            i8::try_from(wanted_hour).ok()?,
            i8::try_from(minute).ok()?,
            0,
            0,
        );
        // A fold has two instants and a gap has none: `unambiguous` refuses both, as the
        // TypeScript's candidate count does, rather than guessing across a DST change.
        if let Ok(zoned) = tz.to_ambiguous_zoned(target).unambiguous() {
            let candidate = zoned.timestamp().as_millisecond();
            if candidate > now {
                return Some(candidate);
            }
        } else {
            return None;
        }
        date = date.tomorrow().ok()?;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(value: &str) -> i64 {
        parse_date(value).expect("a test instant")
    }

    // packages/accounts/src/quota.process.test.ts
    // "limit error clock text resolves in the user's timezone, including midnight"
    #[test]
    fn a_limit_errors_clock_time_resolves_in_the_users_timezone_including_midnight() {
        let now = at("2026-10-02T15:00:00Z");
        assert_eq!(
            parse_limit_reset_words("Usage limit reached. Try again at 11:31 AM", now, "America/Chicago"),
            Some(at("2026-10-02T16:31:00Z"))
        );
        assert_eq!(
            parse_limit_reset_words("Usage limit reached. Try again at 11:31 AM", now, "Asia/Kolkata"),
            Some(at("2026-10-03T06:01:00Z"))
        );
        assert_eq!(
            parse_limit_reset_words("resets 12:01 AM (America/Chicago)", now, "UTC"),
            Some(at("2026-10-03T05:01:00Z"))
        );
    }

    // "ambiguous and nonexistent DST times stay blocked rather than guessing"
    #[test]
    fn ambiguous_and_nonexistent_dst_times_stay_blocked_rather_than_guessing() {
        assert_eq!(
            parse_limit_reset_words(
                "try again at 1:30 AM",
                at("2026-11-01T04:00:00Z"),
                "America/Chicago"
            ),
            None
        );
        assert_eq!(
            parse_limit_reset_words(
                "try again at 2:30 AM",
                at("2026-03-08T06:00:00Z"),
                "America/Chicago"
            ),
            None
        );
        let now = at("2026-10-02T15:00:00Z");
        assert_eq!(parse_limit_reset_words("try again at 25:30 AM", now, "UTC"), None);
        assert_eq!(
            parse_limit_reset_words("try again at 2026-10-02T16:00:00-05:00", now, "UTC"),
            Some(at("2026-10-02T21:00:00Z"))
        );
    }

    #[test]
    fn a_reset_already_passed_or_with_an_unknown_zone_is_never_guessed() {
        let now = at("2026-10-02T15:00:00Z");
        assert_eq!(
            parse_limit_reset_words("try again at 2026-10-02T10:00:00Z", now, "UTC"),
            None
        );
        assert_eq!(parse_limit_reset_words("try again at 11:31 AM", now, "Not/AZone"), None);
        assert_eq!(parse_limit_reset_words("nothing to read", now, "UTC"), None);
    }
}
