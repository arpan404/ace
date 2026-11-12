//! Keeps secrets out of what the person is shown about a bot's work (ADR 0135): values under
//! names that hold secrets, and strings shaped like keys or bearer tokens.

use serde_json::Value;

/// What a hidden secret shows as.
pub const HIDDEN: &str = "•••";

/// Most characters a one-line summary keeps.
pub const SUMMARY_CHARS: usize = 160;

/// Whether a field name says its value is a secret.
pub fn secret_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    [
        "token",
        "secret",
        "password",
        "passwd",
        "key",
        "auth",
        "cookie",
        "credential",
        "session",
    ]
    .iter()
    .any(|word| name.contains(word))
}

/// `text` with every run shaped like a key or a bearer token replaced by [`HIDDEN`].
pub fn text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut word = String::new();
    // The previous word was "Bearer" (or "token"), so the next one is the secret.
    let mut after_bearer = false;
    let flush = |word: &mut String, out: &mut String, after_bearer: &mut bool| {
        if word.is_empty() {
            return;
        }
        let lower = word.to_ascii_lowercase();
        if *after_bearer || looks_like_key(word) {
            out.push_str(HIDDEN);
        } else {
            out.push_str(word);
        }
        *after_bearer = lower == "bearer" || lower == "basic";
        word.clear();
    };
    for c in text.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '+' | '/' | '=') {
            word.push(c);
        } else {
            flush(&mut word, &mut out, &mut after_bearer);
            out.push(c);
        }
    }
    flush(&mut word, &mut out, &mut after_bearer);
    out
}

/// Whether one word looks like a credential.
fn looks_like_key(word: &str) -> bool {
    let word = word.trim_end_matches('.');
    let prefixed = [
        "sk-",
        "sk_",
        "pk_live_",
        "rk_live_",
        "ghp_",
        "gho_",
        "ghu_",
        "ghs_",
        "ghr_",
        "github_pat_",
        "xoxa-",
        "xoxb-",
        "xoxp-",
        "xoxr-",
        "xoxs-",
        "glpat-",
        "AIza",
        "AKIA",
        "ASIA",
    ];
    if word.len() >= 12 && prefixed.iter().any(|p| word.starts_with(p)) {
        return true;
    }
    // A JWT: three base64url parts, the first a JSON header.
    if word.starts_with("eyJ") && word.split('.').count() == 3 && word.len() >= 30 {
        return true;
    }
    // A long run of mixed-case letters and digits (base64 included); file names and addresses
    // (with a `.`) and single-case hex (hashes, ids) are left alone.
    let core = word
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '+' | '/' | '='));
    core && word.len() >= 32
        && word.chars().any(|c| c.is_ascii_digit())
        && word.chars().any(|c| c.is_ascii_lowercase())
        && word.chars().any(|c| c.is_ascii_uppercase())
}

/// A JSON value with secrets hidden: values under secret names, and secret-shaped strings.
pub fn value(value: &Value) -> Value {
    match value {
        Value::String(s) => Value::String(text(s)),
        Value::Array(items) => Value::Array(items.iter().map(self::value).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| {
                    let shown = if secret_name(k) && !v.is_null() {
                        Value::String(HIDDEN.to_owned())
                    } else {
                        self::value(v)
                    };
                    (k.clone(), shown)
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

/// A call's arguments as one short line: `key: value` pairs, strings unquoted, secrets hidden.
pub fn arguments(arguments: &Value) -> String {
    let shown = value(arguments);
    let line = match &shown {
        Value::Object(map) => map
            .iter()
            .map(|(k, v)| format!("{k}: {}", plain(v)))
            .collect::<Vec<_>>()
            .join(", "),
        other => plain(other),
    };
    one_line(&line)
}

fn plain(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Text on one line of at most [`SUMMARY_CHARS`], with secrets hidden.
pub fn one_line(raw: &str) -> String {
    let flat: String = text(raw).split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= SUMMARY_CHARS {
        return flat;
    }
    let kept: String = flat.chars().take(SUMMARY_CHARS - 1).collect();
    format!("{kept}…")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn values_under_secret_names_are_hidden_at_any_depth() {
        let shown = arguments(&json!({
            "title": "Fix login",
            "api_key": "abc",
            "headers": { "Authorization": "anything", "accept": "json" },
            "Password": 1234
        }));
        assert!(shown.contains("title: Fix login"), "{shown}");
        assert!(!shown.contains("abc") && !shown.contains("anything") && !shown.contains("1234"));
        assert!(shown.contains("accept"));
    }

    #[test]
    fn strings_shaped_like_keys_are_hidden_wherever_they_appear() {
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
        let cases = [
            "curl -H 'Authorization: Bearer abc.def-123' https://api.example.com",
            "export OPENAI=sk-proj-abcdefghijklmnop1234",
            "token ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789",
            "aws AKIAIOSFODNN7EXAMPLE now",
            jwt,
            "key=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
        ];
        for case in cases {
            let shown = text(case);
            assert!(shown.contains(HIDDEN), "{case} -> {shown}");
        }
        assert!(!text(cases[0]).contains("abc.def-123"));
        assert!(text(cases[0]).contains("https://api.example.com"));
    }

    #[test]
    fn ordinary_words_paths_and_hashes_stay() {
        for case in [
            "git checkout 3f786850e387550fdab836ed7e6dc881de23001b",
            "workspace/research/2026-11-12-rust-async-runtimes.md",
            "Read the release notes for version 1.95",
        ] {
            assert_eq!(text(case), case);
        }
    }

    #[test]
    fn a_summary_is_one_short_line() {
        let long = "word ".repeat(100);
        let line = one_line(&format!("first\nsecond {long}"));
        assert!(!line.contains('\n'));
        assert_eq!(line.chars().count(), SUMMARY_CHARS);
        assert!(line.ends_with('…'));
    }
}
