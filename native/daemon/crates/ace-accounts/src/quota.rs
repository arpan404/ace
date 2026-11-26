// SPDX-License-Identifier: Apache-2.0
//! Ingesting a provider's quota facts into an account's reading, from
//! `packages/accounts/src/quota.ts`. Only the provider's own usage-limit code holds an account;
//! free text that mentions a limit (a retried throttle, an echoed message) is no signal.

use ace_json::{Map, Value};
use indexmap::IndexMap;

use crate::billing::{reported_billing, BillingMode};
use crate::instance::Provider;
use crate::quota_decode::{decode_reset_credits, decode_windows};
use crate::reset_time::parse_limit_reset_words;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthState {
    Unknown,
    LoggedIn,
    LoggedOut,
}

impl AuthState {
    pub fn as_str(self) -> &'static str {
        match self {
            AuthState::Unknown => "unknown",
            AuthState::LoggedIn => "logged_in",
            AuthState::LoggedOut => "logged_out",
        }
    }

    pub fn parse(value: &str) -> Option<AuthState> {
        Some(match value {
            "logged_in" => AuthState::LoggedIn,
            "logged_out" => AuthState::LoggedOut,
            "unknown" => AuthState::Unknown,
            _ => return None,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowSource {
    Cli,
    StatusEstimate,
    LimitError,
}

impl WindowSource {
    pub fn as_str(self) -> &'static str {
        match self {
            WindowSource::Cli => "cli",
            WindowSource::StatusEstimate => "status_estimate",
            WindowSource::LimitError => "limit_error",
        }
    }
}

/// One window a provider reports (`QuotaWindow`). Times are epoch milliseconds.
#[derive(Clone, Debug, PartialEq)]
pub struct QuotaWindow {
    pub used_percent: f64,
    pub resets_at: Option<i64>,
    pub remaining_percent: Option<f64>,
    pub window_duration_mins: Option<f64>,
    pub source: Option<WindowSource>,
    pub limit_name: Option<String>,
    pub observed_at: Option<i64>,
    pub advisory: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Blockers {
    pub home_unavailable: Option<String>,
    pub overflow: bool,
    pub limit_error: Option<QuotaWindow>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Usage {
    pub input_tokens: Option<f64>,
    pub output_tokens: Option<f64>,
    pub cost_usd: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct QuotaResetCredits {
    pub available: u64,
    /// The soonest expiry among the listed credits; `Some(None)` is the protocol's `null`.
    pub next_expires_at: Option<Option<i64>>,
}

/// An account's replaceable quota reading (`AccountQuota`).
#[derive(Clone, Debug, PartialEq)]
pub struct AccountQuota {
    pub auth: AuthState,
    pub observed_at: i64,
    pub windows: IndexMap<String, QuotaWindow>,
    pub blockers: Blockers,
    pub usage: Usage,
    pub billing_mode: Option<BillingMode>,
    pub plan: Option<String>,
    pub reset_credits: Option<QuotaResetCredits>,
    pub cursor_sdk_auth: Option<Value>,
}

pub fn initial_quota() -> AccountQuota {
    AccountQuota {
        auth: AuthState::Unknown,
        observed_at: 0,
        windows: IndexMap::new(),
        blockers: Blockers::default(),
        usage: Usage::default(),
        billing_mode: None,
        plan: None,
        reset_credits: None,
        cursor_sdk_auth: None,
    }
}

/// One provider fact to read: the payload `ProviderPayload` decoded, when it was observed, and
/// the person's time zone for a usage-limit error's reset words.
pub struct QuotaFact {
    pub provider: Provider,
    pub payload: Value,
    pub observed_at: i64,
    pub time_zone: String,
}

pub struct Ingested {
    pub state: AccountQuota,
    pub raw: Value,
}

fn object(value: Option<&Value>) -> &Map {
    static EMPTY: std::sync::OnceLock<Map> = std::sync::OnceLock::new();
    value
        .and_then(Value::as_object)
        .unwrap_or_else(|| EMPTY.get_or_init(Map::new))
}

fn finite_nonnegative(value: Option<&Value>) -> Option<f64> {
    let number = value?.as_f64()?;
    (number.is_finite() && number >= 0.0).then_some(number)
}

fn bounded_string(value: Option<&Value>, max: usize) -> Option<&str> {
    let value = value.and_then(Value::as_str)?;
    (value.chars().count() <= max).then_some(value)
}

fn definite_limit(provider: Provider, body: &Map) -> Option<String> {
    if provider != Provider::Codex {
        return None;
    }
    let error = object(body.get("error"));
    let code = bounded_string(error.get("codexErrorInfo"), 128)?;
    if code != "usageLimitExceeded" {
        return None;
    }
    Some(
        bounded_string(error.get("message"), 16_384)
            .unwrap_or("")
            .to_string(),
    )
}

fn reset_credits_value(value: &Value) -> Option<QuotaResetCredits> {
    let row = value.as_object()?;
    let available = finite_nonnegative(row.get("available"))?;
    if available.fract() != 0.0 || available > 1_000_000.0 {
        return None;
    }
    let next = match row.get("nextExpiresAt") {
        None | Some(Value::Null) => Some(None),
        Some(value) => Some(Some(finite_nonnegative(Some(value))? as i64)),
    };
    Some(QuotaResetCredits {
        available: available as u64,
        next_expires_at: next,
    })
}

/// `ingestQuota`: the reading after this fact, and the payload's data kept raw.
pub fn ingest_quota(state: AccountQuota, fact: QuotaFact) -> Ingested {
    // ACP frames carry no quota; only ace's own usage-source reading (`usageWindows`) does.
    if fact.provider == Provider::Acp {
        let payload_body = object(Some(&fact.payload));
        if !payload_body.contains_key("usageWindows") {
            return Ingested {
                state,
                raw: fact.payload,
            };
        }
    }
    let raw = fact.payload.clone();
    if fact.observed_at < state.observed_at {
        return Ingested { state, raw };
    }
    let frame = object(Some(&raw));
    let body = frame.get("params").map_or(frame, |params| object(Some(params)));
    let decoded = decode_windows(fact.provider, body);
    let billing = reported_billing(body);
    let reset_credits = match fact.provider {
        Provider::Codex => decode_reset_credits(body),
        Provider::Claude => body.get("resetCredits").and_then(reset_credits_value),
        _ => None,
    };
    let mut blockers = state.blockers.clone();
    // Only the provider's own usage-limit code holds the account; its words only say when it
    // resets.
    let limited = definite_limit(fact.provider, body);
    if let Some(message) = &limited {
        blockers.limit_error = Some(QuotaWindow {
            used_percent: 100.0,
            resets_at: parse_limit_reset_words(message, fact.observed_at, &fact.time_zone),
            remaining_percent: None,
            window_duration_mins: None,
            source: Some(WindowSource::LimitError),
            limit_name: None,
            observed_at: Some(fact.observed_at),
            advisory: false,
        });
    }
    let auth = body.get("auth").and_then(Value::as_str).and_then(AuthState::parse);
    let usage_body = body
        .get("tokenUsage")
        .and_then(Value::as_object)
        .and_then(|usage| usage.get("total"))
        .or_else(|| body.get("usage"))
        .or_else(|| body.get("session"));
    let usage_body = object(usage_body);
    let mut usage = Usage::default();
    usage.input_tokens = finite_nonnegative(
        usage_body
            .get("input_tokens")
            .or_else(|| usage_body.get("inputTokens")),
    );
    usage.output_tokens = finite_nonnegative(
        usage_body
            .get("output_tokens")
            .or_else(|| usage_body.get("outputTokens")),
    );
    usage.cost_usd = finite_nonnegative(
        body.get("total_cost_usd")
            .or_else(|| {
                body.get("session")
                    .and_then(Value::as_object)
                    .and_then(|session| session.get("total_cost_usd"))
            })
            .or_else(|| usage_body.get("total_cost_usd"))
            .or_else(|| usage_body.get("costUsd")),
    );
    if !auth.is_some()
        && billing.billing_mode.is_none()
        && billing.plan.is_none()
        && decoded.count == 0
        && !decoded.overflow
        && usage == Usage::default()
        && limited.is_none()
        && reset_credits.is_none()
    {
        return Ingested { state, raw };
    }
    let mut windows = if decoded.authoritative && decoded.complete && decoded.count > 0 {
        IndexMap::new()
    } else {
        state.windows.clone()
    };
    if decoded.complete && decoded.count > 0 {
        if limited.is_none() {
            blockers.limit_error = None;
        }
        if decoded.authoritative {
            blockers.overflow = false;
        }
    }
    let mut count = windows.len();
    for (name, window) in &decoded.windows {
        let mut window = window.clone();
        window.observed_at = Some(fact.observed_at);
        if windows.contains_key(name) {
            windows.insert(name.clone(), window);
        } else if count < 32 {
            windows.insert(name.clone(), window);
            count += 1;
        } else {
            blockers.overflow = true;
        }
    }
    if decoded.overflow {
        blockers.overflow = true;
    }
    let mut next = state;
    next.billing_mode = billing.billing_mode.or(next.billing_mode);
    if billing.plan.is_some() {
        next.plan = billing.plan;
    } else if billing.billing_mode == Some(BillingMode::Api) {
        next.plan = None;
    }
    if let Some(auth) = auth {
        if auth != AuthState::Unknown {
            next.auth = auth;
        }
    }
    if let Some(credits) = reset_credits {
        next.reset_credits = Some(credits);
    }
    next.observed_at = fact.observed_at;
    next.windows = windows;
    next.blockers = blockers;
    next.usage.input_tokens = usage.input_tokens.or(next.usage.input_tokens);
    next.usage.output_tokens = usage.output_tokens.or(next.usage.output_tokens);
    next.usage.cost_usd = usage.cost_usd.or(next.usage.cost_usd);
    Ingested { state: next, raw }
}

/// The raw data of a payload that is not an object still carries no readable facts.
pub fn payload_data(value: &Value) -> &Value {
    value
        .as_object()
        .and_then(|frame| frame.get("data"))
        .unwrap_or(value)
}

#[cfg(test)]
mod tests {
    use ace_json::parse;

    use super::*;
    use crate::availability::{availability, Availability};

    fn payload(value: &str) -> Value {
        parse(value).unwrap_or(Value::Null)
    }

    fn codex_state() -> AccountQuota {
        let mut state = initial_quota();
        state.auth = AuthState::LoggedIn;
        state
    }

    fn codex(state: AccountQuota, percent: f64, now: i64, resets_at: Option<f64>) -> AccountQuota {
        let text = format!(
            r#"{{"method":"account/rateLimits/updated","params":{{"rateLimits":{{"primary":{{"usedPercent":{percent},"resetsAt":{}}}}}}}}}"#,
            resets_at.map_or("null".to_string(), |value| value.to_string())
        );
        ingest_quota(
            state,
            QuotaFact {
                provider: Provider::Codex,
                payload: payload(&text),
                observed_at: now,
                time_zone: "UTC".into(),
            },
        )
        .state
    }

    // packages/accounts/src/quota.process.test.ts
    // "only Codex's own usage-limit code holds an account, never words that mention a limit"
    #[test]
    fn only_codexs_own_usage_limit_code_holds_an_account() {
        let now = 1_790_000_000_000;
        for payload_text in [
            r#"{"message":"Usage limit reached"}"#,
            r#"{"error":"You've hit your usage limit"}"#,
            r#"{"method":"error","params":{"error":{"message":"Rate limit reached for gpt-6.1 on tokens per min","codexErrorInfo":"rateLimitExceeded"}}}"#,
        ] {
            let state = ingest_quota(
                codex_state(),
                QuotaFact {
                    provider: Provider::Codex,
                    payload: payload(payload_text),
                    observed_at: now,
                    time_zone: "UTC".into(),
                },
            )
            .state;
            assert_eq!(availability(&state, now), Availability::Available);
        }
        let limited = ingest_quota(
            codex_state(),
            QuotaFact {
                provider: Provider::Codex,
                payload: payload(
                    r#"{"method":"error","params":{"error":{"message":"You've hit your usage limit. Try again later.","codexErrorInfo":"usageLimitExceeded"}}}"#,
                ),
                observed_at: now,
                time_zone: "UTC".into(),
            },
        )
        .state;
        assert_eq!(availability(&limited, now), Availability::Exhausted);
    }

    // "old rate-limit updates cannot restore a newly exhausted account"
    #[test]
    fn old_rate_limit_updates_cannot_restore_a_newly_exhausted_account() {
        let now = 1_790_000_000_000;
        let exhausted = codex(codex_state(), 100.0, now, Some((now + 3_600_000) as f64 / 1000.0));
        let older = codex(exhausted, 0.0, now - 1, Some((now + 3_600_000) as f64 / 1000.0));
        assert_eq!(availability(&older, now), Availability::Exhausted);
    }

    // "unknown and malformed facts return raw unchanged and do not reset quota"
    #[test]
    fn unknown_and_malformed_facts_return_raw_unchanged_and_do_not_reset_quota() {
        let now = 1_790_000_000_000;
        let state = codex(codex_state(), 100.0, now, Some((now + 3_600_000) as f64 / 1000.0));
        let payload = payload(
            r#"{"method":"future","params":{"rateLimits":{"primary":{"usedPercent":"oops"}},"secret":{"future":true}}}"#,
        );
        let result = ingest_quota(
            state.clone(),
            QuotaFact {
                provider: Provider::Codex,
                payload: payload.clone(),
                observed_at: now + 1,
                time_zone: "UTC".into(),
            },
        );
        assert_eq!(result.raw, payload);
        assert_eq!(result.state, state);
    }

    // "logged-out accounts stay unavailable even when quota has reset"
    #[test]
    fn logged_out_accounts_stay_unavailable_even_when_quota_has_reset() {
        let now = 1_790_000_000_000;
        let state = ingest_quota(
            codex(codex_state(), 100.0, now, Some((now + 3_600_000) as f64 / 1000.0)),
            QuotaFact {
                provider: Provider::Codex,
                payload: payload(r#"{"auth":"logged_out"}"#),
                observed_at: now + 1,
                time_zone: "UTC".into(),
            },
        )
        .state;
        assert_eq!(availability(&state, now + 86_400_000), Availability::LoggedOut);
    }

    // "a rejection without a reported reset holds only while it is fresh"
    #[test]
    fn a_rejection_without_a_reported_reset_holds_only_while_it_is_fresh() {
        let now = 1_790_000_000_000;
        let state = ingest_quota(
            codex_state(),
            QuotaFact {
                provider: Provider::Claude,
                payload: payload(r#"{"rate_limit_info":{"status":"rejected"}}"#),
                observed_at: now,
                time_zone: "UTC".into(),
            },
        )
        .state;
        assert_eq!(availability(&state, now + 1), Availability::Exhausted);
        assert_eq!(availability(&state, now + 86_400_000), Availability::Available);
    }

    #[test]
    fn a_later_reset_on_a_second_window_keeps_the_account_exhausted() {
        let now = 1_790_000_000_000;
        let state = ingest_quota(
            codex_state(),
            QuotaFact {
                provider: Provider::Codex,
                payload: payload(&format!(
                    r#"{{"rateLimitsByLimitId":{{"codex":{{"primary":{{"usedPercent":100,"resetsAt":{}}},"secondary":{{"usedPercent":100,"resetsAt":{}}}}}}}}}"#,
                    now / 1000 + 1,
                    now / 1000 + 100
                )),
                observed_at: now,
                time_zone: "UTC".into(),
            },
        )
        .state;
        assert_eq!(availability(&state, now + 2_000), Availability::Exhausted);
        assert_eq!(availability(&state, now + 100_000), Availability::Available);
    }

    #[test]
    fn the_reported_plan_survives_a_sparse_update_and_an_api_mode_clears_it() {
        let now = 1_790_000_000_000;
        let with_plan = ingest_quota(
            codex_state(),
            QuotaFact {
                provider: Provider::Claude,
                payload: payload(r#"{"planType":"max","rate_limits":{"five_hour":{"utilization":1}}}"#),
                observed_at: now,
                time_zone: "UTC".into(),
            },
        )
        .state;
        assert_eq!(with_plan.plan.as_deref(), Some("max"));
        let sparse = ingest_quota(
            with_plan,
            QuotaFact {
                provider: Provider::Claude,
                payload: payload(r#"{"auth":"logged_in"}"#),
                observed_at: now + 1,
                time_zone: "UTC".into(),
            },
        )
        .state;
        assert_eq!(sparse.plan.as_deref(), Some("max"));
        let api = ingest_quota(
            sparse,
            QuotaFact {
                provider: Provider::Claude,
                payload: payload(r#"{"billingMode":"api"}"#),
                observed_at: now + 2,
                time_zone: "UTC".into(),
            },
        )
        .state;
        assert_eq!(api.plan, None);
        assert_eq!(api.billing_mode, Some(BillingMode::Api));
    }
}
