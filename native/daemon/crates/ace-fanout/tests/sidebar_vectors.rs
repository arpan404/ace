#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
// SPDX-License-Identifier: Apache-2.0
//! Byte equality with `apps/daemon/src/sidebar-subscription.ts`. `vectors/sidebar.json` is
//! produced by `vectors/make-sidebar-vectors.ts` from the TypeScript `subscribe` over a
//! windowed scope with a real `Store` and `SidebarPlacement`: every sidebar read it asked for
//! (in order, with its result), every place it sent a row with, the device's read cursors, and
//! every `snapshot`/`threads.patch` frame, page and read-state patch.
//!
//! The Rust subscription answers the same reads through a scripted [`SidebarStore`] and
//! [`DeviceReads`], places rows from the recorded places, and must produce the same bytes.

use std::cell::Cell;
use std::collections::HashMap;

use ace_fanout::{
    DeliveryEvent, DeviceReads, PageReuse, PlacedStanding, Placement, SidebarError, SidebarPage,
    SidebarStore, SidebarSubscription, SidebarWindow, ThreadListCursor, ThreadListResume,
};
use ace_json::{JsString, Value};

fn vectors() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/vectors/sidebar.json");
    let text = std::fs::read_to_string(path).expect("read sidebar.json");
    ace_json::parse(&text).expect("parse sidebar.json")
}

fn text(value: &Value, key: &str) -> String {
    match value.get(key) {
        Some(Value::String(seen)) => seen.as_str().to_owned(),
        _ => panic!("{key} is not a string"),
    }
}

fn number(value: &Value, key: &str) -> f64 {
    match value.get(key) {
        Some(Value::Number(seen)) => seen.value(),
        _ => panic!("{key} is not a number"),
    }
}

fn array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    match value.get(key) {
        Some(Value::Array(items)) => items,
        _ => panic!("{key} is not an array"),
    }
}

fn entry_text(entry: &Value, key: &str) -> Option<String> {
    match entry.get(key) {
        Some(Value::String(seen)) => Some(seen.as_str().to_owned()),
        _ => None,
    }
}

fn entry_arg(entry: &Value, index: usize) -> Option<&Value> {
    array(entry, "args").get(index)
}

fn arg_text(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(seen)) => Some(seen.as_str().to_owned()),
        _ => None,
    }
}

fn parse(text: &str) -> Value {
    ace_json::parse(text).expect("parse fixture JSON")
}

/// The fixture's reads, served in order.
struct Scripted {
    name: String,
    reads: Vec<Value>,
    at: Cell<usize>,
}

impl Scripted {
    fn new(name: &str, case: &Value) -> Scripted {
        let mut reads = array(case, "reads").to_vec();
        assert_eq!(
            reads
                .first()
                .and_then(|entry| entry_text(entry, "call"))
                .as_deref(),
            Some("subscribe"),
            "the shell registers before it reads"
        );
        reads.remove(0);
        // The read cursor listener is the shell's too.
        if reads
            .first()
            .and_then(|entry| entry_text(entry, "call"))
            .as_deref()
            == Some("onThreadRead")
        {
            reads.remove(0);
        }
        Scripted {
            name: name.to_owned(),
            reads,
            at: Cell::new(0),
        }
    }

    fn take(&self, call: &str) -> Value {
        let at = self.at.get();
        let entry = self.reads.get(at).unwrap_or_else(|| {
            panic!(
                "{}: read {call} was not in the script (all {} reads consumed)",
                self.name,
                self.reads.len()
            )
        });
        assert_eq!(
            entry_text(entry, "call").as_deref(),
            Some(call),
            "{}: read {at} should be {call}",
            self.name
        );
        self.at.set(at + 1);
        entry.clone()
    }

    fn result(entry: &Value) -> Value {
        entry.get("result").cloned().unwrap_or(Value::Null)
    }

    fn consumed(&self) -> bool {
        self.at.get() == self.reads.len()
    }
}

