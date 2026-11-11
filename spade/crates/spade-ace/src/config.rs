//! Where the daemon is and how to prove who Spade is. The daemon hands these over as environment
//! variables (docs/ace-integration.md, "The Spade process"). Both configs take a [`LoopbackUrl`],
//! so a credential can't be pointed off the machine.

use std::time::Duration;

use crate::secret::Secret;
use crate::url::{LoopbackUrl, UrlError, UrlKind};

/// What a bridge request may take before it gives up, unless the caller sets its own.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConfigError {
    /// Spade was started outside ace, or by a daemon that does not hand these out yet.
    #[error("{0} is not set")]
    Missing(&'static str),
    #[error("{name}: {error}")]
    Url { name: &'static str, error: UrlError },
    #[error("{name} must be a {expected:?} URL")]
    WrongKind {
        name: &'static str,
        expected: UrlKind,
    },
}

/// The daemon's loopback MCP endpoint and Spade's bearer for it.
#[derive(Debug, Clone)]
pub struct ToolsConfig {
    url: LoopbackUrl,
    token: Secret,
    timeout: Duration,
}

impl ToolsConfig {
    /// `url` must be an `http` loopback URL. Each connect, page and call gives up after `timeout`.
    pub fn new(url: LoopbackUrl, token: Secret, timeout: Duration) -> Result<Self, ConfigError> {
        kind("tools url", &url, UrlKind::Http)?;
        Ok(Self {
            url,
            token,
            timeout,
        })
    }

    pub fn url(&self) -> &LoopbackUrl {
        &self.url
    }

    pub(crate) fn token(&self) -> &Secret {
        &self.token
    }

    pub fn timeout(&self) -> Duration {
        self.timeout
    }
}

/// The daemon's loopback WebSocket and its local token.
#[derive(Debug, Clone)]
pub struct SkillsConfig {
    url: LoopbackUrl,
    token: Secret,
    device_id: String,
    timeout: Duration,
}

impl SkillsConfig {
    /// `url` must be a `ws` loopback URL. `device_id` is what `hello` names; the local token
    /// isn't tied to one, so any stable id works. Connecting, the hello, each write and each
    /// request give up after `timeout`.
    pub fn new(
        url: LoopbackUrl,
        token: Secret,
        device_id: impl Into<String>,
        timeout: Duration,
    ) -> Result<Self, ConfigError> {
        kind("skills url", &url, UrlKind::Ws)?;
        Ok(Self {
            url,
            token,
            device_id: device_id.into(),
            timeout,
        })
    }

    pub fn url(&self) -> &LoopbackUrl {
        &self.url
    }

    pub(crate) fn token(&self) -> &Secret {
        &self.token
    }

    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    pub fn timeout(&self) -> Duration {
        self.timeout
    }
}

#[derive(Debug, Clone)]
pub struct AceConfig {
    pub tools: ToolsConfig,
    pub skills: SkillsConfig,
}

impl AceConfig {
    /// Reads `SPADE_ACE_MCP_URL`, `SPADE_ACE_MCP_TOKEN`, `SPADE_ACE_URL` and `SPADE_ACE_TOKEN`
    /// through `var`, so tests pass their own environment.
    pub fn from_env(var: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let read = |name: &'static str| {
            var(name)
                .filter(|value| !value.trim().is_empty())
                .ok_or(ConfigError::Missing(name))
        };
        let url = |name: &'static str| {
            LoopbackUrl::parse(&read(name)?).map_err(|error| ConfigError::Url { name, error })
        };
        let tools = ToolsConfig::new(
            url("SPADE_ACE_MCP_URL")?,
            Secret::new(read("SPADE_ACE_MCP_TOKEN")?),
            DEFAULT_TIMEOUT,
        )
        .map_err(|_| ConfigError::WrongKind {
            name: "SPADE_ACE_MCP_URL",
            expected: UrlKind::Http,
        })?;
        let skills = SkillsConfig::new(
            url("SPADE_ACE_URL")?,
            Secret::new(read("SPADE_ACE_TOKEN")?),
            "spade",
            DEFAULT_TIMEOUT,
        )
        .map_err(|_| ConfigError::WrongKind {
            name: "SPADE_ACE_URL",
            expected: UrlKind::Ws,
        })?;
        Ok(Self { tools, skills })
    }
}

