//! The search backends, read from `config/search.json`. They are tried in the order listed. Like
//! the model catalogue, the file is checked as a whole and every problem is reported at once.

use std::collections::HashSet;
use std::path::Path;

use serde::Deserialize;

/// Which search service a backend is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum Kind {
    /// The person's own SearXNG, with the `json` format enabled in its `settings.yml`.
    #[serde(rename = "searxng")]
    Searxng,
    /// Brave Search API, with the person's key.
    #[serde(rename = "brave")]
    Brave,
}

impl Kind {
    fn default_base_url(self) -> Option<&'static str> {
        match self {
            Self::Searxng => None,
            Self::Brave => Some("https://api.search.brave.com/res/v1/"),
        }
    }

    fn needs_key(self) -> bool {
        matches!(self, Self::Brave)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Backend {
    pub id: String,
    pub name: String,
    pub kind: Kind,
    /// Always ends with `/`.
    pub base_url: String,
    /// Whether calls need a key (from the keychain, then `key_env`).
    pub needs_key: bool,
    pub key_env: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchConfig {
    pub backends: Vec<Backend>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{file} is not a valid search configuration:\n  - {}", problems.join("\n  - "))]
pub struct ConfigError {
    /// The file, or `"search configuration"` when parsed from a string.
    pub file: String,
    pub problems: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    backends: Vec<FileBackend>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileBackend {
    id: String,
    name: String,
    kind: Kind,
    #[serde(default)]
    base_url: Option<String>,
    #[serde(default)]
    key: Option<FileKey>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileKey {
    #[serde(default)]
    env: Option<String>,
}

impl SearchConfig {
    pub fn load(path: &Path) -> Result<Self, ConfigError> {
        let file = path.display().to_string();
        let text = std::fs::read_to_string(path).map_err(|error| ConfigError {
            file: file.clone(),
            problems: vec![format!("cannot be read: {error}")],
        })?;
        Self::parse(&text).map_err(|problems| ConfigError { file, problems })
    }

    pub fn from_json(text: &str) -> Result<Self, ConfigError> {
        Self::parse(text).map_err(|problems| ConfigError {
            file: "search configuration".to_owned(),
            problems,
        })
    }

    fn parse(text: &str) -> Result<Self, Vec<String>> {
        let file: File = serde_json::from_str(text).map_err(|error| vec![error.to_string()])?;
        let mut problems = Vec::new();
        let mut seen = HashSet::new();
        let backends: Vec<Backend> = file
            .backends
            .into_iter()
            .map(|backend| {
                let id = backend.id.trim().to_owned();
                if id.is_empty() || id.contains('/') {
                    problems.push(format!("backend id {:?} must be non-empty, without '/'", backend.id));
                } else if !seen.insert(id.clone()) {
                    problems.push(format!("backend {id} is listed more than once"));
                }
                let base = backend
                    .base_url
                    .or_else(|| backend.kind.default_base_url().map(str::to_owned))
                    .unwrap_or_default();
                let base = base.trim();
                if !(base.starts_with("https://") || base.starts_with("http://")) {
                    problems.push(format!("backend {id}: base_url must start with https:// or http://"));
                }
                if backend.kind.needs_key() && backend.key.is_none() {
                    problems.push(format!("backend {id}: this kind needs a key; add \"key\": {{}} or \"key\": {{ \"env\": \"…\" }}"));
                }
                Backend {
                    id,
                    name: backend.name,
                    kind: backend.kind,
                    base_url: if base.ends_with('/') { base.to_owned() } else { format!("{base}/") },
                    needs_key: backend.key.is_some(),
                    key_env: backend.key.and_then(|k| k.env).map(|v| v.trim().to_owned()),
                }
            })
            .collect();
        if problems.is_empty() {
            Ok(Self { backends })
        } else {
            Err(problems)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shipped_file_lists_searxng_then_brave() -> Result<(), ConfigError> {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../config/search.json");
        let config = SearchConfig::load(&path)?;
        let order: Vec<_> = config
            .backends
            .iter()
            .map(|b| (b.id.as_str(), b.kind))
            .collect();
        assert_eq!(
            order,
            vec![("searxng", Kind::Searxng), ("brave", Kind::Brave)]
        );
        Ok(())
    }

    #[test]
    fn brave_gets_its_address_by_default_and_needs_a_key() {
        let missing_key =
            r#"{ "backends": [ { "id": "brave", "name": "Brave", "kind": "brave" } ] }"#;
        let problems = SearchConfig::from_json(missing_key)
            .err()
            .map(|e| e.problems)
            .unwrap_or_default();
        assert_eq!(problems.len(), 1, "{problems:?}");
        assert!(problems[0].contains("needs a key"));

        let ok =
            r#"{ "backends": [ { "id": "brave", "name": "Brave", "kind": "brave", "key": {} } ] }"#;
        let config = SearchConfig::from_json(ok).map_err(|e| e.to_string());
        assert_eq!(
            config.map(|c| c.backends[0].base_url.clone()),
            Ok("https://api.search.brave.com/res/v1/".to_owned())
        );
    }

    #[test]
    fn searxng_needs_an_address_and_unknown_fields_are_refused() {
        let no_url = r#"{ "backends": [ { "id": "s", "name": "S", "kind": "searxng" } ] }"#;
        assert!(SearchConfig::from_json(no_url).is_err());
        let typo = r#"{ "backends": [ { "id": "s", "name": "S", "kind": "searxng", "base_ur": "http://x/" } ] }"#;
        let problems = SearchConfig::from_json(typo)
            .err()
            .map(|e| e.problems)
            .unwrap_or_default();
        assert!(
            problems.iter().any(|p| p.contains("base_ur")),
            "{problems:?}"
        );
    }
}
