// SPDX-License-Identifier: Apache-2.0
//! `activity()` (`server.ts:399`-`:403`): one note per elided read, before that
//! read's events, from the connection's start to the end-of-body flush.

use super::core;
use std::sync::Arc;

use crate::session::testing::Fake;

/// One activity note, as the tenant's log records it.
fn notes(count: usize) -> Vec<String> {
    vec!["note:transport.activity".to_owned(); count]
}

fn receive(json: &str) -> Vec<String> {
    vec![format!("receive:{json}")]
}

/// Runs the chunks through a tracing tenant and returns its interleaved log.
fn trace_of(chunks: &[&[u8]]) -> Vec<String> {
    let mut server = core(&[]);
    let tenant = Arc::new(Fake::tracing());
    server.subscribe(tenant.clone()).expect("tenant");
    for chunk in chunks {
        let outcome = server.chunk(chunk);
        assert_eq!(outcome.failed, None);
    }
    tenant.trace()
}

/// An envelope with five strings (`id`, `e`, `type`, `t`, `data`) and no
/// session, so no tenant has to own it.
const SMALL: &[u8] = b"data: {\"id\":\"e\",\"type\":\"t\",\"data\":{}}\n\n";

/// A delta envelope: nine strings, so nineteen pieces.
fn delta_text(session: &str, text: &str) -> String {
    format!(
        "data: {{\"id\":\"e1\",\"type\":\"session.text.delta\",\"data\":{{\"sessionID\":\"{session}\",\"text\":\"{text}\"}}}}\n\n"
    )
}

/// (the rule, its chunks, the expected trace as segments).
type Row<'a> = (&'a str, Vec<&'a [u8]>, Vec<Vec<String>>);

#[test]
fn activity_is_one_note_per_elided_piece_in_read_order() {
    // The elider emits at every quote boundary, so the SDK's reads are finer
    // than the body chunks: each string is an opening piece (the outside text
    // plus the quote) and a content piece, and a tail piece closes the block.
    // Every read is one activity note, before that piece's events.
    let small = String::from_utf8(SMALL.to_vec()).expect("ASCII");
    let small_json = r#"{"id":"e","type":"t","data":{}}"#;
    let one = delta_text("a", "one");
    let two = delta_text("a", "two");
    let both_small = small.clone() + &small;
    let both = one.clone() + &two;
    let first_json =
        r#"{"id":"e1","type":"session.text.delta","data":{"sessionID":"a","text":"one"}}"#;
    let second_json =
        r#"{"id":"e1","type":"session.text.delta","data":{"sessionID":"a","text":"two"}}"#;

    let table: &[Row<'_>] = &[
        (
            "five strings are eleven pieces",
            vec![SMALL],
            vec![notes(11), receive(small_json)],
        ),
        (
            "two events in one chunk: the second starts after the first's tail",
            vec![both_small.as_bytes()],
            // The first event's tail and the second's first string are one
            // outside piece, so the second run has ten notes.
            vec![
                notes(11),
                receive(small_json),
                notes(10),
                receive(small_json),
            ],
        ),
        (
            "a chunk that ends inside a string makes no activity of its own",
            vec![
                b"data: {\"i",
                b"d",
                b"\":\"e\",\"type\":\"t\",\"data\":{}}\n\n",
            ],
            vec![notes(11), receive(small_json)],
        ),
        (
            "each delta is nineteen pieces",
            vec![one.as_bytes()],
            vec![notes(19), receive(first_json)],
        ),
        (
            "two deltas in one chunk",
            vec![both.as_bytes()],
            vec![
                notes(19),
                receive(first_json),
                // The first delta's tail and the second's first string are one
                // outside piece.
                notes(18),
                receive(second_json),
            ],
        ),
    ];
    for (rule, chunks, expected) in table {
        assert_eq!(trace_of(chunks), expected.concat(), "{rule}");
    }
}

#[test]
fn the_connections_start_and_the_end_flush_count_as_activity() {
    let mut server = core(&[]);
    let a = Arc::new(Fake::tracing());
    server.subscribe(a.clone()).expect("tenant");
    // `activity()` before the first read (`server.ts:407`).
    server.activity();
    assert_eq!(a.trace(), notes(1));

    // The elider's flush is a read like any other, so it counts as activity,
    // even when the block it completes is malformed.
    let mut server = core(&[]);
    let b = Arc::new(Fake::tracing());
    server.subscribe(b.clone()).expect("tenant");
    server.chunk(b"data: \"ab");
    assert_eq!(
        server.end().failed.map(|error| error.code()),
        Some(Some("MalformedResponse"))
    );
    assert_eq!(b.trace(), notes(2));
}
