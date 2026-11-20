//! What a bot linked to an agent package keeps of it (ADR 0200 §3.9), and the effects ceiling the
//! gate holds its calls to (§3.4): the nearest packaged bot up a call's tree, narrowed by every
//! packaged bot above it, so a worker can't use what its maker didn't declare.

use spade_core::effect::ceiling::Effects;
use spade_core::package::link::{self, Link};
use spade_store::{StoreError, package_key};

use super::Engine;

impl Engine {
    /// Records bot `agent`'s link to its package.
    pub fn set_bot_package(&self, agent: &str, link: &Link) -> Result<(), StoreError> {
        // Strings, lists and finite numbers read from JSON: this always serializes.
        let text = serde_json::to_string(link).unwrap_or_default();
        self.store.set_setting(&package_key(agent), Some(&text))
    }

    /// The package bot `agent` is linked to, if it is.
    pub fn bot_package(&self, agent: &str) -> Option<Link> {
        let text = self.store.setting(&package_key(agent)).ok()??;
        serde_json::from_str(&text).ok()
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
        let mut name = None;
        let allows = link::narrowed(chain.iter().map(|conversation| {
            let agent = self.store.agent_for_conversation(conversation).ok()??;
            let link = self.bot_package(&agent.id)?;
            name = Some(agent.name);
            Some(link.allows())
        }))?;
        Some((name.unwrap_or_default(), allows))
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
