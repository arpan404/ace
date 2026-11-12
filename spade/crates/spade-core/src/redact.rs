//! Keeps secrets out of what the person is shown about a bot's work (ADR 0135): values under
//! names that hold secrets, and strings shaped like keys or bearer tokens.

use serde_json::Value;

/// What a hidden secret shows as.
pub const HIDDEN: &str = "•••";

/// Most characters a one-line summary keeps.
pub const SUMMARY_CHARS: usize = 160;

/// A name's parts, lowercase: split at `_`, `-`, `.` and camelCase (`apiKey` → `api`, `key`).
fn parts(name: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut part = String::new();
    let mut previous_lower = false;
    for c in name.chars() {
        if matches!(c, '_' | '-' | '.' | ' ') {
            if !part.is_empty() {
                parts.push(std::mem::take(&mut part));
            }
            previous_lower = false;
            continue;
        }
        if c.is_ascii_uppercase() && previous_lower && !part.is_empty() {
            parts.push(std::mem::take(&mut part));
        }
        previous_lower = c.is_ascii_lowercase() || c.is_ascii_digit();
        part.push(c.to_ascii_lowercase());
    }
    if !part.is_empty() {
        parts.push(part);
    }
    parts
}

/// Whether a field name says its value is a secret, by whole parts of the name: `token`,
/// `secret`, `password`, `passwd`, `auth`, `authorization`, `credential(s)`, `cookie`, `apikey`,
/// or `key` after another part (`api_key`, `secret_key`, `X-Api-Key`). Not `key` alone, not
/// `tokens`, `keywords`, `author` or `session_id`.
pub fn secret_name(name: &str) -> bool {
    let parts = parts(name);
    parts.iter().enumerate().any(|(i, part)| {
        matches!(
            part.as_str(),
            "token"
                | "secret"
                | "password"
                | "passwd"
                | "auth"
                | "authorization"
                | "credential"
                | "credentials"
                | "cookie"
                | "apikey"
                | "accesskey"
                | "privatekey"
        ) || (part == "key" && i > 0)
    })
}

/// Characters a word is made of, for names and for key-shaped runs.
fn word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '+' | '/' | '=')
}

fn quote(c: char) -> bool {
    matches!(c, '"' | '\'' | '`')
}

/// Where a value starting at `at` ends: after its matching close quote when it opens with one,
/// else at whitespace or a quote, and in a URL's query also at `&` or `#`.
fn value_end(chars: &[char], at: usize, in_query: bool) -> usize {
    let Some(&first) = chars.get(at) else {
        return at;
    };
    if quote(first) {
        return chars[at + 1..]
            .iter()
            .position(|&c| c == first)
            .map_or(chars.len(), |i| at + 1 + i + 1);
    }
    chars[at..]
        .iter()
        .position(|&c| c.is_whitespace() || quote(c) || (in_query && matches!(c, '&' | '#')))
        .map_or(chars.len(), |i| at + i)
}

fn skip_blanks(chars: &[char], mut at: usize) -> usize {
    while chars.get(at).is_some_and(|c| *c == ' ' || *c == '\t') {
        at += 1;
    }
    at
}

/// Schemes an `Authorization` value starts with; the credential after them is secret too.
const SCHEMES: [&str; 4] = ["basic", "bearer", "digest", "token"];

/// `text` with secrets replaced by [`HIDDEN`]: first every value a secret name gives
/// (`TOKEN=abc`, `export API_KEY="sk…"`, `password = "x"`, `password: p@ss`, `--token 'two
/// words'`, a URL's `?api_key=…`, `Authorization: Basic …`, `Bearer …`), then every run shaped
/// like a key. A value runs to whitespace, or to its close quote when it opens with one.
pub fn text(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if !word_char(c) {
            out.push(c);
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len() && word_char(chars[i]) {
            i += 1;
        }
        let word: String = chars[start..i].iter().collect();
        let in_query = start > 0 && matches!(chars[start - 1], '?' | '&');
        // `NAME=value` or `NAME=` with the value right after (a quote).
        if let Some((name, _)) = word.split_once('=')
            && secret_name(name.trim_start_matches('-'))
        {
            let at = start + name.chars().count() + 1;
            out.push_str(name);
            out.push('=');
            i = hide_value(&chars, at, in_query, &mut out);
            continue;
        }
        let bare = word.trim_start_matches('-');
        if secret_name(bare) {
            out.push_str(&word);
            // `"password": "x"`: a name's own close quote comes before its separator.
            let mut at = i;
            if chars.get(at).copied().is_some_and(quote) {
                at += 1;
            }
            let after = skip_blanks(&chars, at);
            let separator = chars.get(after).copied();
            let url = separator == Some(':') && chars.get(after + 1) == Some(&'/');
            if matches!(separator, Some('=' | ':')) && !url {
                let value = skip_blanks(&chars, after + 1);
                out.extend(&chars[i..value]);
                i = hide_value(&chars, value, in_query, &mut out);
                continue;
            }
            // `--token value`: a flag whose name is secret takes the next word.
            if word.starts_with('-') && after > i && chars.get(after).is_some_and(|c| *c != '-') {
                out.extend(&chars[i..after]);
                i = hide_value(&chars, after, in_query, &mut out);
            }
            continue;
        }
        if word.eq_ignore_ascii_case("bearer") {
            out.push_str(&word);
            let after = skip_blanks(&chars, i);
            if after > i && after < chars.len() {
                out.extend(&chars[i..after]);
                i = hide_value(&chars, after, false, &mut out);
            }
            continue;
        }
        if looks_like_key(&word) {
            out.push_str(HIDDEN);
        } else {
            out.push_str(&word);
        }
    }
    out
}

