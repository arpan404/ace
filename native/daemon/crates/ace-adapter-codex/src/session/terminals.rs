// SPDX-License-Identifier: Apache-2.0
//! Codex's live shells and its usage snapshot, both read once and bounded
//! (`background-terminals.ts`, `rate-limits-read.ts`). Discovery asks for the
//! terminals a thread still runs so a summary that omits commands cannot hide
//! a background shell; the usage read runs once when a session opens.

use std::collections::HashSet;

use ace_json::{Map, Value};

use super::frames::{Calls, Effect, FrameDir, Frames};
use super::state::utf16_len;

/// A terminal page's bound (`TerminalPage`, `background-terminals.ts:2`).
const TERMINALS_PER_PAGE: usize = 256;
/// A terminal's `processId` bound.
const PROCESS_ID_MAX: usize = 1024;
/// A continuation cursor's bound.
const CURSOR_MAX: usize = 4096;
/// How many terminals a read keeps.
const TERMINAL_TOTAL: usize = 4096;
/// How many pages a read asks for.
const TERMINAL_PAGES: u64 = 64;
/// One request's default deadline (`request` in `session.ts`).
const REQUEST_MS: f64 = 30_000.0;

/// One live shell (`TerminalPage`'s entries).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Terminal {
    pub process_id: String,
    /// The command item that owns it; a terminal outside ace's items has none.
    pub item_id: Option<String>,
}

/// `readBackgroundTerminals`: bounded pages with checked continuation cursors.
#[derive(Debug)]
pub struct TerminalRead {
    thread: String,
    call: u64,
    cursor: Option<String>,
    cursors: HashSet<String>,
    terminals: Vec<Terminal>,
    pages: u64,
    outcome: Option<Result<Vec<Terminal>, String>>,
}

impl TerminalRead {
    /// The first page; `{ threadId }`, and a cursor when there is one.
    pub fn start(thread: &str, calls: &mut Calls) -> (TerminalRead, Vec<Effect>) {
        let call = calls.take();
        let read = TerminalRead {
            thread: thread.to_owned(),
            call,
            cursor: None,
            cursors: HashSet::new(),
            terminals: Vec::new(),
            pages: 0,
            outcome: None,
        };
        let effect = Effect::Request {
            call,
            method: "thread/backgroundTerminals/list".to_owned(),
            params: read.params(None),
            timeout_ms: Some(REQUEST_MS),
        };
        (read, vec![effect])
    }

    pub fn outcome(&self) -> Option<&Result<Vec<Terminal>, String>> {
        self.outcome.as_ref()
    }

    /// Whether this read waits for `call`'s page.
    pub fn awaits(&self, call: u64) -> bool {
        self.outcome.is_none() && self.call == call
    }

    fn params(&self, cursor: Option<&str>) -> Value {
        let mut params = Map::new();
        params.insert("threadId", Value::from(self.thread.clone()));
        if let Some(cursor) = cursor {
            params.insert("cursor", Value::from(cursor));
        }
        Value::Object(params)
    }

    /// One page's reply. `TerminalPage.parse` throws on anything a bounded page
    /// would not be; a finished read keeps its outcome.
    pub fn settled(&mut self, calls: &mut Calls, reply: Result<&Value, &str>) -> Vec<Effect> {
        if self.outcome.is_some() {
            return Vec::new();
        }
        self.pages += 1;
        let page = match parse_page(reply) {
            Ok(page) => page,
            Err(error) => {
                self.outcome = Some(Err(error));
                return Vec::new();
            }
        };
        self.terminals.extend(page.data);
        if self.terminals.len() > TERMINAL_TOTAL {
            self.outcome = Some(Err("Codex terminal capacity reached".to_owned()));
            return Vec::new();
        }
        let Some(next) = page.next_cursor else {
            self.outcome = Some(Ok(std::mem::take(&mut self.terminals)));
            return Vec::new();
        };
        if !self.cursors.insert(next.clone()) {
            self.outcome = Some(Err("Repeated Codex terminal cursor".to_owned()));
            return Vec::new();
        }
        if self.pages >= TERMINAL_PAGES {
            self.outcome = Some(Err("Codex terminal pagination capacity reached".to_owned()));
            return Vec::new();
        }
        self.call = calls.take();
        self.cursor = Some(next.clone());
        vec![Effect::Request {
            call: self.call,
            method: "thread/backgroundTerminals/list".to_owned(),
            params: self.params(Some(&next)),
            timeout_ms: Some(REQUEST_MS),
        }]
    }
}

