// SPDX-License-Identifier: Apache-2.0
//! The SDK's framing rules, one row each, plus the two bounds. Line references
//! are to `@opencode/client` 2.0.22's `sse` generator
//! (`dist/chunks/service-contender-50fct660.js:81`-`:141`) and to
//! `observation.ts:54`-`:80`.

use super::{EventStream, Framer, MAX_EVENT_BYTES, MAX_SSE_EVENT_UNITS, Step};
use crate::session::error::StreamError;

/// Feeds each chunk, ends the stream, and returns the serialized events.
fn run(chunks: &[&[u8]]) -> Result<Vec<String>, StreamError> {
    let mut stream = EventStream::new();
    let mut steps = Vec::new();
    for chunk in chunks {
        stream.push(chunk, &mut steps)?;
    }
    stream.end(&mut steps)?;
    Ok(events(&steps))
}

/// The events in a run's steps, and how many activity notes preceded them.
fn events(steps: &[Step]) -> Vec<String> {
    steps
        .iter()
        .filter_map(|step| match step {
            Step::Event(value) => Some(ace_json::to_string(value)),
            Step::Activity => None,
        })
        .collect()
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

/// (the rule, its chunks, the events' serialized JSON).
type Row<'a> = (&'a str, &'a [&'a [u8]], &'a [&'a str]);

