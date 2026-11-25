// SPDX-License-Identifier: Apache-2.0
//! The session's other callbacks: the dropped, malformed and stderr lines, the
//! exit, `onNotification` and `onRequest` (`session.ts:354`-`:405`), the
//! correlation deadline and the session's own emit wrappers.

use ace_json::{JsString, Map, Value};
use ace_supervisor::jsonrpc::RpcId;
use ace_supervisor::peer::Direction;

use crate::session::frames::{Effect, FrameDir};
use crate::session::host::{DroppedLine, HostExit, RequestAnswer};
use crate::translate::helpers::{is_interactive_request, request_key};

use super::{
    CORRELATION_MS, Correlation, Pending, Session, correlation_key, text_of, turn_of, value_of,
};

impl Session {
    /// `dropped(line)`: `emit("note", { event: "output-line-dropped", ...line })`
    /// (`:337`-`:338`), with the parse's own `response` and the phase the
    /// framing layer reported.
    pub fn dropped(&mut self, line: &DroppedLine) -> Vec<Effect> {
        let note =
            crate::session::frames::dropped_note(line.bytes, line.phase.as_str(), &line.attributed);
        self.emit_note(&note)
    }

    /// `outputUncertain`: a dropped line may have hidden a control.
    pub fn output_uncertain(&mut self) -> Vec<Effect> {
        self.invalidate_output()
    }

    /// `malformed(line)`: the line as a received frame beside the session's
    /// own frames.
    pub fn malformed(&mut self, line: &str) -> Vec<Effect> {
        let mut value = Map::new();
        value.insert("malformed", Value::from(line));
        self.emit_dir(FrameDir::Recv, &Value::Object(value), "stdio", None)
            .unwrap_or_default()
    }

    /// `stderr(line)`: the lifetime's scrubbed tail, and the frame.
    pub fn stderr(&mut self, line: &str) -> Vec<Effect> {
        self.lifetime.stderr_line(&self.frames, line)
    }

    /// `failed(message)`: a received frame could not be admitted. The host's
    /// reason is reported as a diagnostic, then the transport fails, in that
    /// order (`session.ts:352`; the host refuses the frame before its request
    /// is dispatched).
    pub fn failed(&mut self, message: &str) -> Vec<Effect> {
        let mut effects = self.diagnostic(message);
        let busy = self.busy();
        effects.extend(self.lifetime.fail_transport(&self.frames, busy));
        effects
    }

    /// `exited(exit)`: the exit evidence, and the engine's own notice.
    pub fn exited(&mut self, exit: &HostExit) -> Vec<Effect> {
        self.lifetime.exited(&self.frames, exit)
    }

    /// `onNotification`: the queue refresh and the discovery reconcile a
    /// notification asks for (`:392`). `catalog.changed` is the extension
    /// catalog's (E3-codex.4).
    pub fn notification(&mut self, method: &str, params: Option<&Value>) -> Vec<Effect> {
        let params = params
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let thread = text_of(params.get("threadId"));
        let mut effects = Vec::new();
        if method == "turn/completed" && thread == self.root {
            effects.extend(self.reconcile_loaded(&format!("discovery:{}", turn_of(&params))));
        }
        if method == "thread/queue/changed" {
            effects.extend(self.refresh_queue(&thread));
        }
        effects
    }

    /// `onRequest`: an interactive request waits for its answer; anything else
    /// is `MethodNotFound` (`:401`).
    pub fn request(&mut self, id: &RpcId, method: &str, params: Option<&Value>) -> RequestAnswer {
        if !is_interactive_request(method) {
            return RequestAnswer::MethodNotFound(format!("Unsupported Codex request: {method}"));
        }
        let key = request_key(&value_of(id), &self.scope).as_str().to_owned();
        self.pending.insert(
            key,
            Pending {
                id: id.clone(),
                method: JsString::from(method),
                params: params.cloned(),
            },
        );
        RequestAnswer::Deferred
    }

    /// One call's reply, or its failure: whichever machine asked for it.
    pub fn settled(&mut self, call: u64, reply: Result<&Value, &str>) -> Vec<Effect> {
        if self
            .discovery
            .reads
            .values()
            .any(|read| read.awaits_snapshot(call))
        {
            return self.snapshot_settled(call, reply);
        }
        if let Some(effects) = self.read_terminal_page(call, reply) {
            return effects;
        }
        if let Some(effects) = self.queue_settled(call, reply) {
            return effects;
        }
        if let Some(effects) = self.reconcile_settled(call, reply) {
            return effects;
        }
        Vec::new()
    }

