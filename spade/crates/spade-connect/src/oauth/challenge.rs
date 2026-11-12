//! Reading a `WWW-Authenticate` header (RFC 6750 section 3, RFC 9728 section 5.1). Pure.

/// What a server's Bearer challenge says.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Challenge {
    /// Where the server's protected-resource metadata is.
    pub resource_metadata: Option<String>,
    /// The scopes the request needs, space-separated as sent.
    pub scope: Option<String>,
    /// `invalid_token`, `insufficient_scope`, …
    pub error: Option<String>,
}

/// The Bearer challenge in `header`, if there is one. Other schemes in the same header are
/// skipped; unknown parameters are ignored; a malformed one ends the reading there.
pub fn parse(header: &str) -> Option<Challenge> {
    let mut rest = header.trim_start();
    loop {
        let (scheme, after) = token(rest)?;
        rest = after;
        if scheme.eq_ignore_ascii_case("bearer") {
            return Some(params(rest));
        }
        // Skip this scheme's parameters up to the next scheme.
        rest = skip_params(rest)?;
    }
}

fn params(mut rest: &str) -> Challenge {
    let mut challenge = Challenge::default();
    while let Some((name, value, after)) = param(rest) {
        match name.to_ascii_lowercase().as_str() {
            "resource_metadata" => challenge.resource_metadata = Some(value),
            "scope" => challenge.scope = Some(value),
            "error" => challenge.error = Some(value),
            _ => {}
        }
        rest = after.trim_start();
        match rest.strip_prefix(',') {
            Some(after) => rest = after.trim_start(),
            None => break,
        }
    }
    challenge
}

/// Skips `name=value` pairs; returns what follows them (the next scheme), or None at the end.
fn skip_params(mut rest: &str) -> Option<&str> {
    loop {
        rest = rest.trim_start().trim_start_matches(',').trim_start();
        if rest.is_empty() {
            return None;
        }
        match param(rest) {
            Some((_, _, after)) => rest = after,
            None => return Some(rest),
        }
    }
}

/// `name=value` or `name="quoted value"`, and what follows.
fn param(text: &str) -> Option<(String, String, &str)> {
    let (name, rest) = token(text)?;
    let rest = rest.trim_start().strip_prefix('=')?.trim_start();
    if let Some(quoted) = rest.strip_prefix('"') {
        let mut value = String::new();
        let mut chars = quoted.char_indices();
        while let Some((index, c)) = chars.next() {
            match c {
                '\\' => value.push(chars.next()?.1),
                '"' => return Some((name.to_owned(), value, &quoted[index + 1..])),
                other => value.push(other),
            }
        }
        return None;
    }
    let (value, rest) = token(rest)?;
    Some((name.to_owned(), value.to_owned(), rest))
}

/// A run of token characters (RFC 9110), and what follows.
fn token(text: &str) -> Option<(&str, &str)> {
    let text = text.trim_start();
    let end = text
        .find(|c: char| c.is_whitespace() || matches!(c, ',' | '=' | '"'))
        .unwrap_or(text.len());
    (end > 0).then(|| (&text[..end], &text[end..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bearer_challenge_gives_its_metadata_address_scope_and_error() {
        let header = r#"Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="files:read files:write", error="insufficient_scope""#;
        assert_eq!(
            parse(header),
            Some(Challenge {
                resource_metadata: Some(
                    "https://mcp.example.com/.well-known/oauth-protected-resource".into()
                ),
                scope: Some("files:read files:write".into()),
                error: Some("insufficient_scope".into()),
            })
        );
    }

    #[test]
    fn other_schemes_and_unknown_parameters_are_skipped() {
        let header = r#"Basic realm="x", Bearer realm="mcp", error=invalid_token, scope="a\"b""#;
        let challenge = parse(header);
        assert_eq!(
            challenge,
            Some(Challenge {
                resource_metadata: None,
                scope: Some("a\"b".into()),
                error: Some("invalid_token".into()),
            })
        );
        assert_eq!(parse("Bearer"), Some(Challenge::default()));
        assert_eq!(parse(r#"Basic realm="x""#), None);
        assert_eq!(parse(""), None);
        assert_eq!(
            parse(r#"Bearer scope="never closed"#),
            Some(Challenge::default())
        );
    }
}
