//! Spade on an org host (ADR 0206 §2–§4): the organization this Spade belongs to, the policy it
//! applied, its shared bots and their access lists. A shared bot's approvers are its person:
//! its answers, grants, access changes and raises take a member's stamp, checked here against
//! its list, never a person's.

mod audit;
mod steps;

pub use audit::MEMBER_BY;

use serde_json::{Value, json};
use spade_core::org::policy::ModelPlace;
use spade_core::org::{Access, Member, Policy, Right, Space};
use spade_store::StoreError;

use super::Engine;
use crate::org::{self, Applied, Binding, Offered, statement};

/// Why an org change isn't made.
#[derive(Debug, thiserror::Error)]
pub enum OrgError {
    #[error("this Spade doesn't belong to an organization")]
    NotBound,
    #[error("only the machine's owner can give it to an organization or let it go: do it in ace")]
    PersonOnly,
    #[error("{0}")]
    MemberOnly(&'static str),
    #[error("{0}")]
    Refused(String),
    #[error("{0}")]
    Invalid(String),
    #[error("there is no such bot")]
    NotFound,
    #[error(transparent)]
    Policy(#[from] statement::Refused),
    #[error(transparent)]
    Store(#[from] StoreError),
}

/// What a request without a member's stamp, or with another's, is told.
pub const MEMBER_ONLY: &str =
    "A shared bot takes this only from a member who holds that right on it, through ace.";

/// What an answer from someone who isn't one of a shared bot's approvers is told.
pub const NO_PLUGIN_OUTSIDE: &str = "A shared bot's plugins run only in the sandbox.";
pub const NOT_APPROVER: &str = "Only this shared bot's approvers answer its requests.";
/// What an approver whose role the policy doesn't let run commands outside is told.
pub const OUTSIDE_NOT_YOURS: &str =
    "Your organization lets only admins let a shared bot's commands run outside the sandbox.";

/// The ceiling a shared bot of an organization this host no longer belongs to is held to:
/// nothing outward, nothing outside the sandbox.
const ORPHANED: &str = r#"{"effects": {"network_without_hosts": "off", "publish": "off",
    "send_as_person": "off", "pay": "off", "change_access": "off"},
    "commands_outside_sandbox": "never"}"#;

impl Engine {
    /// The organization this Spade belongs to, if it does.
    pub fn org_binding(&self) -> Option<Binding> {
        let text = self.store.setting(org::BINDING).ok()??;
        serde_json::from_str(&text).ok()
    }

    /// Gives this Spade to an organization, with the person's stamp (target `org`, value the
    /// org's id) from ace's daemon, as the machine itself is given to it (ADR 0206 §2.1). Makes
    /// the host's audit key, kept in its keychain; answers its public half for enrollment. A
    /// Spade already given to another organization is let go first.
    pub fn bind_org(&self, binding: Binding, stamp: Option<&str>) -> Result<Value, OrgError> {
        let binding = binding
            .checked()
            .map_err(|why| OrgError::Invalid(why.to_owned()))?;
        if let Some(held) = self.org_binding()
            && held.org != binding.org
        {
            return Err(OrgError::Refused(format!(
                "This Spade belongs to {}; let it go first.",
                held.name
            )));
        }
        let says = self
            .security()
            .is_some_and(|s| s.person_says(stamp, org::BIND_TARGET, &binding.org));
        if !says {
            return Err(OrgError::PersonOnly);
        }
        let text = serde_json::to_string(&binding).map_err(|e| OrgError::Invalid(e.to_string()))?;
        self.store.set_setting(org::BINDING, Some(&text))?;
        Ok(self.org_view())
    }

    /// Lets this Spade go from its organization, with the person's stamp (value `none`). Its
    /// shared bots stay, held to nothing outward, and stay the organization's; nothing is
    /// deleted.
    pub fn unbind_org(&self, stamp: Option<&str>) -> Result<(), OrgError> {
        if self.org_binding().is_none() {
            return Err(OrgError::NotBound);
        }
        let says = self
            .security()
            .is_some_and(|s| s.person_says(stamp, org::BIND_TARGET, org::UNBOUND));
        if !says {
            return Err(OrgError::PersonOnly);
        }
        self.store
            .set_settings(&[(org::BINDING, None), (org::POLICY, None)])?;
        Ok(())
    }

