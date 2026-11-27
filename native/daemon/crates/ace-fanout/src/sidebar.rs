// SPDX-License-Identifier: Apache-2.0
//! A windowed thread list subscription (ADR 0107): every listed thread and the newest settled
//! page, each sent with the place the daemon gives it in the Threads panel. Ports
//! `apps/daemon/src/sidebar-subscription.ts`.
//!
//! A change sends only the threads it touched, each placed anew, so a thread that moves tabs
//! costs one entry. A list that resumes from a revision of this database and epoch gets only
//! what changed since, and the ids it keeps; any other starts from the whole window. The window
//! carries the rail's dots for what it places live, kept as running totals of the threads sent.
//!
//! Placement (`SidebarPlacement`, `@ace/ui-core`'s `placeWithStanding` and `threadSignal`) is
//! another owner's engine, the sidebar service's; this module asks it for a row's place through
//! [`Placement`], so the transport never decides a tab. The page read is the shell's
//! ([`SidebarStore`]), as are the device's read cursors ([`DeviceReads`]).

use std::collections::{BTreeSet, HashMap};

use ace_json::{JsString, Map, Number, Value};

use crate::event::DeliveryEvent;
use crate::js::{field, field_text, field_truth, number, object};

/// The list's scope: the page's size and filters. `with_chats` is always on, as the client's
/// own list also carries every chat (ADR 0099): a shell mapping this to its query must not drop
/// the flag, and [`SidebarSubscription::new`] sets it however the window arrived.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SidebarWindow {
    pub limit: usize,
    pub project: Option<String>,
    pub archived: bool,
    /// Carry every chat in a project's window (`withChats`, ADR 0099).
    pub with_chats: bool,
    pub resume: Option<ThreadListResume>,
}

/// Where a client says it left the list: this database's and epoch's revision.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThreadListResume {
    pub epoch: String,
    pub revision: u64,
}

/// A page's continuation: the last row's activity and id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThreadListCursor {
    pub at: u64,
    pub id: String,
}

impl ThreadListCursor {
    pub fn from_value(value: &Value) -> Option<ThreadListCursor> {
        Some(ThreadListCursor {
            at: number(field(value, "at")?)? as u64,
            id: field_text(value, "id")?.as_str().to_owned(),
        })
    }

    pub fn to_value(&self) -> Value {
        let mut out = Map::with_capacity(2);
        out.insert("at", Value::Number(Number::from(self.at)));
        out.insert("id", Value::String(JsString::from(self.id.as_str())));
        Value::Object(out)
    }
}

/// One page as the store reads it: rows and the window's watermark, revision and counts.
#[derive(Clone, Debug)]
pub struct SidebarPage {
    pub threads: Vec<Value>,
    pub window: Value,
}

impl SidebarPage {
    pub fn before(&self) -> Option<ThreadListCursor> {
        field(&self.window, "before").and_then(ThreadListCursor::from_value)
    }

    pub fn revision(&self) -> Option<u64> {
        field(&self.window, "revision")
            .and_then(number)
            .map(|revision| revision as u64)
    }

    pub fn from_value(value: &Value) -> Option<SidebarPage> {
        let threads = match field(value, "threads")? {
            Value::Array(items) => items.to_vec(),
            _ => return None,
        };
        Some(SidebarPage {
            threads,
            window: field(value, "window")?.clone(),
        })
    }
}

/// What a live re-read may reuse: the rows the daemon already holds, and the ids that changed.
pub struct PageReuse<'a> {
    pub entries: &'a Map,
    pub changed: &'a BTreeSet<String>,
}

/// The sidebar reads a subscription asks its shell for. Bounded: one page of at most the
/// window's `limit` rows (plus the chat arm for a project), or one live re-read of the same
/// size. The daemon answers them from `ace-store`; nothing here performs I/O.
pub trait SidebarStore {
    fn sidebar_page(
        &self,
        scope: &SidebarWindow,
        before: Option<&ThreadListCursor>,
        reuse: Option<PageReuse<'_>>,
    ) -> SidebarPage;
    /// `sidebarRowRevision(entry)`: the revision the row was read at, so a resume skips it.
    fn sidebar_row_revision(&self, entry: &Value) -> Option<u64>;
    /// `headSeq()`.
    fn head_seq(&self) -> u64;
}

