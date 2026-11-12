//! When a scheduled routine runs (ADR 0129): a short phrase (`weekdays at 9:00`, `every 2 hours`)
//! or a five-field cron expression, evaluated in an IANA time zone. Calendar times follow the
//! zone's rules: a time a spring-forward skips runs at the first instant after the gap, and a time
//! an autumn change repeats runs once, at its first instant. Intervals count real time.

use jiff::civil::Date;
use jiff::tz::TimeZone;
use jiff::{Timestamp, Zoned};

/// Days searched for the next calendar slot before giving up: enough for any rule that matches
/// at all (29 February needs up to eight years).
const SEARCH_DAYS: u32 = 366 * 8 + 2;
/// The longest interval, in minutes: four weeks.
const LONGEST_INTERVAL: u32 = 28 * 24 * 60;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Schedule {
    rule: Rule,
    /// The text it was read from, trimmed, for cron expressions shown as written.
    text: String,
    cron: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Rule {
    /// Every `minutes` of real time, counted from the Unix epoch, so slots never drift.
    Every {
        minutes: u32,
    },
    Calendar(Calendar),
}

/// Cron's fields as sets. Day of month and day of week follow cron's rule: when both are
/// restricted, either matching is enough.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Calendar {
    minutes: u64,
    hours: u32,
    days: u32,
    months: u16,
    /// Bit 0 is Sunday.
    weekdays: u8,
    days_restricted: bool,
    weekdays_restricted: bool,
}

const ALL_DAYS: u32 = 0xFFFF_FFFE;
const ALL_MONTHS: u16 = 0x1FFE;
const ALL_WEEKDAYS: u8 = 0x7F;
const WEEKDAYS: u8 = 0b0011_1110;
const WEEKENDS: u8 = 0b0100_0001;
const DAY_NAMES: [&str; 7] = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
];
const DAY_WORDS: [&str; 7] = [
    "Sundays",
    "Mondays",
    "Tuesdays",
    "Wednesdays",
    "Thursdays",
    "Fridays",
    "Saturdays",
];

impl Schedule {
    /// Reads a phrase or a cron expression. The error is one line for the person or the model.
    pub fn parse(text: &str) -> Result<Self, String> {
        let text = text.trim();
        if text.is_empty() {
            return Err("The schedule is empty.".to_owned());
        }
        if text.chars().count() > 200 {
            return Err("The schedule is too long.".to_owned());
        }
        let fields: Vec<&str> = text.split_whitespace().collect();
        let cron_like = fields.len() == 5
            && fields
                .iter()
                .all(|f| f.chars().all(|c| c.is_ascii_digit() || "*,/-".contains(c)));
        let rule = if cron_like {
            Rule::Calendar(cron(&fields)?)
        } else {
            phrase(&text.to_ascii_lowercase())?
        };
        Ok(Self {
            rule,
            text: text.to_owned(),
            cron: cron_like,
        })
    }

    /// The schedule as written.
    pub fn text(&self) -> &str {
        &self.text
    }

    /// The first slot strictly after `after` (milliseconds since the epoch), or `None` when the
    /// rule never matches again (a 30 February).
    pub fn next_after(&self, after_ms: i64, zone: &TimeZone) -> Option<i64> {
        match &self.rule {
            Rule::Every { minutes } => {
                let step = i64::from(*minutes) * 60_000;
                Some((after_ms.div_euclid(step) + 1) * step)
            }
            Rule::Calendar(calendar) => calendar.next_after(after_ms, zone),
        }
    }

    /// The schedule in a few words, for the routine list: `Weekdays at 9:00`.
    pub fn words(&self) -> String {
        match &self.rule {
            Rule::Every { minutes } => every_words(*minutes),
            Rule::Calendar(calendar) => calendar
                .words()
                .unwrap_or_else(|| format!("Cron {}", self.text)),
        }
    }

    /// Whether this was written as a cron expression.
    pub fn is_cron(&self) -> bool {
        self.cron
    }
}

/// An interval schedule of `minutes`, as a heartbeat uses.
pub fn every(minutes: u32) -> Result<Schedule, String> {
    Schedule::parse(&format!("every {minutes} minutes"))
}

