use serde_json::json;

use super::*;
use crate::event::{FromAgent, ReplyEnd};

fn call(id: &str, effects: Vec<Effect>) -> Event {
    let mut message = Event::user_message("");
    if let Event::Known(Known::UserMessage { from_agent, .. }) = &mut message {
        *from_agent = Some(FromAgent {
            id: "planner".into(),
            name: "Trip planner".into(),
            depth: 1,
            machine: None,
            contract: Some(Box::new(Request {
                call: id.into(),
                contract: "cheapest_fare".into(),
                input: json!({"from": "KTM", "to": "DEL", "month": "2027-01"}),
                effects,
            })),
        });
    }
    message
}

fn finished(reply: &str) -> Event {
    Event::Known(Known::ReplyFinished {
        reply: reply.into(),
        text: "Done.".into(),
        input_tokens: None,
        output_tokens: None,
        cost_micros: 0,
    })
}

fn returned(id: &str) -> Event {
    Event::Known(Known::ContractEnded {
        call: id.into(),
        ending: Ending::Returned {
            output: json!({"fare": 182}),
            untrusted: true,
        },
    })
}

fn open_calls(events: &[Event]) -> Vec<&str> {
    open(events).iter().map(|r| r.call.as_str()).collect()
}

#[test]
fn a_call_is_open_from_its_delivery_until_it_returns() {
    let mut events = vec![
        Event::user_message("Watch KTM to DEL"),
        Event::reply_started("r1", "m"),
        finished("r1"),
        call("c1", vec![Effect::Network]),
        Event::reply_started("r2", "m"),
    ];
    assert_eq!(open_calls(&events), vec!["c1"]);
    assert_eq!(open(&events)[0].effects, vec![Effect::Network]);
    assert_eq!(ended(&events, "c1"), None);
    events.push(returned("c1"));
    assert!(open_calls(&events).is_empty());
    events.push(finished("r2"));
    assert_eq!(
        ended(&events, "c1"),
        Some(Outcome::Returned {
            output: json!({"fare": 182}),
            untrusted: true
        })
    );
}

#[test]
fn a_call_that_steers_a_busy_turn_holds_the_rest_of_that_turn() {
    let events = vec![
        Event::user_message("Plan my week"),
        Event::reply_started("r1", "m"),
        call("c1", Vec::new()),
    ];
    assert_eq!(open_calls(&events), vec!["c1"]);
}

#[test]
fn a_turn_that_ends_without_returning_fails_the_call_and_holds_nothing_after() {
    let events = vec![
        call("c1", Vec::new()),
        Event::reply_started("r1", "m"),
        finished("r1"),
        Event::user_message("Now book a hotel"),
        Event::reply_started("r2", "m"),
    ];
    assert!(open_calls(&events).is_empty(), "the person's next turn isn't held");
    assert!(matches!(
        ended(&events, "c1"),
        Some(Outcome::Failed { problems }) if problems[0].contains("without returning")
    ));
}

#[test]
fn stopping_the_callee_stops_the_call() {
    let events = vec![
        call("c1", Vec::new()),
        Event::reply_started("r1", "m"),
        Event::reply_ended(ReplyEnd::Stopped, "r1", ""),
    ];
    assert!(matches!(
        ended(&events, "c1"),
        Some(Outcome::Stopped { .. })
    ));
    assert!(open_calls(&events).is_empty());
}

#[test]
fn a_stored_failure_ends_the_call_with_its_problems_and_counts_its_misfits() {
    let misfit = |n: usize| {
        Event::Known(Known::ContractMisfit {
            call: "c1".into(),
            problems: vec![format!("output.fare: is a number ({n})")],
        })
    };
    let events = vec![
        call("c1", Vec::new()),
        Event::reply_started("r1", "m"),
        misfit(1),
        misfit(2),
        misfit(3),
        Event::Known(Known::ContractEnded {
            call: "c1".into(),
            ending: Ending::Failed {
                problems: vec!["output.fare: is a number".into()],
            },
        }),
    ];
    assert_eq!(misfits(&events, "c1"), 3);
    assert_eq!(misfits(&events, "c2"), 0);
    assert_eq!(
        ended(&events, "c1"),
        Some(Outcome::Failed {
            problems: vec!["output.fare: is a number".into()]
        })
    );
}

#[test]
fn the_callee_reads_the_call_as_another_bots_request_and_the_caller_reads_a_contract_result() {
    let events = vec![call("c1", Vec::new())];
    let read = crate::context::messages(&events);
    let text = format!("{read:?}");
    assert!(text.contains("<contract_call from=\\\"Trip planner\\\""), "{text}");
    assert!(text.contains("not the person's"), "{text}");
    let result = result_text(
        "c1",
        "Flight watcher",
        "cheapest_fare",
        &Outcome::Returned {
            output: json!({"fare": 182}),
            untrusted: true,
        },
    );
    assert!(result.starts_with(
        "<contract_result call=\"c1\" bot=\"Flight watcher\" contract=\"cheapest_fare\" status=\"returned\" untrusted=\"true\">"
    ));
    assert_eq!(
        crate::context::job_result("c1", CONTRACT_CALL, &result, false),
        result
    );
}

#[test]
fn a_contract_event_round_trips_through_storage() {
    let ended = returned("c1");
    let json = ended.to_json();
    assert_eq!(json["type"], "contract_ended");
    assert_eq!(json["status"], "returned");
    assert_eq!(Event::from_json(json), ended);
    let delivered = call("c1", vec![Effect::Network]);
    assert_eq!(Event::from_json(delivered.to_json()), delivered);
}
