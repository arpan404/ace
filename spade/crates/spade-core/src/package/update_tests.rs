//! Planning an update or a rollback (ADR 0200 §3.9): the package's fields are replaced as a
//! whole, a field the person or the bot changed stays, and anything new starts off.

use std::collections::BTreeMap;

use serde_json::{Value, json};

use super::link::{Link, Made, MadeNote, MadeRoutine, PackageId};
use super::manifest::{Build, read};
use super::update::{Current, Field, RoutineNow, RoutineStep, plan};
use super::*;
use crate::routine::Trigger;

const BUILD: Build<'static> = Build {
    version: "0.0.25",
    task_chars: 4000,
};

fn manifest(task: &str, routines: Value, effects: Value, notes: Value) -> Manifest {
    let mut triggers = vec![json!({ "kind": "message" })];
    triggers.extend(routines.as_array().cloned().unwrap_or_default());
    read(
        &json!({
            "format": "spade-bot", "version": 3, "name": "Flight watcher", "task": task,
            "triggers": triggers, "effects": effects, "notes": notes,
        }),
        BUILD,
    )
    .unwrap_or_else(|problems| panic!("refused: {problems:?}"))
}

fn schedule(name: &str, instruction: &str, at: &str) -> Value {
    json!({ "kind": "schedule", "name": name, "instruction": instruction, "schedule": at })
}

fn trigger(at: &str) -> Trigger {
    Trigger::Schedule {
        schedule: at.to_owned(),
    }
}

/// Version 1 as installed: a task, two routines, a network effect left on, two notes.
fn installed() -> Link {
    let manifest = manifest(
        "Watch fares.",
        json!([
            schedule("Morning check", "Check fares.", "daily at 7:00"),
            schedule("Weekly digest", "Sum up the week.", "mondays at 9:00"),
        ]),
        json!([{ "effect": "network", "hosts": ["api.example-fares.com"], "why": "Reads fares." }]),
        json!(["The person books.", "Prices in dollars."]),
    );
    let routine = |id: &str, instruction: &str, at: &str| MadeRoutine {
        id: id.to_owned(),
        instruction: instruction.to_owned(),
        trigger: trigger(at),
    };
    Link {
        package: PackageId {
            source: "market".to_owned(),
            name: "flight-watcher".to_owned(),
            version: "1.0.0".to_owned(),
            hash: "h1".to_owned(),
        },
        on: ["network:hosts:api.example-fares.com".to_owned()]
            .into_iter()
            .collect(),
        granted: BTreeMap::new(),
        made: Made {
            name: "Flight watcher".to_owned(),
            task: "Watch fares.".to_owned(),
            face: None,
            personality: None,
            routines: [
                (
                    "Morning check".to_owned(),
                    routine("rt1", "Check fares.", "daily at 7:00"),
                ),
                (
                    "Weekly digest".to_owned(),
                    routine("rt2", "Sum up the week.", "mondays at 9:00"),
                ),
            ]
            .into_iter()
            .collect(),
            notes: vec![
                MadeNote {
                    id: "n1".to_owned(),
                    text: "The person books.".to_owned(),
                },
                MadeNote {
                    id: "n2".to_owned(),
                    text: "Prices in dollars.".to_owned(),
                },
            ],
        },
        manifest,
        transaction: None,
        previous: None,
        withdrawn: None,
        pending: None,
    }
}

struct Bot {
    task: String,
    routines: BTreeMap<String, RoutineNow>,
    notes: BTreeMap<String, String>,
}

/// The bot just as the package left it.
fn untouched() -> Bot {
    let routine = |name: &str, instruction: &str, at: &str| RoutineNow {
        name: name.to_owned(),
        instruction: instruction.to_owned(),
        trigger: trigger(at),
    };
    Bot {
        task: "Watch fares.".to_owned(),
        routines: [
            (
                "rt1".to_owned(),
                routine("Morning check", "Check fares.", "daily at 7:00"),
            ),
            (
                "rt2".to_owned(),
                routine("Weekly digest", "Sum up the week.", "mondays at 9:00"),
            ),
        ]
        .into_iter()
        .collect(),
        notes: [
            ("n1".to_owned(), "The person books.".to_owned()),
            ("n2".to_owned(), "Prices in dollars.".to_owned()),
            ("n9".to_owned(), "The person's own note.".to_owned()),
        ]
        .into_iter()
        .collect(),
    }
}