fn every_words(minutes: u32) -> String {
    match minutes {
        1 => "Every minute".to_owned(),
        60 => "Every hour".to_owned(),
        1440 => "Every 24 hours".to_owned(),
        m if m % 60 == 0 => format!("Every {} hours", m / 60),
        m => format!("Every {m} minutes"),
    }
}

impl Calendar {
    fn matches_day(&self, date: Date) -> bool {
        if self.months & (1 << date.month()) == 0 {
            return false;
        }
        let day = self.days & (1 << date.day()) != 0;
        let weekday = self.weekdays & (1 << date.weekday().to_sunday_zero_offset()) != 0;
        match (self.days_restricted, self.weekdays_restricted) {
            (true, true) => day || weekday,
            (true, false) => day,
            (false, true) => weekday,
            (false, false) => true,
        }
    }

    fn next_after(&self, after_ms: i64, zone: &TimeZone) -> Option<i64> {
        let after = Timestamp::from_millisecond(after_ms).ok()?;
        // A day earlier than `after`'s local date, so a slot a gap pushed past midnight is seen.
        let mut date = after.to_zoned(zone.clone()).date().yesterday().ok()?;
        for _ in 0..SEARCH_DAYS {
            if self.matches_day(date)
                && let Some(found) = self.first_on(date, after_ms, zone)
            {
                return Some(found);
            }
            date = date.tomorrow().ok()?;
        }
        None
    }

    /// The earliest slot on local `date` after `after_ms`. A time a gap skips runs at the gap's
    /// end, which can come before an earlier-listed time's instant, so the minimum is taken over
    /// all of them rather than the first in wall-clock order.
    fn first_on(&self, date: Date, after_ms: i64, zone: &TimeZone) -> Option<i64> {
        let mut best: Option<i64> = None;
        for hour in (0..24).filter(|h| self.hours & (1 << h) != 0) {
            for minute in (0..60).filter(|m| self.minutes & (1 << m) != 0) {
                let Some(at) = instant(date.at(hour, minute, 0, 0), zone) else {
                    continue;
                };
                if at > after_ms && best.is_none_or(|b| at < b) {
                    best = Some(at);
                }
            }
        }
        best
    }

    /// Words for the simple shapes phrases make: a few times on every day, weekdays, weekends
    /// or named days. Anything else is `None`.
    fn words(&self) -> Option<String> {
        if self.days_restricted || self.months != ALL_MONTHS {
            return None;
        }
        let mut times = Vec::new();
        for hour in (0..24).filter(|h| self.hours & (1 << h) != 0) {
            for minute in (0..60).filter(|m| self.minutes & (1 << m) != 0) {
                times.push(format!("{hour}:{minute:02}"));
            }
        }
        if times.is_empty() || times.len() > 4 {
            return None;
        }
        let days = match self.weekdays {
            ALL_WEEKDAYS => "Every day".to_owned(),
            WEEKDAYS => "Weekdays".to_owned(),
            WEEKENDS => "Weekends".to_owned(),
            set => list(
                (0..7)
                    .filter(|d| set & (1 << d) != 0)
                    .map(|d| DAY_WORDS[d].to_owned())
                    .collect(),
            ),
        };
        Some(format!("{days} at {}", list(times)))
    }
}

/// The instant of local time `at` in `zone`. A time a spring-forward skips is the first instant
/// after the gap (2:30 on a day that jumps from 2:00 to 3:00 runs at 3:00); a time an autumn
/// change repeats is its first instant.
fn instant(at: jiff::civil::DateTime, zone: &TimeZone) -> Option<i64> {
    use jiff::tz::AmbiguousOffset;
    let timestamp = match zone.to_ambiguous_timestamp(at).offset() {
        AmbiguousOffset::Unambiguous { offset } => offset.to_timestamp(at).ok()?,
        AmbiguousOffset::Fold { before, .. } => before.to_timestamp(at).ok()?,
        AmbiguousOffset::Gap { after, .. } => {
            // Read with the later offset, the time falls before the gap; the gap ends at the
            // next transition.
            let early = after.to_timestamp(at).ok()?;
            zone.following(early).next()?.timestamp()
        }
    };
    Some(timestamp.as_millisecond())
}

