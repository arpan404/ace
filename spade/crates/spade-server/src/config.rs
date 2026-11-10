//! Server settings, read from the environment through an injected lookup so tests
//! never touch the real process environment.

use std::fmt;
use std::net::SocketAddr;

/// Address used when `SPADE_LISTEN` is unset: loopback, behind the VM's reverse proxy.
pub const DEFAULT_LISTEN: &str = "127.0.0.1:3000";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub listen: SocketAddr,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigError {
    InvalidListen(String),
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidListen(value) => write!(
                f,
                "SPADE_LISTEN must be an address like {DEFAULT_LISTEN}, got {value:?}"
            ),
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
        Ok(Self { listen })
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
    fn refuses_a_listen_value_that_is_not_an_address() {
        let config = Config::from_env(env(&[("SPADE_LISTEN", "3000")]));
        assert_eq!(config, Err(ConfigError::InvalidListen("3000".to_owned())));
    }
}
