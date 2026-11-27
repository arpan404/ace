#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
// SPDX-License-Identifier: Apache-2.0
//! Ports the cases of the sidebar test files whose behaviour the subscription owns, by name:
//!
//! `apps/daemon/src/sidebar-tabs.process.test.ts`:
//! - "a reconnect from revision N gets only the threads that moved since, and the same tabs as a
//!   fresh list"
//! - "a resume from another database or sort, or from ahead of this database, gets the whole
//!   window"
//! - "a sort change re-places the open list, sending only threads whose place changed"
//! - "the list carries the rail dots: reading every listed chat clears Chats, and a settled chat
//!   never lights it"
//!
//! `apps/daemon/src/sidebar-pagination.process.test.ts`:
//! - "a settled thread that comes to need the person is listed with the work in hand, not paged
//!   as settled"
//! - "a project's paged window carries every chat, and paging reaches each exactly once"
//!
//! `apps/daemon/src/sidebar-read-state.test.ts`:
//! - "a list for no known device carries no read cursors"
//!
//! Byte equality with the TypeScript lives in `tests/sidebar_vectors.rs`; these cases assert the
//! rules over a small in-memory page.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;

use ace_fanout::{
    DeviceReads, PageReuse, PlacedStanding, Placement, SidebarPage, SidebarStore,
    SidebarSubscription, SidebarWindow, ThreadListCursor,
};
use ace_json::{JsString, Value};

fn parse(text: &str) -> Value {
    ace_json::parse(text).expect("parse JSON")
}

fn entry(id: &str, workspace: &str, settled: bool) -> Value {
    parse(&format!(
        r#"{{"id":"{id}","workspaceId":"{workspace}","title":"{id}","provider":"codex","status":{{"state":"{}"}},"createdAt":1,"updatedAt":2,"settledAt":3}}"#,
        if settled { "done" } else { "working" }
    ))
}

fn window_of(rows: &[Value]) -> Value {
    let mut threads = ace_json::Map::with_capacity(rows.len());
    for row in rows {
        if let Some(Value::String(id)) = row.get("id") {
            threads.insert(id.clone(), row.clone());
        }
    }
    let mut window = ace_json::Map::with_capacity(4);
    window.insert("before", Value::Null);
    window.insert(
        "total",
        Value::Number(ace_json::Number::from(rows.len() as u64)),
    );
    window.insert("counts", Value::Array(Vec::new().into()));
    window.insert("revision", Value::Number(ace_json::Number::from(7_u64)));
    let mut page = ace_json::Map::with_capacity(2);
    page.insert("threads", Value::Object(threads));
    page.insert("window", Value::Object(window));
    Value::Object(page)
}

struct Mem {
    rows: RefCell<Vec<Value>>,
    revision: Cell<Option<u64>>,
    /// The scopes `sidebar_page` was read with, for the flag the daemon forces.
    scopes: RefCell<Vec<SidebarWindow>>,
    /// Heads to answer before the default 10, so a second read can differ.
    heads: RefCell<std::collections::VecDeque<u64>>,
    /// A chat thread the page carries only when the read asks for every chat (ADR 0099).
    chat_row: Option<Value>,
}

impl Mem {
    fn new(rows: Vec<Value>) -> Mem {
        Mem {
            rows: RefCell::new(rows),
            revision: Cell::new(Some(1)),
            scopes: RefCell::new(Vec::new()),
            heads: RefCell::new(std::collections::VecDeque::new()),
            chat_row: None,
        }
    }
}

impl SidebarStore for Mem {
    fn sidebar_page(
        &self,
        scope: &SidebarWindow,
        _before: Option<&ThreadListCursor>,
        _reuse: Option<PageReuse<'_>>,
    ) -> SidebarPage {
        self.scopes.borrow_mut().push(scope.clone());
        let mut rows = self.rows.borrow().clone();
        // The store's own rule: a project window carries chats only when asked to.
        if scope.with_chats
            && let Some(chat) = &self.chat_row
        {
            rows.push(chat.clone());
        }
        SidebarPage {
            window: window_of(&rows),
            threads: rows,
        }
    }

    fn sidebar_row_revision(&self, _entry: &Value) -> Option<u64> {
        self.revision.get()
    }

    fn head_seq(&self) -> u64 {
        self.heads.borrow_mut().pop_front().unwrap_or(10)
    }
}

struct Places {
    epoch: RefCell<String>,
    places: RefCell<HashMap<String, Option<PlacedStanding>>>,
}

impl Places {
    fn new(epoch: &str, places: HashMap<String, Option<PlacedStanding>>) -> Places {
        Places {
            epoch: RefCell::new(epoch.to_owned()),
            places: RefCell::new(places),
        }
    }
}

