// SPDX-License-Identifier: Apache-2.0
//! The child's streams and the facade's calls (`session.ts:256`-`:355`, `:609`, `:671`):
//! stdout and stderr bytes in, write acknowledgements, timers, and the terminal `finish`.

use super::{AcpEffect, AcpErrorWire};
use crate::translate::data::object;
use ace_adapter_api::frame::FrameDirection;
use ace_json::{Map, Value};
use ace_supervisor::lines::restore_borrowed;
use ace_supervisor::peer::{PeerError, Timeout};

impl super::AcpCore {
    /// Issue a JSON-RPC request through the underlying [`RpcPeer`].
    pub fn request(
        &mut self,
        method: &str,
        params: Option<&Value>,
        facade_id: u64,
        timeout: Timeout,
    ) -> Result<Vec<AcpEffect>, PeerError> {
        let peer_effects = self.peer.request(method, params, facade_id, timeout)?;
        let mut effects = Vec::new();
        self.apply_peer_effects(peer_effects, &mut effects);
        Ok(effects)
    }

    /// Issue a JSON-RPC notification through the underlying [`RpcPeer`].
    pub fn notify(
        &mut self,
        method: &str,
        params: Option<&Value>,
    ) -> Result<Vec<AcpEffect>, PeerError> {
        let peer_effects = self.peer.notify(method, params)?;
        let mut effects = Vec::new();
        self.apply_peer_effects(peer_effects, &mut effects);
        Ok(effects)
    }

    /// Feed raw bytes from the child's stdout.
    pub fn stdout_bytes(&mut self, chunk: &[u8]) -> Vec<AcpEffect> {
        let mut effects = Vec::new();
        match self.stdout_framer.push(chunk) {
            Ok(framed) => {
                if framed.count > 0 {
                    for raw_line in framed.text.split('\n') {
                        let line = restore_borrowed(raw_line);
                        let peer_effects = self.peer.line(&line);
                        self.apply_peer_effects(peer_effects, &mut effects);
                    }
                }
            }
            Err(message) => self.fail(&message, &mut effects),
        }
        effects
    }

    /// Feed raw bytes from the child's stderr.
    pub fn stderr_bytes(&mut self, chunk: &[u8]) -> Vec<AcpEffect> {
        let mut effects = Vec::new();
        match self.stderr_framer.push(chunk) {
            Ok(framed) => {
                if framed.count > 0 {
                    for raw_line in framed.text.split('\n') {
                        let line = restore_borrowed(raw_line);
                        self.emit_text_frame(FrameDirection::Stderr, "stdio", &line, &mut effects);
                    }
                }
            }
            Err(message) => self.fail(&message, &mut effects),
        }
        effects
    }

    /// Acknowledge the currently active stdin write (`OutputConsumer::stdin_written`).
    pub fn stdin_written(&mut self) -> Vec<AcpEffect> {
        let Some(ticket) = self.active_write_ticket.take() else {
            return Vec::new();
        };
        self.written(ticket)
    }

    /// Acknowledge a specific write ticket on [`RpcPeer`].
    pub fn written(&mut self, ticket: u64) -> Vec<AcpEffect> {
        if self.active_write_ticket == Some(ticket) {
            self.active_write_ticket = None;
        }
        // The line this ticket carried is on the pipe: a steer waiting on it was written.
        self.confirm_steer_write(ticket);
        let peer_effects = self.peer.written(ticket);
        let mut effects = Vec::new();
        self.apply_peer_effects(peer_effects, &mut effects);
        effects
    }

    /// A write acknowledgement for a steer's ticket marks its send written.
    fn confirm_steer_write(&mut self, ticket: u64) {
        let batches: Vec<u64> = self
            .steering
            .values()
            .filter(|flight| flight.ticket == Some(ticket))
            .map(|flight| flight.batch)
            .collect();
        for batch in batches {
            if let Some(state) = self.batches.get_mut(&batch) {
                state.wrote_any = true;
            }
        }
    }

    /// Stdin write failed (`OutputConsumer::stdin_error`).
    pub fn stdin_error(&mut self, message: &str) -> Vec<AcpEffect> {
        self.active_write_ticket = None;
        let mut effects = Vec::new();
        self.fail(message, &mut effects);
        effects
    }

    /// Stdout stream ended (`session.ts:334`–`:337`).
    pub fn stdout_closed(&mut self) -> Vec<AcpEffect> {
        let mut effects = Vec::new();
        let trailing = self.stdout_framer.finish();
        if trailing.count > 0 {
            for raw_line in trailing.text.split('\n') {
                let line = restore_borrowed(raw_line);
                let peer_effects = self.peer.line(&line);
                self.apply_peer_effects(peer_effects, &mut effects);
            }
        }
        if !self.closed && !self.process_exited {
            self.fail(
                "ACP transport stdout closed before process termination",
                &mut effects,
            );
        }
        effects
    }

