// SPDX-License-Identifier: Apache-2.0
//! The scans around the reads: one thread's queue and the loaded-thread
//! reconcile (`refreshQueue`, `:252`, and `reconcileLoaded`, `:266`).

use std::collections::VecDeque;

use ace_json::{Map, Value};
use indexmap::IndexSet;

use crate::session::frames::Effect;
use crate::session::state::{Session, text_of};

use super::{OUTPUT_TASK, Origin, RECOVERY_MS, REQUEST_MS};

/// One `thread/loaded/list` scan (`reconcileLoaded`, `:266`).
pub(crate) struct Reconcile {
    pub scan_revision: u64,
    pub list_call: Option<u64>,
    pub cursor: Option<String>,
    pub pending: VecDeque<String>,
    pub current: Option<String>,
}

/// One `thread/queue/list` read (`refreshQueue`, `:252`).
pub(crate) struct QueueRead {
    pub thread: String,
    pub cursor: Option<String>,
    pub count: u64,
}

impl Session {
    /// `refreshQueue`: one thread's queued messages, in bounded pages (`:252`).
    pub(crate) fn refresh_queue(&mut self, thread: &str) -> Vec<Effect> {
        let call = self.calls.take();
        self.discovery.queues.insert(
            call,
            QueueRead {
                thread: thread.to_owned(),
                cursor: None,
                count: 0,
            },
        );
        queue_page(call, thread, None)
    }

    /// One `thread/queue/list` reply, when this call is a queue read's.
    pub(crate) fn queue_settled(
        &mut self,
        call: u64,
        reply: Result<&Value, &str>,
    ) -> Option<Vec<Effect>> {
        if !self.discovery.queues.contains_key(&call) {
            return None;
        }
        let result = match reply {
            Ok(result) => result,
            Err(message) => {
                self.discovery.queues.shift_remove(&call);
                return Some(self.diagnostic(message));
            }
        };
        let body = result.as_object().cloned().unwrap_or_default();
        let count = body
            .get("data")
            .and_then(Value::as_array)
            .map_or(0, |data| data.len() as u64);
        let next = text_of(body.get("nextCursor"));
        let Some(read) = self.discovery.queues.get_mut(&call) else {
            return Some(Vec::new());
        };
        read.count += count;
        if !next.is_empty() {
            read.cursor = Some(next.clone());
            let thread = read.thread.clone();
            return Some(queue_page(call, &thread, Some(&next)));
        }
        let read = self.discovery.queues.shift_remove(&call);
        let Some(read) = read else {
            return Some(Vec::new());
        };
        self.discovery
            .queue_counts
            .insert(read.thread.clone(), read.count);
        let total: u64 = self.discovery.queue_counts.values().sum();
        let mut note = Map::new();
        note.insert("event", Value::from("queue-state"));
        note.insert("count", Value::from(total as f64));
        Some(self.emit_note(&Value::Object(note)))
    }

    /// `reconcileLoaded(task, scanRevision = outputRevision)`: every loaded
    /// thread this session may own, read once (`:266`).
    pub(crate) fn reconcile_loaded(&mut self, task: &str) -> Vec<Effect> {
        if self.discovery.tasks.contains_key(task) {
            return Vec::new();
        }
        let scan_revision = self.discovery.output_revision;
        self.discovery.tasks.insert(
            task.to_owned(),
            Reconcile {
                scan_revision,
                list_call: None,
                cursor: None,
                pending: VecDeque::new(),
                current: None,
            },
        );
        self.reconcile_page(task)
    }

    /// Asks for the next `thread/loaded/list` page.
    fn reconcile_page(&mut self, task: &str) -> Vec<Effect> {
        let call = self.calls.take();
        let Some(task_state) = self.discovery.tasks.get_mut(task) else {
            return Vec::new();
        };
        task_state.list_call = Some(call);
        let cursor = task_state.cursor.clone();
        let mut params = Map::new();
        if let Some(cursor) = &cursor {
            params.insert("cursor", Value::from(cursor.clone()));
        }
        vec![Effect::Request {
            call,
            method: "thread/loaded/list".to_owned(),
            params: Value::Object(params),
            timeout_ms: Some(REQUEST_MS),
        }]
    }

