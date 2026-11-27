// SPDX-License-Identifier: Apache-2.0
//! RRULE and cron grammar, ported from `packages/automations/src/grammar.ts`. The refusals are
//! the TypeScript's own words; every list is unique and sorted, as `integers` and `cronField`
//! return them.

use std::collections::BTreeSet;

use crate::error::{AutomationsError, Result};

const WEEKDAYS: [&str; 7] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

fn refuse(text: &str) -> AutomationsError {
    AutomationsError::message(text)
}

/// `integers` (`grammar.ts:3`): a comma list of unsigned integers inside `[min, max]`.
pub fn integers(value: &str, min: i64, max: i64) -> Result<Vec<i64>> {
    let mut result = BTreeSet::new();
    for part in value.split(',') {
        if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(refuse("Expected an unsigned integer list"));
        }
        let number: i64 = part
            .parse()
            .map_err(|_| refuse("Expected an unsigned integer list"))?;
        if number < min || number > max {
            return Err(refuse("Invalid or unsupported RRULE field"));
        }
        result.insert(number);
    }
    Ok(result.into_iter().collect())
}

/// `cronField` (`grammar.ts:12`): `*`, a number, a range, and an optional `/step` on either.
pub fn cron_field(value: &str, min: i64, max: i64) -> Result<Vec<i64>> {
    let mut values = BTreeSet::new();
    for term in value.split(',') {
        let (head, step_text) = match term.split_once('/') {
            Some((head, step)) => (head, Some(step)),
            None => (term, None),
        };
        if let Some(step) = step_text
            && (step.is_empty() || !step.bytes().all(|byte| byte.is_ascii_digit()))
        {
            return Err(refuse("Invalid cron field"));
        }
        let step = match step_text {
            Some(step) => integers(step, 1, max - min + 1)?
                .first()
                .copied()
                .ok_or_else(|| refuse("Invalid step"))?,
            None => 1,
        };
        let (low, high, has_range) = if head == "*" {
            (min, max, true)
        } else if let Some((a, b)) = head.split_once('-') {
            let low = parse_cron_number(a, min, max)?;
            let high = parse_cron_number(b, min, max)?;
            (low, high, true)
        } else {
            let only = parse_cron_number(head, min, max)?;
            (only, only, false)
        };
        if low > high || (step_text.is_some() && !has_range) {
            return Err(refuse("Invalid cron range"));
        }
        let mut n = low;
        while n <= high {
            values.insert(n);
            n += step;
        }
    }
    Ok(values.into_iter().collect())
}

fn parse_cron_number(text: &str, min: i64, max: i64) -> Result<i64> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(refuse("Invalid cron field"));
    }
    let number: i64 = text.parse().map_err(|_| refuse("Invalid cron field"))?;
    if number < min || number > max {
        return Err(refuse("Invalid cron field"));
    }
    Ok(number)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Frequency {
    Minutely,
    Hourly,
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

impl Frequency {
    fn parse(value: &str) -> Result<Frequency> {
        match value {
            "MINUTELY" => Ok(Frequency::Minutely),
            "HOURLY" => Ok(Frequency::Hourly),
            "DAILY" => Ok(Frequency::Daily),
            "WEEKLY" => Ok(Frequency::Weekly),
            "MONTHLY" => Ok(Frequency::Monthly),
            "YEARLY" => Ok(Frequency::Yearly),
            _ => Err(refuse("Invalid or unsupported RRULE field")),
        }
    }
}

/// A `BYDAY` entry: a weekday and, for MONTHLY and YEARLY, its ordinal in the month or year.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DayRule {
    pub weekday: u32,
    pub ordinal: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    pub frequency: Frequency,
    pub interval: i64,
    pub days: Option<Vec<DayRule>>,
    pub hours: Option<Vec<i64>>,
    pub minutes: Option<Vec<i64>>,
    pub count: Option<i64>,
    pub until: Option<i64>,
}

const FIELDS: [&str; 7] = [
    "FREQ", "INTERVAL", "BYDAY", "BYHOUR", "BYMINUTE", "COUNT", "UNTIL",
];

/// `parseRule` (`grammar.ts:47`).
pub fn parse_rule(expression: &str) -> Result<Rule> {
    let body = expression.strip_prefix("RRULE:").unwrap_or(expression);
    let mut fields: Vec<(&str, &str)> = Vec::new();
    for part in body.split(';') {
        let mut pieces = part.split('=');
        let key = pieces.next().unwrap_or("");
        let value = pieces.next();
        let extra = pieces.next();
        let Some(value) = value else {
            return Err(refuse("Invalid or unsupported RRULE field"));
        };
        if key.is_empty()
            || value.is_empty()
            || extra.is_some()
            || fields.iter().any(|(seen, _)| *seen == key)
            || !FIELDS.contains(&key)
        {
            return Err(refuse("Invalid or unsupported RRULE field"));
        }
        fields.push((key, value));
    }
    let field = |key: &str| {
        fields
            .iter()
            .find_map(|(name, value)| (*name == key).then_some(*value))
    };
    let frequency = Frequency::parse(
        field("FREQ").ok_or_else(|| refuse("Invalid or unsupported RRULE field"))?,
    )?;
    let number = |key: &str, min: i64, max: i64| -> Result<Option<Vec<i64>>> {
        field(key)
            .map(|value| integers(value, min, max))
            .transpose()
    };
    let scalar = |key: &str| -> Result<Option<i64>> {
        let result = number(key, 1, 1_000_000)?;
        match result {
            Some(values) if values.len() != 1 => Err(refuse("Expected scalar")),
            Some(values) => Ok(values.first().copied()),
            None => Ok(None),
        }
    };
    let days = match field("BYDAY") {
        Some(value) => Some(
            value
                .split(',')
                .map(|entry| day_rule(entry, frequency))
                .collect::<Result<Vec<DayRule>>>()?,
        ),
        None => None,
    };
    let count = scalar("COUNT")?;
    let mut until = None;
    if let Some(value) = field("UNTIL") {
        if count.is_some() {
            return Err(refuse("COUNT and UNTIL are mutually exclusive"));
        }
        until = Some(parse_until(value)?);
    }
    Ok(Rule {
        frequency,
        interval: scalar("INTERVAL")?.unwrap_or(1),
        days,
        hours: number("BYHOUR", 0, 23)?,
        minutes: number("BYMINUTE", 0, 59)?,
        count,
        until,
    })
}

