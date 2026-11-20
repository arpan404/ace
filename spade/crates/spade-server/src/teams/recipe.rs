//! A bot from a marketplace recipe (ADR 0168 §5, §8): the `spade-bot` format at version 2, which
//! asks rather than grants. The daemon fetched and reviewed the recipe and the person pressed
//! Install; it then posts the recipe with the person's choices to `POST /v1/agents`.
//!
//! The bot is made as a template's is: name, task and face from the recipe, the person's own fast
//! or capable model, routines from their schedules (paused unless the person turned them on), the
//! recipe's notes as its own. `tools`, when present, narrows its built-in tools and never adds one.
//! Nothing in the recipe is a grant: only `grants`, the person's press of Install, is. Connectors
//! this machine hasn't connected are left out and named; plugins are allowed as
//! `PUT /v1/agents/{id}/plugins` allows them; skills need no grant, since store skills serve every
//! bot. A recipe holding anything named or shaped like a secret is refused whole, and any failure
//! after the bot was made removes it again: there is a whole bot or none.

use std::collections::BTreeSet;

use serde::Deserialize;
use serde_json::Value;
use spade_connect::{Access, Connectors};
use spade_core::routine::Trigger;

use super::portable::{Imported, PortableError};
use crate::engine::{
    AgentInput, AvatarInput, BotRecipe, Engine, FromRecipe, NoteScope, TASK_CHARS,
};
use crate::plugins::Plugins;
use crate::routines::{self, By, RoutineInput};

pub const RECIPE_VERSION: u32 = 2;

/// What one recipe may bring (`recipeLimits` in `packages/marketplace/src/recipe.ts`).
const MOST_ROUTINES: usize = 32;
const MOST_NOTES: usize = 50;
const NOTE_CHARS: usize = 2000;
const MOST_TOOLS: usize = 64;
const MOST_CONNECTORS: usize = 32;
const MOST_PLUGINS: usize = 16;
const MOST_SKILLS: usize = 64;
/// Longest source, entry name or version kept in `from_recipe`.
const FROM_CHARS: usize = 200;

/// The recipe as the daemon sends it (`spade-port.ts`).
#[derive(Debug, Clone, Deserialize)]
pub struct Recipe {
    pub format: String,
    pub version: u32,
    pub name: String,
    #[serde(default)]
    pub blurb: String,
    #[serde(default)]
    pub task: String,
    /// The eight stored fields of a character face; repaired if a value is unknown.
    #[serde(default)]
    pub face: Option<serde_json::Map<String, Value>>,
    /// `fast` or `capable`, never a model id.
    #[serde(default = "capable")]
    pub model: String,
    #[serde(default)]
    pub routines: Vec<RecipeRoutine>,
    /// Narrows the bot's built-in tools; unset means all.
    #[serde(default)]
    pub tools: Option<Vec<String>>,
    #[serde(default)]
    pub notes: Vec<String>,
    /// How the bot talks (tone, humour, emoji); its own section of the standing instructions.
    #[serde(default)]
    pub personality: Option<spade_core::personality::Personality>,
}

fn capable() -> String {
    "capable".to_owned()
}

#[derive(Debug, Clone, Deserialize)]
pub struct RecipeRoutine {
    pub name: String,
    pub instruction: String,
    /// A phrase or cron expression routines read (`weekdays at 8:00`).
    pub schedule: String,
}

/// What the person granted by pressing Install.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct RecipeGrants {
    /// Catalogue ids or https addresses.
    #[serde(default)]
    pub connectors: Vec<String>,
    /// Plugin names, accepted in ace already.
    #[serde(default)]
    pub plugins: Vec<String>,
    /// Skill names; store skills serve every bot, so these need no grant.
    #[serde(default)]
    pub skills: Vec<String>,
}

/// Everything `POST /v1/agents` passes for a recipe.
pub struct RecipeInput {
    /// The recipe as sent, checked for secrets before it is read.
    pub recipe: Value,
    pub from_recipe: FromRecipe,
    pub grants: RecipeGrants,
    pub start_routines: bool,
    /// The IANA time zone its routines run in; the machine's when absent.
    pub time_zone: Option<String>,
}

fn invalid(message: impl Into<String>) -> PortableError {
    PortableError::Invalid(message.into())
}

/// Every place in `value` that holds a field named like a secret or a string shaped like one.
pub(super) fn secret_problems(value: &Value, path: &str, out: &mut Vec<String>) {
    match value {
        Value::String(text) if spade_core::redact::text(text) != *text => {
            out.push(format!("{path} holds something shaped like a secret"));
        }
        Value::Array(items) => {
            for (i, item) in items.iter().enumerate() {
                secret_problems(item, &format!("{path}[{i}]"), out);
            }
        }
        Value::Object(fields) => {
            for (key, item) in fields {
                let at = format!("{path}.{key}");
                if spade_core::redact::secret_name(key) {
                    out.push(format!("{at} is named like a secret"));
                } else {
                    secret_problems(item, &at, out);
                }
            }
        }
        _ => {}
    }
}

