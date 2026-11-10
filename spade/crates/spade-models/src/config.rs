//! Model settings and API keys, both read through injected lookups so tests never touch the real
//! environment.
//!
//! - `SPADE_MODEL_CATALOG`: the catalogue file, `config/models.json` by default.
//! - Each endpoint names the environment variable that holds its key (`key.env` in the file).

use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;

/// Where the catalogue is read from when `SPADE_MODEL_CATALOG` is unset.
pub const DEFAULT_CATALOG: &str = "config/models.json";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelsConfig {
    pub catalog: PathBuf,
}

impl ModelsConfig {
    pub fn from_env(lookup: impl Fn(&str) -> Option<String>) -> Self {
        let catalog = lookup("SPADE_MODEL_CATALOG")
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| DEFAULT_CATALOG.to_owned());
        Self {
            catalog: PathBuf::from(catalog),
        }
    }
}

/// A key lookup by environment variable name.
type Lookup = dyn Fn(&str) -> Option<String> + Send + Sync;

/// Looks up an endpoint's key by environment variable name. Keys are never printed.
#[derive(Clone)]
pub struct Keys(Arc<Lookup>);

impl Keys {
    pub fn new(lookup: impl Fn(&str) -> Option<String> + Send + Sync + 'static) -> Self {
        Self(Arc::new(lookup))
    }

    /// Keys from this process's environment.
    pub fn from_process_env() -> Self {
        Self::new(|name| std::env::var(name).ok())
    }

    /// The key in `name`, if set and not blank.
    pub(crate) fn get(&self, name: &str) -> Option<String> {
        (self.0)(name)
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
    }
}

impl fmt::Debug for Keys {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Keys(…)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_catalogue_is_config_models_json_unless_moved() {
        let unset = ModelsConfig::from_env(|_| None);
        assert_eq!(unset.catalog, PathBuf::from("config/models.json"));
        let moved = ModelsConfig::from_env(|k| {
            (k == "SPADE_MODEL_CATALOG").then(|| "/etc/spade/models.json".to_owned())
        });
        assert_eq!(moved.catalog, PathBuf::from("/etc/spade/models.json"));
    }

    #[test]
    fn a_blank_key_counts_as_missing() {
        let keys = Keys::new(|name| (name == "OPENAI_API_KEY").then(|| "   ".to_owned()));
        assert_eq!(keys.get("OPENAI_API_KEY"), None);
    }
}
