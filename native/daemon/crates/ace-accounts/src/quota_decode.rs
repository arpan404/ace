// SPDX-License-Identifier: Apache-2.0
//! Provider quota payloads to ace's window readings, from `packages/accounts/src/quota-decode.ts`.
//! A malformed entry consumes the same small budget as a good one, and nothing is enumerated
//! past it: provider data never makes the daemon do unbounded work.

use ace_json::{Map, Value};
use indexmap::IndexMap;

use crate::instance::Provider;
use crate::quota::{QuotaResetCredits, QuotaWindow, WindowSource};
use crate::reset_time::parse_date;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct DecodedWindows {
    pub windows: IndexMap<String, QuotaWindow>,
    pub count: usize,
    pub overflow: bool,
    pub complete: bool,
    pub authoritative: bool,
}

fn finite_nonnegative(value: Option<&Value>) -> Option<f64> {
    let number = value?.as_f64()?;
    (number.is_finite() && number >= 0.0).then_some(number)
}

fn string_own(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

/// A zod `.min().max()` string counts code points (rule 17).
fn bounded(value: Option<&Value>, min: usize, max: usize) -> Option<&str> {
    let value = string_own(value)?;
    let count = value.chars().count();
    (count >= min && count <= max).then_some(value)
}

/// `reset`: epoch seconds as a number, or an instant as a string, to epoch milliseconds.
pub fn reset(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::String(text) => {
            let text = text.as_str();
            if text.chars().count() > 128 {
                return None;
            }
            parse_date(text).filter(|instant| *instant >= 0)
        }
        other => {
            let number = other.as_f64()?;
            if !number.is_finite() || number < 0.0 || !(number * 1000.0).is_finite() {
                return None;
            }
            Some((number * 1000.0) as i64)
        }
    }
}

#[derive(Default)]
struct WindowDetails {
    window_duration_mins: Option<f64>,
    limit_name: Option<String>,
    advisory: bool,
    source: Option<WindowSource>,
    /// The TypeScript explicitly sets `remainingPercent: undefined` for an estimate.
    omit_remaining: bool,
}

#[allow(clippy::too_many_arguments)]
fn put(
    windows: &mut IndexMap<String, QuotaWindow>,
    count: &mut usize,
    name: &str,
    used_percent: f64,
    resets_at: Option<i64>,
    details: WindowDetails,
    overflow: &mut bool,
    complete: &mut bool,
) {
    // `name.length > 128` is UTF-16 units in the TypeScript (rule 17).
    if name.is_empty()
        || name.encode_utf16().count() > 128
        || ["__proto__", "constructor", "prototype"].contains(&name)
    {
        *complete = false;
        return;
    }
    if !windows.contains_key(name) {
        if *count >= 32 {
            *overflow = true;
            return;
        }
        *count += 1;
    }
    windows.insert(
        name.to_string(),
        QuotaWindow {
            used_percent: used_percent.min(100.0),
            resets_at,
            remaining_percent: if details.omit_remaining {
                None
            } else {
                Some((100.0 - used_percent).max(0.0))
            },
            window_duration_mins: details.window_duration_mins,
            source: Some(details.source.unwrap_or(WindowSource::Cli)),
            limit_name: details.limit_name,
            observed_at: None,
            advisory: details.advisory,
        },
    );
}

/// Whether a name may be stored at all (the TypeScript's `put` refuses these too).
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.encode_utf16().count() <= 128
        && !["__proto__", "constructor", "prototype"].contains(&name)
}

