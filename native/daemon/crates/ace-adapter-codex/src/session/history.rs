// SPDX-License-Identifier: Apache-2.0
//! Codex thread history in bounded pieces (`history.ts`, #693). One
//! `thread/resume` or `thread/read` with turns returns a thread's whole history
//! as one JSON-RPC line, so a long thread outgrows the frame bound and could
//! never be reopened. Opening and recovery need only a thread's current state,
//! which lives in its newest turns, so only those are read, newest page first,
//! and recorded as notes that each fit the frame bound. The work is the same for
//! a thread of ten turns or ten thousand.

use std::collections::HashSet;

use ace_json::{Map, Value};

use super::frames::{Calls, Effect, MAX_PAYLOAD_BYTES};

/// How many of a thread's newest turns are read (`historyPageTurns`).
pub const HISTORY_PAGE_TURNS: usize = 4;
/// Room under the frame bound for the note envelope and credential redaction.
pub const NOTE_BUDGET: usize = MAX_PAYLOAD_BYTES - 64 * 1024;
/// One request's default deadline (`request` in `session.ts`).
const REQUEST_MS: f64 = 30_000.0;

/// What one `readHistory` answered.
#[derive(Debug, Clone, PartialEq)]
pub struct HistoryReply {
    /// The newest turns, oldest first.
    pub turns: Vec<Value>,
    /// The `thread-history-omitted` notes for oversized turns, without the
    /// read's own keys (the session adds `threadId` and `read`).
    pub omitted: Vec<Value>,
}

/// How much of a turn's items a page retained (`ItemsView`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ItemsView {
    Full,
    Summary,
    NotLoaded,
}

impl ItemsView {
    fn as_str(self) -> &'static str {
        match self {
            ItemsView::Full => "full",
            ItemsView::Summary => "summary",
            ItemsView::NotLoaded => "notLoaded",
        }
    }

    /// The omission note's reason: `Oversized turn history retained as <view>`.
    fn retained(self) -> String {
        format!("Oversized turn history retained as {}", self.as_str())
    }
}

/// One accepted turn and how much of it the page that carried it retained.
struct Kept {
    turn: Value,
    view: ItemsView,
    dropped: usize,
}

/// Which read a pending call belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stage {
    /// The paged read (`thread/turns/list`).
    Page,
    /// The deprecated whole-history read (`thread/read`).
    Whole,
}

/// One thread's history read, page by page.
pub struct HistoryRead {
    thread: String,
    stage: Stage,
    call: u64,
    newest: Vec<Kept>,
    seen: HashSet<String>,
    cursor: Option<String>,
    /// How many turns the page in flight may carry.
    limit: usize,
    view: ItemsView,
    dropped: usize,
    outcome: Option<Result<HistoryReply, String>>,
}

impl HistoryRead {
    /// `readHistory`'s first page: the newest turns, newest page first.
    pub fn start(thread: &str, calls: &mut Calls) -> (HistoryRead, Vec<Effect>) {
        let call = calls.take();
        let read = HistoryRead {
            thread: thread.to_owned(),
            stage: Stage::Page,
            call,
            newest: Vec::new(),
            seen: HashSet::new(),
            cursor: None,
            limit: HISTORY_PAGE_TURNS,
            view: ItemsView::Full,
            dropped: 0,
            outcome: None,
        };
        let effect = page_request(call, &read.thread, read.limit, read.view, None);
        (read, vec![effect])
    }

    /// Whether this read waits for `call`'s reply.
    pub fn awaits(&self, call: u64) -> bool {
        self.outcome.is_none() && self.call == call
    }

    /// The read's answer, once it has one.
    pub fn outcome(&self) -> Option<&Result<HistoryReply, String>> {
        self.outcome.as_ref()
    }

    /// One page's reply, or its failure: the read's next request, its end, or
    /// the whole-history read an older server needs instead.
    pub fn settled(&mut self, calls: &mut Calls, reply: Result<&Value, &str>) -> Vec<Effect> {
        if self.outcome.is_some() {
            return Vec::new();
        }
        match self.stage {
            Stage::Page => self.page(calls, reply),
            Stage::Whole => {
                let outcome = whole_history(reply);
                self.outcome = Some(outcome);
                Vec::new()
            }
        }
    }

    fn page(&mut self, calls: &mut Calls, reply: Result<&Value, &str>) -> Vec<Effect> {
        let result = match reply {
            Ok(result) => result,
            Err(message) => return self.failed(calls, message),
        };
        let Some(data) = result.get("data").and_then(Value::as_array) else {
            self.outcome = Some(Err("Codex history page omitted its turns".to_owned()));
            return Vec::new();
        };
        // A page never holds more than was asked for; anything past the limit is
        // ignored.
        for turn in data.iter().take(self.limit) {
            self.newest.push(Kept {
                turn: record(turn),
                view: self.view,
                dropped: self.dropped,
            });
        }
        let next = result
            .get("nextCursor")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        if next.is_empty() || data.is_empty() || self.newest.len() >= HISTORY_PAGE_TURNS {
            self.finished();
            return Vec::new();
        }
        if !self.seen.insert(next.clone()) {
            self.outcome = Some(Err("Codex history repeated a page cursor".to_owned()));
            return Vec::new();
        }
        self.cursor = Some(next.clone());
        self.limit = HISTORY_PAGE_TURNS - self.newest.len();
        self.view = ItemsView::Full;
        self.dropped = 0;
        let call = calls.take();
        self.call = call;
        vec![page_request(
            call,
            &self.thread,
            self.limit,
            self.view,
            self.cursor.as_deref(),
        )]
    }

