//! A package's `surfaces` (ADR 0200 §5): the cards and panels it ships, read from `bot.json`.
//! A panel is a page in `panels/<id>/index.html` with a title, the schema of the state its bot
//! sets with `panel_update`, and the actions it may send back, each with its value's schema. Its
//! page's bytes come beside the manifest and are kept by hash; the hash is Spade's, never the
//! file's. The marketplace reads `surfaces` the same way (`packages/marketplace/src/surfaces.ts`,
//! held to it by `rules.json`). Pure.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::schema;

pub const MOST_SURFACES: usize = 16;
pub const MOST_PANELS: usize = 8;
pub const MOST_ACTIONS: usize = 16;
pub const TITLE_CHARS: usize = 60;
pub const LABEL_CHARS: usize = 40;

/// A card or a panel a package ships.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Surface {
    /// A card's file, kept as declared; `card_show` sends a card's parts itself (§5.1).
    Card {
        id: String,
        file: String,
    },
    Panel(Panel),
}

/// A sandboxed page beside the bot's conversation (§5.2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Panel {
    pub id: String,
    /// Always `panels/<id>/index.html`.
    pub file: String,
    pub title: String,
    /// The schema `panel_update`'s data is checked against; none means the bot sets no state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub actions: Vec<PanelAction>,
    /// The sha256 of the page's bytes as Spade keeps them: set by Spade when the page arrives,
    /// never read from `bot.json`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
}

/// An action a panel may send, by name, with the schema of its value; none means it carries none.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PanelAction {
    pub name: String,
    /// The words the bot reads for it; its name when unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
}

impl Panel {
    pub fn action(&self, name: &str) -> Option<&PanelAction> {
        self.actions.iter().find(|action| action.name == name)
    }
}

/// The panels among `surfaces`, in order.
pub fn panels(surfaces: &[Surface]) -> impl Iterator<Item = &Panel> {
    surfaces.iter().filter_map(|surface| match surface {
        Surface::Panel(panel) => Some(panel),
        Surface::Card { .. } => None,
    })
}

/// The panel named `id`.
pub fn panel<'a>(surfaces: &'a [Surface], id: &str) -> Option<&'a Panel> {
    panels(surfaces).find(|panel| panel.id == id)
}

/// A surface's id: a short name, as its folder is named.
fn surface_id(id: &str) -> bool {
    (1..=40).contains(&id.len())
        && id.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// An action's name: what the page sends and the bot reads.
fn action_name(name: &str) -> bool {
    (1..=40).contains(&name.len())
        && name.starts_with(|c: char| c.is_ascii_lowercase())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

fn card_file(file: &str) -> bool {
    file.strip_prefix("cards/")
        .and_then(|rest| rest.strip_suffix(".json"))
        .is_some_and(|name| {
            !name.is_empty()
                && name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        })
}

fn words(value: Option<&Value>, most: usize) -> Option<String> {
    let text = value?.as_str()?.trim();
    (!text.is_empty() && text.chars().count() <= most).then(|| text.to_owned())
}

/// Reads `surfaces`; every problem goes to `problems`.
pub fn read(value: Option<&Value>, problems: &mut Vec<String>) -> Vec<Surface> {
    let Some(value) = value else {
        return Vec::new();
    };
    let Some(items) = value
        .as_array()
        .filter(|items| items.len() <= MOST_SURFACES)
    else {
        problems.push(format!("surfaces is a list of at most {MOST_SURFACES}"));
        return Vec::new();
    };
    let mut ids = BTreeSet::new();
    let mut surfaces = Vec::new();
    for (i, item) in items.iter().enumerate() {
        let at = format!("surfaces[{i}]");
        let Some(fields) = item.as_object() else {
            problems.push(format!("{at} is an object"));
            continue;
        };
        let id = match fields.get("id").and_then(Value::as_str) {
            Some(id) if surface_id(id) => id.to_owned(),
            _ => {
                problems.push(format!(
                    "{at}.id is a short name: lower-case letters, digits and dashes"
                ));
                continue;
            }
        };
        if !ids.insert(id.clone()) {
            problems.push(format!("{at}: each surface has an id of its own"));
        }
        let file = fields.get("file").and_then(Value::as_str).unwrap_or("");
        match fields.get("kind").and_then(Value::as_str) {
            Some("card") => {
                if card_file(file) {
                    surfaces.push(Surface::Card {
                        id,
                        file: file.to_owned(),
                    });
                } else {
                    problems.push(format!("{at}.file is cards/<name>.json"));
                }
            }
            Some("panel") => {
                if let Some(panel) = read_panel(fields, &at, id, file, problems) {
                    surfaces.push(Surface::Panel(panel));
                }
            }
            Some(kind) => problems.push(format!(
                "{at}: Needs a newer Spade: this one has no {kind:?} surface"
            )),
            None => problems.push(format!("{at}.kind is card or panel")),
        }
    }
    if panels(&surfaces).count() > MOST_PANELS {
        problems.push(format!("a package has at most {MOST_PANELS} panels"));
    }
    surfaces
}

fn read_panel(
    fields: &serde_json::Map<String, Value>,
    at: &str,
    id: String,
    file: &str,
    problems: &mut Vec<String>,
) -> Option<Panel> {
    let before = problems.len();
    if file != format!("panels/{id}/index.html") {
        problems.push(format!("{at}.file is panels/{id}/index.html"));
    }
    let title = words(fields.get("title"), TITLE_CHARS).unwrap_or_else(|| {
        problems.push(format!(
            "{at}.title names the panel in a few words (at most {TITLE_CHARS} characters)"
        ));
        String::new()
    });
    let state = fields.get("state").cloned();
    if let Some(state) = &state
        && let Err(found) = schema::read(state, &format!("{at}.state"))
    {
        problems.extend(found);
    }
    let actions = read_actions(fields.get("actions"), at, problems);
    (problems.len() == before).then(|| Panel {
        id,
        file: file.to_owned(),
        title,
        state,
        actions,
        hash: None,
    })
}

fn read_actions(value: Option<&Value>, at: &str, problems: &mut Vec<String>) -> Vec<PanelAction> {
    let Some(value) = value else {
        return Vec::new();
    };
    let Some(items) = value.as_array().filter(|items| items.len() <= MOST_ACTIONS) else {
        problems.push(format!("{at}.actions is a list of at most {MOST_ACTIONS}"));
        return Vec::new();
    };
    let mut names = BTreeSet::new();
    let mut actions = Vec::new();
    for (j, item) in items.iter().enumerate() {
        let at = format!("{at}.actions[{j}]");
        let name = match item.get("name").and_then(Value::as_str) {
            Some(name) if action_name(name) => name.to_owned(),
            _ => {
                problems.push(format!(
                    "{at}.name is a short name: lower-case letters, digits and underscores"
                ));
                continue;
            }
        };
        if !names.insert(name.clone()) {
            problems.push(format!(
                "{at}: each action of a panel has a name of its own"
            ));
        }
        let label = match item.get("label") {
            None => None,
            Some(label) => {
                let read = words(Some(label), LABEL_CHARS);
                if read.is_none() {
                    problems.push(format!(
                        "{at}.label is a few words (at most {LABEL_CHARS} characters)"
                    ));
                }
                read
            }
        };
        let value = item.get("value").cloned();
        if let Some(value) = &value
            && let Err(found) = schema::read(value, &format!("{at}.value"))
        {
            problems.extend(found);
        }
        actions.push(PanelAction { name, label, value });
    }
    actions
}
