// SPDX-License-Identifier: Apache-2.0
//! Live handles and queued effects under the organization host's access policy
//! (`org-access/handles.ts`): a handle is bound to the operation and resource it was allowed for
//! when it was made, and revalidation closes every one its holder may no longer have. No I/O:
//! closing is the caller's callback.

use std::collections::BTreeMap;

use super::decide::{Decision, Operation, Resource};
use super::principal::Principal;

pub type Decider<'a> = &'a dyn Fn(Operation, &Resource) -> Decision;

pub type Closer = Box<dyn FnOnce(&'static str) + Send>;

/// A live handle.
pub struct BoundHandle {
    pub operation: Operation,
    /// Fixed when the handle was made, never re-derived from a later request.
    pub resource: Resource,
    /// Who held it when it was made, so a socket that later proves someone else doesn't inherit it.
    pub holder: Option<String>,
    pub close: Closer,
}

/// A key that names one principal and changes when the socket's principal does.
pub fn holder_key(principal: &Principal) -> String {
    match principal {
        Principal::Member { org, account, .. } => format!("member:{org}:{account}"),
        Principal::Admitted { org, account } => format!("admitted:{org}:{account}"),
        Principal::Agent { root } => format!("agent:{root}"),
        Principal::Peer { capability } => format!("peer:{}", capability.child),
        Principal::Personal => "personal".to_owned(),
        Principal::Host => "host".to_owned(),
        Principal::Unproven => "unproven".to_owned(),
    }
}

/// The handles one socket holds.
#[derive(Default)]
pub struct Handles {
    live: BTreeMap<u64, BoundHandle>,
    next: u64,
}

impl Handles {
    pub fn new() -> Self {
        Self::default()
    }

    /// Keeps `handle` until it is released or loses its access; returns the release.
    pub fn bind(&mut self, handle: BoundHandle) -> u64 {
        self.next += 1;
        let id = self.next;
        self.live.insert(id, handle);
        id
    }

    pub fn release(&mut self, id: u64) {
        self.live.remove(&id);
    }

    pub fn size(&self) -> usize {
        self.live.len()
    }

    /// Closes, and forgets, every handle `decide` no longer allows, or that another principal
    /// than `holder` made. Returns how many closed.
    pub fn revalidate(&mut self, decide: Decider<'_>, holder: Option<&str>) -> usize {
        let mut closing = Vec::new();
        self.live.retain(|_, handle| {
            let decision = match (&handle.holder, holder) {
                (Some(bound), Some(current)) if bound != current => {
                    Decision::Denied { reason: "unproven" }
                }
                _ => decide(handle.operation, &handle.resource),
            };
            if decision.allowed() {
                true
            } else {
                let BoundHandle { close, .. } = std::mem::replace(
                    handle,
                    BoundHandle {
                        operation: Operation::Session,
                        resource: Resource::Host,
                        holder: None,
                        close: Box::new(|_| {}),
                    },
                );
                closing.push((close, decision.reason().unwrap_or("unproven")));
                false
            }
        });
        let closed = closing.len();
        for (close, reason) in closing {
            close(reason);
        }
        closed
    }

    /// Forgets every handle without closing it: their holder closed them itself.
    pub fn clear(&mut self) {
        self.live.clear();
    }
}

/// Runs a queued effect only if `decide` still allows it now, against the principal that queued
/// it. One that fails is dropped, and `dropped` is told why.
pub fn run_if_still_allowed<T>(
    operation: Operation,
    resource: &Resource,
    run: impl FnOnce() -> T,
    decide: Decider<'_>,
    dropped: impl FnOnce(&'static str),
) -> Option<T> {
    let decision = decide(operation, resource);
    match decision.reason() {
        Some(reason) => {
            dropped(reason);
            None
        }
        None if decision.allowed() => Some(run()),
        None => None,
    }
}
#[cfg(test)]
mod tests {
    //! Ports `apps/daemon/src/org-access/admission.test.ts`'s live-handle and queued-effect
    //! cases (the MCP admission cases in that file belong to the MCP owner).

    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use std::cell::RefCell;
    use std::sync::{Arc, Mutex};

    use super::{BoundHandle, Handles, run_if_still_allowed};
    use crate::org::decide::{Decision, Operation, Resource, unplaced};
    use crate::org::trees::TreeRef;

    fn tree(root: &str) -> Resource {
        Resource::Tree(TreeRef::Root(root.to_owned()))
    }

    #[test]
    fn closes_the_handles_their_holder_may_no_longer_have_and_keeps_the_rest() {
        let mut handles = Handles::new();
        let closed = Arc::new(Mutex::new(Vec::new()));
        let first = Arc::clone(&closed);
        handles.bind(BoundHandle {
            operation: Operation::TreeRead,
            resource: tree("t_a"),
            holder: None,
            close: Box::new(move |reason| first.lock().unwrap().push(format!("a:{reason}"))),
        });
        let second = Arc::clone(&closed);
        handles.bind(BoundHandle {
            operation: Operation::HostMeta,
            resource: Resource::Host,
            holder: None,
            close: Box::new(move |reason| second.lock().unwrap().push(format!("b:{reason}"))),
        });
        let lost = RefCell::new(false);
        let decide = |operation: Operation, _resource: &Resource| {
            if *lost.borrow() && operation == Operation::TreeRead {
                Decision::Denied {
                    reason: "not_shared",
                }
            } else {
                Decision::Allowed
            }
        };
        assert_eq!(handles.revalidate(&decide, None), 0);
        *lost.borrow_mut() = true;
        assert_eq!(handles.revalidate(&decide, None), 1);
        assert_eq!(*closed.lock().unwrap(), vec!["a:not_shared"]);
        // Closed once: a second pass finds nothing left to close.
        assert_eq!(handles.revalidate(&decide, None), 0);
    }

    #[test]
    fn a_handle_made_by_another_principal_is_closed_even_if_it_would_still_be_allowed() {
        let mut handles = Handles::new();
        let closed = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&closed);
        handles.bind(BoundHandle {
            operation: Operation::TreeRead,
            resource: tree("t_a"),
            holder: Some("member:org:ann".to_owned()),
            close: Box::new(move |reason| seen.lock().unwrap().push(reason)),
        });
        let allow = |_: Operation, _: &Resource| Decision::Allowed;
        assert_eq!(handles.revalidate(&allow, Some("member:org:bo")), 1);
        assert_eq!(*closed.lock().unwrap(), vec!["unproven"]);
    }

    #[test]
    fn drops_a_queued_effect_whose_access_was_lost_before_it_runs_and_says_why() {
        let dropped = RefCell::new(Vec::new());
        let ran = RefCell::new(0);
        let allow = |_: Operation, _: &Resource| Decision::Allowed;
        let denied = |_: Operation, _: &Resource| Decision::Denied {
            reason: "not_owner",
        };
        let run = |ran: &RefCell<i32>| {
            *ran.borrow_mut() += 1;
            1
        };
        let allowed = run_if_still_allowed(
            Operation::TreeWrite,
            &tree("t_a"),
            || run(&ran),
            &allow,
            |why| dropped.borrow_mut().push(why.to_owned()),
        );
        assert_eq!(allowed, Some(1));
        let refused = run_if_still_allowed(
            Operation::TreeWrite,
            &tree("t_a"),
            || run(&ran),
            &denied,
            |why| dropped.borrow_mut().push(why.to_owned()),
        );
        assert_eq!(refused, None);
        assert_eq!(*ran.borrow(), 1);
        assert_eq!(*dropped.borrow(), vec!["not_owner"]);
        let _ = unplaced();
    }
}