/// `a`, `a and b`, `a, b and c`.
fn list(items: Vec<String>) -> String {
    match items.as_slice() {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// `every 30 minutes`, `daily at 9:00`, `weekdays at 9am`, `mondays and fridays at 18:30`,
/// `at 7:00 and 19:00`. Lower case.
fn phrase(text: &str) -> Result<Rule, String> {
    let words: Vec<&str> = text
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter(|w| !w.is_empty())
        .collect();
    if let Some(rule) = interval(&words)? {
        return Ok(rule);
    }
    let at = words.iter().position(|w| *w == "at").ok_or_else(|| {
        format!(
            "Could not read the schedule {text:?}. Try \"daily at 9:00\", \"weekdays at 9:00\", \
             \"mondays at 8:30\", \"every 2 hours\" or a cron expression like \"0 9 * * 1-5\"."
        )
    })?;
    let weekdays = days(&words[..at])?;
    let mut minutes = 0u64;
    let mut hours = 0u32;
    let mut times = 0;
    for word in words[at + 1..].iter().filter(|w| **w != "and") {
        let (hour, minute) = time(word)?;
        // Each time is its own (hour, minute) pair; distinct minutes across hours would cross,
        // so several times must share their minute or their hour.
        hours |= 1 << hour;
        minutes |= 1 << minute;
        times += 1;
    }
    if times == 0 {
        return Err("Say what time, like \"at 9:00\".".to_owned());
    }
    if hours.count_ones() > 1 && minutes.count_ones() > 1 {
        return Err(
            "Times at different minutes of different hours need one routine each, or a cron \
             expression."
                .to_owned(),
        );
    }
    Ok(Rule::Calendar(Calendar {
        minutes,
        hours,
        days: ALL_DAYS,
        months: ALL_MONTHS,
        weekdays,
        days_restricted: false,
        weekdays_restricted: weekdays != ALL_WEEKDAYS,
    }))
}

fn interval(words: &[&str]) -> Result<Option<Rule>, String> {
    let (count, unit) = match words {
        ["every", unit] => (1, *unit),
        ["every", count, unit] => (
            count
                .parse::<u32>()
                .map_err(|_| format!("{count:?} is not a number."))?,
            *unit,
        ),
        _ => return Ok(None),
    };
    let minutes = match unit.trim_end_matches('s') {
        "minute" | "min" => count,
        "hour" | "hr" => count.saturating_mul(60),
        _ => return Ok(None),
    };
    if minutes == 0 || minutes > LONGEST_INTERVAL {
        return Err("An interval must be between one minute and four weeks.".to_owned());
    }
    Ok(Some(Rule::Every { minutes }))
}

/// The day words before `at`: none, `daily`, `every day`, `weekdays`, `weekends` or day names.
fn days(words: &[&str]) -> Result<u8, String> {
    let mut set = 0u8;
    for word in words {
        let word = word.trim_end_matches('s');
        match word {
            "every" | "and" | "on" => {}
            "daily" | "day" => set |= ALL_WEEKDAYS,
            "weekday" => set |= WEEKDAYS,
            "weekend" => set |= WEEKENDS,
            _ => {
                let day = DAY_NAMES
                    .iter()
                    .position(|name| word.len() >= 3 && name.starts_with(word))
                    .ok_or_else(|| format!("{word:?} is not a day."))?;
                set |= 1 << day;
            }
        }
    }
    Ok(if set == 0 { ALL_WEEKDAYS } else { set })
}

/// `9`, `9:30`, `09:30`, `9am`, `9:30pm`, `noon`, `midnight`.
fn time(word: &str) -> Result<(u32, u32), String> {
    let bad = || format!("{word:?} is not a time; write it like 9:00 or 9:30pm.");
    match word {
        "noon" => return Ok((12, 0)),
        "midnight" => return Ok((0, 0)),
        _ => {}
    }
    let (clock, half) = if let Some(clock) = word.strip_suffix("am") {
        (clock, Some(false))
    } else if let Some(clock) = word.strip_suffix("pm") {
        (clock, Some(true))
    } else {
        (word, None)
    };
    let (hour, minute) = match clock.split_once(':') {
        Some((h, m)) if m.len() == 2 => (h, m),
        Some(_) => return Err(bad()),
        None => (clock, "0"),
    };
    let mut hour: u32 = hour.parse().map_err(|_| bad())?;
    let minute: u32 = minute.parse().map_err(|_| bad())?;
    if minute > 59 {
        return Err(bad());
    }
    match half {
        Some(pm) => {
            if !(1..=12).contains(&hour) {
                return Err(bad());
            }
            hour = match (hour, pm) {
                (12, false) => 0,
                (12, true) => 12,
                (h, true) => h + 12,
                (h, false) => h,
            };
        }
        None if hour > 23 => return Err(bad()),
        None => {}
    }
    Ok((hour, minute))
}

/// Five numeric cron fields: lists, ranges and steps; Sunday is 0 or 7. No names or macros.
fn cron(fields: &[&str]) -> Result<Calendar, String> {
    let [minute, hour, day, month, weekday] = fields else {
        return Err("A cron expression has five fields.".to_owned());
    };
    let minutes = field(minute, 0, 59, "minute")?;
    let hours = field(hour, 0, 23, "hour")?;
    let days = field(day, 1, 31, "day of month")?;
    let months = field(month, 1, 12, "month")?;
    let mut weekdays = field(weekday, 0, 7, "day of week")?;
    if weekdays & (1 << 7) != 0 {
        weekdays = (weekdays | 1) & 0x7F;
    }
    Ok(Calendar {
        minutes,
        hours: u32::try_from(hours).map_err(|_| "bad hour".to_owned())?,
        days: u32::try_from(days).map_err(|_| "bad day".to_owned())?,
        months: u16::try_from(months).map_err(|_| "bad month".to_owned())?,
        weekdays: u8::try_from(weekdays & 0x7F).map_err(|_| "bad weekday".to_owned())?,
        days_restricted: !day.starts_with('*'),
        weekdays_restricted: !weekday.starts_with('*'),
    })
}

fn field(text: &str, low: u32, high: u32, name: &str) -> Result<u64, String> {
    let bad = || format!("The cron {name} field {text:?} is not valid.");
    let mut set = 0u64;
    for part in text.split(',') {
        let (range, step) = match part.split_once('/') {
            Some((range, step)) => (range, step.parse::<u32>().map_err(|_| bad())?),
            None => (part, 1),
        };
        // A step runs from 1 to the field's span; anything wider matches once at most and is a
        // mistake, and a huge one would overflow.
        if step == 0 || step > high - low {
            return Err(bad());
        }
        let (from, to) = if range == "*" {
            (low, high)
        } else if let Some((a, b)) = range.split_once('-') {
            (
                a.parse::<u32>().map_err(|_| bad())?,
                b.parse::<u32>().map_err(|_| bad())?,
            )
        } else {
            let at = range.parse::<u32>().map_err(|_| bad())?;
            // `5/15` means from 5 to the end, every 15.
            (at, if part.contains('/') { high } else { at })
        };
        if from < low || to > high || from > to {
            return Err(bad());
        }
        let mut value = from;
        while value <= to {
            set |= 1 << value;
            let Some(next) = value.checked_add(step) else {
                break;
            };
            value = next;
        }
    }
    Ok(set)
}

/// The local time of `at_ms` in `zone` as `9:05`, with the weekday when it is not on the same
/// local day as `now_ms` (`Tue 9:05`).
pub fn clock_label(at_ms: i64, now_ms: i64, zone: &TimeZone) -> String {
    let (Ok(at), Ok(now)) = (
        Timestamp::from_millisecond(at_ms),
        Timestamp::from_millisecond(now_ms),
    ) else {
        return String::new();
    };
    let at: Zoned = at.to_zoned(zone.clone());
    let now: Zoned = now.to_zoned(zone.clone());
    let time = format!("{}:{:02}", at.hour(), at.minute());
    if at.date() == now.date() {
        time
    } else {
        let day = DAY_WORDS[usize::try_from(at.weekday().to_sunday_zero_offset()).unwrap_or(0)];
        format!("{} {time}", &day[..3])
    }
}

/// The local minute of the day (0 to 1439) of `at_ms` in `zone`.
pub fn local_minute(at_ms: i64, zone: &TimeZone) -> u32 {
    Timestamp::from_millisecond(at_ms).map_or(0, |at| {
        let at = at.to_zoned(zone.clone());
        u32::try_from(i32::from(at.hour()) * 60 + i32::from(at.minute())).unwrap_or(0)
    })
}