fn neutral_window(value: &Value) -> Option<(f64, Option<i64>, Option<f64>, Option<String>, bool)> {
    let row = value.as_object()?;
    let used = finite_nonnegative(row.get("usedPercent"))?;
    if used > 100.0 {
        return None;
    }
    let resets_at = match row.get("resetsAt") {
        None | Some(Value::Null) => None,
        Some(value) => Some(finite_nonnegative(Some(value))? as i64),
    };
    let duration = finite_nonnegative(row.get("windowDurationMins")).filter(|value| *value > 0.0);
    let limit_name = bounded(row.get("limitName"), 1, 128).map(str::to_string);
    let advisory = matches!(row.get("advisory"), Some(Value::Bool(true)));
    Some((used, resets_at, duration, limit_name, advisory))
}

fn codex_window(value: &Value) -> Option<(f64, Option<i64>, Option<f64>)> {
    let row = value.as_object()?;
    let used = finite_nonnegative(row.get("usedPercent"))?;
    let resets_at = reset(row.get("resetsAt"));
    let duration = finite_nonnegative(row.get("windowDurationMins")).filter(|value| *value > 0.0);
    Some((used, resets_at, duration))
}

struct ClaudeWindow {
    status: Option<String>,
    utilization: Option<f64>,
    resets_at: Option<i64>,
    rate_limit_type: Option<String>,
}

fn claude_window(value: &Value) -> Option<ClaudeWindow> {
    let row = value.as_object()?;
    let status = string_own(row.get("status"))
        .filter(|value| ["allowed", "allowed_warning", "rejected"].contains(value))
        .map(str::to_string);
    if row.contains_key("status") && status.is_none() {
        return None;
    }
    let utilization = match row.get("utilization") {
        None => None,
        Some(value) => Some(finite_nonnegative(Some(value))?),
    };
    let resets_at = match row.get("resetsAt").or_else(|| row.get("resets_at")) {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => {
            if text.as_str().chars().count() > 128 {
                return None;
            }
            // An unreadable instant is a null reset, not a malformed window.
            parse_date(text.as_str())
        }
        Some(value) => Some((finite_nonnegative(Some(value))? * 1000.0) as i64),
    };
    let rate_limit_type = bounded(row.get("rateLimitType"), 1, 128).map(str::to_string);
    Some(ClaudeWindow {
        status,
        utilization,
        resets_at,
        rate_limit_type,
    })
}

