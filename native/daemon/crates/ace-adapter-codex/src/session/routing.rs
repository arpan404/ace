// SPDX-License-Identifier: Apache-2.0
//! Ownership bookkeeping for one app-server shared by several ace threads,
//! ported from `host-routing.ts` (`subjectThread`, `revealedChildren`,
//! `HostRouter`, `:45`–`:173`). A tenant owns the native threads it opened and
//! every descendant they reveal. Responses follow the request that asked;
//! nothing unowned is guessed onto a tenant, and a message about an unowned
//! thread is `Hold`, never `Drop`: the caller resolves the ancestry and then
//! decides, so an unknown route stays raw rather than being lost.

use ace_json::{JsString, Value};
use ace_supervisor::jsonrpc::RpcId;
use indexmap::IndexMap;

/// Requests that may claim a thread when their reply names one.
const OPENING: [&str; 3] = ["thread/start", "thread/resume", "thread/fork"];
/// Open requests kept for attribution (`requestLimit`, `:7`).
const REQUEST_LIMIT: usize = 4096;
/// Server requests and turns kept for attribution (`servedLimit`, `:8`).
const SERVED_LIMIT: usize = 1024;
/// Released threads remembered as replay hints (`RecentSet`, `retention.ts`).
const RECENT_LIMIT: usize = 1024;

/// Where one received app-server message belongs (`Route`, `:11`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route<T> {
    Tenant { tenant: T, claimed: Vec<JsString> },
    Host,
    All,
    Hold { thread: JsString },
    Drop,
}

/// A non-empty string value, as `str()` followed by a falsy check reads it.
pub fn text(value: Option<&Value>) -> Option<JsString> {
    match value {
        Some(Value::String(text)) if !text.is_empty() => Some(text.clone()),
        _ => None,
    }
}

/// The thread id a message is about, including `thread/started`, which nests
/// it: `str(params.threadId, str(params.thread.id))`.
pub fn subject_thread(message: &Value) -> Option<JsString> {
    let params = message.get("params");
    text(params.and_then(|params| params.get("threadId"))).or_else(|| {
        text(
            params
                .and_then(|params| params.get("thread"))
                .and_then(|thread| thread.get("id")),
        )
    })
}

/// Child threads a routed frame reveals; their later events belong to the
/// same owner (`revealedChildren`, `:25`).
pub fn revealed_children(message: &Value) -> Vec<JsString> {
    let method = text(message.get("method"));
    let Some(method) = method.as_ref().and_then(JsString::as_well_formed) else {
        return Vec::new();
    };
    if method != "item/started" && method != "item/completed" {
        return Vec::new();
    }
    let Some(item) = message
        .get("params")
        .and_then(|params| params.get("item"))
        .filter(|item| item.is_object())
    else {
        return Vec::new();
    };
    let kind = text(item.get("type"));
    if kind.as_ref().and_then(JsString::as_well_formed) == Some("collabAgentToolCall")
        && text(item.get("tool"))
            .as_ref()
            .and_then(JsString::as_well_formed)
            == Some("spawnAgent")
    {
        return item
            .get("receiverThreadIds")
            .and_then(Value::as_array)
            .map(|ids| ids.iter().filter_map(|id| text(Some(id))).collect())
            .unwrap_or_default();
    }
    if kind.as_ref().and_then(JsString::as_well_formed) == Some("subAgentActivity")
        && text(item.get("kind"))
            .as_ref()
            .and_then(JsString::as_well_formed)
            == Some("started")
    {
        return text(item.get("agentThreadId")).into_iter().collect();
    }
    Vec::new()
}

/// A thread's parent from Codex's own record (`parentOf`, `session-state.ts:29`),
/// either directly or through the sub-agent spawn that made it.
pub fn parent_of(thread: &Value) -> Option<JsString> {
    text(thread.get("parentThreadId")).or_else(|| {
        text(
            thread
                .get("source")
                .and_then(|source| source.get("subAgent"))
                .and_then(|sub| sub.get("thread_spawn"))
                .and_then(|spawn| spawn.get("parent_thread_id")),
        )
    })
}

