// SPDX-License-Identifier: Apache-2.0
//! The history refresh's paging (`history.ts`): the head it stops at, the
//! repeated cursor, the page limit and the message checks.

use super::{HistoryError, HistoryReader, Step};
use crate::session::http::Reply;
use ace_json::{Value, json};

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
            &mut |m| delivered.push(m.clone()),
        )
        .expect("a page");
    assert_eq!(
        next,
        Step::Request(json!({ "sessionID": "s", "limit": 128, "cursor": "c1" }))
    );
    assert_eq!(ids(&delivered), ["m3", "m2"]);

    assert_eq!(
        history
            .step(&mut read, &reply(page(&["m1"], None)), &mut |m| {
                delivered.push(m.clone())
            })
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
            &mut |m| fresh.push(m.clone()),
        )
        .expect("a page");
    assert_eq!(ids(&fresh), ["m4", "m3"], "the head stops the read");
}

#[test]
fn a_read_refuses_a_repeated_cursor_and_the_page_limit() {
    let mut history = HistoryReader::new();
    let (mut read, _) = history.begin("s");
    history
        .step(&mut read, &reply(page(&[], Some("c1"))), &mut |_| {})
        .expect("a page");
    assert_eq!(
        history.step(&mut read, &reply(page(&[], Some("c1"))), &mut |_| {}),
        Err(HistoryError::RepeatedCursor)
    );

    let mut history = HistoryReader::new();
    let (mut read, _) = history.begin("s");
    for index in 0..512 {
        let next = format!("c{index}");
        let step = history.step(&mut read, &reply(page(&[], Some(&next))), &mut |_| {});
        if index < 511 {
            assert!(step.is_ok(), "{index}: {step:?}");
        } else {
            assert_eq!(step, Err(HistoryError::PageLimit));
        }
    }
}

#[test]
fn a_message_without_an_identity_or_a_type_fails_the_read() {
    let mut history = HistoryReader::new();
    let (mut read, _) = history.begin("s");
    assert_eq!(
        history.step(&mut read, &reply(page(&[""], None)), &mut |_| {}),
        Err(HistoryError::MessageIdentity)
    );
    assert_eq!(
        history.step(
            &mut read,
            &reply(json!({ "data": [{ "id": "m1" }], "cursor": {} })),
            &mut |_| {}
        ),
        Err(HistoryError::Envelope(
            "event failed its envelope check: message".to_owned()
        ))
    );
}
