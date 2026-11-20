//! An update or a rollback of a linked bot, planned (ADR 0200 §3.9, §6.1). The package's fields
//! are replaced as a whole, except a field the person or the bot changed since the package last
//! set it: that one is detached and stays, and the plan says so. Anything the new version asks
//! for that the old one didn't starts off. What the person owns (the conversation, notes they
//! wrote, knowledge, the workspace, connections, grants they made, settings, and whether each
//! routine runs) is never in a plan. A rollback is the same plan towards the earlier version.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use serde_json::Value;

use super::Manifest;
use super::link::Link;
use crate::personality::Personality;
use crate::routine::Trigger;

/// A routine of the bot's, as it is now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoutineNow {
    pub name: String,
    pub instruction: String,
    pub trigger: Trigger,
}

/// The bot as it is now: what the plan compares with what the package last set.
#[derive(Debug, Clone, Copy)]
pub struct Current<'a> {
    pub name: &'a str,
    pub task: &'a str,
    pub face: Option<&'a Value>,
    pub personality: Option<Personality>,
    /// Its routines, by id.
    pub routines: &'a BTreeMap<String, RoutineNow>,
    /// Its own notes' texts, by id.
    pub notes: &'a BTreeMap<String, String>,
}

/// What happens to one of the package's fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Field {
    /// The new version has it as the old one did.
    Same,
    /// The package still owns it: the new version's value replaces it.
    Replace,
    /// The person or the bot changed it, so the update leaves it.
    Kept,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "step", rename_all = "snake_case")]
pub enum RoutineStep {
    /// New in this version: added paused.
    Add { name: String },
    /// The package's, unchanged by the person: its definition is replaced, whether it runs is
    /// left as the person set it.
    Replace { id: String, name: String },
    /// Dropped by this version and unchanged by the person.
    Remove { id: String, name: String },
    /// The person changed it (or removed it): it stays as they left it.
    Kept {
        name: String,
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        removed: bool,
    },
}

/// The whole plan, in the order it is applied.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Plan {
    pub name: Field,
    pub task: Field,
    pub face: Field,
    pub personality: Field,
    pub routines: Vec<RoutineStep>,
    /// The package's notes the person left as they were, by id, which go.
    pub notes_removed: Vec<String>,
    /// The new version's notes to add.
    pub notes_added: Vec<String>,
    /// The package's notes the person changed, which stay.
    pub notes_kept: usize,
    /// Effect switches on after: the person's, for what the new version still declares.
    pub on: BTreeSet<String>,
    /// Effects the new version declares that the old one didn't: they start off.
    pub asks_more: Vec<String>,
    /// Switches that were on for effects the new version no longer declares: what they made is
    /// taken back.
    pub off: Vec<String>,
}

/// A field the person or the bot changed since the package set it is kept; one already at the
/// new version's value (an update a crash cut short, taken again) counts as the package's.
fn field<T: PartialEq + ?Sized>(made: &T, now: &T, old: &T, next: &T) -> Field {
    if now == next && made != now {
        return Field::Replace;
    }
    if made != now {
        if old == next {
            Field::Same
        } else {
            Field::Kept
        }
    } else if old == next {
        Field::Same
    } else {
        Field::Replace
    }
}

/// Plans moving the linked bot from its installed manifest to `next`.
pub fn plan(link: &Link, now: Current<'_>, next: &Manifest) -> Plan {
    let old = &link.manifest;
    let made = &link.made;
    let face_of = |m: &Manifest| m.face.clone().map(Value::Object);
    let face = if made.face.as_ref() == now.face || face_of(next).as_ref() == now.face {
        if face_of(old) == face_of(next) {
            Field::Same
        } else {
            Field::Replace
        }
    } else if face_of(old) == face_of(next) {
        Field::Same
    } else {
        Field::Kept
    };
    let routines = routine_steps(link, now.routines, next);
    let (notes_removed, notes_added, notes_kept) = note_steps(link, now.notes, next);
    let old_keys: BTreeSet<String> = old.effect_keys().into_iter().collect();
    let next_keys: BTreeSet<String> = next.effect_keys().into_iter().collect();
    Plan {
        name: field(
            made.name.as_str(),
            now.name,
            old.name.as_str(),
            next.name.as_str(),
        ),
        task: field(
            made.task.as_str(),
            now.task,
            old.task.as_str(),
            next.task.as_str(),
        ),
        face,
        personality: field(
            &made.personality,
            &now.personality,
            &old.personality,
            &next.personality,
        ),
        routines,
        notes_removed,
        notes_added,
        notes_kept,
        on: link.on.intersection(&next_keys).cloned().collect(),
        asks_more: next
            .effect_keys()
            .into_iter()
            .filter(|key| !old_keys.contains(key))
            .collect(),
        off: link.on.difference(&next_keys).cloned().collect(),
    }
}

fn routine_steps(
    link: &Link,
    now: &BTreeMap<String, RoutineNow>,
    next: &Manifest,
) -> Vec<RoutineStep> {
    let made = &link.made.routines;
    // Unchanged since the package set it, or already as the new version has it.
    let unchanged = |name: &str, id: &str, next: Option<(&str, &Trigger)>| -> Option<bool> {
        let current = now.get(id)?;
        let was = made.get(name)?;
        let is = |instruction: &str, trigger: &Trigger| {
            current.name == name
                && current.instruction == instruction
                && current.trigger == *trigger
        };
        Some(is(&was.instruction, &was.trigger) || next.is_some_and(|(i, t)| is(i, t)))
    };
    let mut steps = Vec::new();
    let mut named = BTreeSet::new();
    for (name, instruction, trigger) in next.routines() {
        named.insert(name.to_owned());
        let Some(was) = made.get(name) else {
            steps.push(RoutineStep::Add {
                name: name.to_owned(),
            });
            continue;
        };
        match unchanged(name, &was.id, Some((instruction, &trigger))) {
            None => steps.push(RoutineStep::Kept {
                name: name.to_owned(),
                removed: true,
            }),
            Some(false) => steps.push(RoutineStep::Kept {
                name: name.to_owned(),
                removed: false,
            }),
            Some(true) if was.instruction == instruction && was.trigger == trigger => {}
            Some(true) => steps.push(RoutineStep::Replace {
                id: was.id.clone(),
                name: name.to_owned(),
            }),
        }
    }
    for (name, was) in made {
        if named.contains(name) {
            continue;
        }
        match unchanged(name, &was.id, None) {
            Some(true) => steps.push(RoutineStep::Remove {
                id: was.id.clone(),
                name: name.clone(),
            }),
            Some(false) => steps.push(RoutineStep::Kept {
                name: name.clone(),
                removed: false,
            }),
            None => {}
        }
    }
    steps
}

fn note_steps(
    link: &Link,
    now: &BTreeMap<String, String>,
    next: &Manifest,
) -> (Vec<String>, Vec<String>, usize) {
    if link.manifest.notes == next.notes {
        return (Vec::new(), Vec::new(), 0);
    }
    let mut removed = Vec::new();
    let mut kept = Vec::new();
    // A note the person forgot stays forgotten, whatever the new version says.
    let mut forgotten = Vec::new();
    for note in &link.made.notes {
        match now.get(&note.id) {
            Some(text) if *text == note.text => removed.push(note.id.clone()),
            Some(text) => kept.push(text.as_str()),
            None => forgotten.push(note.text.as_str()),
        }
    }
    let added = next
        .notes
        .iter()
        .filter(|text| !kept.contains(&text.as_str()) && !forgotten.contains(&text.as_str()))
        .cloned()
        .collect();
    (removed, added, kept.len())
}