    /// A page that failed: a dropped reply is asked once more for one turn, then
    /// for its summary, then for its envelope alone; an older server without
    /// paged history falls back to the whole read; anything else ends the read.
    fn failed(&mut self, calls: &mut Calls, message: &str) -> Vec<Effect> {
        if self.cursor.is_none() && self.newest.is_empty() && method_missing(message) {
            let call = calls.take();
            self.call = call;
            self.stage = Stage::Whole;
            let mut params = Map::new();
            params.insert("threadId", Value::from(self.thread.clone()));
            params.insert("includeTurns", Value::Bool(true));
            return vec![Effect::Request {
                call,
                method: "thread/read".to_owned(),
                params: Value::Object(params),
                timeout_ms: Some(REQUEST_MS),
            }];
        }
        let Some(bytes) = dropped_bytes(message) else {
            self.outcome = Some(Err(message.to_owned()));
            return Vec::new();
        };
        self.dropped = bytes;
        if self.limit != 1 {
            self.limit = 1;
        } else if self.view == ItemsView::Full {
            self.view = ItemsView::Summary;
        } else if self.view == ItemsView::Summary {
            self.view = ItemsView::NotLoaded;
        } else {
            // No cursor survived even in the envelope; never invent one.
            self.outcome = Some(Err(message.to_owned()));
            return Vec::new();
        }
        let call = calls.take();
        self.call = call;
        vec![page_request(
            call,
            &self.thread,
            self.limit,
            self.view,
            self.cursor.as_deref(),
        )]
    }

    /// The newest turns, oldest first, and the note for each one a page cut.
    fn finished(&mut self) {
        let hand = std::mem::take(&mut self.newest);
        let turns: Vec<Value> = hand.iter().rev().map(|kept| kept.turn.clone()).collect();
        let mut omitted = Vec::new();
        for kept in hand.iter().rev() {
            if kept.view == ItemsView::Full {
                continue;
            }
            let mut note = Map::new();
            note.insert("event", Value::from("thread-history-omitted"));
            note.insert(
                "turnId",
                Value::from(
                    kept.turn
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                ),
            );
            note.insert("item", Value::from(""));
            note.insert("bytes", Value::from(kept.dropped as f64));
            note.insert("bytesAtLeast", Value::Bool(true));
            note.insert("reason", Value::from(kept.view.retained()));
            omitted.push(Value::Object(note));
        }
        self.outcome = Some(Ok(HistoryReply { turns, omitted }));
    }
}

/// One `thread/turns/list` request, newest page first.
fn page_request(
    call: u64,
    thread: &str,
    limit: usize,
    view: ItemsView,
    cursor: Option<&str>,
) -> Effect {
    let mut params = Map::new();
    params.insert("threadId", Value::from(thread.to_owned()));
    params.insert("limit", Value::from(limit as f64));
    params.insert("sortDirection", Value::from("desc"));
    params.insert("itemsView", Value::from(view.as_str()));
    if let Some(cursor) = cursor {
        params.insert("cursor", Value::from(cursor.to_owned()));
    }
    Effect::Request {
        call,
        method: "thread/turns/list".to_owned(),
        params: Value::Object(params),
        timeout_ms: Some(REQUEST_MS),
    }
}

/// The deprecated whole-history read: one reply, of which only the newest turns
/// are kept.
fn whole_history(reply: Result<&Value, &str>) -> Result<HistoryReply, String> {
    let result = reply?;
    let turns = result
        .get("thread")
        .map(record)
        .and_then(|thread| match thread.get("turns") {
            Some(Value::Array(turns)) => Some(turns.clone()),
            _ => None,
        })
        .ok_or_else(|| "Codex read omitted turn history".to_owned())?;
    let start = turns.len().saturating_sub(HISTORY_PAGE_TURNS);
    Ok(HistoryReply {
        turns: turns.iter().skip(start).map(record).collect(),
        omitted: Vec::new(),
    })
}

/// `obj(value)`: an object, or the empty record a non-object reads as.
fn record(value: &Value) -> Value {
    match value {
        Value::Object(_) => value.clone(),
        _ => Value::Object(Map::new()),
    }
}

/// `methodMissing`: a server without paged history answers `-32601`.
fn method_missing(message: &str) -> bool {
    const CODE: &str = "\"code\":";
    let Some(at) = message.find(CODE) else {
        return false;
    };
    let rest = &message[at + CODE.len()..];
    let rest = rest.trim_start();
    let Some(digits) = rest.strip_prefix("-32601") else {
        return false;
    };
    // `\b`: the code ends where the number ends, so `-3260` or `-32601x` is no
    // `-32601`.
    digits
        .chars()
        .next()
        .is_none_or(|ch| !(ch.is_ascii_alphanumeric() || ch == '_'))
}