struct Page {
    data: Vec<Terminal>,
    next_cursor: Option<String>,
}

/// `TerminalPage.parse`: `data` up to 256 terminals with a bounded
/// `processId`, and a bounded non-empty `nextCursor` when there is one.
fn parse_page(result: Result<&Value, &str>) -> Result<Page, String> {
    let body = result
        .map_err(str::to_owned)?
        .as_object()
        .ok_or_else(|| "Invalid Codex terminal page".to_owned())?;
    let data = body
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| "Invalid Codex terminal page".to_owned())?;
    if data.len() > TERMINALS_PER_PAGE {
        return Err("Invalid Codex terminal page".to_owned());
    }
    let mut terminals = Vec::with_capacity(data.len());
    for entry in data {
        let entry = entry
            .as_object()
            .ok_or_else(|| "Invalid Codex terminal page".to_owned())?;
        let process_id = entry
            .get("processId")
            .and_then(Value::as_str)
            // `zod`'s `.min(1).max(1024)` counts UTF-16 code units.
            .filter(|id| !id.is_empty() && utf16_len(id) <= PROCESS_ID_MAX)
            .ok_or_else(|| "Invalid Codex terminal page".to_owned())?;
        // `z.string().optional()`: an empty id names no item, and the
        // discovery fold's `if (terminal.itemId)` treats it as absent.
        let item_id = match entry.get("itemId") {
            None => None,
            Some(Value::String(item)) if item.as_str().is_empty() => None,
            Some(Value::String(item)) => Some(item.as_str().to_owned()),
            Some(_) => return Err("Invalid Codex terminal page".to_owned()),
        };
        terminals.push(Terminal {
            process_id: process_id.to_owned(),
            item_id,
        });
    }
    let next_cursor = match body.get("nextCursor") {
        None | Some(Value::Null) => None,
        Some(Value::String(cursor)) if !cursor.as_str().is_empty() => {
            if utf16_len(cursor.as_str()) > CURSOR_MAX {
                return Err("Invalid Codex terminal page".to_owned());
            }
            Some(cursor.as_str().to_owned())
        }
        Some(_) => return Err("Invalid Codex terminal page".to_owned()),
    };
    Ok(Page {
        data: terminals,
        next_cursor,
    })
}

/// `readRateLimits`: Codex's usage endpoint only; no model turn, no quota. The
/// answer goes out as a note whose top level is the read's result, so the
/// account registry ingests it like any other rate-limit report.
#[derive(Debug)]
pub struct RateLimitsRead {
    call: u64,
}

impl RateLimitsRead {
    pub fn start(calls: &mut Calls) -> (RateLimitsRead, Vec<Effect>) {
        let call = calls.take();
        let effect = Effect::Request {
            call,
            method: "account/rateLimits/read".to_owned(),
            params: Value::Object(Map::new()),
            timeout_ms: Some(REQUEST_MS),
        };
        (RateLimitsRead { call }, vec![effect])
    }

    /// The call the read waits on.
    pub fn call(&self) -> u64 {
        self.call
    }