/// The recipe read and checked, before anything is made.
fn checked(input: &RecipeInput) -> Result<Recipe, PortableError> {
    let mut secrets = Vec::new();
    secret_problems(&input.recipe, "recipe", &mut secrets);
    if let Some(first) = secrets.first() {
        return Err(invalid(format!(
            "{first}; a recipe never carries a key, token or secret"
        )));
    }
    let recipe: Recipe = serde_json::from_value(input.recipe.clone())
        .map_err(|e| invalid(format!("this is not a bot recipe: {e}")))?;
    if recipe.format != super::portable::FORMAT || recipe.version != RECIPE_VERSION {
        return Err(invalid("this is not a Spade bot recipe this version reads"));
    }
    if recipe.name.trim().is_empty() {
        return Err(invalid("a recipe needs a name"));
    }
    if recipe.task.chars().count() > TASK_CHARS {
        return Err(invalid(format!(
            "a recipe's task is at most {TASK_CHARS} characters"
        )));
    }
    if !matches!(recipe.model.as_str(), "fast" | "capable") {
        return Err(invalid(
            "a recipe's model is fast or capable, never a model of its own",
        ));
    }
    if recipe.routines.len() > MOST_ROUTINES {
        return Err(invalid(format!(
            "a recipe has at most {MOST_ROUTINES} routines"
        )));
    }
    for routine in &recipe.routines {
        let trigger = Trigger::Schedule {
            schedule: routine.schedule.clone(),
        };
        if !trigger.schedule().is_ok_and(|s| s.is_some()) {
            let name: String = routine.name.chars().take(60).collect();
            return Err(invalid(format!(
                "the routine {name:?} has a schedule Spade doesn't read"
            )));
        }
    }
    if recipe.notes.len() > MOST_NOTES
        || recipe.notes.iter().any(|n| n.chars().count() > NOTE_CHARS)
    {
        return Err(invalid(format!(
            "a recipe has at most {MOST_NOTES} notes of {NOTE_CHARS} characters"
        )));
    }
    if let Some(tools) = &recipe.tools {
        let named = |t: &String| {
            t.len() <= 64
                && t.starts_with(|c: char| c.is_ascii_lowercase())
                && t.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        };
        if tools.len() > MOST_TOOLS || !tools.iter().all(named) {
            return Err(invalid("a recipe's tools are built-in tools, by name"));
        }
    }
    let from = &input.from_recipe;
    if [&from.source, &from.name, &from.version]
        .iter()
        .any(|f| f.trim().is_empty() || f.chars().count() > FROM_CHARS)
    {
        return Err(invalid(
            "from_recipe names the recipe's source, name and version",
        ));
    }
    let grants = &input.grants;
    if grants.connectors.len() > MOST_CONNECTORS
        || grants.plugins.len() > MOST_PLUGINS
        || grants.skills.len() > MOST_SKILLS
    {
        return Err(invalid("more grants than a recipe can ask for"));
    }
    Ok(recipe)
}

/// The connectors granted that this machine has, by id, and a line for each it hasn't.
fn connector_grants(
    hub: Option<&Connectors>,
    wanted: &[String],
) -> (BTreeSet<String>, Vec<String>) {
    let mut granted = BTreeSet::new();
    let mut left_out = Vec::new();
    let views = hub.map(Connectors::list).unwrap_or_default();
    for want in wanted {
        let want = want.trim();
        let address = want.starts_with("https://");
        let same_url = |url: &str| url.trim_end_matches('/') == want.trim_end_matches('/');
        let found: Vec<&str> = views
            .iter()
            .filter(|v| v.state != "signing_in")
            .filter(|v| {
                if address {
                    same_url(&v.url)
                } else {
                    v.catalogue.as_deref() == Some(want) || v.id == want
                }
            })
            .map(|v| v.id.as_str())
            .collect();
        if found.is_empty() {
            let label = hub
                .and_then(|h| h.catalogue().iter().find(|e| e.id == want))
                .map_or_else(|| want.chars().take(120).collect(), |e| e.name.clone());
            left_out.push(format!(
                "{label} isn't connected on this machine. Connect after install, then allow it for this bot."
            ));
        }
        granted.extend(found.into_iter().map(str::to_owned));
    }
    (granted, left_out)
}

