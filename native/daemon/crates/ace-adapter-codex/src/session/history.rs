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
        if next.is_empty() || data.is_empty() {
            self.finished();
            return Vec::new();
        }
        // The pager refuses a cursor it already followed even for the page that
        // fills the quota, as the TypeScript does before its loop can end.
        if !self.seen.insert(next.clone()) {
            self.outcome = Some(Err("Codex history repeated a page cursor".to_owned()));
            return Vec::new();
        }
        if self.newest.len() >= HISTORY_PAGE_TURNS {
            self.finished();
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
    // `/"code":\s*-32601\b/`: any occurrence, whichever code the reply names
    // first.
    message.match_indices(CODE).any(|(at, code)| {
        let rest = message[at + code.len()..].trim_start();
        rest.strip_prefix("-32601").is_some_and(|digits| {
            // `\b`: the code ends where the number ends, so `-3260` or
            // `-32601x` is no `-32601`.
            digits
                .chars()
                .next()
                .is_none_or(|ch| !(ch.is_ascii_alphanumeric() || ch == '_'))
        })
    })
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

mod notes;

pub use notes::{history_notes, history_notes_with};

/// `Buffer.byteLength(JSON.stringify(value))`: the UTF-8 size of a value's
/// JS-exact JSON.
pub(crate) fn bytes_of(value: &Value) -> usize {
    ace_json::to_string(value).len()
}

#[cfg(test)]
mod tests;
