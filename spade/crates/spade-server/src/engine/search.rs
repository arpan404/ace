//! `web_search` on the bot's own endpoint, where its model has a search tool (docs/design.md,
//! Web search): paid for like any model call (ADR 0135), its tokens and each search the endpoint
//! billed.

use std::sync::Arc;

use spade_models::WebFound;

use super::Engine;

/// How a search on the endpoint ended.
pub(crate) enum Native {
    /// The bot's model has no search of its own.
    Unavailable,
    Found(WebFound),
    /// It failed: a few words why.
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
        let admitted = self.admit(conversation, &model);
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
