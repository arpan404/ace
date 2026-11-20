//! An update or a rollback, applied (ADR 0200 §6.1, §6.2). Both take the same path: the plan
//! replaces what the package still owns, leaves what the person or the bot changed, and starts
//! anything new off. It is one step keyed by its transaction: written down before it starts,
//! each routine and note recorded as it is added or removed, and committed by storing the new
//! link. A crash leaves the old version recorded and the step is taken again, from the start, at
//! the next start or the next ask; what it already did counts as done.

use std::collections::BTreeMap;

use serde_json::Value;
use spade_core::package::Manifest;
use spade_core::package::link::{Link, MadeNote, MadeRoutine, PackageId, Pending};
use spade_core::package::update::{Field, RoutineStep, plan};

use super::{Now, PackageError, failed, link_of, switches};
use crate::engine::roster::State;
use crate::engine::{AgentChange, AvatarInput, Engine, NoteScope};
use crate::routines::{self, By, RoutineInput};

/// The update or rollback the person accepted.
pub struct Step {
    pub manifest: Manifest,
    pub package: PackageId,
    pub transaction: String,
    /// The IANA zone new routines run in; the machine's when absent.
    pub time_zone: Option<String>,
}

/// Applies an update or rollback to `bot`. The same transaction asked again answers with the
/// link it made and does nothing twice.
pub fn update(engine: &Engine, bot: &str, step: Step) -> Result<Link, PackageError> {
    let link = link_of(engine, bot)?;
    if link.transaction.as_deref() == Some(step.transaction.as_str())
        && link.package == step.package
    {
        return Ok(link);
    }
    if step.manifest.version != 3 {
        return Err(PackageError::Invalid(
            "a linked bot updates from a version 3 package".to_owned(),
        ));
    }
    let view = engine
        .agent_view(bot)
        .map_err(failed)?
        .ok_or(PackageError::NotFound)?;
    if matches!(view.state, State::Working | State::Waiting) {
        return Err(PackageError::Busy(format!(
            "{} is working. Update it once it's still.",
            view.agent.name
        )));
    }
    // One cut short before, under another transaction, finishes first.
    let link = match link.pending {
        Some(_) => resume_pending(engine, bot, link)?,
        None => link,
    };
    let pending = Pending {
        transaction: step.transaction,
        package: step.package,
        manifest: step.manifest,
        routines: BTreeMap::new(),
        notes_added: Vec::new(),
        notes_removed: Vec::new(),
    };
    run(engine, bot, link, pending, step.time_zone)
}

/// Takes again, from the start, every update a crash cut short. Run as Spade opens.
pub fn recover(engine: &Engine) {
    let Ok(agents) = engine.store().agents() else {
        return;
    };
    for agent in agents {
        let Some(link) = engine.bot_package(&agent.id) else {
            continue;
        };
        if link.pending.is_some()
            && let Err(error) = resume_pending(engine, &agent.id, link)
        {
            tracing::warn!(%error, bot = %agent.id, "a package update cut short waits for the next start");
        }
    }
}

fn resume_pending(engine: &Engine, bot: &str, mut link: Link) -> Result<Link, PackageError> {
    let Some(pending) = link.pending.take() else {
        return Ok(link);
    };
    run(engine, bot, link, pending, None)
}

fn save(engine: &Engine, bot: &str, link: &Link) -> Result<(), PackageError> {
    engine.set_bot_package(bot, link).map_err(failed)
}