/// A row's place and part in the rail's dots, as the placement engine reads it.
#[derive(Clone, Debug, PartialEq)]
pub struct PlacedStanding {
    pub place: Value,
    pub signal: Option<Value>,
}

/// The placement engine (`SidebarPlacement`): this database's token, sort and seen baseline as
/// one `epoch`, and each row's place under them.
pub trait Placement {
    fn epoch(&self) -> String;
    fn place(&self, entry: &Value) -> Option<PlacedStanding>;
}

/// The subscribing device's read cursors (`DeviceReads`): each row is sent with its own, and
/// again when the device marks it read.
pub trait DeviceReads {
    /// `read(threadId)`: `{ lastSeenSeq, updatedAt }`.
    fn read(&self, thread: &str) -> Value;
}

/// Why a page was refused: its cursor is no longer the list's continuation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidebarError {
    StalePageCursor,
}

impl SidebarError {
    /// The TypeScript's wording, for the socket's `page_failed`.
    pub fn message(&self) -> &'static str {
        match self {
            SidebarError::StalePageCursor => "Stale page cursor",
        }
    }
}

/// A row as the client was last sent it: the entry (with its place) and its part in the dots.
#[derive(Clone, Debug)]
struct Placed {
    entry: Value,
    signal: Option<Value>,
}

/// One windowed list subscription.
pub struct SidebarSubscription {
    id: JsString,
    scope: SidebarWindow,
    limit: usize,
    before: Option<ThreadListCursor>,
    window: Option<Value>,
    selected: Map,
    sent: HashMap<String, Placed>,
    attention: Value,
    paced: bool,
    stopped: bool,
    initializing: bool,
    queued: Vec<DeliveryEvent>,
}

impl SidebarSubscription {
    /// A window about to initialize. `paced` asks for the `subscription.ready` the TypeScript
    /// sends after the snapshot; the scope always carries every chat, as its client's list does.
    pub fn new(id: JsString, mut scope: SidebarWindow, paced: bool) -> SidebarSubscription {
        scope.with_chats = true;
        SidebarSubscription {
            id,
            limit: scope.limit,
            scope,
            before: None,
            window: None,
            selected: Map::new(),
            sent: HashMap::new(),
            attention: no_attention(),
            paced,
            stopped: false,
            initializing: true,
            queued: Vec::new(),
        }
    }

    pub fn id(&self) -> &JsString {
        &self.id
    }

    pub fn is_stopped(&self) -> bool {
        self.stopped
    }

    /// Stop: the shell removes the live, placement, chat-membership and read listeners.
    pub fn stop(&mut self) {
        self.stopped = true;
    }

    /// The read's scope: the client's page size, filters, and every chat (ADR 0099).
    fn read_scope(&self) -> SidebarWindow {
        SidebarWindow {
            limit: self.limit,
            project: self.scope.project.clone(),
            archived: self.scope.archived,
            with_chats: self.scope.with_chats,
            resume: None,
        }
    }

