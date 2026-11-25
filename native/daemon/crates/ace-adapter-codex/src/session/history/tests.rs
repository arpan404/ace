use super::*;

fn json(text: &str) -> Value {
    ace_json::parse(text).expect("fixture parses")
}

fn request(effect: &Effect) -> (u64, String, Value) {
    match effect {
        Effect::Request {
            call,
            method,
            params,
            ..
        } => (*call, method.clone(), params.clone()),
        other => panic!("expected a request, got {other:?}"),
    }
}

fn page(turns: &str, next: Option<&str>) -> Value {
    let cursor = next
        .map(|next| format!(",\"nextCursor\":{next:?}"))
        .unwrap_or_default();
    json(&format!("{{\"data\":[{turns}]{cursor}}}"))
}

fn dropped(bytes: usize) -> String {
    format!(
        "Codex stdout reply dropped because its line exceeded the limit (at least {bytes} bytes)"
    )
}

#[test]
fn a_read_asks_for_the_newest_turns_newest_page_first() {
    let mut calls = Calls::new();
    let (read, effects) = HistoryRead::start("root-1", &mut calls);
    let (_, method, params) = request(&effects[0]);
    assert_eq!(method, "thread/turns/list");
    assert_eq!(
        params.get("threadId").and_then(Value::as_str),
        Some("root-1")
    );
    assert_eq!(params.get("limit").and_then(Value::as_f64), Some(4.0));
    assert_eq!(
        params.get("sortDirection").and_then(Value::as_str),
        Some("desc")
    );
    assert_eq!(
        params.get("itemsView").and_then(Value::as_str),
        Some("full")
    );
    assert!(params.get("cursor").is_none());
    assert!(read.awaits(0));
}

