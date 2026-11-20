use serde_json::{Value, json};

use super::brief::{self, BotInput};
use super::notable::{engaged, notable};
use super::settings::{self, Budget, SpendAlerts};
use super::spend;
use super::*;
use crate::event::Event;

const MINUTE: i64 = 60_000;

fn events(raw: &[Value]) -> Vec<Event> {
    raw.iter().map(|r| Event::from_json(r.clone())).collect()
}

fn notice(category: Category, level: Option<Level>) -> Notice {
    Notice {
        category,
        level,
        engaged: false,
        bot_on: true,
    }
}

fn at(now_ms: i64, minute: u16, sent: &[i64]) -> Moment<'_> {
    Moment {
        now_ms,
        minute,
        sent,
    }
}

#[test]
fn do_not_disturb_holds_proactive_notices_but_never_a_stop_or_a_block() {
    let settings = Settings {
        dnd: true,
        ..Settings::default()
    };
    let cases = [
        (notice(Category::Routine, None), Reach::Held),
        (notice(Category::Finished, Some(Level::Inform)), Reach::Held),
        (notice(Category::Digest, Some(Level::Inform)), Reach::Held),
        (notice(Category::Spend, None), Reach::Held),
        (notice(Category::NeedsYou, Some(Level::Ask)), Reach::Held),
        (notice(Category::NeedsYou, Some(Level::Block)), Reach::Now),
        (notice(Category::Escalation, Some(Level::Stop)), Reach::Now),
        (notice(Category::Brief, None), Reach::Now),
        (notice(Category::Record, Some(Level::Inform)), Reach::None),
    ];
    for (n, reach) in cases {
        let decided = decide(&settings, n, at(0, 600, &[]));
        assert_eq!(decided.reach, reach, "{:?}", n.category);
        if reach == Reach::Held {
            assert_eq!(decided.why, Some(Why::Dnd));
        }
    }
}

#[test]
fn a_question_for_later_gets_through_quiet_when_the_person_is_in_the_conversation() {
    let settings = Settings {
        quiet: Some(Window {
            from: 22 * 60,
            to: 7 * 60,
        }),
        ..Settings::default()
    };
    let mut ask = notice(Category::NeedsYou, Some(Level::Ask));
    assert_eq!(
        decide(&settings, ask, at(0, 23 * 60, &[])).why,
        Some(Why::Quiet)
    );
    ask.engaged = true;
    assert_eq!(
        decide(&settings, ask, at(0, 23 * 60, &[])).reach,
        Reach::Now
    );
}

#[test]
fn quiet_hours_wrap_past_midnight_and_hold_only_inside_the_window() {
    let settings = Settings {
        quiet: Some(Window {
            from: 22 * 60,
            to: 7 * 60,
        }),
        ..Settings::default()
    };
    let routine = notice(Category::Routine, None);
    for (minute, held) in [
        (21 * 60 + 59, false),
        (22 * 60, true),
        (3 * 60, true),
        (7 * 60, false),
    ] {
        let reach = decide(&settings, routine, at(0, minute, &[])).reach;
        assert_eq!(reach == Reach::Held, held, "minute {minute}");
    }
}

#[test]
fn the_budget_sends_the_rest_to_the_digest_and_frees_up_after_an_hour() {
    let settings = Settings {
        budget: Budget {
            per_hour: Some(2),
            per_day: Some(3),
        },
        ..Settings::default()
    };
    let routine = notice(Category::Routine, None);
    let now = 10 * 3_600_000;
    let first = decide(&settings, routine, at(now, 600, &[]));
    assert_eq!((first.reach, first.counts), (Reach::Now, true));
    let two = [now - 5 * MINUTE, now - MINUTE];
    let past = decide(&settings, routine, at(now, 600, &two));
    assert_eq!((past.reach, past.why), (Reach::Held, Some(Why::Budget)));
    // A stop is never counted or held.
    let stop = decide(
        &settings,
        notice(Category::Escalation, Some(Level::Stop)),
        at(now, 600, &two),
    );
    assert_eq!((stop.reach, stop.counts), (Reach::Now, false));
    // An hour on, the hour has room, but the day's three are used.
    let three = [now - 3 * 3_600_000, now - 5 * MINUTE, now - MINUTE];
    let later = now + 3_600_000;
    assert_eq!(
        decide(&settings, routine, at(later, 660, &two)).reach,
        Reach::Now
    );
    assert_eq!(
        decide(&settings, routine, at(later, 660, &three)).why,
        Some(Why::Budget)
    );
}

#[test]
fn notifications_off_globally_or_for_the_bot_reach_no_one() {
    let off = Settings {
        notify: false,
        ..Settings::default()
    };
    let stop = notice(Category::Escalation, Some(Level::Stop));
    assert_eq!(decide(&off, stop, at(0, 0, &[])).why, Some(Why::Off));
    let bot_off = Notice {
        bot_on: false,
        ..stop
    };
    assert_eq!(
        decide(&Settings::default(), bot_off, at(0, 0, &[])).why,
        Some(Why::BotOff)
    );
}

