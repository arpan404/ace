// SPDX-License-Identifier: Apache-2.0
//! Model and billing facts (`packages/adapter-opencode/src/usage.ts`).
//! Session billing is cumulative; step occupancy replaces the last sampling.

use crate::translate::data::{Num, fields, get, utf16_len};
use serde::Serialize;
use serde_json::{Map, Value};

/// A model name either borrowed from translator state or freshly parsed.
pub enum Model<'a> {
    Borrowed(&'a str),
    Owned(String),
}

impl Serialize for Model<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Model::Borrowed(model) => serializer.serialize_str(model),
            Model::Owned(model) => serializer.serialize_str(model),
        }
    }
}

impl<'a> Model<'a> {
    pub fn as_str(&self) -> &str {
        match self {
            Model::Borrowed(model) => model,
            Model::Owned(model) => model,
        }
    }
}

/// Parse a model reference the way `ModelRef.safeParse` does.
pub fn qualified_model(value: &Value) -> Option<String> {
    let model = fields(value);
    match (model.get("providerID"), model.get("id")) {
        (Some(Value::String(provider)), Some(Value::String(id)))
            if !provider.is_empty()
                && !id.is_empty()
                && utf16_len(provider) <= 256
                && utf16_len(id) <= 256 =>
        {
            let qualified = format!("{provider}/{id}");
            if utf16_len(&qualified) <= 256 {
                Some(qualified)
            } else {
                None
            }
        }
        _ => None,
    }
}

#[derive(Serialize)]
pub struct AgentLinked<'a> {
    #[serde(rename = "type")]
    typ: &'static str,
    agent: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<Model<'a>>,
}

pub fn linked_model<'a>(agent: &'a str, model: Model<'a>) -> AgentLinked<'a> {
    AgentLinked {
        typ: "agent.linked",
        agent,
        model: Some(model),
    }
}

pub struct Counts {
    pub input_tokens: f64,
    pub output_tokens: f64,
    pub cached_input_tokens: f64,
    pub cache_write_tokens: f64,
    pub reasoning_tokens: f64,
}

/// Read token counts the way `Tokens.safeParse` does, or nothing.
pub fn counts(value: &Value) -> Option<Counts> {
    let tokens = fields(value);
    let input = required_count(tokens.get("input"))?;
    let output = required_count(tokens.get("output"))?;
    let reasoning = match tokens.get("reasoning") {
        None => 0.0,
        Some(reasoning) => required_count(Some(reasoning))?,
    };
    let (read, write) = match tokens.get("cache") {
        None => (0.0, 0.0),
        Some(Value::Null) => return None,
        Some(cache) => {
            let cached = fields(cache);
            if !matches!(cache, Value::Object(_)) {
                return None;
            }
            (
                required_count(cached.get("read"))?,
                required_count(cached.get("write"))?,
            )
        }
    };
    let input_tokens = input + read + write;
    let output_tokens = output + reasoning;
    if input_tokens + output_tokens > 9_007_199_254_740_991.0 {
        return None;
    }
    Some(Counts {
        input_tokens,
        output_tokens,
        cached_input_tokens: read,
        cache_write_tokens: write,
        reasoning_tokens: reasoning,
    })
}

fn required_count(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(n)) => {
            let v = n.as_f64()?;
            if v.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(&v) {
                Some(v)
            } else {
                None
            }
        }
        _ => None,
    }
}

#[derive(Serialize)]
pub struct Usage<'a> {
    #[serde(rename = "type")]
    typ: &'static str,
    agent: &'a str,
    #[serde(rename = "inputTokens")]
    input_tokens: Num,
    #[serde(rename = "outputTokens")]
    output_tokens: Num,
    #[serde(rename = "cachedInputTokens")]
    cached_input_tokens: Num,
    #[serde(rename = "cacheWriteTokens")]
    cache_write_tokens: Num,
    #[serde(rename = "reasoningTokens")]
    reasoning_tokens: Num,
    #[serde(rename = "counterMode")]
    counter_mode: &'static str,
    #[serde(rename = "counterKey")]
    counter_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<Model<'a>>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "billingMode")]
    billing_mode: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "costUsd")]
    cost_usd: Option<Num>,
}

/// Session billing, cumulative under its session key.
pub fn session_usage<'a>(
    agent: &'a str,
    session: &str,
    model: Option<Model<'a>>,
    data: &'a Map<String, Value>,
) -> Option<Usage<'a>> {
    let tokens = counts(get(data, "tokens"))?;
    let cost = match get(data, "cost") {
        Value::Number(cost) => cost.as_f64().filter(|v| *v >= 0.0),
        _ => None,
    };
    Some(Usage {
        typ: "usage",
        agent,
        input_tokens: Num(tokens.input_tokens),
        output_tokens: Num(tokens.output_tokens),
        cached_input_tokens: Num(tokens.cached_input_tokens),
        cache_write_tokens: Num(tokens.cache_write_tokens),
        reasoning_tokens: Num(tokens.reasoning_tokens),
        counter_mode: "cumulative",
        counter_key: format!("session:{session}"),
        billing_mode: match &model {
            Some(model) if model.as_str().starts_with("openrouter/") => Some("api"),
            _ => None,
        },
        model,
        cost_usd: cost.map(Num),
    })
}

#[derive(Serialize)]
pub struct ContextSample<'a> {
    #[serde(rename = "type")]
    typ: &'static str,
    agent: &'a str,
    #[serde(rename = "usedTokens")]
    used_tokens: Num,
    #[serde(rename = "sessionId")]
    session_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<Model<'a>>,
}

/// Step occupancy replaces the last sampling.
pub fn step_context<'a>(
    agent: &'a str,
    session: &'a str,
    model: Option<Model<'a>>,
    data: &'a Map<String, Value>,
) -> Option<ContextSample<'a>> {
    let tokens = counts(get(data, "tokens"))?;
    Some(ContextSample {
        typ: "context.sample",
        agent,
        used_tokens: Num(tokens.input_tokens + tokens.output_tokens),
        session_id: session,
        model,
    })
}
