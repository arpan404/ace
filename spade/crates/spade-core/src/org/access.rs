//! A shared bot's access list (ADR 0206 §2.3): who may talk to it, answer its requests,
//! configure it and move it. A shared bot's approvers are its person: every answer is theirs,
//! and the list always names at least one.

use serde::{Deserialize, Serialize};

use super::{Member, Role};

/// What a member may do with a shared bot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Right {
    /// Message it, read its chat, cards and panels, `@` it in a club of the same organization.
    Talk,
    /// Answer its raised requests.
    Approve,
    /// Its grants, switches, routines, model route and this list.
    Configure,
    /// Move it between the organization's hosts.
    Move,
}

impl Right {
    pub fn parse(word: &str) -> Option<Self> {
        match word {
            "talk" => Some(Self::Talk),
            "approve" => Some(Self::Approve),
            "configure" => Some(Self::Configure),
            "move" => Some(Self::Move),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Talk => "talk",
            Self::Approve => "approve",
            Self::Configure => "configure",
            Self::Move => "move",
        }
    }
}

/// A shared bot's record: its organization, who made it, and its rights.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Access {
    pub org: String,
    /// The member who made it, by account. Their leaving changes nothing: it is the
    /// organization's.
    pub maker: String,
    /// Who may talk to it: `None` for every member, else these accounts (with its approvers and
    /// configurers, who must read what they answer and configure).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub talk: Option<Vec<String>>,
    /// Who answers its requests: never empty.
    pub approvers: Vec<String>,
    /// Who configures it besides its maker and the organization's admins.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub configurers: Vec<String>,
}

/// Why a new list isn't taken.
pub const NO_APPROVER: &str = "A shared bot always has at least one approver.";

/// The most accounts one right names.
pub const MOST_NAMED: usize = 200;

impl Access {
    /// A new shared bot's list: its maker approves and configures it; every member talks to it.
    pub fn new(org: &str, maker: &str) -> Self {
        Self {
            org: org.to_owned(),
            maker: maker.to_owned(),
            talk: None,
            approvers: vec![maker.to_owned()],
            configurers: Vec::new(),
        }
    }

    /// Whether `member` holds `right` on this bot. Approving is only ever by name: no role
    /// approves for a bot that doesn't name it. Moving is the organization's admins'.
    pub fn may(&self, member: &Member, right: Right) -> bool {
        let account = member.account.as_str();
        let named = |list: &[String]| list.iter().any(|named| named == account);
        let configures = account == self.maker || member.role().admin() || named(&self.configurers);
        match right {
            Right::Approve => named(&self.approvers),
            Right::Configure => configures,
            Right::Move => member.role() == Role::Owner || member.role() == Role::Admin,
            Right::Talk => {
                configures
                    || named(&self.approvers)
                    || self.talk.as_ref().is_none_or(|talk| named(talk))
            }
        }
    }

    /// The list a change asks for, checked: the same organization and maker, at least one
    /// approver, each account named once and plainly. Spade keeps the maker and the org; a
    /// change names only the rights.
    pub fn changed(
        &self,
        talk: Option<Vec<String>>,
        approvers: Vec<String>,
        configurers: Vec<String>,
    ) -> Result<Self, &'static str> {
        let tidy = |list: Vec<String>| -> Result<Vec<String>, &'static str> {
            let mut out: Vec<String> = Vec::with_capacity(list.len());
            for account in list {
                let account = account.trim().to_owned();
                if !plain_account(&account) {
                    return Err("An access list names members by their account id.");
                }
                if !out.contains(&account) {
                    out.push(account);
                }
            }
            if out.len() > MOST_NAMED {
                return Err("An access list names at most 200 members per right.");
            }
            Ok(out)
        };
        let approvers = tidy(approvers)?;
        if approvers.is_empty() {
            return Err(NO_APPROVER);
        }
        Ok(Self {
            org: self.org.clone(),
            maker: self.maker.clone(),
            talk: talk.map(tidy).transpose()?,
            approvers,
            configurers: tidy(configurers)?,
        })
    }

    /// The names of the rights a change from `self` to `new` touched, for the audit entry
    /// (names, never the accounts themselves).
    pub fn touched(&self, new: &Self) -> Vec<&'static str> {
        let mut changed = Vec::new();
        if self.talk != new.talk {
            changed.push("talk");
        }
        if self.approvers != new.approvers {
            changed.push("approvers");
        }
        if self.configurers != new.configurers {
            changed.push("configurers");
        }
        changed
    }
}

/// An account id as ace's backend gives one (`user_…`): letters, digits, `_` and `-`.
pub fn plain_account(account: &str) -> bool {
    !account.is_empty()
        && account.len() <= 128
        && account
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