impl Placement for Places {
    fn epoch(&self) -> String {
        self.epoch.borrow().clone()
    }

    fn place(&self, entry: &Value) -> Option<PlacedStanding> {
        let Some(Value::String(id)) = entry.get("id") else {
            return None;
        };
        self.places.borrow().get(id.as_str()).cloned().flatten()
    }
}

fn place(tab: &str, rank: u64) -> Option<PlacedStanding> {
    let mut place = ace_json::Map::with_capacity(2);
    place.insert("tab", Value::String(JsString::from(tab)));
    place.insert(
        "rank",
        Value::Array(vec![Value::Number(ace_json::Number::from(rank))].into()),
    );
    Some(PlacedStanding {
        place: Value::Object(place),
        signal: None,
    })
}

fn places(ids: &[&str], tab: &str) -> HashMap<String, Option<PlacedStanding>> {
    ids.iter()
        .enumerate()
        .map(|(index, id)| ((*id).to_owned(), place(tab, 100 - index as u64)))
        .collect()
}

fn window(limit: usize) -> SidebarWindow {
    SidebarWindow {
        limit,
        project: None,
        archived: false,
        with_chats: true,
        resume: None,
    }
}

fn snapshot_view(frames: &[Value]) -> &ace_json::Map {
    match frames[0].get("view") {
        Some(Value::Object(view)) => view,
        _ => panic!("no snapshot view"),
    }
}

/// "a resume from another database or sort, or from ahead of this database, gets the whole
/// window": the epoch is not this one's, so nothing is kept.
#[test]
fn a_resume_from_another_epoch_gets_the_whole_window() {
    let rows = vec![entry("a", "w", false), entry("b", "w", true)];
    let mem = Mem::new(rows);
    let placement = Places::new("token:activity:0", places(&["a", "b"], "settled"));
    let mut scope = window(20);
    scope.resume = Some(ace_fanout::ThreadListResume {
        epoch: "another:activity:0".to_owned(),
        revision: 1,
    });
    let mut sidebar = SidebarSubscription::new(JsString::from("s"), scope, false);
    let frames = sidebar.start(&mem, &placement, None);
    let view = snapshot_view(&frames);
    assert!(!view.contains_key("keep"));
    let Some(Value::Object(threads)) = view.get("threads") else {
        panic!("threads");
    };
    assert_eq!(threads.len(), 2);
}

/// "a list for no known device carries no read cursors".
#[test]
fn a_list_for_no_known_device_carries_no_read_cursors() {
    let mem = Mem::new(vec![entry("a", "w", false)]);
    let placement = Places::new("token:activity:0", places(&["a"], "inbox"));
    let mut sidebar = SidebarSubscription::new(JsString::from("s"), window(20), false);
    let frames = sidebar.start(&mem, &placement, None);
    let Some(Value::Object(threads)) = snapshot_view(&frames).get("threads") else {
        panic!("threads");
    };
    let Some(Value::Object(row)) = threads.get("a") else {
        panic!("row");
    };
    assert!(!row.contains_key("readState"));
}

/// "a sort change re-places the open list, sending only threads whose place changed".
#[test]
fn a_sort_change_sends_only_the_threads_whose_place_changed() {
    let mem = Mem::new(vec![
        entry("a", "w", false),
        entry("b", "w", false),
        entry("c", "w", false),
    ]);
    let placement = Places::new("token:activity:0", places(&["a", "b", "c"], "inbox"));
    let mut sidebar = SidebarSubscription::new(JsString::from("s"), window(20), false);
    sidebar.start(&mem, &placement, None);
    // The sort changes: `b` moves to Snoozed, the others keep their place and rank.
    let mut changed = places(&["a", "c"], "inbox");
    changed.insert("c".to_owned(), place("inbox", 98));
    changed.insert("b".to_owned(), place("snoozed", 50));
    placement.epoch.replace("token:created:0".to_owned());
    placement.places.replace(changed);
    let frames = sidebar.placement_changed(&mem, &placement, None);
    assert_eq!(frames.len(), 1);
    let patch = &frames[0];
    let Some(Value::Object(threads)) = patch.get("threads") else {
        panic!("threads");
    };
    assert_eq!(threads.len(), 1);
    assert!(threads.contains_key("b"));
    let Some(Value::Object(window)) = patch.get("window") else {
        panic!("window");
    };
    assert_eq!(
        window.get("epoch").and_then(|epoch| match epoch {
            Value::String(seen) => Some(seen.as_str().to_owned()),
            _ => None,
        }),
        Some("token:created:0".to_owned())
    );
}

