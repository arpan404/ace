//! The models Spade uses, loaded from a JSON file (`config/models.json` by default) when Spade
//! starts. Changing models means editing that file and restarting; nothing is recompiled.
//!
//! Keep the list curated: the current model of each family worth running, nothing older and no
//! variants that add cost without a reason. Loading checks the whole file and reports every
//! problem at once, so a bad edit stops Spade at startup instead of failing a call later.

use std::collections::{BTreeMap, HashSet};
use std::fmt;
use std::path::Path;

use serde::Deserialize;

use crate::gateway::{Gateway, Protocol};

/// What a call is for. Callers ask for a role; the catalogue's defaults pick the model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// Everyday chat and tool use.
    Main,
    /// Cheap, quick work: routing group chat, extracting memories, short summaries.
    Fast,
    /// Hard reasoning and long plans.
    Deep,
}

/// A model Spade can call. `id` is Spade's own name for it, used everywhere else.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Model {
    pub id: String,
    pub name: String,
    routes: Vec<Route>,
}

/// One gateway's way to reach a model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Route {
    pub gateway: Gateway,
    pub protocol: Protocol,
    /// The model id that gateway expects.
    pub model: String,
}

impl Model {
    /// How `gateway` reaches this model, if it can.
    pub fn route(&self, gateway: Gateway) -> Option<&Route> {
        self.routes.iter().find(|route| route.gateway == gateway)
    }

    pub fn routes(&self) -> &[Route] {
        &self.routes
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Catalog {
    models: Vec<Model>,
    defaults: BTreeMap<Gateway, Defaults>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
struct Defaults {
    main: String,
    fast: String,
    deep: String,
}

impl Defaults {
    fn get(&self, role: Role) -> &str {
        match role {
            Role::Main => &self.main,
            Role::Fast => &self.fast,
            Role::Deep => &self.deep,
        }
    }
}

/// Everything wrong with a catalogue file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogError {
    /// The file, or `"catalogue"` when parsed from a string.
    pub source: String,
    pub problems: Vec<String>,
}

impl fmt::Display for CatalogError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} is not a valid model catalogue:", self.source)?;
        for problem in &self.problems {
            write!(f, "\n  - {problem}")?;
        }
        Ok(())
    }
}

impl std::error::Error for CatalogError {}

