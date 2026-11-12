//! Finding the daemon without being started by it (docs/ace-integration.md, "Finding the
//! daemon"): `<ace home>/daemon-endpoint` holds `http://127.0.0.1:PORT`, `daemon-token` the local
//! token. Both are read on every connect, since the daemon may restart on another port.

use std::path::Path;
use std::time::Duration;

use crate::config::{AceConfig, ConfigError, DEFAULT_TIMEOUT, SkillsConfig, ToolsConfig};
use crate::url::{LoopbackUrl, UrlError, UrlKind};
use spade_mcp::Secret;

/// The first wait before connecting again, and the longest.
pub const FIRST_RETRY: Duration = Duration::from_secs(1);
pub const LONGEST_RETRY: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DiscoveryError {
    /// The daemon is not running (or has not written its files yet).
    #[error("{0} is missing")]
    Missing(&'static str),
    #[error("could not read {name}: {reason}")]
    Unreadable { name: &'static str, reason: String },
    #[error("daemon-endpoint: {0}")]
    Endpoint(UrlError),
    #[error(transparent)]
    Config(#[from] ConfigError),
}

/// The wait before the next connect after `previous` (none after a success): 1 s, doubling, at
/// most 30 s.
pub fn next_retry(previous: Option<Duration>) -> Duration {
    next_retry_between(previous, FIRST_RETRY, LONGEST_RETRY)
}

/// [`next_retry`] with other bounds (tests use milliseconds).
pub fn next_retry_between(
    previous: Option<Duration>,
    first: Duration,
    longest: Duration,
) -> Duration {
    previous.map_or(first, |d| (d * 2).clamp(first, longest.max(first)))
}

/// The MCP and WebSocket URLs for the daemon at `endpoint` (`http://127.0.0.1:PORT`).
pub fn daemon_urls(endpoint: &str) -> Result<(LoopbackUrl, LoopbackUrl), UrlError> {
    let base = endpoint.trim().trim_end_matches('/');
    let mcp = LoopbackUrl::parse(&format!("{base}/mcp"))?;
    if mcp.kind() != UrlKind::Http {
        return Err(UrlError::Scheme("ws".to_owned()));
    }
    let socket = base
        .strip_prefix("http://")
        .ok_or_else(|| UrlError::Scheme(base.split(':').next().unwrap_or_default().to_owned()))?;
    let ws = LoopbackUrl::parse(&format!("ws://{socket}/"))?;
    Ok((mcp, ws))
}

/// How to reach the daemon from `ace_home`'s files, with `grant` as the MCP bearer.
pub fn discover(ace_home: &Path, grant: Secret) -> Result<AceConfig, DiscoveryError> {
    let endpoint = read(ace_home, "daemon-endpoint")?;
    let token = read(ace_home, "daemon-token")?;
    let (mcp, ws) = daemon_urls(&endpoint).map_err(DiscoveryError::Endpoint)?;
    Ok(AceConfig {
        tools: ToolsConfig::new(mcp, grant, DEFAULT_TIMEOUT)?,
        skills: SkillsConfig::new(ws, Secret::new(token), "spade", DEFAULT_TIMEOUT)?,
    })
}

fn read(dir: &Path, name: &'static str) -> Result<String, DiscoveryError> {
    match std::fs::read_to_string(dir.join(name)) {
        Ok(text) if !text.trim().is_empty() => Ok(text.trim().to_owned()),
        Ok(_) => Err(DiscoveryError::Missing(name)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Err(DiscoveryError::Missing(name))
        }
        Err(error) => Err(DiscoveryError::Unreadable {
            name,
            reason: error.to_string(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retries_start_at_a_second_and_double_up_to_thirty() {
        let mut waits = Vec::new();
        let mut last = None;
        for _ in 0..8 {
            let wait = next_retry(last);
            waits.push(wait.as_secs());
            last = Some(wait);
        }
        assert_eq!(waits, vec![1, 2, 4, 8, 16, 30, 30, 30]);
    }

    #[test]
    fn the_endpoint_gives_mcp_and_socket_urls_on_the_same_port() -> Result<(), UrlError> {
        let (mcp, ws) = daemon_urls("http://127.0.0.1:4310\n")?;
        assert_eq!(mcp.as_str(), "http://127.0.0.1:4310/mcp");
        assert_eq!(ws.as_str(), "ws://127.0.0.1:4310/");
        let (mcp, _) = daemon_urls("http://127.0.0.1:4310/")?;
        assert_eq!(mcp.as_str(), "http://127.0.0.1:4310/mcp");
        Ok(())
    }

    #[test]
    fn an_endpoint_off_the_machine_or_not_http_is_refused() {
        assert!(matches!(
            daemon_urls("http://example.com:4310"),
            Err(UrlError::NotLoopback(_))
        ));
        assert!(daemon_urls("ws://127.0.0.1:4310").is_err());
        assert!(daemon_urls("https://127.0.0.1:4310").is_err());
    }

    #[test]
    fn files_are_read_on_each_discover_and_missing_ones_are_named()
    -> Result<(), Box<dyn std::error::Error>> {
        let temp = tempfile::tempdir()?;
        let dir = temp.path();
        assert_eq!(
            discover(dir, Secret::new("g")).err(),
            Some(DiscoveryError::Missing("daemon-endpoint"))
        );
        std::fs::write(dir.join("daemon-endpoint"), "http://127.0.0.1:4310\n")?;
        assert_eq!(
            discover(dir, Secret::new("g")).err(),
            Some(DiscoveryError::Missing("daemon-token"))
        );
        std::fs::write(dir.join("daemon-token"), "local\n")?;
        let config = discover(dir, Secret::new("g"))?;
        assert_eq!(config.tools.url().as_str(), "http://127.0.0.1:4310/mcp");
        std::fs::write(dir.join("daemon-endpoint"), "http://127.0.0.1:4999")?;
        let moved = discover(dir, Secret::new("g"))?;
        assert_eq!(moved.skills.url().as_str(), "ws://127.0.0.1:4999/");
        Ok(())
    }
}