    /// One `thread/loaded/list` reply, when this call is a scan's.
    pub(crate) fn reconcile_settled(
        &mut self,
        call: u64,
        reply: Result<&Value, &str>,
    ) -> Option<Vec<Effect>> {
        let task = self
            .discovery
            .tasks
            .iter()
            .find(|(_, state)| state.list_call == Some(call))
            .map(|(task, _)| task.clone())?;
        let result = match reply {
            Ok(result) => result,
            Err(_) => return Some(self.reconcile_failed(&task)),
        };
        let body = result.as_object().cloned().unwrap_or_default();
        let entries = body
            .get("data")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let next = text_of(body.get("nextCursor"));
        let foreign = &self.foreign;
        if let Some(state) = self.discovery.tasks.get_mut(&task) {
            state.list_call = None;
            for entry in entries {
                let Some(thread) = entry.as_str() else {
                    continue;
                };
                if self.recovered.contains(thread) || foreign(thread) {
                    continue;
                }
                state.pending.push_back(thread.to_owned());
            }
            state.cursor = Some(next.clone()).filter(|next| !next.is_empty());
        }
        Some(self.reconcile_continue(&task, ""))
    }

    /// Starts the next pending read, or finishes the scan (one `:288`).
    pub(crate) fn reconcile_continue(&mut self, task: &str, released: &str) -> Vec<Effect> {
        let Some(state) = self.discovery.tasks.get_mut(task) else {
            return Vec::new();
        };
        if let Some(current) = &state.current {
            if current == released {
                state.current = None;
            } else {
                return Vec::new();
            }
        }
        if state.list_call.is_some() {
            // The next page is still on its way; the scan resumes when it lands.
            return Vec::new();
        }
        match state.pending.pop_front() {
            Some(thread) => {
                if self.recovered.contains(&thread) {
                    return self.reconcile_continue(task, "");
                }
                // `reconcileLoaded` awaits the read: one already in flight is
                // joined, and this scan moves on when it releases.
                state.current = Some(thread.clone());
                self.read_thread(
                    &thread,
                    &IndexSet::new(),
                    Origin::Reconcile(task.to_owned()),
                )
            }
            None => {
                if let Some(cursor) = self
                    .discovery
                    .tasks
                    .get(task)
                    .and_then(|state| state.cursor.clone())
                {
                    let _ = cursor;
                    return self.reconcile_page(task);
                }
                self.reconcile_finished(task)
            }
        }
    }

    /// The scan's own end: restart it when the output changed under it.
    fn reconcile_finished(&mut self, task: &str) -> Vec<Effect> {
        let state = self.discovery.tasks.shift_remove(task);
        let Some(state) = state else {
            return Vec::new();
        };
        if task == OUTPUT_TASK {
            if state.scan_revision != self.discovery.output_revision {
                return self.reconcile_loaded(OUTPUT_TASK);
            }
            self.discovery.output_scan = false;
            return self.finish_output_recovery();
        }
        if self.lifetime.is_closed() {
            return Vec::new();
        }
        let mut note = Map::new();
        note.insert("event", Value::from("discovery-finished"));
        note.insert("threadId", Value::from(self.root.clone()));
        note.insert("task", Value::from(task));
        self.emit_note(&Value::Object(note))
    }

    /// A failed scan: recorded, then retried one task timer later (`:288`).
    pub(crate) fn reconcile_failed(&mut self, task: &str) -> Vec<Effect> {
        self.discovery.tasks.shift_remove(task);
        let mut effects = self.diagnostic("Codex discovery scan failed");
        if !self.lifetime.is_closed() && !self.timers.contains_key(task) {
            self.timers.insert(task.to_owned(), ());
            self.discovery.retries.insert(task.to_owned());
            effects.push(Effect::ArmTimer {
                key: task.to_owned(),
                ms: RECOVERY_MS,
            });
        }
        effects
    }
}

/// One `thread/queue/list` request.
fn queue_page(call: u64, thread: &str, cursor: Option<&str>) -> Vec<Effect> {
    let mut params = Map::new();
    params.insert("threadId", Value::from(thread));
    if let Some(cursor) = cursor {
        params.insert("cursor", Value::from(cursor));
    }
    vec![Effect::Request {
        call,
        method: "thread/queue/list".to_owned(),
        params: Value::Object(params),
        timeout_ms: Some(REQUEST_MS),
    }]
}