    /// The answer, as a note frame. A closed session, a failed read and a
    /// value that is not an object change nothing; a reply that cannot be
    /// admitted is dropped, as the TypeScript's unhandled rejection is.
    pub fn settled(
        &self,
        call: u64,
        closed: bool,
        result: Option<&Value>,
        frames: &Frames,
    ) -> Vec<Effect> {
        if call != self.call || closed {
            return Vec::new();
        }
        let Some(Value::Object(result)) = result else {
            return Vec::new();
        };
        let mut note = result.clone();
        note.insert("event", Value::from("account-rate-limits"));
        match frames.emit(FrameDir::Note, &Value::Object(note), "stdio", None) {
            Ok(emitted) => emitted.frames.into_iter().map(Effect::from).collect(),
            Err(_) => Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(pairs: &[(&str, Option<&str>)], next: Option<&str>) -> Value {
        let entries: Vec<String> = pairs
            .iter()
            .map(|(process, item)| match item {
                Some(item) => format!("{{\"processId\":{process:?},\"itemId\":{item:?}}}"),
                None => format!("{{\"processId\":{process:?}}}"),
            })
            .collect();
        let cursor = next
            .map(|cursor| format!(",\"nextCursor\":{cursor:?}"))
            .unwrap_or_default();
        ace_json::parse(&format!("{{\"data\":[{}]{cursor}}}", entries.join(",")))
            .expect("fixture parses")
    }

    #[test]
    fn a_terminal_read_walks_every_page_and_keeps_the_item_that_owns_it() {
        let mut calls = Calls::new();
        let (mut read, effects) = TerminalRead::start("t1", &mut calls);
        let Effect::Request { params, .. } = &effects[0] else {
            panic!("the read asks for its first page");
        };
        assert_eq!(params.get("threadId").and_then(Value::as_str), Some("t1"));
        assert!(params.get("cursor").is_none());
        let second = read.settled(&mut calls, Ok(&page(&[("p1", Some("item-1"))], Some("c2"))));
        assert_eq!(second.len(), 1);
        let Effect::Request { params, .. } = &second[0] else {
            panic!("the read asks for its second page");
        };
        assert_eq!(params.get("cursor").and_then(Value::as_str), Some("c2"));
        read.settled(&mut calls, Ok(&page(&[("p2", None)], None)));
        assert_eq!(
            read.outcome(),
            Some(&Ok(vec![
                Terminal {
                    process_id: "p1".to_owned(),
                    item_id: Some("item-1".to_owned()),
                },
                Terminal {
                    process_id: "p2".to_owned(),
                    item_id: None,
                },
            ]))
        );
    }

    #[test]
    fn a_repeated_terminal_cursor_fails_the_read() {
        let mut calls = Calls::new();
        let (mut read, _) = TerminalRead::start("t1", &mut calls);
        read.settled(&mut calls, Ok(&page(&[("p1", None)], Some("c2"))));
        read.settled(&mut calls, Ok(&page(&[("p2", None)], Some("c2"))));
        assert_eq!(
            read.outcome(),
            Some(&Err("Repeated Codex terminal cursor".to_owned()))
        );
    }

    #[test]
    fn more_than_a_page_of_terminals_fails_the_read() {
        let mut calls = Calls::new();
        let (mut read, _) = TerminalRead::start("t1", &mut calls);
        let entries: Vec<(&str, Option<&str>)> =
            (0..TERMINALS_PER_PAGE).map(|_| ("p", None)).collect();
        // 16 full pages are exactly the bound; the next terminal is over it.
        for index in 0..TERMINAL_TOTAL / TERMINALS_PER_PAGE {
            let cursor = format!("c{}", index + 2);
            read.settled(&mut calls, Ok(&page(&entries, Some(cursor.as_str()))));
            assert!(read.outcome().is_none());
        }
        read.settled(&mut calls, Ok(&page(&[("p", None)], None)));
        assert_eq!(
            read.outcome(),
            Some(&Err("Codex terminal capacity reached".to_owned()))
        );
    }

    #[test]
    fn sixty_four_pages_of_terminals_fail_the_read() {
        let mut calls = Calls::new();
        let (mut read, _) = TerminalRead::start("t1", &mut calls);
        for index in 0..TERMINAL_PAGES {
            let cursor = format!("c{}", index + 2);
            read.settled(&mut calls, Ok(&page(&[("p", None)], Some(cursor.as_str()))));
        }
        assert_eq!(
            read.outcome(),
            Some(&Err("Codex terminal pagination capacity reached".to_owned()))
        );
    }

    #[test]
    fn a_terminal_with_an_empty_item_id_has_no_owning_item() {
        let mut calls = Calls::new();
        let (mut read, _) = TerminalRead::start("t1", &mut calls);
        read.settled(&mut calls, Ok(&page(&[("p1", Some(""))], None)));
        assert_eq!(
            read.outcome(),
            Some(&Ok(vec![Terminal {
                process_id: "p1".to_owned(),
                item_id: None,
            }]))
        );
    }

    #[test]
    fn a_process_id_is_bounded_in_utf16_code_units_as_zod_counts_them() {
        let mut calls = Calls::new();
        let (mut read, _) = TerminalRead::start("t1", &mut calls);
        // 600 CJK characters: 600 UTF-16 code units, 1,800 UTF-8 bytes.
        let id = "\u{6f22}".repeat(600);
        read.settled(
            &mut calls,
            Ok(
                &ace_json::parse(&format!("{{\"data\":[{{\"processId\":\"{id}\"}}]}}"))
                    .expect("fixture parses"),
            ),
        );
        assert!(matches!(read.outcome(), Some(Ok(_))));
        let mut calls = Calls::new();
        let (mut read, _) = TerminalRead::start("t1", &mut calls);
        let id = "\u{6f22}".repeat(PROCESS_ID_MAX + 1);
        read.settled(
            &mut calls,
            Ok(
                &ace_json::parse(&format!("{{\"data\":[{{\"processId\":\"{id}\"}}]}}"))
                    .expect("fixture parses"),
            ),
        );
        assert!(read.outcome().is_some_and(|outcome| outcome.is_err()));
    }

    #[test]
    fn a_terminal_page_without_a_bounded_process_id_is_refused() {
        let mut calls = Calls::new();
        let (mut read, _) = TerminalRead::start("t1", &mut calls);
        let long = "x".repeat(PROCESS_ID_MAX + 1);
        read.settled(
            &mut calls,
            Ok(
                &ace_json::parse(&format!("{{\"data\":[{{\"processId\":\"{long}\"}}]}}"))
                    .expect("fixture parses"),
            ),
        );
        assert!(read.outcome().is_some_and(|outcome| outcome.is_err()));
    }

    #[test]
    fn the_usage_read_goes_out_as_a_note_whose_top_level_is_its_result() {
        let mut calls = Calls::new();
        let (read, effects) = RateLimitsRead::start(&mut calls);
        let Effect::Request {
            call,
            method,
            params,
            ..
        } = &effects[0]
        else {
            panic!("the read asks for the snapshot");
        };
        assert_eq!(method, "account/rateLimits/read");
        assert_eq!(params.to_json(), "{}");
        let result =
            ace_json::parse("{\"plan\":\"pro\",\"rateLimits\":[]}").expect("fixture parses");
        let effects = read.settled(*call, false, Some(&result), &Frames::new(None));
        assert_eq!(effects.len(), 1);
        let Effect::Frame { dir, channel, text } = &effects[0] else {
            panic!("the read emits one note");
        };
        assert_eq!(*dir, FrameDir::Note);
        assert_eq!(*channel, "stdio");
        assert_eq!(
            text,
            "{\"plan\":\"pro\",\"rateLimits\":[],\"event\":\"account-rate-limits\"}"
        );
    }

    #[test]
    fn a_closed_session_or_a_failed_usage_read_emits_nothing() {
        let mut calls = Calls::new();
        let (read, effects) = RateLimitsRead::start(&mut calls);
        let Effect::Request { call, .. } = &effects[0] else {
            panic!("the read asks for the snapshot");
        };
        let result = ace_json::parse("{\"plan\":\"pro\"}").expect("fixture parses");
        let frames = Frames::new(None);
        assert!(read.settled(*call, true, Some(&result), &frames).is_empty());
        assert!(read.settled(*call, false, None, &frames).is_empty());
        let array = ace_json::parse("[1]").expect("fixture parses");
        assert!(read.settled(*call, false, Some(&array), &frames).is_empty());
    }
}
