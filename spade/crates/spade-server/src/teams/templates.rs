//! Bot templates (ADR 0132 §11, ADR 0200 §3.8): the ten roles a person can start a bot from,
//! shipped by ace as version 3 agent packages in `spade/templates/<id>/`. They are built into the
//! binary, so New bot works offline and a shipped correction reaches every install; a bot made
//! from one is linked to it (`package {source: "spade", name: <id>, version, hash}`), so a later
//! Spade can fix it the way any package update does. The market's seed lists the same folders.

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use spade_core::package::Manifest;
use spade_core::package::link::PackageId;

/// Where a template's link says it came from: built into Spade.
pub const SOURCE: &str = "spade";

/// One template's files, as shipped.
struct Shipped {
    id: &'static str,
    files: &'static [(&'static str, &'static str)],
}

/// A template's folder in `spade/templates/`, every file listed: `tests` names its scenarios.
macro_rules! shipped {
    ($id:literal, [$($test:literal),* $(,)?]) => {
        Shipped {
            id: $id,
            files: &[
                ("bot.json", include_str!(concat!("../../../../templates/", $id, "/bot.json"))),
                ("README.md", include_str!(concat!("../../../../templates/", $id, "/README.md"))),
                $(($test, include_str!(concat!("../../../../templates/", $id, "/", $test))),)*
            ],
        }
    };
}

const SHIPPED: &[Shipped] = &[
    shipped!("inbox", ["tests/first-message.json", "tests/routine.json"]),
    shipped!("research", ["tests/first-message.json"]),
    shipped!(
        "release-notes",
        ["tests/first-message.json", "tests/routine.json"]
    ),
    shipped!("travel", ["tests/first-message.json"]),
    shipped!(
        "finance",
        ["tests/first-message.json", "tests/routine.json"]
    ),
    shipped!("writing", ["tests/first-message.json"]),
    shipped!(
        "on-call",
        ["tests/first-message.json", "tests/routine.json"]
    ),
    shipped!(
        "learning",
        ["tests/first-message.json", "tests/routine.json"]
    ),
    shipped!(
        "meeting-notes",
        ["tests/first-message.json", "tests/routine.json"]
    ),
    shipped!(
        "health-habits",
        ["tests/first-message.json", "tests/routine.json"]
    ),
];

/// The templates' order and each one's version.
const INDEX: &str = include_str!("../../../../templates/index.json");

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TemplateRoutine {
    pub name: String,
    pub instruction: String,
    /// A phrase or cron expression routines read (`weekdays at 8:00`).
    pub schedule: String,
    /// The schedule in a few words, as a routine shows it (`Weekdays at 8:00`).
    #[serde(default)]
    pub words: String,
}

/// A template as `GET /v1/templates` shows it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Template {
    pub id: String,
    pub name: String,
    pub blurb: String,
    pub task: String,
    /// Its character face, as stored (`{"kind":"character", ...}`).
    pub face: Value,
    /// `fast` (the person's fast model) or `capable` (their default).
    pub model_kind: String,
    pub routines: Vec<TemplateRoutine>,
    /// How a bot made from it talks, from its first turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub personality: Option<spade_core::personality::Personality>,
    /// Its package's version.
    pub version: String,
}

/// A template's package: the manifest as posted to the install path, read, and its identity.
#[derive(Debug, Clone)]
pub struct TemplatePackage {
    pub template: Template,
    pub recipe: Value,
    pub manifest: Manifest,
    pub package: PackageId,
    /// Its files, path and text.
    pub files: Vec<(&'static str, &'static str)>,
}

#[derive(Deserialize)]
struct Index {
    templates: Vec<Version>,
}

#[derive(Deserialize)]
struct Version {
    id: String,
    version: String,
}

/// ADR 0014's content hash, as `contentHash` in `@ace/marketplace` writes it: sha256 over one
/// JSON line per file (`[path, bytes, executable, sha256]`) in path order.
pub fn content_hash(files: &[(&str, &str)]) -> String {
    let mut sorted: Vec<&(&str, &str)> = files.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(b.0));
    let mut lines = String::new();
    for (path, text) in sorted {
        let digest = hex(&Sha256::digest(text.as_bytes()));
        lines.push_str(&serde_json::json!([path, text.len(), false, digest]).to_string());
        lines.push('\n');
    }
    hex(&Sha256::digest(lines.as_bytes()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn package(shipped: &Shipped, version: &str) -> Result<TemplatePackage, String> {
    let id = shipped.id;
    let bot = shipped
        .files
        .iter()
        .find(|(path, _)| *path == "bot.json")
        .map(|(_, text)| *text)
        .ok_or_else(|| format!("{id} has no bot.json"))?;
    let recipe: Value = serde_json::from_str(bot).map_err(|e| format!("{id}: {e}"))?;
    let manifest = crate::packages::manifest(&recipe).map_err(|e| format!("{id}: {e}"))?;
    let routines = manifest
        .triggers
        .iter()
        .filter_map(|trigger| match trigger {
            spade_core::package::PackageTrigger::Schedule {
                name,
                instruction,
                schedule,
            } => Some(TemplateRoutine {
                name: name.clone(),
                instruction: instruction.clone(),
                schedule: schedule.clone(),
                words: spade_core::routine::Trigger::Schedule {
                    schedule: schedule.clone(),
                }
                .words(),
            }),
            _ => None,
        })
        .collect();
    let template = Template {
        id: id.to_owned(),
        name: manifest.name.clone(),
        blurb: manifest.blurb.clone(),
        task: manifest.task.clone(),
        face: manifest.face.clone().map_or(Value::Null, Value::Object),
        model_kind: manifest.model.clone(),
        routines,
        personality: manifest.personality,
        version: version.to_owned(),
    };
    Ok(TemplatePackage {
        package: PackageId {
            source: SOURCE.to_owned(),
            name: id.to_owned(),
            version: version.to_owned(),
            hash: content_hash(shipped.files),
        },
        template,
        recipe,
        manifest,
        files: shipped.files.to_vec(),
    })
}

/// Every shipped template's package, in the order the app offers them.
pub fn packages() -> &'static [TemplatePackage] {
    static READ: OnceLock<Vec<TemplatePackage>> = OnceLock::new();
    READ.get_or_init(|| {
        let index: Index = match serde_json::from_str(INDEX) {
            Ok(index) => index,
            Err(error) => {
                tracing::error!(%error, "the shipped templates' index doesn't parse");
                return Vec::new();
            }
        };
        index
            .templates
            .iter()
            .filter_map(|entry| {
                let shipped = SHIPPED.iter().find(|s| s.id == entry.id)?;
                package(shipped, &entry.version)
                    .map_err(|error| tracing::error!(%error, "a shipped template doesn't read"))
                    .ok()
            })
            .collect()
    })
}

/// One template's package.
pub fn package_of(id: &str) -> Option<&'static TemplatePackage> {
    packages().iter().find(|p| p.template.id == id)
}

/// The shipped templates, in the order the app offers them.
pub fn templates() -> Vec<Template> {
    packages().iter().map(|p| p.template.clone()).collect()
}

#[cfg(test)]
#[path = "templates_tests.rs"]
mod tests;
