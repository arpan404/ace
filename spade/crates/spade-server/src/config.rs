//! Server settings, read from the environment through an injected lookup so tests
//! never touch the real process environment.

use std::fmt;
use std::net::SocketAddr;
use std::path::PathBuf;

/// Address used when `SPADE_LISTEN` is unset: loopback. The ace daemon passes `127.0.0.1:0`.
pub const DEFAULT_LISTEN: &str = "127.0.0.1:3000";

#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    pub listen: SocketAddr,
    /// `SPADE_DATA_DIR`: the database, token, lock, `server.json`, `models.json`, `search.json`.
    pub data_dir: PathBuf,
    /// `SPADE_PARALLEL_TOOLS`: tool calls of one step run at once; unset is the engine's default.
    pub parallel_tools: Option<usize>,
    /// `SPADE_HELPERS_AT_ONCE`: helpers of one bot run at once; unset is the engine's default.
    pub helpers_at_once: Option<usize>,
    /// `SPADE_WORKERS_AT_ONCE`: one orchestrator's worker bots that work at once (ADR 0161);
    /// unset is the engine's default.
    pub workers_at_once: Option<usize>,
    /// `SPADE_CONTEXT_TOKENS`: compact before this many prompt tokens even when the model's own
    /// window is larger (a cost choice); unset uses each model's window.
    pub context_tokens: Option<u32>,
    /// `SPADE_KNOWLEDGE_BYTES`: the size of each bot's knowledge base when the person set none
    /// (ADR 0164); unset is the engine's default.
    pub knowledge_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigError {
    InvalidListen(String),
    /// A setting that must be a whole number above zero: its name and value.
    InvalidCount(&'static str, String),
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidListen(value) => write!(
                f,
                "SPADE_LISTEN must be an address like {DEFAULT_LISTEN}, got {value:?}"
            ),
            Self::InvalidCount(name, value) => {
                write!(f, "{name} must be a whole number above zero, got {value:?}")
            }
        }
    }
}

impl std::error::Error for ConfigError {}

impl Config {
    /// Builds the config from `lookup`, which returns a variable's value if it is set.
    pub fn from_env(lookup: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let raw = lookup("SPADE_LISTEN").unwrap_or_else(|| DEFAULT_LISTEN.to_owned());
        let listen = raw
            .trim()
            .parse()
            .map_err(|_| ConfigError::InvalidListen(raw.clone()))?;
        let data_dir = PathBuf::from(
            lookup("SPADE_DATA_DIR")
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "data".to_owned()),
        );
        // `SPADE_DAILY_CAP_USD` is no longer read: Spade has no spending limits (ADR 0166).
        let count = |name: &'static str| -> Result<Option<u64>, ConfigError> {
            match lookup(name).filter(|v| !v.trim().is_empty()) {
                None => Ok(None),
                Some(value) => match value.trim().parse::<u64>() {
                    Ok(n) if n > 0 => Ok(Some(n)),
                    _ => Err(ConfigError::InvalidCount(name, value)),
                },
            }
        };
        let parallel_tools = count("SPADE_PARALLEL_TOOLS")?.map(|n| n as usize);
        let helpers_at_once = count("SPADE_HELPERS_AT_ONCE")?.map(|n| n as usize);
        let workers_at_once = count("SPADE_WORKERS_AT_ONCE")?.map(|n| n as usize);
        let context_tokens =
            count("SPADE_CONTEXT_TOKENS")?.map(|n| u32::try_from(n).unwrap_or(u32::MAX));
        let knowledge_bytes = count("SPADE_KNOWLEDGE_BYTES")?;
        Ok(Self {
            listen,
            data_dir,
            parallel_tools,
            helpers_at_once,
            workers_at_once,
            context_tokens,
            knowledge_bytes,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |key| {
            pairs
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| (*v).to_owned())
        }
    }

    #[test]
    fn listens_on_loopback_port_3000_when_unset() {
        let config = Config::from_env(env(&[]));
        assert_eq!(
            config.map(|c| c.listen.to_string()),
            Ok("127.0.0.1:3000".to_owned())
        );
    }

    #[test]
    fn uses_the_address_given_in_spade_listen() {
        let config = Config::from_env(env(&[("SPADE_LISTEN", "0.0.0.0:8080")]));
        assert_eq!(
            config.map(|c| c.listen.to_string()),
            Ok("0.0.0.0:8080".to_owned())
        );
    }

    #[test]
    fn data_lives_in_data_unless_set() {
        let config = Config::from_env(env(&[])).map(|c| c.data_dir);
        assert_eq!(config, Ok(PathBuf::from("data")));
        let set = Config::from_env(env(&[("SPADE_DATA_DIR", "/var/spade")])).map(|c| c.data_dir);
        assert_eq!(set, Ok(PathBuf::from("/var/spade")));
    }

    #[test]
    fn counts_are_unset_unless_given_and_must_be_above_zero() {
        let config = Config::from_env(env(&[])).map(|c| (c.parallel_tools, c.context_tokens));
        assert_eq!(config, Ok((None, None)));
        let set = Config::from_env(env(&[
            ("SPADE_PARALLEL_TOOLS", "32"),
            ("SPADE_HELPERS_AT_ONCE", "8"),
            ("SPADE_CONTEXT_TOKENS", "300000"),
        ]))
        .map(|c| (c.parallel_tools, c.helpers_at_once, c.context_tokens));
        assert_eq!(set, Ok((Some(32), Some(8), Some(300_000))));
        assert_eq!(
            Config::from_env(env(&[("SPADE_HELPERS_AT_ONCE", "0")])),
            Err(ConfigError::InvalidCount(
                "SPADE_HELPERS_AT_ONCE",
                "0".to_owned()
            ))
        );
    }

    #[test]
    fn a_daily_cap_left_in_the_environment_is_ignored() {
        let config = Config::from_env(env(&[("SPADE_DAILY_CAP_USD", "-1")]));
        assert_eq!(
            config.map(|c| c.data_dir),
            Ok(PathBuf::from("data")),
            "Spade has no spending limits, so an old cap neither applies nor fails start"
        );
    }

    #[test]
    fn refuses_a_listen_value_that_is_not_an_address() {
        let config = Config::from_env(env(&[("SPADE_LISTEN", "3000")]));
        assert_eq!(
            config.map(|c| c.listen),
            Err(ConfigError::InvalidListen("3000".to_owned()))
        );
    }
}
