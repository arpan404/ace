//! Admission for model calls (ADR 0135): every model call (a turn's step, compaction, a title,
//! a review, research) is admitted here before it starts. Admission counts the calls still in
//! flight as spent at their estimated cost, so calls started at once cannot all pass a cap the
//! ledger alone has not reached yet; the estimate is released when the call's real cost is
//! recorded. A cap can still be passed, by at most the calls admitted before it was reached.

use std::collections::HashMap;
use std::sync::Arc;

use spade_core::oversight::{self, Caps, Hit, Spent};
use spade_core::spending;
use spade_models::{Message, Prompt, Usage};

use super::Engine;

/// Calls admitted and not yet settled: their estimated cost, per conversation and in all.
#[derive(Debug, Default)]
pub(super) struct InFlight {
    by_conversation: HashMap<String, u64>,
    total: u64,
}

/// Why a model call may not start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Refusal {
    /// The service's daily cap, counting calls in flight.
    Service,
    /// The bot's own cap.
    Bot { name: String, hit: Hit },
}

impl Refusal {
    /// What was reached, in a few words: "the service's daily cap", "the bot's daily cap".
    pub(crate) fn reached(&self) -> String {
        match self {
            Self::Service => "the service's daily cap".to_owned(),
            Self::Bot { hit, .. } => format!(
                "the bot's {} cap",
                match hit.scope {
                    spade_core::event::CapScope::Daily => "daily",
                    spade_core::event::CapScope::Monthly => "monthly",
                }
            ),
        }
    }
}

/// An admitted call's reservation. [`Admission::settle`] records the real cost; dropping it
/// unsettled (a call that never got an answer) just releases the estimate.
pub(crate) struct Admission {
    engine: Arc<Engine>,
    conversation: String,
    model: String,
    reserved: u64,
}

impl Admission {
    /// Records what the call cost against its conversation, then releases the estimate. Returns
    /// the cost.
    pub(crate) fn settle(self, usage: &Usage) -> u64 {
        self.engine.pay(&self.conversation, &self.model, usage)
    }

    /// Records the cost of an answer that may not have come (an error that still reported use).
    pub(crate) fn settle_if(self, usage: Option<Usage>) -> u64 {
        match usage {
            Some(usage) => self.settle(&usage),
            None => 0,
        }
    }
}

impl Drop for Admission {
    fn drop(&mut self) {
        let mut flight = self
            .engine
            .in_flight
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        flight.total = flight.total.saturating_sub(self.reserved);
        if let Some(held) = flight.by_conversation.get_mut(&self.conversation) {
            *held = held.saturating_sub(self.reserved);
            if *held == 0 {
                flight.by_conversation.remove(&self.conversation);
            }
        }
    }
}

/// Output tokens assumed for a call that names no limit.
const DEFAULT_OUTPUT_TOKENS: u32 = 4_096;
/// Input tokens an image is taken to cost.
const IMAGE_TOKENS: usize = 1_600;

/// What a call to `prompt` is likely to cost: about four characters a token in, its output
/// limit out. Linear in the prompt, which is about to be sent anyway.
pub(crate) fn estimate(price: Option<spade_models::Price>, prompt: &Prompt) -> u64 {
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
    let input = chars / 4 + images * IMAGE_TOKENS;
    let usage = Usage {
        input_tokens: Some(u32::try_from(input).unwrap_or(u32::MAX)),
        output_tokens: Some(prompt.max_tokens.unwrap_or(DEFAULT_OUTPUT_TOKENS)),
        ..Usage::default()
    };
    spending::cost_micros(price, &usage)
}

impl Engine {
    /// Admits a model call for `conversation` on `model`, reserving its estimated cost, unless
    /// the service's daily cap or the bot's own cap is reached counting every call in flight.
    pub(crate) fn admit(
        self: &Arc<Self>,
        conversation: &str,
        model: &str,
        prompt: &Prompt,
    ) -> Result<Admission, Refusal> {
        let reserved = estimate(self.models.price(model), prompt);
        // Held across the check and the reservation, so two calls cannot both see room.
        let mut flight = self.in_flight.lock().unwrap_or_else(|p| p.into_inner());
        let periods = self.periods();
        let service = self
            .store
            .spent_since(periods.day_start)
            .unwrap_or(u64::MAX);
        if !spending::within_cap(service.saturating_add(flight.total), self.daily_cap_micros) {
            return Err(Refusal::Service);
        }
        let held = flight
            .by_conversation
            .get(conversation)
            .copied()
            .unwrap_or(0);
        if let Some((name, hit)) = self.bot_hit_with(conversation, held) {
            return Err(Refusal::Bot { name, hit });
        }
        flight.total += reserved;
        *flight
            .by_conversation
            .entry(conversation.to_owned())
            .or_default() += reserved;
        Ok(Admission {
            engine: self.clone(),
            conversation: conversation.to_owned(),
            model: model.to_owned(),
            reserved,
        })
    }

    /// The cap the conversation's bot is at, counting `pending` micros as spent already.
    pub(super) fn bot_hit_with(&self, conversation: &str, pending: u64) -> Option<(String, Hit)> {
        let agent = self.store.agent_for_conversation(conversation).ok()??;
        let settings = self.agent_oversight(&agent.id).ok()?;
        let caps = Caps {
            daily_micros: settings.daily_cap_micros,
            monthly_micros: settings.monthly_cap_micros,
        };
        if caps == Caps::default() {
            return None;
        }
        let periods = self.periods();
        let spent = Spent {
            today_micros: self
                .store
                .spent_by(&agent.conversation, periods.day_start)
                .ok()?
                .saturating_add(pending),
            month_micros: self
                .store
                .spent_by(&agent.conversation, periods.month_start)
                .ok()?
                .saturating_add(pending),
        };
        oversight::hit(caps, spent, periods).map(|hit| (agent.name, hit))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_longer_prompt_and_a_higher_limit_are_estimated_to_cost_more() {
        let price = Some(spade_models::Price {
            input: 2.0,
            output: 10.0,
            cache_read: None,
            cache_write: None,
        });
        let short = Prompt::default().person("hi").max_tokens(100);
        let long = Prompt::default()
            .person("word ".repeat(4_000))
            .max_tokens(100);
        let more_out = Prompt::default().person("hi").max_tokens(1_000);
        assert!(estimate(price, &long) > estimate(price, &short));
        assert!(estimate(price, &more_out) > estimate(price, &short));
        assert_eq!(estimate(None, &long), 0, "an unpriced model costs nothing");
    }
}