impl SidebarStore for Scripted {
    fn sidebar_page(
        &self,
        scope: &SidebarWindow,
        before: Option<&ThreadListCursor>,
        reuse: Option<PageReuse<'_>>,
    ) -> SidebarPage {
        let entry = self.take("sidebarPage");
        let recorded = parse(&arg_text(entry_arg(&entry, 0)).expect("scope arg"));
        assert_eq!(number(&recorded, "limit") as usize, scope.limit);
        assert_eq!(
            recorded.get("project").and_then(|project| match project {
                Value::String(seen) => Some(seen.as_str().to_owned()),
                _ => None,
            }),
            scope.project
        );
        assert_eq!(
            matches!(recorded.get("archived"), Some(Value::Bool(true))),
            scope.archived
        );
        assert!(matches!(recorded.get("withChats"), Some(Value::Bool(true))));
        assert_eq!(
            arg_text(entry_arg(&entry, 1)),
            before.map(|before| ace_json::to_string(&before.to_value()))
        );
        assert_eq!(
            arg_text(entry_arg(&entry, 2)),
            reuse.map(|reuse| {
                let changed: Vec<Value> = reuse
                    .changed
                    .iter()
                    .map(|id| Value::String(JsString::from(id.as_str())))
                    .collect();
                ace_json::to_string(&Value::Array(changed.into()))
            })
        );
        match Scripted::result(&entry) {
            Value::String(seen) => {
                SidebarPage::from_value(&parse(seen.as_str())).expect("sidebar page")
            }
            _ => panic!("sidebarPage result"),
        }
    }

    fn sidebar_row_revision(&self, entry: &Value) -> Option<u64> {
        let read = self.take("sidebarRowRevision");
        let Some(id) = entry.get("id").and_then(|id| match id {
            Value::String(seen) => Some(seen.as_str().to_owned()),
            _ => None,
        }) else {
            panic!("entry id");
        };
        assert_eq!(arg_text(entry_arg(&read, 0)), Some(id));
        match Scripted::result(&read) {
            Value::Number(seen) => Some(seen.value() as u64),
            Value::Null => None,
            _ => panic!("sidebarRowRevision result"),
        }
    }

    fn head_seq(&self) -> u64 {
        let entry = self.take("headSeq");
        match Scripted::result(&entry) {
            Value::Number(seen) => seen.value() as u64,
            _ => panic!("headSeq result"),
        }
    }
}

impl DeviceReads for Scripted {
    fn read(&self, thread: &str) -> Value {
        let entry = self.take("threadReadState");
        assert_eq!(arg_text(entry_arg(&entry, 0)), Some(thread.to_owned()));
        match Scripted::result(&entry) {
            Value::String(seen) => parse(seen.as_str()),
            _ => panic!("threadReadState result"),
        }
    }
}

/// The recorded places, by thread id, under one epoch.
struct RecordedPlacement {
    epoch: String,
    places: HashMap<String, Option<PlacedStanding>>,
}

impl RecordedPlacement {
    fn new(epoch: &str, places: &Value) -> RecordedPlacement {
        let mut recorded = HashMap::new();
        match places {
            Value::Object(map) => {
                for (id, place) in map.iter() {
                    match place {
                        Value::Null => {
                            recorded.insert(id.as_str().to_owned(), None);
                        }
                        Value::Object(fields) => {
                            let Some(Value::Object(place)) = fields.get("place") else {
                                panic!("place");
                            };
                            let signal = match fields.get("signal") {
                                Some(Value::Null) | None => None,
                                Some(signal) => Some(signal.clone()),
                            };
                            recorded.insert(
                                id.as_str().to_owned(),
                                Some(PlacedStanding {
                                    place: Value::Object(place.clone()),
                                    signal,
                                }),
                            );
                        }
                        _ => panic!("place entry"),
                    }
                }
            }
            _ => panic!("places is not an object"),
        }
        RecordedPlacement {
            epoch: epoch.to_owned(),
            places: recorded,
        }
    }
}

impl Placement for RecordedPlacement {
    fn epoch(&self) -> String {
        self.epoch.clone()
    }

    fn place(&self, entry: &Value) -> Option<PlacedStanding> {
        let id = entry.get("id").and_then(|id| match id {
            Value::String(seen) => Some(seen.as_str().to_owned()),
            _ => None,
        })?;
        self.places.get(&id).cloned().flatten()
    }
}

