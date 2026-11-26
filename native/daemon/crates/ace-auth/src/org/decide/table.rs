// SPDX-License-Identifier: Apache-2.0
//! The policy's table, every case `org-access/decide.test.ts` names, and part A's rule that an
//! access table which places no tree refuses every member request on one.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::tests::{ORG, allowed_in, filled, member, peer, thread};
use crate::org::decide::{Operation, Resource, TreeRef, decide, filtered, host, tree, unplaced};
use crate::org::principal::Principal;

#[test]
fn the_policy_decides_each_case_the_typescript_table_names() {
    let ann = member("ann", "member");
    let bo = member("bo", "member");
    let org_owner = member("olu", "owner");
    let operator = Principal::Host;
    let admitted = Principal::Admitted {
        org: ORG.to_owned(),
        account: "ann".to_owned(),
    };
    let unproven = Principal::Unproven;
    let anns_agent = Principal::Agent {
        root: "t_mine".to_owned(),
    };
    let bos_agent = Principal::Agent {
        root: "t_theirs".to_owned(),
    };
    let peer_mine = peer("t_mine");
    let cases: Vec<(&str, &Principal, Operation, Resource, bool)> = vec![
        // Admission is not identity.
        (
            "an admission keeps its connection",
            &admitted,
            Operation::Session,
            host(),
            true,
        ),
        (
            "an admission reaches no Spade",
            &admitted,
            Operation::Spade,
            host(),
            false,
        ),
        (
            "an admission reads no org tree",
            &admitted,
            Operation::TreeRead,
            tree(thread("t_shared")),
            false,
        ),
        (
            "an old paired device reads nothing",
            &unproven,
            Operation::TreeRead,
            tree(thread("t_shared")),
            false,
        ),
        // The operator runs the daemon and reads nothing of members'.
        (
            "the operator runs the daemon",
            &operator,
            Operation::HostAdmin,
            host(),
            true,
        ),
        (
            "the operator reads health",
            &operator,
            Operation::HostMeta,
            host(),
            true,
        ),
        (
            "the operator reads no tree",
            &operator,
            Operation::TreeRead,
            tree(thread("t_shared")),
            false,
        ),
        (
            "the operator reaches no Spade",
            &operator,
            Operation::Spade,
            host(),
            false,
        ),
        (
            "the operator writes into no tree",
            &operator,
            Operation::TreeWrite,
            tree(thread("t_mine")),
            false,
        ),
        (
            "the operator makes no pairing",
            &operator,
            Operation::Pairing,
            host(),
            false,
        ),
        // Members, by visibility; no role reads more.
        (
            "a member reads an org tree",
            &bo,
            Operation::TreeRead,
            tree(thread("t_shared")),
            true,
        ),
        (
            "a member reads not another's private tree",
            &bo,
            Operation::TreeRead,
            tree(thread("t_mine")),
            false,
        ),
        (
            "an org owner reads not a private tree",
            &org_owner,
            Operation::TreeRead,
            tree(thread("t_mine")),
            false,
        ),
        (
            "the owner reads their own private tree",
            &ann,
            Operation::TreeRead,
            tree(thread("t_mine")),
            true,
        ),
        (
            "the owner reads it through a child",
            &ann,
            Operation::TreeRead,
            tree(thread("t_mine_child")),
            true,
        ),
        (
            "only the owner writes into an org tree",
            &bo,
            Operation::TreeWrite,
            tree(thread("t_shared")),
            false,
        ),
        (
            "the owner writes into their tree",
            &ann,
            Operation::TreeWrite,
            tree(thread("t_shared")),
            true,
        ),
        (
            "an org owner may stop any tree",
            &org_owner,
            Operation::TreeStop,
            tree(thread("t_theirs")),
            true,
        ),
        (
            "a member may not stop another's tree",
            &ann,
            Operation::TreeStop,
            tree(thread("t_theirs")),
            false,
        ),
        (
            "a tree with no access row is nobody's",
            &ann,
            Operation::TreeRead,
            tree(thread("t_bare")),
            false,
        ),
        (
            "a list names no tree",
            &bo,
            Operation::TreeRead,
            unplaced(),
            false,
        ),
        (
            "a member reads a list filtered to what they may read",
            &bo,
            Operation::TreeRead,
            filtered(),
            true,
        ),
        (
            "a filtered list changes nothing",
            &bo,
            Operation::TreeWrite,
            filtered(),
            false,
        ),
        (
            "the operator reads no filtered list",
            &operator,
            Operation::TreeRead,
            filtered(),
            false,
        ),
        (
            "an agent reads no filtered list",
            &anns_agent,
            Operation::TreeRead,
            filtered(),
            false,
        ),
        (
            "an admission reads no filtered list",
            &admitted,
            Operation::TreeRead,
            filtered(),
            false,
        ),
        (
            "an interaction can't be placed yet",
            &ann,
            Operation::TreeWrite,
            tree(TreeRef::Interaction("i_1".to_owned())),
            false,
        ),
        (
            "members start no tree yet",
            &ann,
            Operation::TreeCreate,
            host(),
            false,
        ),
        (
            "a member reaches Spade",
            &bo,
            Operation::Spade,
            host(),
            true,
        ),
        (
            "a member runs nothing of the daemon",
            &bo,
            Operation::HostAdmin,
            host(),
            false,
        ),
        (
            "an org owner uses the host's shell",
            &org_owner,
            Operation::HostShell,
            host(),
            true,
        ),
        ("a member doesn't", &bo, Operation::HostShell, host(), false),
        (
            "computer use is refused even to an org owner",
            &org_owner,
            Operation::Computer,
            host(),
            false,
        ),
        (
            "fleet links are refused even to an org owner",
            &org_owner,
            Operation::FleetLink,
            host(),
            false,
        ),
        (
            "transfers are refused",
            &ann,
            Operation::Transfer,
            tree(thread("t_mine")),
            false,
        ),
        // Agents: their own tree, and at most their owner's rights elsewhere.
        (
            "an agent writes into its own tree",
            &anns_agent,
            Operation::TreeWrite,
            tree(TreeRef::Root("t_mine".to_owned())),
            true,
        ),
        (
            "through a child of it",
            &anns_agent,
            Operation::TreeWrite,
            tree(thread("t_mine_child")),
            true,
        ),
        (
            "an agent reads an org tree",
            &bos_agent,
            Operation::TreeRead,
            tree(thread("t_shared")),
            true,
        ),
        (
            "an agent writes only into its owner's trees",
            &bos_agent,
            Operation::TreeWrite,
            tree(thread("t_shared")),
            false,
        ),
        (
            "Ann's agent writes into Ann's other tree",
            &anns_agent,
            Operation::TreeWrite,
            tree(thread("t_shared")),
            true,
        ),
        (
            "an agent reads not another's private tree",
            &bos_agent,
            Operation::TreeRead,
            tree(thread("t_mine")),
            false,
        ),
        (
            "an agent answers no Spade",
            &anns_agent,
            Operation::Spade,
            host(),
            false,
        ),
        (
            "an agent makes no fleet link",
            &anns_agent,
            Operation::FleetLink,
            host(),
            false,
        ),
        // Peers: exactly one child.
        (
            "a peer calls its child",
            &peer_mine,
            Operation::FleetChild,
            tree(thread("t_mine")),
            true,
        ),
        (
            "a peer's capability refuses another child",
            &peer_mine,
            Operation::FleetChild,
            tree(thread("t_shared")),
            false,
        ),
        (
            "a peer reads no tree",
            &peer_mine,
            Operation::TreeRead,
            tree(thread("t_mine")),
            false,
        ),
    ];
    for (name, who, operation, resource, expected) in cases {
        assert_eq!(
            decide(who, Some(operation), &resource, &filled()).allowed(),
            expected,
            "{name}"
        );
    }
}

#[test]
fn refuses_every_member_request_on_a_tree_until_the_access_table_places_it() {
    for operation in [
        Operation::TreeRead,
        Operation::TreeWrite,
        Operation::TreeStop,
    ] {
        for who in [
            member("ann", "member"),
            member("bo", "member"),
            member("olu", "owner"),
        ] {
            assert!(!allowed_in(&who, Some(operation), &tree(thread("t_mine"))));
        }
    }
    let anns_agent = Principal::Agent {
        root: "t_mine".to_owned(),
    };
    assert!(allowed_in(
        &anns_agent,
        Some(Operation::TreeWrite),
        &tree(thread("t_mine"))
    ));
    assert!(!allowed_in(
        &anns_agent,
        Some(Operation::TreeRead),
        &tree(thread("t_shared"))
    ));
}