    /// The initial page: the whole window, or only what changed since the resume revision.
    pub fn start(
        &mut self,
        store: &dyn SidebarStore,
        placement: &dyn Placement,
        reads: Option<&dyn DeviceReads>,
    ) -> Vec<Value> {
        let initial = store.sidebar_page(&self.read_scope(), None, None);
        self.before = initial.before();
        let revision = initial.revision();
        let resume = self.scope.resume.clone();
        let resumable = resume.as_ref().is_some_and(|resume| {
            revision.is_some_and(|revision| {
                resume.epoch == placement.epoch() && resume.revision <= revision
            })
        });
        let resume_revision = resume.as_ref().map(|resume| resume.revision);
        let mut keep: Vec<String> = Vec::new();
        let mut fresh: Vec<Value> = Vec::new();
        for entry in &initial.threads {
            let id = entry_id(entry).unwrap_or_default();
            let placed = self.placed(entry, placement);
            self.track(&id, Some(placed.clone()));
            let read = store.sidebar_row_revision(entry);
            if resumable && read.is_some_and(|read| read <= resume_revision.unwrap_or(0)) {
                keep.push(id.as_str().to_owned());
            } else {
                fresh.push(self.stamp(&placed.entry, reads));
            }
            self.selected.insert(id, entry.clone());
        }
        self.window = Some(self.stamped(&initial.window, placement));
        let head = store.head_seq();
        let mut view = Map::with_capacity(6);
        view.insert("kind", Value::String(JsString::from("threads")));
        view.insert("seq", Value::Number(Number::from(head)));
        view.insert("threads", Value::Object(record_of(fresh)));
        if let Some(window) = &self.window {
            view.insert("window", window.clone());
        }
        if resumable {
            let kept: Vec<Value> = keep
                .iter()
                .map(|id| Value::String(JsString::from(id.as_str())))
                .collect();
            view.insert("keep", Value::Array(kept.into()));
            if let Some(reads) = reads {
                let mut cursors = Map::with_capacity(keep.len());
                for thread in &keep {
                    let cursor = reads.read(thread);
                    if field(&cursor, "updatedAt").is_some_and(|at| !matches!(at, Value::Null)) {
                        cursors.insert(thread.as_str(), cursor);
                    }
                }
                view.insert("reads", Value::Object(cursors));
            }
        }
        let mut frames = Vec::with_capacity(1);
        frames.push(snapshot_frame(&self.id, head, Value::Object(view)));
        self.initializing = false;
        let queued = std::mem::take(&mut self.queued);
        frames.extend(self.deliver(queued, store, placement, reads));
        if self.paced {
            // After the snapshot and its queued patches, with the head read now, as the
            // TypeScript's `subscribe` does.
            frames.push(ready_frame(&self.id, store.head_seq()));
        }
        frames
    }

    /// A live batch: only the sidebar's events matter, and only the threads they name.
    pub fn hear(
        &mut self,
        events: Vec<DeliveryEvent>,
        store: &dyn SidebarStore,
        placement: &dyn Placement,
        reads: Option<&dyn DeviceReads>,
    ) -> Vec<Value> {
        if self.stopped {
            return Vec::new();
        }
        if self.initializing {
            self.queued.extend(events);
            return Vec::new();
        }
        self.deliver(events, store, placement, reads)
    }

    fn deliver(
        &mut self,
        events: Vec<DeliveryEvent>,
        store: &dyn SidebarStore,
        placement: &dyn Placement,
        reads: Option<&dyn DeviceReads>,
    ) -> Vec<Value> {
        if self.stopped || !events.iter().any(is_sidebar) {
            return Vec::new();
        }
        let changed: BTreeSet<String> = events
            .iter()
            .filter(|event| is_sidebar(event))
            .filter_map(|event| event.thread_id().map(|id| id.as_str().to_owned()))
            .collect();
        self.resend(&changed, store, placement, reads)
    }

    /// What places threads changed (the sort, the seen baseline): send only the threads that moved.
    pub fn placement_changed(
        &mut self,
        store: &dyn SidebarStore,
        placement: &dyn Placement,
        reads: Option<&dyn DeviceReads>,
    ) -> Vec<Value> {
        if self.stopped || self.initializing || self.window.is_none() {
            return Vec::new();
        }
        let mut threads = Map::new();
        let rows: Vec<(JsString, Value)> = self
            .selected
            .iter()
            .map(|(id, entry)| (id.clone(), entry.clone()))
            .collect();
        for (id, entry) in rows {
            let placed = self.placed(&entry, placement);
            if same_place(self.sent.get(id.as_str()), &placed) {
                continue;
            }
            threads.insert(id.clone(), self.stamp(&placed.entry, reads));
            self.track(id.as_str(), Some(placed));
        }
        self.window = self
            .window
            .clone()
            .map(|window| self.stamped(&window, placement));
        let window = self.window.clone().unwrap_or(Value::Null);
        vec![patch_frame(
            &self.id,
            None,
            store.head_seq(),
            threads,
            Vec::new(),
            window,
        )]
    }