    /// `cleanup()`: nothing more will be sent (`:428`-`:443`).
    pub fn cleanup(&mut self) -> Vec<Effect> {
        let correlations: Vec<String> = self.correlations.keys().cloned().collect();
        self.correlations.clear();
        self.control_requests.clear();
        let timers: Vec<String> = self.timers.keys().cloned().collect();
        self.timers.clear();
        let mut effects: Vec<Effect> = correlations
            .into_iter()
            .map(|key| Effect::CancelTimer { key })
            .collect();
        effects.extend(timers.into_iter().map(|key| Effect::CancelTimer { key }));
        for pending in self.pending.values() {
            effects.push(Effect::AnswerError {
                id: pending.id.clone(),
                message: "Codex session ended".to_owned(),
            });
        }
        self.pending.clear();
        self.async_questions.clear();
        self.plans.clear();
        effects
    }

    /// A correlated request's timer fired (`expire`, `:97`): a local RPC
    /// rejection cannot resolve translation's held completion, so the owned
    /// peer is retired.
    pub(crate) fn correlation_timer(&mut self, key: &str, now: f64) -> Vec<Effect> {
        let Some(correlation) = self.correlations.get(key) else {
            return Vec::new();
        };
        if self.lifetime.is_closed() || !self.control_requests.contains_key(&correlation.id) {
            return Vec::new();
        }
        let remaining = correlation.deadline - now;
        if remaining > 0.0 {
            if let Some(entry) = self.correlations.get_mut(key) {
                entry.deadline = now + remaining;
            }
            return vec![Effect::ArmTimer {
                key: key.to_owned(),
                ms: remaining,
            }];
        }
        let thread = correlation.thread.clone();
        let mut note = Map::new();
        note.insert("event", Value::from("turn-correlation-timeout"));
        note.insert("threadId", Value::from(thread));
        let mut effects = self.emit_note(&Value::Object(note));
        let busy = self.busy();
        effects.extend(self.lifetime.fail_transport(&self.frames, busy));
        effects
    }

    /// `awaitCorrelation`: a turn/start answer waits 30 seconds for its turn.
    pub(crate) fn await_correlation(&mut self, id: &RpcId, thread: &str, now: f64) -> Vec<Effect> {
        let Some(key) = correlation_key(id) else {
            return Vec::new();
        };
        if self.correlations.contains_key(&key) {
            return Vec::new();
        }
        self.correlations.insert(
            key.clone(),
            Correlation {
                id: id.clone(),
                deadline: now + CORRELATION_MS,
                thread: thread.to_owned(),
            },
        );
        vec![Effect::ArmTimer {
            key,
            ms: CORRELATION_MS,
        }]
    }

    /// A new child thread: known, parented, and recovered before anything acts
    /// on it (`:283`-`:296`).
    pub(crate) fn discover_child(&mut self, child: &str, thread: &str) -> Vec<Effect> {
        self.known.insert(child.to_owned());
        self.parents.insert(child.to_owned(), thread.to_owned());
        if self.recovered.contains(child) {
            return Vec::new();
        }
        self.schedule_recovery(child)
    }

    /// One frame through the session's emitter, and the recovery a frame
    /// left out asks for.
    pub(crate) fn emit(
        &mut self,
        dir: Direction,
        data: &Value,
        channel: &'static str,
        optional: Option<&str>,
    ) -> Result<Vec<Effect>, crate::session::frames::Rejected> {
        let dir = match dir {
            Direction::Send => FrameDir::Send,
            Direction::Recv => FrameDir::Recv,
        };
        self.emit_dir(dir, data, channel, optional)
    }

    pub(crate) fn emit_dir(
        &mut self,
        dir: FrameDir,
        data: &Value,
        channel: &'static str,
        optional: Option<&str>,
    ) -> Result<Vec<Effect>, crate::session::frames::Rejected> {
        let emitted = self.frames.emit(dir, data, channel, optional)?;
        let mut effects: Vec<Effect> = emitted.frames.into_iter().map(Effect::from).collect();
        if emitted.recover_output {
            effects.extend(self.invalidate_output());
        }
        Ok(effects)
    }

    /// `emit("note", data)` on the stdio channel.
    pub(crate) fn emit_note(&mut self, data: &Value) -> Vec<Effect> {
        self.emit_dir(FrameDir::Note, data, "stdio", None)
            .unwrap_or_default()
    }
}
