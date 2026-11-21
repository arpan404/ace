//! A bot as a marketplace recipe (ADR 0168 §5): the `spade-bot` format at version 2, which asks
//! rather than grants, for publishing. It is the reverse of [`super::recipe::from_recipe`].
//!
//! The recipe holds the bot's name, task, face, model kind (`fast` when it runs on the person's
//! fast model, else `capable`), its scheduled routines, the marketplace skills it has used, the
//! plugins it is allowed, and needs derived from its grants: each catalogue connector it is
//! allowed, by id, with generic words. A custom connector is never named; `left_out` says one
//! was. A bot installed from the marketplace is refused: it isn't the person's to publish. It never holds a grant, a key, a token, a webhook secret, a
//! model id, a conversation or the bot's notes about the person. What a recipe can't carry is
//! named in `left_out`. A recipe holding anything shaped like a secret is refused, so the person
//! takes it out before publishing.

use serde::Serialize;
use serde_json::{Map, Value, json};
use spade_connect::{Access, Connectors};
use spade_core::routine::Trigger;
use spade_store::{HEARTBEAT, ROUTINE};

use super::portable::{FORMAT, PortableError};
use super::recipe::{RECIPE_VERSION, secret_problems};
use crate::engine::{BOT, Engine};
use crate::plugins::Plugins;
use crate::skill_store::SkillStore;

/// What one recipe may bring (`recipeLimits` in `packages/protocol`).
const MOST_ROUTINES: usize = 32;
const MOST_SKILLS: usize = 32;
const MOST_PLUGINS: usize = 16;
const MOST_CONNECTORS: usize = 32;
const NAME_CHARS: usize = 80;

/// A recipe and what of the bot it couldn't carry.
#[derive(Debug, Serialize)]
pub struct ExportedRecipe {
    pub recipe: Value,
    pub left_out: Vec<String>,
}

/// What [`export_recipe`] reads besides the bot itself.
#[derive(Clone, Copy, Default)]
pub struct RecipeSources<'a> {
    pub connectors: Option<&'a Connectors>,
    pub plugins: Option<&'a Plugins>,
    pub skills: Option<&'a SkillStore>,
}

/// A marketplace entry name (`MarketEntryName`): lowercase letters, digits, dots and hyphens.
fn entry_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'.' || *b == b'-')
        && bytes[0].is_ascii_alphanumeric()
        && bytes[bytes.len() - 1].is_ascii_alphanumeric()
}

fn invalid(message: impl Into<String>) -> PortableError {
    PortableError::Invalid(message.into())
}

/// The bot `id` as a version 2 recipe. Only a person's own bots are published; Spade itself isn't.
pub fn export_recipe(
    engine: &Engine,
    sources: RecipeSources<'_>,
    id: &str,
) -> Result<ExportedRecipe, PortableError> {
    let fail = |e: &dyn std::fmt::Display| PortableError::Failed(e.to_string());
    let agent = engine
        .store()
        .agent(id)
        .map_err(|e| fail(&e))?
        .ok_or(PortableError::NotFound)?;
    if agent.kind != BOT {
        return Err(invalid("Spade itself isn't published as a recipe"));
    }
    // A bot made from a recipe is someone else's work; only bots the person made are theirs.
    if engine.bot_recipe(id).is_some() {
        return Err(invalid(
            "This bot was installed from the marketplace, so it isn't yours to publish",
        ));
    }
    let mut left_out = Vec::new();

    let face = face_of(&agent, &mut left_out);
    let model = model_of(engine, &agent);

    let mut routines = Vec::new();
    for routine in engine
        .store()
        .routines_of(id, ROUTINE)
        .map_err(|e| fail(&e))?
    {
        let trigger: Option<Trigger> = serde_json::from_str(&routine.trigger).ok();
        match trigger {
            Some(Trigger::Schedule { schedule }) if routines.len() < MOST_ROUTINES => {
                routines.push(json!({
                    "name": routine.name.trim(),
                    "instruction": routine.instruction.trim(),
                    "schedule": schedule,
                }));
            }
            Some(Trigger::Schedule { .. }) => left_out.push(format!(
                "The routine {:?} is past the {MOST_ROUTINES} a recipe holds.",
                routine.name
            )),
            _ => left_out.push(format!(
                "The routine {:?} doesn't run on a schedule, so a recipe can't carry it.",
                routine.name
            )),
        }
    }
    if !engine
        .store()
        .routines_of(id, HEARTBEAT)
        .map_err(|e| fail(&e))?
        .is_empty()
    {
        left_out.push("Its heartbeat isn't part of a recipe.".to_owned());
    }

    let skills = market_skills(sources.skills, id)?;
    let plugins = plugins_of(sources.plugins, id);

    let connectors = sources
        .connectors
        .map(|hub| connector_needs(hub, id, &mut left_out))
        .unwrap_or_default();
    let mut needs = Map::new();
    needs.insert("connectors".to_owned(), Value::Array(connectors));
    if let Some(tools) = engine.bot_recipe(id).and_then(|r| r.tools) {
        needs.insert("tools".to_owned(), json!(tools));
    }

    let name: String = agent.name.trim().chars().take(NAME_CHARS).collect();
    let mut recipe = json!({
        "format": FORMAT,
        "version": RECIPE_VERSION,
        "name": name,
        "blurb": "",
        "task": agent.task,
        "model": model,
        "routines": routines,
        "skills": skills,
        "plugins": plugins,
        "needs": needs,
        "notes": [],
    });
    if let (Some(face), Some(fields)) = (face, recipe.as_object_mut()) {
        fields.insert("face".to_owned(), face);
    }

    let mut secrets = Vec::new();
    secret_problems(&recipe, "recipe", &mut secrets);
    if let Some(first) = secrets.first() {
        return Err(invalid(format!(
            "{first}; take it out before publishing, since a recipe never carries a key, token or secret"
        )));
    }
    left_out.truncate(20);
    Ok(ExportedRecipe { recipe, left_out })
}