    /// `GET /v1/org`: the organization, the policy version applied and the audit key.
    pub fn org_view(&self) -> Value {
        let Some(binding) = self.org_binding() else {
            return json!({ "org": null });
        };
        let applied = self.applied_policy();
        let key = self.audit_key(&binding.org);
        json!({
            "org": binding.org,
            "name": binding.name,
            "host": binding.host,
            "policy": applied.as_ref().map_or(0, |a| a.version),
            "auditKey": key.as_ref().ok().map(org::signer::AuditKey::public),
            "auditKeyProblem": key.err(),
        })
    }

    fn applied_policy(&self) -> Option<Applied> {
        let text = self.store.setting(org::POLICY).ok()??;
        serde_json::from_str(&text).ok()
    }

    /// The policy this host holds now: the applied version's, or none of the organization's
    /// own yet (`{}`).
    pub(crate) fn org_policy(&self) -> Policy {
        self.applied_policy()
            .and_then(|applied| Policy::parse(&applied.body))
            .unwrap_or_default()
    }

    /// A policy version the daemon fetched from the backend (on connect, on a relay nudge, or
    /// seeing a higher one in a member grant): applied only when its statement verifies with the
    /// pinned grant keys, is over this exact body, names this organization, and is newer than
    /// the one held, so an old one can't be replayed. Answers the version held after.
    pub fn offer_policy(&self, offered: &Offered) -> Result<u64, OrgError> {
        let binding = self.org_binding().ok_or(OrgError::NotBound)?;
        let token = offered
            .statement
            .as_deref()
            .ok_or(statement::Refused::Malformed)?;
        let signed = statement::verify(token, &binding.keys, &offered.body, &binding.org)?;
        if signed.version != offered.version || offered.org != binding.org {
            return Err(statement::Refused::Malformed.into());
        }
        if Policy::parse(&offered.body).is_none() {
            return Err(OrgError::Invalid("That policy isn't one.".to_owned()));
        }
        let _held = self.agent_lock.lock().unwrap_or_else(|p| p.into_inner());
        let held = self.applied_policy().map_or(0, |a| a.version);
        if signed.version <= held {
            return Err(statement::Refused::NotNewer.into());
        }
        let applied = Applied {
            version: signed.version,
            body: offered.body.clone(),
            statement: token.to_owned(),
            set_by: signed.set_by,
            set_at: signed.set_at,
        };
        let text = serde_json::to_string(&applied).map_err(|e| OrgError::Invalid(e.to_string()))?;
        self.store.set_setting(org::POLICY, Some(&text))?;
        Ok(signed.version)
    }

    /// A shared bot's access list, if `agent` is one.
    pub fn shared_access(&self, agent: &str) -> Option<Access> {
        let text = self
            .store
            .setting(&format!("{}{agent}", org::SHARED))
            .ok()??;
        serde_json::from_str(&text).ok()
    }

    /// Whose the bot behind `conversation` is: a shared bot's organization when it, or a bot
    /// above it (a worker's maker, a helper's bot), is a shared bot.
    pub(crate) fn org_space(&self, conversation: &str) -> Space {
        let owner = self
            .helper_of(conversation)
            .map_or_else(|| conversation.to_owned(), |h| h.parent);
        let mut chain = vec![owner.clone()];
        chain.extend(self.worker_ancestors(&owner));
        for conversation in chain.iter().rev() {
            if let Some(agent) = self.agent_of(conversation)
                && let Some(access) = self.shared_access(&agent)
            {
                return Space::Org(access.org);
            }
        }
        Space::Personal
    }

    /// The lead of club `id`, if there is such a club.
    pub(crate) fn club_lead(&self, id: &str) -> Option<String> {
        self.store.group(id).ok()?.map(|group| group.lead_id)
    }

    /// The space bot `agent` is in.
    pub(crate) fn agent_space(&self, agent: &str) -> Space {
        match self.store.agent(agent) {
            Ok(Some(found)) => self.org_space(&found.conversation),
            _ => Space::Personal,
        }
    }

    /// The access list a call in `conversation` answers to: its shared bot's (the top one of
    /// its tree), with that bot's id.
    pub(crate) fn shared_over(&self, conversation: &str) -> Option<(String, Access)> {
        let owner = self
            .helper_of(conversation)
            .map_or_else(|| conversation.to_owned(), |h| h.parent);
        let mut chain = vec![owner.clone()];
        chain.extend(self.worker_ancestors(&owner));
        chain.iter().rev().find_map(|conversation| {
            let agent = self.agent_of(conversation)?;
            self.shared_access(&agent).map(|access| (agent, access))
        })
    }

