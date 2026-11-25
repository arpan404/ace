// SPDX-License-Identifier: Apache-2.0
//! The host's public entries: what a channel and the shell call.

use super::*;

impl Host {
    /// A host over an already spawned child: it sends `initialize` at once, as
    /// the constructor does.
    pub fn new(config: HostConfig) -> (Host, Vec<HostEffect>) {
        let gate = HostGate::new();
        let peer = RpcPeer::new(config.peer());
        let host = Host {
            inner: Mutex::new(Inner {
                config,
                gate: gate.clone(),
                router: HostRouter::default(),
                tenants: IndexMap::new(),
                holds: IndexMap::new(),
                init_frames: Vec::new(),
                peer,
                pid: None,
                leader: None,
                exit: None,
                retiring: false,
                retired: false,
                output_drained: true,
                initialize_id: None,
                initialize_call: 0,
                sender: None,
                own: HashMap::new(),
                calls: IndexMap::new(),
                active: IndexMap::new(),
                departed: Vec::new(),
                exiting: false,
                detaching: IndexMap::new(),
                next_own: 0,
                next_hold: 0,
                next_attempt: 0,
                ready: Handshake::Initializing,
                idle_armed: false,
                out: Vec::new(),
            }),
            gate,
        };
        let mut effects = Vec::new();
        {
            let mut inner = host.lock();
            let initialize = inner.config.initialize.clone();
            match inner.peer.request(
                "initialize",
                Some(&initialize),
                0,
                Timeout::After(INITIALIZE_MS),
            ) {
                Ok(peer) => inner.apply(peer),
                Err(error) => inner.ready = Handshake::Failed(error.message().to_owned()),
            }
            effects.extend(inner.take());
        }
        (host, effects)
    }

    /// The read gate the diverted child's chunks answer.
    pub fn gate(&self) -> &HostGate {
        &self.gate
    }

    /// The leader's pid, as the shell read it at spawn.
    pub fn set_pid(&self, pid: u32) {
        self.lock().pid = Some(pid);
    }

    pub fn pid(&self) -> Option<u32> {
        self.lock().pid
    }

    /// Accepts new channels: running, and not winding down.
    pub fn available(&self) -> bool {
        let inner = self.lock();
        inner.leader.is_none() && inner.exit.is_none() && !inner.retiring
    }

    /// The process leader already exited; final output may still be draining.
    pub fn gone(&self) -> bool {
        let inner = self.lock();
        inner.leader.is_some() || inner.exit.is_some()
    }

    pub fn dedicated(&self) -> bool {
        self.lock().config.dedicated
    }

    /// How many channels this process serves.
    pub fn tenant_count(&self) -> usize {
        self.lock().tenants.len()
    }

    /// No other channel shares this process.
    pub fn alone(&self, tenant: u64) -> bool {
        let inner = self.lock();
        inner.tenants.len() <= 1 && inner.tenants.contains_key(&tenant)
    }

    /// The thread provably belongs to another channel on this process.
    pub fn foreign(&self, tenant: u64, thread: &JsString) -> bool {
        let inner = self.lock();
        match inner.router.owner(thread) {
            Some(owner) => *owner != tenant,
            None => inner.router.released(thread),
        }
    }

    /// Register a channel before initialization completes, so a dedicated
    /// channel sees every frame live (`attach`, `:302`).
    pub fn attach(
        &self,
        tenant: u64,
        handlers: Arc<dyn ChannelHandlers>,
    ) -> Result<Vec<HostEffect>, HostError> {
        let mut inner = self.lock();
        // A leader that has died takes no new channel, even while its pipes
        // still drain (`#attach`: a process that exited never opens one).
        if inner.leader.is_some() || inner.exit.is_some() || inner.retiring {
            return Err(HostError::Unavailable);
        }
        if inner.config.dedicated && !inner.tenants.is_empty() {
            return Err(HostError::DedicatedInUse);
        }
        inner.cancel_idle();
        inner.tenants.insert(
            tenant,
            Tenant {
                handlers,
                closed: None,
                muted: false,
                exited: false,
            },
        );
        // The handshake's frames reached the process before this channel was
        // registered: replay them so a dedicated channel still sees them.
        let init: Vec<(Direction, Value)> = inner.init_frames.clone();
        for (dir, data) in init {
            inner.deliver(tenant, dir, &data, None);
        }
        match inner.ready.clone() {
            Handshake::Open => inner.out.push(HostEffect::Opened { tenant }),
            Handshake::Failed(message) => inner.fail_tenant(tenant, &message),
            Handshake::Initializing => {}
        }
        Ok(inner.take())
    }

