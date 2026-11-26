// SPDX-License-Identifier: Apache-2.0
//! Recurrence, ported from `packages/automations/src/recurrence.ts`: the same expansion, COUNT
//! and UNTIL semantics, DST handling and bounded search. `seek` returns the occurrence and its
//! ordinal so a counted schedule advances from its persisted cursor instead of rereading
//! history.

use serde::{Deserialize, Serialize};

use crate::calendar::{
    Civil, DAY, MINUTE, ZonedCalendar, civil_stamp, from_stamp, month_days, weekday,
};
use crate::error::{AutomationsError, Result};
use crate::grammar::{Frequency, Rule, cron_field, parse_rule};

/// The protocol's schedule (`AutomationSchedule`, `packages/protocol/src/automations.ts:8`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub kind: ScheduleKind,
    pub expression: String,
    pub timezone: String,
    pub start_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScheduleKind {
    Rrule,
    Cron,
}

impl Schedule {
    fn validate(&self) -> Result<()> {
        if self.expression.is_empty() || self.expression.chars().count() > 1024 {
            return Err(AutomationsError::message("Invalid schedule expression"));
        }
        if self.timezone.is_empty() || self.timezone.chars().count() > 128 {
            return Err(AutomationsError::message("Invalid schedule timezone"));
        }
        if self.start_at < 0 || self.start_at > 8_640_000_000_000_000 || self.start_at % MINUTE != 0
        {
            return Err(AutomationsError::message("DTSTART must have zero seconds"));
        }
        Ok(())
    }
}

/// One occurrence and where it sits in a counted series, as `Occurrence` stores it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Occurrence {
    pub at: i64,
    pub ordinal: u32,
}

fn matches_days(rule: &Rule, day: Civil, anchor: Civil) -> bool {
    let stamp = civil_stamp(day);
    let origin = civil_stamp(anchor.at_midnight());
    let delta = (stamp - origin) / DAY;
    let dow = weekday(day);
    let month_delta =
        i64::from(day.year - anchor.year) * 12 + i64::from(day.month) - i64::from(anchor.month);
    match rule.frequency {
        Frequency::Daily => {
            if delta % rule.interval != 0 {
                return false;
            }
        }
        Frequency::Weekly => {
            let monday = origin - i64::from((weekday(anchor) + 6) % 7) * DAY;
            if ((stamp - monday) / (7 * DAY)) % rule.interval != 0 {
                return false;
            }
            if rule.days.is_none() && dow != weekday(anchor) {
                return false;
            }
        }
        Frequency::Monthly => {
            if month_delta % rule.interval != 0 || (rule.days.is_none() && day.day != anchor.day) {
                return false;
            }
        }
        Frequency::Yearly => {
            if (i64::from(day.year - anchor.year)) % rule.interval != 0
                || (rule.days.is_none() && (day.month != anchor.month || day.day != anchor.day))
            {
                return false;
            }
        }
        Frequency::Hourly | Frequency::Minutely => {}
    }
    let Some(days) = &rule.days else {
        return true;
    };
    days.iter().any(|filter| {
        if dow != filter.weekday {
            return false;
        }
        let Some(ordinal) = filter.ordinal else {
            return true;
        };
        let start = if rule.frequency == Frequency::Yearly {
            civil_stamp(Civil {
                year: day.year,
                month: 1,
                day: 1,
                hour: 0,
                minute: 0,
            })
        } else {
            civil_stamp(Civil {
                year: day.year,
                month: day.month,
                day: 1,
                hour: 0,
                minute: 0,
            })
        };
        let total = if rule.frequency == Frequency::Yearly {
            (civil_stamp(Civil {
                year: day.year + 1,
                month: 1,
                day: 1,
                hour: 0,
                minute: 0,
            }) - start)
                / DAY
        } else {
            i64::from(month_days(day.year, day.month))
        };
        let index = (stamp - start) / DAY;
        if ordinal > 0 {
            index / 7 + 1 == i64::from(ordinal)
        } else {
            -((total - index - 1) / 7 + 1) == i64::from(ordinal)
        }
    })
}