    /// A workspace became or stopped being a chat: re-read the threads it holds (ADR 0099).
    pub fn chat_membership_changed(
        &mut self,
        workspace: &str,
        store: &dyn SidebarStore,
        placement: &dyn Placement,
        reads: Option<&dyn DeviceReads>,
    ) -> Vec<Value> {
        if self.stopped || self.initializing || self.window.is_none() {
            return Vec::new();
        }
        let changed: BTreeSet<String> = self
            .selected
            .iter()
            .filter(|(_, entry)| {
                field_text(entry, "workspaceId").is_some_and(|id| id.as_str() == workspace)
            })
            .map(|(id, _)| id.as_str().to_owned())
            .collect();
        self.resend(&changed, store, placement, reads)
    }

    /// This device marked a row read: send that row again with its cursor.
    pub fn read_moved(
        &mut self,
        thread: &str,
        store: &dyn SidebarStore,
        placement: &dyn Placement,
        reads: Option<&dyn DeviceReads>,
    ) -> Vec<Value> {
        let Some(entry) = self.selected.get(thread).cloned() else {
            return Vec::new();
        };
        let (Some(window), false, Some(reads)) = (self.window.clone(), self.initializing, reads)
        else {
            return Vec::new();
        };
        if self.stopped {
            return Vec::new();
        }
        // The TypeScript's send literal reads `seq` before it stamps the row.
        let seq = store.head_seq();
        let placed = self.placed(&entry, placement);
        let mut threads = Map::with_capacity(1);
        threads.insert(thread, self.stamp(&placed.entry, Some(reads)));
        vec![patch_frame(
            &self.id,
            None,
            seq,
            threads,
            Vec::new(),
            window,
        )]
    }

    /// `page(before, requestId)`: the next settled page, refused when the cursor moved on.
    pub fn page(
        &mut self,
        cursor: &ThreadListCursor,
        request_id: &str,
        store: &dyn SidebarStore,
        placement: &dyn Placement,
        reads: Option<&dyn DeviceReads>,
    ) -> Result<Value, SidebarError> {
        let stale = self.stopped
            || self
                .before
                .as_ref()
                .is_none_or(|before| before.at != cursor.at || before.id != cursor.id);
        if stale {
            return Err(SidebarError::StalePageCursor);
        }
        let next = store.sidebar_page(&self.read_scope(), Some(cursor), None);
        let mut threads = Map::new();
        for entry in &next.threads {
            let Some(id) = entry_id(entry) else {
                continue;
            };
            self.selected.insert(id.as_str(), entry.clone());
            let placed = self.placed(entry, placement);
            threads.insert(id.as_str(), self.stamp(&placed.entry, reads));
            self.track(&id, Some(placed));
        }
        self.limit += next.threads.len();
        self.before = next.before();
        // A page keeps the list's revision: rows older than the window don't advance it.
        let mut window = next.window.clone();
        if let Some(revision) = self
            .window
            .as_ref()
            .and_then(|window| field(window, "revision"))
            .cloned()
            && let Some(map) = object_mut(&mut window)
        {
            map.insert("revision", revision);
        }
        let window = self.stamped(&window, placement);
        self.window = Some(window.clone());
        Ok(patch_frame(
            &self.id,
            Some(request_id),
            store.head_seq(),
            threads,
            Vec::new(),
            window,
        ))
    }

