//! Bots linked to agent packages (ADR 0200 §3.9, §6.1): the link an install makes, updates and
//! rollbacks that replace what the package still owns and leave what the person or the bot
//! changed, the person's effect switches, and a withdrawn version's pause. The daemon reviewed
//! the package's bytes and the person pressed Install, Update or Roll back; it then posts the
//! manifest here. Every step is the person's: nothing here runs on its own but a restart's
//! resumption of a step a crash cut short.

pub mod apply;
pub mod held;
pub mod switches;

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use serde_json::{Value, json};
use spade_core::package::link::{Link, Made, MadeNote, MadeRoutine, PackageId, switched_on};
use spade_core::package::manifest::Build;
use spade_core::package::update::{Current, Plan, RoutineNow, plan};
use spade_core::package::{Manifest, read};

use crate::engine::{Engine, NoteScope, TASK_CHARS};
use crate::routines;

pub use apply::{recover, update};

/// This build, as a manifest's `requires` reads it.
pub fn build() -> Build<'static> {
    Build {
        version: crate::home::VERSION,
        task_chars: TASK_CHARS,
    }
}

/// Reads a posted manifest, its problems in one line.
pub fn manifest(value: &Value) -> Result<Manifest, PackageError> {
    read(value, build()).map_err(|problems| PackageError::Invalid(problems.join("; ")))
}

#[derive(Debug, thiserror::Error)]
pub enum PackageError {
    #[error("no such bot")]
    NotFound,
    #[error("this bot isn't linked to a package")]
    NotLinked,
    /// Its work is under way: the step waits for it to be still.
    #[error("{0}")]
    Busy(String),
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Failed(String),
}

fn failed(error: impl std::fmt::Display) -> PackageError {
    PackageError::Failed(error.to_string())
}

/// The bot's link, or why there is none.
pub fn link_of(engine: &Engine, bot: &str) -> Result<Link, PackageError> {
    if engine.agent_view(bot).map_err(failed)?.is_none() {
        return Err(PackageError::NotFound);
    }
    engine.bot_package(bot).ok_or(PackageError::NotLinked)
}

/// The bot as it is now, for a plan.
pub(crate) struct Now {
    pub name: String,
    pub task: String,
    pub face: Option<Value>,
    pub personality: Option<spade_core::personality::Personality>,
    pub routines: BTreeMap<String, RoutineNow>,
    pub notes: BTreeMap<String, String>,
}

impl Now {
    pub fn read(engine: &Engine, bot: &str) -> Result<Self, PackageError> {
        let agent = engine
            .agent_view(bot)
            .map_err(failed)?
            .ok_or(PackageError::NotFound)?
            .agent;
        let routines = routines::list(engine, bot)
            .map_err(failed)?
            .into_iter()
            .map(|view| {
                (
                    view.routine.id.clone(),
                    RoutineNow {
                        name: view.routine.name.clone(),
                        instruction: view.routine.instruction.clone(),
                        trigger: view.trigger,
                    },
                )
            })
            .collect();
        let notes = engine
            .notes(&NoteScope::Agent(bot.to_owned()), None)
            .map_err(failed)?
            .into_iter()
            .map(|note| (note.id, note.text))
            .collect();
        Ok(Self {
            face: serde_json::from_str(&agent.avatar).ok(),
            name: agent.name,
            task: agent.task,
            personality: agent.personality,
            routines,
            notes,
        })
    }

    pub fn current(&self) -> Current<'_> {
        Current {
            name: &self.name,
            task: &self.task,
            face: self.face.as_ref(),
            personality: self.personality,
            routines: &self.routines,
            notes: &self.notes,
        }
    }
}

/// What an update or rollback to `next` would do to the bot, for the person's review.
pub fn plan_for(engine: &Engine, bot: &str, next: &Manifest) -> Result<Plan, PackageError> {
    let link = link_of(engine, bot)?;
    let now = Now::read(engine, bot)?;
    Ok(plan(&link, now.current(), next))
}

/// The values the package set, read back as stored: what a later update compares with.
pub(crate) fn made(
    engine: &Engine,
    bot: &str,
    manifest: &Manifest,
    routine_ids: &BTreeMap<String, String>,
    notes: Vec<MadeNote>,
) -> Result<Made, PackageError> {
    let now = Now::read(engine, bot)?;
    let routines = manifest
        .routines()
        .filter_map(|(name, instruction, trigger)| {
            let id = routine_ids.get(name)?;
            Some((
                name.to_owned(),
                MadeRoutine {
                    id: id.clone(),
                    instruction: instruction.to_owned(),
                    trigger,
                },
            ))
        })
        .collect();
    Ok(Made {
        name: now.name,
        task: now.task,
        face: now.face,
        personality: now.personality,
        routines,
        notes,
    })
}

/// What an install from a version 3 package passes on: the package, the person's switches,
/// and what was made for it.
pub struct Linking<'a> {
    pub package: PackageId,
    pub switches: &'a BTreeMap<String, bool>,
    pub transaction: Option<String>,
    pub routine_ids: BTreeMap<String, String>,
    pub notes: Vec<MadeNote>,
}