#[test]
fn the_sdk_framing_rules() {
    let table: &[Row<'_>] = &[
        (
            "a block split on a blank line, one JSON.parse per event",
            &[b"data: {\"a\":1}\n\n"],
            &[r#"{"a":1}"#],
        ),
        (
            "decode(stream: true): a chunk boundary inside the JSON",
            &[b"data: {\"a\":", b"1}\n\n"],
            &[r#"{"a":1}"#],
        ),
        (
            "a chunk boundary between the boundary's two newlines",
            &[b"data: {\"a\":1}\n", b"\n"],
            &[r#"{"a":1}"#],
        ),
        (
            "CRLF becomes one LF",
            &[b"data: {\"a\":1}\r\n\r\n"],
            &[r#"{"a":1}"#],
        ),
        (
            "a lone CR becomes one LF",
            &[b"data: {\"a\":1}\r\r"],
            &[r#"{"a":1}"#],
        ),
        (
            "a CRLF split across chunks is still one LF",
            &[b"data: {\"a\":1}\r", b"\n\r\n"],
            &[r#"{"a":1}"#],
        ),
        (
            "a trailing CR is held while the chunk is not the end",
            &[b"data: {\"a\":1}\r", b"\n\r", b"\n"],
            &[r#"{"a":1}"#],
        ),
        (
            "a trailing CR is a lone CR at the end",
            &[b"data: {\"a\":1}\r"],
            &[r#"{"a":1}"#],
        ),
        (
            "two held CRs at the end are two LFs",
            &[b"data: {\"a\":1}\r", b"\r"],
            &[r#"{"a":1}"#],
        ),
        (
            "a final non-empty buffer gets its blank line",
            &[b"data: {\"a\":1}"],
            &[r#"{"a":1}"#],
        ),
        (
            "two events in one chunk",
            &[b"data: 1\n\ndata: 2\n\n"],
            &["1", "2"],
        ),
        (
            "lines that do not start with data: are ignored",
            &[b": keep-alive\nevent: message\nid: 1\ndata: 2\nretry: 5\n\n"],
            &["2"],
        ),
        (
            "data: needs no space, and slice(5).trimStart() trims",
            &[b"data:{\"a\":1}\n\ndata:   {\"b\":2}\n\n"],
            &[r#"{"a":1}"#, r#"{"b":2}"#],
        ),
        (
            "data lines join with a newline",
            &[b"data: {\"a\":\ndata: 1}\n\n"],
            &[r#"{"a":1}"#],
        ),
        (
            "an empty data line still joins",
            &[b"data:\ndata: 1\n\n"],
            &["1"],
        ),
        (
            "an empty data string yields nothing",
            &[b"data:\n\ndata:   \n\n"],
            &[],
        ),
        (
            "a block with no data line yields nothing",
            &[b"event: ping\n\n"],
            &[],
        ),
        (
            "trimStart is JavaScript's \\s, so it strips a BOM",
            &[b"data: \xef\xbb\xbf1\n\n"],
            &["1"],
        ),
        (
            "an astral character survives the decode",
            &["data: \"😀\"\n\n".as_bytes()],
            &["\"😀\""],
        ),
        (
            "an astral character split across chunks survives",
            &[b"data: \"\xf0\x9f", b"\x98\x80\"\n\n"],
            &["\"😀\""],
        ),
        (
            "an invalid sequence decodes as U+FFFD",
            &[b"data: \"\xf0\x9f\x98\"\n\n"],
            &["\"\u{fffd}\""],
        ),
        (
            "one leading BOM is dropped at the stream's start",
            &[b"\xef\xbb\xbfdata: 1\n\n"],
            &["1"],
        ),
        (
            "only the stream's first character is checked: a second BOM stays",
            &[b"\xef\xbb\xbf\xef\xbb\xbfdata: 1\n\n"],
            &[],
        ),
        (
            "a BOM in a later chunk is not the stream's start",
            &[b"data: 1\n\n", b"\xef\xbb\xbfdata: 2\n\n"],
            &["1"],
        ),
        (
            "a truncated sequence at the end decodes as U+FFFD outside the JSON",
            &[b"data: 1\n\n\xf0\x9f"],
            &["1"],
        ),
    ];
    for (rule, chunks, expected) in table {
        assert_eq!(run(chunks), Ok(strings(expected)), "{rule}");
    }
}

#[test]
fn a_block_the_json_parser_refuses_fails_the_stream() {
    assert_eq!(
        run(&[b"data: {\"a\":\n\n"]).map_err(|error| error.code()),
        Err(Some("MalformedResponse"))
    );
    // U+0085 is not JavaScript whitespace, so it stays in the data.
    assert_eq!(
        run(&[b"data: \xc2\x851\n\n"]).map_err(|error| error.code()),
        Err(Some("MalformedResponse"))
    );
}

#[test]
fn events_before_a_malformed_one_are_already_parsed() {
    let mut stream = EventStream::new();
    let mut steps = Vec::new();
    let result = stream.push(b"data: 1\n\ndata: nope\n\n", &mut steps);
    assert_eq!(
        result.map_err(|error| error.code()),
        Err(Some("MalformedResponse"))
    );
    assert_eq!(events(&steps), vec!["1"]);
}

/// One event whose emitted bytes since its blank line are exactly `total`: a
/// one-byte JSON payload and a filler line the elider passes untouched, so the
/// bound is what the test measures.
fn padded_event(total: usize, ending: &str) -> Vec<u8> {
    let head = "data: 1\n: ";
    let fill = total - head.len() - ending.len();
    let event = format!("{head}{}{ending}", "x".repeat(fill)).into_bytes();
    assert_eq!(event.len(), total);
    event
}

#[test]
fn the_event_byte_bound_counts_since_the_last_blank_line() {
    // At the bound: 1 MiB passes, one more byte fails.
    let at = padded_event(MAX_EVENT_BYTES, "\n\n");
    assert_eq!(at.len(), MAX_EVENT_BYTES);
    assert_eq!(run(&[&at]).map(|events| events.len()), Ok(1));
    let over = padded_event(MAX_EVENT_BYTES + 1, "\n\n");
    assert_eq!(run(&[&over]), Err(StreamError::EventBytes));
    assert_eq!(
        StreamError::EventBytes.to_string(),
        "Transport: OpenCode event exceeds byte limit"
    );

    // The blank line resets the count: two events at the bound both fit.
    let mut both = at.clone();
    both.extend_from_slice(&at);
    assert_eq!(run(&[&both]).map(|events| events.len()), Ok(2));

    // A CR takes a byte although it never closes a line.
    let crlf_at = padded_event(MAX_EVENT_BYTES, "\r\n\r\n");
    assert_eq!(crlf_at.len(), MAX_EVENT_BYTES);
    assert_eq!(run(&[&crlf_at]).map(|events| events.len()), Ok(1));
    assert_eq!(
        run(&[&padded_event(MAX_EVENT_BYTES + 1, "\r\n\r\n")]),
        Err(StreamError::EventBytes)
    );
}

#[test]
fn elision_keeps_a_heavy_event_under_the_byte_bound() {
    let image = format!("data:image/png;base64,{}", "QUJD".repeat(300_000));
    let body = format!("{{\"image\":\"{image}\"}}");
    let chunk = format!("data: {body}\n\n");
    assert!(
        chunk.len() > MAX_EVENT_BYTES,
        "the raw event is over the bound"
    );
    let events = run(&[chunk.as_bytes()]).expect("the elided event fits");
    assert_eq!(events.len(), 1);
    let parsed: ace_json::Value = ace_json::parse(&events[0]).expect("text is JSON");
    let kept = parsed
        .get("image")
        .and_then(ace_json::Value::as_str)
        .expect("the image field is a string");
    assert!(
        kept.starts_with("[ace: ") && kept.ends_with(" bytes of data:image/png;base64 elided]"),
        "{kept}"
    );
}

#[test]
fn the_sdk_buffer_bound_counts_utf16_units() {
    // The bound is `buffer.length`, UTF-16 units: 8,388,608 emoji are exactly
    // 16,777,216 units, and one more emoji is 16,777,218.
    assert_eq!(MAX_SSE_EVENT_UNITS, 16 * 1024 * 1024);
    let mut framer = Framer::default();
    let mut events = Vec::new();
    let at = "😀".repeat(MAX_SSE_EVENT_UNITS / 2);
    assert_eq!(at.encode_utf16().count(), MAX_SSE_EVENT_UNITS);
    assert_eq!(framer.push(at.as_bytes(), false, &mut events), Ok(()));

    // A fresh framer, so the "over" case is over on its own: counting code
    // points instead of UTF-16 units would let it pass.
    let mut over = Framer::default();
    let mut events = Vec::new();
    let too_many = format!("{}😀", "😀".repeat(MAX_SSE_EVENT_UNITS / 2));
    assert_eq!(
        over.push(too_many.as_bytes(), false, &mut events),
        Err(StreamError::SseEventTooLarge)
    );
    assert_eq!(
        StreamError::SseEventTooLarge.to_string(),
        "SseEventTooLarge"
    );
}

#[test]
fn the_sdk_buffer_bound_applies_to_the_final_chunk() {
    let mut framer = Framer::default();
    let mut events = Vec::new();
    let at = "😀".repeat(MAX_SSE_EVENT_UNITS / 2);
    assert_eq!(framer.push(at.as_bytes(), true, &mut events), Ok(()));
    let mut over = Framer::default();
    let mut events = Vec::new();
    let text = format!("{at}😀");
    assert_eq!(
        over.push(text.as_bytes(), true, &mut events),
        Err(StreamError::SseEventTooLarge)
    );
}

#[test]
fn a_chunk_that_trips_the_bound_delivers_only_the_piece_a_read_already_took() {
    // The elider emits piece 1 (the first event), the "x" string, piece 3 (the
    // second event), the "y" string, then a tail over the bound. The SDK's
    // transform enqueues them all in one task: a pending read takes piece 1,
    // the rest wait, and the throw errors the stream and drops the waiters.
    let chunk = format!(
        "data: 1\n\ndata: \"x\"\n\ndata: 2\n\ndata: \"y\"\n\n{}",
        "z".repeat(MAX_EVENT_BYTES + 2)
    );
    let mut stream = EventStream::new();
    let mut steps = Vec::new();
    let result = stream.push(chunk.as_bytes(), &mut steps);
    assert_eq!(result, Err(StreamError::EventBytes));
    assert_eq!(
        events(&steps),
        vec!["1"],
        "only the read piece is delivered"
    );
}

#[test]
fn a_stream_failure_names_the_error_the_type_script_surfaces() {
    // `reader.read()` rejects with the transform's error, which the SDK wraps
    // as ClientError("Transport", { cause }).
    let bound = StreamError::EventBytes;
    assert_eq!(bound.code(), Some("Transport"));
    assert_eq!(
        bound.message(),
        "Transport: OpenCode event exceeds byte limit"
    );

    // A malformed block is MalformedResponse with the parser's text after it.
    let error = run(&[b"data: nope\n\n"]).expect_err("malformed");
    assert_eq!(error.code(), Some("MalformedResponse"));
    let message = error.message();
    assert!(
        message.starts_with("MalformedResponse: ") && message.contains("at position"),
        "{message}"
    );
}

#[test]
fn the_sdk_bound_applies_per_piece_not_per_body_chunk() {
    // 16 Mi units of body in one chunk, in events small enough that the SDK's
    // buffer never holds more than one of them: every piece passes the bound.
    let one = format!("data: \"{}\"\n\n", " x".repeat(4_000));
    let count = (16 * 1024 * 1024) / one.len() + 64;
    let chunk = one.repeat(count);
    assert!(chunk.len() > 16 * 1024 * 1024, "the body is past the bound");
    let mut stream = EventStream::new();
    let mut steps = Vec::new();
    stream
        .push(chunk.as_bytes(), &mut steps)
        .expect("per piece");
    stream.end(&mut steps).expect("the flush");
    assert_eq!(events(&steps).len(), count);
}

#[test]
fn a_new_stream_starts_with_no_decoder_buffer_or_elider_state() {
    let mut stream = EventStream::new();
    let mut steps = Vec::new();
    stream
        .push(b"data: \"unterminated", &mut steps)
        .expect("a chunk with no boundary yet");
    assert!(events(&steps).is_empty());
    stream.reset();
    steps.clear();
    stream
        .push(b"data: 1\n\n", &mut steps)
        .expect("a fresh stream");
    assert_eq!(events(&steps), vec!["1"]);
}