fn current(bot: &Bot) -> Current<'_> {
    Current {
        name: "Flight watcher",
        task: &bot.task,
        face: None,
        personality: None,
        routines: &bot.routines,
        notes: &bot.notes,
    }
}

/// Version 2: a new task, the morning check changed, the digest dropped, a new routine, a new
/// effect, one note changed.
fn version_2() -> Manifest {
    manifest(
        "Watch fares and hotels.",
        json!([
            schedule("Morning check", "Check fares and hotels.", "daily at 7:00"),
            schedule("Evening check", "Check again.", "daily at 19:00"),
        ]),
        json!([
            { "effect": "network", "hosts": ["api.example-fares.com"], "why": "Reads fares." },
            { "effect": "publish", "why": "Posts a weekly fare report." }
        ]),
        json!(["The person books.", "Prices in euros."]),
    )
}

#[test]
fn an_update_replaces_what_the_package_still_owns() {
    let bot = untouched();
    let planned = plan(&installed(), current(&bot), &version_2());
    assert_eq!(planned.task, Field::Replace);
    assert_eq!(planned.name, Field::Same);
    assert_eq!(
        planned.routines,
        vec![
            RoutineStep::Replace {
                id: "rt1".to_owned(),
                name: "Morning check".to_owned()
            },
            RoutineStep::Add {
                name: "Evening check".to_owned()
            },
            RoutineStep::Remove {
                id: "rt2".to_owned(),
                name: "Weekly digest".to_owned()
            },
        ]
    );
    // The package's notes go as a whole; the person's own note is never in a plan.
    assert_eq!(planned.notes_removed, vec!["n1", "n2"]);
    assert_eq!(
        planned.notes_added,
        vec!["The person books.", "Prices in euros."]
    );
}

#[test]
fn an_update_that_adds_an_effect_turns_nothing_new_on() {
    let bot = untouched();
    let planned = plan(&installed(), current(&bot), &version_2());
    assert_eq!(planned.asks_more, vec!["publish"]);
    assert_eq!(
        planned.on.iter().map(String::as_str).collect::<Vec<_>>(),
        vec!["network:hosts:api.example-fares.com"]
    );
    assert!(planned.off.is_empty());
}

#[test]
fn what_the_person_changed_stays_and_the_plan_says_so() {
    let mut bot = untouched();
    bot.task = "Watch fares to Delhi only.".to_owned();
    if let Some(morning) = bot.routines.get_mut("rt1") {
        morning.instruction = "Check fares, and be brief.".to_owned();
    }
    // They removed the digest themselves; it isn't put back.
    bot.routines.remove("rt2");
    if let Some(note) = bot.notes.get_mut("n2") {
        "Prices in rupees.".clone_into(note);
    }
    let planned = plan(&installed(), current(&bot), &version_2());
    assert_eq!(planned.task, Field::Kept);
    assert_eq!(
        planned.routines,
        vec![
            RoutineStep::Kept {
                name: "Morning check".to_owned(),
                removed: false
            },
            RoutineStep::Add {
                name: "Evening check".to_owned()
            },
        ]
    );
    assert_eq!(planned.notes_removed, vec!["n1"]);
    assert_eq!(planned.notes_kept, 1);
}

#[test]
fn a_rollback_is_the_same_plan_towards_the_earlier_version() {
    let mut updated = installed();
    updated.manifest = version_2();
    updated.made.task = "Watch fares and hotels.".to_owned();
    updated.on.insert("publish".to_owned());
    let bot = Bot {
        task: "Watch fares and hotels.".to_owned(),
        ..untouched()
    };
    let back = plan(&updated, current(&bot), &installed().manifest);
    assert_eq!(back.task, Field::Replace);
    // What only the newer version declared is taken back.
    assert_eq!(back.off, vec!["publish"]);
    assert!(back.asks_more.is_empty());
}
