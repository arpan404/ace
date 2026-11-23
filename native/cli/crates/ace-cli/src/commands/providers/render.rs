// SPDX-License-Identifier: Apache-2.0//! Shared human rendering for the providers commands: aligned columns, counts and ages.
//!
//! Ports `apps/daemon/src/cli/render/provider-columns.ts` and the `formatAge`/`formatAgo`
//! wording of `@ace/ui-core/time`, which the device, machine and MCP lists print.
//!
//! The shared human rendering for the providers commands: `render.rs` prints, the command
//! files fetch.

use serde_json::Value;

/// Aligned columns: each cell padded to its column's widest, empty trailing cells dropped,
/// two spaces between. Widths count code points, so a name with accents lines up.
#[must_use]
pub fn columns(rows: &[Vec<Option<String>>]) -> Vec<String> {
    let mut widths: Vec<usize> = Vec::new();
    for row in rows {
        for (index, cell) in row.iter().enumerate() {
            let len = cell.as_deref().unwrap_or("").chars().count();
            if widths.len() <= index {
                widths.push(len);
            } else if widths[index] < len {
                widths[index] = len;
            }
        }
    }
    rows.iter()
        .map(|row| {
            let last = row
                .iter()
                .rposition(|cell| cell.as_deref().is_some_and(|text| !text.is_empty()));
            let Some(last) = last else {
                return String::new();
            };
            row[..=last]
                .iter()
                .enumerate()
                .map(|(index, cell)| {
                    let text = cell.as_deref().unwrap_or("");
                    if index == last {
                        text.to_owned()
                    } else {
                        pad(text, widths.get(index).copied().unwrap_or(0))
                    }
                })
                .collect::<Vec<_>>()
                .join("  ")
        })
        .collect()
}

fn pad(text: &str, width: usize) -> String {
    let missing = width.saturating_sub(text.chars().count());
    format!("{text}{}", " ".repeat(missing))
}

/// A count and its noun: "1 model", "3 models".
#[must_use]
pub fn count(n: usize, noun: &str) -> String {
    format!("{n} {noun}{}", if n == 1 { "" } else { "s" })
}

/// "now", "2m", "3h", "4d", "6w": the compact age between two millisecond timestamps.
#[must_use]
pub fn format_age(at_ms: i64, now_ms: i64) -> String {
    let raw = now_ms - at_ms;
    let seconds = if raw <= 0 { 0 } else { (raw + 500) / 1_000 };
    if seconds < 45 {
        return "now".to_owned();
    }
    let minutes = (seconds + 30) / 60;
    if minutes < 60 {
        return format!("{minutes}m");
    }
    let hours = (minutes + 30) / 60;
    if hours < 24 {
        return format!("{hours}h");
    }
    let days = (hours + 12) / 24;
    if days < 14 {
        return format!("{days}d");
    }
    format!("{}w", (days + 3) / 7)
}

/// "just now", "2m ago": an age in a sentence.
#[must_use]
pub fn format_ago(at_ms: i64, now_ms: i64) -> String {
    let age = format_age(at_ms, now_ms);
    if age == "now" {
        "just now".to_owned()
    } else {
        format!("{age} ago")
    }
}

/// `new Date(ms).toISOString()`: always `YYYY-MM-DDTHH:MM:SS.sssZ`.
#[must_use]
pub fn iso8601_millis(ms: i64) -> String {
    let secs = ms.div_euclid(1_000);
    let milli = ms.rem_euclid(1_000);
    let days = secs.div_euclid(86_400);
    let time = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{milli:03}Z",
        time / 3_600,
        (time % 3_600) / 60,
        time % 60,
    )
}

/// Days since 1970-01-01 to year, month, day (Howard Hinnant's civil algorithm).
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[must_use]
pub fn provider_element_raw(reply: &super::session::WireReply, provider: &str) -> Option<String> {
    let array = reply.result_field_raw("providers")?;
    let elements: Vec<Box<serde_json::value::RawValue>> = serde_json::from_str(&array).ok()?;
    elements.into_iter().find_map(|element| {
        let status: Value = serde_json::from_str(element.get()).ok()?;
        if status.get("provider").and_then(Value::as_str) == Some(provider) {
            Some(element.get().to_owned())
        } else {
            None
        }
    })
}

