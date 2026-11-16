//! A proxy request's head (ADR 0167 decision 3): parsed, its target and run token read, and
//! rewritten for the host. Pure.

use base64::Engine as _;

/// A request's head.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Head {
    pub method: String,
    pub target: String,
    pub version: String,
    pub headers: Vec<(String, String)>,
}

impl Head {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// The token of `Proxy-Authorization: Basic base64(user:token)`.
    pub fn token(&self) -> Option<String> {
        let value = self.header("proxy-authorization")?.trim();
        let (scheme, encoded) = value.split_once(' ')?;
        if !scheme.eq_ignore_ascii_case("basic") {
            return None;
        }
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded.trim())
            .ok()?;
        let text = String::from_utf8(decoded).ok()?;
        text.split_once(':').map(|(_, token)| token.to_owned())
    }
}

/// Parses a request's head (everything before the blank line).
pub fn parse_head(raw: &[u8]) -> Option<Head> {
    let text = std::str::from_utf8(raw).ok()?;
    let mut lines = text.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let (method, target, version) = (first.next()?, first.next()?, first.next()?);
    if first.next().is_some() || !version.starts_with("HTTP/1.") {
        return None;
    }
    let mut headers = Vec::new();
    for line in lines.filter(|l| !l.is_empty()) {
        let (name, value) = line.split_once(':')?;
        headers.push((name.trim().to_owned(), value.trim().to_owned()));
    }
    Some(Head {
        method: method.to_owned(),
        target: target.to_owned(),
        version: version.to_owned(),
        headers,
    })
}

/// Where a request goes: host, port, and for plain HTTP the path to send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub host: String,
    pub port: u16,
    /// `None` for `CONNECT`.
    pub path: Option<String>,
}

pub fn target(head: &Head) -> Option<Target> {
    if head.method.eq_ignore_ascii_case("CONNECT") {
        let (host, port) = split_host_port(&head.target)?;
        return Some(Target {
            host,
            port: port?,
            path: None,
        });
    }
    let rest = head.target.strip_prefix("http://")?;
    let (authority, path) = match rest.find('/') {
        Some(at) => (&rest[..at], &rest[at..]),
        None => (rest, "/"),
    };
    if authority.contains('@') {
        return None;
    }
    let (host, port) = split_host_port(authority)?;
    Some(Target {
        host,
        port: port.unwrap_or(80),
        path: Some(path.to_owned()),
    })
}

pub(super) fn split_host_port(authority: &str) -> Option<(String, Option<u16>)> {
    if let Some(rest) = authority.strip_prefix('[') {
        let (host, after) = rest.split_once(']')?;
        let port = match after.strip_prefix(':') {
            Some(port) => Some(port.parse().ok()?),
            None if after.is_empty() => None,
            None => return None,
        };
        return Some((host.to_owned(), port));
    }
    match authority.rsplit_once(':') {
        Some((host, port)) => Some((host.to_owned(), Some(port.parse().ok()?))),
        None => Some((authority.to_owned(), None)),
    }
    .filter(|(host, _)| !host.is_empty())
}

/// The head sent on for a plain HTTP request: origin-form, without the proxy's headers, closed
/// after one exchange.
pub fn forward_head(head: &Head, path: &str) -> Vec<u8> {
    let mut out = format!("{} {} {}\r\n", head.method, path, head.version);
    for (name, value) in &head.headers {
        let lower = name.to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "proxy-authorization" | "proxy-connection" | "connection" | "keep-alive"
        ) {
            continue;
        }
        out.push_str(&format!("{name}: {value}\r\n"));
    }
    out.push_str("Connection: close\r\n\r\n");
    out.into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_connect_head_names_its_host_port_and_the_runs_token() {
        let head = parse_head(
            b"CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\nProxy-Authorization: Basic c3BhZGU6dG9rMQ==",
        )
        .unwrap_or_else(|| std::process::abort());
        assert_eq!(head.token().as_deref(), Some("tok1"));
        assert_eq!(
            target(&head),
            Some(Target {
                host: "github.com".into(),
                port: 443,
                path: None
            })
        );
    }

    #[test]
    fn a_plain_request_is_sent_on_in_origin_form_without_the_proxys_headers() {
        let head = parse_head(
            b"GET http://example.org:8080/a?b=1 HTTP/1.1\r\nHost: example.org\r\nProxy-Authorization: Basic eA==\r\nProxy-Connection: keep-alive",
        )
        .unwrap_or_else(|| std::process::abort());
        let to = target(&head).unwrap_or_else(|| std::process::abort());
        assert_eq!((to.host.as_str(), to.port), ("example.org", 8080));
        let sent = String::from_utf8(forward_head(&head, to.path.as_deref().unwrap_or("/")))
            .unwrap_or_default();
        assert_eq!(
            sent,
            "GET /a?b=1 HTTP/1.1\r\nHost: example.org\r\nConnection: close\r\n\r\n"
        );
    }

    #[test]
    fn heads_spade_does_not_forward_are_refused() {
        for raw in [
            &b"GET https://example.org/ HTTP/1.1"[..],
            b"GET http://user@example.org/ HTTP/1.1",
            b"CONNECT example.org HTTP/1.1",
            b"GET / HTTP/1.1",
        ] {
            let head = parse_head(raw);
            assert!(head.as_ref().and_then(target).is_none(), "{raw:?}");
        }
        assert!(parse_head(b"GARBAGE").is_none());
    }

    #[test]
    fn an_ipv6_literal_keeps_its_port() {
        assert_eq!(
            split_host_port("[::1]:3000"),
            Some(("::1".to_owned(), Some(3000)))
        );
        assert_eq!(split_host_port(":80"), None);
    }
}
