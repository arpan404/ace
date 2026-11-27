// SPDX-License-Identifier: Apache-2.0
//! Helpers `decide`'s table and part A share, and the cases that need no tree: a person's machine
//! always allows, and an operation nobody classified is refused.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::HashMap;

use crate::org::decide::{Operation, Resource, decide, host, unplaced};
use crate::org::principal::{ChildCapability, Principal};
use crate::org::trees::{StructuralTrees, TreeAccess, TreeRef, TreeResolver, Visibility};

pub(super) const ORG: &str = "org_acme";

pub(super) fn thread(id: &str) -> TreeRef {
    TreeRef::Thread(id.to_owned())
}

/// A resolver as the access table will fill it: Ann owns two trees, Bo one private one.
pub(super) struct FilledTrees {
    structural: StructuralTrees,
    access: HashMap<String, TreeAccess>,
}

impl TreeResolver for FilledTrees {
    fn root(&self, reference: &TreeRef) -> Option<String> {
        self.structural.root(reference)
    }

    fn access(&self, root: &str) -> Option<TreeAccess> {
        self.access.get(root).cloned()
    }
}

pub(super) fn filled() -> FilledTrees {
    let structural =
        StructuralTrees::new(|thread| (thread == "t_mine_child").then(|| "t_mine".to_owned()));
    let mut access = HashMap::new();
    access.insert("t_mine".to_owned(), TreeAccess::private("ann"));
    access.insert(
        "t_shared".to_owned(),
        TreeAccess {
            owner: "ann".to_owned(),
            visibility: Visibility::Org,
            readers: Vec::new(),
        },
    );
    access.insert("t_theirs".to_owned(), TreeAccess::private("bo"));
    FilledTrees { structural, access }
}

pub(super) fn part_a() -> StructuralTrees {
    StructuralTrees::new(|_| None)
}

pub(super) fn member(account: &str, role: &str) -> Principal {
    Principal::Member {
        org: ORG.to_owned(),
        account: account.to_owned(),
        role: role.to_owned(),
    }
}

pub(super) fn peer(child: &str) -> Principal {
    Principal::Peer {
        capability: ChildCapability {
            org: ORG.to_owned(),
            from: "host_b".to_owned(),
            root: "t_remote_root".to_owned(),
            owner: "ann".to_owned(),
            child: child.to_owned(),
        },
    }
}

pub(super) fn allowed(who: &Principal, operation: Option<Operation>, resource: &Resource) -> bool {
    decide(who, operation, resource, &filled()).allowed()
}

pub(super) fn allowed_in(
    who: &Principal,
    operation: Option<Operation>,
    resource: &Resource,
) -> bool {
    decide(who, operation, resource, &part_a()).allowed()
}

#[test]
fn allows_everything_on_a_persons_machine() {
    for operation in [
        None,
        Some(Operation::TreeWrite),
        Some(Operation::Pairing),
        Some(Operation::Computer),
    ] {
        assert!(allowed_in(&Principal::Personal, operation, &unplaced()));
    }
}

#[test]
fn refuses_an_operation_nobody_classified_to_every_principal_on_an_org_host() {
    for who in [
        member("ann", "member"),
        member("olu", "owner"),
        Principal::Host,
        Principal::Agent {
            root: "t_mine".to_owned(),
        },
        Principal::Admitted {
            org: ORG.to_owned(),
            account: "ann".to_owned(),
        },
    ] {
        assert!(!allowed(&who, None, &host()), "{}", who.kind());
    }
}

#[test]
fn a_members_catch_up_feed_is_let_through_and_other_lists_are_not() {
    use crate::org::operations::{socket_operation, socket_resource};

    let feed = ace_json::parse(
        "{\"type\":\"notification.feed\",\"requestId\":\"wake\",\"afterCursor\":4}",
    )
    .unwrap();
    let operation = socket_operation(&feed);
    assert_eq!(operation, Some(Operation::TreeRead));
    let resource = socket_resource(&feed, Operation::TreeRead);
    assert!(allowed(&member("bo", "member"), operation, &resource));
    assert!(!allowed(
        &Principal::Admitted {
            org: ORG.to_owned(),
            account: "ann".to_owned(),
        },
        operation,
        &resource
    ));
    let page = ace_json::parse("{\"type\":\"threads.page\",\"requestId\":\"list\"}").unwrap();
    let operation = socket_operation(&page);
    assert!(!allowed(
        &member("bo", "member"),
        operation,
        &socket_resource(&page, operation.unwrap())
    ));
}
