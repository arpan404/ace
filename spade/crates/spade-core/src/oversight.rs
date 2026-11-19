//! What a bot spent, shown as information (ADR 0135; ADR 0166 removed every spending limit): the
//! person's day and month, and money in words. Pure: the clock and the zone come in as arguments.

use jiff::tz::TimeZone;
use jiff::{Timestamp, ToSpan, Zoned};

/// The day and month containing an instant, in the person's zone, as epoch milliseconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Periods {
    pub day_start: i64,
    pub next_day: i64,
    pub month_start: i64,
    pub next_month: i64,
}

/// What a bot spent in the current day and month.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Spent {
    pub today_micros: u64,
    pub month_micros: u64,
}

/// The day and month around `now_ms` in `zone`. A day that a clock change makes 23 or 25 hours
/// long is still one day.
pub fn periods(now_ms: i64, zone: &TimeZone) -> Periods {
    let fallback = || {
        let day = crate::spending::day_start_ms(now_ms, 0);
        Periods {
            day_start: day,
            next_day: day + 86_400_000,
            month_start: day,
            next_month: day + 86_400_000,
        }
    };
    let Ok(at) = Timestamp::from_millisecond(now_ms) else {
        return fallback();
    };
    let now = at.to_zoned(zone.clone());
    let found = (|| -> Result<Periods, jiff::Error> {
        let day: Zoned = now.start_of_day()?;
        let next_day = day.date().tomorrow()?.to_zoned(zone.clone())?;
        let month = now.first_of_month()?.start_of_day()?;
        let next_month = month
            .date()
            .checked_add(1.month())?
            .to_zoned(zone.clone())?;
        Ok(Periods {
            day_start: day.timestamp().as_millisecond(),
            next_day: next_day.timestamp().as_millisecond(),
            month_start: month.timestamp().as_millisecond(),
            next_month: next_month.timestamp().as_millisecond(),
        })
    })();
    found.unwrap_or_else(|_| fallback())
}

/// Micros as dollars: cents from one cent up (`$1.20`), else up to four places (`$0.004`).
pub fn dollars(micros: u64) -> String {
    if micros >= 10_000 || micros == 0 {
        let cents = (micros + 5_000) / 10_000;
        format!("${}.{:02}", cents / 100, cents % 100)
    } else {
        let tenths_of_cents = micros.div_ceil(100);
        let text = format!("{:.4}", tenths_of_cents as f64 / 10_000.0);
        format!("${}", text.trim_end_matches('0'))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chicago() -> TimeZone {
        TimeZone::get("America/Chicago").unwrap_or(TimeZone::UTC)
    }

    #[test]
    fn the_persons_day_starts_at_their_midnight_not_utcs() {
        // 2026-11-09T03:00:00Z is 21:00 on the 8th in Chicago.
        let now = 1_794_193_200_000;
        let p = periods(now, &chicago());
        assert_eq!(p.day_start, 1_794_117_600_000); // 2026-11-08T06:00:00Z
        assert_eq!(p.next_day, 1_794_204_000_000); // 2026-11-09T06:00:00Z
        assert_eq!(p.month_start, 1_793_509_200_000); // 2026-11-01T05:00:00Z (still CDT)
        assert_eq!(p.next_month, 1_796_104_800_000); // 2026-12-01T06:00:00Z
    }

    #[test]
    fn money_reads_in_dollars() {
        assert_eq!(dollars(1_000_000), "$1.00");
        assert_eq!(dollars(1_234_567), "$1.23");
        assert_eq!(dollars(0), "$0.00");
        assert_eq!(dollars(4_000), "$0.004");
        assert_eq!(dollars(250), "$0.0003");
    }
}
