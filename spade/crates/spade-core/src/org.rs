//! Organizations on an org host (ADR 0206 §2–§4): who a member is, the space a bot belongs to,
//! a shared bot's access list, the organization's policy as a ceiling in the gate, and the host's
//! hash-chained audit log. Pure: the server brings the facts (the verified policy, the member a
//! stamp proved, the stored chain).

use serde::{Deserialize, Serialize};

pub mod access;
pub mod audit;
pub mod gate;
pub mod policy;

pub use access::{Access, Right};
pub use gate::Gate;
pub use policy::Policy;

/// A member's role in their organization, as ace authorizes it (ADR 0206 §1.2): from the role
/// slug WorkOS gave, through ace's own table. A slug ace doesn't know (an organization's own
/// `org…` role, `billing`) authorizes as `member`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Owner,
    Admin,
    Member,
}

impl Role {
    pub fn parse(slug: &str) -> Self {
        match slug.trim() {
            "owner" => Self::Owner,
            "admin" => Self::Admin,
            _ => Self::Member,
        }
    }

    /// Owners and admins: `bots:manage`, `policy:set`, `hosts:manage`.
    pub fn admin(self) -> bool {
        matches!(self, Self::Owner | Self::Admin)
    }
}

/// A member as a stamp from ace's daemon proved them: their account and the role slug their
/// member grant carried, kept as given (lenient) and authorized through [`Role::parse`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Member {
    pub account: String,
    /// The role slug, as WorkOS gave it.
    pub role: String,
    /// Their name, for the record; never authorizes anything.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl Member {
    pub fn role(&self) -> Role {
        Role::parse(&self.role)
    }
}

/// Whose a bot is: the person's own (on any machine, an org host's earlier bots too), or one
/// organization's (a shared bot). Clubs, contracts and moves stay inside one space (§2.3, §8).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Space {
    Personal,
    Org(String),
}

impl Space {
    pub fn of(org: Option<&str>) -> Self {
        org.map_or(Self::Personal, |org| Self::Org(org.to_owned()))
    }
}

/// Why a club, a contract call or a move that would cross spaces is refused, if it would.
pub fn crossing(from: &Space, to: &Space, what: Crossing) -> Option<&'static str> {
    if from == to {
        return None;
    }
    Some(match what {
        Crossing::Club => {
            "A club stays inside one space: a shared bot's club takes only its organization's \
             shared bots, and a person's club only their own bots."
        }
        Crossing::Contract => {
            "Contracts are called only inside one space: a shared bot calls its organization's \
             shared bots, a personal bot the person's own."
        }
        Crossing::Move => {
            "A shared bot moves only between its organization's hosts, and a personal bot never \
             onto one."
        }
    })
}

/// What would cross spaces.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Crossing {
    Club,
    Contract,
    Move,
}

#[cfg(test)]
mod tests;
