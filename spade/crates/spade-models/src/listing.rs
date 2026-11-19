//! An endpoint's own model list (`GET <base>/models`, ADR 0126). OpenAI formats authenticate with
//! `Authorization: Bearer`, Anthropic with `x-api-key` and `anthropic-version`. The answer is
//! read leniently: items without a string id are skipped, unknown fields are kept in `raw`, and
//! the size, item count and time are bounded. Errors are one short line that never holds the key.

use std::time::Duration;

use serde_json::Value;

use crate::catalog::{Capability, Endpoint};
use crate::format::Format;

/// The Anthropic API version sent with Anthropic-format calls.
pub const ANTHROPIC_VERSION: &str = "2023-06-01";

/// A model the endpoint listed, with what it said about it.
#[derive(Debug, Clone, PartialEq)]
pub struct Listed {
    pub id: String,
    pub name: Option<String>,
    pub context: Option<u64>,
    pub capabilities: Option<Vec<Capability>>,
    /// The item as the endpoint sent it.
    pub raw: Value,
}

/// How much of a model list Spade reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ListBounds {
    pub timeout: Duration,
    pub max_bytes: usize,
    pub max_models: usize,
}

impl Default for ListBounds {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(10),
            max_bytes: 4 * 1024 * 1024,
            max_models: 5_000,
        }
    }
}

/// Fetches the endpoint's model list with `key` (none for a keyless endpoint).
pub(crate) async fn fetch(
    http: &reqwest::Client,
    endpoint: &Endpoint,
    key: Option<&str>,
    bounds: ListBounds,
) -> Result<Vec<Listed>, String> {
    let url = format!("{}models", endpoint.base_url);
    let mut request = http.get(&url).timeout(bounds.timeout);
    if endpoint.format == Format::Anthropic {
        request = request
            .query(&[("limit", "1000")])
            .header("anthropic-version", ANTHROPIC_VERSION);
        if let Some(key) = key {
            request = request.header("x-api-key", key);
        }
    } else if let Some(key) = key {
        request = request.bearer_auth(key);
    }
    for (name, value) in &endpoint.headers {
        request = request.header(name.as_str(), value.as_str());
    }
    // Never echo the key or a configured header's value, whatever the endpoint sends back.
    let mut secrets: Vec<&str> = endpoint.headers.iter().map(|(_, v)| v.as_str()).collect();
    secrets.extend(key);
    let scrub = |text: String| one_line(&text, &secrets);
    let mut response = request
        .send()
        .await
        .map_err(|e| scrub(format!("could not reach the endpoint: {}", reason(&e))))?;
    let status = response.status();
    if status.is_redirection() {
        return Err(format!(
            "the endpoint redirected ({}); Spade does not follow redirects with your key, so set the \
             base URL to the address it points to",
            status.as_u16()
        ));
    }
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                body.extend_from_slice(&chunk);
                if body.len() > bounds.max_bytes {
                    return Err(format!(
                        "the model list is larger than {} KB",
                        bounds.max_bytes / 1024
                    ));
                }
            }
            Ok(None) => break,
            Err(e) => {
                return Err(scrub(format!(
                    "the model list did not arrive: {}",
                    reason(&e)
                )));
            }
        }
    }
    if !status.is_success() {
        let detail = message_in(&body).map_or_else(String::new, |m| format!(": {m}"));
        return Err(scrub(format!(
            "the endpoint answered {}{detail}",
            status.as_u16()
        )));
    }
    parse(&body, bounds.max_models)
}

pub(crate) fn reason(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "it took too long"
    } else if error.is_connect() {
        "the connection failed"
    } else {
        "the request failed"
    }
}

/// The error message an endpoint put in its answer, if any.
pub(crate) fn message_in(body: &[u8]) -> Option<String> {
    let value: Value = serde_json::from_slice(body).ok()?;
    let message = value
        .pointer("/error/message")
        .or_else(|| value.get("message"))
        .or_else(|| value.get("error"))?;
    message.as_str().map(str::to_owned)
}