fn run(
    engine: &Engine,
    bot: &str,
    mut link: Link,
    mut pending: Pending,
    time_zone: Option<String>,
) -> Result<Link, PackageError> {
    // What a step cut short already did counts as the package's own.
    for (name, id) in &pending.routines {
        if let Some((_, instruction, trigger)) =
            pending.manifest.routines().find(|(n, _, _)| n == name)
        {
            link.made.routines.insert(
                name.clone(),
                MadeRoutine {
                    id: id.clone(),
                    instruction: instruction.to_owned(),
                    trigger,
                },
            );
        }
    }
    link.pending = Some(pending.clone());
    save(engine, bot, &link)?;
    let mut now = Now::read(engine, bot)?;
    // A note it removed before the crash reads as still there, not as one the person forgot;
    // one it added reads as not yet there.
    for note in &pending.notes_removed {
        now.notes.insert(note.id.clone(), note.text.clone());
    }
    for note in &pending.notes_added {
        now.notes.remove(&note.id);
    }
    let next = pending.manifest.clone();
    let planned = plan(&link, now.current(), &next);
    let why = format!("Version {} of its package", pending.package.version);
    let change = AgentChange {
        name: (planned.name == Field::Replace).then(|| next.name.clone()),
        task: (planned.task == Field::Replace).then(|| next.task.clone()),
        avatar: (planned.face == Field::Replace).then(|| match &next.face {
            Some(face) => AvatarInput::Character(Value::Object(face.clone())),
            None => AvatarInput::Generated,
        }),
        personality: (planned.personality == Field::Replace).then_some(next.personality),
        why: Some(why),
        by: None,
        ..AgentChange::default()
    };
    if change.name.is_some()
        || change.task.is_some()
        || change.avatar.is_some()
        || change.personality.is_some()
    {
        engine.update_agent(bot, change).map_err(failed)?;
    }
    for routine in &planned.routines {
        match routine {
            RoutineStep::Add { name } => {
                let Some((_, instruction, trigger)) = next.routines().find(|(n, _, _)| n == name)
                else {
                    continue;
                };
                let made = routines::create(
                    engine,
                    bot,
                    RoutineInput {
                        name: Some(name.clone()),
                        instruction: Some(instruction.to_owned()),
                        trigger: Some(trigger.clone()),
                        time_zone: time_zone.clone(),
                        // Anything new an update brings starts off.
                        paused: Some(true),
                        untrusted: false,
                    },
                    By::Person,
                )
                .map_err(failed)?;
                pending
                    .routines
                    .insert(name.clone(), made.routine.id.clone());
                link.made.routines.insert(
                    name.clone(),
                    MadeRoutine {
                        id: made.routine.id,
                        instruction: instruction.to_owned(),
                        trigger,
                    },
                );
                link.pending = Some(pending.clone());
                save(engine, bot, &link)?;
            }
            RoutineStep::Replace { id, name } => {
                let Some((_, instruction, trigger)) = next.routines().find(|(n, _, _)| n == name)
                else {
                    continue;
                };
                routines::update(
                    engine,
                    id,
                    RoutineInput {
                        instruction: Some(instruction.to_owned()),
                        trigger: Some(trigger.clone()),
                        ..RoutineInput::default()
                    },
                )
                .map_err(failed)?;
                link.made.routines.insert(
                    name.clone(),
                    MadeRoutine {
                        id: id.clone(),
                        instruction: instruction.to_owned(),
                        trigger,
                    },
                );
            }
            RoutineStep::Remove { id, name } => {
                match routines::delete(engine, id) {
                    Ok(()) | Err(routines::RoutineError::NotFound) => {}
                    Err(error) => return Err(failed(error)),
                }
                link.made.routines.remove(name);
            }
            RoutineStep::Kept { .. } => {}
        }
    }
    let scope = NoteScope::Agent(bot.to_owned());
    for id in &planned.notes_removed {
        if pending.notes_added.iter().any(|note| note.id == *id) {
            continue;
        }
        if let Some(text) = now.notes.get(id) {
            pending.notes_removed.push(MadeNote {
                id: id.clone(),
                text: text.clone(),
            });
            link.pending = Some(pending.clone());
            save(engine, bot, &link)?;
        }
        // One already gone is as good as forgotten.
        let _ = engine.forget_note(id);
    }
    link.made
        .notes
        .retain(|note| !planned.notes_removed.contains(&note.id));
    for text in &planned.notes_added {
        if let Some(added) = pending.notes_added.iter().find(|note| note.text == *text) {
            link.made.notes.push(added.clone());
            continue;
        }
        let (note, _) = engine
            .import_note(&scope, text, &format!("the {} package", next.name))
            .map_err(failed)?;
        let made = MadeNote {
            id: note.id,
            text: note.text,
        };
        pending.notes_added.push(made.clone());
        link.made.notes.push(made);
        link.pending = Some(pending.clone());
        save(engine, bot, &link)?;
    }
    // Switches: the person's, for what the new version still declares; what it no longer
    // declares is taken back, and what it newly declares stays off.
    let security = engine.security().map(|s| &**s);
    switches::apply(
        security,
        bot,
        &next,
        &mut link.granted,
        &link.on,
        &planned.on,
    )
    .map_err(failed)?;
    link.on = planned.on;
    // A newer version isn't the withdrawn one: what the withdrawal paused runs again.
    if let Some(withdrawn) = link.withdrawn.take() {
        for id in &withdrawn.paused {
            let _ = routines::update(
                engine,
                id,
                RoutineInput {
                    paused: Some(false),
                    ..RoutineInput::default()
                },
            );
        }
    }
    // What the package set now, as stored; detached fields keep what the package set before.
    let stored = Now::read(engine, bot)?;
    if planned.name == Field::Replace {
        link.made.name = stored.name;
    }
    if planned.task == Field::Replace {
        link.made.task = stored.task;
    }
    if planned.face == Field::Replace {
        link.made.face = stored.face;
    }
    if planned.personality == Field::Replace {
        link.made.personality = stored.personality;
    }
    link.previous = Some(link.package.clone());
    link.package = pending.package;
    link.transaction = Some(pending.transaction);
    link.manifest = next;
    link.pending = None;
    save(engine, bot, &link)?;
    Ok(link)
}