    /// The organization's name and policy for a call in `conversation`, when its bot is shared:
    /// what `effect::route` holds it to (ADR 0206 §3). A shared bot of an organization this
    /// host no longer belongs to is held to nothing outward.
    pub(crate) fn org_gate(&self, conversation: &str) -> Option<(String, Policy)> {
        let Space::Org(org) = self.org_space(conversation) else {
            return None;
        };
        match self.org_binding() {
            Some(binding) if binding.org == org => Some((binding.name, self.org_policy())),
            _ => Some((
                "Its organization".to_owned(),
                Policy::parse(ORPHANED).unwrap_or_default(),
            )),
        }
    }

    /// Why a step of the bot behind `conversation` may not think with `model`, when it is a
    /// shared bot and its organization's policy doesn't allow where that model runs.
    pub(crate) fn org_model_refusal(
        &self,
        conversation: &str,
        model: &str,
    ) -> Option<&'static str> {
        let (_, policy) = self.org_gate(conversation)?;
        if model.starts_with(spade_core::brain::PREFIX) {
            return policy.model_refusal(ModelPlace::Subscription);
        }
        let endpoint = model
            .split_once('/')
            .map_or(model, |(endpoint, _)| endpoint);
        let base = self
            .store
            .endpoints()
            .ok()?
            .into_iter()
            .find(|e| e.id == endpoint)?
            .base_url;
        let host = host_of(&base);
        let local = matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]");
        policy.model_refusal(if local {
            ModelPlace::Local
        } else {
            ModelPlace::Endpoint(&host)
        })
    }

    /// Makes `agent`, just made by `member` on this org host, a shared bot of its organization:
    /// its maker approves and configures it, every member talks to it. A member who isn't an
    /// admin makes one only if the policy lets members make shared bots.
    pub fn share_new_bot(&self, agent: &str, member: &Member) -> Result<Access, OrgError> {
        let binding = self.org_binding().ok_or(OrgError::NotBound)?;
        if !member.role().admin() && !self.org_policy().members_create_bots() {
            return Err(OrgError::MemberOnly(
                "Your organization lets only admins make shared bots.",
            ));
        }
        if self.store.agent(agent)?.is_none() {
            return Err(OrgError::NotFound);
        }
        let access = Access::new(&binding.org, &member.account);
        let text = serde_json::to_string(&access).map_err(|e| OrgError::Invalid(e.to_string()))?;
        let entry = self.bot_entry("bot.created", agent, member, &[]);
        self.store.set_settings_audited(
            &[(&format!("{}{agent}", org::SHARED), Some(&text))],
            &[entry],
            self.now_ms(),
        )?;
        self.after_audit();
        Ok(access)
    }

    /// Whether `member` holds `right` on shared bot `agent` now.
    pub fn member_may(&self, agent: &str, member: &Member, right: Right) -> bool {
        self.shared_access(agent)
            .is_some_and(|access| access.may(member, right))
    }

    /// Changes a shared bot's access list, as `member` (who must configure it) asks; recorded as
    /// `bot.access_changed` in the same write, naming the rights changed, never the accounts.
    pub fn set_access(
        &self,
        agent: &str,
        member: &Member,
        talk: Option<Vec<String>>,
        approvers: Vec<String>,
        configurers: Vec<String>,
    ) -> Result<Access, OrgError> {
        let _held = self.agent_lock.lock().unwrap_or_else(|p| p.into_inner());
        let current = self.shared_access(agent).ok_or(OrgError::NotFound)?;
        if !current.may(member, Right::Configure) {
            return Err(OrgError::MemberOnly(MEMBER_ONLY));
        }
        let next = current
            .changed(talk, approvers, configurers)
            .map_err(|why| OrgError::Invalid(why.to_owned()))?;
        let touched = current.touched(&next);
        if touched.is_empty() {
            return Ok(next);
        }
        let text = serde_json::to_string(&next).map_err(|e| OrgError::Invalid(e.to_string()))?;
        let entry = self.bot_entry("bot.access_changed", agent, member, &touched);
        self.store.set_settings_audited(
            &[(&format!("{}{agent}", org::SHARED), Some(&text))],
            &[entry],
            self.now_ms(),
        )?;
        self.after_audit();
        Ok(next)
    }
}

/// The host a base URL names, in lower case: `https://API.example.com:8443/v1` is
/// `api.example.com`; an IPv6 address keeps its brackets.
fn host_of(base: &str) -> String {
    let rest = base.split_once("://").map_or(base, |(_, rest)| rest);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let authority = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    let host = if authority.starts_with('[') {
        authority.split_inclusive(']').next().unwrap_or(authority)
    } else {
        authority.split(':').next().unwrap_or(authority)
    };
    host.to_ascii_lowercase()
}