/// The bot's face as a package carries it: a character, never a picture (named in `left_out`).
pub(super) fn face_of(agent: &spade_store::Agent, left_out: &mut Vec<String>) -> Option<Value> {
    let stored: Value = serde_json::from_str(&agent.avatar).unwrap_or(Value::Null);
    match stored["kind"].as_str() {
        Some("image") => {
            left_out.push("Its picture isn't part of a recipe; the bot gets a face.".to_owned());
            None
        }
        _ => Some(spade_core::face::shown_avatar(&agent.id, &agent.avatar))
            .filter(|face| face["kind"] == "character"),
    }
}

/// `fast` when the bot runs on the person's fast model, else `capable`: never a model id.
pub(super) fn model_of(engine: &Engine, agent: &spade_store::Agent) -> &'static str {
    let fast = engine.fast_model().ok().flatten();
    if fast.as_deref() == Some(agent.model.as_str()) {
        "fast"
    } else {
        "capable"
    }
}

/// The plugins `agent` is allowed, as `spade-plugin/<name>`.
pub(super) fn plugins_of(plugins: Option<&Plugins>, agent: &str) -> Vec<String> {
    plugins
        .map(|p| p.allowed(agent))
        .unwrap_or_default()
        .into_iter()
        .filter(|name| entry_name(name))
        .take(MOST_PLUGINS)
        .map(|name| format!("spade-plugin/{name}"))
        .collect()
}

/// The marketplace skills `agent` has loaded, as `spade-skill/<name>`.
pub(super) fn market_skills(
    store: Option<&SkillStore>,
    agent: &str,
) -> Result<Vec<String>, PortableError> {
    let Some(store) = store else {
        return Ok(Vec::new());
    };
    let mut names: Vec<String> = store
        .views()
        .map_err(PortableError::Failed)?
        .into_iter()
        .filter(|view| view.origin == "market" && view.used_by.iter().any(|a| a == agent))
        .map(|view| view.name)
        .filter(|name| entry_name(name))
        .collect();
    names.sort();
    names.dedup();
    names.truncate(MOST_SKILLS);
    Ok(names
        .into_iter()
        .map(|name| format!("spade-skill/{name}"))
        .collect())
}

/// Each connector `agent` is allowed, as a need: by catalogue id, else by its https address.
pub(super) fn connector_needs(
    hub: &Connectors,
    agent: &str,
    left_out: &mut Vec<String>,
) -> Vec<Value> {
    let ids = match hub.access(agent, false) {
        Access::All => {
            left_out.push(
                "The bot may use every connector; a recipe asks for each by name, so it asks for none."
                    .to_owned(),
            );
            return Vec::new();
        }
        Access::Only(ids) => ids,
    };
    let views = hub.list();
    let mut needs = Vec::new();
    let mut custom = 0;
    for id in ids {
        let Some(view) = views.iter().find(|v| v.id == id) else {
            continue;
        };
        // Only a catalogue app is named, by its id, with words that say nothing of the person's
        // own setup; a custom app's name and address stay home.
        let Some(catalogue) = view.catalogue.as_deref() else {
            custom += 1;
            continue;
        };
        let need = json!({ "id": catalogue, "why": "The bot uses this app.", "required": true });
        if needs.len() < MOST_CONNECTORS && !needs.contains(&need) {
            needs.push(need);
        }
    }
    match custom {
        0 => {}
        1 => left_out
            .push("It uses a custom app you added, which a recipe can't ask for.".to_owned()),
        n => left_out.push(format!(
            "It uses {n} custom apps you added, which a recipe can't ask for."
        )),
    }
    needs
}