#[test]
fn settings_that_cannot_hold_say_why() {
    let bad = [
        Settings {
            quiet: Some(Window { from: 600, to: 600 }),
            ..Settings::default()
        },
        Settings {
            budget: Budget {
                per_hour: Some(0),
                per_day: None,
            },
            ..Settings::default()
        },
        Settings {
            spend: SpendAlerts {
                factor: 1,
                ..SpendAlerts::default()
            },
            ..Settings::default()
        },
    ];
    for settings in &bad {
        assert!(settings::check(settings).is_err(), "{settings:?}");
    }
    assert!(settings::check(&Settings::default()).is_ok());
    let stored: Settings = serde_json::from_value(json!({ "dnd": true })).unwrap_or_default();
    assert!(
        stored.dnd && stored.notify,
        "missing fields take their defaults"
    );
    assert_eq!(stored.budget.per_hour, Some(6));
}

#[test]
fn the_summary_counts_what_waited_and_names_who() {
    assert_eq!(summary_text(&[]), None);
    assert_eq!(
        summary_text(&["Builder"]).as_deref(),
        Some("While you were away: 1 update from Builder.")
    );
    assert_eq!(
        summary_text(&["Builder", "Scout", "Builder"]).as_deref(),
        Some("While you were away: 3 updates from Builder and Scout.")
    );
    assert_eq!(
        summary_text(&["A", "B", "C"]).as_deref(),
        Some("While you were away: 3 updates from A and 2 others.")
    );
}

#[test]
fn an_unusual_spend_rate_alerts_once_per_episode() {
    let rule = SpendAlerts::default();
    let usual = vec![200_000; 24];
    // $0.80 is under the $1 floor though 4× the usual $0.20: nothing.
    let quiet = spend::check(rule, 800_000, &usual, false);
    assert!(!quiet.alert && !quiet.episode);
    // $1.50 is 7.5×: an alert, and the episode starts.
    let first = spend::check(rule, 1_500_000, &usual, false);
    assert!(first.alert && first.episode);
    // Still unusual: no second alert.
    let again = spend::check(rule, 2_000_000, &usual, true);
    assert!(!again.alert && again.episode);
    // Back near the line but not under half of it: still the same episode.
    let hovering = spend::check(rule, 900_000, &usual, true);
    assert!(!hovering.alert && hovering.episode);
    // Calm again ends it, so the next run-up alerts.
    let calm = spend::check(rule, 100_000, &usual, true);
    assert!(!calm.episode);
    assert!(spend::check(rule, 1_500_000, &usual, calm.episode).alert);
    // Turned off, nothing.
    let off = SpendAlerts { on: false, ..rule };
    assert!(!spend::check(off, 9_000_000, &usual, false).alert);
}

#[test]
fn a_busy_bot_is_measured_against_its_own_usual_rate() {
    let rule = SpendAlerts::default();
    let busy = vec![3_000_000; 24];
    assert!(
        !spend::check(rule, 9_000_000, &busy, false).alert,
        "3× its $3 hour"
    );
    assert!(
        spend::check(rule, 16_000_000, &busy, false).alert,
        "over 5×"
    );
    assert_eq!(
        spend::alert_text(16_000_000, 3_000_000),
        "Spent $16.00 in the last hour, about 5× its usual $3.00 an hour."
    );
    assert_eq!(spend::median(&[1, 9, 3]), 3);
    assert_eq!(spend::median(&[]), 0);
}

fn routine_message(name: &str) -> Value {
    json!({ "type": "user_message", "text": "Check the deploy",
            "from_routine": { "id": "rt1", "name": name, "run": "run1", "label": name } })
}