fn day_rule(value: &str, frequency: Frequency) -> Result<DayRule> {
    let (prefix, weekday) = WEEKDAYS
        .iter()
        .enumerate()
        .find_map(|(index, name)| {
            value
                .strip_suffix(name)
                .map(|prefix| (prefix, index as u32))
        })
        .ok_or_else(|| refuse("Invalid BYDAY"))?;
    let ordinal = if prefix.is_empty() {
        None
    } else {
        let digits = prefix.strip_prefix(['+', '-']).unwrap_or(prefix);
        if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(refuse("Invalid BYDAY"));
        }
        let number: i32 = prefix.parse().map_err(|_| refuse("Invalid BYDAY"))?;
        Some(number)
    };
    if let Some(ordinal) = ordinal
        && (ordinal == 0
            || ordinal.unsigned_abs() > 53
            || !matches!(frequency, Frequency::Monthly | Frequency::Yearly))
    {
        return Err(refuse("Invalid BYDAY ordinal"));
    }
    Ok(DayRule { weekday, ordinal })
}

/// `UNTIL` (`grammar.ts:101`): `YYYYMMDDTHHMMSSZ`, an instant that must round-trip.
fn parse_until(value: &str) -> Result<i64> {
    let bytes = value.as_bytes();
    if bytes.len() != 16
        || bytes[8] != b'T'
        || bytes[15] != b'Z'
        || !bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 8 || index == 15 || byte.is_ascii_digit())
    {
        return Err(refuse("UNTIL must be a UTC date-time"));
    }
    let field = |start: usize, end: usize| -> Result<i32> {
        value[start..end]
            .parse::<i32>()
            .map_err(|_| refuse("Invalid UNTIL"))
    };
    let year = field(0, 4)?;
    let month = field(4, 6)? as u32;
    let day = field(6, 8)? as u32;
    let hour = field(9, 11)? as u32;
    let minute = field(11, 13)? as u32;
    let second = field(13, 15)? as u32;
    let days = crate::calendar::month_days(year, month);
    if !(1..=12).contains(&month)
        || day == 0
        || day > days
        || hour > 23
        || minute > 59
        || second > 59
    {
        return Err(refuse("Invalid UNTIL"));
    }
    Ok(crate::calendar::civil_stamp(crate::calendar::Civil {
        year,
        month,
        day,
        hour,
        minute,
    }) + i64::from(second) * 1000)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cron_fields_expand_lists_ranges_and_steps() {
        assert_eq!(cron_field("0,30", 0, 59).unwrap(), vec![0, 30]);
        assert_eq!(cron_field("8-10/2", 0, 23).unwrap(), vec![8, 10]);
        assert_eq!(cron_field("*/15", 0, 59).unwrap(), vec![0, 15, 30, 45]);
        assert_eq!(cron_field("7", 0, 7).unwrap(), vec![7]);
    }

    #[test]
    fn cron_fields_refuse_the_typescripts_cases() {
        for value in ["24", "MON", "", "2-1"] {
            assert!(cron_field(value, 0, 23).is_err(), "{value}");
        }
        assert!(cron_field("*/0", 0, 59).is_err());
        assert!(cron_field("1/2", 0, 59).is_err());
    }

    #[test]
    fn rrule_parses_every_supported_field() {
        let rule =
            parse_rule("RRULE:FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR;BYHOUR=9;BYMINUTE=0;COUNT=4")
                .unwrap();
        assert_eq!(rule.frequency, Frequency::Monthly);
        assert_eq!(rule.interval, 2);
        assert_eq!(
            rule.days,
            Some(vec![DayRule {
                weekday: 5,
                ordinal: Some(-1)
            }])
        );
        assert_eq!(rule.hours, Some(vec![9]));
        assert_eq!(rule.minutes, Some(vec![0]));
        assert_eq!(rule.count, Some(4));
        assert_eq!(rule.until, None);
    }

    #[test]
    fn rrule_refuses_unknown_duplicate_and_invalid_fields() {
        for expression in [
            "FREQ=DAILY;BYMONTH=3",
            "FREQ=DAILY;COUNT=2;UNTIL=20240101T000000Z",
            "FREQ=WEEKLY;BYDAY=1MO",
            "FREQ=DAILY;INTERVAL=0",
            "FREQ=DAILY;BYHOUR=24",
            "FREQ=DAILY;UNTIL=20240230T000000Z",
            "FREQ=DAILY;FREQ=WEEKLY",
        ] {
            assert!(parse_rule(expression).is_err(), "{expression}");
        }
    }

    #[test]
    fn until_is_a_utc_instant_inclusive_of_its_second() {
        assert_eq!(
            parse_rule("FREQ=DAILY;UNTIL=20240102T090000Z")
                .unwrap()
                .until,
            Some(1_704_186_000_000)
        );
    }
}