/// The bytes a dropped reply's error reports (`OutputLineDroppedError`), when
/// the message is one. `host.rs` builds the message from the supervisor's count.
fn dropped_bytes(message: &str) -> Option<usize> {
    const PREFIX: &str =
        "Codex stdout reply dropped because its line exceeded the limit (at least ";
    const SUFFIX: &str = " bytes)";
    message
        .strip_prefix(PREFIX)?
        .strip_suffix(SUFFIX)?
        .parse()
        .ok()
}

/// `historyNotes`: the turns split into notes that each fit the frame bound, in
/// order. A turn too large for one note is split by items, and its parts share
/// the turn's id. An item larger than a whole note is left out with a note
/// saying so, the same outcome a live frame of that size would have.
pub fn history_notes(thread: &str, read: u64, turns: &[Value]) -> Vec<Value> {
    history_notes_with(thread, read, turns, NOTE_BUDGET)
}

/// `historyNotes(threadId, read, turns, budget)`.
pub fn history_notes_with(thread: &str, read: u64, turns: &[Value], budget: usize) -> Vec<Value> {
    let mut builder = NoteBuilder {
        thread,
        read,
        budget,
        notes: Vec::new(),
        batch: Vec::new(),
        batch_bytes: 0,
    };
    for turn in turns {
        let bytes = bytes_of(turn);
        if bytes <= budget {
            builder.add(turn.clone(), bytes);
            continue;
        }
        let mut shell = turn.as_object().cloned().unwrap_or_default();
        shell.remove("items");
        let mut empty = shell.clone();
        empty.insert("items", Value::Array(Vec::new().into()));
        let shell_bytes = bytes_of(&Value::Object(empty));
        let mut part: Vec<Value> = Vec::new();
        let mut part_bytes = shell_bytes;
        for item in turn
            .get("items")
            .and_then(Value::as_array)
            .map(|items| items.to_vec())
            .unwrap_or_default()
        {
            let size = bytes_of(&item) + 1;
            if shell_bytes + size > budget {
                builder.omitted(turn, &item, size - 1);
                continue;
            }
            if part_bytes + size > budget {
                builder.add_part(&shell, &mut part, &mut part_bytes, shell_bytes);
                builder.flush();
            }
            part.push(item);
            part_bytes += size;
        }
        builder.add_part(&shell, &mut part, &mut part_bytes, shell_bytes);
    }
    builder.flush();
    builder.notes
}

/// The notes under construction: one bounded batch at a time.
struct NoteBuilder<'a> {
    thread: &'a str,
    read: u64,
    budget: usize,
    notes: Vec<Value>,
    batch: Vec<Value>,
    batch_bytes: usize,
}

impl NoteBuilder<'_> {
    /// One turn's note is full: record it and start the next.
    fn flush(&mut self) {
        if self.batch.is_empty() {
            return;
        }
        self.notes.push(history_note(
            self.thread,
            self.read,
            std::mem::take(&mut self.batch),
        ));
        self.batch_bytes = 0;
    }

    fn add(&mut self, turn: Value, bytes: usize) {
        if self.batch_bytes + bytes > self.budget {
            self.flush();
        }
        self.batch.push(turn);
        self.batch_bytes += bytes;
    }

    /// One split turn's part: its shell, then the items gathered so far.
    fn add_part(
        &mut self,
        shell: &Map,
        part: &mut Vec<Value>,
        part_bytes: &mut usize,
        shell_bytes: usize,
    ) {
        let mut whole = shell.clone();
        whole.insert("items", Value::Array(std::mem::take(part).into()));
        let size = *part_bytes;
        self.add(Value::Object(whole), size);
        *part_bytes = shell_bytes;
    }

    /// An item larger than a whole note is left out with a note saying so.
    fn omitted(&mut self, turn: &Value, item: &Value, bytes: usize) {
        let mut note = Map::new();
        note.insert("event", Value::from("thread-history-omitted"));
        note.insert("threadId", Value::from(self.thread.to_owned()));
        note.insert("read", Value::from(self.read as f64));
        note.insert(
            "turnId",
            Value::from(
                turn.get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            ),
        );
        note.insert(
            "item",
            Value::from(
                item.get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            ),
        );
        note.insert("bytes", Value::from(bytes as f64));
        self.notes.push(Value::Object(note));
    }
}

/// One `thread-history` note.
fn history_note(thread: &str, read: u64, turns: Vec<Value>) -> Value {
    let mut note = Map::new();
    note.insert("event", Value::from("thread-history"));
    note.insert("threadId", Value::from(thread.to_owned()));
    note.insert("read", Value::from(read as f64));
    note.insert("turns", Value::Array(turns.into()));
    Value::Object(note)
}

/// `Buffer.byteLength(JSON.stringify(value))`.
fn bytes_of(value: &Value) -> usize {
    ace_json::to_string(value).len()
}

#[cfg(test)]
mod tests {
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
}
