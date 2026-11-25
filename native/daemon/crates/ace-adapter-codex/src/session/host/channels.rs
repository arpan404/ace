// SPDX-License-Identifier: Apache-2.0
//! Tenants and the frames they receive: routing, delivery, notifications and server requests.

use super::*;

impl Inner {
    /// Keep each thread's running turn, so a close can interrupt it.
    pub(super) fn track_active(&mut self, message: &Value) {
        let Some(method) = message.get("method").and_then(Value::as_str) else {
            return;
        };
        if method != "turn/started" && method != "turn/completed" {
            return;
        }
        let Some(thread) = crate::session::routing::subject_thread(message) else {
            return;
        };
        let Some(turn) = message
            .get("params")
            .and_then(|params| params.get("turn"))
            .and_then(|turn| turn.get("id"))
            .and_then(Value::as_str)
        else {
            return;
        };
        let turn = JsString::from(turn);
        if method == "turn/started" {
            self.active.insert(thread, turn);
        } else if self.active.get(&thread) == Some(&turn) {
            self.active.shift_remove(&thread);
        }
    }

    /// An outgoing frame: a tenant's own, its answer, or an init frame to
    /// everyone (`#sent`, `:437`).
    pub(super) fn sent(&mut self, data: &Value) -> Option<String> {
        let sender = self.sender;
        let tenant = self.router.sent(data, sender.as_ref());
        if let Some(tenant) = tenant {
            let mut failed = None;
            if !self.deliver(tenant, Direction::Send, data, Some(&mut failed)) {
                return failed.or_else(|| Some("Codex send frame was not admitted".to_owned()));
            }
            return None;
        }
        let method = data.get("method").and_then(Value::as_str)?;
        if method == "initialize" {
            self.initialize_id = id_of(data);
        }
        if method == "initialize" || method == "initialized" {
            self.broadcast_init(Direction::Send, data);
        }
        None
    }

    /// Init frames are replayed to every tenant that attaches (`:449`).
    pub(super) fn broadcast_init(&mut self, dir: Direction, data: &Value) {
        self.init_frames.push((dir, data.clone()));
        for tenant in self.tenant_ids() {
            self.deliver(tenant, dir, data, None);
        }
    }

    /// Where a received message goes, with the dedicated and lone-channel
    /// overrides (`#route`, `:454`).
    pub(super) fn route(&mut self, data: &Value) -> Route<u64> {
        let route = self.router.received(data);
        let only = self.tenants.keys().next().copied();
        let alone = self.tenants.len() == 1;
        if self.config.dedicated && route != Route::Host {
            return match only {
                Some(tenant) => Route::Tenant {
                    tenant,
                    claimed: Vec::new(),
                },
                None => Route::Drop,
            };
        }
        if matches!(route, Route::Hold { .. })
            && let Some(tenant) = only
            && alone
        {
            return Route::Tenant {
                tenant,
                claimed: Vec::new(),
            };
        }
        route
    }

    /// One received frame (`#received`, `:495`).
    pub(super) fn received(&mut self, data: Value) -> Pending {
        let route = self.route(&data);
        let mut pending = Pending {
            route: route.clone(),
            data: None,
            held: None,
            failed: HashSet::new(),
        };
        match route {
            Route::Host => {
                if id_of(&data) == self.initialize_id {
                    self.broadcast_init(Direction::Recv, &data);
                }
                pending.data = Some(data);
            }
            Route::Drop => {}
            Route::Hold { thread } => {
                pending.held = self.hold(thread, &data);
                pending.data = Some(data);
            }
            Route::All => {
                for tenant in self.tenant_ids() {
                    if !self.deliver(tenant, Direction::Recv, &data, None) {
                        pending.failed.insert(tenant);
                    }
                }
            }
            Route::Tenant { tenant, claimed } => {
                for thread in claimed {
                    self.claimed(&thread, tenant);
                }
                if !self.deliver(tenant, Direction::Recv, &data, None) {
                    pending.failed.insert(tenant);
                }
                self.track_active(&data);
                if self.router.opening() == 0 {
                    self.settle_waiting();
                }
            }
        }
        pending
    }

    /// A notification follows its frame; a held one is dispatched on release
    /// (`#notification`, `:521`).
    pub(super) fn notification(
        &mut self,
        pending: Option<Pending>,
        method: &JsString,
        params: Option<&Value>,
    ) {
        let Some(pending) = pending else {
            return;
        };
        if let Some((thread, index)) = &pending.held {
            if let Some(hold) = self.holds.get_mut(thread)
                && let Some(item) = hold.items.get_mut(*index)
            {
                let data = item.data().clone();
                *item = Held::Notification {
                    data,
                    method: method.clone(),
                    params: params.cloned(),
                };
            }
            return;
        }
        match pending.route {
            Route::Tenant { tenant, .. } => {
                if !pending.failed.contains(&tenant)
                    && let Some(entry) = self.tenants.get(&tenant)
                {
                    entry.handlers.notification(method, params);
                }
            }
            Route::All => {
                for tenant in self.tenant_ids() {
                    if pending.failed.contains(&tenant) {
                        continue;
                    }
                    if let Some(entry) = self.tenants.get(&tenant) {
                        entry.handlers.notification(method, params);
                    }
                }
            }
            _ => {}
        }
    }

