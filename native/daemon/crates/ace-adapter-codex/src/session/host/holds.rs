// SPDX-License-Identifier: Apache-2.0
//! Frames for a thread no channel owns yet (`host.ts:607`–`:690`). Codex
//! names a thread before ace knows whose it is, so the frames wait while the
//! host walks Codex's own thread records for an owned ancestor; then they go
//! to that owner, to every channel when the walk could not prove one, or
//! nowhere when the chain reaches no ace thread. A held request is answered
//! either way, so nothing waits forever.

use ace_json::{JsString, Value};
use ace_supervisor::jsonrpc::RpcId;
use ace_supervisor::peer::METHOD_NOT_FOUND;

use super::*;

/// One held frame, before the dispatch effect that follows it names it.
#[derive(Debug, Clone)]
pub(super) enum Held {
    Frame {
        data: Value,
    },
    Notification {
        data: Value,
        method: JsString,
        params: Option<Value>,
    },
    Request {
        data: Value,
        id: RpcId,
        method: JsString,
        params: Option<Value>,
    },
}

impl Held {
    fn frame(data: &Value) -> Held {
        Held::Frame { data: data.clone() }
    }

    pub(super) fn data(&self) -> &Value {
        match self {
            Held::Frame { data } | Held::Notification { data, .. } | Held::Request { data, .. } => {
                data
            }
        }
    }
}

/// One unowned thread's held frames (`Hold`, `:118`).
#[derive(Debug)]
pub(super) struct Hold {
    pub(super) id: u64,
    pub(super) items: Vec<Held>,
    pub(super) resolving: bool,
    /// Every thread walked so far, starting with the held one (`chain`).
    pub(super) walked: Vec<JsString>,
    /// Where the next read starts (`#resolve`'s cursor).
    pub(super) cursor: JsString,
    pub(super) depth: usize,
    /// The finished chain, kept for a later claim; `None` while walking.
    pub(super) chain: Option<Vec<JsString>>,
}

/// Where a held thread's frames go (`#flush`'s target).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Flush {
    None,
    All,
    One(u64),
}

impl Inner {
    /// A thread just became owned: release what waited for it, then anything
    /// below it (`#claimed`, `:573`).
    pub(super) fn claimed(&mut self, thread: &JsString, tenant: u64) {
        if let Some(hold) = self.holds.shift_remove(thread) {
            self.flush(hold, Flush::One(tenant));
        }
        let waiting: Vec<JsString> = self
            .holds
            .iter()
            .filter(|(_, entry)| {
                entry
                    .chain
                    .as_ref()
                    .is_some_and(|chain| chain.contains(thread))
            })
            .map(|(waiting, _)| waiting.clone())
            .collect();
        for waiting in waiting {
            let Some(entry) = self.holds.shift_remove(&waiting) else {
                continue;
            };
            for member in entry.chain.iter().flatten() {
                self.router.claim(member, &tenant);
            }
            self.flush(entry, Flush::One(tenant));
        }
    }

    /// A held thread's frames go to their owner, to everyone, or nowhere.
    pub(super) fn flush(&mut self, hold: Hold, target: Flush) {
        for item in hold.items {
            match target {
                Flush::None => self.dispatch_none(&item),
                Flush::All => match &item {
                    // No owner could be proven. Answering for every channel
                    // would duplicate a prompt.
                    Held::Request { id, .. } => {
                        let peer = self.peer.answer_error(
                            id,
                            METHOD_NOT_FOUND,
                            "Codex request has no ace owner",
                        );
                        self.apply(peer);
                    }
                    Held::Notification {
                        data,
                        method,
                        params,
                    } => {
                        for tenant in self.tenant_ids() {
                            if self.deliver(tenant, Direction::Recv, data, None)
                                && let Some(entry) = self.tenants.get(&tenant)
                            {
                                entry.handlers.notification(method, params.as_ref());
                            }
                        }
                    }
                    Held::Frame { .. } => {}
                },
                Flush::One(tenant) => {
                    let delivered = self.deliver(tenant, Direction::Recv, item.data(), None);
                    if delivered {
                        self.dispatch_one(tenant, &item);
                    } else {
                        self.dispatch_none(&item);
                    }
                }
            }
        }
    }

    pub(super) fn dispatch_one(&mut self, tenant: u64, item: &Held) {
        match item {
            Held::Notification { method, params, .. } => {
                if let Some(entry) = self.tenants.get(&tenant) {
                    entry.handlers.notification(method, params.as_ref());
                }
            }
            Held::Request {
                id, method, params, ..
            } => self.serve(id, tenant, method, params.as_ref()),
            Held::Frame { .. } => {}
        }
    }

    pub(super) fn dispatch_none(&mut self, item: &Held) {
        if let Held::Request { id, .. } = item {
            let peer =
                self.peer
                    .answer_error(id, METHOD_NOT_FOUND, "Codex request has no ace owner");
            self.apply(peer);
        }
    }