/// A request id: a JavaScript string or a finite number.
fn rpc_id(value: &Value) -> Option<RpcId> {
    match value {
        Value::String(text) => Some(RpcId::Text(text.clone())),
        Value::Number(number) => number
            .as_f64()
            .filter(|id| id.is_finite())
            .map(RpcId::Number),
        _ => None,
    }
}

/// A message's `id`, when it names one.
fn message_id(message: &Value) -> Option<RpcId> {
    message.get("id").and_then(rpc_id)
}

/// One open request, for the reply that follows it.
struct RequestEntry<T> {
    tenant: Option<T>,
    method: JsString,
}

/// A closed thread remembered as a replay hint (`RecentSet`): newest last,
/// bounded at 1024, re-adding moves it to the end.
#[derive(Default)]
struct RecentSet {
    threads: IndexMap<JsString, ()>,
}

impl RecentSet {
    fn add(&mut self, thread: &JsString) {
        self.threads.shift_remove(thread);
        self.threads.insert(thread.clone(), ());
        while self.threads.len() > RECENT_LIMIT {
            self.threads.shift_remove_index(0);
        }
    }

    fn has(&self, thread: &JsString) -> bool {
        self.threads.contains_key(thread)
    }

    fn remove(&mut self, thread: &JsString) {
        self.threads.shift_remove(thread);
    }
}

/// Pure ownership bookkeeping for one app-server shared by several ace
/// threads (`HostRouter`). `T` is a tenant's key.
pub struct HostRouter<T> {
    owners: IndexMap<JsString, T>,
    requests: IndexMap<RpcId, RequestEntry<T>>,
    served: IndexMap<RpcId, T>,
    released: RecentSet,
    /// Requests may name only their turn; a turn belongs to its thread's owner.
    turns: IndexMap<JsString, T>,
    opening: usize,
}

impl<T> Default for HostRouter<T> {
    fn default() -> Self {
        Self {
            owners: IndexMap::new(),
            requests: IndexMap::new(),
            served: IndexMap::new(),
            released: RecentSet::default(),
            turns: IndexMap::new(),
            opening: 0,
        }
    }
}

impl<T: Clone + Eq> HostRouter<T> {
    /// Open requests in flight. While any is pending, an unowned root may
    /// still be claimed.
    pub fn opening(&self) -> usize {
        self.opening
    }

    pub fn owner(&self, thread: &JsString) -> Option<&T> {
        self.owners.get(thread)
    }

    /// Released by a detached tenant; its late events are not evidence of a
    /// new owner.
    pub fn released(&self, thread: &JsString) -> bool {
        self.released.has(thread)
    }

    pub fn claim(&mut self, thread: &JsString, tenant: &T) -> bool {
        if thread.is_empty() || self.owners.get(thread) == Some(tenant) {
            return false;
        }
        self.owners.insert(thread.clone(), tenant.clone());
        self.released.remove(thread);
        true
    }

    /// The threads one tenant owns, for a detach's unsubscribes.
    pub fn owned(&self, tenant: &T) -> Vec<JsString> {
        self.owners
            .iter()
            .filter(|(_, owner)| *owner == tenant)
            .map(|(thread, _)| thread.clone())
            .collect()
    }

