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
        // The TypeScript accepts any safe integer as the cursor, negative ones included.
        const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
        if !(-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&after) {
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
