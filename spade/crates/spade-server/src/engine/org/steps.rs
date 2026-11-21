//! A bot's package steps on an org host, on its record (ADR 0206 §4.1): whichever path writes a
//! bot's package link (an install finishing, an update or rollback landing, a switch, a pause,
//! the bot's deletion), the store writes the entry with it, in the same transaction.

use spade_core::effect::Effect;
use spade_core::org::Right;
use spade_core::org::audit::{Entry, Ref};
use spade_core::org::policy::{Package, Source};
use spade_core::org::steps::{Actor, Stepped, link_entries};
use spade_core::package::link::{Link, PackageId};

use super::super::Engine;
use crate::org::{self, Binding};

impl Engine {
    /// Watches every bot's package link `store` writes for what it records, from Spade's start.
    pub(crate) fn watch_package_links(&self, store: &spade_store::Store) {
        let clock = self.clock.clone();
        let prefix = format!("{}:", spade_store::BOT_PACKAGE);
        store.watch_settings(
            &prefix,
            &[org::BINDING],
            Box::new(move |watched| {
                // Only an org host keeps a log.
                let Some(binding) = watched
                    .read
                    .first()
                    .and_then(Option::as_deref)
                    .and_then(|text| serde_json::from_str::<Binding>(text).ok())
                else {
                    return Vec::new();
                };
                let link =
                    |text: Option<&str>| text.and_then(|t| serde_json::from_str::<Link>(t).ok());
                let (before, after) = (link(watched.before.as_deref()), link(watched.after));
                let actor = org::acting::current().unwrap_or(Actor::Host(binding.host));
                link_entries(
                    before.as_ref(),
                    after.as_ref(),
                    &Stepped {
                        bot: watched.id,
                        name: watched.agent_name.as_deref().unwrap_or(""),
                        actor: &actor,
                        at: clock.now_ms(),
                    },
                )
            }),
        );
    }

    /// `bot.deleted` for shared bot `agent`, as whoever is acting deletes it; nothing for any
    /// other bot.
    pub(crate) fn deleted_entries(&self, agent: &str) -> Vec<Entry> {
        let (Some(binding), Some(_)) = (self.org_binding(), self.shared_access(agent)) else {
            return Vec::new();
        };
        let name = self
            .store
            .agent(agent)
            .ok()
            .flatten()
            .map(|a| a.name)
            .unwrap_or_default();
        let actor = org::acting::current().unwrap_or(Actor::Host(binding.host));
        let mut entry = Entry::new(
            "bot.deleted",
            self.now_ms(),
            actor.reference(),
            vec![Ref::new("bot", agent).named(&name)],
        );
        if let Actor::Member(member) = &actor {
            entry = entry.with("role", member.role.as_str());
        }
        vec![entry]
    }

    /// `bot.configured` for shared bot `agent`, as `member` changed `changed` (names, never
    /// values).
    pub fn org_configured(
        &self,
        agent: &str,
        member: &spade_core::org::Member,
        changed: &str,
    ) -> Result<(), spade_store::StoreError> {
        let entry = self.bot_entry("bot.configured", agent, member, &[changed]);
        self.org_record(&[entry]).map(|_| ())
    }

    /// `bot.moved` for each shared bot move `held` carries, now that the machine it went to holds
    /// it (`kept` is the move's record): who asked, and where it went.
    pub(crate) fn moved_entries(
        &self,
        held: &spade_store::StoredMove,
        kept: &serde_json::Value,
    ) -> Vec<Entry> {
        let Some(binding) = self.org_binding() else {
            return Vec::new();
        };
        let actor = serde_json::from_value::<spade_core::org::Member>(kept["by"].clone())
            .map_or(Actor::Host(binding.host.clone()), Actor::Member);
        let agents: Vec<String> = kept["agents"]
            .as_array()
            .map(|agents| {
                agents
                    .iter()
                    .filter_map(|a| a.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_else(|| vec![held.agent_id.clone()]);
        agents
            .iter()
            .filter(|agent| self.shared_access(agent).is_some())
            .map(|agent| {
                let name = self
                    .store
                    .agent(agent)
                    .ok()
                    .flatten()
                    .map_or_else(|| held.agent_name.clone(), |a| a.name);
                let mut entry = Entry::new(
                    "bot.moved",
                    self.now_ms(),
                    actor.reference(),
                    vec![
                        Ref::new("bot", agent).named(&name),
                        Ref::new("host", &held.peer),
                    ],
                )
                .with("from", binding.host.as_str())
                .with("to", held.peer.as_str());
                if let Actor::Member(member) = &actor {
                    entry = entry.with("role", member.role.as_str());
                }
                entry
            })
            .collect()
    }

    /// Why the organization's policy refuses installing or moving to `package` on this host, if
    /// it does; nothing on a host no organization owns. A template this Spade ships is read as a
    /// market package; a local package, signed by nobody, as a git catalog's.
    pub(crate) fn org_package_refusal(&self, package: &PackageId) -> Option<String> {
        self.org_binding()?;
        let source = Source::parse(&package.source).unwrap_or(
            if package.source == crate::teams::TEMPLATE_SOURCE {
                Source::Market
            } else {
                Source::Git
            },
        );
        self.org_policy().package_refusal(Package {
            source,
            name: &package.name,
            version: &package.version,
            hash: &package.hash,
        })
    }

    /// Why the organization's policy blocks `package`, if this is an org host and it does.
    pub(crate) fn org_blocked(&self, package: &PackageId) -> Option<String> {
        self.org_binding()?;
        self.org_policy().blocked(&package.name, &package.hash)
    }

    /// Why `member` may not turn shared bot `agent`'s switch `key` on, if they may not: the
    /// policy's word for that effect and their role (ADR 0206 §3). Nothing for any other bot.
    pub(crate) fn org_switch_refusal(
        &self,
        agent: &str,
        key: &str,
        member: Option<&spade_core::org::Member>,
    ) -> Option<&'static str> {
        let access = self.shared_access(agent)?;
        let Some(member) = member else {
            return Some(crate::engine::MEMBER_ONLY);
        };
        let effect: Effect = self
            .bot_package(agent)?
            .manifest
            .effects
            .iter()
            .find(|declared| declared.key() == key)?
            .effect;
        self.org_policy().switch_refusal(
            effect,
            member.role(),
            access.may(member, Right::Configure),
        )
    }

    /// Every bot running a version `policy` blocks and not paused for it already: its id, its
    /// link and why.
    pub(super) fn blocked_by(
        &self,
        policy: &spade_core::org::Policy,
    ) -> Vec<(String, Link, String)> {
        let Ok(agents) = self.store.agents() else {
            return Vec::new();
        };
        agents
            .into_iter()
            .filter_map(|agent| {
                let link = self.bot_package(&agent.id)?;
                if link.withdrawn.is_some() {
                    return None;
                }
                let why = policy.blocked(&link.package.name, &link.package.hash)?;
                Some((agent.id, link, why))
            })
            .collect()
    }
}
