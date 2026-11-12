//! Admission for model calls (ADR 0135): every model call (a turn's step, compaction, a title,
//! a review, research) is admitted here before it starts. Admission counts the calls still in
//! flight as spent at their estimated cost, so calls started at once cannot all pass a cap the
//! ledger alone has not reached yet; the estimate is released when the call's real cost is
//! recorded. A cap can still be passed, by at most the calls admitted before it was reached.
//!
//! Only real spend reaching a cap refuses a call. When it is the estimates of calls still
//! running that would pass it, the call waits ([`Engine::admit_waiting`]) until one of them
//! settles, then looks again: it may well fit once their real cost is known.

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
    /// What was spent has reached the service's daily cap.
    Service,
    /// What the bot spent has reached its own cap.
    Bot { name: String, hit: Hit },
    /// Nothing is reached yet, but the estimates of calls still running would pass a cap:
    /// wait for one to settle and look again. Never a reason to stop or to tell the person.
    InFlight,
}

impl Refusal {
    /// What was reached, in a few words: "the service's daily cap", "the bot's daily cap".
    pub(crate) fn reached(&self) -> String {
        match self {
            Self::Service => "the service's daily cap".to_owned(),
            Self::InFlight => "a cap, counting the calls still running".to_owned(),
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
        drop(flight);
        // Calls waiting on this one's estimate look again.
        self.engine.released.notify_waiters();
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
    /// Admits a model call for `conversation` on `model`, reserving its estimated cost, unless
    /// the service's daily cap or the bot's own cap is reached counting every call in flight.
    pub(crate) fn admit(
        self: &Arc<Self>,
        conversation: &str,
        model: &str,
        prompt: &Prompt,
        hint: Hint,
    ) -> Result<Admission, Refusal> {
        let reserved = estimate(self.models.price(model), prompt, hint);
        // Held across the check and the reservation, so two calls cannot both see room.
        let mut flight = self.in_flight.lock().unwrap_or_else(|p| p.into_inner());
        let periods = self.periods();
        let service = self
            .store
            .spent_since(periods.day_start)
            .unwrap_or(u64::MAX);
        if !spending::within_cap(service, self.daily_cap_micros) {
            return Err(Refusal::Service);
        }
        if let Some((name, hit)) = self.bot_hit_with(conversation, 0) {
            return Err(Refusal::Bot { name, hit });
        }
        let held = flight
            .by_conversation
            .get(conversation)
            .copied()
            .unwrap_or(0);
        if !spending::within_cap(service.saturating_add(flight.total), self.daily_cap_micros)
            || (held > 0 && self.bot_hit_with(conversation, held).is_some())
        {
            return Err(Refusal::InFlight);
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

    /// Like [`Engine::admit`], but waits while only calls still running stand in the way, so
    /// it answers only with an admission or a cap really reached.
    pub(crate) async fn admit_waiting(
        self: &Arc<Self>,
        conversation: &str,
        model: &str,
        prompt: &Prompt,
        hint: Hint,
    ) -> Result<Admission, Refusal> {
        loop {
            // Listening before looking, so a release between the two is not missed.
            let released = self.released.notified();
            tokio::pin!(released);
            released.as_mut().enable();
            match self.admit(conversation, model, prompt, hint) {
                Err(Refusal::InFlight) => released.await,
                answer => return answer,
            }
        }
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
    fn a_cached_prompt_and_a_short_typical_answer_are_estimated_closer_to_their_cost() {
        let price = Some(spade_models::Price {
            input: 2.0,
            output: 10.0,
            cache_read: Some(0.2),
            cache_write: None,
            per_call: None,
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
