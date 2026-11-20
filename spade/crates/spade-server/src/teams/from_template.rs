//! A bot from one of the shipped templates (ADR 0132 §11, ADR 0200 §3.8): the template is a
//! version 3 package, so the bot is made through the same path a package from the market takes
//! (`from_recipe`): linked to it, with its declared effects as switches. Unlike a package from
//! another publisher, the person chose to make this bot from ace's own template on New bot, which
//! shows its routines with a switch: so its routines start, and what it declares is on, unless
//! the body says otherwise. A daily-brief bot that never ran would be a silent failure. What the person
//! chose over the template (a name, a task, a model, a face) is applied after, as their change,
//! which the link keeps through any update.

use std::collections::BTreeMap;
use std::sync::Arc;

use spade_connect::Connectors;

use super::portable::{Imported, PortableError};
use super::recipe::{RecipeGrants, RecipeInput, from_recipe};
use super::templates::{SOURCE, package_of};
use crate::engine::{AgentChange, AvatarInput, Engine, FromRecipe};
use crate::plugins::Plugins;

/// What the person chose on New bot, over the template's own.
#[derive(Default)]
pub struct TemplateChoices {
    /// A name of their own, when it differs from the template's.
    pub name: Option<String>,
    /// A task of their own; the template's when empty.
    pub task: String,
    /// The model they picked; else their fast model for a fast template, their default otherwise.
    pub model: Option<String>,
    pub avatar: Option<AvatarInput>,
    /// The IANA time zone its routines run in.
    pub time_zone: Option<String>,
    /// Its effect switches by key; `None` turns on everything the template declares.
    pub switches: Option<BTreeMap<String, bool>>,
    /// Its routines start on now; New bot's switch, on unless the person turned it off.
    pub start_routines: bool,
}

/// Makes the bot from template `id`. A failure part-way leaves nothing made.
pub fn from_template(
    engine: &Arc<Engine>,
    connectors: Option<&Connectors>,
    plugins: Option<&Plugins>,
    id: &str,
    choices: TemplateChoices,
) -> Result<Imported, PortableError> {
    let template = package_of(id).ok_or(PortableError::NotFound)?;
    let switches = choices.switches.unwrap_or_else(|| {
        template
            .manifest
            .effect_keys()
            .into_iter()
            .map(|key| (key, true))
            .collect()
    });
    let made = from_recipe(
        engine,
        connectors,
        plugins,
        RecipeInput {
            recipe: template.recipe.clone(),
            from_recipe: FromRecipe {
                source: SOURCE.to_owned(),
                name: id.to_owned(),
                version: template.package.version.clone(),
                transaction: None,
            },
            grants: RecipeGrants::default(),
            start_routines: choices.start_routines,
            time_zone: choices.time_zone,
            package: None,
            envelope: None,
            shipped: Some(template.package.clone()),
            switches,
            // ace's templates ship no panels.
            pages: std::collections::BTreeMap::new(),
        },
    )?;
    let bot = made.agent.agent.id.clone();
    let name = choices
        .name
        .filter(|name| !name.trim().is_empty() && name.trim() != template.template.name);
    let task = Some(choices.task).filter(|task| !task.trim().is_empty());
    let model = choices
        .model
        .filter(|model| *model != made.agent.agent.model);
    if name.is_none() && task.is_none() && model.is_none() && choices.avatar.is_none() {
        return Ok(made);
    }
    let changed = engine.update_agent(
        &bot,
        AgentChange {
            name,
            task,
            model,
            avatar: choices.avatar,
            personality: None,
            why: None,
            by: None,
        },
    );
    match changed {
        Ok(agent) => Ok(Imported {
            agent,
            left_out: made.left_out,
        }),
        Err(error) => {
            let (engine, id) = (engine.clone(), bot);
            // On the blocking pool, so waiting here holds up no async worker.
            if let Err(undo) = tokio::runtime::Handle::current()
                .block_on(async move { engine.delete_agent(&id).await })
            {
                tracing::warn!(%undo, "a template's bot whose choices failed could not be removed");
            }
            Err(PortableError::Agent(error))
        }
    }
}

/// The model a template's bot runs on unless the person picks one: their fast model for a fast
/// template, else their default.
pub fn template_model(engine: &Arc<Engine>, id: &str) -> Option<String> {
    let template = package_of(id)?;
    if template.manifest.model == "fast"
        && let Ok(Some(fast)) = engine.fast_model()
    {
        return Some(fast);
    }
    Some(engine.new_bot_default())
}