/// `--quiet`: one provider, or every provider a list names.
#[must_use]
pub fn quiet_of_show(json: &Value, is_show: bool) -> Vec<String> {
    if is_show {
        return json
            .get("provider")
            .and_then(Value::as_str)
            .map(|provider| vec![provider.to_owned()])
            .unwrap_or_default();
    }
    json.get("providers")
        .and_then(Value::as_array)
        .map(|providers| {
            providers
                .iter()
                .filter_map(|status| status.get("provider").and_then(Value::as_str))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// The fields at `key`, whether the daemon nested them or not.
#[must_use]
pub fn array_at<'a>(value: &'a Value, key: &str) -> Option<&'a Vec<Value>> {
    if let Some(inner) = value.get(key).and_then(Value::as_array) {
        return Some(inner);
    }
    if let Some(result) = value.get("result") {
        return array_at(result, key);
    }
    None
}

#[must_use]
pub fn is_record(value: &Value) -> bool {
    value.is_object()
}

#[must_use]
pub fn model_ids(value: &Value) -> Vec<String> {
    value
        .get("models")
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(|model| model.get("id").and_then(Value::as_str))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

#[must_use]
pub fn live(grant: &Value, now: i64) -> bool {
    if !grant.get("revokedAt").is_some_and(Value::is_null) {
        return false;
    }
    grant
        .get("expiresAt")
        .is_some_and(|at| at.is_null() || as_i64(at).is_some_and(|ends| ends > now))
}

#[must_use]
pub fn scope_words(scopes: &Value) -> String {
    scopes
        .as_array()
        .map(|scopes| {
            scopes
                .iter()
                .filter_map(Value::as_str)
                .map(|scope| scope.replace("threads:", ""))
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default()
}

#[must_use]
pub fn mcp_list_lines(value: &Value, now: i64) -> Vec<String> {
    let url = value.get("url").and_then(Value::as_str).unwrap_or("");
    let grants = value
        .get("grants")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let current: Vec<&Value> = grants.iter().filter(|grant| live(grant, now)).collect();
    let ended = grants.len().saturating_sub(current.len());
    let mut lines = vec![format!("Outside clients connect to {url}")];
    if current.is_empty() {
        lines.push("No clients have access. Add one with ace mcp add.".to_owned());
    } else {
        lines.push(String::new());
        lines.extend(columns(
            &current
                .iter()
                .map(|grant| {
                    vec![
                        grant.get("id").and_then(Value::as_str).map(str::to_owned),
                        grant.get("name").and_then(Value::as_str).map(str::to_owned),
                        grant.get("scopes").map(scope_words),
                        grant.get("expiresAt").map(|at| {
                            if at.is_null() {
                                "until revoked".to_owned()
                            } else {
                                as_i64(at)
                                    .map(|ends| format!("ends in {}", format_age(now, ends)))
                                    .unwrap_or_default()
                            }
                        }),
                        grant.get("lastUsedAt").and_then(as_i64).map_or_else(
                            || Some("never used".to_owned()),
                            |at| Some(format!("used {}", format_ago(at, now))),
                        ),
                    ]
                })
                .collect::<Vec<_>>(),
        ));
    }
    if ended > 0 {
        lines.push(String::new());
        lines.push(format!("{ended} ended. --json lists them."));
    }
    lines
}

#[must_use]
pub fn grant_ids(value: &Value, now: i64) -> Vec<String> {
    value
        .get("grants")
        .and_then(Value::as_array)
        .map(|grants| {
            grants
                .iter()
                .filter(|grant| live(grant, now))
                .filter_map(|grant| grant.get("id").and_then(Value::as_str))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

#[must_use]
pub fn mcp_added_lines(data: &Value) -> Vec<String> {
    let id = data.get("id").and_then(Value::as_str).unwrap_or("");
    let expires = data.get("expiresAt").and_then(as_i64);
    vec![
        format!(
            "Grant {id}, {}.",
            expires.map_or_else(
                || "until revoked".to_owned(),
                |at| format!("ends {}", iso8601_millis(at))
            )
        ),
        String::new(),
        data.get("setup")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        String::new(),
        data.get("claude")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        String::new(),
        "# ~/.codex/config.toml".to_owned(),
        data.get("codex")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
    ]
}

/// A millisecond timestamp that may arrive as a JSON integer of either sign.
#[must_use]
pub fn as_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|n| i64::try_from(n).ok()))
}

/// This moment in milliseconds since the Unix epoch, saturating.
#[must_use]
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).map_or(i64::MAX, |ms| ms)
        })
}

#[cfg(test)]
mod tests {
    use super::{columns, count, format_age, format_ago, iso8601_millis};

    #[test]
    fn columns_align_and_drop_empty_tails() {
        let rows = vec![
            vec![
                Some("codex".to_owned()),
                Some("ready".to_owned()),
                Some("1.2.3".to_owned()),
            ],
            vec![Some("pi".to_owned()), Some("signed out".to_owned()), None],
        ];
        assert_eq!(
            columns(&rows),
            vec![
                "codex  ready       1.2.3".to_owned(),
                "pi     signed out".to_owned()
            ]
        );
    }

    #[test]
    fn columns_all_empty_is_empty() {
        assert_eq!(columns(&[vec![None, None]]), vec![String::new()]);
    }

    #[test]
    fn counts_singulate() {
        assert_eq!(count(0, "model"), "0 models");
        assert_eq!(count(1, "model"), "1 model");
        assert_eq!(count(3, "ace tool"), "3 ace tools");
    }

    #[test]
    fn ages_read_as_lists_do() {
        assert_eq!(format_age(1_000, 1_000), "now");
        assert_eq!(format_age(0, 90_000), "2m");
        assert_eq!(format_age(0, 3 * 3_600_000), "3h");
        assert_eq!(format_age(0, 4 * 86_400_000), "4d");
        assert_eq!(format_ago(0, 90_000), "2m ago");
        assert_eq!(format_ago(1_000, 1_000), "just now");
    }

    #[test]
    fn timestamps_print_like_javascript() {
        assert_eq!(iso8601_millis(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            iso8601_millis(1_746_057_600_123),
            "2025-05-01T00:00:00.123Z"
        );
    }
}
