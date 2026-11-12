use jiff::tz::TimeZone;

use super::*;
use crate::event::FromRoutine;

fn zone(name: &str) -> TimeZone {
    TimeZone::get(name).unwrap_or_else(|e| panic!("{name}: {e}"))
}

/// Milliseconds of a local wall time in `zone`.
fn local(zone_name: &str, text: &str) -> i64 {
    let civil: jiff::civil::DateTime = text.parse().unwrap_or_else(|e| panic!("{text}: {e}"));
    civil
        .to_zoned(zone(zone_name))
        .unwrap_or_else(|e| panic!("{text}: {e}"))
        .timestamp()
        .as_millisecond()
}

/// The local wall time of `ms` in `zone`, as `2026-03-08T09:00`.
fn wall(zone_name: &str, ms: i64) -> String {
    let at = jiff::Timestamp::from_millisecond(ms).unwrap_or_else(|e| panic!("{e}"));
    at.to_zoned(zone(zone_name))
        .datetime()
        .strftime("%Y-%m-%dT%H:%M")
        .to_string()
}

fn parse(text: &str) -> Schedule {
    Schedule::parse(text).unwrap_or_else(|e| panic!("{text}: {e}"))
}

fn next_walls(text: &str, zone_name: &str, from: &str, count: usize) -> Vec<String> {
    let schedule = parse(text);
    let tz = zone(zone_name);
    let mut at = local(zone_name, from);
    let mut out = Vec::new();
    for _ in 0..count {
        at = schedule
            .next_after(at, &tz)
            .unwrap_or_else(|| panic!("{text} ended"));
        out.push(wall(zone_name, at));
    }
    out
}

#[test]
fn phrases_read_as_the_words_the_list_shows() {
    for (text, words) in [
        ("daily at 9:00", "Every day at 9:00"),
        ("every day at 9am", "Every day at 9:00"),
        ("at 7:00 and 19:00", "Every day at 7:00 and 19:00"),
        ("weekdays at 9:00", "Weekdays at 9:00"),
        ("Weekends at 10:30", "Weekends at 10:30"),
        (
            "mondays and thursdays at 6:30pm",
            "Mondays and Thursdays at 18:30",
        ),
        (
            "mon, wed, fri at noon",
            "Mondays, Wednesdays and Fridays at 12:00",
        ),
        ("every 2 hours", "Every 2 hours"),
        ("every hour", "Every hour"),
        ("every 30 minutes", "Every 30 minutes"),
        ("0 9 * * 1-5", "Weekdays at 9:00"),
        ("0 */2 * * *", "Cron 0 */2 * * *"),
    ] {
        assert_eq!(parse(text).words(), words, "{text}");
    }
}

#[test]
fn schedules_that_cannot_be_read_say_why() {
    for text in [
        "",
        "whenever",
        "daily at 25:00",
        "daily at 9:75",
        "blursday at 9:00",
        "every 0 minutes",
        "61 * * * *",
        "0 9 * * 8",
        "at 9:15 and 10:30",
        "1/4294967295 * * * *",
        "0 0/4294967295 * * *",
        "*/60 * * * *",
        "0 9 */32 * *",
    ] {
        assert!(Schedule::parse(text).is_err(), "{text:?} was accepted");
    }
}

#[test]
fn weekdays_skip_the_weekend() {
    // 2026-11-13 is a Friday.
    assert_eq!(
        next_walls("weekdays at 9:00", "Europe/London", "2026-11-13T10:00", 2),
        ["2026-11-16T09:00", "2026-11-17T09:00"]
    );
}

