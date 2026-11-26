// SPDX-License-Identifier: Apache-2.0
//! The session's end (`session.ts:156`-`:181`): the pipes' close asks the caller for the exit, the
//! exit publishes the host-exit note and the engine's callback, and a stdin failure stops the
//! host as a connection failure. The stray line's note answers the host's hold here too.

use ace_adapter_api::bridge::queue::SessionEvent;
use ace_adapter_api::frame::FrameDirection;
use ace_json::Value;

use super::super::frames;
use super::super::host::{HostEffect, PORT_CONNECTION};
use super::{CoreEffect, CursorSessionCore, PORT_HOST_OUTPUT, PORT_STOP_CHILD, listener_event};

impl CursorSessionCore {
    /// The pipes are closed: the host's tails drain. The caller answers the exit once its own
    /// wait on the child resolves (`session.ts:156` waits on `process.exited`).
    pub fn pipes_closed(&mut self) -> Vec<CoreEffect> {
        let mut effects = Vec::new();
        for effect in self.host.finish() {
            // The host's own `Drained` is not the session's: the session's comes after its
            // host-exit frame, once the caller has answered the exit.
            if matches!(effect, HostEffect::Drained) {
                continue;
            }
            self.apply_host(effect, &mut effects);
        }
        effects
    }

    /// `process.exited` resolved: the host-exit note, the engine's exit and the drain
    /// (`session.ts:156`-`:181`). `detail` is the caller's `failureMessage`, `stop_cause` its
    /// `stopCause`.
    pub fn exit(
        &mut self,
        code: Option<i64>,
        signal: Option<&str>,
        reason: &str,
        detail: Option<&str>,
        stop_cause: Option<&str>,
    ) -> Vec<CoreEffect> {
        let mut effects = Vec::new();
        self.state.exited = true;
        let body = frames::host_exit_body(self.state.deliberate, code, signal, reason, detail);
        // The body is the caller's bounded prose, so a bound failure here is not reachable; the
        // exit's callback and drain must still cross even if it were.
        let _ = self.frame(
            FrameDirection::Note,
            frames::KIND_HOST_EXIT,
            &body,
            &mut effects,
        );
        effects.push(CoreEffect::Event(SessionEvent::Callback {
            name: "onExit",
            json: frames::exit_args(self.state.deliberate, stop_cause),
        }));
        effects.push(CoreEffect::Event(SessionEvent::Drained));
        effects
    }

    /// The caller answered a port. `"host-output"` releases the host's hold with the redacted
    /// text; `"stop"` is the child's stop. The exit needs no port: the caller owns the child.
    pub fn note(&mut self, name: &str, text: Option<&str>) -> Vec<CoreEffect> {
        match name {
            PORT_HOST_OUTPUT => {
                let mut effects = Vec::new();
                if let Some(text) = text {
                    let mut body = ace_json::Map::with_capacity(1);
                    body.insert("text", Value::from(text));
                    let body = Value::Object(body);
                    // A diagnostic over the note's bound is dropped, but the hold is released
                    // either way: a stray line must never stall the host's reads.
                    let _ = self.frame(
                        FrameDirection::Note,
                        frames::KIND_HOST_OUTPUT,
                        &body,
                        &mut effects,
                    );
                }
                let released = self.host.note("host-output");
                for effect in released {
                    self.apply_host(effect, &mut effects);
                }
                effects
            }
            PORT_STOP_CHILD => crate::session::commands::close_stopped(self),
            _ => Vec::new(),
        }
    }

    /// A stdin write failed (`proc.stdin.on("error")`): the host is stopped as a connection
    /// failure, as `host.ts:152`-`:154` fails it.
    pub fn stdin_failed(&mut self, message: &str) -> Vec<CoreEffect> {
        let effects = self.host.close(message);
        let mut effects = self.map_host(effects);
        effects.insert(
            0,
            CoreEffect::Event(listener_event(PORT_CONNECTION, message)),
        );
        effects
    }
}
