// SPDX-License-Identifier: Apache-2.0
//! The one access policy (ADR 0209 §4.2), ported from `org-access/decide.ts` and
//! `@ace/account-grant`'s `org-roles.ts`: `decide(principal, operation, resource)`, deny by
//! default. An operation it doesn't know, a resource it can't place or a principal it has no
//! rule for is refused. Pure: where trees sit is read through the injected resolver.

use super::principal::Principal;

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

/// What names something inside a tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TreeRef {
    Thread(String),
    Interaction(String),
    Task(String),
    /// A handle bound to its root when it was made: never re-derived from a later id.
    Root(String),
}

/// Who may reach a tree through ace (ADR 0209 §5.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Visibility {
    Org,
    Members,
    Private,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeAccess {
    pub owner: String,
    pub visibility: Visibility,
    /// For `members`: the accounts it is shared with.
    pub readers: Vec<String>,
}

impl TreeAccess {
    pub fn private(owner: impl Into<String>) -> Self {
        Self {
            owner: owner.into(),
            visibility: Visibility::Private,
            readers: Vec::new(),
        }
    }
}

/// Where a resource sits, and who may reach its tree.
pub trait TreeResolver {
    /// The root of the tree `reference` is in, or `None` when it can't be placed.
    fn root(&self, reference: &TreeRef) -> Option<String>;
    /// That root's owner and visibility, or `None` when it has none a member can hold.
    fn access(&self, root: &str) -> Option<TreeAccess>;
}

/// How a thread in a delegation tree finds its root.
type RootOf = Box<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// Part A's resolver: places threads by their delegation tree and handles by their bound root,
/// and knows no tree's access, so every member request on a tree is refused.
pub struct StructuralTrees {
    root_of: RootOf,
}

impl StructuralTrees {
    pub fn new(root_of: impl Fn(&str) -> Option<String> + Send + Sync + 'static) -> Self {
        Self {
            root_of: Box::new(root_of),
        }
    }
}

impl TreeResolver for StructuralTrees {
    fn root(&self, reference: &TreeRef) -> Option<String> {
        match reference {
            TreeRef::Root(root) => Some(root.clone()),
            TreeRef::Thread(thread) => {
                Some((self.root_of)(thread).unwrap_or_else(|| thread.clone()))
            }
            TreeRef::Interaction(_) | TreeRef::Task(_) => None,
        }
    }

    fn access(&self, _root: &str) -> Option<TreeAccess> {
        None
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

/// The permissions the policy reads (`org-roles.ts:9`–`:24`); the rest of the table is data for
/// the account backend, kept here so a role authorizes as the backend does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum OrgPermission {
    BotsUse,
    BotsCreate,
    MembersManage,
    PolicySet,
    HostsManage,
    BotsManage,
    RegistryPublish,
    AuditRead,
    SsoManage,
    OrgDelete,
    OrgOwners,
    RegistryKey,
    AuditRetention,
    HostShell,
    BillingManage,
}

/// The role a WorkOS role slug acts as; an unknown slug acts as `member`.
pub fn org_role(slug: &str) -> &'static str {
    match slug {
        "owner" => "owner",
        "admin" => "admin",
        "billing" => "billing",
        _ => "member",
    }
}