/// `compileSchedule` (`recurrence.ts:79`), evaluated lazily.
pub struct Recurrence {
    schedule: Schedule,
    calendar: ZonedCalendar,
    anchor: Civil,
    anchor_stamp: i64,
    anchor_hour: i64,
    rule: Option<Rule>,
    cron: Option<CronDays>,
    hours: Vec<i64>,
    minutes: Vec<i64>,
}

/// The parts of a cron expression that decide the day, parsed once at compile.
struct CronDays {
    days: Vec<i64>,
    months: Vec<i64>,
    weeks: Vec<i64>,
    day_wildcard: bool,
    week_wildcard: bool,
}

impl Recurrence {
    pub fn compile(schedule: Schedule) -> Result<Recurrence> {
        schedule.validate()?;
        let calendar = ZonedCalendar::new(&schedule.timezone)?;
        let anchor = calendar.local(schedule.start_at)?;
        let anchor_stamp = civil_stamp(anchor);
        let anchor_hour = civil_stamp(Civil {
            minute: 0,
            ..anchor
        });
        let rule = match schedule.kind {
            ScheduleKind::Rrule => Some(parse_rule(&schedule.expression)?),
            ScheduleKind::Cron => None,
        };
        let mut cron = None;
        let (hours, minutes) = if let Some(rule) = &rule {
            let hours = rule.hours.clone().unwrap_or_else(|| {
                if matches!(rule.frequency, Frequency::Hourly | Frequency::Minutely) {
                    (0..24).collect()
                } else {
                    vec![i64::from(anchor.hour)]
                }
            });
            let minutes = rule.minutes.clone().unwrap_or_else(|| {
                if rule.frequency == Frequency::Minutely {
                    (0..60).collect()
                } else {
                    vec![i64::from(anchor.minute)]
                }
            });
            (hours, minutes)
        } else {
            let fields: Vec<&str> = schedule.expression.split_whitespace().collect();
            if fields.len() != 5 {
                return Err(AutomationsError::message("Cron requires five fields"));
            }
            let minutes = cron_field(fields[0], 0, 59)?;
            let hours = cron_field(fields[1], 0, 23)?;
            cron = Some(CronDays {
                days: cron_field(fields[2], 1, 31)?,
                months: cron_field(fields[3], 1, 12)?,
                weeks: cron_field(fields[4], 0, 7)?
                    .into_iter()
                    .map(|week| week % 7)
                    .collect(),
                day_wildcard: fields[2].starts_with('*'),
                week_wildcard: fields[4].starts_with('*'),
            });
            (hours, minutes)
        };
        Ok(Recurrence {
            schedule,
            calendar,
            anchor,
            anchor_stamp,
            anchor_hour,
            rule,
            cron,
            hours,
            minutes,
        })
    }

    pub fn schedule(&self) -> &Schedule {
        &self.schedule
    }

    /// The next occurrence strictly after `after`, or none when the rule ends.
    pub fn next(&self, after: i64) -> Result<Option<i64>> {
        Ok(self.seek(after, None)?.map(|occurrence| occurrence.at))
    }

