//! What a bot made from a marketplace recipe keeps of it (ADR 0168 §8): where it came from
//! (`from_recipe`, shown in its profile) and, when the recipe named them, the built-in tools it
//! is narrowed to. The narrowing works as a worker's grant does (ADR 0161): it can only take
//! tools away, and a worker of the bot gets no more than the bot.

use serde::{Deserialize, Serialize};
use spade_store::{StoreError, recipe_key};

use super::Engine;

/// The recipe a bot was made from: its source, entry name and version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FromRecipe {
    pub source: String,
    pub name: String,
    pub version: String,
}

/// What the store keeps for a bot made from a recipe.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BotRecipe {
    pub from_recipe: FromRecipe,
    /// The built-in tools it may use, by name; `None` for all.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<String>>,
}

impl Engine {
    /// Records that bot `agent` was made from a recipe.
    pub fn set_bot_recipe(&self, agent: &str, recipe: &BotRecipe) -> Result<(), StoreError> {
        // Plain strings and lists: this always serializes.
        let text = serde_json::to_string(recipe).unwrap_or_default();
        self.store.set_setting(&recipe_key(agent), Some(&text))
    }

    /// The recipe bot `agent` was made from, if it was.
    pub fn bot_recipe(&self, agent: &str) -> Option<BotRecipe> {
        let text = self.store.setting(&recipe_key(agent)).ok()??;
        serde_json::from_str(&text).ok()
    }

    /// The built-in tools the top-level bot whose conversation is `conversation` is narrowed
    /// to by its recipe; `None` for all.
    pub(super) fn recipe_tools(&self, conversation: &str) -> Option<Vec<String>> {
        let agent = self.store.agent_for_conversation(conversation).ok()??;
        self.bot_recipe(&agent.id)?.tools
    }
}
