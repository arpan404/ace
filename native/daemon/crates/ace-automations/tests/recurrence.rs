// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
//! Ports every case of `packages/automations/src/recurrence.test.ts`: the `calendar recurrence`
//! describe block and the two top-level counted-cursor cases.

mod tests {
    use ace_automations::calendar::{Civil, iso_string};
    use ace_automations::{Occurrence, Recurrence, Schedule, ScheduleKind, next_occurrence};

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
        ace_automations::calendar::civil_stamp(Civil {
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

    #[test]
    fn a_negative_safe_integer_cursor_returns_the_epoch_dtstart() {
        let epoch = schedule("FREQ=DAILY", ScheduleKind::Rrule, 0, "UTC");
        let recurrence = Recurrence::compile(epoch).expect("compiles");
        assert_eq!(
            recurrence.seek(-1, None).expect("evaluates"),
            Some(Occurrence { at: 0, ordinal: 1 }),
            "the cursor may be negative"
        );
        assert_eq!(
            recurrence
                .seek(-9_007_199_254_740_991, None)
                .expect("evaluates"),
            Some(Occurrence { at: 0, ordinal: 1 }),
            "every safe integer is a cursor"
        );
        assert!(
            recurrence.seek(i64::MIN, None).is_err(),
            "an unsafe integer is refused"
        );
        // At the epoch itself DTSTART is consumed, so the next occurrence is the following day.
        assert_eq!(
            recurrence.seek(0, None).expect("evaluates").map(|o| o.at),
            Some(86_400_000)
        );
    }
}
