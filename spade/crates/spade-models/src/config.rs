//! Model settings, read through an injected lookup so tests never touch the real environment.
//!
//! - `SPADE_MODEL_GATEWAY`: `openrouter` (default), `opencode-go` or `anthropic`.
//! - The gateway's key: `OPENROUTER_API_KEY`, `OPENCODE_API_KEY` or `ANTHROPIC_API_KEY`.
//! - `SPADE_MODEL_ROOT`: optional address replacing the gateway's root (a proxy or test server).
//! - `SPADE_MODEL_CATALOG`: the model catalogue file, `config/models.json` by default.

use std::fmt;
use std::path::PathBuf;

use crate::error::ModelError;
use crate::gateway::Gateway;

/// A gateway key. Never printed.
#[derive(Clone, PartialEq, Eq)]
pub struct ApiKey(String);

impl ApiKey {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ApiKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ApiKey(…)")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelsConfig {
    pub gateway: Gateway,
    pub key: ApiKey,
    pub root: Option<String>,
    pub catalog: PathBuf,
}

/// Where the catalogue is read from when `SPADE_MODEL_CATALOG` is unset.
pub const DEFAULT_CATALOG: &str = "config/models.json";

impl ModelsConfig {
    pub fn from_env(lookup: impl Fn(&str) -> Option<String>) -> Result<Self, ModelError> {
        let set = |name: &str| {
            lookup(name)
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        let gateway = match set("SPADE_MODEL_GATEWAY") {
            None => Gateway::OpenRouter,
            Some(name) => Gateway::from_name(&name).ok_or(ModelError::UnknownGateway(name))?,
        };
        let key =
            set(gateway.key_variable()).ok_or(ModelError::MissingKey(gateway.key_variable()))?;
        Ok(Self {
            gateway,
            key: ApiKey::new(key),
            root: set("SPADE_MODEL_ROOT"),
            catalog: PathBuf::from(
                set("SPADE_MODEL_CATALOG").unwrap_or_else(|| DEFAULT_CATALOG.to_owned()),
            ),
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
    fn production_gateway_is_openrouter_by_default() {
        let config = ModelsConfig::from_env(env(&[("OPENROUTER_API_KEY", "or-key")]));
        assert_eq!(
            config,
            Ok(ModelsConfig {
                gateway: Gateway::OpenRouter,
                key: ApiKey::new("or-key"),
                root: None,
                catalog: PathBuf::from("config/models.json"),
            })
        );
    }

    #[test]
    fn development_uses_the_opencode_go_key() {
        let config = ModelsConfig::from_env(env(&[
            ("SPADE_MODEL_GATEWAY", "opencode-go"),
            ("OPENCODE_API_KEY", "go-key"),
            ("OPENROUTER_API_KEY", "or-key"),
        ]));
        assert_eq!(
            config.map(|c| (c.gateway, c.key)),
            Ok((Gateway::OpenCodeGo, ApiKey::new("go-key")))
        );
    }

    #[test]
    fn a_missing_key_names_the_variable_to_set() {
        let config = ModelsConfig::from_env(env(&[("SPADE_MODEL_GATEWAY", "anthropic")]));
        assert_eq!(config, Err(ModelError::MissingKey("ANTHROPIC_API_KEY")));
    }

    #[test]
    fn the_catalogue_path_can_be_moved() {
        let config = ModelsConfig::from_env(env(&[
            ("OPENROUTER_API_KEY", "or-key"),
            ("SPADE_MODEL_CATALOG", "/etc/spade/models.json"),
        ]));
        assert_eq!(
            config.map(|c| c.catalog),
            Ok(PathBuf::from("/etc/spade/models.json"))
        );
    }

    #[test]
    fn a_blank_key_counts_as_missing() {
        let config = ModelsConfig::from_env(env(&[("OPENROUTER_API_KEY", "  ")]));
        assert_eq!(config, Err(ModelError::MissingKey("OPENROUTER_API_KEY")));
    }

    #[test]
    fn an_unknown_gateway_is_refused() {
        let config = ModelsConfig::from_env(env(&[("SPADE_MODEL_GATEWAY", "together")]));
        assert_eq!(
            config,
            Err(ModelError::UnknownGateway("together".to_owned()))
        );
    }

    #[test]
    fn the_key_never_appears_in_debug_output() {
        let config = ModelsConfig::from_env(env(&[("OPENROUTER_API_KEY", "secret-123")]));
        assert!(!format!("{config:?}").contains("secret-123"));
    }
}
