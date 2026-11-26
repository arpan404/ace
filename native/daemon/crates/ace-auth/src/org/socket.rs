// SPDX-License-Identifier: Apache-2.0
//! The org host's access policy as a socket asks it (`org-access/socket-wiring.ts`,
//! `socket-operations.ts`, `gate.ts`): what each message type is, the resource it names, the
//! channel a hello opens, and the refusals it answers with. Every helper returns today's answer
//! on a person's machine.

use std::cell::Cell;
use std::sync::Mutex;

use ace_json::Value;

use super::decide::{Decision, Operation, Resource, decide, tree, unplaced};
use super::handles::{BoundHandle, Handles, holder_key};
use super::operations::{channel_operation, socket_operation, socket_resource};
use super::principal::{ChildCapability, Principal, PrincipalFacts, principal};
use super::trees::{TreeRef, TreeResolver};

/// What a transport knows about its caller, without the organization (read fresh each time).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SocketFacts {
    pub host_token: bool,
    pub admitted: Option<crate::devices::Member>,
    pub proven: Option<crate::devices::Member>,
    pub agent_root: Option<String>,
    pub capability: Option<ChildCapability>,
}

/// What a refusal says to the client (`gate.ts:14`).
pub fn refusal_message(reason: &str) -> &'static str {
    match reason {
        "unproven" => "Prove you're a member of this organization on this connection first.",
        "operator" => "This host's own token runs the daemon; it doesn't read members' work.",
        "not_org_owner" => {
            "Only an owner of this organization, proven on this connection, can do that."
        }
        "unclassified" | "refused_on_org_host" => "This organization's host doesn't allow that.",
        "unplaced" | "not_shared" => "That isn't shared with you on this host.",
        "not_owner" => "Only this thread's owner can do that.",
        "other_child" => "That capability is for another child.",
        _ => "This organization's host doesn't allow that.",
    }
}

/// The policy as one socket asks it.
pub struct SocketGate {
    org: Box<dyn Fn() -> Option<String> + Send + Sync>,
    facts: Box<dyn Fn() -> SocketFacts + Send + Sync>,
    trees: Box<dyn TreeResolver + Send + Sync>,
    handles: Mutex<Handles>,
    channel: Cell<Option<Operation>>,
}

impl SocketGate {
    pub fn new(
        org: impl Fn() -> Option<String> + Send + Sync + 'static,
        facts: impl Fn() -> SocketFacts + Send + Sync + 'static,
        trees: impl TreeResolver + Send + Sync + 'static,
    ) -> Self {
        Self {
            org: Box::new(org),
            facts: Box::new(facts),
            trees: Box::new(trees),
            handles: Mutex::new(Handles::new()),
            channel: Cell::new(Some(Operation::Session)),
        }
    }

    /// The principal recomputed from what the socket proved at the moment of asking.
    pub fn principal(&self) -> Principal {
        let facts = (self.facts)();
        principal(&PrincipalFacts {
            org: (self.org)(),
            host_token: facts.host_token,
            admitted: facts.admitted,
            proven: facts.proven,
            agent_root: facts.agent_root,
            capability: facts.capability,
        })
    }

    /// Whether the policy steps aside here: a person's machine.
    pub fn personal(&self) -> bool {
        (self.org)().is_none()
    }

    pub fn ask(&self, operation: Option<Operation>, resource: &Resource) -> Decision {
        decide(&self.principal(), operation, resource, self.trees.as_ref())
    }

    /// What a socket message asks for.
    pub fn message(&self, message: &Value) -> Decision {
        let operation = socket_operation(message);
        let resource = match operation {
            Some(operation) => socket_resource(message, operation),
            None => unplaced(),
        };
        self.ask(operation, &resource)
    }

    /// Opening a dedicated channel; its binary frames are decided as this opening was.
    pub fn open(&self, name: Option<&str>) -> Decision {
        let operation = channel_operation(name);
        self.channel.set(operation);
        self.ask(operation, &unplaced())
    }

    /// A binary frame: taken only on a channel whose opening `decide` still allows.
    pub fn binary(&self) -> Decision {
        let channel = self.channel.get();
        let operation = if channel == Some(Operation::Session) {
            None
        } else {
            channel
        };
        self.ask(operation, &unplaced())
    }

    pub fn bind(&self, handle: BoundHandle) -> u64 {
        self.handles
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .bind(handle)
    }

    pub fn release(&self, id: u64) {
        self.handles
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .release(id);
    }

    pub fn handle_count(&self) -> usize {
        self.handles
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .size()
    }

    /// The current principal's key, which a bound handle must still match.
    pub fn holder(&self) -> String {
        holder_key(&self.principal())
    }

