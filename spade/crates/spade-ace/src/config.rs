//! The daemon hands Spade its ace credentials as environment variables
//! (docs/ace-integration.md, "The Spade process").

use std::time::Duration;

use crate::secret::Secret;
use crate::skills::SkillsConfig;
use crate::tools::ToolsConfig;

/// What a bridge request may take before it gives up, unless the caller sets its own.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
pub struct AceConfig {
    pub tools: ToolsConfig,
    pub skills: SkillsConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConfigError {
    /// Spade was started outside ace, or by a daemon that does not hand these out yet.
    #[error("{0} is not set")]
    Missing(&'static str),
    #[error("{name} must be a loopback {scheme} URL, got {value}")]
    NotLoopback {
        name: &'static str,
        scheme: &'static str,
        value: String,
    },
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
        let mcp_url = loopback("SPADE_ACE_MCP_URL", read("SPADE_ACE_MCP_URL")?, &["http"])?;
        let ws_url = loopback("SPADE_ACE_URL", read("SPADE_ACE_URL")?, &["ws"])?;
        Ok(Self {
            tools: ToolsConfig {
                url: mcp_url,
                token: Secret::new(read("SPADE_ACE_MCP_TOKEN")?),
                timeout: DEFAULT_TIMEOUT,
            },
            skills: SkillsConfig {
                url: ws_url,
                token: Secret::new(read("SPADE_ACE_TOKEN")?),
                device_id: "spade".into(),
                timeout: DEFAULT_TIMEOUT,
            },
        })
    }
}

/// Both endpoints are the daemon's loopback listeners; the bearer is never sent anywhere else.
fn loopback(
    name: &'static str,
    value: String,
    schemes: &[&'static str],
) -> Result<String, ConfigError> {
    let scheme = schemes[0];
    let ok = schemes.iter().any(|scheme| {
        let Some(rest) = value.strip_prefix(&format!("{scheme}://")) else {
            return false;
        };
        let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
        let host = match host.rsplit_once(':') {
            Some((host, port)) if port.chars().all(|c| c.is_ascii_digit()) => host,
            _ => host,
        };
        matches!(host, "127.0.0.1" | "localhost" | "[::1]")
    });
    if ok {
        Ok(value)
    } else {
        Err(ConfigError::NotLoopback {
            name,
            scheme,
            value,
        })
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
            config.map(|c| c.tools.url.as_str()),
            Some("http://127.0.0.1:4400/mcp")
        );
        assert_eq!(
            config.map(|c| c.skills.url.as_str()),
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
    fn a_credential_is_never_pointed_off_the_machine() {
        for url in [
            "http://example.com/mcp",
            "https://127.0.0.1/mcp",
            "http://127.0.0.1.evil.test/mcp",
            "http://localhost@evil.test/mcp",
        ] {
            let mut pairs = FULL.to_vec();
            pairs[0].1 = url;
            assert!(
                matches!(
                    AceConfig::from_env(env(&pairs)),
                    Err(ConfigError::NotLoopback { .. })
                ),
                "{url}"
            );
        }
        let mut pairs = FULL.to_vec();
        pairs[0].1 = "http://localhost:9/mcp";
        pairs[2].1 = "ws://[::1]:9";
        assert!(AceConfig::from_env(env(&pairs)).is_ok());
    }
}
