// SPDX-License-Identifier: Apache-2.0
//! The org host's access policy as a socket asks it (`org-access/socket-wiring.ts`,
//! `socket-operations.ts`, `gate.ts`): what each message type is, the resource it names, the
//! channel a hello opens, and the refusals it answers with. Every helper returns today's answer
//! on a person's machine.

use std::cell::Cell;
use std::sync::Mutex;

use ace_json::Value;

use super::decide::{
    Decision, Operation, Resource, TreeRef, TreeResolver, decide, filtered, host, tree, unplaced,
};
use super::handles::{BoundHandle, Handles, holder_key};
use super::principal::{ChildCapability, Principal, PrincipalFacts, principal};

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
                .filter(|text| !text.is_empty())
                .map(str::to_owned)
        };
        Some(Refusal {
            code: "forbidden",
            message: refusal_message(reason),
            reason,
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

    /// Notifications reach a socket only for trees it may read.
    pub fn fan_out_thread(&self, thread: Option<&str>) -> bool {
        if self.gate.personal() {
            return true;
        }
        match thread {
            Some(thread) => self.reads(thread),
            // A message naming no thread still passes, as the TypeScript's fan-out does.
            None => true,
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

/// Every socket message type's operation, or `None` when nobody classified it.
pub fn socket_operation(message: &Value) -> Option<Operation> {
    let name = message.get("type").and_then(Value::as_str)?;
    if let Some(operation) = exact_operation(name) {
        return Some(operation);
    }
    if let Some(operation) = prefix_operation(name) {
        return Some(operation);
    }
    if name == "fleet.request" {
        let op = message
            .get("operation")
            .and_then(|operation| operation.get("op"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        return Some(fleet_operation(op));
    }
    if name == "command" {
        let payload = message
            .get("command")
            .and_then(|command| command.get("payload"))
            .and_then(|payload| payload.get("type"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        return Some(match payload {
            "thread.create" => Operation::TreeCreate,
            "thread.interrupt" => Operation::TreeStop,
            _ => Operation::TreeWrite,
        });
    }
    None
}

fn exact_operation(name: &str) -> Option<Operation> {
    use Operation::*;
    Some(match name {
        "hello"
        | "ping"
        | "unsubscribe"
        | "presence.update"
        | "account.grant.refresh"
        | "account.standing"
        | "device.standing"
        | "catalog.unsubscribe"
        | "notification.unregister"
        | "browser.unsubscribe"
        | "skills.unsubscribe" => Session,
        "account.owner.release" | "account.owner.enroll" | "account.owner.enroll.confirm" => {
            HostAdmin
        }
        "host.identity"
        | "diagnostics.health"
        | "appUpdate.request"
        | "machineUpdate.request"
        | "icons.read"
        | "icons.resolve"
        | "avatars.resolve"
        | "permissions.capabilities"
        | "onboarding.query"
        | "onboarding.dismiss"
        | "search.status" => HostMeta,
        "diagnostics.request"
        | "admission.request"
        | "storage.request"
        | "projects.request"
        | "devices.request"
        | "devices.ack"
        | "outside.request"
        | "user_browser.settings"
        | "machine.code.clear"
        | "machine.code.set"
        | "machine.code.status"
        | "provider.logout"
        | "providers.request"
        | "marketplace.request"
        | "pluginRequest"
        | "suitRequest"
        | "suitWatch"
        | "suitReport" => HostAdmin,
        "terminal.request" | "terminal.credit" => HostShell,
        "subscribe"
        | "threads.page"
        | "items.page"
        | "items.window"
        | "entities.page"
        | "turns.page"
        | "turn.steps"
        | "item.raw"
        | "output.read"
        | "interaction.read"
        | "thread.catchUp"
        | "thread.readState"
        | "thread.search"
        | "search.query"
        | "activity.reads"
        | "activity.markRead"
        | "context.request"
        | "preview.request"
        | "queue.get"
        | "command.status"
        | "commands.list"
        | "commands.resolve"
        | "catalog.list"
        | "notification.feed"
        | "notification.ack"
        | "notification.register"
        | "notification.snooze"
        | "notification.config"
        | "notification.preferences"
        | "automation.list"
        | "automation.inbox"
        | "browser.subscribe"
        | "browser.tabs.list"
        | "browser.downloads.list"
        | "browser.download.read"
        | "browser.browsing.watch" => TreeRead,
        "cli.request"
        | "pi.control"
        | "workspace.request"
        | "source-control.request"
        | "repositories.request"
        | "verify.request"
        | "skills.request"
        | "prompts.request" => TreeWrite,
        "worktree.creation.request"
        | "history.list"
        | "history.import"
        | "history.continue"
        | "history.release"
        | "automation.put"
        | "automation.remove"
        | "automation.run"
        | "automation.retry"
        | "automation.setEnabled"
        | "automation.webhook" => TreeCreate,
        "machines.request" | "machine.call" | "machine.cancel" | "spade.machines"
        | "spade.remote" => FleetLink,
        "machine.transfer" | "transfers.request" => Transfer,
        "pair.redeem" => Pairing,
        "screen.request"
        | "screen.ack"
        | "computer.using.watch"
        | "media.connect"
        | "spade.computer.drive"
        | "spade.computer.get" => Computer,
        _ => return None,
    })
}

fn prefix_operation(name: &str) -> Option<Operation> {
    use Operation::*;
    const PREFIXES: [(&str, Operation); 16] = [
        ("browser.backend.", HostAdmin),
        ("user_browser.", HostAdmin),
        ("browser.", TreeWrite),
        ("spade.", Spade),
        ("settings.", HostAdmin),
        ("accounts.", HostAdmin),
        ("provider.accounts.", HostAdmin),
        ("provider.login.", HostAdmin),
        ("provider.install.", HostAdmin),
        ("cursor.auth.", HostAdmin),
        ("lockedUse.", HostAdmin),
        ("registry.", HostAdmin),
        ("mcp.", HostAdmin),
        ("models.", HostMeta),
        ("usage.", HostMeta),
        ("files.", HostShell),
    ];
    PREFIXES
        .iter()
        .find(|(prefix, _)| name.starts_with(prefix))
        .map(|(_, operation)| *operation)
}

/// `fleet.request` carries pairing and device care as well as fleet links.
fn fleet_operation(op: &str) -> Operation {
    match op {
        "pairing" | "pairings" | "cancelPairing" => Operation::Pairing,
        "devices" | "revoke" | "revokeOthers" | "scope" => Operation::HostAdmin,
        "remoteStatus" => Operation::HostMeta,
        _ => Operation::FleetLink,
    }
}

/// The resource a message names. A tree operation names the thread it carries (top level, in a
/// subscription's scope, a terminal's operation or a command's payload); one that names none
/// can't be placed.
pub fn socket_resource(message: &Value, operation: Operation) -> Resource {
    if !operation.as_str().starts_with("tree.") {
        return host();
    }
    if operation == Operation::TreeRead
        && message.get("type").and_then(Value::as_str) == Some("notification.feed")
    {
        return filtered();
    }
    let nested = |key: &str| {
        message
            .get(key)
            .and_then(|value| value.get("threadId"))
            .and_then(Value::as_str)
    };
    let payload = message
        .get("command")
        .and_then(|command| command.get("payload"));
    let thread = message
        .get("threadId")
        .and_then(Value::as_str)
        .filter(|thread| !thread.is_empty())
        .or_else(|| nested("scope"))
        .or_else(|| nested("operation"))
        .or_else(|| {
            payload
                .and_then(|payload| payload.get("threadId"))
                .and_then(Value::as_str)
        });
    if let Some(thread) = thread.filter(|thread| !thread.is_empty()) {
        return tree(TreeRef::Thread(thread.to_owned()));
    }
    let payload_id = |key: &str| {
        payload
            .and_then(|payload| payload.get(key))
            .and_then(Value::as_str)
    };
    if let Some(interaction) = payload_id("interactionId") {
        return tree(TreeRef::Interaction(interaction.to_owned()));
    }
    if let Some(task) = payload_id("taskId") {
        return tree(TreeRef::Task(task.to_owned()));
    }
    unplaced()
}

/// What opening a dedicated channel is (hello `channel`).
pub fn channel_operation(channel: Option<&str>) -> Option<Operation> {
    match channel {
        None => Some(Operation::Session),
        Some("files") => Some(Operation::HostShell),
        Some("devices" | "provider_auth") => Some(Operation::HostAdmin),
        Some("browser") => Some(Operation::TreeWrite),
        Some("screen" | "media") => Some(Operation::Computer),
        Some("machine" | "tunnel") => Some(Operation::FleetLink),
        Some(_) => None,
    }
}
#[cfg(test)]
mod tests {
    //! Ports `apps/daemon/src/org-access/socket-wiring.ts`'s admission checks at the socket
    //! surface behaviour.md §6 names: a lapsed standing stops the socket speaking, channel
    //! openings and binary frames follow the same policy, a refused command answers for good,
    //! a queued lane rechecks the principal that admitted it, and revalidation closes the
    //! handles a lapsed standing guarded. The TypeScript wiring has no test file of its own; the
    //! policy cases it calls are `decide.test.ts`'s (ported in `decide.rs`).

    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use std::sync::{Arc, Mutex};

    use ace_json::Value;

    use super::{Refusal, SocketFacts, SocketPolicy};
    use crate::devices::Member;
    use crate::org::decide::{StructuralTrees, TreeAccess, TreeRef, TreeResolver};
    use crate::org::handles::BoundHandle;

    const ORG: &str = "org_acme";

    fn member(account: &str, role: &str) -> Member {
        Member {
            org: ORG.to_owned(),
            account: account.to_owned(),
            role: role.to_owned(),
        }
    }

    struct Tables {
        structural: StructuralTrees,
        access: Vec<(String, TreeAccess)>,
    }

    impl TreeResolver for Tables {
        fn root(&self, reference: &TreeRef) -> Option<String> {
            self.structural.root(reference)
        }

        fn access(&self, root: &str) -> Option<TreeAccess> {
            self.access
                .iter()
                .find(|(each, _)| each == root)
                .map(|(_, access)| access.clone())
        }
    }

    fn trees() -> Tables {
        Tables {
            structural: StructuralTrees::new(|_| None),
            access: vec![
                ("t_mine".to_owned(), TreeAccess::private("ann")),
                (
                    "t_shared".to_owned(),
                    TreeAccess {
                        owner: "ann".to_owned(),
                        visibility: crate::org::decide::Visibility::Org,
                        readers: Vec::new(),
                    },
                ),
            ],
        }
    }

    fn policy(org: Option<&str>, facts: Arc<Mutex<SocketFacts>>) -> SocketPolicy {
        let org = org.map(str::to_owned);
        SocketPolicy::new(
            move || org.clone(),
            move || facts.lock().unwrap().clone(),
            trees(),
        )
    }

    fn json(text: &str) -> Value {
        ace_json::parse(text).unwrap()
    }

    #[test]
    fn a_persons_machine_is_left_alone() {
        let policy = policy(None, Arc::new(Mutex::new(SocketFacts::default())));
        assert!(policy.personal());
        assert!(policy.speaks());
        for channel in [None, Some("files"), Some("devices"), Some("screen")] {
            assert!(policy.opens(channel), "{channel:?}");
        }
        assert!(policy.binary());
        assert!(policy.reads("t_anyone"));
        assert!(policy.writes("t_anyone"));
        assert!(
            policy
                .refuses(&json("{\"type\":\"threads.page\"}"))
                .is_none()
        );
        assert!(policy.fan_out_thread(Some("t_anyone")));
        assert!(policy.holder().is_none());
    }

    #[test]
    fn the_hosts_operator_speaks_but_reads_no_members_tree() {
        let facts = Arc::new(Mutex::new(SocketFacts {
            host_token: true,
            ..Default::default()
        }));
        let policy = policy(Some(ORG), facts);
        assert!(policy.speaks());
        assert!(policy.opens(Some("files")));
        assert!(policy.opens(None));
        assert!(!policy.reads("t_shared"));
        assert!(!policy.writes("t_shared"));
        let refusal = policy
            .refuses(&json("{\"type\":\"threads.page\",\"requestId\":\"list\"}"))
            .expect("the operator reads no list");
        assert_eq!(refusal.code, "forbidden");
        assert_eq!(
            refusal.message,
            "This host's own token runs the daemon; it doesn't read members' work."
        );
        assert_eq!(refusal.request_id.as_deref(), Some("list"));
    }

    #[test]
    fn a_proven_member_reads_what_is_shared_and_opens_only_what_its_role_allows() {
        let proven = member("bo", "member");
        let facts = Arc::new(Mutex::new(SocketFacts {
            admitted: Some(proven.clone()),
            proven: Some(proven),
            ..Default::default()
        }));
        let policy = policy(Some(ORG), facts);
        assert!(policy.speaks());
        assert!(policy.reads("t_shared"));
        assert!(!policy.reads("t_mine"));
        assert!(policy.opens(None));
        assert!(!policy.opens(Some("files")));
        assert!(!policy.binary());
        assert!(policy.fan_out_thread(Some("t_shared")));
        assert!(!policy.fan_out_thread(Some("t_mine")));
        assert!(
            policy
                .refuses(&json(
                    "{\"type\":\"subscribe\",\"subscriptionId\":\"s\",\
                 \"scope\":{\"kind\":\"thread\",\"threadId\":\"t_shared\"}}"
                ))
                .is_none()
        );
        // A message that names no tree can't be placed, so a member is refused it.
        assert_eq!(
            policy
                .refuses(&json("{\"type\":\"threads.page\"}"))
                .map(|refusal| refusal.reason),
            Some("unplaced")
        );
    }

    #[test]
    fn an_admission_that_never_proved_speaks_for_nobody_but_keeps_its_connection() {
        let admitted = member("ann", "member");
        let facts = Arc::new(Mutex::new(SocketFacts {
            admitted: Some(admitted),
            ..Default::default()
        }));
        let policy = policy(Some(ORG), facts);
        assert!(!policy.speaks());
        assert!(policy.opens(None));
        assert!(!policy.opens(Some("devices")));
        assert!(!policy.reads("t_shared"));
        let refusal = policy
            .refuses(&json("{\"type\":\"command\",\"command\":{\"id\":\"c1\",\"payload\":{\"type\":\"thread.create\"}}}"))
            .expect("a command is refused");
        assert_eq!(refusal.command_id.as_deref(), Some("c1"));
        assert_eq!(
            refusal.message,
            "Prove you're a member of this organization on this connection first."
        );
    }

    #[test]
    fn a_lapsed_standing_stops_the_socket_speaking_and_closes_what_it_held() {
        let proven = member("ann", "member");
        let facts = Arc::new(Mutex::new(SocketFacts {
            admitted: Some(proven.clone()),
            proven: Some(proven),
            ..Default::default()
        }));
        let policy = policy(Some(ORG), facts.clone());
        assert!(policy.speaks());
        let holder = policy.holder().expect("a member has a holder key");
        let message = json(
            "{\"type\":\"subscribe\",\"subscriptionId\":\"s\",\"scope\":{\"kind\":\"thread\",\"threadId\":\"t_mine\"}}",
        );
        assert!(policy.recheck(&message, &holder));
        let closed = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&closed);
        let subscription = Arc::new(Mutex::new(Some(1_u64)));
        let released = Arc::clone(&subscription);
        policy
            .bind(BoundHandle {
                operation: crate::org::decide::Operation::TreeRead,
                resource: crate::org::decide::Resource::Tree(TreeRef::Thread("t_mine".into())),
                holder: None,
                close: Box::new(move |reason| {
                    *released.lock().unwrap() = None;
                    seen.lock().unwrap().push(reason);
                }),
            })
            .expect("a handle bound on an org host");
        assert_eq!(policy.revalidate(), 0);
        // The standing lapses: same socket, no proof any more.
        *facts.lock().unwrap() = SocketFacts {
            admitted: Some(member("ann", "member")),
            ..Default::default()
        };
        assert!(!policy.speaks());
        assert!(!policy.recheck(&message, &holder));
        assert_eq!(policy.revalidate(), 1);
        assert_eq!(*closed.lock().unwrap(), vec!["unproven"]);
        assert!(subscription.lock().unwrap().is_none());
    }

    #[test]
    fn a_refusal_is_a_forbidden_answer_that_a_client_can_match_to_its_request() {
        let facts = Arc::new(Mutex::new(SocketFacts::default()));
        let policy = policy(Some(ORG), facts);
        let refusal: Refusal = policy
            .refuses(&json("{\"type\":\"threads.page\",\"requestId\":\"r1\"}"))
            .unwrap();
        assert_eq!(refusal.code, "forbidden");
        assert_eq!(refusal.reason, "unproven");
        assert_eq!(refusal.request_id.as_deref(), Some("r1"));
        // An unclassified type is refused on an org host until someone classifies it.
        let refusal = policy
            .refuses(&json("{\"type\":\"a_tool_added_later\"}"))
            .unwrap();
        assert_eq!(refusal.reason, "unclassified");
    }
}