    /// Forget a tenant. Returns the threads it owned so the host can
    /// unsubscribe them.
    pub fn release(&mut self, tenant: &T) -> Vec<JsString> {
        let mut threads = Vec::new();
        let owned: Vec<JsString> = self
            .owners
            .iter()
            .filter(|(_, owner)| *owner == tenant)
            .map(|(thread, _)| thread.clone())
            .collect();
        for thread in owned {
            self.owners.shift_remove(&thread);
            self.released.add(&thread);
            threads.push(thread);
        }
        let forgotten: Vec<RpcId> = self
            .requests
            .iter()
            .filter(|(_, request)| request.tenant.as_ref() == Some(tenant))
            .map(|(id, _)| id.clone())
            .collect();
        for id in &forgotten {
            self.forget(id);
        }
        // `served` stays: the host queues a server request's dispatch, so a
        // tenant can leave before its handler answers, where TS answers in the
        // same step it dispatches. The reply is still that tenant's frame, and
        // the entry goes when it arrives or falls out of the bound.
        self.turns.retain(|_, owner| owner != tenant);
        threads
    }

    /// The process is gone: a served request nobody answered will never be, so
    /// its attribution goes with the host.
    pub fn forget_served(&mut self) {
        self.served.clear();
    }

    /// A server request routed to a tenant; its answer is that tenant's frame.
    pub fn serve(&mut self, id: RpcId, tenant: T) {
        while self.served.len() >= SERVED_LIMIT {
            self.served.shift_remove_index(0);
        }
        self.served.insert(id, tenant);
    }

    /// Attribute an outgoing frame. `sender` is `None` for the host's own
    /// traffic.
    pub fn sent(&mut self, message: &Value, sender: Option<&T>) -> Option<T> {
        let id = message_id(message);
        let method = text(message.get("method"));
        let Some(method) = method else {
            let id = id?;
            return self.served.shift_remove(&id);
        };
        if let Some(id) = id {
            while self.requests.len() >= REQUEST_LIMIT {
                let oldest = self.requests.first().map(|(id, _)| id.clone());
                match oldest {
                    Some(oldest) => self.forget(&oldest),
                    None => break,
                }
            }
            let opening = OPENING
                .iter()
                .any(|candidate| Some(*candidate) == method.as_well_formed());
            self.requests.insert(
                id,
                RequestEntry {
                    tenant: sender.cloned(),
                    method,
                },
            );
            if sender.is_some() && opening {
                self.opening += 1;
            }
        }
        sender.cloned()
    }

    /// Where one received message belongs (`received`, `:113`–`:153`), branch
    /// for branch.
    pub fn received(&mut self, message: &Value) -> Route<T> {
        let Some(method) = text(message.get("method")) else {
            let Some(id) = message_id(message) else {
                return Route::Drop;
            };
            let Some(request) = self.requests.get(&id) else {
                return Route::Drop;
            };
            let opening = OPENING
                .iter()
                .any(|candidate| Some(*candidate) == request.method.as_well_formed());
            let tenant = request.tenant.clone();
            self.forget(&id);
            let Some(tenant) = tenant else {
                return Route::Host;
            };
            let mut claimed = Vec::new();
            if opening
                && message.get("error").is_none()
                && let Some(thread) = message
                    .get("result")
                    .and_then(|result| result.get("thread"))
                    .and_then(|thread| thread.get("id"))
                    .and_then(|id| text(Some(id)))
                && self.claim(&thread, &tenant)
            {
                claimed.push(thread);
            }
            return Route::Tenant { tenant, claimed };
        };
        let Some(thread) = subject_thread(message) else {
            let turn = text(
                message
                    .get("params")
                    .and_then(|params| params.get("turnId")),
            );
            if let Some(owner) = turn.and_then(|turn| self.turns.get(&turn).cloned()) {
                return Route::Tenant {
                    tenant: owner,
                    claimed: Vec::new(),
                };
            }
            return if message_id(message).is_some() {
                Route::Host
            } else {
                Route::All
            };
        };
        let mut tenant = self.owners.get(&thread).cloned();
        let mut claimed = Vec::new();
        if tenant.is_none() && method.as_well_formed() == Some("thread/started") {
            let parent = message
                .get("params")
                .and_then(|params| params.get("thread"))
                .and_then(parent_of);
            let owner = parent.and_then(|parent| self.owners.get(&parent).cloned());
            if let Some(owner) = owner
                && self.claim(&thread, &owner)
            {
                tenant = Some(owner);
                claimed.push(thread.clone());
            }
        }
        let Some(tenant) = tenant else {
            // Codex broadcasts names for unloaded threads too; a name never
            // proves ownership.
            if method.as_well_formed() == Some("thread/name/updated") || self.released.has(&thread)
            {
                return Route::Drop;
            }
            return Route::Hold { thread };
        };
        for child in revealed_children(message) {
            if self.claim(&child, &tenant) {
                claimed.push(child);
            }
        }
        self.track_turn(&method, message, &tenant);
        Route::Tenant { tenant, claimed }
    }
}

