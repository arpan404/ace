//! What a bot linked to an agent package keeps of it (ADR 0200 §3.9), and the effects ceiling the
//! gate holds its calls to (§3.4): the nearest packaged bot up a call's tree, narrowed by every
//! packaged bot above it, so a worker can't use what its maker didn't declare. A bot a packaged
//! bot makes for the person carries its maker's ceiling too: what it was made under, kept with
//! it, and its maker's as it is now while the maker is there.

use serde::{Deserialize, Serialize};
use spade_core::effect::Effect;
use spade_core::effect::ceiling::Effects;
use spade_core::package::link::{self, Link};
pub(super) use spade_store::made_under_key;
use spade_store::{StoreError, package_key};

use super::Engine;

/// How far up a chain of makers the ceiling is read: a bot made by a bot made by a bot.
const MOST_MAKERS: usize = 16;

/// A maker's ceiling as a made bot keeps it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct MadeUnder {
    /// The packaged bot the refusal names.
    pub bot: String,
    /// Effect words left on.
    pub allows: Vec<String>,
}

impl MadeUnder {
    pub fn new(bot: &str, allows: Effects) -> Self {
        Self {
            bot: bot.to_owned(),
            allows: allows.iter().map(|e| e.name().to_owned()).collect(),
        }
    }

    fn effects(&self) -> Effects {
        self.allows
            .iter()
            .filter_map(|w| Effect::parse(w))
            .collect()
    }
}

impl Engine {
    /// Records bot `agent`'s link to its package.
    pub fn set_bot_package(&self, agent: &str, link: &Link) -> Result<(), StoreError> {
        self.store
            .set_setting(&package_key(agent), Some(&link_text(link)))
    }

    /// The package bot `agent` is linked to, if it is.
    pub fn bot_package(&self, agent: &str) -> Option<Link> {
        let text = self.store.setting(&package_key(agent)).ok()??;
        serde_json::from_str(&text).ok()
    }

