//! Per-bot spending caps (ADR 0135): the person's day and month, whether a bot is at a cap, and
//! what it says when it is. Pure: the clock and the zone come in as arguments.

use jiff::tz::TimeZone;
use jiff::{Timestamp, ToSpan, Zoned};

use crate::event::{CapScope, Event, Known};

/// A bot's own caps, in micros. `None` is no cap.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Caps {
    pub daily_micros: Option<u64>,
    pub monthly_micros: Option<u64>,
}

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

/// A cap the bot is at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Hit {
    pub scope: CapScope,
    pub cap_micros: u64,
    pub period_start: i64,
    pub resets_at: i64,
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

/// The cap the bot is at, if any. When both hold, the monthly one, since it lasts longer.
pub fn hit(caps: Caps, spent: Spent, periods: Periods) -> Option<Hit> {
    let monthly = caps
        .monthly_micros
        .filter(|cap| spent.month_micros >= *cap)
        .map(|cap| Hit {
            scope: CapScope::Monthly,
            cap_micros: cap,
            period_start: periods.month_start,
            resets_at: periods.next_month,
        });
    let daily = caps
        .daily_micros
        .filter(|cap| spent.today_micros >= *cap)
        .map(|cap| Hit {
            scope: CapScope::Daily,
            cap_micros: cap,
            period_start: periods.day_start,
            resets_at: periods.next_day,
        });
    monthly.or(daily)
}

/// Whether the conversation already said it reached this cap in this period.
pub fn said(events: &[Event], hit: &Hit) -> bool {
    events.iter().any(|event| {
        matches!(event, Event::Known(Known::CapReached { scope, period_start, .. })
            if *scope == hit.scope && *period_start == hit.period_start)
    })
}

/// The event that says it, once.
pub fn reached(hit: &Hit) -> Event {
    Event::Known(Known::CapReached {
        scope: hit.scope,
        cap_micros: hit.cap_micros,
        period_start: hit.period_start,
        resets_at: hit.resets_at,
    })
}

/// Why `name` starts nothing: "Research is at its daily cap of $1.00 until midnight."
pub fn refusal(name: &str, hit: &Hit) -> String {
    let (which, until) = match hit.scope {
        CapScope::Daily => ("daily", "midnight"),
        CapScope::Monthly => ("monthly", "the start of next month"),
    };
    format!(
        "{name} is at its {which} cap of {} until {until}.",
        dollars(hit.cap_micros)
    )
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
    fn a_bot_is_at_the_cap_it_reached_and_the_monthly_one_wins() {
        let p = periods(1_794_193_200_000, &TimeZone::UTC);
        let caps = Caps {
            daily_micros: Some(1_000_000),
            monthly_micros: Some(5_000_000),
        };
        let under = Spent {
            today_micros: 999_999,
            month_micros: 4_000_000,
        };
        assert_eq!(hit(caps, under, p), None);
        let day = hit(
            caps,
            Spent {
                today_micros: 1_000_000,
                ..under
            },
            p,
        );
        assert_eq!(
            day.map(|h| (h.scope, h.resets_at)),
            Some((CapScope::Daily, p.next_day))
        );
        let both = hit(
            caps,
            Spent {
                today_micros: 2_000_000,
                month_micros: 5_000_000,
            },
            p,
        );
        assert_eq!(both.map(|h| h.scope), Some(CapScope::Monthly));
        assert_eq!(
            hit(Caps::default(), both_spent(), p),
            None,
            "no caps, no hit"
        );
    }

    fn both_spent() -> Spent {
        Spent {
            today_micros: u64::MAX,
            month_micros: u64::MAX,
        }
    }

    #[test]
    fn a_cap_is_said_once_per_period() {
        let p = periods(1_794_193_200_000, &TimeZone::UTC);
        let caps = Caps {
            daily_micros: Some(0),
            monthly_micros: None,
        };
        let Some(today) = hit(caps, Spent::default(), p) else {
            panic!("a zero cap holds at once");
        };
        let mut events = vec![Event::user_message("hi")];
        assert!(!said(&events, &today));
        events.push(reached(&today));
        assert!(said(&events, &today));
        let tomorrow = hit(caps, Spent::default(), periods(p.next_day, &TimeZone::UTC));
        assert!(tomorrow.is_some_and(|t| !said(&events, &t)));
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