#[test]
fn two_pages_are_returned_oldest_first_and_stop_at_four_turns() {
    let mut calls = Calls::new();
    let (mut read, effects) = HistoryRead::start("root-1", &mut calls);
    let (first, _, _) = request(&effects[0]);
    let effects = read.settled(
        &mut calls,
        Ok(&page(r#"{"id":"t3"},{"id":"t2"},{"id":"t1"}"#, Some("c2"))),
    );
    let (_, _, params) = request(&effects[0]);
    // One turn is still owed, so the next page asks for one.
    assert_eq!(params.get("limit").and_then(Value::as_f64), Some(1.0));
    assert_eq!(params.get("cursor").and_then(Value::as_str), Some("c2"));
    let (second, _, _) = request(&effects[0]);
    read.settled(&mut calls, Ok(&page(r#"{"id":"t0"}"#, None)));
    let reply = read
        .outcome()
        .expect("the read ended")
        .as_ref()
        .expect("ok");
    let ids: Vec<&str> = reply
        .turns
        .iter()
        .map(|turn| turn.get("id").and_then(Value::as_str).unwrap_or_default())
        .collect();
    assert_eq!(ids, ["t0", "t1", "t2", "t3"]);
    assert!(reply.omitted.is_empty());
    assert_ne!(first, second);
}

#[test]
fn a_page_over_the_frame_bound_is_asked_again_for_one_turn_then_its_summary() {
    let mut calls = Calls::new();
    let (mut read, effects) = HistoryRead::start("root-1", &mut calls);
    assert!(read.awaits(request(&effects[0]).0));
    let effects = read.settled(&mut calls, Err(&dropped(2_000_000)));
    let (_, _, params) = request(&effects[0]);
    assert_eq!(params.get("limit").and_then(Value::as_f64), Some(1.0));
    assert_eq!(
        params.get("itemsView").and_then(Value::as_str),
        Some("full")
    );
    let effects = read.settled(&mut calls, Err(&dropped(2_000_000)));
    let (_, _, params) = request(&effects[0]);
    assert_eq!(params.get("limit").and_then(Value::as_f64), Some(1.0));
    assert_eq!(
        params.get("itemsView").and_then(Value::as_str),
        Some("summary")
    );
    let effects = read.settled(&mut calls, Err(&dropped(2_000_000)));
    let (_, _, params) = request(&effects[0]);
    assert_eq!(
        params.get("itemsView").and_then(Value::as_str),
        Some("notLoaded")
    );
    read.settled(&mut calls, Ok(&page(r#"{"id":"t1"}"#, None)));
    let reply = read
        .outcome()
        .expect("the read ended")
        .as_ref()
        .expect("ok");
    assert_eq!(reply.turns.len(), 1);
    assert_eq!(
        reply.omitted,
        vec![json(
            r#"{"event":"thread-history-omitted","turnId":"t1","item":"","bytes":2000000,"bytesAtLeast":true,"reason":"Oversized turn history retained as notLoaded"}"#,
        )]
    );
}

#[test]
fn a_dropped_envelope_even_for_one_turn_ends_the_read_rather_than_inventing_a_turn() {
    let mut calls = Calls::new();
    let (mut read, _) = HistoryRead::start("root-1", &mut calls);
    read.settled(&mut calls, Err(&dropped(2_000_000)));
    read.settled(&mut calls, Err(&dropped(2_000_000)));
    read.settled(&mut calls, Err(&dropped(2_000_000)));
    let effects = read.settled(&mut calls, Err(&dropped(2_000_000)));
    assert!(effects.is_empty());
    assert_eq!(read.outcome(), Some(&Err(dropped(2_000_000))));
}

#[test]
fn an_older_server_without_paged_history_answers_the_whole_read_instead() {
    let mut calls = Calls::new();
    let (mut read, _) = HistoryRead::start("root-1", &mut calls);
    let effects = read.settled(&mut calls, Err("Method not found (\"code\":-32601)"));
    let (_, method, params) = request(&effects[0]);
    assert_eq!(method, "thread/read");
    assert_eq!(
        params.get("includeTurns").and_then(Value::as_bool),
        Some(true)
    );
    read.settled(
        &mut calls,
        Ok(&json(
            r#"{"thread":{"id":"root-1","turns":[{"id":"t1"},{"id":"t2"},{"id":"t3"},{"id":"t4"},{"id":"t5"}]}}"#,
        )),
    );
    let reply = read
        .outcome()
        .expect("the read ended")
        .as_ref()
        .expect("ok");
    let ids: Vec<&str> = reply
        .turns
        .iter()
        .map(|turn| turn.get("id").and_then(Value::as_str).unwrap_or_default())
        .collect();
    assert_eq!(ids, ["t2", "t3", "t4", "t5"]);
}

#[test]
fn a_repeated_page_cursor_ends_the_read_instead_of_looping() {
    let mut calls = Calls::new();
    let (mut read, _) = HistoryRead::start("root-1", &mut calls);
    read.settled(&mut calls, Ok(&page(r#"{"id":"t4"}"#, Some("c2"))));
    read.settled(&mut calls, Ok(&page(r#"{"id":"t3"}"#, Some("c2"))));
    assert_eq!(
        read.outcome(),
        Some(&Err("Codex history repeated a page cursor".to_owned()))
    );
}

#[test]
fn a_page_without_turns_ends_the_read_instead_of_keeping_a_shape_it_cannot_read() {
    let mut calls = Calls::new();
    let (mut read, _) = HistoryRead::start("root-1", &mut calls);
    read.settled(&mut calls, Ok(&json(r#"{"nextCursor":null}"#)));
    assert_eq!(
        read.outcome(),
        Some(&Err("Codex history page omitted its turns".to_owned()))
    );
}

#[test]
fn history_is_split_into_notes_that_each_fit_the_bound() {
    let turns = vec![
        json(r#"{"id":"t1","items":[{"id":"i1"}]}"#),
        json(r#"{"id":"t2","items":[{"id":"i2"}]}"#),
    ];
    let limit = bytes_of(&turns[0]) + 1;
    let notes = history_notes_with("root-1", 2, &turns, limit);
    assert_eq!(notes.len(), 2);
    assert_eq!(
        notes[0],
        json(
            r#"{"event":"thread-history","threadId":"root-1","read":2,"turns":[{"id":"t1","items":[{"id":"i1"}]}]}"#
        )
    );
    assert_eq!(
        notes[1],
        json(
            r#"{"event":"thread-history","threadId":"root-1","read":2,"turns":[{"id":"t2","items":[{"id":"i2"}]}]}"#
        )
    );
}

#[test]
fn a_turn_too_large_for_one_note_is_split_by_items_and_its_parts_share_its_id() {
    let turns = vec![json(
        r#"{"id":"t1","items":[{"id":"i1","text":"aaaaaaaaaa"},{"id":"i2","text":"bbbbbbbbbb"}]}"#,
    )];
    let shell = json(r#"{"id":"t1","items":[]}"#);
    let item = json(r#"{"id":"i1","text":"aaaaaaaaaa"}"#);
    let limit = bytes_of(&shell) + bytes_of(&item) + 2;
    let notes = history_notes_with("root-1", 3, &turns, limit);
    assert_eq!(notes.len(), 2);
    assert_eq!(
        notes[0],
        json(
            r#"{"event":"thread-history","threadId":"root-1","read":3,"turns":[{"id":"t1","items":[{"id":"i1","text":"aaaaaaaaaa"}]}]}"#
        )
    );
    assert_eq!(
        notes[1],
        json(
            r#"{"event":"thread-history","threadId":"root-1","read":3,"turns":[{"id":"t1","items":[{"id":"i2","text":"bbbbbbbbbb"}]}]}"#
        )
    );
}

#[test]
fn an_item_larger_than_a_whole_note_is_left_out_with_a_note_saying_so() {
    let turns = vec![json(
        r#"{"id":"t1","items":[{"id":"huge","text":"aaaaaaaaaa"},{"id":"small"}]}"#,
    )];
    let shell = json(r#"{"id":"t1","items":[]}"#);
    let huge = json(r#"{"id":"huge","text":"aaaaaaaaaa"}"#);
    let small = json(r#"{"id":"small"}"#);
    let limit = bytes_of(&shell) + bytes_of(&small) + 2;
    let notes = history_notes_with("root-1", 4, &turns, limit);
    assert_eq!(
        notes[0],
        json(&format!(
            r#"{{"event":"thread-history-omitted","threadId":"root-1","read":4,"turnId":"t1","item":"huge","bytes":{}}}"#,
            bytes_of(&huge)
        ))
    );
    assert_eq!(
        notes[1],
        json(
            r#"{"event":"thread-history","threadId":"root-1","read":4,"turns":[{"id":"t1","items":[{"id":"small"}]}]}"#
        )
    );
}

#[test]
fn a_page_that_fills_the_quota_still_refuses_a_cursor_it_already_followed() {
    let mut calls = Calls::new();
    let (mut read, _) = HistoryRead::start("root-1", &mut calls);
    read.settled(
        &mut calls,
        Ok(&page(r#"{"id":"t4"},{"id":"t3"},{"id":"t2"}"#, Some("c2"))),
    );
    read.settled(&mut calls, Ok(&page(r#"{"id":"t1"}"#, Some("c2"))));
    assert_eq!(
        read.outcome(),
        Some(&Err("Codex history repeated a page cursor".to_owned()))
    );
}

#[test]
fn an_older_server_is_recognised_by_its_code_wherever_the_reply_carries_it() {
    let mut calls = Calls::new();
    let (mut read, _) = HistoryRead::start("root-1", &mut calls);
    let effects = read.settled(
        &mut calls,
        Err(r#"{"code":-32000,"data":{"code": -32601},"message":"no paged history"}"#),
    );
    let (_, method, _) = request(&effects[0]);
    assert_eq!(method, "thread/read");
}
