// SPDX-License-Identifier: Apache-2.0
//! The civil calendar and the person's zone, ported from `packages/automations/src/calendar.ts`.
//! Stamps are minute-aligned epoch milliseconds in UTC; a civil value is a wall time with no
//! zone. Zone rules come from jiff's bundled tzdb, while resolution keeps the TypeScript's own
//! algorithm: probe both sides of the transition and pick the earliest instant whose wall time
//! round-trips, so a repeated autumn time runs once (first instant) and a spring gap is skipped.

use jiff::Timestamp;
use jiff::tz::TimeZone;

use crate::error::{AutomationsError, Result};

pub const DAY: i64 = 86_400_000;
pub const MINUTE: i64 = 60_000;

/// A wall time in the schedule's zone, at minute precision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Civil {
    pub year: i32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
}

impl Civil {
    pub fn at_midnight(self) -> Civil {
        Civil {
            hour: 0,
            minute: 0,
            ..self
        }
    }
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let y = i64::from(year) - i64::from(month <= 2);
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (i64::from(month) + 9) % 12;
    let doy = (153 * mp + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    (year as i32, m as u32, d as u32)
}

/// `civilStamp` (`calendar.ts:10`): the UTC millisecond a civil wall time names.
pub fn civil_stamp(c: Civil) -> i64 {
    let days = days_from_civil(c.year, c.month, c.day);
    days * DAY + i64::from(c.hour) * 3_600_000 + i64::from(c.minute) * MINUTE
}

/// `fromStamp` (`calendar.ts:18`).
pub fn from_stamp(stamp: i64) -> Civil {
    let days = stamp.div_euclid(DAY);
    let rem = stamp.rem_euclid(DAY);
    let (year, month, day) = civil_from_days(days);
    Civil {
        year,
        month,
        day,
        hour: (rem / 3_600_000) as u32,
        minute: ((rem % 3_600_000) / MINUTE) as u32,
    }
}

/// `weekday` (`calendar.ts:27`): Sunday is 0, as JavaScript's `getUTCDay`.
pub fn weekday(c: Civil) -> u32 {
    (days_from_civil(c.year, c.month, c.day) + 4).rem_euclid(7) as u32
}

/// `monthDays` (`calendar.ts:30`).
pub fn month_days(year: i32, month: u32) -> u32 {
    let (next_year, next_month) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    let before = days_from_civil(next_year, next_month, 1) - 1;
    civil_from_days(before).2
}

/// `zonedCalendar` (`calendar.ts:32`): local wall time and the earliest instant naming it.
pub struct ZonedCalendar {
    zone: TimeZone,
}

impl ZonedCalendar {
    pub fn new(timezone: &str) -> Result<ZonedCalendar> {
        let zone = TimeZone::get(timezone).map_err(|_| {
            AutomationsError::message(format!("Invalid time zone specified: {timezone}"))
        })?;
        Ok(ZonedCalendar { zone })
    }

    fn local_at(&self, at: i64) -> Result<Civil> {
        let timestamp = Timestamp::from_millisecond(at)
            .map_err(|_| AutomationsError::message("Instant is outside the calendar's range"))?;
        let dt = self.zone.to_datetime(timestamp);
        Ok(Civil {
            year: i32::from(dt.year()),
            month: dt.month() as u32,
            day: dt.day() as u32,
            hour: dt.hour() as u32,
            minute: dt.minute() as u32,
        })
    }

    /// The wall time at `at` in this zone, minute precision.
    pub fn local(&self, at: i64) -> Result<Civil> {
        self.local_at(at)
    }

    /// The earliest instant whose wall time is `c`, or none when the zone skips it.
    /// Probes both sides of transitions, including half-hour changes and date-line jumps.
    pub fn resolve(&self, c: Civil) -> Result<Option<i64>> {
        let stamp = civil_stamp(c);
        let mut offsets: Vec<i64> = Vec::with_capacity(5);
        for shift in [-2 * DAY, -DAY, 0, DAY, 2 * DAY] {
            let probe = stamp + shift;
            let offset = civil_stamp(self.local_at(probe)?) - probe;
            if !offsets.contains(&offset) {
                offsets.push(offset);
            }
        }
        let mut first: Option<i64> = None;
        for offset in offsets {
            let candidate = stamp - offset;
            if civil_stamp(self.local_at(candidate)?) == stamp
                && first.is_none_or(|current| candidate < current)
            {
                first = Some(candidate);
            }
        }
        Ok(first)
    }
}

/// `new Date(ms).toISOString()`: the timestamp a scheduled event names in its variables.
pub fn iso_string(at: i64) -> String {
    let c = from_stamp(at);
    let rem = at.rem_euclid(DAY);
    let second = rem % MINUTE / 1000;
    let millis = rem % 1000;
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        c.year, c.month, c.day, c.hour, c.minute, second, millis
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_stamps_round_trip_and_weekdays_are_sunday_zero() {
        let c = Civil {
            year: 2024,
            month: 3,
            day: 10,
            hour: 9,
            minute: 30,
        };
        assert_eq!(from_stamp(civil_stamp(c)), c);
        assert_eq!(weekday(c), 0);
        assert_eq!(
            civil_stamp(Civil {
                year: 1970,
                month: 1,
                day: 1,
                hour: 0,
                minute: 0
            }),
            0
        );
    }

    #[test]
    fn month_days_handles_leap_and_century_years() {
        assert_eq!(month_days(2024, 2), 29);
        assert_eq!(month_days(2100, 2), 28);
        assert_eq!(month_days(2000, 2), 29);
        assert_eq!(month_days(2024, 12), 31);
    }

    #[test]
    fn iso_string_matches_javascript() {
        assert_eq!(iso_string(1_704_099_600_000), "2024-01-01T09:00:00.000Z");
    }
}