    /// The next occurrence after `after`, advancing a counted series from `previous` when given.
    pub fn seek(&self, after: i64, previous: Option<Occurrence>) -> Result<Option<Occurrence>> {
        if after < 0 {
            return Err(AutomationsError::message("Invalid recurrence cursor"));
        }
        if let Some(until) = self.rule.as_ref().and_then(|rule| rule.until)
            && after >= until
        {
            return Ok(None);
        }
        if self.rule.is_some() && after < self.schedule.start_at {
            let until = self.rule.as_ref().and_then(|rule| rule.until);
            return Ok(until
                .is_none_or(|until| self.schedule.start_at <= until)
                .then_some(Occurrence {
                    at: self.schedule.start_at,
                    ordinal: 1,
                }));
        }
        let counted = self.rule.as_ref().and_then(|rule| rule.count);
        let cursor = match (counted, previous) {
            (Some(_), Some(previous)) => Some(previous),
            _ => None,
        };
        if let Some(cursor) = cursor
            && (cursor.at > after || cursor.at < self.schedule.start_at)
        {
            return Err(AutomationsError::message("Invalid counted cursor"));
        }
        let mut count =
            cursor.map_or_else(|| if self.rule.is_some() { 1 } else { 0 }, |c| c.ordinal);
        if let Some(limit) = counted
            && i64::from(count) >= limit
        {
            return Ok(None);
        }
        let (first, lower) = match counted {
            Some(_) => {
                let first = match cursor {
                    Some(cursor) => self.calendar.local(cursor.at)?,
                    None => self.anchor,
                };
                let lower = match cursor {
                    Some(cursor) => civil_stamp(self.calendar.local(cursor.at)?) + MINUTE,
                    None => self.anchor_stamp,
                };
                (first, lower)
            }
            None => {
                let first = self.calendar.local(after.max(self.schedule.start_at))?;
                let lower =
                    civil_stamp(self.calendar.local(after.max(self.schedule.start_at - 1))?);
                (first, lower)
            }
        };
        let mut date = civil_stamp(first.at_midnight());
        let mut work = 0u32;
        for _ in 0..146_097 {
            let day = from_stamp(date);
            if self.matches_day(day) {
                for hour in &self.hours {
                    for minute in &self.minutes {
                        let candidate = date + *hour * 60 * MINUTE + *minute * MINUTE;
                        if candidate < self.anchor_stamp
                            || candidate < lower
                            || (self.rule.is_some() && candidate == self.anchor_stamp)
                        {
                            continue;
                        }
                        if let Some(rule) = &self.rule {
                            if rule.frequency == Frequency::Hourly
                                && ((date + *hour * 60 * MINUTE - self.anchor_hour) / (60 * MINUTE))
                                    % rule.interval
                                    != 0
                            {
                                continue;
                            }
                            if rule.frequency == Frequency::Minutely
                                && ((candidate - self.anchor_stamp) / MINUTE) % rule.interval != 0
                            {
                                continue;
                            }
                        }
                        work += 1;
                        if work > 1_000_000 {
                            return Err(AutomationsError::message(
                                "Recurrence evaluation budget exhausted",
                            ));
                        }
                        let Some(at) = self.calendar.resolve(Civil {
                            year: day.year,
                            month: day.month,
                            day: day.day,
                            hour: *hour as u32,
                            minute: *minute as u32,
                        })?
                        else {
                            continue;
                        };
                        if at < self.schedule.start_at {
                            continue;
                        }
                        if let Some(until) = self.rule.as_ref().and_then(|rule| rule.until)
                            && at > until
                        {
                            return Ok(None);
                        }
                        count += 1;
                        if let Some(limit) = counted
                            && i64::from(count) > limit
                        {
                            return Ok(None);
                        }
                        if at > after {
                            return Ok(Some(Occurrence { at, ordinal: count }));
                        }
                    }
                }
            }
            date += DAY;
        }
        Err(AutomationsError::message(
            "Recurrence search horizon exhausted",
        ))
    }

    fn matches_day(&self, day: Civil) -> bool {
        match &self.rule {
            Some(rule) => matches_days(rule, day, self.anchor),
            None => self.matches_cron_day(day),
        }
    }
}

impl Recurrence {
    fn matches_cron_day(&self, day: Civil) -> bool {
        let Some(cron) = &self.cron else {
            return false;
        };
        let dow = i64::from(weekday(day));
        cron.months.contains(&i64::from(day.month))
            && if cron.day_wildcard || cron.week_wildcard {
                cron.days.contains(&i64::from(day.day)) && cron.weeks.contains(&dow)
            } else {
                cron.days.contains(&i64::from(day.day)) || cron.weeks.contains(&dow)
            }
    }
}