/// Writes the value starting at `at` hidden (its quotes kept) and returns where it ended. An
/// `Authorization` scheme (`Basic`, `Bearer`) is hidden with the credential after it.
fn hide_value(chars: &[char], at: usize, in_query: bool, out: &mut String) -> usize {
    let end = value_end(chars, at, in_query);
    if end <= at {
        return at;
    }
    let value: String = chars[at..end].iter().collect();
    let open = chars[at];
    if quote(open) {
        out.push(open);
        out.push_str(HIDDEN);
        if end - at >= 2 && chars[end - 1] == open {
            out.push(open);
        }
        return end;
    }
    out.push_str(HIDDEN);
    if SCHEMES.contains(&value.to_ascii_lowercase().as_str()) {
        let next = skip_blanks(chars, end);
        if next > end && next < chars.len() {
            return value_end(chars, next, in_query);
        }
    }
    end
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
    fn values_a_name_marks_as_secret_are_hidden_however_they_are_written() {
        let cases = [
            ("https://api.example.com/cb?token=sk-123&page=2", "sk-123"),
            ("curl 'https://x.dev/a?api_key=short1&q=rust'", "short1"),
            ("PASSWORD=short-secret ./run.sh", "short-secret"),
            ("export GITHUB_TOKEN=abc123", "abc123"),
            ("deploy --password hunter2 --verbose", "hunter2"),
            ("deploy --api-key=xyz --verbose", "xyz"),
            ("login with password: hunter2", "hunter2"),
            ("Cookie: session=abcdef", "abcdef"),
            ("export API_KEY=\"sk123abc\"", "sk123abc"),
            ("password = \"x y\"", "x y"),
            ("TOKEN = abc", "abc"),
            ("deploy --token 'two words' --verbose", "two words"),
            ("PASSWORD=p@ssw0rd ./run", "p@ssw0rd"),
            ("password: p@ss", "p@ss"),
            ("{\"password\": \"hunter2\"}", "hunter2"),
            ("Authorization: Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"),
            ("curl -H 'Authorization: Bearer abc.def' x", "abc.def"),
            ("https://x.dev/cb?code=1&access_token=a%20b#frag", "a%20b"),
            ("X-Api-Key: k3y", "k3y"),
            ("set apiKey=secretvalue", "secretvalue"),
        ];
        for (case, secret) in cases {
            let shown = text(case);
            assert!(!shown.contains(secret), "{case} -> {shown}");
            assert!(shown.contains(HIDDEN), "{case} -> {shown}");
        }
        assert!(text(cases[0].0).contains("page=2"), "other parameters stay");
        assert!(text(cases[4].0).contains("--verbose"));
        assert!(text("deploy --token 'two words' --verbose").ends_with("'•••' --verbose"));
        assert!(text("https://x.dev/cb?code=1&access_token=a%20b#frag").ends_with("#frag"));
        assert_eq!(text("password = \"x y\" done"), "password = \"•••\" done");
    }

    #[test]
    fn words_that_only_look_like_secret_names_are_left_alone() {
        for case in [
            "a basic script",
            "run --max-tokens 100 now",
            "git log --author alice",
            "{\"keywords\": [\"rust\", \"async\"]}",
            "{\"key\": \"Enter\"}",
            "session_id: 42",
            "the input_tokens: 300",
            "the author: Ann",
        ] {
            assert_eq!(text(case), case);
        }
        let args = arguments(&json!({ "key": "Enter", "session_id": "s1", "max_tokens": 5,
                                      "keywords": "rust", "api_key": "abc" }));
        assert!(args.contains("key: Enter") && args.contains("session_id: s1"), "{args}");
        assert!(args.contains("max_tokens: 5") && args.contains("keywords: rust"));
        assert!(!args.contains("abc"));
        for name in ["api_key", "apiKey", "X-Api-Key", "accessToken", "client_secret",
                     "DB_PASSWORD", "authorization", "session_token", "Cookie"] {
            assert!(secret_name(name), "{name}");
        }
        for name in ["key", "keywords", "tokens", "max_tokens", "author", "session_id",
                     "session", "monkey"] {
            assert!(!secret_name(name), "{name}");
        }
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
