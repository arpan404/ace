// SPDX-License-Identifier: Apache-2.0
//! Accounting counters that look like secrets (`packages/redaction/src/token-counters.ts`):
//! token *counts* stay visible, so `inputTokens: 12` survives while `tokens: "…"` does not.

use ace_json::Value;

const TOKEN_COUNTERS: [&str; 7] = [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reasoningTokens",
    "totalTokens",
    "tokens",
];
const NATIVE_TOKEN_COUNTERS: [&str; 4] = ["input", "output", "reasoning", "total"];

fn nonnegative_counter(value: &Value) -> bool {
    match value {
        Value::Number(number) => {
            let value = number.value();
            value >= 0.0 && value.fract() == 0.0 && value <= 9_007_199_254_740_991.0
        }
        _ => false,
    }
}

fn native_token_counters(value: &Value) -> bool {
    let Value::Object(entries) = value else {
        return false;
    };
    if entries.is_empty() {
        return false;
    }
    entries.iter().all(|(key, counter)| {
        if key.as_str() != "cache" {
            return NATIVE_TOKEN_COUNTERS.contains(&key.as_str()) && nonnegative_counter(counter);
        }
        let Value::Object(cache) = counter else {
            return false;
        };
        cache.iter().all(|(name, count)| {
            (name.as_str() == "read" || name.as_str() == "write") && nonnegative_counter(count)
        })
    })
}

/// Whether `key`'s value is a usage counter rather than a credential.
pub fn accounting_counter(key: &str, value: &Value) -> bool {
    (TOKEN_COUNTERS.contains(&key) && nonnegative_counter(value))
        || (key == "tokens" && native_token_counters(value))
}

#[cfg(test)]
mod tests {
    use super::accounting_counter;
    use ace_json::parse;

    fn value(json: &str) -> ace_json::Value {
        parse(json).expect("test JSON parses")
    }

    #[test]
    fn numeric_usage_counters_survive_and_strings_do_not() {
        for (key, json) in [
            ("inputTokens", "12"),
            ("outputTokens", "7"),
            ("totalTokens", "19"),
            ("tokens", "4"),
        ] {
            assert!(accounting_counter(key, &value(json)), "{key}");
        }
        for (key, json) in [
            ("inputTokens", "\"sentinel-secret\""),
            ("tokens", "\"sentinel-secret\""),
            ("inputTokens", "-1"),
            ("inputTokens", "1.5"),
        ] {
            assert!(!accounting_counter(key, &value(json)), "{key} {json}");
        }
    }

    #[test]
    fn native_token_objects_are_counters_only_when_every_entry_is_a_count() {
        assert!(accounting_counter(
            "tokens",
            &value(r#"{"input":1,"output":2,"cache":{"read":3,"write":4}}"#)
        ));
        assert!(!accounting_counter("tokens", &value(r#"{"input":"x"}"#)));
        assert!(!accounting_counter("tokens", &value(r#"{"other":1}"#)));
        assert!(!accounting_counter(
            "tokens",
            &value(r#"{"cache":{"other":1}}"#)
        ));
        assert!(!accounting_counter("tokens", &value("{}")));
    }

    #[test]
    fn non_token_keys_are_never_counters() {
        assert!(!accounting_counter("visible", &value("7")));
    }
}