pub fn next_occurrence(schedule: &Schedule, after: i64) -> Result<Option<i64>> {
    Recurrence::compile(schedule.clone())?.next(after)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::iso_string;

    const START: i64 = 1_704_099_600_000; // 2024-01-01T09:00:00Z

    fn at(value: &str) -> i64 {
        // Test-only parsing for the exact literals the TypeScript tests use.
        let number = |start: usize, end: usize| value[start..end].parse::<i64>().unwrap_or(0);
        let year = number(0, 4);
        let month = number(5, 7);
        let day = number(8, 10);
        let hour = number(11, 13);
        let minute = number(14, 16);
        let second = number(17, 19);
        crate::calendar::civil_stamp(Civil {
            year: year as i32,
            month: month as u32,
            day: day as u32,
            hour: hour as u32,
            minute: minute as u32,
        }) + second * 1000
    }

    fn schedule(expression: &str, kind: ScheduleKind, start: i64, timezone: &str) -> Schedule {
        Schedule {
            kind,
            expression: expression.to_owned(),
            timezone: timezone.to_owned(),
            start_at: start,
        }
    }

    fn dates(input: Schedule, after: &str, n: usize) -> Vec<String> {
        let recurrence = Recurrence::compile(input).expect("schedule compiles");
        let mut cursor = at(after);
        let mut result = Vec::new();
        for _ in 0..n {
            let Some(next) = recurrence.next(cursor).expect("evaluates") else {
                break;
            };
            result.push(iso_string(next));
            cursor = next;
        }
        result
    }

    fn rrule(expression: &str) -> Schedule {
        schedule(expression, ScheduleKind::Rrule, START, "UTC")
    }

    #[test]
    fn runs_weekdays_at_nine_across_spring_dst() {
        let s = schedule(
            "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0",
            ScheduleKind::Rrule,
            at("2024-03-08T15:00:00Z"),
            "America/Chicago",
        );
        assert_eq!(
            dates(s, "2024-03-07T00:00:00Z", 3),
            vec![
                "2024-03-08T15:00:00.000Z",
                "2024-03-11T14:00:00.000Z",
                "2024-03-12T14:00:00.000Z",
            ]
        );
    }

    #[test]
    fn skips_a_nonexistent_spring_wall_time_for_rrule_and_cron() {
        for (kind, expression) in [
            (ScheduleKind::Rrule, "FREQ=DAILY;BYHOUR=2;BYMINUTE=30"),
            (ScheduleKind::Cron, "30 2 * * *"),
        ] {
            let s = schedule(
                expression,
                kind,
                at("2024-03-09T07:30:00Z"),
                "America/New_York",
            );
            assert_eq!(
                dates(s, "2024-03-09T07:30:00Z", 2),
                vec!["2024-03-11T06:30:00.000Z", "2024-03-12T06:30:00.000Z"]
            );
        }
    }

    #[test]
    fn runs_a_repeated_autumn_wall_time_only_at_its_first_instant() {
        for (kind, expression) in [
            (ScheduleKind::Rrule, "FREQ=DAILY;BYHOUR=1;BYMINUTE=30"),
            (ScheduleKind::Cron, "30 1 * * *"),
        ] {
            let s = schedule(
                expression,
                kind,
                at("2024-11-02T05:30:00Z"),
                "America/New_York",
            );
            assert_eq!(
                dates(s.clone(), "2024-11-02T05:30:00Z", 2),
                vec!["2024-11-03T05:30:00.000Z", "2024-11-04T06:30:00.000Z"]
            );
            assert_eq!(
                dates(s, "2024-11-03T06:00:00Z", 1),
                vec!["2024-11-04T06:30:00.000Z"]
            );
        }
    }

    #[test]
    fn skips_the_half_hour_spring_gap_on_lord_howe() {
        assert_eq!(
            dates(
                schedule(
                    "15 2 * * *",
                    ScheduleKind::Cron,
                    at("2024-10-04T15:45:00Z"),
                    "Australia/Lord_Howe"
                ),
                "2024-10-04T15:45:00Z",
                1
            ),
            vec!["2024-10-06T15:15:00.000Z"]
        );
    }

    #[test]
    fn does_not_shift_monthly_day_31_into_a_shorter_month() {
        assert_eq!(
            dates(
                schedule(
                    "FREQ=MONTHLY",
                    ScheduleKind::Rrule,
                    at("2024-01-31T09:00:00Z"),
                    "UTC"
                ),
                "2024-01-30T00:00:00Z",
                4
            ),
            vec![
                "2024-01-31T09:00:00.000Z",
                "2024-03-31T09:00:00.000Z",
                "2024-05-31T09:00:00.000Z",
                "2024-07-31T09:00:00.000Z",
            ]
        );
    }

    #[test]
    fn annual_leap_day_skips_common_and_century_non_leap_years() {
        assert_eq!(
            dates(
                schedule(
                    "FREQ=YEARLY",
                    ScheduleKind::Rrule,
                    at("2096-02-29T09:00:00Z"),
                    "UTC"
                ),
                "2096-02-29T09:00:00Z",
                2
            ),
            vec!["2104-02-29T09:00:00.000Z", "2108-02-29T09:00:00.000Z"]
        );
    }

    #[test]
    fn cron_finds_leap_days_without_scanning_every_minute() {
        assert_eq!(
            dates(
                schedule("0 9 29 2 *", ScheduleKind::Cron, START, "UTC"),
                "2024-03-01T00:00:00Z",
                1
            ),
            vec!["2028-02-29T09:00:00.000Z"]
        );
    }

    #[test]
    fn count_counts_dtstart_and_valid_occurrences_excluding_skipped_dst_times() {
        let s = schedule(
            "FREQ=DAILY;COUNT=3",
            ScheduleKind::Rrule,
            at("2024-03-09T07:30:00Z"),
            "America/New_York",
        );
        assert_eq!(
            dates(s.clone(), "2024-03-09T00:00:00Z", 5),
            vec![
                "2024-03-09T07:30:00.000Z",
                "2024-03-11T06:30:00.000Z",
                "2024-03-12T06:30:00.000Z",
            ]
        );
        assert_eq!(
            next_occurrence(&s, at("2025-01-01T00:00:00Z")).unwrap(),
            None
        );
    }

    #[test]
    fn until_is_inclusive_and_applies_to_expanded_times() {
        assert_eq!(
            dates(
                rrule("FREQ=DAILY;BYHOUR=9,15;UNTIL=20240102T090000Z"),
                "2024-01-01T00:00:00Z",
                9
            ),
            vec![
                "2024-01-01T09:00:00.000Z",
                "2024-01-01T15:00:00.000Z",
                "2024-01-02T09:00:00.000Z",
            ]
        );
    }

    #[test]
    fn applies_interval_and_calendar_filters() {
        for (expression, expected) in [
            ("FREQ=MINUTELY;INTERVAL=17", "2024-01-01T09:17:00.000Z"),
            (
                "FREQ=HOURLY;INTERVAL=3;BYMINUTE=10,20",
                "2024-01-01T09:10:00.000Z",
            ),
            ("FREQ=DAILY;INTERVAL=2", "2024-01-03T09:00:00.000Z"),
            (
                "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR",
                "2024-01-05T09:00:00.000Z",
            ),
            ("FREQ=MONTHLY;BYDAY=-1FR", "2024-01-26T09:00:00.000Z"),
            ("FREQ=YEARLY;BYDAY=2MO", "2024-01-08T09:00:00.000Z"),
        ] {
            assert_eq!(
                dates(rrule(expression), "2024-01-01T09:00:00Z", 1),
                vec![expected],
                "{expression}"
            );
        }
    }

    #[test]
    fn hourly_byhour_filters_rather_than_expanding_outside_the_interval() {
        assert_eq!(
            dates(
                rrule("FREQ=HOURLY;INTERVAL=3;BYHOUR=12;BYMINUTE=15"),
                "2024-01-01T09:00:00Z",
                2
            ),
            vec!["2024-01-01T12:15:00.000Z", "2024-01-02T12:15:00.000Z"]
        );
    }

    #[test]
    fn cron_supports_lists_range_steps_and_sunday_seven() {
        assert_eq!(
            dates(
                schedule("0,30 8-10/2 * * 7", ScheduleKind::Cron, START, "UTC"),
                "2024-01-06T00:00:00Z",
                3
            ),
            vec![
                "2024-01-07T08:00:00.000Z",
                "2024-01-07T08:30:00.000Z",
                "2024-01-07T10:00:00.000Z",
            ]
        );
    }

    #[test]
    fn cron_uses_or_for_two_restricted_day_fields() {
        assert_eq!(
            dates(
                schedule("0 9 1 * 5", ScheduleKind::Cron, START, "UTC"),
                "2024-01-01T09:00:00Z",
                2
            ),
            vec!["2024-01-05T09:00:00.000Z", "2024-01-12T09:00:00.000Z"]
        );
    }

    #[test]
    fn cron_wildcard_steps_still_constrain_weekdays_with_and() {
        assert_eq!(
            dates(
                schedule("0 9 */2 * 1", ScheduleKind::Cron, START, "UTC"),
                "2024-01-01T09:00:00Z",
                2
            ),
            vec!["2024-01-15T09:00:00.000Z", "2024-01-29T09:00:00.000Z"]
        );
    }

    #[test]
    fn rejects_unsupported_rules_and_invalid_cron() {
        for expression in [
            "FREQ=DAILY;BYMONTH=3",
            "FREQ=DAILY;COUNT=2;UNTIL=20240101T000000Z",
            "FREQ=WEEKLY;BYDAY=1MO",
            "FREQ=DAILY;INTERVAL=0",
            "FREQ=DAILY;BYHOUR=24",
            "FREQ=DAILY;UNTIL=20240230T000000Z",
            "FREQ=DAILY;FREQ=WEEKLY",
        ] {
            assert!(
                Recurrence::compile(rrule(expression)).is_err(),
                "{expression}"
            );
        }
        for expression in [
            "0 24 * * *",
            "0 9 * * MON",
            "0 9 * *",
            "0 9 2-1 * *",
            "0 9 * * */0",
        ] {
            assert!(
                Recurrence::compile(schedule(expression, ScheduleKind::Cron, START, "UTC"))
                    .is_err(),
                "{expression}"
            );
        }
    }

    #[test]
    fn reports_a_bounded_search_failure_rather_than_claiming_an_impossible_schedule_ended() {
        let error = next_occurrence(
            &schedule("0 9 30 2 *", ScheduleKind::Cron, START, "UTC"),
            at("2024-01-01T00:00:00Z"),
        )
        .expect_err("no 30 February");
        assert!(error.to_string().contains("horizon"), "{error}");
    }

    #[test]
    fn advances_a_counted_recurrence_from_a_supplied_cursor_like_full_evaluation() {
        let recurrence = Recurrence::compile(rrule("FREQ=DAILY;COUNT=6")).expect("compiles");
        let first = recurrence
            .seek(at("2024-01-01T08:00:00Z"), None)
            .expect("evaluates")
            .expect("first");
        assert_eq!(
            first,
            Occurrence {
                at: START,
                ordinal: 1
            }
        );
        let next = recurrence
            .seek(at("2024-01-03T12:00:00Z"), Some(first))
            .expect("evaluates")
            .expect("next");
        assert_eq!(
            next,
            Occurrence {
                at: at("2024-01-04T09:00:00Z"),
                ordinal: 4
            }
        );
        assert_eq!(
            Some(next.at),
            recurrence
                .next(at("2024-01-03T12:00:00Z"))
                .expect("evaluates")
        );
        assert_eq!(
            recurrence
                .seek(at("2024-01-07T00:00:00Z"), Some(next))
                .expect("evaluates"),
            None
        );
    }

    #[test]
    fn expands_byminute_within_the_hourly_interval_anchored_at_the_civil_hour() {
        let s = schedule(
            "FREQ=HOURLY;INTERVAL=2;BYMINUTE=0,30",
            ScheduleKind::Rrule,
            at("2026-01-01T09:30:00Z"),
            "UTC",
        );
        assert_eq!(
            dates(s, "2026-01-01T09:30:00Z", 4),
            vec![
                "2026-01-01T11:00:00.000Z",
                "2026-01-01T11:30:00.000Z",
                "2026-01-01T13:00:00.000Z",
                "2026-01-01T13:30:00.000Z",
            ]
        );
    }
}
