// SPDX-License-Identifier: Apache-2.0
//! What the shell hands back to a channel: every callback the host decides is
//! an effect, and `Host::hand_over` applies the ones that belong to a channel.
//! A shell's sink calls it from its effect handler, in publication order, so a
//! notification, a server request, a refusal, a dropped line or a diagnostic
//! never reaches a channel before the effects the host decided earlier
//! (`bridge.rs`'s ordered publication, ADR 0223 §7 rule 3).

use super::*;

impl Host {
    /// Hands one decided effect to the channel it belongs to, for the effects
    /// that are the channel's own callbacks: a frame, a notification, a server
    /// request, a refusal, a dropped line, a malformed line, a diagnostic or a
    /// failure. `channel` is the shell's registry: it must keep a channel alive
    /// until its exit is published, because a frame decided before a detach
    /// still reaches it.
    ///
    /// Answers whether the effect was one of those, so a shell knows which
    /// effects it must apply itself. A server request's answer goes back
    /// through `answer`/`answer_error`, which publishes its reply in the same
    /// order.
    pub fn hand_over(
        &self,
        effect: &HostEffect,
        channel: impl Fn(u64) -> Option<Arc<dyn ChannelHandlers>>,
    ) -> bool {
        match effect {
            HostEffect::Frame { tenant, dir, data } => {
                if let Some(handlers) = channel(*tenant) {
                    handlers.frame(*dir, data);
                }
            }
            HostEffect::Notification {
                tenant,
                method,
                params,
            } => {
                if let Some(handlers) = channel(*tenant) {
                    handlers.notification(method, params.as_ref());
                }
            }
            HostEffect::ServerRequest {
                tenant,
                id,
                method,
                params,
            } => {
                let Some(handlers) = channel(*tenant) else {
                    self.refuse_unowned(id);
                    return true;
                };
                match handlers.request(id, method, params.as_ref()) {
                    RequestAnswer::Answered(value) => self.answer(id, &value),
                    RequestAnswer::MethodNotFound(message) => {
                        self.answer_error(id, METHOD_NOT_FOUND, &message);
                    }
                    RequestAnswer::Failed(message) => {
                        self.answer_error(id, INTERNAL_ERROR, &message);
                    }
                    RequestAnswer::Deferred => {}
                }
            }
            HostEffect::AdmissionFailed { tenant, message } => {
                if let Some(handlers) = channel(*tenant) {
                    handlers.failed(message);
                }
            }
            HostEffect::Dropped {
                tenant,
                line,
                uncertain,
            } => {
                if let Some(handlers) = channel(*tenant) {
                    if *uncertain {
                        handlers.output_uncertain();
                    }
                    handlers.dropped(line);
                }
            }
            HostEffect::Malformed { tenant, line } => {
                if let Some(handlers) = channel(*tenant) {
                    handlers.malformed(line);
                }
            }
            HostEffect::Stderr { tenant, line } => {
                if let Some(handlers) = channel(*tenant) {
                    handlers.stderr(line);
                }
            }
            HostEffect::Error { tenant, message } => {
                if let Some(handlers) = channel(*tenant) {
                    handlers.error(message);
                }
            }
            _ => return false,
        }
        true
    }

    /// A served request whose channel is gone: answered, never left open.
    fn refuse_unowned(&self, id: &RpcId) {
        self.input(|inner| {
            let peer =
                inner
                    .peer
                    .answer_error(id, METHOD_NOT_FOUND, "Codex request has no ace owner");
            inner.apply(peer);
        });
    }
}