    /// Re-read the window and send the rows it gained, moved or lost.
    fn resend(
        &mut self,
        changed: &BTreeSet<String>,
        store: &dyn SidebarStore,
        placement: &dyn Placement,
        reads: Option<&dyn DeviceReads>,
    ) -> Vec<Value> {
        if self.stopped || self.initializing || self.window.is_none() {
            return Vec::new();
        }
        let scope = self.read_scope();
        let current = store.sidebar_page(
            &scope,
            None,
            Some(PageReuse {
                entries: &self.selected,
                changed,
            }),
        );
        let present: BTreeSet<String> = current
            .threads
            .iter()
            .filter_map(entry_id)
            .map(|id| id.as_str().to_owned())
            .collect();
        let mut threads = Map::new();
        let mut removed = Vec::new();
        let ids: Vec<String> = self
            .selected
            .iter()
            .map(|(id, _)| id.as_str().to_owned())
            .collect();
        for id in ids {
            if present.contains(&id) {
                continue;
            }
            self.selected.remove(id.as_str());
            self.track(&id, None);
            removed.push(Value::String(JsString::from(id.as_str())));
        }
        for entry in &current.threads {
            let Some(id) = entry_id(entry) else {
                continue;
            };
            let unchanged = !changed.contains(id.as_str())
                && self
                    .selected
                    .get(id.as_str())
                    .is_some_and(|held| held == entry);
            if !unchanged {
                let placed = self.placed(entry, placement);
                threads.insert(id.as_str(), self.stamp(&placed.entry, reads));
                self.track(&id, Some(placed));
            }
            self.selected.insert(id.as_str(), entry.clone());
        }
        self.before = current.before();
        self.window = Some(self.stamped(&current.window, placement));
        let window = self.window.clone().unwrap_or(Value::Null);
        vec![patch_frame(
            &self.id,
            None,
            store.head_seq(),
            threads,
            removed,
            window,
        )]
    }

    /// `#thread`: the entry with its place appended, and its part in the dots.
    fn placed(&self, entry: &Value, placement: &dyn Placement) -> Placed {
        let mut rest = object(entry).cloned().unwrap_or_else(Map::new);
        rest.remove("place");
        let found = placement.place(entry);
        let signal = found.as_ref().and_then(|found| found.signal.clone());
        if let Some(found) = found {
            rest.insert("place", found.place);
        }
        Placed {
            entry: Value::Object(rest),
            signal,
        }
    }

    /// `stamp(entry)`: the row with this device's read cursor, when the daemon has it.
    fn stamp(&self, entry: &Value, reads: Option<&dyn DeviceReads>) -> Value {
        let Some(reads) = reads else {
            return entry.clone();
        };
        let Some(id) = entry_id(entry) else {
            return entry.clone();
        };
        let mut copy = object(entry).cloned().unwrap_or_else(Map::new);
        copy.insert("readState", reads.read(id.as_str()));
        Value::Object(copy)
    }

    /// Send `placed` for a row: its old part in the dots goes, its new one comes.
    fn track(&mut self, thread: &str, placed: Option<Placed>) {
        let previous = self.sent.get(thread).and_then(|old| old.signal.clone());
        with_signal(&mut self.attention, previous.as_ref(), -1);
        let Some(placed) = placed else {
            self.sent.remove(thread);
            return;
        };
        with_signal(&mut self.attention, placed.signal.as_ref(), 1);
        self.sent.insert(thread.to_owned(), placed);
    }

    /// `stamped(window)`: the window as the client reads it, with its epoch and rail dots.
    fn stamped(&self, window: &Value, placement: &dyn Placement) -> Value {
        let mut copy = object(window).cloned().unwrap_or_else(Map::new);
        copy.insert(
            "epoch",
            Value::String(JsString::from(placement.epoch().as_str())),
        );
        copy.insert("attention", self.attention.clone());
        Value::Object(copy)
    }
}

fn no_attention() -> Value {
    let counts = || {
        let mut counts = Map::with_capacity(2);
        counts.insert("needsYou", Value::Number(Number::from(0_u64)));
        counts.insert("unread", Value::Number(Number::from(0_u64)));
        Value::Object(counts)
    };
    let mut attention = Map::with_capacity(2);
    attention.insert("threads", counts());
    attention.insert("chats", counts());
    Value::Object(attention)
}