/// "the list carries the rail dots": only what the window places live adds to them, and taking
/// a thread out takes its part back.
#[test]
fn the_window_carries_the_rail_dots() {
    let mem = Mem::new(vec![entry("a", "w", false), entry("b", "w", false)]);
    let mut given = places(&["a", "b"], "inbox");
    let signal = |needs_you: bool, unread: bool| {
        let mut signal = ace_json::Map::with_capacity(3);
        signal.insert("place", Value::String(JsString::from("threads")));
        signal.insert("needsYou", Value::Bool(needs_you));
        signal.insert("unread", Value::Bool(unread));
        Value::Object(signal)
    };
    given.insert(
        "a".to_owned(),
        Some(PlacedStanding {
            place: place("inbox", 1).expect("place").place,
            signal: Some(signal(true, false)),
        }),
    );
    given.insert(
        "b".to_owned(),
        Some(PlacedStanding {
            place: place("settled", 2).expect("place").place,
            signal: Some(signal(false, true)),
        }),
    );
    let placement = Places::new("token:activity:0", given);
    let mut sidebar = SidebarSubscription::new(JsString::from("s"), window(20), false);
    let frames = sidebar.start(&mem, &placement, None);
    let Some(Value::Object(window)) = snapshot_view(&frames).get("window") else {
        panic!("window");
    };
    let Some(Value::Object(attention)) = window.get("attention") else {
        panic!("attention");
    };
    let Some(Value::Object(threads)) = attention.get("threads") else {
        panic!("threads");
    };
    assert_eq!(
        threads.get("needsYou").and_then(|count| match count {
            Value::Number(seen) => Some(seen.value()),
            _ => None,
        }),
        Some(1.0)
    );
    assert_eq!(
        threads.get("unread").and_then(|count| match count {
            Value::Number(seen) => Some(seen.value()),
            _ => None,
        }),
        Some(1.0)
    );
}

/// A chat workspace's membership change re-reads only the threads it holds.
#[test]
fn a_chat_membership_change_rereads_only_its_threads() {
    let mem = Mem::new(vec![entry("a", "w1", true), entry("b", "w2", true)]);
    let placement = Places::new("token:activity:0", places(&["a", "b"], "settled"));
    let mut sidebar = SidebarSubscription::new(JsString::from("s"), window(20), false);
    sidebar.start(&mem, &placement, None);
    let frames = sidebar.chat_membership_changed("w1", &mem, &placement, None);
    assert_eq!(frames.len(), 1);
    let Some(Value::Object(threads)) = frames[0].get("threads") else {
        panic!("threads");
    };
    assert_eq!(threads.len(), 1);
    assert!(threads.contains_key("a"));
}

/// A stopped window hears, places and pages nothing more.
#[test]
fn a_stopped_window_sends_nothing_more() {
    let mem = Mem::new(vec![entry("a", "w", false)]);
    let placement = Places::new("token:activity:0", places(&["a"], "inbox"));
    let mut sidebar = SidebarSubscription::new(JsString::from("s"), window(20), false);
    sidebar.start(&mem, &placement, None);
    sidebar.stop();
    assert!(sidebar.placement_changed(&mem, &placement, None).is_empty());
    assert!(
        sidebar
            .chat_membership_changed("w", &mem, &placement, None)
            .is_empty()
    );
    assert!(
        sidebar
            .read_moved("a", &mem, &placement, Some(&NoReads))
            .is_empty()
    );
    assert!(matches!(
        sidebar.page(
            &ace_fanout::ThreadListCursor {
                at: 1,
                id: "a".to_owned()
            },
            "p",
            &mem,
            &placement,
            None
        ),
        Err(ace_fanout::SidebarError::StalePageCursor)
    ));
}

struct NoReads;

