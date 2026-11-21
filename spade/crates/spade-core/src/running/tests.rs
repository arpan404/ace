use super::*;
use crate::event::{Event, FailureKind, Known};

use State::{Idle, Paused, Sleeping, Updating, Waiting, Working};

#[test]
fn a_node_reads_the_strongest_of_its_own_state_and_anything_under_it() {
    let cases = [
        (Idle, Working, Working),
        (Idle, Waiting, Waiting),
        (Working, Waiting, Waiting),
        (Waiting, Working, Waiting),
        (Idle, Sleeping, Sleeping),
        (Sleeping, Working, Working),
        (Working, Idle, Working),
        (Idle, Idle, Idle),
        // Paused sits below sleeping and above idle (ADR 0200 §6.2).
        (Paused, Idle, Paused),
        (Idle, Paused, Paused),
        (Paused, Sleeping, Sleeping),
        (Paused, Working, Working),
        (Paused, Waiting, Waiting),
        (Sleeping, Paused, Sleeping),
    ];
    for (own, under, expected) in cases {
        assert_eq!(
            rolled(own, under),
            expected,
            "{own:?} with {under:?} under it"
        );
    }
}

#[test]
fn a_paused_bot_reads_paused_unless_it_still_waits_on_the_person_or_is_being_stopped() {
    let cases = [
        // A question its stopped work left open still reads waiting.
        (Waiting, true, Waiting),
        // Something of it is still being stopped (an ace child until ace confirms).
        (Working, true, Working),
        // Its held wakes don't make it read sleeping: they won't fire.
        (Sleeping, true, Paused),
        (Idle, true, Paused),
        (Sleeping, false, Sleeping),
        (Idle, false, Idle),
        (Waiting, false, Waiting),
    ];
    for (own, paused, expected) in cases {
        assert_eq!(held(own, paused), expected, "{own:?}, paused {paused}");
    }
}

#[test]
fn a_bot_being_updated_reads_updating_and_counts_as_working_never_at_rest() {
    let cases = [
        (Idle, Updating),
        (Sleeping, Updating),
        // A paused bot rolled back reads updating while the rollback is applied.
        (Paused, Updating),
        (Working, Working),
        (Waiting, Waiting),
    ];
    for (own, expected) in cases {
        assert_eq!(updating(own, true), expected, "{own:?} being updated");
        assert_eq!(updating(own, false), own, "{own:?} not being updated");
    }
    assert_eq!(reads(Updating, None), Reads::Working);
    assert_eq!(reads(Updating, Some("it broke")), Reads::Working);
    // A parent with an updating worker under it reads working's rank, never idle or paused.
    assert_eq!(rolled(Idle, Updating), Updating);
    assert_eq!(rolled(Paused, Updating), Updating);
    assert_eq!(rolled(Updating, Waiting), Waiting);
}

fn facts(id: &str, name: &str, state: State) -> Facts {
    Facts {
        code: CodeUse::default(),
        id: id.to_owned(),
        name: name.to_owned(),
        kind: if id == "main" { "main" } else { "bot" }.to_owned(),
        conversation: format!("c_{id}"),
        avatar: serde_json::Value::Null,
        state,
        status: None,
        waiting_for: None,
        failure: None,
        paused_at_ms: None,
        archived: false,
        uses: Uses::default(),
        spend: Spend::default(),
        network: Network::default(),
        next_wake: None,
        workers: Vec::new(),
        development: false,
    }
}

#[test]
fn rows_sort_by_needs_you_working_failed_sleeping_paused_then_idle_and_by_name_within() {
    let mut failed = facts("b_f", "Fares", Idle);
    failed.failure = Some("its endpoint refused the key".to_owned());
    let mut paused = facts("b_p", "Post", Paused);
    paused.paused_at_ms = Some(5);
    let rows = rows(vec![
        facts("main", "Spade", Idle),
        paused,
        facts("b_s", "Sleeper", Sleeping),
        failed,
        facts("b_w2", "writer", Working),
        facts("b_w1", "Watcher", Working),
        facts("b_a", "Asker", Waiting),
    ]);
    let order: Vec<(&str, Reads)> = rows.iter().map(|r| (r.name.as_str(), r.reads)).collect();
    assert_eq!(
        order,
        vec![
            ("Asker", Reads::NeedsYou),
            ("Watcher", Reads::Working),
            ("writer", Reads::Working),
            ("Fares", Reads::Failed),
            ("Sleeper", Reads::Sleeping),
            ("Post", Reads::Paused),
            ("Spade", Reads::Idle),
        ]
    );
}

#[test]
fn a_row_says_its_state_in_words() {
    let mut working = facts("b_1", "Fares", Working);
    working.status = Some("Checking fares".to_owned());
    let mut asking = facts("b_2", "Mail", Waiting);
    asking.waiting_for = Some("question".to_owned());
    let mut sleeping = facts("b_3", "Brief", Sleeping);
    sleeping.status = Some("Sleeping until 7:00: the morning brief".to_owned());
    let mut failed = facts("b_4", "Flights", Idle);
    failed.failure = Some("its endpoint refused the key".to_owned());
    let mut paused = facts("b_5", "Post", Paused);
    paused.paused_at_ms = Some(1);
    let said: Vec<String> = rows(vec![working, asking, sleeping, failed, paused])
        .into_iter()
        .map(|r| r.doing)
        .collect();
    assert_eq!(
        said,
        vec![
            "Waiting on you: a question",
            "Checking fares",
            "Failed: its endpoint refused the key",
            "Sleeping until 7:00: the morning brief",
            "Paused",
        ]
    );
}