    /// A channel's request, written through the shared peer (`send`, `:331`).
    pub fn request(
        &self,
        tenant: u64,
        method: &str,
        params: Option<&Value>,
        id: u64,
        timeout: Timeout,
    ) -> Result<Vec<HostEffect>, HostError> {
        let mut inner = self.lock();
        // A channel that left, or is leaving, issues nothing (`host.ts:153`).
        let closed = match inner.tenants.get(&tenant) {
            _ if inner.detaching.contains_key(&tenant) => Some("Codex channel closed".to_owned()),
            Some(entry) => entry.closed.clone(),
            None => Some("Codex channel closed".to_owned()),
        };
        if let Some(closed) = closed {
            return Err(HostError::Refused(closed));
        }
        inner.sender = Some(tenant);
        let requested = inner.peer.request(method, params, id, timeout);
        match requested {
            // The send frame is attributed while the sender is still known.
            Ok(peer) => {
                inner.calls.insert(id, tenant);
                inner.apply(peer);
            }
            Err(error) => {
                inner.sender = None;
                return Err(HostError::Refused(error.message().to_owned()));
            }
        }
        inner.sender = None;
        Ok(inner.take())
    }

    /// A session's answer to a server request (`answer`).
    pub fn answer(&self, id: &RpcId, result: &Value) -> Vec<HostEffect> {
        let mut inner = self.lock();
        let peer = inner.peer.answer(id, result);
        inner.apply(peer);
        inner.take()
    }

    /// A session's refusal of a server request.
    pub fn answer_error(&self, id: &RpcId, code: f64, message: &str) -> Vec<HostEffect> {
        let mut inner = self.lock();
        let peer = inner.peer.answer_error(id, code, message);
        inner.apply(peer);
        inner.take()
    }

    /// One framed stdout line (`#received`).
    pub fn line(&self, line: &str) -> Vec<HostEffect> {
        let mut inner = self.lock();
        let peer = inner.peer.line(line);
        inner.apply(peer);
        inner.take()
    }

    /// One stderr line: diagnostics, to every channel.
    pub fn stderr_line(&self, line: &str) {
        let inner = self.lock();
        for entry in inner.tenants.values() {
            entry.handlers.stderr(line);
        }
    }

    /// The write callback ran: release its bytes and hand out the next line.
    pub fn written(&self, ticket: u64) -> Vec<HostEffect> {
        let mut inner = self.lock();
        let peer = inner.peer.written(ticket);
        inner.apply(peer);
        inner.take()
    }

    /// An armed deadline fired.
    pub fn timer(&self, key: &str) -> Vec<HostEffect> {
        let mut inner = self.lock();
        if key == IDLE_TIMER {
            inner.idle_armed = false;
            if inner.tenants.is_empty() {
                inner.retire(Retirement::Idle, false);
            }
            return inner.take();
        }
        let peer = inner.peer.timer(key);
        inner.apply(peer);
        inner.take()
    }

    /// A line the framing layer dropped, attributed by the adapter.
    pub fn dropped(&self, line: &DroppedLine) -> Vec<HostEffect> {
        let mut inner = self.lock();
        inner.dropped(line);
        inner.take()
    }

    /// The leader exited (`exit`, `:268`): the status is recorded and every
    /// routed call still pending settles exactly once, but the channels stay
    /// until the pipes are done, so the frames after the leader reach them.
    pub fn exit(&self, exit: RawExit) -> Vec<HostEffect> {
        let mut inner = self.lock();
        if inner.leader.is_some() {
            return inner.take();
        }
        inner.exiting = true;
        inner.gate.drain();
        let stopped = inner.peer.stop_requests("process exited");
        inner.apply(stopped);
        let exit = HostExit::from_raw(exit, inner.pid, inner.output_drained);
        inner.leader = Some(exit);
        inner.lead_retired();
        inner.take()
    }