/// Whether a role slug may do `permission`.
pub fn org_allows(slug: &str, permission: OrgPermission) -> bool {
    use OrgPermission::*;
    let member = [BotsUse, BotsCreate];
    let admin = [
        BotsUse,
        BotsCreate,
        MembersManage,
        PolicySet,
        HostsManage,
        BotsManage,
        RegistryPublish,
        AuditRead,
        SsoManage,
    ];
    let allowed: &[OrgPermission] = match org_role(slug) {
        "owner" => &[
            BotsUse,
            BotsCreate,
            MembersManage,
            PolicySet,
            HostsManage,
            BotsManage,
            RegistryPublish,
            AuditRead,
            SsoManage,
            OrgDelete,
            OrgOwners,
            RegistryKey,
            AuditRetention,
            HostShell,
        ],
        "admin" => &admin,
        "billing" => &[BillingManage, AuditRead],
        _ => &member,
    };
    allowed.contains(&permission)
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
mod tests {
    //! Ports `apps/daemon/src/org-access/decide.test.ts`, including its catch-up feed cases from
    //! `socketOperation`/`socketResource`.

    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use std::collections::HashMap;

    use super::{
        Operation, Resource, StructuralTrees, TreeAccess, TreeRef, TreeResolver, Visibility,
        decide, filtered, host, tree, unplaced,
    };
    use crate::devices::Member;
    use crate::org::principal::{ChildCapability, Principal, PrincipalFacts, principal};
    use crate::org::socket::{socket_operation, socket_resource};

    const ORG: &str = "org_acme";

    fn thread(id: &str) -> TreeRef {
        TreeRef::Thread(id.to_owned())
    }

    /// A resolver as the access table will fill it: Ann owns two trees, Bo one private one.
    struct FilledTrees {
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

    fn filled() -> FilledTrees {
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

    fn part_a() -> StructuralTrees {
        StructuralTrees::new(|_| None)
    }

    fn member(account: &str, role: &str) -> Principal {
        Principal::Member {
            org: ORG.to_owned(),
            account: account.to_owned(),
            role: role.to_owned(),
        }
    }

    fn peer(child: &str) -> Principal {
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

    fn allowed(who: &Principal, operation: Option<Operation>, resource: &Resource) -> bool {
        decide(who, operation, resource, &filled()).allowed()
    }

    fn allowed_in(who: &Principal, operation: Option<Operation>, resource: &Resource) -> bool {
        decide(who, operation, resource, &part_a()).allowed()
    }

    #[test]
    fn who_a_request_is_on_an_org_host() {
        let member_facts = || Member {
            org: ORG.to_owned(),
            account: "ann".to_owned(),
            role: "member".to_owned(),
        };
        fn facts(build: impl FnOnce(&mut PrincipalFacts)) -> Principal {
            let mut facts = PrincipalFacts {
                org: Some(ORG.to_owned()),
                ..Default::default()
            };
            build(&mut facts);
            principal(&facts)
        }
        assert_eq!(
            principal(&PrincipalFacts {
                org: None,
                proven: Some(member_facts()),
                admitted: Some(member_facts()),
                ..Default::default()
            })
            .kind(),
            "personal"
        );
        assert_eq!(
            facts(|each| {
                each.admitted = Some(member_facts());
                each.proven = Some(member_facts());
            })
            .kind(),
            "member"
        );
        assert_eq!(
            facts(|each| each.admitted = Some(member_facts())).kind(),
            "admitted"
        );
        assert_eq!(
            facts(|each| {
                each.admitted = Some(member_facts());
                each.proven = Some(Member {
                    account: "bo".to_owned(),
                    ..member_facts()
                });
            })
            .kind(),
            "admitted"
        );
        assert_eq!(
            facts(|each| {
                each.admitted = Some(member_facts());
                each.proven = Some(Member {
                    org: "org_other".to_owned(),
                    ..member_facts()
                });
            })
            .kind(),
            "admitted"
        );
        assert_eq!(facts(|each| each.host_token = true).kind(), "host");
        assert_eq!(
            facts(|each| {
                each.host_token = true;
                each.proven = Some(member_facts());
            })
            .kind(),
            "member"
        );
        assert_eq!(
            facts(|each| each.proven = Some(member_facts())).kind(),
            "unproven"
        );
        assert_eq!(
            facts(|each| each.agent_root = Some("t_mine".to_owned())).kind(),
            "agent"
        );
        assert_eq!(facts(|_| {}).kind(), "unproven");
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

    #[test]
    fn a_members_catch_up_feed_is_let_through_and_other_lists_are_not() {
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
}
