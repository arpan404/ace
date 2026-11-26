// SPDX-License-Identifier: Apache-2.0
//! What each organization role may do (ADR 0206 §1.2, `@ace/account-grant`'s `org-roles.ts`).
//! Roles are WorkOS role slugs; ace authorizes from this table, and an unknown slug authorizes as
//! `member`.

/// The permissions the policy reads (`org-roles.ts:9`-`:24`).
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