    /// The pipes are done (`close`, `:239`): settlements, then the held
    /// requests, then the exit to every channel.
    pub fn closed(&self, exit: RawExit) -> Vec<HostEffect> {
        let mut inner = self.lock();
        inner.exiting = true;
        inner.gate.drain();
        let closed = inner.peer.close("process exited");
        inner.apply(closed);
        let leader = inner
            .leader
            .clone()
            .unwrap_or_else(|| HostExit::from_raw(exit, inner.pid, true));
        let exit = HostExit {
            output_drained: inner.output_drained,
            ..leader
        };
        if inner.exit.is_none() {
            inner.exited(exit);
        }
        inner.take()
    }

    /// The final drain was cut short, so the exit reports `outputDrained: false`.
    pub fn output_cut(&self) {
        self.lock().output_drained = false;
    }

    /// Stop routing to this channel (`detach`, `:346`). It issues nothing new,
    /// interrupts the turns it still runs, and keeps receiving its threads'
    /// frames until its unsubscribes land.
    pub fn detach(&self, tenant: u64, retirement: Retirement, reason: &str) -> Vec<HostEffect> {
        let mut inner = self.lock();
        if inner.detaching.contains_key(&tenant)
            || inner
                .tenants
                .get(&tenant)
                .is_none_or(|entry| entry.closed.is_some())
        {
            return inner.take();
        }
        if inner.config.dedicated || inner.exiting {
            // A dedicated process belongs to this channel; its exit is the
            // channel's exit, published when the pipes are done.
            inner.abort_calls(tenant, reason);
            inner.retire(retirement, true);
            return inner.take();
        }
        // A running turn cannot outlive its channel: the interrupt goes out
        // while the channel still owns its threads, so its completion lands in
        // the channel's queue before the exit. The threads are released once
        // every interrupt is answered, as the session's close awaits them.
        inner.next_attempt += 1;
        let attempt = inner.next_attempt;
        inner.detaching.insert(
            tenant,
            Detaching {
                remaining: 0,
                retirement,
                reason: reason.to_owned(),
                attempt,
                phase: Leaving::Interrupts,
            },
        );
        // An interrupt the peer will not take cannot stop the turn: nothing
        // detaches, and the close reports it. A full write queue surfaces the
        // same way, as the enqueue's own settlement.
        if let Err(message) = inner.interrupt_turns(tenant, attempt) {
            inner.detaching.shift_remove(&tenant);
            inner.out.push(HostEffect::DetachFailed {
                tenant,
                reason: retirement,
                message,
            });
            return inner.take();
        }
        if inner
            .detaching
            .get(&tenant)
            .is_some_and(|state| state.remaining == 0)
        {
            inner.unsubscribe_threads(tenant);
        }
        inner.take()
    }

    /// Stop the whole process (`retire`, `:379`); every channel on it exits.
    pub fn retire(&self, reason: Retirement) -> Vec<HostEffect> {
        let mut inner = self.lock();
        if inner.retiring && inner.exit.is_none() {
            // The stop in flight is the shell's: its failure reaches this
            // caller too.
            inner.out.push(HostEffect::Retiring { reason });
            return inner.take();
        }
        inner.retire(reason, true);
        inner.take()
    }

    /// The shell's stop did not confirm: a host that outlived it takes
    /// backpressure again. A leader already dead started draining for its exit,
    /// and a late failure cannot undo that.
    pub fn stop_failed(&self) {
        let inner = self.lock();
        if inner.exiting {
            return;
        }
        inner.gate.undrain();
    }

    /// A tenant's `outputFlow` pause (`setPaused`).
    pub fn set_paused(&self, tenant: u64, paused: bool) {
        self.gate.set_paused(tenant, paused);
    }

    pub fn paused(&self) -> bool {
        self.gate.paused()
    }

    /// A chunk arrived: answer it while the gate decides.
    pub fn answer_delivery(&self, delivered: Delivered) {
        self.gate.answer(delivered);
    }

    pub(super) fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|error| error.into_inner())
    }
}