/// Makes a new top-level bot from a recipe. On any failure after the bot was made it is removed
/// again before the error returns. Runs off the async workers (it may wait on a delete).
pub fn from_recipe(
    engine: &std::sync::Arc<Engine>,
    connectors: Option<&Connectors>,
    plugins: Option<&Plugins>,
    input: RecipeInput,
) -> Result<Imported, PortableError> {
    let recipe = checked(&input)?;
    let plugin_names: BTreeSet<String> = input
        .grants
        .plugins
        .iter()
        .map(|p| p.trim().to_owned())
        .filter(|p| !p.is_empty())
        .collect();
    if !plugin_names.is_empty() && plugins.is_none() {
        return Err(invalid(
            "plugins come from ace, and Spade isn't set up with ace",
        ));
    }
    let (granted, mut left_out) = connector_grants(connectors, &input.grants.connectors);
    let model = match recipe.model.as_str() {
        "fast" => engine.fast_model().ok().flatten(),
        _ => None,
    }
    .unwrap_or_else(|| engine.new_bot_default());
    let made = engine.create_agent(AgentInput {
        name: recipe.name.trim().to_owned(),
        task: recipe.task.clone(),
        model,
        avatar: recipe
            .face
            .clone()
            .map(|face| AvatarInput::Character(Value::Object(face))),
    })?;
    let id = made.agent.id.clone();
    let furnished = furnish(
        engine,
        connectors,
        plugins,
        &id,
        &recipe,
        &input,
        &granted,
        &plugin_names,
    );
    if let Err(error) = furnished {
        undo(engine, connectors, plugins, &id);
        return Err(error);
    }
    if !input.grants.skills.is_empty() {
        tracing::debug!(skills = ?input.grants.skills, "a recipe's skills serve every bot from the store");
    }
    let agent = match engine.agent_view(&id) {
        Ok(Some(agent)) => agent,
        Ok(None) => return Err(PortableError::NotFound),
        Err(error) => {
            undo(engine, connectors, plugins, &id);
            return Err(PortableError::Failed(error.to_string()));
        }
    };
    left_out.truncate(20);
    Ok(Imported { agent, left_out })
}

/// Everything after the bot exists: routines, notes, grants and its recipe record.
#[allow(clippy::too_many_arguments)]
fn furnish(
    engine: &Engine,
    connectors: Option<&Connectors>,
    plugins: Option<&Plugins>,
    id: &str,
    recipe: &Recipe,
    input: &RecipeInput,
    granted: &BTreeSet<String>,
    plugin_names: &BTreeSet<String>,
) -> Result<(), PortableError> {
    if let Some(personality) = recipe.personality {
        engine
            .start_with_personality(id, personality)
            .map_err(|why| invalid(format!("its personality wasn't set: {why}")))?;
    }
    for routine in &recipe.routines {
        routines::create(
            engine,
            id,
            RoutineInput {
                name: Some(routine.name.clone()),
                instruction: Some(routine.instruction.clone()),
                trigger: Some(Trigger::Schedule {
                    schedule: routine.schedule.clone(),
                }),
                time_zone: input.time_zone.clone(),
                paused: Some(!input.start_routines),
                untrusted: false,
            },
            By::Person,
        )
        .map_err(|why| {
            invalid(format!(
                "the routine {:?} wasn't added: {why}",
                routine.name
            ))
        })?;
    }
    for note in &recipe.notes {
        engine
            .add_note(&NoteScope::Agent(id.to_owned()), note)
            .map_err(|why| invalid(format!("a note wasn't kept: {why}")))?;
    }
    if let (Some(hub), false) = (connectors, granted.is_empty()) {
        hub.set_access(id, Access::Only(granted.clone()))
            .map_err(|why| {
                PortableError::Failed(format!("the connectors weren't allowed: {why}"))
            })?;
    }
    if let (Some(plugins), false) = (plugins, plugin_names.is_empty()) {
        plugins
            .set_allowed(id, plugin_names.clone())
            .map_err(|why| invalid(format!("the plugins weren't allowed: {why}")))?;
        if let Err(error) = engine.plugins_changed(id) {
            tracing::error!(%error, "could not note the bot's changed plugins");
        }
    }
    engine
        .set_bot_recipe(
            id,
            &BotRecipe {
                from_recipe: input.from_recipe.clone(),
                tools: recipe.tools.clone(),
            },
        )
        .map_err(|e| PortableError::Failed(e.to_string()))
}

/// Removes a half-made bot and whatever it was allowed.
fn undo(
    engine: &std::sync::Arc<Engine>,
    connectors: Option<&Connectors>,
    plugins: Option<&Plugins>,
    id: &str,
) {
    if let Some(hub) = connectors
        && let Err(error) = hub.forget_agent(id)
    {
        tracing::warn!(%error, "a half-made bot's connectors were not forgotten");
    }
    if let Some(plugins) = plugins {
        plugins.forget(id);
    }
    let (engine, id) = (engine.clone(), id.to_owned());
    // On the blocking pool, so waiting here holds up no async worker.
    if let Err(error) =
        tokio::runtime::Handle::current().block_on(async move { engine.delete_agent(&id).await })
    {
        tracing::warn!(%error, "a bot whose recipe failed could not be removed");
    }
}