/// `decodeWindows`.
pub fn decode_windows(provider: Provider, body: &Map) -> DecodedWindows {
    let mut windows: IndexMap<String, QuotaWindow> = IndexMap::new();
    let mut count = 0usize;
    let mut overflow = false;
    let mut complete = true;
    let authoritative = body.contains_key("rateLimitsByLimitId")
        || body.contains_key("rate_limits")
        || body.contains_key("usageWindows");
    if let Some(value) = body.get("usageWindows") {
        match value.as_object() {
            None => complete = false,
            Some(rows) => {
                let mut inspected = 0;
                for (name, value) in rows {
                    if inspected + 1 > 32 {
                        overflow = true;
                        break;
                    }
                    inspected += 1;
                    if !valid_name(name.as_str()) {
                        complete = false;
                        continue;
                    }
                    match neutral_window(value) {
                        Some((used, resets, duration, limit_name, advisory)) => put(
                            &mut windows,
                            &mut count,
                            name.as_str(),
                            used,
                            resets,
                            WindowDetails {
                                window_duration_mins: duration,
                                limit_name,
                                advisory,
                                ..Default::default()
                            },
                            &mut overflow,
                            &mut complete,
                        ),
                        None => complete = false,
                    }
                }
            }
        }
    }
    if provider == Provider::Codex {
        let mut snapshot = |key: &str, value: &Value| {
            let Some(row) = value.as_object() else {
                complete = false;
                return;
            };
            let label = if !row.contains_key("limitId") {
                key.to_string()
            } else if let Some(label) = bounded(row.get("limitId"), 1, 100) {
                label.to_string()
            } else {
                complete = false;
                return;
            };
            let limit_name = bounded(row.get("limitName"), 1, 128).map(str::to_string);
            let mut present = false;
            for name in ["primary", "secondary"] {
                let Some(value) = row.get(name) else { continue };
                if value.is_null() {
                    continue;
                }
                present = true;
                let Some((used, resets, duration)) = codex_window(value) else {
                    complete = false;
                    continue;
                };
                let window_name = format!("{label}:{name}");
                if !valid_name(&window_name) {
                    complete = false;
                    continue;
                }
                put(
                    &mut windows,
                    &mut count,
                    &window_name,
                    used,
                    resets,
                    WindowDetails {
                        window_duration_mins: duration,
                        limit_name: limit_name.clone(),
                        ..Default::default()
                    },
                    &mut overflow,
                    &mut complete,
                );
            }
            if !present {
                complete = false;
            }
        };
        if let Some(rows) = body.get("rateLimitsByLimitId").and_then(Value::as_object) {
            for (key, value) in rows {
                snapshot(key.as_str(), value);
            }
        } else if let Some(value) = body.get("rateLimits") {
            snapshot("default", value);
        }
    }
    if provider == Provider::Claude {
        if let Some(info_value) = body.get("rate_limit_info") {
            match claude_window(info_value) {
                None => complete = false,
                Some(event) => {
                    if event.status.is_none() && event.utilization.is_none() {
                        complete = false;
                    } else {
                        if let Some(rows) = info_value
                            .as_object()
                            .and_then(|info| info.get("unifiedWindows"))
                            .and_then(Value::as_object)
                        {
                            for (name, value) in rows {
                                match claude_window(value) {
                                    Some(window) if window.utilization.is_some() => put(
                                        &mut windows,
                                        &mut count,
                                        name.as_str(),
                                        window.utilization.unwrap_or(0.0) * 100.0,
                                        window.resets_at,
                                        WindowDetails::default(),
                                        &mut overflow,
                                        &mut complete,
                                    ),
                                    _ => complete = false,
                                }
                            }
                        }
                        let name = event.rate_limit_type.clone().unwrap_or_else(|| "default".into());
                        if event.status.as_deref() == Some("rejected") || !windows.contains_key(&name)
                        {
                            let used = if event.status.as_deref() == Some("rejected") {
                                100.0
                            } else if let Some(utilization) = event.utilization {
                                utilization * 100.0
                            } else if event.status.as_deref() == Some("allowed_warning") {
                                80.0
                            } else {
                                0.0
                            };
                            put(
                                &mut windows,
                                &mut count,
                                &name,
                                used,
                                event.resets_at,
                                WindowDetails {
                                    source: (event.utilization.is_none())
                                        .then_some(WindowSource::StatusEstimate),
                                    omit_remaining: event.utilization.is_none(),
                                    ..Default::default()
                                },
                                &mut overflow,
                                &mut complete,
                            );
                        }
                    }
                }
            }
        }
        if let Some(rows) = body.get("rate_limits").and_then(Value::as_object) {
            for (name, value) in rows {
                match claude_window(value) {
                    Some(window) if window.utilization.is_some() => put(
                        &mut windows,
                        &mut count,
                        name.as_str(),
                        window.utilization.unwrap_or(0.0),
                        window.resets_at,
                        WindowDetails::default(),
                        &mut overflow,
                        &mut complete,
                    ),
                    _ => complete = false,
                }
            }
        }
    }
    DecodedWindows {
        windows,
        count,
        overflow,
        complete: complete && !overflow,
        authoritative,
    }
}