// The file's shape. Unknown fields are refused so a typo cannot be silently ignored.

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    /// When the provider ids were last checked; for people, not used by Spade.
    #[serde(default)]
    #[allow(dead_code)]
    checked: Option<String>,
    defaults: BTreeMap<Gateway, Defaults>,
    models: Vec<FileModel>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileModel {
    id: String,
    name: String,
    routes: BTreeMap<Gateway, FileRoute>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileRoute {
    model: String,
    /// Defaults to the gateway's own protocol.
    #[serde(default)]
    protocol: Option<Protocol>,
}

impl Catalog {
    /// Reads and checks the catalogue file at `path`.
    pub fn load(path: &Path) -> Result<Self, CatalogError> {
        let source = path.display().to_string();
        let text = std::fs::read_to_string(path).map_err(|error| CatalogError {
            source: source.clone(),
            problems: vec![format!("cannot be read: {error}")],
        })?;
        Self::parse(&text).map_err(|problems| CatalogError { source, problems })
    }

    /// Parses and checks a catalogue held in memory.
    pub fn from_json(text: &str) -> Result<Self, CatalogError> {
        Self::parse(text).map_err(|problems| CatalogError {
            source: "catalogue".to_owned(),
            problems,
        })
    }

    pub fn models(&self) -> &[Model] {
        &self.models
    }

    pub fn find(&self, id: &str) -> Option<&Model> {
        self.models.iter().find(|model| model.id == id)
    }

    /// The model `gateway` uses for `role`, if the catalogue sets defaults for that gateway.
    pub fn default_for(&self, gateway: Gateway, role: Role) -> Option<&str> {
        self.defaults
            .get(&gateway)
            .map(|defaults| defaults.get(role))
    }

    fn parse(text: &str) -> Result<Self, Vec<String>> {
        let file: File = serde_json::from_str(text).map_err(|error| vec![error.to_string()])?;
        let mut problems = Vec::new();
        let models: Vec<Model> = file
            .models
            .into_iter()
            .map(|model| check_model(model, &mut problems))
            .collect();
        if models.is_empty() {
            problems.push("lists no models".to_owned());
        }
        let mut seen = HashSet::new();
        for model in &models {
            if !seen.insert(model.id.as_str()) {
                problems.push(format!("model {} is listed more than once", model.id));
            }
        }
        let catalog = Self {
            models,
            defaults: file.defaults,
        };
        catalog.check_defaults(&mut problems);
        if problems.is_empty() {
            Ok(catalog)
        } else {
            Err(problems)
        }
    }

    fn check_defaults(&self, problems: &mut Vec<String>) {
        for (gateway, defaults) in &self.defaults {
            for (role, id) in [
                ("main", &defaults.main),
                ("fast", &defaults.fast),
                ("deep", &defaults.deep),
            ] {
                match self.find(id) {
                    None => problems.push(format!(
                        "{gateway} {role} default {id} is not a listed model"
                    )),
                    Some(model) if model.route(*gateway).is_none() => problems.push(format!(
                        "{gateway} {role} default {id} has no {gateway} route"
                    )),
                    Some(_) => {}
                }
            }
        }
    }
}

fn check_model(model: FileModel, problems: &mut Vec<String>) -> Model {
    let label = if model.id.trim().is_empty() {
        problems.push("a model has an empty id".to_owned());
        "(no id)".to_owned()
    } else {
        model.id.clone()
    };
    if model.name.trim().is_empty() {
        problems.push(format!("model {label} has an empty name"));
    }
    if model.routes.is_empty() {
        problems.push(format!("model {label} has no routes"));
    }
    let routes = model
        .routes
        .into_iter()
        .map(|(gateway, route)| {
            let protocol = route.protocol.unwrap_or(gateway.default_protocol());
            if !gateway.serves(protocol) {
                problems.push(format!(
                    "model {label}: {gateway} does not serve the {protocol} protocol"
                ));
            }
            if route.model.trim().is_empty() {
                problems.push(format!("model {label}: {gateway} route has an empty model"));
            }
            Route {
                gateway,
                protocol,
                model: route.model,
            }
        })
        .collect();
    Model {
        id: model.id,
        name: model.name,
        routes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn problems(json: &str) -> Vec<String> {
        Catalog::from_json(json)
            .err()
            .map(|e| e.problems)
            .unwrap_or_default()
    }

    const HAIKU: &str = r#"{ "id": "haiku", "name": "Haiku", "routes": {
        "openrouter": { "model": "anthropic/claude-haiku-5.5" },
        "opencode-go": { "model": "claude-haiku-5-5", "protocol": "anthropic" } } }"#;

    fn with_defaults(defaults: &str, models: &str) -> String {
        format!(r#"{{ "defaults": {{ {defaults} }}, "models": [ {models} ] }}"#)
    }

    const ALL_HAIKU: &str =
        r#""openrouter": { "main": "haiku", "fast": "haiku", "deep": "haiku" }"#;

    #[test]
    fn the_shipped_catalogue_is_valid_and_covers_every_gateway() -> Result<(), CatalogError> {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../config/models.json");
        let catalog = Catalog::load(&path)?;
        for gateway in Gateway::ALL {
            for role in [Role::Main, Role::Fast, Role::Deep] {
                assert!(
                    catalog.default_for(gateway, role).is_some(),
                    "{gateway} has no {role:?} default"
                );
            }
        }
        Ok(())
    }

    #[test]
    fn a_route_without_a_protocol_uses_the_gateways_own() -> Result<(), CatalogError> {
        let catalog = Catalog::from_json(&with_defaults(ALL_HAIKU, HAIKU))?;
        let route = catalog
            .find("haiku")
            .and_then(|m| m.route(Gateway::OpenRouter));
        assert_eq!(route.map(|r| r.protocol), Some(Protocol::OpenRouter));
        Ok(())
    }

    #[test]
    fn a_model_listed_twice_is_refused() {
        let json = with_defaults(ALL_HAIKU, &format!("{HAIKU}, {HAIKU}"));
        assert_eq!(
            problems(&json),
            vec!["model haiku is listed more than once"]
        );
    }

    #[test]
    fn a_default_naming_an_unlisted_model_is_refused() {
        let json = with_defaults(
            r#""openrouter": { "main": "haiku", "fast": "haiku", "deep": "gpt-5.4" }"#,
            HAIKU,
        );
        assert_eq!(
            problems(&json),
            vec!["openrouter deep default gpt-5.4 is not a listed model"]
        );
    }

    #[test]
    fn a_default_its_gateway_cannot_run_is_refused() {
        let json = with_defaults(
            r#""anthropic": { "main": "haiku", "fast": "haiku", "deep": "haiku" }"#,
            HAIKU,
        );
        assert_eq!(problems(&json).len(), 3);
        assert!(problems(&json)[0].contains("has no anthropic route"));
    }

    #[test]
    fn a_protocol_the_gateway_does_not_serve_is_refused() {
        let model = r#"{ "id": "haiku", "name": "Haiku", "routes": {
            "openrouter": { "model": "anthropic/claude-haiku-5.5", "protocol": "gemini" } } }"#;
        assert_eq!(
            problems(&with_defaults(ALL_HAIKU, model)),
            vec!["model haiku: openrouter does not serve the gemini protocol"]
        );
    }

    #[test]
    fn a_misspelt_field_is_refused_not_ignored() {
        let model = r#"{ "id": "haiku", "name": "Haiku", "routes": {
            "openrouter": { "modle": "anthropic/claude-haiku-5.5" } } }"#;
        let found = problems(&with_defaults(ALL_HAIKU, model));
        assert!(found.iter().any(|p| p.contains("modle")), "{found:?}");
    }

    #[test]
    fn an_unknown_gateway_is_refused() {
        let model = r#"{ "id": "haiku", "name": "Haiku", "routes": {
            "together": { "model": "claude-haiku" } } }"#;
        let found = problems(&with_defaults(ALL_HAIKU, model));
        assert!(found.iter().any(|p| p.contains("together")), "{found:?}");
    }

    #[test]
    fn every_problem_is_reported_at_once() {
        let models = r#"{ "id": "haiku", "name": "", "routes": {} }"#;
        assert_eq!(
            problems(&with_defaults(ALL_HAIKU, models)),
            vec![
                "model haiku has an empty name",
                "model haiku has no routes",
                "openrouter main default haiku has no openrouter route",
                "openrouter fast default haiku has no openrouter route",
                "openrouter deep default haiku has no openrouter route",
            ]
        );
    }

    #[test]
    fn a_missing_file_names_the_path() {
        let error = Catalog::load(Path::new("/nonexistent/models.json"));
        assert!(
            matches!(&error, Err(e) if e.source == "/nonexistent/models.json"),
            "{error:?}"
        );
    }
}