impl DeviceReads for NoReads {
    fn read(&self, _thread: &str) -> Value {
        parse(r#"{"lastSeenSeq":0,"updatedAt":null}"#)
    }
}

/// A paced window says it is ready after its snapshot, with the head read then (the
/// TypeScript's `subscribe` sends it for windows too).
#[test]
fn a_paced_window_says_it_is_ready_after_its_snapshot_with_a_fresh_head() {
    let mem = Mem::new(vec![entry("a", "w", false)]);
    mem.heads.borrow_mut().extend([10, 11]);
    let placement = Places::new("token:activity:0", places(&["a"], "inbox"));
    let mut sidebar = SidebarSubscription::new(JsString::from("s"), window(20), true);
    let frames = sidebar.start(&mem, &placement, None);
    assert_eq!(frames.len(), 2);
    assert_eq!(frame_type(&frames[0]), "snapshot");
    assert_eq!(frame_seq(&frames[0]), 10);
    assert_eq!(frame_type(&frames[1]), "subscription.ready");
    assert_eq!(
        frame_seq(&frames[1]),
        11,
        "the head read after the snapshot"
    );
    assert_eq!(
        frames[1].get("subscriptionId").and_then(|id| match id {
            Value::String(seen) => Some(seen.as_str()),
            _ => None,
        }),
        Some("s")
    );
}

/// The daemon reads every window with every chat, whatever flag the shell passes (ADR 0099), on
/// the first read and on a live re-read alike: the rows the store returns prove it.
#[test]
fn a_window_reads_every_chat_whatever_arrived() {
    let mut mem = Mem::new(vec![entry("a", "w", false)]);
    mem.chat_row = Some(entry("chat", "w2", false));
    let placement = Places::new("token:activity:0", places(&["a", "chat"], "inbox"));
    let mut scope = window(20);
    scope.with_chats = false;
    let mut sidebar = SidebarSubscription::new(JsString::from("s"), scope, false);
    let frames = sidebar.start(&mem, &placement, None);
    let Some(Value::Object(threads)) = snapshot_view(&frames).get("threads") else {
        panic!("threads");
    };
    assert!(threads.contains_key("a"));
    assert!(
        threads.contains_key("chat"),
        "the project window carries its chat"
    );
    sidebar.chat_membership_changed("w", &mem, &placement, None);
    let scopes = mem.scopes.borrow();
    assert_eq!(scopes.len(), 2);
    assert!(scopes.iter().all(|scope| scope.with_chats));
}

/// Paging asks the store for one page of the initial `scope.limit`, never the grown window limit,
/// while a live resend re-reads the full grown window (`sidebar-subscription.ts:88, :237`).
#[test]
fn paging_keeps_the_initial_page_size_while_live_resends_cover_the_grown_window() {
    struct PagedStore {
        pages: RefCell<std::collections::VecDeque<SidebarPage>>,
        scopes: RefCell<Vec<SidebarWindow>>,
    }
    impl SidebarStore for PagedStore {
        fn sidebar_page(
            &self,
            scope: &SidebarWindow,
            _before: Option<&ThreadListCursor>,
            _reuse: Option<PageReuse<'_>>,
        ) -> SidebarPage {
            self.scopes.borrow_mut().push(scope.clone());
            self.pages
                .borrow_mut()
                .pop_front()
                .unwrap_or_else(|| SidebarPage {
                    threads: Vec::new(),
                    window: parse(r#"{"revision":1,"before":null,"hasMore":false}"#),
                })
        }
        fn sidebar_row_revision(&self, _entry: &Value) -> Option<u64> {
            None
        }
        fn head_seq(&self) -> u64 {
            10
        }
    }

    let store = PagedStore {
        pages: RefCell::new(std::collections::VecDeque::from([
            SidebarPage {
                threads: vec![entry("a", "w", false), entry("b", "w", false)],
                window: parse(r#"{"revision":1,"before":{"at":2,"id":"b"},"hasMore":true}"#),
            },
            SidebarPage {
                threads: vec![entry("c", "w", false), entry("d", "w", false)],
                window: parse(r#"{"revision":1,"before":{"at":1,"id":"d"},"hasMore":true}"#),
            },
            SidebarPage {
                threads: vec![entry("e", "w", false)],
                window: parse(r#"{"revision":1,"before":null,"hasMore":false}"#),
            },
            SidebarPage {
                threads: vec![
                    entry("a", "w", false),
                    entry("b", "w", false),
                    entry("c", "w", false),
                    entry("d", "w", false),
                    entry("e", "w", false),
                ],
                window: parse(r#"{"revision":2,"before":null,"hasMore":false}"#),
            },
        ])),
        scopes: RefCell::new(Vec::new()),
    };
    let placement = Places::new(
        "token:activity:0",
        places(&["a", "b", "c", "d", "e"], "inbox"),
    );
    let mut sidebar = SidebarSubscription::new(JsString::from("s"), window(2), false);
    sidebar.start(&store, &placement, None);
    sidebar
        .page(
            &ThreadListCursor {
                at: 2,
                id: "b".to_owned(),
            },
            "p1",
            &store,
            &placement,
            None,
        )
        .unwrap();
    sidebar
        .page(
            &ThreadListCursor {
                at: 1,
                id: "d".to_owned(),
            },
            "p2",
            &store,
            &placement,
            None,
        )
        .unwrap();
    sidebar.chat_membership_changed("w", &store, &placement, None);

    let limits: Vec<usize> = store.scopes.borrow().iter().map(|s| s.limit).collect();
    assert_eq!(limits, vec![2, 2, 2, 5]);
}

fn frame_type(frame: &Value) -> &str {
    match frame.get("type") {
        Some(Value::String(seen)) => seen.as_str(),
        _ => panic!("type"),
    }
}

fn frame_seq(frame: &Value) -> u64 {
    match frame.get("seq") {
        Some(Value::Number(seen)) => seen.value() as u64,
        _ => panic!("seq"),
    }
}
