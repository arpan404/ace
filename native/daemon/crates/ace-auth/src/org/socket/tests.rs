// SPDX-License-Identifier: Apache-2.0
//! The socket policy's cases at the surface behaviour.md §6 names: a lapsed standing stops the
//! socket speaking, channel openings and binary frames follow the same policy, a refused command
//! answers for good, a queued lane rechecks the principal that admitted it, and revalidation
//! closes the handles a lapsed standing guarded.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::{Arc, Mutex};

use ace_json::Value;

use super::{Refusal, SocketFacts, SocketPolicy};
use crate::devices::Member;
use crate::org::handles::BoundHandle;
use crate::org::trees::{StructuralTrees, TreeAccess, TreeRef, TreeResolver};

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
                    visibility: crate::org::trees::Visibility::Org,
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
fn a_broadcast_naming_no_thread_is_dropped_on_an_org_host_and_passes_on_a_person_s_machine() {
    let personal = policy(None, Arc::new(Mutex::new(SocketFacts::default())));
    assert!(personal.fan_out_thread(None));
    let proven = member("bo", "member");
    let facts = Arc::new(Mutex::new(SocketFacts {
        admitted: Some(proven.clone()),
        proven: Some(proven),
        ..Default::default()
    }));
    let org = policy(Some(ORG), facts);
    // `socket-wiring.ts:96`-`:102`: only a placeable thread's message is sent.
    assert!(!org.fan_out_thread(None));
    assert!(org.fan_out_thread(Some("t_shared")));
    assert!(!org.fan_out_thread(Some("t_mine")));
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