#[test]
fn a_routine_that_speaks_and_a_long_job_are_notable_but_a_quiet_beat_is_not() {
    let raw = [
        routine_message("Deploy check"),
        json!({ "type": "reply_started", "reply": "r1", "model": "m" }),
        json!({ "type": "reply_finished", "reply": "r1", "text": "The deploy is red." }),
        json!({ "type": "user_message", "text": "beat",
                "from_routine": { "id": "hb", "name": "Heartbeat", "run": "run2",
                                  "label": "Heartbeat", "heartbeat": true } }),
        json!({ "type": "reply_started", "reply": "r2", "model": "m" }),
        json!({ "type": "reply_finished", "reply": "r2", "text": "[quiet]" }),
        json!({ "type": "job_started", "reply": "r3", "job": "j1", "name": "Build" }),
        json!({ "type": "job_finished", "job": "j1", "name": "Build", "content": "ok" }),
        json!({ "type": "job_started", "reply": "r3", "job": "j2", "name": "Lint" }),
        json!({ "type": "job_finished", "job": "j2", "name": "Lint", "content": "x",
                "is_error": true }),
    ];
    let events = events(&raw);
    let at_ms = [
        0,
        1,
        2,
        3,
        4,
        5,
        10,
        10 + 42 * MINUTE,
        50 * MINUTE,
        51 * MINUTE,
    ];
    let found: Vec<Option<(Category, String)>> = (0..events.len())
        .map(|i| notable(&events, &at_ms, i).map(|n| (n.category, n.text)))
        .collect();
    assert_eq!(
        found[2],
        Some((
            Category::Routine,
            "Deploy check: The deploy is red.".to_owned()
        ))
    );
    assert_eq!(found[5], None, "a quiet heartbeat says nothing");
    assert_eq!(
        found[7],
        Some((Category::Finished, "Build finished after 42m.".to_owned()))
    );
    assert_eq!(found[9], None, "a one-minute job isn't long");
}

#[test]
fn the_person_is_engaged_only_by_their_own_recent_words() {
    let events = events(&[
        json!({ "type": "user_message", "text": "Go" }),
        routine_message("Daily"),
    ]);
    assert!(engaged(&events, &[100 * MINUTE, 200 * MINUTE], 90 * MINUTE));
    assert!(!engaged(
        &events,
        &[100 * MINUTE, 200 * MINUTE],
        150 * MINUTE
    ));
}

#[test]
fn the_morning_brief_lists_what_finished_overnight_and_what_waits_with_one_tap_answers() {
    let raw = [
        json!({ "type": "user_message", "text": "Build it overnight" }),
        json!({ "type": "reply_started", "reply": "r1", "model": "m" }),
        json!({ "type": "job_started", "reply": "r1", "job": "j1", "name": "Release build" }),
        json!({ "type": "job_finished", "job": "j1", "name": "Release build", "content": "ok" }),
        json!({ "type": "approval_requested", "reply": "r1", "call_id": "c1", "name": "shell",
                "arguments": {} }),
        json!({ "type": "question_asked", "reply": "r1", "call_id": "q1", "question": "Ship?",
                "questions": [{ "prompt": "Ship it now?", "kind": "choice",
                                "options": [{ "label": "Now" }, { "label": "Tomorrow" }] }],
                "later": true }),
        json!({ "type": "question_deferred", "call_id": "q1", "by_bot": true }),
    ];
    let events = events(&raw);
    let night = 1_000 * MINUTE;
    let at_ms = [
        night - 60 * MINUTE,
        night - 59 * MINUTE,
        night - 58 * MINUTE,
        night + 120 * MINUTE,
        night + 121 * MINUTE,
        night + 122 * MINUTE,
        night + 122 * MINUTE,
    ];
    let seqs = [1, 2, 3, 4, 5, 6, 7];
    let bot = BotInput {
        agent: "a1",
        name: "Builder",
        conversation: "c-a1",
        events: &events,
        at_ms: &at_ms,
        seqs: &seqs,
        spent_micros: 2_100_000,
    };
    let today = vec![brief::Planned {
        agent: "a1".to_owned(),
        name: "Builder".to_owned(),
        routine: "Standup notes".to_owned(),
        at_ms: night + 600 * MINUTE,
    }];
    let made = brief::build(
        night,
        night + 480 * MINUTE,
        &[bot],
        today,
        Vec::new(),
        2_100_000,
    );
    let finished: Vec<(&str, i64)> = made
        .finished
        .iter()
        .map(|f| (f.text.as_str(), f.seq))
        .collect();
    assert_eq!(finished, vec![("Release build finished after 2h 58m.", 4)]);
    let waiting: Vec<(&str, &str, Option<&str>, Vec<String>)> = made
        .waiting
        .iter()
        .map(|w| {
            (
                w.kind.as_str(),
                w.call_id.as_str(),
                w.answer.as_deref(),
                w.options.clone(),
            )
        })
        .collect();
    assert_eq!(
        waiting,
        vec![
            ("approval", "c1", Some("approval"), vec![]),
            (
                "question",
                "q1",
                Some("choice"),
                vec!["Now".to_owned(), "Tomorrow".to_owned()]
            ),
        ]
    );
    let time = |ms: i64| format!("t{}", (ms - night) / MINUTE);
    let text = brief::text(&made, &time);
    assert!(text.starts_with("Since t0:"), "{text}");
    assert!(
        text.contains("- Builder: Release build finished after 2h 58m."),
        "{text}"
    );
    assert!(text.contains("- Builder: Standup notes at t600"), "{text}");
    assert!(text.ends_with("Spent $2.10 (Builder $2.10)."), "{text}");
    assert_eq!(
        brief::headline(&made),
        "1 finished, 2 waiting on you, 1 routine today, $2.10 spent"
    );
}
