// SPDX-License-Identifier: Apache-2.0
//! Validated local and remote daemon origin URLs backed by the WHATWG `url` crate.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use url::{Host, Url};

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
        if raw.bytes().any(|b| b.is_ascii_control() || b == b' ') {
            return Err(WireError::InvalidTarget {
                detail: "Local daemon origin must not contain whitespace or control characters"
                    .into(),
            });
        }
        let parsed = Url::parse(raw).map_err(|_| WireError::InvalidTarget {
            detail: "Local daemon origin must be http://127.0.0.1[:PORT][/]".into(),
        })?;
        if parsed.scheme() != "http"
            || parsed.host() != Some(Host::Ipv4(Ipv4Addr::LOCALHOST))
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.path() != "/"
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err(WireError::InvalidTarget {
                detail: "Local daemon origin must be http://127.0.0.1[:PORT][/] without credentials, path, query, or fragment".into(),
            });
        }
        let port = parsed.port_or_known_default().unwrap_or(80);
        if port == 0 {
            return Err(WireError::InvalidTarget {
                detail: "Local daemon origin port must be non-zero".into(),
            });
        }

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

    /// Full HTTP URL for a validated `/v1/...` path.
    #[must_use]
    pub(crate) fn endpoint_url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
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
        if raw.bytes().any(|b| b.is_ascii_control() || b == b' ') {
            return Err(WireError::InvalidTarget {
                detail: "Remote origin must not contain whitespace or control characters".into(),
            });
        }
        let parsed = Url::parse(raw).map_err(|_| WireError::InvalidTarget {
            detail: "Remote origin must be a valid https://HOST[:PORT][/] URL".into(),
        })?;
        if parsed.scheme() != "https" {
            return Err(WireError::InvalidTarget {
                detail: "Remote requests require pinned HTTPS".into(),
            });
        }
        if !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.path() != "/"
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err(WireError::InvalidTarget {
                detail: "Remote origin must be https://HOST[:PORT][/] without credentials or path"
                    .into(),
            });
        }
        let port = parsed.port_or_known_default().unwrap_or(443);
        if port == 0 {
            return Err(WireError::InvalidTarget {
                detail: "Remote origin port must be non-zero".into(),
            });
        }
        let (host, is_ipv6_literal) = match parsed.host() {
            Some(Host::Domain(domain)) if !domain.is_empty() => (domain.to_owned(), false),
            Some(Host::Ipv4(addr)) => (addr.to_string(), false),
            Some(Host::Ipv6(addr)) => (addr.to_string(), true),
            _ => {
                return Err(WireError::InvalidTarget {
                    detail: "Remote origin has an invalid host".into(),
                });
            }
        };

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

    /// Full HTTPS URL for a validated `/v1/...` path.
    #[must_use]
    pub(crate) fn endpoint_url(&self, path: &str) -> String {
        if self.is_ipv6_literal {
            format!("https://[{}]:{}{path}", self.host, self.port)
        } else {
            format!("https://{}:{}{path}", self.host, self.port)
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
