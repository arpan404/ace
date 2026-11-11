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
    /// `SPADE_DAILY_CAP_USD`: a day's spending cap in dollars.
    pub daily_cap_usd: f64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigError {
    InvalidListen(String),
    InvalidCap(String),
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidListen(value) => write!(
                f,
                "SPADE_LISTEN must be an address like {DEFAULT_LISTEN}, got {value:?}"
            ),
            Self::InvalidCap(value) => write!(
                f,
                "SPADE_DAILY_CAP_USD must be a number of dollars, zero or more, got {value:?}"
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
        let data_dir = PathBuf::from(
            lookup("SPADE_DATA_DIR")
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "data".to_owned()),
        );
        let cap = lookup("SPADE_DAILY_CAP_USD").unwrap_or_else(|| "5".to_owned());
        let daily_cap_usd = cap
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|v| v.is_finite() && *v >= 0.0)
            .ok_or(ConfigError::InvalidCap(cap))?;
        Ok(Self {
            listen,
            data_dir,
            daily_cap_usd,
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
    fn data_lives_in_data_and_the_cap_is_five_dollars_unless_set() {
        let config = Config::from_env(env(&[])).map(|c| (c.data_dir, c.daily_cap_usd));
        assert_eq!(config, Ok((PathBuf::from("data"), 5.0)));
        let set = Config::from_env(env(&[
            ("SPADE_DATA_DIR", "/var/spade"),
            ("SPADE_DAILY_CAP_USD", "0.5"),
        ]))
        .map(|c| (c.data_dir, c.daily_cap_usd));
        assert_eq!(set, Ok((PathBuf::from("/var/spade"), 0.5)));
    }

    #[test]
    fn refuses_a_cap_that_is_not_a_positive_number() {
        let config = Config::from_env(env(&[("SPADE_DAILY_CAP_USD", "-1")]));
        assert_eq!(config, Err(ConfigError::InvalidCap("-1".to_owned())));
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
