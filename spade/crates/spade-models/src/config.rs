//! Model settings, read through an injected lookup so tests never touch the real environment.
//! Keys are looked up through `spade_keys::Keys` (ADR 0116).
//!
//! - `SPADE_MODEL_CATALOG`: the catalogue file, `config/models.json` by default.

use std::path::PathBuf;

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
}
