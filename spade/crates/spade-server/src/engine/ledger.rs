//! What each model call costs (ADR 0135; ADR 0166): every model call (a turn's step,
//! compaction, a title, a review, research) takes an [`Admission`] before it starts, and settling
//! it records the call's real cost in the ledger under its conversation and role. It is never
//! refused: Spade has no spending limits, so the cost is information only. The estimates here
//! are what routing compares models by.

use std::sync::Arc;

use spade_core::spending;
use spade_models::{Message, Prompt, Usage};

use super::Engine;

/// A call about to start. [`Admission::settle`] records its real cost; dropping it unsettled (a
/// call that never got an answer) records nothing.
pub(crate) struct Admission {
    engine: Arc<Engine>,
    conversation: String,
    model: String,
    /// What the call is for (ADR 0162); `None` is the conversation's own turn or helper.
    role: Option<spade_core::routing::Role>,
}

impl Admission {
    /// Records this call's cost under `role`.
    pub(crate) fn for_role(mut self, role: spade_core::routing::Role) -> Self {
        self.role = Some(role);
        self
    }

    /// Records what the call cost against its conversation. Returns the cost.
    pub(crate) fn settle(self, usage: &Usage) -> u64 {
        let cost = spending::cost_micros(self.engine.models.price(&self.model), usage);
        self.engine
            .record_cost_as(&self.conversation, &self.model, self.role, cost);
        cost
    }

    /// Records what a call with the endpoint's own web search cost: its tokens and each search
    /// the endpoint billed.
    pub(crate) fn settle_searches(self, usage: &Usage, searches: u32) -> u64 {
        let cost =
            spending::search_cost_micros(self.engine.models.price(&self.model), usage, searches);
        self.engine
            .record_cost_as(&self.conversation, &self.model, self.role, cost);
        cost
    }

    /// Records the cost of an answer that may not have come (an error that still reported use).
    pub(crate) fn settle_if(self, usage: Option<Usage>) -> u64 {
        match usage {
            Some(usage) => self.settle(&usage),
            None => 0,
        }
    }
}

/// Output tokens assumed for a call that names no limit and has no history to go by.
const DEFAULT_OUTPUT_TOKENS: u32 = 1_024;
/// Input tokens an image is taken to cost.
const IMAGE_TOKENS: usize = 1_600;

/// What the caller knows that makes an estimate closer: how much of the prompt the endpoint
/// will likely read from its cache (the previous step's prompt, for a turn), and how long
/// answers here tend to be.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Hint {
    pub cached_tokens: u32,
    pub typical_output: Option<u32>,
}

/// What a call to `prompt` is likely to cost: about four characters a token in, the part the
/// cache will serve at the cache-read price, and out its limit, else what answers here tend to
/// be, else 1,024 tokens. Linear in the prompt, which is about to be sent anyway.
pub(crate) fn estimate(price: Option<spade_models::Price>, prompt: &Prompt, hint: Hint) -> u64 {
    let input = prompt_tokens(prompt);
    let output = prompt
        .max_tokens
        .or(hint.typical_output)
        .unwrap_or(DEFAULT_OUTPUT_TOKENS);
    spending::cost_micros(price, &likely_usage(input, hint, output))
}

/// A call's use as it likely was: `input` tokens in (the hint's cached part read from the
/// cache), `output` out.
pub(crate) fn likely_usage(input: u32, hint: Hint, output: u32) -> Usage {
    Usage {
        input_tokens: Some(input),
        output_tokens: Some(output),
        cache_read_tokens: Some(hint.cached_tokens.min(input)),
        ..Usage::default()
    }
}

/// About how many tokens `prompt` is: four characters a token, a fixed amount per image.
pub(crate) fn prompt_tokens(prompt: &Prompt) -> u32 {
    let mut chars = prompt.system.as_ref().map_or(0, String::len);
    let mut images = 0;
    for message in &prompt.messages {
        chars += match message {
            Message::Person { text, images: i } => {
                images += i.len();
                text.len()
            }
            Message::Spade { text, calls, .. } => {
                text.len()
                    + calls
                        .iter()
                        .map(|c| c.arguments.to_string().len())
                        .sum::<usize>()
            }
            Message::ToolResult { content, .. } => content.len(),
        };
    }
    for tool in &prompt.tools {
        chars += tool.description.len() + tool.schema.to_string().len();
    }
    u32::try_from(chars / 4 + images * IMAGE_TOKENS).unwrap_or(u32::MAX)
}

/// A turn's hint from its events: the last step's prompt is cached, and answers run about as
/// long as the longest of the last few steps'.
pub(crate) fn turn_hint(events: &[spade_core::Event]) -> Hint {
    use spade_core::event::Known;
    let steps: Vec<&spade_core::event::Tokens> = events
        .iter()
        .rev()
        .filter_map(|event| match event {
            spade_core::Event::Known(Known::StepFinished { usage, .. }) => Some(usage),
            _ => None,
        })
        .take(3)
        .collect();
    Hint {
        cached_tokens: steps.first().and_then(|u| u.input).unwrap_or(0),
        typical_output: steps.iter().filter_map(|u| u.output).max(),
    }
}

impl Engine {
    /// The admission for a model call of `conversation`'s on `model`. A helper's calls are its
    /// bot's (ADR 0152): recorded under the bot, as the helper role.
    pub(crate) fn admit(self: &Arc<Self>, conversation: &str, model: &str) -> Admission {
        let owner = self.helper_of(conversation).map(|h| h.parent);
        Admission {
            engine: self.clone(),
            conversation: owner.as_deref().unwrap_or(conversation).to_owned(),
            model: model.to_owned(),
            // Paid under the bot, but spent as a helper (ADR 0162).
            role: owner.is_some().then_some(spade_core::routing::Role::Helper),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cached_prompt_and_a_short_typical_answer_are_estimated_closer_to_their_cost() {
        let price = Some(spade_models::Price {
            input: 2.0,
            output: 10.0,
            cache_read: Some(0.2),
            cache_write: None,
            per_call: None,
            per_search: None,
        });
        let prompt = Prompt::default().person("word ".repeat(40_000));
        let cold = estimate(price, &prompt, Hint::default());
        let warm = estimate(
            price,
            &prompt,
            Hint {
                cached_tokens: 50_000,
                typical_output: Some(200),
            },
        );
        // 50,000 input tokens: $0.10 cold, $0.01 from the cache; 1,024 vs 200 out.
        assert_eq!(cold, 100_000 + 10_240);
        assert_eq!(warm, 10_000 + 2_000);
    }

    #[test]
    fn a_longer_prompt_and_a_higher_limit_are_estimated_to_cost_more() {
        let price = Some(spade_models::Price {
            input: 2.0,
            output: 10.0,
            cache_read: None,
            cache_write: None,
            per_call: None,
            per_search: None,
        });
        assert!(price.is_some());
        let short = Prompt::default().person("hi").max_tokens(100);
        let long = Prompt::default()
            .person("word ".repeat(4_000))
            .max_tokens(100);
        let more_out = Prompt::default().person("hi").max_tokens(1_000);
        assert!(estimate(price, &long, Hint::default()) > estimate(price, &short, Hint::default()));
        assert!(
            estimate(price, &more_out, Hint::default()) > estimate(price, &short, Hint::default())
        );
        assert_eq!(
            estimate(None, &long, Hint::default()),
            0,
            "an unpriced model costs nothing"
        );
    }
}
