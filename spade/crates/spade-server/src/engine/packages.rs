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
        if let Some(code) = self.code() {
            code.retire(agent);
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
        narrowest(self.held_over(conversation))
    }

    /// The packaged bots whose switches the ceiling over `conversation` reads: a change to any of
    /// them can change it.
    pub(crate) fn ceiling_holders(&self, conversation: &str) -> Vec<String> {
        self.held_over(conversation)
            .into_iter()
            .filter_map(|held| held.by)
            .collect()
    }

    /// Every ceiling a call in `conversation` is held to, the outermost first.
    fn held_over(&self, conversation: &str) -> Vec<Held> {
        let helper = self.helper_of(conversation);
        let owner = helper
            .as_ref()
            .map_or_else(|| conversation.to_owned(), |h| h.parent.clone());
        let mut chain: Vec<String> = self.worker_ancestors(&owner);
        chain.reverse();
        chain.push(owner);
        let mut held = Vec::new();
        let by_call = |scope: spade_core::contract::Scope| Held {
            name: format!("The {} call", scope.contract),
            allows: scope.effects.into_iter().collect(),
            by: None,
        };
        for conversation in &chain {
            if let Ok(Some(agent)) = self.store.agent_for_conversation(conversation) {
                self.held_by(&agent, MOST_MAKERS, &mut held);
            }
            // A contract call its reply serves, or one it was made under, holds it to the
            // contract's effects too (ADR 0200 §7).
            held.extend(self.call_ceilings(conversation).into_iter().map(by_call));
        }
        // A helper stays held to the calls of the reply that started it, after that reply ends.
        if let Some(helper) = &helper {
            held.extend(self.helper_call_ceilings(helper).into_iter().map(by_call));
        }
        held
    }

    /// The ceiling over bot `agent`'s own runs: its commands, terminal and services.
    pub(crate) fn bot_ceiling(&self, agent: &str) -> Option<(String, Effects)> {
        let agent = self.store.agent(agent).ok()??;
        self.ceiling(&agent.conversation)
    }

    /// Every ceiling `agent` is held to, the outermost first: what its makers hold it to, then
    /// its own package's.
    fn held_by(&self, agent: &spade_store::Agent, makers: usize, out: &mut Vec<Held>) {
        self.made_held(agent, makers, out);
        if let Some(link) = self.bot_package(&agent.id) {
            out.push(Held {
                name: agent.name.clone(),
                allows: link.allows(),
                by: Some(agent.id.clone()),
            });
        }
    }

    /// What `agent`'s makers hold it to: the ceiling it was made under (as last narrowed), and
    /// its maker's as it is now while the maker is here.
    fn made_held(&self, agent: &spade_store::Agent, makers: usize, out: &mut Vec<Held>) {
        if let Some(under) = self.made_under(&agent.id) {
            out.push(Held {
                name: under.bot.clone(),
                allows: under.effects(),
                by: None,
            });
        }
        if makers > 0
            && let Some(maker) = self.maker_of(&agent.id)
            && let Ok(Some(maker)) = self.store.agent(&maker)
        {
            self.held_by(&maker, makers - 1, out);
        }
    }

    fn made_under(&self, agent: &str) -> Option<MadeUnder> {
        let text = self.store.setting(&made_under_key(agent)).ok()??;
        serde_json::from_str(&text).ok()
    }

    /// Narrows the ceiling each bot a packaged bot made carries to what its makers hold it to
    /// now, so it never widens again: not when its maker is gone, and not on another machine a
    /// move takes it to (the setting moves with it). Run after a package's switches change and
    /// before a bot moves.
    pub(crate) fn narrow_made_under(&self) {
        let Ok(agents) = self.store.agents() else {
            return;
        };
        for agent in agents {
            let Some(before) = self.made_under(&agent.id) else {
                continue;
            };
            let mut held = Vec::new();
            self.made_held(&agent, MOST_MAKERS, &mut held);
            let Some((bot, allows)) = narrowest(held) else {
                continue;
            };
            if allows == before.effects() {
                continue;
            }
            let text = serde_json::to_string(&MadeUnder::new(&bot, allows)).unwrap_or_default();
            if let Err(error) = self
                .store
                .set_setting(&made_under_key(&agent.id), Some(&text))
            {
                tracing::warn!(%error, bot = %agent.id, "a made bot's ceiling was not narrowed");
            }
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

/// One ceiling a call is held to: the packaged bot it names, what it allows, and the bot whose
/// switches decide it, when one does (a made bot's stored ceiling has none).
struct Held {
    name: String,
    allows: Effects,
    by: Option<String>,
}

/// The narrowest of `held`, named for the innermost: `None` when nothing holds the call.
fn narrowest(held: Vec<Held>) -> Option<(String, Effects)> {
    let name = held.last().map(|held| held.name.clone());
    let allows = link::narrowed(held.into_iter().map(|held| Some(held.allows)))?;
    Some((name.unwrap_or_default(), allows))
}

/// A link as stored. Strings, lists and finite numbers read from JSON: this always serializes.
pub fn link_text(link: &Link) -> String {
    serde_json::to_string(link).unwrap_or_default()
}
