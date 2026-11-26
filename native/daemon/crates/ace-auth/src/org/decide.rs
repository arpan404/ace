// SPDX-License-Identifier: Apache-2.0
//! The one access policy (ADR 0209 §4.2), ported from `org-access/decide.ts`:
//! `decide(principal, operation, resource)`, deny by default. An operation it doesn't know, a
//! resource it can't place or a principal it has no rule for is refused. Pure: where trees sit is
//! read through the injected resolver.

use super::principal::Principal;
use super::roles::{OrgPermission, org_allows};
use super::trees::{TreeAccess, TreeRef, TreeResolver, Visibility};

/// Every operation the policy knows; one a transport can't name is refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Operation {
    /// Keeping the connection: hello, ping, proving standing, refreshing a grant.
    Session,
    /// The daemon's own state, without member content: health, versions, updates.
    HostMeta,
    /// Running the daemon: its settings, provider sign-ins, machine code, packages.
    HostAdmin,
    /// The host's shell: its terminal and files outside trees.
    HostShell,
    /// Spade, where shared bots live; Spade checks each member's stamp itself.
    Spade,
    /// Reading a tree: its threads, transcript, diff, attachments, previews and fan-out.
    TreeRead,
    /// Anything that changes what a tree executes: the owner's alone.
    TreeWrite,
    /// Halting a tree without reading it.
    TreeStop,
    /// Starting a new tree on the host.
    TreeCreate,
    /// A call into a child this host runs for another host of the organization.
    FleetChild,
    /// Fleet links, the machine tunnel and parcels between machines.
    FleetLink,
    /// Moving a tree to or from another machine.
    Transfer,
    /// Making or redeeming a pairing link.
    Pairing,
    /// Computer use and simulators, refused for coding trees on org hosts.
    Computer,
}

impl Operation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::HostMeta => "host.meta",
            Self::HostAdmin => "host.admin",
            Self::HostShell => "host.shell",
            Self::Spade => "spade",
            Self::TreeRead => "tree.read",
            Self::TreeWrite => "tree.write",
            Self::TreeStop => "tree.stop",
            Self::TreeCreate => "tree.create",
            Self::FleetChild => "fleet.child",
            Self::FleetLink => "fleet.link",
            Self::Transfer => "transfer",
            Self::Pairing => "pairing",
            Self::Computer => "computer",
        }
    }
}

/// A resource a decision is about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resource {
    Host,
    Tree(TreeRef),
    /// A list across trees whose service keeps only what the socket may read.
    Filtered,
    Unplaced,
}

pub fn host() -> Resource {
    Resource::Host
}

pub fn filtered() -> Resource {
    Resource::Filtered
}

pub fn unplaced() -> Resource {
    Resource::Unplaced
}

pub fn tree(reference: TreeRef) -> Resource {
    Resource::Tree(reference)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Allowed,
    Denied { reason: &'static str },
}

impl Decision {
    pub fn allowed(self) -> bool {
        matches!(self, Self::Allowed)
    }

    pub fn reason(self) -> Option<&'static str> {
        match self {
            Self::Allowed => None,
            Self::Denied { reason } => Some(reason),
        }
    }
}

const ALLOW: Decision = Decision::Allowed;
const fn deny(reason: &'static str) -> Decision {
    Decision::Denied { reason }
}

/// Who may read a tree with this access. No role reads more.
fn reads(account: &str, access: &TreeAccess) -> bool {
    access.owner == account
        || access.visibility == Visibility::Org
        || (access.visibility == Visibility::Members
            && access.readers.iter().any(|reader| reader == account))
}

fn tree_operation(operation: Operation) -> bool {
    matches!(
        operation,
        Operation::TreeRead | Operation::TreeWrite | Operation::TreeStop
    )
}

