// SPDX-License-Identifier: Apache-2.0
//! Zero pricing is credential-free evidence only for OpenCode Zen or OpenCode Go.
//!
//! Ports `packages/models/src/opencode-free.ts`.

use serde_json::Value;

const COST_TIERS_LIMIT: usize = 128;

fn price(value: Option<&Value>) -> Option<f64> {
    let price = value?.as_f64()?;
    (price >= 0.0).then_some(price)
}

fn tier(value: &Value) -> Option<(f64, f64, f64, f64)> {
    let entry = value.as_object()?;
    let cache = entry.get("cache")?.as_object()?;
    Some((
        price(entry.get("input"))?,
        price(entry.get("output"))?,
        price(cache.get("read"))?,
        price(cache.get("write"))?,
    ))
}

/// Whether the model is a free OpenCode Zen/Go choice (zero price on every tier).
pub fn free_opencode_model(value: &Value) -> bool {
    let Some(entry) = value.as_object() else {
        return false;
    };
    let Some(provider) = entry.get("providerID").and_then(Value::as_str) else {
        return false;
    };
    if entry.get("enabled").and_then(Value::as_bool) != Some(true) {
        return false;
    }
    if provider != "opencode" && provider != "opencode-zen" {
        return false;
    }
    let Some(costs) = entry.get("cost").and_then(Value::as_array) else {
        return false;
    };
    if costs.is_empty() || costs.len() > COST_TIERS_LIMIT {
        return false;
    }
    costs.iter().all(|cost| {
        tier(cost)
            .map(|(input, output, read, write)| {
                input == 0.0 && output == 0.0 && read == 0.0 && write == 0.0
            })
            .unwrap_or(false)
    })
}

#[cfg(test)]
mod tests {
    //! Ports the free-model rule the catalog-source cases rely on:
    //! `packages/models/src/catalog-source.process.test.ts`, "OpenCode lists free Zen
    //! and local LM Studio choices even when connected metadata is complete" — the
    //! free rows are the zero-priced `opencode/*` ones, never a paid subscription.

    use super::*;
    use serde_json::json;

    fn cost(input: f64, output: f64, read: f64, write: f64) -> Value {
        json!({ "input": input, "output": output, "cache": { "read": read, "write": write } })
    }

    #[test]
    fn zero_priced_enabled_zen_and_go_models_are_free() {
        for provider in ["opencode", "opencode-zen"] {
            assert!(free_opencode_model(&json!({
                "providerID": provider,
                "enabled": true,
                "cost": [cost(0.0, 0.0, 0.0, 0.0)],
            })));
        }
        assert!(free_opencode_model(&json!({
            "providerID": "opencode",
            "enabled": true,
            "cost": [cost(0.0, 0.0, 0.0, 0.0), cost(0.0, 0.0, 0.0, 0.0)],
        })));
    }

    #[test]
    fn paid_disabled_or_foreign_providers_are_not_free() {
        assert!(!free_opencode_model(&json!({
            "providerID": "opencode",
            "enabled": true,
            "cost": [cost(0.0, 0.0, 0.0, 0.5)],
        })));
        assert!(!free_opencode_model(&json!({
            "providerID": "opencode",
            "enabled": true,
            "cost": [cost(0.0, 0.0, 0.0, 0.0), cost(0.0, 0.1, 0.0, 0.0)],
        })));
        assert!(!free_opencode_model(&json!({
            "providerID": "opencode",
            "enabled": false,
            "cost": [cost(0.0, 0.0, 0.0, 0.0)],
        })));
        assert!(!free_opencode_model(&json!({
            "providerID": "anthropic",
            "enabled": true,
            "cost": [cost(0.0, 0.0, 0.0, 0.0)],
        })));
    }

    #[test]
    fn an_unreadable_cost_list_is_never_free() {
        assert!(!free_opencode_model(&json!({
            "providerID": "opencode",
            "enabled": true,
            "cost": [],
        })));
        assert!(!free_opencode_model(&json!({
            "providerID": "opencode",
            "enabled": true,
            "cost": [{ "input": 0, "output": 0, "cache": { "read": 0 } }],
        })));
        assert!(!free_opencode_model(&json!({
            "providerID": "opencode",
            "enabled": true,
            "cost": [cost(-1.0, 0.0, 0.0, 0.0)],
        })));
        assert!(!free_opencode_model(&json!("opencode")));
    }
}