fn kind(name: &'static str, url: &LoopbackUrl, expected: UrlKind) -> Result<(), ConfigError> {
    if url.kind() == expected {
        Ok(())
    } else {
        Err(ConfigError::WrongKind { name, expected })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        move |name| map.get(name).cloned()
    }

    const FULL: [(&str, &str); 4] = [
        ("SPADE_ACE_MCP_URL", "http://127.0.0.1:4400/mcp"),
        ("SPADE_ACE_MCP_TOKEN", "mcp-secret"),
        ("SPADE_ACE_URL", "ws://127.0.0.1:4300/"),
        ("SPADE_ACE_TOKEN", "local-secret"),
    ];

    #[test]
    fn reads_the_four_variables_the_daemon_sets() {
        let config = AceConfig::from_env(env(&FULL)).ok();
        let config = config.as_ref();
        assert_eq!(
            config.map(|c| c.tools.url().as_str()),
            Some("http://127.0.0.1:4400/mcp")
        );
        assert_eq!(
            config.map(|c| c.skills.url().as_str()),
            Some("ws://127.0.0.1:4300/")
        );
        assert!(!format!("{config:?}").contains("secret"));
    }

    #[test]
    fn a_missing_or_blank_variable_is_named() {
        let mut pairs = FULL.to_vec();
        pairs[1].1 = "  ";
        assert_eq!(
            AceConfig::from_env(env(&pairs)).err(),
            Some(ConfigError::Missing("SPADE_ACE_MCP_TOKEN"))
        );
        assert_eq!(
            AceConfig::from_env(env(&FULL[1..])).err(),
            Some(ConfigError::Missing("SPADE_ACE_MCP_URL"))
        );
    }

    #[test]
    fn the_environment_cannot_point_a_credential_off_the_machine() {
        for (index, url) in [
            (0, "http://example.com/mcp"),
            (0, "http://127.0.0.1.evil.test/mcp"),
            (2, "ws://10.1.2.3:4300/"),
            (2, "ws://localhost@evil.test/"),
        ] {
            let mut pairs = FULL.to_vec();
            pairs[index].1 = url;
            assert!(
                matches!(
                    AceConfig::from_env(env(&pairs)),
                    Err(ConfigError::Url { .. })
                ),
                "{url}"
            );
        }
        // Each endpoint also needs its own scheme.
        let mut pairs = FULL.to_vec();
        pairs[0].1 = "ws://127.0.0.1:4400/";
        assert!(matches!(
            AceConfig::from_env(env(&pairs)),
            Err(ConfigError::WrongKind {
                name: "SPADE_ACE_MCP_URL",
                ..
            })
        ));
    }

    #[test]
    fn each_config_takes_only_its_own_kind_of_loopback_url() {
        let ws = LoopbackUrl::parse("ws://127.0.0.1:1/").ok();
        let http = LoopbackUrl::parse("http://127.0.0.1:1/mcp").ok();
        let (Some(ws), Some(http)) = (ws, http) else {
            panic!("loopback URLs refused");
        };
        let token = Secret::new("t");
        assert!(ToolsConfig::new(ws.clone(), token.clone(), DEFAULT_TIMEOUT).is_err());
        assert!(SkillsConfig::new(http.clone(), token.clone(), "spade", DEFAULT_TIMEOUT).is_err());
        assert!(ToolsConfig::new(http, token.clone(), DEFAULT_TIMEOUT).is_ok());
        assert!(SkillsConfig::new(ws, token, "spade", DEFAULT_TIMEOUT).is_ok());
    }
}