/// Codex's banked resets (`rateLimitResetCredits`): how many are available and the soonest
/// expiry among the listed available ones.
pub fn decode_reset_credits(body: &Map) -> Option<QuotaResetCredits> {
    let summary = body.get("rateLimitResetCredits")?.as_object()?;
    let count = finite_nonnegative(summary.get("availableCount"))?;
    if count.fract() != 0.0 || count > 1_000_000.0 {
        return None;
    }
    let credits = match summary.get("credits") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) if items.len() <= 256 => items.to_vec(),
        Some(_) => return None,
    };
    let mut next_expires_at: Option<i64> = None;
    for entry in credits {
        let Some(credit) = entry.as_object() else { continue };
        if let Some(status) = credit.get("status").and_then(Value::as_str) {
            if status.chars().count() > 64 || status != "available" {
                continue;
            }
        }
        if let Some(expires) = reset(credit.get("expiresAt")) {
            next_expires_at = Some(next_expires_at.map_or(expires, |current| current.min(expires)));
        }
    }
    Some(QuotaResetCredits {
        available: count as u64,
        next_expires_at: Some(next_expires_at),
    })
}

#[cfg(test)]
mod tests {
    use ace_json::parse;

    use super::*;

    fn body(value: &str) -> Map {
        parse(value)
            .ok()
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default()
    }

    // packages/accounts/src/quota.process.test.ts
    // "a Claude usage read records its 5-hour and weekly windows, resets and plan"
    #[test]
    fn a_claude_usage_read_records_its_windows_and_resets() {
        let decoded = decode_windows(
            Provider::Claude,
            &body(
                r#"{"rate_limits":{"five_hour":{"utilization":42,"resets_at":"2026-10-02T18:00:00.000Z"},"seven_day":{"utilization":100,"resets_at":"2026-10-05T09:00:00.000Z"}},"planType":"max"}"#,
            ),
        );
        assert_eq!(decoded.count, 2);
        assert!(!decoded.overflow);
        let five = decoded.windows.get("five_hour").expect("five-hour window");
        assert_eq!(five.used_percent, 42.0);
        assert_eq!(five.resets_at, parse_date("2026-10-02T18:00:00.000Z"));
    }

    #[test]
    fn a_codex_snapshot_names_each_window_and_clamps_percentages() {
        let decoded = decode_windows(
            Provider::Codex,
            &body(
                r#"{"rateLimitsByLimitId":{"codex":{"primary":{"usedPercent":120,"resetsAt":100},"secondary":null}}}"#,
            ),
        );
        assert_eq!(decoded.count, 1);
        let window = decoded.windows.get("codex:primary").expect("primary window");
        assert_eq!(window.used_percent, 100.0);
        assert_eq!(window.resets_at, Some(100_000));
        assert_eq!(window.remaining_percent, Some(0.0));
    }

    #[test]
    fn a_malformed_entry_consumes_the_same_small_budget_and_marks_the_read_incomplete() {
        let mut entries = String::from("{");
        for index in 0..40 {
            if index > 0 {
                entries.push(',');
            }
            entries.push_str(&format!(r#""w{index}":{{"usedPercent":1,"resetsAt":null}}"#));
        }
        entries.push('}');
        let decoded =
            decode_windows(Provider::Claude, &body(&format!(r#"{{"usageWindows":{entries}}}"#)));
        assert_eq!(decoded.count, 32);
        assert!(decoded.overflow);
        assert!(!decoded.complete);
        // A malformed entry marks the read incomplete, and the good ones still arrive.
        let decoded = decode_windows(
            Provider::Claude,
            &body(r#"{"usageWindows":{"bad":{"usedPercent":"oops"},"good":{"usedPercent":10}}}"#),
        );
        assert_eq!(decoded.count, 1);
        assert!(!decoded.complete);
    }

    #[test]
    fn banked_resets_count_only_available_credits_and_take_the_soonest_expiry() {
        let credits = decode_reset_credits(&body(
            r#"{"rateLimitResetCredits":{"availableCount":2,"credits":[{"status":"available","expiresAt":100},{"status":"used","expiresAt":50},{"status":"available","expiresAt":80}]}}"#,
        ));
        assert_eq!(
            credits,
            Some(QuotaResetCredits {
                available: 2,
                next_expires_at: Some(Some(80_000)),
            })
        );
        assert_eq!(decode_reset_credits(&body("{}")), None);
    }
}