/// `withSignal(totals, signal, sign)`: add or take back a thread's part in its place's dot.
fn with_signal(totals: &mut Value, signal: Option<&Value>, sign: i64) {
    let Some(signal) = signal else {
        return;
    };
    let Some(place) = field_text(signal, "place").map(JsString::as_str) else {
        return;
    };
    if place != "threads" && place != "chats" {
        return;
    }
    let Some(totals) = object_mut(totals) else {
        return;
    };
    let Some(Value::Object(counts)) = totals.get_mut(place) else {
        return;
    };
    for key in ["needsYou", "unread"] {
        if !field_truth(signal, key) {
            continue;
        }
        let current = match counts.get(key) {
            Some(Value::Number(seen)) => seen.value(),
            _ => 0.0,
        };
        if let Some(next) = Number::from_f64(current + sign as f64) {
            counts.insert(key, Value::Number(next));
        }
    }
}

/// `samePlace(a, b)`: the same place and the same part in the dots, compared as JSON.
fn same_place(previous: Option<&Placed>, next: &Placed) -> bool {
    let place_of = |placed: Option<&Placed>| {
        placed
            .and_then(|placed| field(&placed.entry, "place"))
            .map(ace_json::to_string)
    };
    let signal_of = |placed: Option<&Placed>| {
        placed
            .and_then(|placed| placed.signal.as_ref())
            .map(ace_json::to_string)
    };
    place_of(previous) == place_of(Some(next)) && signal_of(previous) == signal_of(Some(next))
}

fn is_sidebar(event: &DeliveryEvent) -> bool {
    event
        .payload_type()
        .is_some_and(|kind| ace_projection::is_sidebar_event(kind.as_str()))
}

fn entry_id(entry: &Value) -> Option<JsString> {
    field_text(entry, "id").cloned()
}

fn record_of(entries: Vec<Value>) -> Map {
    let mut record = Map::with_capacity(entries.len());
    for entry in entries {
        if let Some(id) = entry_id(&entry) {
            record.insert(id, entry);
        }
    }
    record
}

fn patch_frame(
    subscription_id: &JsString,
    request_id: Option<&str>,
    seq: u64,
    threads: Map,
    removed: Vec<Value>,
    window: Value,
) -> Value {
    let mut frame = Map::with_capacity(7);
    frame.insert("type", Value::String(JsString::from("threads.patch")));
    frame.insert("subscriptionId", Value::String(subscription_id.clone()));
    if let Some(request_id) = request_id {
        frame.insert("requestId", Value::String(JsString::from(request_id)));
    }
    frame.insert("seq", Value::Number(Number::from(seq)));
    frame.insert("threads", Value::Object(threads));
    frame.insert("removed", Value::Array(removed.into()));
    frame.insert("window", window);
    Value::Object(frame)
}

fn snapshot_frame(subscription_id: &JsString, seq: u64, view: Value) -> Value {
    let mut frame = Map::with_capacity(4);
    frame.insert("type", Value::String(JsString::from("snapshot")));
    frame.insert("subscriptionId", Value::String(subscription_id.clone()));
    frame.insert("seq", Value::Number(Number::from(seq)));
    frame.insert("view", view);
    Value::Object(frame)
}

/// `{ type: "subscription.ready", subscriptionId, seq }`: a paced window's acknowledgement.
fn ready_frame(subscription_id: &JsString, seq: u64) -> Value {
    let mut frame = Map::with_capacity(3);
    frame.insert("type", Value::String(JsString::from("subscription.ready")));
    frame.insert("subscriptionId", Value::String(subscription_id.clone()));
    frame.insert("seq", Value::Number(Number::from(seq)));
    Value::Object(frame)
}

fn object_mut(value: &mut Value) -> Option<&mut Map> {
    match value {
        Value::Object(map) => Some(map),
        _ => None,
    }
}
