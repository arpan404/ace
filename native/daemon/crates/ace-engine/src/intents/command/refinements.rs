// SPDX-License-Identifier: Apache-2.0
//! The protocol's JavaScript refinements that cannot be generated from declarative checks.

use ace_json::Value;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Refinement {
    OwnerPath,
    RemoteName,
    #[serde(rename = "keys_64")]
    Keys64,
    ParameterDefault,
    LineRange,
    #[serde(rename = "keys_32")]
    Keys32,
    PatchBytes,
    Nonblank,
    Reviewers,
    NoNul,
    RepositoryName,
    ProjectName,
    Url,
    ModelProvider,
    UnlinkSelection,
    ReviewRef,
    ReviewLineRange,
    ReviewPath,
    FingerprintLength,
    OrchestrationLanes,
    OrchestrationCommand,
    OrchestrationId,
    #[serde(rename = "keys_24")]
    Keys24,
}

fn field_len(value: &Value, key: &str) -> usize {
    value
        .get(key)
        .and_then(Value::as_array)
        .map_or(0, |a| a.len())
}

fn number(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or_default()
}

fn is_dot_segment(part: &str) -> bool {
    matches!(part, "." | "..")
}

fn trim(text: &str) -> &str {
    text.trim_matches(|ch| {
        matches!(
            ch,
            '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
            | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
        )
    })
}

fn review_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    let drive = bytes.first().is_some_and(u8::is_ascii_alphabetic) && bytes.get(1) == Some(&b':');
    !drive
        && !path.contains('\\')
        && !bytes.iter().any(|byte| *byte < 32)
        && path
            .split('/')
            .all(|part| !part.is_empty() && !is_dot_segment(part))
}

fn typeof_json(value: &Value) -> &'static str {
    match value {
        Value::String(_) => "string",
        Value::Number(_) => "number",
        Value::Bool(_) => "boolean",
        Value::Object(_) | Value::Array(_) | Value::Null => "object",
    }
}

impl Refinement {
    pub(super) fn accepts(&self, value: &Value) -> bool {
        let text = || value.as_str().unwrap_or_default();
        let count = || value.as_object().map_or(0, |map| map.len());
        match self {
            Self::OwnerPath => text().split('/').all(|part| !is_dot_segment(part)),
            Self::RemoteName => !text().starts_with(['-', '.']),
            Self::Keys64 => count() <= 64,
            Self::Keys32 => count() <= 32,
            Self::Keys24 => count() <= 24,
            Self::ParameterDefault => value.get("default").is_none_or(|default| {
                value.get("type").and_then(Value::as_str) == Some(typeof_json(default))
            }),
            Self::LineRange => number(value, "end") >= number(value, "start"),
            Self::PatchBytes => text().len() <= 65_536,
            Self::Nonblank => !trim(text()).is_empty(),
            Self::Reviewers => field_len(value, "reviewers") + field_len(value, "teams") > 0,
            Self::NoNul => !text().contains('\0'),
            Self::RepositoryName => !is_dot_segment(text()),
            Self::ProjectName => text() == trim(text()) && !text().ends_with('.'),
            // ProjectIcon's regex handles the HTTP(S) prefix and whitespace within the
            // icon contract. Its bare z.url() trims first, then validateURL takes the
            // WHATWG URL.canParse branch. The refinement uses only the verdict.
            Self::Url => url::Url::parse(trim(text())).is_ok(),
            Self::ModelProvider => value.get("model").is_none() || value.get("provider").is_some(),
            Self::UnlinkSelection => {
                value.get("number").is_some() != (value.get("all") == Some(&Value::Bool(true)))
            }
            Self::ReviewRef => !text().starts_with('-') && !text().contains('\0'),
            Self::ReviewLineRange => {
                let start = number(value, "start");
                let end = number(value, "end");
                end >= start && end - start < 100
            }
            Self::ReviewPath => review_path(text()),
            Self::FingerprintLength => {
                ["before", "lines", "after"]
                    .into_iter()
                    .filter_map(|key| value.get(key).and_then(Value::as_array))
                    .flat_map(|entries| entries.iter())
                    .filter_map(|entry| match entry {
                        Value::String(text) => Some(text.len_utf16()),
                        _ => None,
                    })
                    .sum::<usize>()
                    <= 8192
            }
            Self::OrchestrationLanes => {
                let lanes = field_len(value, "lanes");
                value
                    .get("budget")
                    .is_some_and(|budget| lanes as i64 <= number(budget, "maxLanes"))
                    && (value.get("kind").and_then(Value::as_str) != Some("coordinator")
                        || lanes == 1)
            }
            Self::OrchestrationCommand => value
                .get("command")
                .and_then(Value::as_array)
                .is_some_and(|args| {
                    args.first()
                        .and_then(Value::as_str)
                        .is_some_and(|arg| !arg.is_empty())
                        && args
                            .iter()
                            .filter_map(Value::as_str)
                            .all(|arg| !arg.contains('\0'))
                }),
            Self::OrchestrationId => !matches!(text(), "__proto__" | "constructor" | "prototype"),
        }
    }
}
