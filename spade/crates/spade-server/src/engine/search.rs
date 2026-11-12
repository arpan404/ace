//! `web_search` on the bot's own endpoint, where its model has a search tool (docs/design.md,
//! Web search): admitted against the caps like any model call (ADR 0135) and paid for its tokens
//! and each search the endpoint billed.

use std::sync::Arc;

use spade_models::{Prompt, WebFound};

use super::Engine;
use super::ledger::Hint;

/// How a search on the endpoint ended.
pub(crate) enum Native {
    /// The bot's model has no search of its own.
    Unavailable,
    Found(WebFound),
    /// It failed, or a cap stood in the way: a few words why.
    Failed(String),
}

impl Engine {
    /// Searches the web for `query` with the model of `conversation`'s bot, when that model can.
    pub(crate) async fn native_search(
        self: &Arc<Self>,
        conversation: &str,
        query: &str,
        count: usize,
    ) -> Native {
        let model = self.bot_model(conversation);
        if !self.models.searches_natively(&model) {
            return Native::Unavailable;
        }
        let estimate = Prompt::ask(query);
        let admitted = match self
            .admit_waiting(conversation, &model, &estimate, Hint::default())
            .await
        {
            Ok(admitted) => admitted,
            Err(refused) => return Native::Failed(format!("{} is reached", refused.reached())),
        };
        match self.models.web_search(&model, query, count).await {
            Ok(found) => {
                admitted.settle_searches(&found.usage, found.searches);
                Native::Found(found)
            }
            Err(error) => {
                admitted.settle_if(error.usage());
                Native::Failed(error.to_string())
            }
        }
    }
}