#[test]
fn a_paused_bot_offers_resume_a_running_one_stop_and_pause_and_an_archived_one_unarchive() {
    let mut paused_waiting = facts("b_1", "Mail", Waiting);
    paused_waiting.paused_at_ms = Some(1);
    let mut paused = facts("b_2", "Post", Paused);
    paused.paused_at_ms = Some(1);
    let working = facts("b_3", "Fares", Working);
    let idle = facts("b_4", "Notes", Idle);
    let mut serving = facts("b_5", "Site", Idle);
    serving.uses.services = 1;
    let mut archived = facts("b_6", "Undone", Idle);
    archived.archived = true;
    let actions: Vec<(String, Vec<&str>)> = rows(vec![
        paused_waiting,
        paused,
        working,
        idle,
        serving,
        archived,
    ])
    .into_iter()
    .map(|r| (r.name, r.actions))
    .collect();
    assert_eq!(
        actions,
        vec![
            ("Mail".to_owned(), vec!["stop", "resume"]),
            ("Fares".to_owned(), vec!["stop", "pause"]),
            ("Post".to_owned(), vec!["resume"]),
            ("Notes".to_owned(), vec!["pause"]),
            ("Site".to_owned(), vec!["stop", "pause"]),
            ("Undone".to_owned(), vec!["pause", "unarchive"]),
        ]
    );
}

#[test]
fn network_today_adds_up_only_today_s_allowed_bytes_and_names_hosts_by_bytes() {
    let entry = |at_ms, host, allowed, sent, received| Egress {
        at_ms,
        host,
        allowed,
        sent,
        received,
    };
    let network = network_today(
        [
            entry(50, "old.example", true, 1_000, 1_000),
            entry(100, "api.fares.example", true, 10, 200),
            entry(110, "cdn.example", true, 5, 900),
            entry(120, "api.fares.example", true, 10, 800),
            entry(130, "blocked.example", false, 0, 0),
        ],
        100,
    );
    assert_eq!(
        network,
        Network {
            sent_bytes: 25,
            received_bytes: 1_900,
            hosts: vec!["api.fares.example".to_owned(), "cdn.example".to_owned()],
            refused: 1,
        }
    );
}

fn failed(kind: FailureKind, error: &str) -> Event {
    Event::Known(Known::ReplyFailed {
        reply: "r1".into(),
        text: String::new(),
        error: error.into(),
        kind,
        endpoint: None,
    })
}

#[test]
fn a_failure_is_read_only_while_the_latest_reply_ended_failing() {
    let finished = Event::Known(Known::ReplyFinished {
        reply: "r2".into(),
        text: "ok".into(),
        input_tokens: None,
        output_tokens: None,
        cost_micros: 0,
    });
    let key = failed(FailureKind::Key, "401");
    assert_eq!(
        failure([&key]),
        Some("its endpoint refused the key".to_owned())
    );
    assert_eq!(failure([&key, &finished]), None, "a later reply worked");
    assert_eq!(
        failure([
            &finished,
            &failed(FailureKind::Other, "  the fares\n site  refused ")
        ]),
        Some("the fares site refused".to_owned())
    );
    assert_eq!(
        failure([&failed(FailureKind::Cap, "cap")]),
        None,
        "caps are retired"
    );
    assert_eq!(failure(std::iter::empty::<&Event>()), None);
}

#[test]
fn the_sooner_of_two_wakes_is_next() {
    let at = |at_ms, what: &str| {
        Some(NextWake {
            at_ms,
            what: what.to_owned(),
        })
    };
    assert_eq!(sooner(at(10, "wake"), at(5, "routine")), at(5, "routine"));
    assert_eq!(sooner(at(10, "wake"), None), at(10, "wake"));
    assert_eq!(sooner(None, at(7, "routine")), at(7, "routine"));
}

fn code_ran(component: &str, run_ms: u64, cut: Option<&str>) -> Event {
    Event::Known(Known::CodeRan {
        reply: "r".to_owned(),
        call_id: "c".to_owned(),
        component: component.to_owned(),
        run_ms,
        fuel: 10,
        peak_memory: run_ms * 1000,
        cut: cut.map(str::to_owned),
        reached: Vec::new(),
        calls: Vec::new(),
    })
}

#[test]
fn code_calls_are_summed_and_three_failures_in_a_row_mark_a_component_failed() {
    let events = vec![
        code_ran("fares", 5, None),
        code_ran("fares", 7, Some("trap")),
        code_ran("fares", 1, Some("deadline")),
        code_ran("dates", 2, Some("stopped")),
        code_ran("fares", 3, Some("trap")),
    ];
    let used = code_in(&events);
    assert_eq!(used.calls, 5);
    assert_eq!(used.run_ms, 18);
    assert_eq!(used.fuel, 50);
    assert_eq!(used.peak_memory, 7000);
    assert_eq!(used.cut_off, 4);
    assert_eq!(used.failing.len(), 1);
    assert_eq!(used.failing[0].component, "fares");
    assert!(used.failing[0].reason.contains("failed on its own"));
    // A call that answers again clears it; Stop is never the code's own failure.
    let mut later = events.clone();
    later.push(code_ran("fares", 1, None));
    later.extend([
        code_ran("dates", 1, Some("stopped")),
        code_ran("dates", 1, Some("stopped")),
    ]);
    assert!(code_in(&later).failing.is_empty());
}