    /// Hold an unowned thread's frame (`#hold`, `:607`).
    pub(super) fn hold(&mut self, thread: JsString, data: &Value) -> Option<(JsString, usize)> {
        if !self.holds.contains_key(&thread) {
            if self.holds.len() >= HOLD_THREADS {
                // Bounded: the oldest unresolved thread falls back to every
                // channel's own discovery.
                let oldest = self.holds.keys().next().cloned();
                if let Some(oldest) = oldest
                    && let Some(entry) = self.holds.shift_remove(&oldest)
                {
                    self.flush(entry, Flush::All);
                }
            }
            self.next_hold += 1;
            self.holds.insert(
                thread.clone(),
                Hold {
                    id: self.next_hold,
                    items: Vec::new(),
                    resolving: false,
                    walked: vec![thread.clone()],
                    cursor: thread.clone(),
                    depth: 0,
                    chain: None,
                },
            );
        }
        let hold = self.holds.get_mut(&thread)?;
        hold.items.push(Held::frame(data));
        let index = hold.items.len() - 1;
        if hold.items.len() > HOLD_FRAMES {
            if let Some(entry) = self.holds.shift_remove(&thread) {
                self.flush(entry, Flush::All);
            }
            return None;
        }
        let start = !hold.resolving && hold.chain.is_none();
        if start {
            hold.resolving = true;
            self.resolve_loop(&thread);
        }
        Some((thread, index))
    }

    /// One step of `#resolve`'s walk: the owned ancestor, the next read, or
    /// the end of the chain.
    pub(super) fn resolve_loop(&mut self, thread: &JsString) {
        if self.exiting {
            return;
        }
        let Some(hold) = self.holds.get(thread) else {
            return;
        };
        let hold_id = hold.id;
        if hold.depth >= ANCESTRY_DEPTH {
            self.resolve_after(thread, hold_id, false);
            return;
        }
        let cursor = hold.cursor.clone();
        if let Some(owner) = self.router.owner(&cursor).copied() {
            self.finish_owned(thread, hold_id, owner);
            return;
        }
        let Ok((id, peer)) = self.enqueue_own("thread/read", &[("threadId", &cursor)], READ_MS)
        else {
            self.resolve_after(thread, hold_id, true);
            return;
        };
        self.own.insert(
            id,
            OwnPurpose::Read {
                thread: thread.clone(),
                hold: hold_id,
            },
        );
        // A queue that refused the line settles here, at once.
        self.apply(peer);
        if let Some(hold) = self.holds.get_mut(thread)
            && hold.id == hold_id
            && hold.resolving
        {
            hold.depth += 1;
        }
    }

    /// A read answered: walk on, or end the chain (`#resolve`'s loop). The
    /// answer belongs to the hold that asked: a hold evicted and recreated for
    /// the same thread never takes a late reply.
    pub(super) fn read_settled(
        &mut self,
        thread: &JsString,
        hold_id: u64,
        result: Result<Value, PeerError>,
    ) {
        if self.exiting {
            return;
        }
        let Some(hold) = self.holds.get(thread) else {
            return;
        };
        if hold.id != hold_id {
            return;
        }
        let Ok(result) = result else {
            self.resolve_after(thread, hold_id, true);
            return;
        };
        let parent = result.get("thread").and_then(parent_of);
        let Some(parent) = parent else {
            self.resolve_after(thread, hold_id, false);
            return;
        };
        let Some(hold) = self.holds.get_mut(thread) else {
            return;
        };
        if hold.id != hold_id || hold.walked.contains(&parent) {
            self.resolve_after(thread, hold_id, false);
            return;
        }
        hold.walked.push(parent.clone());
        hold.cursor = parent;
        self.resolve_loop(thread);
    }

    /// The walk's tail: an owner among the chain, else the chain waits for a
    /// claim (`:661`–`:679`).
    pub(super) fn resolve_after(&mut self, thread: &JsString, hold_id: u64, unreadable: bool) {
        if self.exiting {
            return;
        }
        let Some(hold) = self.holds.get_mut(thread) else {
            return;
        };
        if hold.id != hold_id {
            return;
        }
        hold.resolving = false;
        let walked = hold.walked.clone();
        let owner = walked
            .iter()
            .find_map(|member| self.router.owner(member).copied());
        if let Some(owner) = owner {
            self.finish_owned(thread, hold_id, owner);
            return;
        }
        if unreadable {
            // Without ancestry, every channel checks for itself, as a
            // dedicated process would.
            if let Some(entry) = self.holds.shift_remove(thread) {
                self.flush(entry, Flush::All);
            }
            return;
        }
        if let Some(hold) = self.holds.get_mut(thread) {
            hold.chain = Some(walked);
        }
        // A resumed root may still be claimed by an open in flight; decide
        // once none remain.
        if self.router.opening() == 0 {
            self.settle_waiting();
        }
    }

    pub(super) fn finish_owned(&mut self, thread: &JsString, hold_id: u64, owner: u64) {
        let Some(hold) = self.holds.get(thread) else {
            return;
        };
        if hold.id != hold_id {
            return;
        }
        let walked = hold.walked.clone();
        let Some(entry) = self.holds.shift_remove(thread) else {
            return;
        };
        for member in &walked {
            self.router.claim(member, &owner);
        }
        self.flush(entry, Flush::One(owner));
        for member in &walked {
            self.claimed(member, owner);
        }
    }

    /// No chain reached an ace thread: the held frames are dropped and their
    /// waiting requests answered (`#settleWaiting`, `:682`).
    pub(super) fn settle_waiting(&mut self) {
        let ready: Vec<JsString> = self
            .holds
            .iter()
            .filter(|(_, hold)| hold.chain.is_some() && !hold.resolving)
            .map(|(thread, _)| thread.clone())
            .collect();
        for thread in ready {
            if let Some(entry) = self.holds.shift_remove(&thread) {
                self.flush(entry, Flush::None);
            }
        }
    }
}