    /// Mark that the child process leader has exited (before `close` barrier).
    ///
    /// The pipes may still drain, so frames keep being captured, but no work is
    /// accepted from here: a buffered reply must not resolve a call the exit
    /// already ended (`jsonrpc.ts:265`, `:270`–`:272`, `#end`).
    pub fn mark_exited(&mut self) -> Vec<AcpEffect> {
        self.process_exited = true;
        let peer_effects = self.peer.stop_requests("process exited");
        let mut effects = Vec::new();
        self.apply_peer_effects(peer_effects, &mut effects);
        effects
    }

    /// Handle a fired timer (either a [`Deadlines`] timer or an [`RpcPeer`] request timeout).
    pub fn timer(&mut self, key: &str) -> Vec<AcpEffect> {
        let mut effects = Vec::new();
        if let Some(logical) = self.deadlines.fire(key) {
            self.handle_deadline(&logical, &mut effects);
            return effects;
        }
        let peer_effects = self.peer.timer(key);
        self.apply_peer_effects(peer_effects, &mut effects);
        effects
    }

    /// No child will ever report (the spawn threw): fail every pending call, then
    /// publish `Drained` so each promise settles and the close barrier opens.
    pub fn abandon(&mut self) -> Vec<AcpEffect> {
        let mut effects = self.fail_session("ACP session abandoned before start");
        effects.push(AcpEffect::Drained);
        effects
    }

    /// Fail the session (`session.ts:338`–`:355`). Idempotent once closed.
    pub fn fail_session(&mut self, message: &str) -> Vec<AcpEffect> {
        let mut effects = Vec::new();
        self.fail(message, &mut effects);
        effects
    }

    /// Terminal barrier when the child's pipes have closed (`session.ts:256`–`:272`).
    pub fn finish(&mut self, exit_detail: Value, exit_summary: &str) -> Vec<AcpEffect> {
        let mut effects = Vec::new();
        // Flush any remaining partial lines before draining.
        let out_tail = self.stdout_framer.finish();
        if out_tail.count > 0 {
            for raw_line in out_tail.text.split('\n') {
                let line = restore_borrowed(raw_line);
                let peer_effects = self.peer.line(&line);
                self.apply_peer_effects(peer_effects, &mut effects);
            }
        }
        let err_tail = self.stderr_framer.finish();
        if err_tail.count > 0 {
            for raw_line in err_tail.text.split('\n') {
                let line = restore_borrowed(raw_line);
                self.emit_text_frame(FrameDirection::Stderr, "stdio", &line, &mut effects);
            }
        }

        self.process_exited = true;
        self.closed = true;
        self.clear_all_deadlines(&mut effects);
        self.cancel_questions(None, None, &mut effects);
        self.end_lease(&mut effects);
        self.reject_queue("ACP process exited", &mut effects);

        let peer_effects = self.peer.close("ACP process exited");
        self.apply_peer_effects(peer_effects, &mut effects);
        self.fail_open(
            AcpErrorWire::open_failed("ACP process exited"),
            &mut effects,
        );

        let mut detail = object(&exit_detail).clone();
        detail.insert("deliberate", Value::Bool(self.deliberate));
        let mut note = Map::with_capacity(2);
        note.insert("event", Value::from("process-exit"));
        note.insert("detail", Value::Object(detail));
        self.emit_note("recorder", Value::Object(note), &mut effects);

        let mut on_exit = Map::with_capacity(2);
        on_exit.insert("deliberate", Value::Bool(self.deliberate));
        on_exit.insert(
            "message",
            Value::from(format!("ACP process exited: {exit_summary}")),
        );
        effects.push(AcpEffect::Callback {
            name: "onExit",
            json: Value::Array(vec![Value::Object(on_exit)].into()).to_json(),
        });
        effects.push(AcpEffect::Drained);
        effects
    }

    /// `ctx.mcp?.end()` (`session.ts:73`, `:259`, `:912`): the lease ends once, and the
    /// facade owns it, so it hears it as a context callback.
    pub(crate) fn end_lease(&mut self, effects: &mut Vec<AcpEffect>) {
        if self.lease_ended {
            return;
        }
        self.lease_ended = true;
        effects.push(AcpEffect::Callback {
            name: "endMcp",
            json: "[]".to_owned(),
        });
    }

    pub(crate) fn fail(&mut self, message: &str, effects: &mut Vec<AcpEffect>) {
        if self.closed {
            return;
        }
        let clean_msg = self.redact_message(message);
        self.fault = Some(clean_msg.clone());
        self.closed = true;
        self.clear_all_deadlines(effects);

        let mut note = Map::with_capacity(2);
        note.insert("event", Value::from("transport-error"));
        note.insert("message", Value::from(clean_msg.as_str()));
        self.emit_note("transport", Value::Object(note), effects);

        self.cancel_questions(None, None, effects);
        self.end_lease(effects);
        self.reject_queue(&clean_msg, effects);
        let peer_effects = self.peer.stop_requests(&clean_msg);
        self.apply_peer_effects(peer_effects, effects);
        self.fail_open(AcpErrorWire::open_failed(clean_msg.clone()), effects);
        effects.push(AcpEffect::Fatal { message: clean_msg });
    }
}
