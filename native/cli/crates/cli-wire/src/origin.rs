// SPDX-License-Identifier: Apache-2.0
//! Validated local and remote daemon origin URLs.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use crate::error::WireError;

/// Validated local loopback daemon origin (`http://127.0.0.1[:PORT][/]`).
///
/// Matches `HostConnection` in `apps/daemon/src/cli/daemon-endpoint.ts`:
/// protocol `http:`, hostname `127.0.0.1`, pathname `/`, no userinfo, query, or fragment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalOrigin {
    raw: String,
    port: u16,
}

impl LocalOrigin {
    /// Validates a local daemon endpoint string as written in `daemon-endpoint`.
    pub fn parse(raw: &str) -> Result<Self, WireError> {
        let rest =
            raw.strip_prefix("http://127.0.0.1")
                .ok_or_else(|| WireError::InvalidTarget {
                    detail: "Local daemon origin must be http://127.0.0.1[:PORT][/]".into(),
                })?;

        let port = if rest.is_empty() || rest == "/" {
            80
        } else if let Some(after_colon) = rest.strip_prefix(':') {
            let port_str = after_colon.strip_suffix('/').unwrap_or(after_colon);
            if port_str.is_empty() || !port_str.bytes().all(|b| b.is_ascii_digit()) {
                return Err(WireError::InvalidTarget {
                    detail: "Local daemon origin has an invalid port or path".into(),
                });
            }
            let parsed: u16 = port_str.parse().map_err(|_| WireError::InvalidTarget {
                detail: "Local daemon origin port is out of range".into(),
            })?;
            if parsed == 0 {
                return Err(WireError::InvalidTarget {
                    detail: "Local daemon origin port must be non-zero".into(),
                });
            }
            parsed
        } else {
            return Err(WireError::InvalidTarget {
                detail: "Local daemon origin must not contain a path, query, fragment, or userinfo"
                    .into(),
            });
        };

        Ok(Self {
            raw: raw.to_owned(),
            port,
        })
    }

    /// Loopback host string (`"127.0.0.1"`).
    #[must_use]
    pub const fn host(&self) -> &'static str {
        "127.0.0.1"
    }

    /// Listening TCP port (defaults to 80 if omitted, matching `Number(url.port || 80)`).
    #[must_use]
    pub const fn port(&self) -> u16 {
        self.port
    }

    /// Loopback socket address for direct TCP connection.
    #[must_use]
    pub const fn socket_addr(&self) -> SocketAddr {
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), self.port)
    }

    /// Original validated HTTP origin string.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.raw
    }

    /// HTTP `Host` header value (`127.0.0.1:PORT`).
    #[must_use]
    pub fn host_header(&self) -> String {
        format!("127.0.0.1:{}", self.port)
    }

    /// WebSocket URL (`ws://127.0.0.1:PORT/`).
    #[must_use]
    pub fn ws_url(&self) -> String {
        format!("ws://127.0.0.1:{}/", self.port)
    }
}

/// Validated remote HTTPS daemon origin (`https://HOST[:PORT][/]`).
///
/// Matches `directOrigin` in `apps/daemon/src/cli/profiles.ts`:
/// protocol `https:`, pathname `/`, no userinfo, query, or fragment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteOrigin {
    raw: String,
    host: String,
    port: u16,
    is_ipv6_literal: bool,
}

impl RemoteOrigin {
    /// Parses a remote HTTPS origin without credentials, path, query, or fragment.
    pub fn parse(raw: &str) -> Result<Self, WireError> {
        let rest = raw
            .strip_prefix("https://")
            .ok_or_else(|| WireError::InvalidTarget {
                detail: "Remote requests require pinned HTTPS".into(),
            })?;
        let authority = rest.strip_suffix('/').unwrap_or(rest);
        if authority.is_empty()
            || authority.contains(['/', '?', '#', '@', '\\', ' ', '\t', '\r', '\n'])
        {
            return Err(WireError::InvalidTarget {
                detail: "Remote origin must be https://HOST[:PORT][/] without credentials or path"
                    .into(),
            });
        }

        let (host, port, is_ipv6_literal) = if let Some(after_open) = authority.strip_prefix('[') {
            let (addr, remainder) =
                after_open
                    .split_once(']')
                    .ok_or_else(|| WireError::InvalidTarget {
                        detail: "Remote origin has an unclosed IPv6 host literal".into(),
                    })?;
            if addr.parse::<Ipv6Addr>().is_err() {
                return Err(WireError::InvalidTarget {
                    detail: "Remote origin has an invalid IPv6 host".into(),
                });
            }
            let port = parse_optional_port(remainder, 443)?;
            (addr.to_owned(), port, true)
        } else if let Some((h, p)) = authority.rsplit_once(':') {
            if h.is_empty() || h.contains(':') {
                return Err(WireError::InvalidTarget {
                    detail: "Remote origin has an invalid host".into(),
                });
            }
            let port = parse_port_digits(p)?;
            (h.to_ascii_lowercase(), port, false)
        } else {
            (authority.to_ascii_lowercase(), 443, false)
        };

        if !is_ipv6_literal && !is_valid_hostname(&host) {
            return Err(WireError::InvalidTarget {
                detail: "Remote origin has an invalid hostname".into(),
            });
        }

        Ok(Self {
            raw: raw.to_owned(),
            host,
            port,
            is_ipv6_literal,
        })
    }

