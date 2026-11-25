// SPDX-License-Identifier: Apache-2.0
//! The stderr tail's redactor: `createTextRedactor`'s lexical rules, ported.

use crate::session::lifetime::Redactor;

use super::ShellConfig;

/// `createTextRedactor`'s lexical rules: paths, the host name, environment
/// values and credential assignments become placeholders. A line it cannot
/// scrub is omitted, never retained raw.
pub fn redactor(config: &ShellConfig) -> Redactor {
    let mut pairs: Vec<(String, String)> = Vec::new();
    let mut push = |from: &str, to: &str| {
        if from.len() >= 4 {
            pairs.push((from.to_owned(), to.to_owned()));
        }
    };
    push(&config.workspace, "<WORKSPACE>");
    if let Some(home) = &config.home {
        push(home, "<HOME>");
    }
    if let Some(host) = &config.hostname {
        push(host, "<HOST>");
        if let Some(short) = host.split('.').next() {
            push(short, "<HOST>");
        }
    }
    for (_, value) in &config.env {
        push(value, "<ENV>");
    }
    pairs.sort_by_key(|pair| std::cmp::Reverse(pair.0.len()));
    Box::new(move |text: &str| scrub(text, &pairs))
}

fn scrub(text: &str, pairs: &[(String, String)]) -> String {
    if text.len() > 65_536 {
        return "<OVERSIZED REDACTED>".to_owned();
    }
    let mut out = text.to_owned();
    for (from, to) in pairs {
        if out.contains(from.as_str()) {
            out = out.replace(from.as_str(), to);
        }
    }
    scrub_credentials(&out)
}

/// `\b(?:token|secret|password|api[_-]?key)\s*[=:]\s*[^\s,;]+`: the key stays,
/// its value becomes `<SECRET>`.
fn scrub_credentials(text: &str) -> String {
    const KEYS: [&str; 5] = ["token", "secret", "password", "api_key", "api-key"];
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    while index < bytes.len() {
        let rest = &text[index..];
        let lower = rest.to_ascii_lowercase();
        let found = KEYS
            .iter()
            .filter_map(|key| lower.find(key).map(|at| (at, key.len())))
            .min_by_key(|(at, _)| *at);
        let Some((at, len)) = found else {
            out.push_str(rest);
            break;
        };
        let before = bytes.get(index + at).copied();
        let boundary =
            index + at == 0 || before.is_some_and(|ch| !ch.is_ascii_alphanumeric() && ch != b'_');
        let after = index + at + len;
        let mut cursor = after;
        while bytes
            .get(cursor)
            .is_some_and(|ch| *ch == b' ' || *ch == b'\t')
        {
            cursor += 1;
        }
        let separator = bytes.get(cursor).copied();
        if !boundary || !matches!(separator, Some(b'=') | Some(b':')) {
            out.push_str(&rest[..at + len]);
            index += at + len;
            continue;
        }
        out.push_str(&rest[..at + len]);
        out.push(char::from(separator.unwrap_or(b'=')));
        cursor += 1;
        while bytes
            .get(cursor)
            .is_some_and(|ch| *ch == b' ' || *ch == b'\t')
        {
            out.push(' ');
            cursor += 1;
        }
        while bytes
            .get(cursor)
            .is_some_and(|ch| !ch.is_ascii_whitespace() && *ch != b',' && *ch != b';')
        {
            cursor += 1;
        }
        out.push_str("<SECRET>");
        index = cursor;
    }
    out
}
