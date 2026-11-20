//! A bot from a marketplace recipe (ADR 0168 §5, §8) or agent package (ADR 0200 §3): the
//! `spade-bot` format at version 2 or 3, which asks rather than grants. A version 2 recipe makes a
//! copy the person owns; a version 3 package makes a bot linked to it, whose declared effects are
//! switches the person set on the review (`switches`) and whose triggers start paused. The daemon fetched and reviewed the recipe and the person pressed
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

use std::collections::{BTreeMap, BTreeSet};

use serde::Deserialize;
use serde_json::Value;
use spade_connect::{Access, Connectors};
use spade_core::package::Manifest;
use spade_core::package::link::{MadeNote, PackageId};
use spade_store::package_key;

use super::portable::{Imported, PortableError};
use crate::engine::packages::link_text;
use crate::engine::{AgentInput, AvatarInput, BotRecipe, Engine, FromRecipe, NoteScope};
use crate::packages::envelope::{self, Envelope};
use crate::packages::{self, Linking};
use crate::plugins::Plugins;
use crate::routines::{self, By, RoutineInput};

pub const RECIPE_VERSION: u32 = 2;

/// What one install may grant (`recipeLimits` in `packages/marketplace/src/recipe.ts`).
const MOST_CONNECTORS: usize = 32;
const MOST_PLUGINS: usize = 16;
const MOST_SKILLS: usize = 64;
const MOST_SWITCHES: usize = 64;
/// Longest source, entry name or version kept in `from_recipe`.
const FROM_CHARS: usize = 200;

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

/// Everything `POST /v1/agents` passes for a recipe or a package.
pub struct RecipeInput {
    /// `bot.json` as sent, read by [`spade_core::package::read`].
    pub recipe: Value,
    pub from_recipe: FromRecipe,
    pub grants: RecipeGrants,
    pub start_routines: bool,
    /// The IANA time zone its routines run in; the machine's when absent.
    pub time_zone: Option<String>,
    /// The identity the caller says a version 3 package has: believed only as the market's
    /// signed manifest in `envelope` proves it, and must match it.
    pub package: Option<PackageId>,
    /// The market's signed manifest and `bot.json` exactly as it signed it (ADR 0200 §3.2).
    /// Without one a version 3 package installs as a local package, claiming no publisher.
    pub envelope: Option<Envelope>,
    /// A package Spade ships itself (a template, ADR 0200 §3.8): its identity is Spade's own,
    /// from its built-in bytes, and never comes from an API body.
    pub shipped: Option<PackageId>,
    /// The person's effect switches, by key; one missing is off.
    pub switches: BTreeMap<String, bool>,
}

fn invalid(message: impl Into<String>) -> PortableError {
    PortableError::Invalid(message.into())
}

/// Every place in `value` that holds a field named like a secret or a string shaped like one.
pub(super) fn secret_problems(value: &Value, path: &str, out: &mut Vec<String>) {
    spade_core::package::manifest::secret_problems(value, path, out);
}