/// What a member may do to a placed tree.
fn member_on_tree(
    operation: Operation,
    account: &str,
    role: &str,
    access: &TreeAccess,
) -> Decision {
    match operation {
        Operation::TreeRead => {
            if reads(account, access) {
                ALLOW
            } else {
                deny("not_shared")
            }
        }
        Operation::TreeWrite => {
            if access.owner == account {
                ALLOW
            } else {
                deny("not_owner")
            }
        }
        Operation::TreeStop => {
            if access.owner == account || org_allows(role, OrgPermission::HostShell) {
                ALLOW
            } else {
                deny("not_owner")
            }
        }
        _ => deny("unclassified"),
    }
}

/// Whether `principal` may do `operation` on `resource`, on this host. On a person's machine it
/// always allows.
pub fn decide(
    principal: &Principal,
    operation: Option<Operation>,
    resource: &Resource,
    trees: &dyn TreeResolver,
) -> Decision {
    if matches!(principal, Principal::Personal) {
        return ALLOW;
    }
    let Some(operation) = operation else {
        return deny("unclassified");
    };
    if operation == Operation::Session {
        return ALLOW;
    }
    match principal {
        Principal::Personal => ALLOW,
        Principal::Unproven | Principal::Admitted { .. } => deny("unproven"),
        Principal::Host => {
            if matches!(
                operation,
                Operation::HostMeta | Operation::HostAdmin | Operation::HostShell
            ) {
                ALLOW
            } else {
                deny("operator")
            }
        }
        Principal::Member { account, role, .. } => {
            if operation == Operation::Spade {
                return ALLOW;
            }
            if matches!(
                operation,
                Operation::HostMeta | Operation::HostAdmin | Operation::HostShell
            ) {
                return if org_allows(role, OrgPermission::HostShell) {
                    ALLOW
                } else {
                    deny("not_org_owner")
                };
            }
            if !tree_operation(operation) {
                return deny("refused_on_org_host");
            }
            // Each entry is decided as a placed read, so reading the list itself reveals nothing.
            if *resource == Resource::Filtered {
                return if operation == Operation::TreeRead {
                    ALLOW
                } else {
                    deny("unplaced")
                };
            }
            let Resource::Tree(reference) = resource else {
                return deny("unplaced");
            };
            let root = trees.root(reference);
            let Some(root) = root else {
                return deny("unplaced");
            };
            let Some(access) = trees.access(&root) else {
                return deny("unplaced");
            };
            member_on_tree(operation, account, role, &access)
        }
        Principal::Agent { root: own_root } => {
            // What the daemon offers every thread alike: models, the host's shared projects.
            if operation == Operation::HostMeta {
                return ALLOW;
            }
            if !tree_operation(operation) {
                return deny("refused_on_org_host");
            }
            let Resource::Tree(reference) = resource else {
                return deny("unplaced");
            };
            let Some(root) = trees.root(reference) else {
                return deny("unplaced");
            };
            // Its own tree, the one its bearer was minted for: bound, never re-derived.
            if root == *own_root {
                return ALLOW;
            }
            // Another tree: at most its owner's rights, and writes only into the owner's own trees.
            let own = trees.access(own_root);
            let access = trees.access(&root);
            let (Some(own), Some(access)) = (own, access) else {
                return deny("unplaced");
            };
            if operation == Operation::TreeRead {
                return if reads(&own.owner, &access) {
                    ALLOW
                } else {
                    deny("not_shared")
                };
            }
            if access.owner == own.owner {
                ALLOW
            } else {
                deny("not_owner")
            }
        }
        Principal::Peer { capability } => {
            // Exactly the one child its capability names, never another of that tree.
            if operation != Operation::FleetChild {
                return deny("refused_on_org_host");
            }
            let Resource::Tree(reference) = resource else {
                return deny("refused_on_org_host");
            };
            let target = match reference {
                TreeRef::Thread(thread) => Some(thread),
                TreeRef::Root(root) => Some(root),
                TreeRef::Interaction(_) | TreeRef::Task(_) => None,
            };
            if target == Some(&capability.child) {
                ALLOW
            } else {
                deny("other_child")
            }
        }
    }
}

#[cfg(test)]
mod table;
#[cfg(test)]
mod tests;
