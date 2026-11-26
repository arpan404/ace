// SPDX-License-Identifier: Apache-2.0
//! Who is acting on an organization's host (ADR 0209 §3), ported from
//! `org-access/principal.ts`: admission is not identity, so a member counts only with a standing
//! proven on this socket for the account it was admitted as.

use crate::devices::Member;

/// A fleet child capability the destination verified (ADR 0209 §6.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChildCapability {
    pub org: String,
    /// The parent host it came from.
    pub from: String,
    pub root: String,
    pub owner: String,
    pub child: String,
}

/// Who a socket or request is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Principal {
    /// Not an org host: the policy steps aside and today's rules decide.
    Personal,
    /// A member grant at admission and a standing proven here under the current owner.
    Member {
        org: String,
        account: String,
        role: String,
    },
    /// The daemon's own token: the host's operator. Metadata only; owns and answers nothing.
    Host,
    /// An ace MCP bearer, bound to one tree when it was minted.
    Agent { root: String },
    /// A fleet call from another host of the organization, on a verified child capability.
    Peer { capability: ChildCapability },
    /// A member grant whose standing isn't proven on this socket, or has lapsed.
    Admitted { org: String, account: String },
    /// Nothing this host recognises as anyone: an old paired device, an unknown bearer.
    Unproven,
}

impl Principal {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Personal => "personal",
            Self::Member { .. } => "member",
            Self::Host => "host",
            Self::Agent { .. } => "agent",
            Self::Peer { .. } => "peer",
            Self::Admitted { .. } => "admitted",
            Self::Unproven => "unproven",
        }
    }
}

/// What a transport knows about its caller when it asks.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PrincipalFacts {
    /// The organization that owns this machine; `None` on a person's machine.
    pub org: Option<String>,
    /// It authenticated with the daemon's own token (a loopback socket or an HTTP bearer).
    pub host_token: bool,
    /// The member its hello's grant admitted, if any.
    pub admitted: Option<Member>,
    /// The member whose standing is proven and current on this very socket or request.
    pub proven: Option<Member>,
    /// The tree an ace MCP bearer was minted for.
    pub agent_root: Option<String>,
    /// A child capability the destination already verified against its roster and fleet keys.
    pub capability: Option<ChildCapability>,
}

/// The one rule (ADR 0209 §3): a member counts only with a standing proven on this socket for
/// the account it was admitted as; the host's own token proving a member becomes that member.
pub fn principal(facts: &PrincipalFacts) -> Principal {
    let Some(org) = facts.org.as_deref() else {
        return Principal::Personal;
    };
    let proven = facts.proven.as_ref().filter(|member| member.org == org);
    let admitted = facts.admitted.as_ref().filter(|member| member.org == org);
    if let Some(proven) = proven {
        let same_account = match admitted {
            Some(admitted) => admitted.account == proven.account,
            None => facts.host_token,
        };
        if same_account {
            return Principal::Member {
                org: org.to_owned(),
                account: proven.account.clone(),
                role: proven.role.clone(),
            };
        }
    }
    if let Some(root) = &facts.agent_root {
        return Principal::Agent { root: root.clone() };
    }
    if let Some(capability) = &facts.capability
        && capability.org == org
    {
        return Principal::Peer {
            capability: capability.clone(),
        };
    }
    if facts.host_token {
        return Principal::Host;
    }
    if let Some(admitted) = admitted {
        return Principal::Admitted {
            org: org.to_owned(),
            account: admitted.account.clone(),
        };
    }
    Principal::Unproven
}
