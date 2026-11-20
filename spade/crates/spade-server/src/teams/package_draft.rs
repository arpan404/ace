//! One of the person's bots as the start of an agent package (ADR 0200 §9, `ace bot init --from`):
//! a version 3 `bot.json` with its name, task, face, personality, model kind, its routines as
//! triggers, the marketplace skills it used, the plugins and apps it is allowed, and every effect
//! its calls were read as, declared with a `why` the developer still has to write.
//!
//! Like [`super::export_recipe`] it never holds a grant, key, token, webhook secret, model id,
//! conversation, note, knowledge or workspace file; what a package can't carry is named in
//! `left_out`, and a draft holding anything shaped like a secret is refused. A bot installed from
//! someone else's package is refused: its maker's package is the one to change.

use serde_json::{Map, Value, json};
use spade_core::effect::{Effect, ceiling};
use spade_core::routine::Trigger;
use spade_store::{HEARTBEAT, ROUTINE};

use super::portable::{FORMAT, PortableError};
use super::recipe::secret_problems;
use super::recipe_export::{
    ExportedRecipe, RecipeSources, connector_needs, face_of, market_skills, model_of, plugins_of,
};
use crate::engine::{BOT, Engine};

/// How many of the bot's latest events are read for the effects its calls had.
const EFFECT_SCAN: usize = 20_000;
/// What one package may bring.
const MOST_TRIGGERS: usize = 32;
const NAME_CHARS: usize = 80;
/// Where a bot's link may say it came from for it to be the person's own to package: one made
/// from one of Spade's templates, or a development bot of a package folder on this machine.
const OWN_SOURCES: [&str; 2] = [super::TEMPLATE_SOURCE, "local"];

fn invalid(message: impl Into<String>) -> PortableError {
    PortableError::Invalid(message.into())
}

/// The bot `id` as a version 3 package manifest, with what it couldn't carry.
pub fn package_draft(
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
        return Err(invalid("Spade itself isn't made into a package"));
    }
    let made_from = engine.bot_recipe(id);
    if made_from
        .as_ref()
        .is_some_and(|r| !OWN_SOURCES.contains(&r.from_recipe.source.as_str()))
    {
        return Err(invalid(
            "This bot was installed from someone else's package, so its maker's package is the one to change",
        ));
    }
    let mut left_out = Vec::new();
    let name: String = agent.name.trim().chars().take(NAME_CHARS).collect();

    let mut triggers = vec![json!({ "kind": "message" })];
    for routine in engine
        .store()
        .routines_of(id, ROUTINE)
        .map_err(|e| fail(&e))?
    {
        let (name, instruction) = (routine.name.trim(), routine.instruction.trim());
        let trigger = match serde_json::from_str::<Trigger>(&routine.trigger).ok() {
            Some(Trigger::Schedule { schedule }) => json!({
                "kind": "schedule", "name": name, "instruction": instruction, "schedule": schedule,
            }),
            Some(Trigger::Event { event }) => json!({
                "kind": "event", "name": name, "instruction": instruction,
                "event": event_word(event),
            }),
            // Its address and secret stay with the bot; an install makes its own.
            Some(Trigger::Webhook) => json!({
                "kind": "webhook", "name": name, "instruction": instruction,
            }),
            _ => {
                left_out.push(format!(
                    "The routine {name:?} runs in a way a package can't carry."
                ));
                continue;
            }
        };
        if triggers.len() > MOST_TRIGGERS {
            left_out.push(format!(
                "The routine {name:?} is past the {MOST_TRIGGERS} a package holds."
            ));
            continue;
        }
        triggers.push(trigger);
    }
    if !engine
        .store()
        .routines_of(id, HEARTBEAT)
        .map_err(|e| fail(&e))?
        .is_empty()
    {
        left_out.push("Its heartbeat isn't part of a package.".to_owned());
    }

    let used = engine
        .store()
        .effects_used(&agent.conversation, EFFECT_SCAN)
        .map_err(|e| fail(&e))?;
    let effects: Vec<Value> = declared_effects(&used)
        .into_iter()
        .map(|effect| {
            json!({
                "effect": effect.name(),
                "why": format!("TODO: say in one sentence what {name} does with this."),
            })
        })
        .collect();

    let mut needs = Map::new();
    let connectors = sources
        .connectors
        .map(|hub| connector_needs(hub, id, &mut left_out))
        .unwrap_or_default();
    needs.insert("connectors".to_owned(), Value::Array(connectors));
    if let Some(tools) = made_from.and_then(|r| r.tools) {
        needs.insert("tools".to_owned(), json!(tools));
    }

    let mut draft = json!({
        "format": FORMAT,
        "version": 3,
        "requires": { "runtime": "1" },
        "name": name,
        "blurb": "",
        "task": agent.task,
        "model": model_of(engine, &agent),
        "triggers": triggers,
        "skills": market_skills(sources.skills, id)?,
        "plugins": plugins_of(sources.plugins, id),
        "needs": needs,
        "effects": effects,
        "pricing": { "kind": "free" },
    });
    if let Some(fields) = draft.as_object_mut() {
        if let Some(face) = face_of(&agent, &mut left_out) {
            fields.insert("face".to_owned(), face);
        }
        if let Some(personality) = &agent.personality {
            fields.insert("personality".to_owned(), json!(personality));
        }
    }

    let mut secrets = Vec::new();
    secret_problems(&draft, "bot.json", &mut secrets);
    if let Some(first) = secrets.first() {
        return Err(invalid(format!(
            "{first}; take it out of the bot first, since a package never carries a key, token or secret"
        )));
    }
    left_out.truncate(20);
    Ok(ExportedRecipe {
        recipe: draft,
        left_out,
    })
}

/// The words a package declares for the effects its calls were read as, least serious first:
/// reads and changes to its own things need none, a driving step needs `network`.
fn declared_effects(used: &[String]) -> Vec<Effect> {
    let mut declared: Vec<Effect> = used
        .iter()
        .filter_map(|word| ceiling::needs(Some(Effect::declared(&json!(word))?)))
        .collect();
    declared.sort();
    declared.dedup();
    declared
}

fn event_word(event: spade_core::routine::AceEvent) -> &'static str {
    use spade_core::routine::AceEvent;
    match event {
        AceEvent::ThreadDone => "thread.finished",
        AceEvent::ThreadFailed => "thread.failed",
        AceEvent::ThreadNeedsYou => "thread.needs_you",
    }
}