/// Links a just-made bot to its package: the switches the person left on become grants and
/// allowed hosts, recorded `by: person`, and the link is stored. On a failure nothing a switch
/// made is left behind; the caller removes the bot.
pub fn link_new(
    engine: &Engine,
    bot: &str,
    manifest: &Manifest,
    linking: Linking<'_>,
) -> Result<Link, PackageError> {
    let on = switched_on(manifest, linking.switches);
    let security = engine.security().map(|s| &**s);
    let mut granted = BTreeMap::new();
    let applied = switches::apply(security, bot, manifest, &mut granted, &BTreeSet::new(), &on);
    if let Err(why) = applied {
        switches::take_back_all(security, bot, &granted);
        return Err(PackageError::Invalid(format!(
            "what you allowed couldn't be set up: {why}"
        )));
    }
    let link = Link {
        package: linking.package,
        manifest: manifest.clone(),
        on,
        granted,
        made: made(engine, bot, manifest, &linking.routine_ids, linking.notes)?,
        transaction: linking.transaction,
        previous: None,
        withdrawn: None,
        pending: None,
    };
    engine.set_bot_package(bot, &link).map_err(failed)?;
    Ok(link)
}

/// The person turns one of the package's effects on or off in the bot's Security page. Only
/// what the package declared can be turned on.
pub fn set_switch(engine: &Engine, bot: &str, key: &str, on: bool) -> Result<Link, PackageError> {
    let mut link = link_of(engine, bot)?;
    if !link.manifest.effect_keys().iter().any(|k| k == key) {
        return Err(PackageError::Invalid(
            "only an effect its package declares can be turned on".to_owned(),
        ));
    }
    let mut after = link.on.clone();
    if on {
        after.insert(key.to_owned());
    } else {
        after.remove(key);
    }
    let security = engine.security().map(|s| &**s);
    switches::apply(
        security,
        bot,
        &link.manifest,
        &mut link.granted,
        &link.on,
        &after,
    )
    .map_err(PackageError::Invalid)?;
    link.on = after;
    engine.set_bot_package(bot, &link).map_err(failed)?;
    Ok(link)
}

/// A withdrawn version pauses its bot (ADR 0200 §6.1) with the one pause the person has: its
/// work stops, its wakes and routine slots are held, its services stop and messages to it wait,
/// through a restart. The reason is shown; nothing is deleted. Saying it again changes nothing.
pub fn withdraw(engine: &Arc<Engine>, bot: &str, reason: &str) -> Result<Link, PackageError> {
    let mut link = link_of(engine, bot)?;
    if link.withdrawn.is_some() {
        return Ok(link);
    }
    // Paused first: the reason is only words, the pause is what keeps the bot from acting.
    engine.pause_agent(bot).map_err(failed)?;
    let reason: String = reason.trim().chars().take(500).collect();
    link.withdrawn = Some(spade_core::package::link::Withdrawn {
        reason,
        paused: Vec::new(),
    });
    engine.set_bot_package(bot, &link).map_err(failed)?;
    Ok(link)
}

/// The person resumes a bot its package's withdrawal paused: the same Resume as the Running
/// page's, so each wake that came due fires once and what waited is answered.
pub fn resume(engine: &Arc<Engine>, bot: &str) -> Result<Link, PackageError> {
    link_of(engine, bot)?;
    engine.resume_agent(bot).map_err(failed)?;
    // Resume forgets the withdrawal itself; one cut short is forgotten here.
    forget_withdrawal(engine, bot)?;
    link_of(engine, bot)
}

/// Resuming a bot ends its withdrawal's pause too: one pause, not two. Routines a withdrawal
/// before the full pause stopped run again. Nothing to do for a bot that wasn't withdrawn.
pub(crate) fn forget_withdrawal(engine: &Engine, bot: &str) -> Result<(), PackageError> {
    let Some(mut link) = engine.bot_package(bot) else {
        return Ok(());
    };
    let Some(withdrawn) = link.withdrawn.take() else {
        return Ok(());
    };
    for id in &withdrawn.paused {
        let resumed = routines::update(
            engine,
            id,
            routines::RoutineInput {
                paused: Some(false),
                ..routines::RoutineInput::default()
            },
        );
        // One the person removed meanwhile stays removed.
        if let Err(routines::RoutineError::NotFound) = resumed {
            continue;
        }
        resumed.map_err(failed)?;
    }
    engine.set_bot_package(bot, &link).map_err(failed)
}

/// A link as the profile and the daemon read it: the package and version, what it was before,
/// a withdrawal's reason, and each declared effect with the person's switch.
pub fn view(link: &Link) -> Value {
    let effects: Vec<Value> = link
        .manifest
        .effects
        .iter()
        .map(|declared| {
            let key = declared.key();
            json!({
                "key": key,
                "effect": declared.effect.name(),
                "hosts": declared.hosts,
                "grant": declared.grant,
                "why": declared.why,
                "on": link.on.contains(&key),
            })
        })
        .collect();
    json!({
        "source": link.package.source,
        "name": link.package.name,
        "version": link.package.version,
        "hash": link.package.hash,
        "previous": link.previous.as_ref().map(|p| json!({ "version": p.version, "hash": p.hash })),
        "withdrawn": link.withdrawn.as_ref().map(|w| json!({ "reason": w.reason })),
        "updating": link.pending.as_ref().map(|p| p.package.version.clone()),
        "effects": effects,
        "limits": link.manifest.limits,
    })
}

/// [`view`], with the update the person accepted while the bot was working, held for its next
/// still moment: `held {version}`.
pub fn shown(engine: &Engine, bot: &str, link: &Link) -> Value {
    let mut shown = view(link);
    if let Some(held) = held::of(engine, bot) {
        shown["held"] = json!({ "version": held.package.version });
    }
    shown
}