impl<T: Clone + Eq> HostRouter<T> {
    fn track_turn(&mut self, method: &JsString, message: &Value, tenant: &T) {
        let Some(turn) = text(
            message
                .get("params")
                .and_then(|params| params.get("turn"))
                .and_then(|turn| turn.get("id")),
        ) else {
            return;
        };
        match method.as_well_formed() {
            Some("turn/completed") => {
                self.turns.shift_remove(&turn);
            }
            Some("turn/started") => {
                while self.turns.len() >= SERVED_LIMIT {
                    self.turns.shift_remove_index(0);
                }
                self.turns.insert(turn, tenant.clone());
            }
            _ => {}
        }
    }

    /// Forget one request, keeping the opening count right.
    fn forget(&mut self, id: &RpcId) {
        let Some(request) = self.requests.shift_remove(id) else {
            return;
        };
        if request.tenant.is_some()
            && OPENING
                .iter()
                .any(|opening| Some(*opening) == request.method.as_well_formed())
        {
            self.opening = self.opening.saturating_sub(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(text: &str) -> Value {
        ace_json::parse(text).expect("test frame parses")
    }

    fn thread(name: &str) -> JsString {
        JsString::from(name)
    }

    /// The routing table's rows: the messages, then the route each one takes.
    #[test]
    fn a_received_message_routes_as_the_table_says() {
        type Setup = fn(&mut HostRouter<u64>);
        let rows: &[(Setup, &str, Route<u64>)] = &[
            (
                |_| {},
                r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"no"}}"#,
                Route::Drop,
            ),
            (
                |_| {},
                r#"{"jsonrpc":"2.0","method":"x/unknown","params":{"threadId":"t"}}"#,
                Route::Hold {
                    thread: thread("t"),
                },
            ),
            (
                |_| {},
                r#"{"jsonrpc":"2.0","method":"thread/name/updated","params":{"threadId":"t"}}"#,
                Route::Drop,
            ),
            (
                |_| {},
                r#"{"jsonrpc":"2.0","method":"x/global"}"#,
                Route::All,
            ),
            (
                |_| {},
                r#"{"jsonrpc":"2.0","id":9,"method":"x/host"}"#,
                Route::Host,
            ),
        ];
        for (setup, message, expected) in rows {
            let mut router = HostRouter::<u64>::default();
            setup(&mut router);
            assert_eq!(&router.received(&frame(message)), expected, "{message}");
        }
    }

    /// Every branch of `received` that needs prior ownership.
    #[test]
    fn ownership_decides_each_route_in_the_table() {
        let mut router = HostRouter::<u64>::default();
        router.claim(&thread("own"), &7);
        router.turns.insert(thread("turn-1"), 7);

        let rows: &[(&str, Route<u64>)] = &[
            (
                r#"{"jsonrpc":"2.0","method":"item/completed","params":{"threadId":"own"}}"#,
                Route::Tenant {
                    tenant: 7,
                    claimed: vec![],
                },
            ),
            (
                r#"{"jsonrpc":"2.0","method":"x/named","params":{"threadId":"own"}}"#,
                Route::Tenant {
                    tenant: 7,
                    claimed: vec![],
                },
            ),
            (
                r#"{"jsonrpc":"2.0","method":"x/turn","params":{"turnId":"turn-1"}}"#,
                Route::Tenant {
                    tenant: 7,
                    claimed: vec![],
                },
            ),
            (
                r#"{"jsonrpc":"2.0","method":"x/turn","params":{"turnId":"turn-2"}}"#,
                Route::All,
            ),
            (
                r#"{"jsonrpc":"2.0","id":4,"method":"x/turn","params":{"turnId":"turn-2"}}"#,
                Route::Host,
            ),
            (
                r#"{"jsonrpc":"2.0","method":"thread/started","params":{"thread":{"id":"child","parentThreadId":"own"}}}"#,
                Route::Tenant {
                    tenant: 7,
                    claimed: vec![thread("child")],
                },
            ),
            (
                r#"{"jsonrpc":"2.0","method":"thread/started","params":{"thread":{"id":"grandchild","source":{"subAgent":{"thread_spawn":{"parent_thread_id":"child"}}}}}}"#,
                Route::Tenant {
                    tenant: 7,
                    claimed: vec![thread("grandchild")],
                },
            ),
            (
                r#"{"jsonrpc":"2.0","method":"x/frames","params":{"threadId":"orphan"}}"#,
                Route::Hold {
                    thread: thread("orphan"),
                },
            ),
        ];
        for (message, expected) in rows {
            assert_eq!(&router.received(&frame(message)), expected, "{message}");
        }
        assert_eq!(router.owner(&thread("grandchild")), Some(&7));
    }

    /// A child a routed frame reveals belongs to the same owner; the other
    /// item shapes reveal nothing.
    #[test]
    fn revealed_children_are_the_spawned_agents_only() {
        let rows: &[(&str, Vec<JsString>)] = &[
            (
                r#"{"method":"item/started","params":{"threadId":"a","item":{"type":"collabAgentToolCall","tool":"spawnAgent","receiverThreadIds":["b","c",""]}}}"#,
                vec![thread("b"), thread("c")],
            ),
            (
                r#"{"method":"item/completed","params":{"threadId":"a","item":{"type":"subAgentActivity","kind":"started","agentThreadId":"d"}}}"#,
                vec![thread("d")],
            ),
            (
                r#"{"method":"item/completed","params":{"threadId":"a","item":{"type":"subAgentActivity","kind":"completed","agentThreadId":"d"}}}"#,
                vec![],
            ),
            (
                r#"{"method":"item/completed","params":{"threadId":"a","item":{"type":"collabAgentToolCall","tool":"wait"}}}"#,
                vec![],
            ),
            (
                r#"{"method":"turn/completed","params":{"threadId":"a"}}"#,
                vec![],
            ),
        ];
        for (message, expected) in rows {
            assert_eq!(&revealed_children(&frame(message)), expected, "{message}");
        }
    }

    /// A spawned child is claimed by its owner's frame, and only that tenant
    /// sees it afterwards.
    #[test]
    fn a_revealed_child_belongs_to_the_owner_of_the_frame_that_named_it() {
        let mut router = HostRouter::<u64>::default();
        router.claim(&thread("a"), &1);
        let route = router.received(&frame(
            r#"{"method":"item/completed","params":{"threadId":"a","item":{"type":"collabAgentToolCall","tool":"spawnAgent","receiverThreadIds":["child"]}}}"#,
        ));
        assert_eq!(
            route,
            Route::Tenant {
                tenant: 1,
                claimed: vec![thread("child")],
            }
        );
        assert_eq!(
            router.received(&frame(
                r#"{"method":"x/next","params":{"threadId":"child"}}"#
            )),
            Route::Tenant {
                tenant: 1,
                claimed: vec![],
            }
        );
    }

    /// A response follows the request that asked, and only an opening request
    /// claims the thread its reply names.
    #[test]
    fn a_response_returns_to_its_requester_and_claims_only_an_opening_thread() {
        let mut router = HostRouter::<u64>::default();
        router.sent(
            &frame(r#"{"jsonrpc":"2.0","id":"start-1","method":"thread/start","params":{}}"#),
            Some(&4),
        );
        assert_eq!(router.opening(), 1);
        assert_eq!(
            router.received(&frame(
                r#"{"jsonrpc":"2.0","id":"start-1","result":{"thread":{"id":"native-1"}}}"#
            )),
            Route::Tenant {
                tenant: 4,
                claimed: vec![thread("native-1")],
            }
        );
        assert_eq!(router.opening(), 0);
        assert_eq!(router.owner(&thread("native-1")), Some(&4));

        // A failed open claims nothing, and still returns to its requester.
        router.sent(
            &frame(r#"{"jsonrpc":"2.0","id":2,"method":"thread/resume","params":{}}"#),
            Some(&5),
        );
        assert_eq!(
            router.received(&frame(
                r#"{"jsonrpc":"2.0","id":2,"error":{"code":-32600,"message":"busy"}}"#
            )),
            Route::Tenant {
                tenant: 5,
                claimed: vec![],
            }
        );
        assert_eq!(router.opening(), 0);

        // A read's result returns without claiming.
        router.sent(
            &frame(r#"{"jsonrpc":"2.0","id":3,"method":"thread/read","params":{}}"#),
            Some(&5),
        );
        assert_eq!(
            router.received(&frame(
                r#"{"jsonrpc":"2.0","id":3,"result":{"thread":{"id":"someone-elses"}}}"#
            )),
            Route::Tenant {
                tenant: 5,
                claimed: vec![],
            }
        );
        assert_eq!(router.owner(&thread("someone-elses")), None);
    }

    /// The host's own requests answer to the host, and an answer to a request
    /// nobody made is dropped rather than guessed.
    #[test]
    fn host_traffic_and_stray_responses_have_their_own_routes() {
        let mut router = HostRouter::<u64>::default();
        router.sent(
            &frame(r#"{"jsonrpc":"2.0","id":1,"method":"thread/read","params":{}}"#),
            None,
        );
        assert_eq!(
            router.received(&frame(
                r#"{"jsonrpc":"2.0","id":1,"result":{"thread":{"id":"x"}}}"#
            )),
            Route::Host
        );
        assert_eq!(
            router.received(&frame(r#"{"jsonrpc":"2.0","id":99,"result":{}}"#)),
            Route::Drop
        );
        assert_eq!(
            router.received(&frame(r#"{"jsonrpc":"2.0","result":{}}"#)),
            Route::Drop
        );
    }

    /// An answered server request belongs to the tenant that was served, and
    /// to nobody after that.
    #[test]
    fn a_served_requests_answer_is_the_tenants_frame() {
        let mut router = HostRouter::<u64>::default();
        router.serve(RpcId::Text(thread("ask-1")), 3);
        assert_eq!(
            router.sent(
                &frame(r#"{"jsonrpc":"2.0","id":"ask-1","result":{}}"#),
                None
            ),
            Some(3),
            "the host's own sender is attributed by the request it served"
        );
        assert_eq!(
            router.sent(
                &frame(r#"{"jsonrpc":"2.0","id":"ask-1","result":{}}"#),
                None
            ),
            None,
            "one answer belongs to one tenant"
        );
        assert_eq!(router.served.len(), 0);
    }

    /// A served request's answer stays that tenant's frame even when the
    /// tenant left before answering: the host queues the dispatch, so a detach
    /// can land between the request and its reply, where TS's one step cannot.
    #[test]
    fn a_served_requests_answer_stays_the_tenants_after_it_leaves() {
        let mut router = HostRouter::<u64>::default();
        router.serve(RpcId::Text(thread("ask-1")), 3);
        router.release(&3);
        assert_eq!(
            router.sent(
                &frame(r#"{"jsonrpc":"2.0","id":"ask-1","result":{}}"#),
                None
            ),
            Some(3),
            "the reply is the departed tenant's frame, never nobody's"
        );
        assert_eq!(router.served.len(), 0, "one answer belongs to one tenant");
    }

    /// The host's exit ends an answer nobody gave: a served request is not
    /// attributed to a tenant of a process that is gone.
    #[test]
    fn the_hosts_exit_forgets_an_unanswered_served_request() {
        let mut router = HostRouter::<u64>::default();
        router.serve(RpcId::Text(thread("ask-1")), 3);
        router.release(&3);
        router.forget_served();
        assert_eq!(router.served.len(), 0);
        assert_eq!(
            router.sent(
                &frame(r#"{"jsonrpc":"2.0","id":"ask-1","result":{}}"#),
                None
            ),
            None
        );
    }

    /// A turn belongs to its thread's owner only while it runs.
    #[test]
    fn a_completed_turn_stops_routing_to_its_owner() {
        let mut router = HostRouter::<u64>::default();
        router.claim(&thread("a"), &1);
        router.received(&frame(
            r#"{"method":"turn/started","params":{"threadId":"a","turn":{"id":"turn-1"}}}"#,
        ));
        assert_eq!(
            router.received(&frame(r#"{"method":"x/ask","params":{"turnId":"turn-1"}}"#)),
            Route::Tenant {
                tenant: 1,
                claimed: vec![],
            }
        );
        router.received(&frame(
            r#"{"method":"turn/completed","params":{"threadId":"a","turn":{"id":"turn-1"}}}"#,
        ));
        assert_eq!(
            router.received(&frame(r#"{"method":"x/ask","params":{"turnId":"turn-1"}}"#)),
            Route::All
        );
    }

    /// Releasing a tenant forgets its threads; their late traffic is dropped,
    /// not held for a new owner.
    #[test]
    fn a_released_tenants_threads_are_never_reclaimed_by_a_neighbour() {
        let mut router = HostRouter::<u64>::default();
        router.claim(&thread("a"), &1);
        router.claim(&thread("b"), &1);
        router.sent(
            &frame(r#"{"jsonrpc":"2.0","id":1,"method":"thread/start","params":{}}"#),
            Some(&1),
        );
        assert_eq!(
            router.release(&1),
            vec![thread("a"), thread("b")],
            "every owned thread is unsubscribed"
        );
        assert_eq!(router.opening(), 0, "a released request stops counting");
        assert!(router.released(&thread("b")));
        assert_eq!(
            router.received(&frame(r#"{"method":"x/late","params":{"threadId":"b"}}"#)),
            Route::Drop
        );
        // The released hint is a replay guard, not a claim: another owner can
        // take the thread again.
        assert!(router.claim(&thread("b"), &2));
        assert!(!router.released(&thread("b")));
        assert_eq!(
            router.received(&frame(r#"{"method":"x/late","params":{"threadId":"b"}}"#)),
            Route::Tenant {
                tenant: 2,
                claimed: vec![],
            }
        );
    }

    /// `subjectThread` reads both shapes a thread id travels in.
    #[test]
    fn a_subject_thread_is_read_from_either_shape() {
        let rows: &[(&str, Option<JsString>)] = &[
            (r#"{"params":{"threadId":"flat"}}"#, Some(thread("flat"))),
            (
                r#"{"params":{"thread":{"id":"nested"}}}"#,
                Some(thread("nested")),
            ),
            (
                r#"{"params":{"threadId":"","thread":{"id":"nested"}}}"#,
                Some(thread("nested")),
            ),
            (r#"{"params":{"threadId":""}}"#, None),
            (r#"{"params":{}}"#, None),
            (r#"{"params":{"turnId":"t"}}"#, None),
        ];
        for (message, expected) in rows {
            assert_eq!(&subject_thread(&frame(message)), expected, "{message}");
        }
    }
}
