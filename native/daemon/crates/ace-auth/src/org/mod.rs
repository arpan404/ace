// SPDX-License-Identifier: Apache-2.0
//! An organization host's standing checks (ADR 0206, ADR 0209; behaviour.md §6's last bullet):
//! the principal a socket speaks for, the one access policy, the live handles and queued effects
//! it closes, and the socket operations each message type asks for. Admission and revalidation
//! both ask the same pure `decide`.

pub mod decide;
pub mod handles;
pub mod operations;
pub mod principal;
pub mod roles;
pub mod socket;
pub mod trees;

pub use decide::{Decision, Operation, Resource, decide, filtered, host, tree, unplaced};
pub use handles::{BoundHandle, Handles, holder_key, run_if_still_allowed};
pub use operations::{channel_operation, socket_operation, socket_resource};
pub use principal::{ChildCapability, Principal, PrincipalFacts, principal};
pub use roles::{OrgPermission, org_allows, org_role};
pub use socket::{Refusal, SocketFacts, SocketGate, SocketPolicy, refusal_message};
pub use trees::{StructuralTrees, TreeAccess, TreeRef, TreeResolver, Visibility};
