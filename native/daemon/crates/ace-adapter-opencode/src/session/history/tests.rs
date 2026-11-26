// SPDX-License-Identifier: Apache-2.0
//! The history refresh's paging (`history.ts`): the head it stops at, the
//! repeated cursor, the page limit, the message checks, and a delivery that
//! fails before the head moves.

use super::{Failure, HistoryError, HistoryReader, Step};
use crate::session::http::Reply;
use ace_json::{Value, json};

/// A delivery that cannot fail.
type Delivered = Result<(), ()>;

fn reply(body: Value) -> Reply {
    Reply::parse(true, &ace_json::to_string(&body))
}

fn page(ids: &[&str], next: Option<&str>) -> Value {
    json!({
        "data": ids
            .iter()
            .map(|id| json!({ "id": id, "type": "assistant" }))
            .collect::<Vec<_>>(),
        "cursor": { "next": next },
    })
}

fn ids(delivered: &[Value]) -> Vec<String> {
    delivered
        .iter()
        .map(|message| {
            message
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        })
        .collect()
}

#[test]
fn a_first_read_walks_from_the_newest_page_to_the_oldest() {
    let mut history = HistoryReader::new();
    let (mut read, first) = history.begin("s");
    assert_eq!(
        first,
        Step::Request(json!({ "sessionID": "s", "limit": 128, "order": "desc" }))
    );

    let mut delivered = Vec::new();
    let next = history
        .step(
            &mut read,
            &reply(page(&["m3", "m2"], Some("c1"))),
            &mut |m: &Value| -> Delivered {
                delivered.push(m.clone());
                Ok(())
            },
        )
        .expect("a page");
    assert_eq!(
        next,
        Step::Request(json!({ "sessionID": "s", "limit": 128, "cursor": "c1" }))
    );
    assert_eq!(ids(&delivered), ["m3", "m2"]);

    assert_eq!(
        history
            .step(
                &mut read,
                &reply(page(&["m1"], None)),
                &mut |m: &Value| -> Delivered {
                    delivered.push(m.clone());
                    Ok(())
                },
            )
            .expect("the last page"),
        Step::Done
    );
    assert_eq!(ids(&delivered), ["m3", "m2", "m1"]);

    // The head is the newest identity read, so the next pass stops at m3.
    let (mut second, _) = history.begin("s");
    let mut fresh = Vec::new();
    history
        .step(
            &mut second,
            &reply(page(&["m4", "m3", "m2"], None)),
            &mut |m: &Value| -> Delivered {
                fresh.push(m.clone());
                Ok(())
            },
        )
        .expect("a page");
    assert_eq!(ids(&fresh), ["m4", "m3"], "the head stops the read");
}

#[test]
fn a_read_refuses_a_repeated_cursor_and_the_page_limit() {
    let mut history = HistoryReader::new();
    let (mut read, _) = history.begin("s");
    history
        .step(
            &mut read,
            &reply(page(&[], Some("c1"))),
            &mut |_: &Value| Ok::<(), ()>(()),
        )
        .expect("a page");
    assert_eq!(
        history.step(
            &mut read,
            &reply(page(&[], Some("c1"))),
            &mut |_: &Value| { Ok::<(), ()>(()) }
        ),
        Err(Failure::History(HistoryError::RepeatedCursor))
    );

    let mut history = HistoryReader::new();
    let (mut read, _) = history.begin("s");
    for index in 0..512 {
        let next = format!("c{index}");
        let step = history.step(
            &mut read,
            &reply(page(&[], Some(&next))),
            &mut |_: &Value| Ok::<(), ()>(()),
        );
        if index < 511 {
            assert!(step.is_ok(), "{index}: {step:?}");
        } else {
            assert_eq!(step, Err(Failure::History(HistoryError::PageLimit)));
        }
    }
}

#[test]
fn a_message_without_an_identity_or_a_type_fails_the_read() {
    let mut history = HistoryReader::new();
    let (mut read, _) = history.begin("s");
    assert_eq!(
        history.step(&mut read, &reply(page(&[""], None)), &mut |_: &Value| {
            Ok::<(), ()>(())
        }),
        Err(Failure::History(HistoryError::MessageIdentity))
    );
    assert_eq!(
        history.step(
            &mut read,
            &reply(json!({ "data": [{ "id": "m1" }], "cursor": {} })),
            &mut |_: &Value| Ok::<(), ()>(())
        ),
        Err(Failure::History(HistoryError::Envelope(
            "event failed its envelope check: message".to_owned()
        )))
    );
}

#[test]
fn a_failed_delivery_stops_the_read_before_its_head_moves() {
    let mut history = HistoryReader::new();
    let (mut read, _) = history.begin("s");
    let failed = history.step(
        &mut read,
        &reply(page(&["m2", "m1"], None)),
        &mut |message: &Value| {
            if message.get("id").and_then(Value::as_str) == Some("m1") {
                return Err("the frame was refused");
            }
            Ok(())
        },
    );
    assert_eq!(failed, Err(Failure::Delivery("the frame was refused")));

    // m2 was never committed as the head: the next read still walks from the top.
    let (mut second, first) = history.begin("s");
    assert_eq!(
        first,
        Step::Request(json!({ "sessionID": "s", "limit": 128, "order": "desc" }))
    );
    let mut delivered = Vec::new();
    history
        .step(
            &mut second,
            &reply(page(&["m2"], None)),
            &mut |m: &Value| {
                delivered.push(m.clone());
                Ok::<(), ()>(())
            },
        )
        .expect("a page");
    assert_eq!(ids(&delivered), ["m2"]);
}