fn window_of(case: &Value) -> SidebarWindow {
    let window = case.get("window").expect("window");
    let resume = window.get("resume").map(|resume| ThreadListResume {
        epoch: text(resume, "epoch"),
        revision: number(resume, "revision") as u64,
    });
    SidebarWindow {
        limit: number(window, "limit") as usize,
        project: window.get("project").and_then(|project| match project {
            Value::String(seen) => Some(seen.as_str().to_owned()),
            _ => None,
        }),
        archived: matches!(window.get("archived"), Some(Value::Bool(true))),
        resume,
    }
}

fn expected(list: &[Value]) -> Vec<String> {
    list.iter()
        .map(|frame| match frame {
            Value::String(text) => text.as_str().to_owned(),
            _ => panic!("frame is not a string"),
        })
        .collect()
}

fn strings(frames: &[Value]) -> Vec<String> {
    frames.iter().map(ace_json::to_string).collect()
}

fn live_events(entry: &Value) -> Vec<DeliveryEvent> {
    array(entry, "events")
        .iter()
        .map(|event| match event {
            Value::String(seen) => DeliveryEvent::parse(seen.as_str()).expect("live event"),
            _ => panic!("live event is not a string"),
        })
        .collect()
}

#[test]
fn the_sidebar_sends_the_typescripts_bytes() {
    let vectors = vectors();
    for case in array(&vectors, "cases") {
        let name = text(case, "name");
        let scripted = Scripted::new(&name, case);
        let epochs = array(case, "epochs");
        let first = epochs.first().expect("an epoch");
        let placement =
            RecordedPlacement::new(&text(first, "epoch"), first.get("places").expect("places"));
        let device = matches!(case.get("device"), Some(Value::Bool(true)));
        let reads: Option<&dyn DeviceReads> = if device { Some(&scripted) } else { None };
        let mut sidebar = SidebarSubscription::new(JsString::from("window"), window_of(case));
        let frames = sidebar.start(&scripted, &placement, reads);
        assert_eq!(
            strings(&frames),
            expected(array(case, "frames")),
            "{name} / start"
        );
        for live in array(case, "live") {
            let sent = sidebar.hear(live_events(live), &scripted, &placement, reads);
            assert_eq!(
                strings(&sent),
                expected(array(live, "frames")),
                "{name} / live"
            );
        }
        if let Some(page) = present(case, "page") {
            let cursor = cursor_of(page.get("cursor").expect("cursor"));
            let request_id = text(page, "requestId");
            let frame = sidebar
                .page(&cursor, &request_id, &scripted, &placement, reads)
                .unwrap_or_else(|error| panic!("{name}: {}", error.message()));
            assert_eq!(
                strings(&[frame]),
                expected(array(page, "frames")),
                "{name} / page"
            );
        }
        if let Some(stale) = present(case, "pageStale") {
            let cursor = cursor_of(stale.get("cursor").expect("cursor"));
            let error = sidebar
                .page(
                    &cursor,
                    &text(stale, "requestId"),
                    &scripted,
                    &placement,
                    reads,
                )
                .expect_err("a stale cursor");
            assert_eq!(error, SidebarError::StalePageCursor);
            assert_eq!(error.message(), text(stale, "error"));
        }
        if let Some(change) = present(case, "change") {
            let thread = text(change, "threadId");
            let frames = sidebar.read_moved(&thread, &scripted, &placement, reads);
            assert_eq!(
                strings(&frames),
                expected(array(change, "frames")),
                "{name} / read"
            );
        }
        assert!(
            scripted.consumed(),
            "{name}: {} reads were not asked for",
            scripted.reads.len() - scripted.at.get()
        );
    }
}

/// A case's optional part, when the fixture carries it (a JSON `null` is absent).
fn present<'a>(case: &'a Value, key: &str) -> Option<&'a Value> {
    case.get(key).filter(|value| !matches!(value, Value::Null))
}

fn cursor_of(value: &Value) -> ThreadListCursor {
    ThreadListCursor {
        at: number(value, "at") as u64,
        id: text(value, "id"),
    }
}