    /// Closes every live handle the socket's current principal may no longer hold.
    pub fn revalidate(&self) -> usize {
        let mut handles = self
            .handles
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let holder = self.holder();
        handles.revalidate(
            &|operation, resource| self.ask(Some(operation), resource),
            Some(&holder),
        )
    }
}

/// A refusal as the socket answers it: the error frame's fields and what it answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub code: &'static str,
    pub message: &'static str,
    pub reason: &'static str,
    /// A refused command fails for good (`socket-wiring.ts:77`-`:83`).
    pub retryable: bool,
    pub command_id: Option<String>,
    pub request_id: Option<String>,
    pub subscription_id: Option<String>,
}

/// One socket's policy surface (`orgSocketPolicy`).
pub struct SocketPolicy {
    gate: SocketGate,
}

impl SocketPolicy {
    pub fn new(
        org: impl Fn() -> Option<String> + Send + Sync + 'static,
        facts: impl Fn() -> SocketFacts + Send + Sync + 'static,
        trees: impl TreeResolver + Send + Sync + 'static,
    ) -> Self {
        Self {
            gate: SocketGate::new(org, facts, trees),
        }
    }

    pub fn gate(&self) -> &SocketGate {
        &self.gate
    }

    pub fn personal(&self) -> bool {
        self.gate.personal()
    }

    /// Whether the socket speaks for anyone here at all: on an org host only a proven member or
    /// the host's operator does.
    pub fn speaks(&self) -> bool {
        if self.gate.personal() {
            return true;
        }
        matches!(
            self.gate.principal(),
            Principal::Member { .. } | Principal::Host
        )
    }

    /// Whether the socket may read `thread`'s tree, as services check it per read and event.
    pub fn reads(&self, thread: &str) -> bool {
        self.gate.personal()
            || self
                .gate
                .ask(
                    Some(Operation::TreeRead),
                    &tree(TreeRef::Thread(thread.to_owned())),
                )
                .allowed()
    }

    /// Whether the socket may write into `thread`'s tree, now.
    pub fn writes(&self, thread: &str) -> bool {
        self.gate.personal()
            || self
                .gate
                .ask(
                    Some(Operation::TreeWrite),
                    &tree(TreeRef::Thread(thread.to_owned())),
                )
                .allowed()
    }

    /// Refuses `message` when the policy does, answering its request.
    pub fn refuses(&self, message: &Value) -> Option<Refusal> {
        if self.gate.personal() {
            return None;
        }
        let decision = self.gate.message(message);
        let reason = decision.reason()?;
        let command = message.get("command");
        let field = |value: Option<&Value>, key: &str| {
            value
                .and_then(|value| value.get(key))
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        Some(Refusal {
            code: "forbidden",
            message: refusal_message(reason),
            reason,
            retryable: false,
            command_id: field(command, "id"),
            request_id: field(Some(message), "requestId"),
            subscription_id: field(Some(message), "subscriptionId"),
        })
    }

    /// Whether a hello may open `channel`. A member admission has proven nothing yet, so it opens
    /// only the main channel.
    pub fn opens(&self, channel: Option<&str>) -> bool {
        self.gate.personal() || self.gate.open(channel).allowed()
    }

    pub fn binary(&self) -> bool {
        self.gate.personal() || self.gate.binary().allowed()
    }

    /// Notifications reach a socket only for trees it may read (`socket-wiring.ts:96`-`:102`):
    /// on an org host anything that doesn't name a placeable thread is dropped.
    pub fn fan_out_thread(&self, thread: Option<&str>) -> bool {
        if self.gate.personal() {
            return true;
        }
        match thread {
            Some(thread) => self.reads(thread),
            None => false,
        }
    }

    /// Binds a live handle to the socket's principal now and what it was allowed for; its
    /// release. A no-op on a person's machine (`None`).
    pub fn bind(&self, handle: BoundHandle) -> Option<u64> {
        if self.gate.personal() {
            return None;
        }
        Some(self.gate.bind(BoundHandle {
            holder: Some(self.gate.holder()),
            ..handle
        }))
    }

    pub fn release(&self, id: u64) {
        self.gate.release(id);
    }

    /// Who the socket is now, as a key a bound request must still match; `None` if personal.
    pub fn holder(&self) -> Option<String> {
        if self.gate.personal() {
            return None;
        }
        Some(self.gate.holder())
    }

    /// For deferred work (a command waiting in its lane): a check that holds only while the
    /// principal that admitted it is still the one, and the policy still allows it.
    pub fn recheck(&self, message: &Value, admitted: &str) -> bool {
        self.gate.holder() == admitted && self.gate.message(message).allowed()
    }

    /// Closes what the socket may no longer hold; a no-op on a person's machine.
    pub fn revalidate(&self) -> usize {
        if self.gate.personal() {
            return 0;
        }
        self.gate.revalidate()
    }
}

#[cfg(test)]
mod tests;
