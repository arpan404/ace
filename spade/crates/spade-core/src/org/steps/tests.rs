//! A link's writes as the host's log records them: each step once, in the words ADR 0206 §4.1
//! names, and nothing for a write that is only part of a step.

use std::collections::BTreeMap;

use serde_json::json;

use super::*;
use crate::org::Member;
use crate::package::link::{Made, Withdrawn};
use crate::package::manifest::{Build, read};

fn link(version: &str, hash: &str, on: &[&str]) -> Link {
    let manifest = read(
        &json!({
            "format": "spade-bot", "version": 3,
            "requires": { "runtime": "1", "spade": "0.0.25" },
            "name": "CI watcher", "blurb": "Watches CI.", "task": "You watch CI.",
            "effects": [{ "effect": "publish", "why": "Comments on the PR." }]
        }),
        Build {
            version: "0.0.25",
            task_chars: 4000,
        },
    )
    .unwrap_or_else(|problems| panic!("{problems:?}"));
    Link {
        package: PackageId {
            source: "market".to_owned(),
            name: "spade-bot/ci-watcher".to_owned(),
            version: version.to_owned(),
            hash: hash.to_owned(),
        },
        manifest,
        on: on.iter().map(|k| (*k).to_owned()).collect(),
        granted: BTreeMap::new(),
        made: Made::default(),
        transaction: None,
        previous: None,
        withdrawn: None,
        withdrawn_hashes: Vec::new(),
        pending: None,
        installing: false,
    }
}

fn actions(before: Option<&Link>, after: Option<&Link>) -> Vec<String> {
    let actor = Actor::Member(Member {
        account: "user_ann".to_owned(),
        role: "admin".to_owned(),
        name: None,
    });
    let step = Stepped {
        bot: "a_1",
        name: "CI watcher",
        actor: &actor,
        at: 7,
    };
    link_entries(before, after, &step)
        .into_iter()
        .map(|entry| entry.action)
        .collect()
}

#[test]
fn an_install_is_recorded_once_it_finishes_never_while_it_is_made() {
    let mut making = link("1.0.0", "h1", &[]);
    making.installing = true;
    assert!(actions(None, Some(&making)).is_empty());
    let done = link("1.0.0", "h1", &["publish"]);
    assert_eq!(actions(Some(&making), Some(&done)), ["package.installed"]);
}

#[test]
fn an_update_and_a_rollback_are_told_apart_by_the_version_before() {
    let one = link("1.0.0", "h1", &[]);
    let mut two = link("1.1.0", "h2", &[]);
    two.previous = Some(one.package.clone());
    assert_eq!(actions(Some(&one), Some(&two)), ["package.updated"]);
    let mut back = link("1.0.0", "h1", &[]);
    back.previous = Some(two.package.clone());
    assert_eq!(actions(Some(&two), Some(&back)), ["package.rolled_back"]);
    // Halfway through an update nothing is recorded: it records itself once it lands.
    let mut halfway = one.clone();
    halfway.pending = serde_json::from_value(json!({
        "transaction": "t", "package": two.package, "manifest": two.manifest
    }))
    .ok();
    assert!(halfway.pending.is_some());
    assert!(actions(Some(&one), Some(&halfway)).is_empty());
}

#[test]
fn a_switch_a_pause_and_a_removal_each_say_what_happened() {
    let off = link("1.0.0", "h1", &[]);
    let on = link("1.0.0", "h1", &["publish"]);
    assert_eq!(actions(Some(&off), Some(&on)), ["bot.configured"]);
    let mut paused = on.clone();
    paused.withdrawn = Some(Withdrawn {
        reason: "Your organization blocked spade-bot/ci-watcher.".to_owned(),
        paused: Vec::new(),
    });
    assert_eq!(actions(Some(&on), Some(&paused)), ["package.paused"]);
    assert_eq!(actions(Some(&paused), None), ["package.removed"]);
    // A write that changes nothing a person would see records nothing.
    assert!(actions(Some(&on), Some(&on.clone())).is_empty());
}

#[test]
fn an_entry_names_the_member_the_bot_and_the_version_never_more() {
    let actor = Actor::Member(Member {
        account: "user_ann".to_owned(),
        role: "admin".to_owned(),
        name: Some("Ann".to_owned()),
    });
    let step = Stepped {
        bot: "a_1",
        name: "CI watcher",
        actor: &actor,
        at: 7,
    };
    let entries = link_entries(None, Some(&link("1.0.0", "h1", &["publish"])), &step);
    let entry = &entries[0];
    assert_eq!(entry.actor.id, "user_ann");
    assert_eq!(entry.actor.name.as_deref(), Some("Ann"));
    assert_eq!(entry.targets[0].id, "a_1");
    assert_eq!(entry.metadata["version"], "1.0.0");
    assert_eq!(entry.metadata["hash"], "h1");
    assert_eq!(entry.metadata["effects_on"], "publish");
    assert_eq!(entry.occurred_at, 7);
}