/// One short line, with every secret (the key, header values) cut out wherever it appears.
pub(crate) fn one_line(text: &str, secrets: &[&str]) -> String {
    let mut text = text.replace(['\n', '\r'], " ");
    for secret in secrets.iter().filter(|s| s.len() >= 4) {
        text = text.replace(secret, "[hidden]");
    }
    if text.chars().count() > 200 {
        text = text.chars().take(199).collect::<String>() + "…";
    }
    text
}

/// Reads a model list: `{"data":[…]}` (OpenAI, Anthropic), `{"models":[…]}` or a bare array.
pub fn parse(body: &[u8], max_models: usize) -> Result<Vec<Listed>, String> {
    let value: Value =
        serde_json::from_slice(body).map_err(|_| "the model list is not JSON".to_owned())?;
    let items = match &value {
        Value::Array(items) => items,
        Value::Object(map) => match map.get("data").or_else(|| map.get("models")) {
            Some(Value::Array(items)) => items,
            _ => return Err("the answer holds no model list".to_owned()),
        },
        _ => return Err("the answer holds no model list".to_owned()),
    };
    let mut seen = std::collections::HashSet::new();
    Ok(items
        .iter()
        .filter_map(item)
        .filter(|m| seen.insert(m.id.clone()))
        .take(max_models)
        .collect())
}

fn item(raw: &Value) -> Option<Listed> {
    let id = raw.get("id")?.as_str()?.trim();
    if id.is_empty() || id.len() > 300 || id.chars().any(char::is_control) {
        return None;
    }
    let text = |key: &str| {
        raw.get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.chars().take(200).collect::<String>())
    };
    let number = |key: &str| raw.get(key).and_then(Value::as_u64).filter(|n| *n > 0);
    let context = [
        "context_length",
        "context_window",
        "max_context_length",
        "max_input_tokens",
    ]
    .into_iter()
    .find_map(number);
    let capabilities = raw.get("capabilities").and_then(|c| match c {
        Value::Array(names) => Some(
            names
                .iter()
                .filter_map(Value::as_str)
                .filter_map(Capability::parse)
                .collect(),
        ),
        _ => None,
    });
    Some(Listed {
        id: id.to_owned(),
        name: text("display_name").or_else(|| text("name")),
        context,
        capabilities,
        raw: raw.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_list_is_read_leniently_skipping_odd_items_and_keeping_the_rest() {
        let body = br#"{"object":"list","data":[
            {"id":"kimi","context_length":262144,"owned_by":"x"},
            {"id":"claude","display_name":"Claude","max_input_tokens":1000000,"capabilities":["tools","images","teleport"]},
            {"name":"no id"}, {"id":42}, "text", {"id":"  "}, {"id":"kimi"}
        ],"has_more":false}"#;
        let models = parse(body, 100).unwrap_or_default();
        let ids: Vec<_> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["kimi", "claude"]);
        assert_eq!(models[0].context, Some(262_144));
        assert_eq!(models[0].raw["owned_by"], "x", "unknown fields are kept");
        assert_eq!(models[1].name.as_deref(), Some("Claude"));
        assert_eq!(
            models[1].capabilities,
            Some(vec![Capability::Tools, Capability::Images])
        );
    }

    #[test]
    fn a_bare_array_works_and_the_count_is_bounded() {
        let body = br#"[{"id":"a"},{"id":"b"},{"id":"c"}]"#;
        assert_eq!(parse(body, 2).map(|m| m.len()), Ok(2));
        assert!(parse(b"<html>", 10).is_err());
        assert!(parse(br#"{"data":"nope"}"#, 10).is_err());
    }

    #[test]
    fn an_error_line_never_carries_the_key() {
        let line = one_line(
            "bad key sk-secret for team-blue\nsecond line",
            &["sk-secret", "team-blue"],
        );
        assert_eq!(line, "bad key [hidden] for [hidden] second line");
    }
}
