//! Spade on an org host (ADR 0206): what binds this Spade to an organization, the policy it
//! applied, the audit key that signs its log, and exporting and verifying that log. The engine
//! keeps the rest (`engine::org`): shared bots, their gate and their entries.

pub mod acting;
pub mod export;
pub mod signer;
pub mod statement;

use serde::{Deserialize, Serialize};

pub use statement::GrantKey;

/// Settings: this host's organization, and the policy version it applied.
pub const BINDING: &str = "org";
pub const POLICY: &str = "org_policy";
/// Settings, per bot: a shared bot's access list (`org_bot:<agent id>`); it moves with the bot.
pub const SHARED: &str = "org_bot:";

/// What the person's stamp signs when this Spade is given to an organization (`org`, the
/// org's id) or let go (`none`).
pub const BIND_TARGET: &str = "org";
pub const UNBOUND: &str = "none";

/// The organization this host belongs to, as ace's daemon passed it on with the person's
/// stamp when the machine was given to it (ADR 0206 §2.1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Binding {
    /// The organization's id (WorkOS's, `org_…`).
    pub org: String,
    /// Its name, for what Spade says ("Acme doesn't allow paying.").
    pub name: String,
    /// The ace host id of this machine, as the checkpoints name it.
    pub host: String,
    /// The account backend's grant keys the policy is verified with.
    pub keys: Vec<GrantKey>,
}

impl Binding {
    /// A binding from outside, checked: an org id, a name and host of one plain line, and one
    /// to eight keys.
    pub fn checked(self) -> Result<Self, &'static str> {
        let plain = |text: &str, most: usize| {
            !text.trim().is_empty() && text.len() <= most && !text.chars().any(char::is_control)
        };
        let org_ok = self.org.strip_prefix("org_").is_some_and(|rest| {
            !rest.is_empty() && rest.len() <= 64 && rest.bytes().all(|b| b.is_ascii_alphanumeric())
        });
        if !org_ok {
            return Err("An organization is named by its id, org_….");
        }
        if !plain(&self.name, 128) || !plain(&self.host, 128) {
            return Err("An organization's name and this host's id are one short line each.");
        }
        if self.keys.is_empty() || self.keys.len() > 8 {
            return Err("A binding carries the backend's one to eight grant keys.");
        }
        Ok(self)
    }
}

/// The policy version this host applied: its exact body and the statement it was verified with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Applied {
    pub version: u64,
    pub body: String,
    pub statement: String,
    pub set_by: String,
    pub set_at: u64,
}

/// One policy version as the backend serves it (`AceOrgPolicyVersion`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Offered {
    pub org: String,
    pub version: u64,
    pub body: String,
    #[serde(default)]
    pub statement: Option<String>,
}