    /// A server request follows its frame; it is answered once, by its owner
    /// (`#request`, `:537`).
    pub(super) fn server_request(
        &mut self,
        pending: Option<Pending>,
        id: RpcId,
        method: &JsString,
        params: Option<&Value>,
    ) {
        let Some(pending) = pending else {
            self.refuse(&id, "unhandled request");
            return;
        };
        if let Some((thread, index)) = &pending.held {
            if let Some(hold) = self.holds.get_mut(thread)
                && let Some(item) = hold.items.get_mut(*index)
            {
                let data = item.data().clone();
                *item = Held::Request {
                    data,
                    id,
                    method: method.clone(),
                    params: params.cloned(),
                };
            }
            return;
        }
        match &pending.route {
            Route::Tenant { tenant, .. } if !pending.failed.contains(tenant) => {
                self.serve(&id, *tenant, method, params);
            }
            Route::Host if self.tenants.len() == 1 => {
                let tenant = self.tenants.keys().next().copied().unwrap_or_default();
                // A request naming no thread or turn can only be answered when
                // one session could own it: it sees the frame its discovery
                // needs, then answers it.
                if let Some(data) = &pending.data {
                    self.deliver(tenant, Direction::Recv, data, None);
                }
                self.serve(&id, tenant, method, params);
            }
            _ => self.refuse(&id, &format!("Unsupported Codex request: {method}")),
        }
    }

    /// Answer a request nobody can own, as `MethodNotFound`.
    pub(super) fn refuse(&mut self, id: &RpcId, message: &str) {
        let peer = self.peer.answer_error(id, METHOD_NOT_FOUND, message);
        self.apply(peer);
    }

    /// Hand a server request to one tenant, then answer it.
    pub(super) fn serve(
        &mut self,
        id: &RpcId,
        tenant: u64,
        method: &JsString,
        params: Option<&Value>,
    ) {
        self.router.serve(id.clone(), tenant);
        let Some(entry) = self.tenants.get(&tenant) else {
            self.refuse(id, "Codex request has no ace owner");
            return;
        };
        let answer = entry.handlers.request(id, method, params);
        match answer {
            RequestAnswer::Answered(value) => {
                let peer = self.peer.answer(id, &value);
                self.apply(peer);
            }
            RequestAnswer::MethodNotFound(message) => {
                let peer = self.peer.answer_error(id, METHOD_NOT_FOUND, &message);
                self.apply(peer);
            }
            RequestAnswer::Failed(message) => {
                let peer = self.peer.answer_error(id, INTERNAL_ERROR, &message);
                self.apply(peer);
            }
            RequestAnswer::Deferred => {}
        }
    }

    /// Deliver one frame to one tenant (`Tenant.deliver`, `:169`).
    pub(super) fn deliver(
        &mut self,
        tenant: u64,
        dir: Direction,
        data: &Value,
        failed: Option<&mut Option<String>>,
    ) -> bool {
        let Some(entry) = self.tenants.get_mut(&tenant) else {
            return false;
        };
        if entry.closed.is_some() || entry.muted {
            return false;
        }
        let handlers = Arc::clone(&entry.handlers);
        match handlers.frame(dir, data) {
            Admission::Taken => true,
            Admission::Failed(message) => {
                entry.muted = true;
                handlers.failed(&message);
                if let Some(failed) = failed {
                    *failed = Some(message);
                }
                false
            }
        }
    }

    pub(super) fn tenant_ids(&self) -> Vec<u64> {
        self.tenants.keys().copied().collect()
    }

    pub(super) fn report_all(&self, message: &str) {
        for entry in self.tenants.values() {
            entry.handlers.error(message);
        }
    }

    /// A supervisor drop: answer the request it lost, then tell the channel
    /// that owns the thread (`#dropped`, `:466`).
    pub(super) fn dropped(&mut self, line: &DroppedLine) {
        let mut rejected = false;
        if line.phase != DroppedPhase::End
            && let Some(id) = &line.response
        {
            let message = dropped_message(line.bytes);
            let peer = self
                .peer
                .reject_request(id, PeerError::new(message.clone()));
            if !peer.is_empty() {
                rejected = true;
                self.apply(peer);
                // Follow normal reply routing to clear request ownership and
                // session correlation too.
                let reply = ace_json::json!({
                    "id": id_to_value(id),
                    "error": {"code": -32099.0, "message": message},
                });
                let _ = self.received(reply);
                if self.router.opening() == 0 {
                    self.settle_waiting();
                }
            }
        }
        let affected = match &line.thread {
            Some(thread) => match self.router.owner(thread).copied() {
                Some(owner) => vec![owner],
                None => self.tenant_ids(),
            },
            None => self.tenant_ids(),
        };
        for tenant in affected {
            let Some(entry) = self.tenants.get(&tenant) else {
                continue;
            };
            if entry.closed.is_some() {
                continue;
            }
            if line.phase != DroppedPhase::End && !rejected {
                entry.handlers.output_uncertain();
            }
            entry.handlers.dropped(line);
        }
    }
}
