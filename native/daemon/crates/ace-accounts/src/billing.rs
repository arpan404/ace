// SPDX-License-Identifier: Apache-2.0
//! Billing facts from a provider's status body, from `packages/accounts/src/billing.ts`. OAuth
//! alone never establishes a billing mode.

use ace_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BillingMode {
    Api,
    Subscription,
    Unknown,
}

impl BillingMode {
    pub fn as_str(self) -> &'static str {
        match self {
            BillingMode::Api => "api",
            BillingMode::Subscription => "subscription",
            BillingMode::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Billing {
    pub billing_mode: Option<BillingMode>,
    pub plan: Option<String>,
}

fn string(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

/// `reportedBilling`: the body's explicit mode first, else the sign-in method's kind.
pub fn reported_billing(body: &ace_json::Map) -> Billing {
    let explicit = string(body.get("billingMode")).and_then(|value| match value {
        "api" => Some(BillingMode::Api),
        "subscription" => Some(BillingMode::Subscription),
        "unknown" => Some(BillingMode::Unknown),
        _ => None,
    });
    let method = string(body.get("authDetail"))
        .or_else(|| string(body.get("authMethod")))
        .or_else(|| string(body.get("authMode")));
    let billing_mode = explicit.or_else(|| {
        let method = method?;
        if ["API key", "api_key", "apiKey", "apikey", "api_key_helper"].contains(&method) {
            Some(BillingMode::Api)
        } else if ["ChatGPT", "chatgpt", "chatgptAuthTokens", "claude.ai"].contains(&method) {
            Some(BillingMode::Subscription)
        } else {
            Some(BillingMode::Unknown)
        }
    });
    let plan_value = body.get("planType").or_else(|| {
        body.get("rateLimits")
            .and_then(Value::as_object)
            .and_then(|limits| limits.get("planType"))
    });
    // `planType` is a zod string `.min(1).max(128)`: code points, rule 17.
    let plan = string(plan_value)
        .filter(|value| !value.is_empty() && value.chars().count() <= 128)
        .map(str::to_string);
    Billing { billing_mode, plan }
}

#[cfg(test)]
mod tests {
    use ace_json::parse;

    use super::*;

    fn body(value: &str) -> ace_json::Map {
        parse(value)
            .ok()
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default()
    }

    #[test]
    fn an_api_key_sign_in_is_api_billing_and_chatgpt_is_subscription() {
        assert_eq!(
            reported_billing(&body(r#"{"authMethod":"API key"}"#)).billing_mode,
            Some(BillingMode::Api)
        );
        assert_eq!(
            reported_billing(&body(r#"{"authDetail":"chatgpt"}"#)).billing_mode,
            Some(BillingMode::Subscription)
        );
        // OAuth is its own method, not a billing mode.
        assert_eq!(
            reported_billing(&body(r#"{"authMode":"oauth"}"#)).billing_mode,
            Some(BillingMode::Unknown)
        );
        assert_eq!(reported_billing(&body("{}")).billing_mode, None);
    }

    #[test]
    fn an_explicit_mode_wins_and_the_plan_keeps_its_bounded_words() {
        let billing = reported_billing(&body(
            r#"{"billingMode":"api","authMethod":"ChatGPT","planType":"max"}"#,
        ));
        assert_eq!(billing.billing_mode, Some(BillingMode::Api));
        assert_eq!(billing.plan.as_deref(), Some("max"));
        let nested = reported_billing(&body(r#"{"rateLimits":{"planType":"pro"}}"#));
        assert_eq!(nested.plan.as_deref(), Some("pro"));
        // 128 emoji are 128 code points (rule 17), but 129 are over the bound.
        let plan = "😀".repeat(128);
        let accepted = reported_billing(&body(&format!(r#"{{"planType":"{plan}"}}"#)));
        assert_eq!(accepted.plan.map(|plan| plan.chars().count()), Some(128));
        let rejected =
            reported_billing(&body(&format!(r#"{{"planType":"{}"}}"#, "😀".repeat(129))));
        assert_eq!(rejected.plan, None);
    }
}