#[test]
fn a_daily_time_keeps_its_wall_time_across_both_clock_changes() {
    // New York springs forward on 2026-03-08 and falls back on 2026-11-01.
    assert_eq!(
        next_walls("daily at 9:00", "America/New_York", "2026-03-06T12:00", 3),
        ["2026-03-07T09:00", "2026-03-08T09:00", "2026-03-09T09:00"]
    );
    assert_eq!(
        next_walls("daily at 9:00", "America/New_York", "2026-10-30T12:00", 3),
        ["2026-10-31T09:00", "2026-11-01T09:00", "2026-11-02T09:00"]
    );
    // The two 9:00s across the spring change are 23 real hours apart.
    let tz = zone("America/New_York");
    let schedule = parse("daily at 9:00");
    let before = local("America/New_York", "2026-03-07T09:00");
    let after = schedule.next_after(before, &tz).unwrap_or_default();
    assert_eq!(after - before, 23 * 3_600_000);
}

#[test]
fn a_time_the_spring_change_skips_runs_just_after_the_gap_and_a_repeated_one_runs_once() {
    // 2:30 does not exist on 2026-03-08 in New York (2:00 jumps to 3:00): it runs at 3:00, the
    // first instant after the gap, not never and not an hour late.
    assert_eq!(
        next_walls("daily at 2:30", "America/New_York", "2026-03-07T12:00", 2),
        ["2026-03-08T03:00", "2026-03-09T02:30"]
    );
    // 1:30 happens twice on 2026-11-01: it runs once.
    let schedule = parse("daily at 1:30");
    let tz = zone("America/New_York");
    let first = schedule
        .next_after(local("America/New_York", "2026-10-31T12:00"), &tz)
        .unwrap_or_default();
    let second = schedule.next_after(first, &tz).unwrap_or_default();
    assert_eq!(wall("America/New_York", second), "2026-11-02T01:30");
}

#[test]
fn intervals_count_real_time_through_a_clock_change() {
    let tz = zone("America/New_York");
    let schedule = parse("every 2 hours");
    let start = local("America/New_York", "2026-03-08T00:30");
    let one = schedule.next_after(start, &tz).unwrap_or_default();
    let two = schedule.next_after(one, &tz).unwrap_or_default();
    assert_eq!(two - one, 2 * 3_600_000);
}

#[test]
fn cron_days_of_month_and_week_match_either_when_both_are_set() {
    // The 13th, or any Friday.
    let walls = next_walls("0 8 13 * 5", "UTC", "2026-11-01T00:00", 3);
    assert_eq!(
        walls,
        ["2026-11-06T08:00", "2026-11-13T08:00", "2026-11-20T08:00"]
    );
    assert_eq!(
        next_walls("0 0 29 2 *", "UTC", "2026-03-01T00:00", 1),
        ["2028-02-29T00:00"]
    );
}

#[test]
fn missed_slots_come_due_as_one_caught_up_firing() {
    let tz = zone("UTC");
    let schedule = parse("every 1 hour");
    let next = local("UTC", "2026-11-12T09:00");
    // On time: due, not caught up.
    let on_time = due(&schedule, &tz, next, next + 1_000).unwrap_or_else(|| panic!("not due"));
    assert_eq!((on_time.missed, on_time.caught_up), (0, false));
    assert_eq!(on_time.next_ms, Some(next + 3_600_000));
    // Down from 9:00 until 13:20: one firing for the 13:00 slot, four slots missed.
    let now = local("UTC", "2026-11-12T13:20");
    let late = due(&schedule, &tz, next, now).unwrap_or_else(|| panic!("not due"));
    assert_eq!(late.slot_ms, local("UTC", "2026-11-12T13:00"));
    assert_eq!(late.missed, 4);
    assert!(late.caught_up);
    assert_eq!(late.next_ms, Some(local("UTC", "2026-11-12T14:00")));
    // Before the slot: nothing.
    assert!(due(&schedule, &tz, next, next - 1).is_none());
    // A month down on a minute schedule still finds one slot, quickly.
    let minutely = parse("every minute");
    let month = due(&minutely, &tz, next, next + 30 * 86_400_000).unwrap_or_else(|| panic!());
    assert_eq!(month.slot_ms, next + 30 * 86_400_000);
}

