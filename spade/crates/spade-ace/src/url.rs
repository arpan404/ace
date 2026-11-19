//! A daemon URL proven to point at this machine. Spade's ace credentials are only ever sent to
//! one, and the only way to make one is to pass the check.

use std::fmt;
use std::io;
use std::net::{IpAddr, ToSocketAddrs};

/// What a [`LoopbackUrl`] speaks: `http` for the MCP endpoint, `ws` for the daemon socket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UrlKind {
    Http,
    Ws,
}

#[derive(Clone, PartialEq, Eq)]
pub struct LoopbackUrl {
    url: String,
    kind: UrlKind,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum UrlError {
    #[error("not a URL: {0}")]
    Malformed(String),
    #[error("only http and ws URLs reach the daemon, got {0}")]
    Scheme(String),
    #[error("a daemon URL carries no user name or password")]
    Userinfo,
    #[error("{0} is not this machine")]
    NotLoopback(String),
    #[error("could not resolve {host}: {reason}")]
    Unresolved { host: String, reason: String },
}

impl LoopbackUrl {
    /// Checks `value` with the system resolver for `localhost`.
    pub fn parse(value: &str) -> Result<Self, UrlError> {
        Self::parse_with(value, |host, port| {
            Ok((host, port)
                .to_socket_addrs()?
                .map(|address| address.ip())
                .collect())
        })
    }

    /// Checks `value`. The host must be a loopback address, or `localhost` when every address
    /// `resolve` gives for it is loopback. IP literals are never resolved.
    pub fn parse_with(
        value: &str,
        resolve: impl Fn(&str, u16) -> io::Result<Vec<IpAddr>>,
    ) -> Result<Self, UrlError> {
        let parsed =
            url::Url::parse(value).map_err(|error| UrlError::Malformed(error.to_string()))?;
        let kind = match parsed.scheme() {
            "http" => UrlKind::Http,
            "ws" => UrlKind::Ws,
            other => return Err(UrlError::Scheme(other.to_owned())),
        };
        if !parsed.username().is_empty() || parsed.password().is_some() {
            return Err(UrlError::Userinfo);
        }
        let port = parsed.port_or_known_default().unwrap_or(80);
        let loopback = match parsed.host() {
            Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            Some(url::Host::Domain("localhost")) => {
                let addresses =
                    resolve("localhost", port).map_err(|error| UrlError::Unresolved {
                        host: "localhost".into(),
                        reason: error.to_string(),
                    })?;
                !addresses.is_empty() && addresses.iter().all(IpAddr::is_loopback)
            }
            _ => false,
        };
        if !loopback {
            return Err(UrlError::NotLoopback(
                parsed.host_str().unwrap_or_default().to_owned(),
            ));
        }
        Ok(Self {
            url: parsed.into(),
            kind,
        })
    }

    pub fn kind(&self) -> UrlKind {
        self.kind
    }

    pub fn as_str(&self) -> &str {
        &self.url
    }
}

impl fmt::Debug for LoopbackUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("LoopbackUrl").field(&self.url).finish()
    }
}

impl fmt::Display for LoopbackUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.url)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    fn resolves_to(addresses: Vec<IpAddr>) -> impl Fn(&str, u16) -> io::Result<Vec<IpAddr>> {
        move |_, _| Ok(addresses.clone())
    }

    #[test]
    fn only_this_machine_passes() {
        let local = resolves_to(vec![IpAddr::V4(Ipv4Addr::LOCALHOST)]);
        for ok in [
            "http://127.0.0.1:4400/mcp",
            "ws://127.0.0.1:4300/",
            "http://[::1]:9/mcp",
            "ws://localhost:9",
        ] {
            assert!(LoopbackUrl::parse_with(ok, &local).is_ok(), "{ok}");
        }
        for (bad, why) in [
            ("http://example.com/mcp", "host"),
            ("http://10.0.0.2/mcp", "host"),
            ("https://127.0.0.1/mcp", "scheme"),
            ("http://127.0.0.1.evil.test/mcp", "host"),
            ("http://localhost@evil.test/mcp", "userinfo"),
            ("http://user@127.0.0.1/mcp", "userinfo"),
            ("not a url", "malformed"),
        ] {
            let error = LoopbackUrl::parse_with(bad, &local).err();
            let matched = matches!(
                (&error, why),
                (Some(UrlError::NotLoopback(_)), "host")
                    | (Some(UrlError::Scheme(_)), "scheme")
                    | (Some(UrlError::Userinfo), "userinfo")
                    | (Some(UrlError::Malformed(_)), "malformed")
            );
            assert!(matched, "{bad}: {error:?}");
        }
    }

    #[test]
    fn localhost_must_resolve_only_to_loopback() {
        let mixed = resolves_to(vec![
            IpAddr::V6(Ipv6Addr::LOCALHOST),
            IpAddr::V4(Ipv4Addr::new(192, 168, 1, 9)),
        ]);
        assert!(matches!(
            LoopbackUrl::parse_with("ws://localhost:9", mixed),
            Err(UrlError::NotLoopback(_))
        ));
        assert!(matches!(
            LoopbackUrl::parse_with("ws://localhost:9", resolves_to(vec![])),
            Err(UrlError::NotLoopback(_))
        ));
        let failing = |_: &str, _: u16| Err(io::Error::other("no resolver"));
        assert!(matches!(
            LoopbackUrl::parse_with("ws://localhost:9", failing),
            Err(UrlError::Unresolved { .. })
        ));
    }
}