    /// The market keys a package's signed manifest must verify with.
    pub fn market_keys(&self) -> Vec<crate::packages::envelope::MarketKey> {
        self.market_keys
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    /// Trusts `keys` in place of the shipped market keys: a test's own signer.
    pub fn trust_market_keys(&self, keys: Vec<crate::packages::envelope::MarketKey>) {
        *self.market_keys.write().unwrap_or_else(|p| p.into_inner()) = keys;
    }

    /// Whether bot `agent` is still being installed from its package: nothing is scheduled
    /// for it yet.
    pub fn installing(&self, agent: &str) -> bool {
        self.bot_package(agent).is_some_and(|link| link.installing)
    }

    /// Removes a bot an install left unfinished, before any work for it could start: with its
    /// apps, plugins, grants and allowed hosts, as an install that fails removes it.
    pub(crate) fn forget_unfinished_install(&self, agent: &str) -> Result<(), StoreError> {
        if let Some(hub) = self.apps()
            && let Err(error) = hub.forget_agent(agent)
        {
            tracing::warn!(%error, "an unfinished install's connectors were not forgotten");
        }
        if let Some(plugins) = self.plugins() {
            plugins.forget(agent);
        }
        self.store.delete_agent(agent)?;
        if let Some(security) = self.security() {
            security.forget(agent);
        }
        Ok(())
    }

    /// The bot whose package was installed or last updated under `transaction`, if any.
    pub fn bot_for_package_transaction(
        &self,
        transaction: &str,
    ) -> Result<Option<String>, StoreError> {
        Ok(self
            .store
            .agents()?
            .into_iter()
            .map(|agent| agent.id)
            .find(|id| {
                self.bot_package(id)
                    .and_then(|link| link.transaction)
                    .is_some_and(|t| t == transaction)
            }))
    }

    /// The ceiling over a call made in `conversation` (a bot's, a worker's or a helper's): the
    /// packaged bot's name it is refused in, and the effects left on all the way up.
    pub(crate) fn ceiling(&self, conversation: &str) -> Option<(String, Effects)> {
        let owner = self
            .helper_of(conversation)
            .map_or_else(|| conversation.to_owned(), |h| h.parent);
        let mut chain: Vec<String> = self.worker_ancestors(&owner);
        chain.reverse();
        chain.push(owner);
        let mut held = Vec::new();
        for conversation in &chain {
            if let Ok(Some(agent)) = self.store.agent_for_conversation(conversation) {
                self.held_by(&agent, MOST_MAKERS, &mut held);
            }
        }
        let name = held.last().map(|(name, _)| name.clone());
        let allows = link::narrowed(held.into_iter().map(|(_, allows)| Some(allows)))?;
        Some((name.unwrap_or_default(), allows))
    }

    /// The ceiling over bot `agent`'s own runs: its commands, terminal and services.
    pub(crate) fn bot_ceiling(&self, agent: &str) -> Option<(String, Effects)> {
        let agent = self.store.agent(agent).ok()??;
        self.ceiling(&agent.conversation)
    }

    /// Every ceiling `agent` is held to, the outermost first: what it was made under, its maker's
    /// as it is now, then its own package's.
    fn held_by(&self, agent: &spade_store::Agent, makers: usize, out: &mut Vec<(String, Effects)>) {
        let made_under = self
            .store
            .setting(&made_under_key(&agent.id))
            .ok()
            .flatten()
            .and_then(|text| serde_json::from_str::<MadeUnder>(&text).ok());
        if let Some(under) = made_under {
            out.push((under.bot.clone(), under.effects()));
        }
        if makers > 0
            && let Some(maker) = self.maker_of(&agent.id)
            && let Ok(Some(maker)) = self.store.agent(&maker)
        {
            self.held_by(&maker, makers - 1, out);
        }
        if let Some(link) = self.bot_package(&agent.id) {
            out.push((agent.name.clone(), link.allows()));
        }
    }

    /// Whether `name` is among the tools of the modules every packaged bot over `conversation`
    /// uses (ADR 0200 §4.3). A tool outside `spade.v1` (a harness internal) is every bot's; an
    /// app's or plugin's own tool belongs to `apps`.
    pub(crate) fn uses_allow(&self, conversation: &str, name: &str) -> bool {
        let owner = self
            .helper_of(conversation)
            .map_or_else(|| conversation.to_owned(), |h| h.parent);
        let mut chain = self.worker_ancestors(&owner);
        chain.push(owner);
        let app = || {
            self.tools
                .get_for(conversation, name)
                .is_some_and(|tool| tool.hints().is_some())
        };
        chain
            .iter()
            .all(|conversation| match self.package_uses(conversation) {
                Some(uses) => spade_core::effect::runtime::uses_allow(&uses, name, app()),
                None => true,
            })
    }

    /// The runtime modules the top-level bot whose conversation is `conversation` is narrowed to
    /// by its package's `uses`; `None` for all.
    pub(super) fn package_uses(&self, conversation: &str) -> Option<Vec<String>> {
        let agent = self.store.agent_for_conversation(conversation).ok()??;
        self.bot_package(&agent.id)?.manifest.uses
    }

    /// The most of `parent`'s workers its package expects to work at once, if it says.
    pub(super) fn package_workers_at_once(&self, parent: &str) -> Option<usize> {
        let agent = self.store.agent_for_conversation(parent).ok()??;
        let most = self
            .bot_package(&agent.id)?
            .manifest
            .limits
            .workers_at_once?;
        usize::try_from(most).ok()
    }

    /// What `agent`'s package expects it to cost an hour, in micro-dollars: the floor of its
    /// spend alert. Information only (ADR 0166).
    pub(super) fn package_spend_floor(&self, agent: &str) -> Option<u64> {
        let usd = self
            .bot_package(agent)?
            .manifest
            .limits
            .spend_alert_usd_per_day?;
        // Whole micro-dollars an hour; a day's dollars are small enough to round.
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        Some((usd * 1_000_000.0 / 24.0).round() as u64)
    }
}

/// A link as stored. Strings, lists and finite numbers read from JSON: this always serializes.
pub fn link_text(link: &Link) -> String {
    serde_json::to_string(link).unwrap_or_default()
}