    /// Hostname or IP literal (without IPv6 brackets).
    #[must_use]
    pub fn host(&self) -> &str {
        &self.host
    }

    /// TCP port (defaults to 443).
    #[must_use]
    pub const fn port(&self) -> u16 {
        self.port
    }

    /// Original validated HTTPS origin string.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.raw
    }

    /// HTTP `Host` header value.
    #[must_use]
    pub fn host_header(&self) -> String {
        if self.is_ipv6_literal {
            format!("[{}]:{}", self.host, self.port)
        } else if self.port == 443 {
            self.host.clone()
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }

    /// WebSocket URL (`wss://HOST[:PORT]/`).
    #[must_use]
    pub fn wss_url(&self) -> String {
        if self.is_ipv6_literal {
            format!("wss://[{}]:{}/", self.host, self.port)
        } else {
            format!("wss://{}:{}/", self.host, self.port)
        }
    }

    /// True if this host is a Tailscale `MagicDNS` name (`*.ts.net` and not an IP address),
    /// matching `tailnetName()` in `apps/daemon/src/client-access.ts`.
    #[must_use]
    pub fn is_tailnet(&self) -> bool {
        is_tailnet_name(&self.host)
    }
}

/// Checks whether a host is a Tailscale `MagicDNS` name (`*.ts.net` and not an IP).
#[must_use]
pub fn is_tailnet_name(host: &str) -> bool {
    let normalized = host.trim_end_matches('.');
    if normalized.is_empty() || normalized.parse::<IpAddr>().is_ok() {
        return false;
    }
    normalized.len().checked_sub(7).is_some_and(|prefix_len| {
        prefix_len > 0 && normalized[prefix_len..].eq_ignore_ascii_case(".ts.net")
    })
}

fn parse_optional_port(rest: &str, default_port: u16) -> Result<u16, WireError> {
    if rest.is_empty() {
        Ok(default_port)
    } else if let Some(digits) = rest.strip_prefix(':') {
        parse_port_digits(digits)
    } else {
        Err(WireError::InvalidTarget {
            detail: "Remote origin has trailing characters after host".into(),
        })
    }
}

fn parse_port_digits(digits: &str) -> Result<u16, WireError> {
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Err(WireError::InvalidTarget {
            detail: "Remote origin port is invalid".into(),
        });
    }
    let port: u16 = digits.parse().map_err(|_| WireError::InvalidTarget {
        detail: "Remote origin port is out of range".into(),
    })?;
    if port == 0 {
        return Err(WireError::InvalidTarget {
            detail: "Remote origin port must be non-zero".into(),
        });
    }
    Ok(port)
}

fn is_valid_hostname(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
        && !host.starts_with('.')
        && !host.contains("..")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_origin_matches_ts_host_connection_rules() {
        let with_slash = LocalOrigin::parse("http://127.0.0.1:4312/").unwrap();
        assert_eq!(with_slash.port(), 4312);
        assert_eq!(with_slash.ws_url(), "ws://127.0.0.1:4312/");

        let without_slash = LocalOrigin::parse("http://127.0.0.1:4312").unwrap();
        assert_eq!(without_slash.port(), 4312);

        let default_port = LocalOrigin::parse("http://127.0.0.1/").unwrap();
        assert_eq!(default_port.port(), 80);

        for invalid in [
            "https://127.0.0.1:4312/",
            "http://localhost:4312/",
            "http://127.0.0.1:4312/v1",
            "http://user@127.0.0.1:4312/",
            "http://127.0.0.1:4312/?a=1",
            "http://127.0.0.1:4312/#frag",
            "http://127.0.0.1:0/",
            "http://127.0.0.1:70000/",
            "http://127.0.0.1:4312/\n",
        ] {
            assert!(
                LocalOrigin::parse(invalid).is_err(),
                "expected invalid local origin: {invalid}"
            );
        }
    }

    #[test]
    fn remote_origin_and_tailnet_detection() {
        let lan = RemoteOrigin::parse("https://192.168.1.5:8443/").unwrap();
        assert_eq!(lan.host(), "192.168.1.5");
        assert_eq!(lan.port(), 8443);
        assert!(!lan.is_tailnet());

        let ts = RemoteOrigin::parse("https://Mac.Tailnet.ts.net/").unwrap();
        assert_eq!(ts.host(), "mac.tailnet.ts.net");
        assert_eq!(ts.port(), 443);
        assert!(ts.is_tailnet());

        let v6 = RemoteOrigin::parse("https://[::1]:9443").unwrap();
        assert_eq!(v6.host(), "::1");
        assert_eq!(v6.port(), 9443);
        assert_eq!(v6.wss_url(), "wss://[::1]:9443/");
        assert!(!v6.is_tailnet());

        for invalid in [
            "http://192.168.1.5:8443/",
            "https://user:pass@example.com/",
            "https://example.com/path",
            "https://example.com/?q=1",
            "https://example.com/#h",
        ] {
            assert!(
                RemoteOrigin::parse(invalid).is_err(),
                "expected invalid remote origin: {invalid}"
            );
        }
    }
}
