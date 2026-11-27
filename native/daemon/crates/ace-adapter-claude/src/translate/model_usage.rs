// SPDX-License-Identifier: Apache-2.0
//! Model usage snapshots (split from `result_usage.rs`).

use ace_json::{Map, Value};
use std::collections::BTreeMap;

use super::json::object;

const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

type ModelMap = BTreeMap<String, Map>;

pub(crate) fn parse_model_usage(value: &Value) -> Option<ModelMap> {
    let obj = object(value);

    if obj.is_empty() && !matches!(value, Value::Object(_)) {
        return None;
    }

    let as_map = match value {
        Value::Object(m) => m,

        _ => return None,
    };

    if as_map.len() > 64 {
        return None;
    }

    let mut out = ModelMap::new();

    for (name, entry) in as_map {
        if name.is_empty() || name.len_code_points() > 512 {
            return None;
        }

        let eobj = object(entry);

        let get_count = |key: &str| -> Option<i64> {
            match eobj.get(key) {
                Some(Value::Number(n)) => {
                    let v = n.as_i64()?;

                    if v < 0 || (v as f64) > MAX_SAFE {
                        return None;
                    }

                    if n.as_f64().map(|f| f.fract() != 0.0).unwrap_or(true) {
                        return None;
                    }

                    Some(v)
                }

                _ => None,
            }
        };

        let input_tokens = get_count("inputTokens")?;

        let output_tokens = get_count("outputTokens")?;

        let cache_read = get_count("cacheReadInputTokens")?;

        let cache_creation = get_count("cacheCreationInputTokens")?;

        let cost_value = match eobj.get("costUSD") {
            Some(Value::Number(n)) => {
                let v = n.as_f64()?;

                if v < 0.0 || !v.is_finite() {
                    return None;
                }

                Value::Number(*n)
            }

            _ => return None,
        };

        if let Some(Value::Number(n)) = eobj.get("contextWindow") {
            let v = n.as_i64()?;

            if v <= 0 || n.as_f64().map(|f| f.fract() != 0.0).unwrap_or(true) {
                return None;
            }
        } else if eobj.get("contextWindow").is_some() {
            // Present but not a positive int.

            if !matches!(eobj.get("contextWindow"), Some(Value::Null)) {
                return None;
            }

            // null is not a valid contextWindow either (must be int if present).

            return None;
        }

        let mut kept = Map::new();

        // contextWindow is passthrough in the TypeScript schema: validated
        // above, then read back for the agent-scope usage fact.
        if let Some(Value::Number(n)) = eobj.get("contextWindow") {
            kept.insert("contextWindow".to_owned(), Value::Number(*n));
        }

        kept.insert("inputTokens".to_owned(), Value::Number(input_tokens.into()));

        kept.insert(
            "outputTokens".to_owned(),
            Value::Number(output_tokens.into()),
        );

        kept.insert(
            "cacheReadInputTokens".to_owned(),
            Value::Number(cache_read.into()),
        );

        kept.insert(
            "cacheCreationInputTokens".to_owned(),
            Value::Number(cache_creation.into()),
        );

        kept.insert("costUSD".to_owned(), cost_value);

        out.insert(String::from(name.clone()), kept);
    }

    Some(out)
}

pub(crate) struct SessionCounts {
    pub(crate) input: i64,
    pub(crate) output: i64,
    pub(crate) cached: i64,
    pub(crate) written: i64,
}

pub(crate) fn model_session_fact(
    root: &str,
    model: &str,
    counter_key: &str,
    counts: &SessionCounts,
    cost: &Value,
) -> Value {
    let mut map = Map::with_capacity(10);

    map.insert("type".to_owned(), Value::from("usage".to_owned()));

    map.insert("agent".to_owned(), Value::from(root.to_owned()));

    map.insert(
        "usageScope".to_owned(),
        Value::from("model_session".to_owned()),
    );

    map.insert("model".to_owned(), Value::from(model.to_owned()));

    map.insert(
        "counterMode".to_owned(),
        Value::from("cumulative".to_owned()),
    );

    map.insert("counterKey".to_owned(), Value::from(counter_key.to_owned()));

    map.insert("inputTokens".to_owned(), Value::Number(counts.input.into()));

    map.insert(
        "outputTokens".to_owned(),
        Value::Number(counts.output.into()),
    );

    map.insert(
        "cachedInputTokens".to_owned(),
        Value::Number(counts.cached.into()),
    );

    map.insert(
        "cacheWriteTokens".to_owned(),
        Value::Number(counts.written.into()),
    );

    map.insert("costUsd".to_owned(), cost.clone());

    Value::Object(map)
}

pub(crate) fn provider_session_fact(
    root: &str,

    counter_key: &str,

    input: i64,

    output: i64,

    cached: i64,

    written: i64,

    cost: &Value,
) -> Value {
    let mut map = Map::with_capacity(9);

    map.insert("type".to_owned(), Value::from("usage".to_owned()));

    map.insert("agent".to_owned(), Value::from(root.to_owned()));

    map.insert(
        "usageScope".to_owned(),
        Value::from("provider_session".to_owned()),
    );

    map.insert(
        "counterMode".to_owned(),
        Value::from("cumulative".to_owned()),
    );

    map.insert("counterKey".to_owned(), Value::from(counter_key.to_owned()));

    map.insert("inputTokens".to_owned(), Value::Number(input.into()));

    map.insert("outputTokens".to_owned(), Value::Number(output.into()));

    map.insert("cachedInputTokens".to_owned(), Value::Number(cached.into()));

    map.insert("cacheWriteTokens".to_owned(), Value::Number(written.into()));

    map.insert("costUsd".to_owned(), cost.clone());

    Value::Object(map)
}

#[cfg(test)]
mod length_tests {
    use super::*;

    #[test]
    fn result_usage_accepts_a_model_of_512_emoji() {
        for length in [512, 513] {
            let model = "😀".repeat(length);
            let usage = ace_json::parse(&format!(r#"{{"{model}":{{"inputTokens":1,"outputTokens":0,"cacheReadInputTokens":0,"cacheCreationInputTokens":0,"costUSD":0}}}}"#)).expect("usage");
            let parsed = parse_model_usage(&usage);
            assert_eq!(
                parsed.is_some_and(|totals| totals.contains_key(&model)),
                length == 512
            );
        }
    }
}