/// The recipe read and checked, before anything is made, with the identity a version 3 package
/// installs under: the market's, when its signed manifest covers these exact bytes, and a local
/// package's otherwise. A version 2 recipe is a copy the person owns, never linked.
fn checked(
    engine: &Engine,
    input: &RecipeInput,
) -> Result<(Manifest, Option<PackageId>), PortableError> {
    let (recipe, signed) = match &input.envelope {
        Some(sealed) => {
            let (package, recipe) = envelope::verify(sealed, &engine.market_keys())
                .map_err(|why| invalid(format!("the package's identity isn't proven: {why}")))?;
            if !input.recipe.is_null() && input.recipe != recipe {
                return Err(invalid("recipe isn't the bot.json the market signed"));
            }
            if let Some(claimed) = &input.package
                && (&claimed.name, &claimed.version, &claimed.hash)
                    != (&package.name, &package.version, &package.hash)
            {
                return Err(invalid("package isn't the one the market signed"));
            }
            (recipe, Some(package))
        }
        None if input.shipped.is_some() && input.package.is_none() => {
            (input.recipe.clone(), input.shipped.clone())
        }
        // A claimed identity with nothing that proves it is refused, never stored.
        None if input.package.is_some() => {
            return Err(invalid(
                "a package's identity comes from the market's signed manifest (envelope)",
            ));
        }
        None => (input.recipe.clone(), None),
    };
    let manifest = packages::manifest(&recipe).map_err(|e| invalid(e.to_string()))?;
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
        || input.switches.len() > MOST_SWITCHES
    {
        return Err(invalid("more grants than a recipe can ask for"));
    }
    let package = match (manifest.version, signed) {
        (3, Some(package)) => Some(package),
        (3, None) => Some(envelope::local(&recipe, &manifest.name)),
        (_, Some(_)) => {
            return Err(invalid(
                "a version 2 recipe installs as a copy you own, never linked",
            ));
        }
        (_, None) => None,
    };
    Ok((manifest, package))
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
    let (recipe, package) = checked(engine, &input)?;
    // A package from the market answers the bots' cards that suggested it (ADR 0200 §8).
    let from_market = package
        .as_ref()
        .filter(|p| p.source == envelope::MARKET)
        .map(|p| p.name.clone());
    // A version 3 package's link, with its ceiling, is stored with the bot in one transaction,
    // marked installing until everything below is in place (ADR 0200 §3.4).
    let linking = package.map(|package| Linking {
        package,
        switches: &input.switches,
        transaction: input.from_recipe.transaction.clone(),
        routine_ids: BTreeMap::new(),
        notes: Vec::new(),
    });
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
    let made = engine.create_agent_with(
        AgentInput {
            name: recipe.name.clone(),
            task: recipe.task.clone(),
            model,
            avatar: recipe
                .face
                .clone()
                .map(|face| AvatarInput::Character(Value::Object(face))),
            naming: false,
        },
        |id| match &linking {
            Some(linking) => vec![(
                package_key(id),
                link_text(&packages::installing(&recipe, linking)),
            )],
            None => Vec::new(),
        },
    )?;
    let id = made.agent.id.clone();
    let furnished = furnish(
        engine,
        Furnishing {
            connectors,
            plugins,
            id: &id,
            recipe: &recipe,
            input: &input,
            granted: &granted,
            plugin_names: &plugin_names,
        },
        linking,
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
    if let Some(package) = from_market {
        engine.package_installed(&package, &agent.agent.id, &agent.agent.name);
    }
    Ok(Imported { agent, left_out })
}

/// What furnishing a just-made bot works from.
struct Furnishing<'a> {
    connectors: Option<&'a Connectors>,
    plugins: Option<&'a Plugins>,
    id: &'a str,
    recipe: &'a Manifest,
    input: &'a RecipeInput,
    granted: &'a BTreeSet<String>,
    plugin_names: &'a BTreeSet<String>,
}

/// Everything after the bot exists: routines, notes, grants, its recipe record and, for a
/// version 3 package, its link committed. Its routines are made paused and start, when the person
/// asked, only once all of it is in place: nothing fires while the bot is half made.
fn furnish(
    engine: &Engine,
    made: Furnishing<'_>,
    linking: Option<Linking<'_>>,
) -> Result<(), PortableError> {
    let Furnishing {
        connectors,
        plugins,
        id,
        recipe,
        input,
        granted,
        plugin_names,
    } = made;
    if let Some(personality) = recipe.personality {
        engine
            .start_with_personality(id, personality)
            .map_err(|why| invalid(format!("its personality wasn't set: {why}")))?;
    }
    // Schedule, event and webhook triggers become routines (ADR 0200 §3.5); a webhook's secret
    // is made here, never shipped.
    let mut routine_ids = BTreeMap::new();
    for (name, instruction, trigger) in recipe.routines() {
        let made = routines::create(
            engine,
            id,
            RoutineInput {
                name: Some(name.to_owned()),
                instruction: Some(instruction.to_owned()),
                trigger: Some(trigger),
                time_zone: input.time_zone.clone(),
                paused: Some(true),
                untrusted: false,
            },
            By::Person,
        )
        .map_err(|why| invalid(format!("the routine {name:?} wasn't added: {why}")))?;
        routine_ids.insert(name.to_owned(), made.routine.id);
    }
    let what = if recipe.version == 3 {
        "package"
    } else {
        "recipe"
    };
    let mut notes = Vec::new();
    for note in &recipe.notes {
        let (kept, _) = engine
            .import_note(
                &NoteScope::Agent(id.to_owned()),
                note,
                &format!("the {} {what}", recipe.name),
            )
            .map_err(|why| invalid(format!("a note wasn't kept: {why}")))?;
        notes.push(MadeNote {
            id: kept.id,
            text: kept.text,
        });
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
        .map_err(|e| PortableError::Failed(e.to_string()))?;
    if let Some(linking) = linking {
        packages::link_new(
            engine,
            id,
            recipe,
            Linking {
                routine_ids: routine_ids.clone(),
                notes,
                ..linking
            },
        )
        .map_err(|why| invalid(why.to_string()))?;
    }
    if input.start_routines {
        for (name, routine) in &routine_ids {
            routines::update(
                engine,
                routine,
                RoutineInput {
                    paused: Some(false),
                    ..RoutineInput::default()
                },
            )
            .map_err(|why| invalid(format!("the routine {name:?} didn't start: {why}")))?;
        }
    }
    Ok(())
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