#[test]
fn quiet_hours_wrap_past_midnight() {
    let night = Some(QuietHours {
        start: 22 * 60,
        end: 7 * 60,
    });
    assert!(quiet_at(night, 23 * 60));
    assert!(quiet_at(night, 3 * 60));
    assert!(!quiet_at(night, 7 * 60));
    assert!(!quiet_at(night, 12 * 60));
    assert!(!quiet_at(None, 3 * 60));
}

fn message(run: &str, heartbeat: bool) -> Event {
    Event::Known(Known::UserMessage {
        text: "go".into(),
        context: None,
        images: Vec::new(),
        from_agent: None,
        from_routine: Some(Box::new(FromRoutine {
            id: "rt_1".into(),
            name: "Check".into(),
            run: run.into(),
            label: "9:00".into(),
            heartbeat,
            event: None,
        })),
    })
}

fn finished(reply: &str, text: &str) -> Event {
    Event::Known(Known::ReplyFinished {
        reply: reply.into(),
        text: text.into(),
        input_tokens: None,
        output_tokens: None,
        cost_micros: 0,
    })
}

#[test]
fn a_run_is_open_from_its_message_until_a_reply_ends() {
    let events = [
        finished("r0", "earlier"),
        message("run_1", false),
        Event::reply_started("r1", "fake/m"),
    ];
    assert!(run_open(&events, "run_1"));
    assert!(!run_open(&events, "run_2"));
    let mut done = events.to_vec();
    done.push(finished("r1", "Here is the briefing."));
    assert!(!run_open(&done, "run_1"));
}

#[test]
fn only_a_quiet_answer_to_a_heartbeat_alone_is_silent() {
    let events = [
        message("b1", true),
        Event::reply_started("r1", "fake/m"),
        finished("r1", "[quiet]"),
        message("b2", true),
        Event::reply_started("r2", "fake/m"),
        finished("r2", "The deploy failed; you should look."),
        message("b3", true),
        Event::user_message("also, what's up?"),
        Event::reply_started("r3", "fake/m"),
        finished("r3", "[quiet]"),
        Event::user_message("hi"),
        Event::reply_started("r4", "fake/m"),
        finished("r4", "[QUIET]."),
    ];
    let silent = silent_replies(&events);
    assert_eq!(silent, HashSet::from(["r1".to_owned()]));
}

#[test]
fn a_quiet_answer_to_the_persons_queued_message_and_a_heartbeat_still_shows() {
    // The person's message waited (Spade was closed for an update); a beat came after it, and
    // one reply answered both.
    let events = [
        Event::user_message("Did the deploy finish?"),
        message("b1", true),
        Event::reply_started("r1", "fake/m"),
        finished("r1", "[quiet]"),
    ];
    assert!(silent_replies(&events).is_empty());
}

fn step(reply: &str, text: &str) -> Event {
    Event::Known(Known::StepFinished {
        reply: reply.into(),
        text: text.into(),
        calls: Vec::new(),
        thoughts: Vec::new(),
        usage: crate::event::Tokens::default(),
        cost_micros: 0,
        seen: None,
    })
}

#[test]
fn a_heartbeat_reply_that_said_something_before_ending_quiet_still_shows() {
    let events = [
        message("b1", true),
        Event::reply_started("r1", "fake/m"),
        step("r1", "The deploy failed twice; checking the logs."),
        step("r1", "[quiet]"),
        finished("r1", "[quiet]"),
        message("b2", true),
        Event::reply_started("r2", "fake/m"),
        step("r2", ""),
        step("r2", "[quiet]"),
        finished("r2", "[quiet]"),
    ];
    assert_eq!(silent_replies(&events), HashSet::from(["r2".to_owned()]));
}

#[test]
fn a_routine_message_reads_as_the_routine_not_the_person() {
    let Event::Known(Known::UserMessage {
        from_routine: Some(from),
        ..
    }) = message("run_1", false)
    else {
        panic!("not a routine message");
    };
    let framed = framed(&from, "Summarise the inbox.");
    assert!(framed.starts_with("<routine name=\"Check\" id=\"rt_1\" fired=\"9:00\">"));
    assert!(framed.contains("Summarise the inbox."));
}
