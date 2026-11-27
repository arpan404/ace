// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::expect_used)]
//! Forge's `redact.ts`: the masks applied to untrusted host text before it is cached, kept as
//! `raw`, logged or put in an error (ADR 0224 §8a). `@ace/redaction` owns the shared
//! vocabulary; forge's own spellings (a `gh*_` token at any length, `Bearer`, and a
//! `token`/`authorization` assignment up to the record's end) are the part whose move into
//! `@ace/redaction` the owner deferred with F0r's TypeScript work.

use ace_redaction::EnvironmentMatcher;
use regex::Regex;

/// The marker forge's payloads carry.
pub const REDACTED: &str = "[REDACTED]";

static GITHUB_TOKEN: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
    Regex::new(r"(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)")
        .expect("the GitHub token pattern compiles")
});
static BEARER: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
    Regex::new(r#"(?i)\bBearer\s+[^\s'"<>]+"#).expect("the Bearer pattern compiles")
});
static ASSIGNMENT: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
    Regex::new(r"(?i)(\b(?:authorization|[a-z0-9_-]{0,64}token)\s*[=:]\s*)[^\r\n,}]+")
        .expect("the assignment pattern compiles")
});

/// Masks GitHub tokens, `Bearer` schemes, `token`/`authorization` assignments, then the
/// request's exact credential values, keeping each assignment's key readable.
pub fn redact(text: &str, environment: Option<&EnvironmentMatcher>) -> String {
    let mut out = GITHUB_TOKEN.replace_all(text, REDACTED).into_owned();
    out = BEARER
        .replace_all(&out, |captures: &regex::Captures<'_>| {
            let whole = captures.get(0).map_or("", |found| found.as_str());
            let token = whole
                .split_once(char::is_whitespace)
                .map_or("", |(_, token)| token);
            // The TypeScript always writes the canonical scheme, keeping the input's case out.
            let _ = token;
            format!("Bearer {REDACTED}")
        })
        .into_owned();
    out = ASSIGNMENT
        .replace_all(&out, |captures: &regex::Captures<'_>| {
            format!(
                "{}{REDACTED}",
                captures.get(1).map_or("", |key| key.as_str())
            )
        })
        .into_owned();
    mask_environment(out, environment)
}

/// Masks the exact configured values, which no pattern can know.
fn mask_environment(text: String, environment: Option<&EnvironmentMatcher>) -> String {
    let Some(environment) = environment else {
        return text;
    };
    if environment.is_empty() {
        return text;
    }
    let spans = environment.spans(&text);
    if spans.is_empty() {
        return text;
    }
    let mut out = String::with_capacity(text.len());
    let mut start = 0;
    for span in spans {
        if span.start < start || span.end > text.len() {
            continue;
        }
        out.push_str(&text[start..span.start]);
        out.push_str(REDACTED);
        start = span.end;
    }
    out.push_str(&text[start..]);
    out
}

/// `text` with every mask applied, keeping the string's UTF-16 units: a lone surrogate is a
/// separator the mask never touches, and each well-formed segment between surrogates is
/// redacted as text (`redact.ts:8-25` masks the string, not a lossy copy of it).
pub fn redact_js(
    text: &ace_json::JsString,
    environment: Option<&EnvironmentMatcher>,
) -> ace_json::JsString {
    if text.as_well_formed().is_some() {
        return ace_json::JsString::from(redact(text.as_str(), environment));
    }
    let units: Vec<u16> = text.units().collect();
    let mut out: Vec<u16> = Vec::with_capacity(units.len());
    let mut segment: Vec<u16> = Vec::new();
    let mut index = 0;
    while index < units.len() {
        let unit = units[index];
        let paired = (0xd800..=0xdbff).contains(&unit)
            && units
                .get(index + 1)
                .is_some_and(|low| (0xdc00..=0xdfff).contains(low));
        if paired {
            segment.push(unit);
            segment.push(units[index + 1]);
            index += 2;
            continue;
        }
        if (0xd800..=0xdfff).contains(&unit) {
            // A lone surrogate: redact what came before it, then keep it as its own unit.
            let plain = ace_json::JsString::from_units(&segment);
            out.extend(redact(plain.as_str(), environment).encode_utf16());
            segment.clear();
            out.push(unit);
            index += 1;
            continue;
        }
        segment.push(unit);
        index += 1;
    }
    let plain = ace_json::JsString::from_units(&segment);
    out.extend(redact(plain.as_str(), environment).encode_utf16());
    ace_json::JsString::from_units(&out)
}

#[cfg(test)]
mod tests {
    use super::{REDACTED, redact};
    use ace_redaction::EnvironmentMatcher;

    #[test]
    fn a_github_token_is_masked_whole_at_any_length() {
        assert_eq!(
            redact("pushed with ghp_secret1", None),
            "pushed with [REDACTED]"
        );
        assert_eq!(redact("ghp_12345678901234567890", None), REDACTED);
        assert_eq!(redact("github_pat_abcdef", None), REDACTED);
    }

    #[test]
    fn a_bearer_scheme_stays_readable() {
        // The assignment pass then takes the scheme's value, as `redact.ts` does.
        assert_eq!(
            redact("curl -H 'Authorization: Bearer abc.def-1'", None),
            "curl -H 'Authorization: [REDACTED]"
        );
        assert_eq!(redact("bEaReR OPAQUE", None), "Bearer [REDACTED]");
        // A token glued to a word character is still the token (`redact.ts:4`).
        assert_eq!(redact("xghp_12345678901234567890", None), "x[REDACTED]");
    }

    #[test]
    fn an_assignment_keeps_its_key_and_loses_its_value() {
        assert_eq!(redact("token=ghp_secret1", None), "token=[REDACTED]");
        assert_eq!(
            redact("access_token=opaque-demo-token", None),
            "access_token=[REDACTED]"
        );
        assert_eq!(
            redact("Authorization: opaque-header", None),
            "Authorization: [REDACTED]"
        );
    }

    #[test]
    fn a_configured_value_is_masked_wherever_it_appears() {
        let environment = EnvironmentMatcher::new(&["opaque-echoed-value"]);
        assert_eq!(
            redact("said opaque-echoed-value twice", Some(&environment)),
            "said [REDACTED] twice"
        );
    }

    #[test]
    fn a_lone_surrogate_survives_while_the_secret_beside_it_is_masked() {
        let mut units: Vec<u16> = vec![0xd800];
        units.extend("ghp_12345678901234567890".encode_utf16());
        units.push(0xdc00);
        let text = ace_json::JsString::from_units(&units);
        let masked = super::redact_js(&text, None);
        let output: Vec<u16> = masked.units().collect();
        assert_eq!(output.first(), Some(&0xd800));
        assert_eq!(output.last(), Some(&0xdc00));
        let display: Vec<u16> = output[1..output.len() - 1].to_vec();
        assert_eq!(
            String::from_utf16(&display).expect("well-formed masked text"),
            "[REDACTED]"
        );
    }

    #[test]
    fn ordinary_text_is_untouched() {
        assert_eq!(
            redact("ordinary prose about tokens", None),
            "ordinary prose about tokens"
        );
    }
}
