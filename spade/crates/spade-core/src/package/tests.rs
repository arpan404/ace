//! The manifest as tables (ADR 0200, Tests): version 2 reads as version 3; what a package may
//! never carry is refused; what this build doesn't know is kept and grants nothing.

use std::collections::BTreeMap;

use serde_json::{Value, json};

use super::link::{Link, Made, PackageId, narrowed, switched_on};
use super::manifest::{Build, read};
use super::*;
use crate::effect::Effect;
use crate::effect::ceiling::Effects;
use crate::routine::{AceEvent, Trigger};

const BUILD: Build<'static> = Build {
    version: "0.0.25",
    task_chars: 4000,
};

fn watcher() -> Value {
    json!({
        "format": "spade-bot",
        "version": 3,
        "requires": { "runtime": "1", "spade": "0.0.25" },
        "name": "Flight watcher",
        "blurb": "Watches fares.",
        "task": "You watch flight fares for the person.",
        "face": { "kind": "character", "body": "bird", "pair": "sky" },
        "style": { "accent": "#2F7BEA" },
        "personality": { "tone": "concise" },
        "model": "fast",
        "uses": ["task", "memory", "web", "schedule"],
        "triggers": [
            { "kind": "message" },
            { "kind": "schedule", "name": "Morning check", "instruction": "Check fares.", "schedule": "daily at 7:00" },
            { "kind": "event", "name": "After a failure", "instruction": "Look.", "event": "thread.failed" },
            { "kind": "webhook", "name": "Fare feed", "instruction": "Read the posted fare." },
            { "kind": "mention", "in": ["threads"] }
        ],
        "effects": [
            { "effect": "network", "hosts": ["api.example-fares.com"], "why": "Reads fares." },
            { "effect": "network", "grant": { "kind": "drive_site", "host": "book.example-air.com" }, "why": "Checks a fare page." },
            { "effect": "send_as_person", "why": "Drafts a mail to your travel agent. You send it." }
        ],
        "limits": { "spend_alert": { "usd_per_day": 0.5 }, "workers_at_once": 2, "workspace_mb": 50 },
        "tests": ["tests/watch-a-trip.json"],
        "notes": ["The person books."],
        "pricing": { "kind": "free" }
    })
}

fn with(mut base: Value, field: &str, value: Value) -> Value {
    base[field] = value;
    base
}

fn refused(value: &Value) -> Vec<String> {
    match read(value, BUILD) {
        Ok(_) => panic!("read a package it should refuse"),
        Err(problems) => problems,
    }
}

fn reads(value: &Value) -> Manifest {
    match read(value, BUILD) {
        Ok(manifest) => manifest,
        Err(problems) => panic!("refused: {problems:?}"),
    }
}

#[test]
fn a_full_version_3_package_reads_whole() {
    let read = reads(&watcher());
    assert_eq!(read.version, 3);
    assert_eq!(read.model, "fast");
    assert_eq!(read.limits.workers_at_once, Some(2));
    assert_eq!(read.limits.spend_alert_usd_per_day, Some(0.5));
    assert_eq!(
        read.routines()
            .map(|(name, _, trigger)| (name.to_owned(), trigger))
            .collect::<Vec<_>>(),
        vec![
            (
                "Morning check".to_owned(),
                Trigger::Schedule {
                    schedule: "daily at 7:00".to_owned()
                }
            ),
            (
                "After a failure".to_owned(),
                Trigger::Event {
                    event: AceEvent::ThreadFailed
                }
            ),
            ("Fare feed".to_owned(), Trigger::Webhook),
        ]
    );
    assert_eq!(
        read.effect_keys(),
        vec![
            "network:hosts:api.example-fares.com",
            "network:drive_site:book.example-air.com",
            "send_as_person",
        ]
    );
    assert!(read.unused.is_empty());
}

#[test]
fn version_2_reads_as_version_3_with_its_routines_as_schedule_triggers() {
    let recipe = json!({
        "format": "spade-bot", "version": 2, "name": "Inbox", "task": "Sort mail.",
        "model": "fast",
        "routines": [{ "name": "Morning sort", "instruction": "Sort.", "schedule": "weekdays at 8:00" }],
        "tools": ["web_search"],
        "notes": ["Never send."]
    });
    let read = reads(&recipe);
    assert_eq!(read.version, 2);
    assert_eq!(
        read.triggers,
        vec![PackageTrigger::Schedule {
            name: "Morning sort".to_owned(),
            instruction: "Sort.".to_owned(),
            schedule: "weekdays at 8:00".to_owned(),
        }]
    );
    assert_eq!(read.tools, Some(vec!["web_search".to_owned()]));
    // Nothing else of version 3's: no effects, no limits.
    assert!(read.effects.is_empty());
    assert_eq!(read.limits, Limits::default());
}

#[test]
fn what_a_package_may_never_carry_refuses_it() {
    let effects = |entry: Value| with(watcher(), "effects", json!([entry]));
    let cases: Vec<(&str, Value, &str)> = vec![
        (
            "an identity field",
            with(watcher(), "publisher", json!("acme")),
            "signed manifest",
        ),
        (
            "a version of its own",
            with(watcher(), "version", json!("1.2.0")),
            "signed manifest",
        ),
        ("a secret", with(watcher(), "api_key", json!("x")), "secret"),
        (
            "a value shaped like a secret",
            with(
                watcher(),
                "blurb",
                json!("ghp_0123456789abcdefghijABCDEFGHIJ012345"),
            ),
            "secret",
        ),
        (
            "executions",
            with(watcher(), "mcpServers", json!({})),
            "plugin",
        ),
        ("hooks", with(watcher(), "hooks", json!([])), "plugin"),
        (
            "credential",
            effects(json!({"effect": "credential", "why": "x"})),
            "credential",
        ),
        (
            "a push grant",
            effects(
                json!({"effect": "network", "grant": {"kind": "git_push", "repo": "a/b", "branch": "x/*"}, "why": "x"}),
            ),
            "push",
        ),
        (
            "a folder grant",
            effects(
                json!({"effect": "network", "grant": {"kind": "folder", "path": "/home"}, "why": "x"}),
            ),
            "folder",
        ),
        (
            "a grant under a send",
            effects(
                json!({"effect": "send_as_person", "grant": {"kind": "tool", "tool": "send_message"}, "why": "x"}),
            ),
            "never granted",
        ),
        (
            "a tool grant for a send",
            effects(
                json!({"effect": "network", "grant": {"kind": "tool", "tool": "send_message"}, "why": "x"}),
            ),
            "can't be granted",
        ),
        (
            "an effect without a reason",
            effects(json!({"effect": "publish"})),
            "why",
        ),
        (
            "an unknown effect word",
            effects(json!({"effect": "teleport", "why": "x"})),
            "isn't an effect",
        ),
        (
            "a price",
            with(watcher(), "pricing", json!({"kind": "one_time", "usd": 5})),
            "Paid packages aren't offered yet.",
        ),
        (
            "a newer runtime",
            with(watcher(), "requires", json!({"runtime": "2"})),
            "Needs a newer Spade",
        ),
        (
            "a newer Spade",
            with(watcher(), "requires", json!({"spade": "9.0.0"})),
            "Needs a newer Spade",
        ),
        (
            "an unknown module",
            with(watcher(), "uses", json!(["teleport"])),
            "Needs a newer Spade",
        ),
        (
            "a model id",
            with(watcher(), "model", json!("gpt-9")),
            "fast or capable",
        ),
    ];
    for (case, value, words) in cases {
        let problems = refused(&value);
        assert!(
            problems.iter().any(|p| p.contains(words)),
            "{case}: {problems:?}"
        );
    }
}

#[test]
fn a_missing_price_reads_as_free() {
    let mut free = watcher();
    free.as_object_mut().map(|f| f.remove("pricing"));
    assert!(read(&free, BUILD).is_ok());
}

#[test]
fn a_contract_reads_with_its_schemas_and_the_effects_its_calls_may_use() {
    let contract = json!({
        "name": "cheapest_fare",
        "summary": "The cheapest fare seen for a route this week.",
        "input": {"type": "object", "properties": {"from": {"type": "string", "maxLength": 3}}, "required": ["from"]},
        "output": {"type": "object", "properties": {"fare": {"type": "number"}}, "required": ["fare"]},
        "effects": ["network", "read"],
        "examples": [{"input": {"from": "KTM"}, "output": {"fare": 182}}]
    });
    let read = reads(&with(watcher(), "contracts", json!([contract])));
    assert!(
        read.unused.is_empty(),
        "contracts are read now: {:?}",
        read.unused
    );
    let [one] = read.contracts.as_slice() else {
        panic!("one contract: {:?}", read.contracts)
    };
    assert_eq!(one.name, "cheapest_fare");
    assert_eq!(one.effects, vec![Effect::Network]);
    assert_eq!(one.misfit_input(&json!({"from": "KTM"})), None);
    assert_eq!(
        one.misfit_output(&json!({"fare": "cheap"})),
        Some(vec!["output.fare: is a number".to_owned()])
    );
}

#[test]
fn unknown_fields_are_kept_by_name_and_grant_nothing() {
    let value = with(
        with(watcher(), "effects", json!([])),
        "superpowers",
        json!({ "effects": [{ "effect": "publish", "why": "x" }] }),
    );
    let value = with(
        value,
        "surfaces",
        json!([{ "id": "fare-drop", "kind": "card", "file": "cards/fare-drop.json" }]),
    );
    let value = with(
        value,
        "triggers",
        json!([{ "kind": "message" }, { "kind": "call", "contract": "cheapest_fare" }]),
    );
    let read = reads(&value);
    assert_eq!(read.unused, vec!["superpowers"]);
    assert!(read.effects.is_empty());
    assert_eq!(read.triggers, vec![PackageTrigger::Message]);
    let link = link_of(read, &[]);
    assert_eq!(link.allows(), Effects::NONE);
}

fn link_of(manifest: Manifest, on: &[&str]) -> Link {
    Link {
        package: PackageId {
            source: "market".to_owned(),
            name: "flight-watcher".to_owned(),
            version: "1.0.0".to_owned(),
            hash: "h1".to_owned(),
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

#[test]
fn only_the_switches_the_person_left_on_make_the_ceiling() {
    let manifest = reads(&watcher());
    let switches: BTreeMap<String, bool> = [
        ("network:hosts:api.example-fares.com".to_owned(), true),
        ("network:drive_site:book.example-air.com".to_owned(), false),
        ("send_as_person".to_owned(), false),
        // A key the package didn't declare turns nothing on.
        ("publish".to_owned(), true),
    ]
    .into_iter()
    .collect();
    let on = switched_on(&manifest, &switches);
    assert_eq!(
        on.iter().map(String::as_str).collect::<Vec<_>>(),
        vec!["network:hosts:api.example-fares.com"]
    );
    let link = Link {
        on,
        ..link_of(manifest.clone(), &[])
    };
    assert!(link.allows().has(Effect::Network));
    // Turned off by the person: undeclared for this bot.
    assert!(!link.allows().has(Effect::SendAsPerson));
    assert!(!link.allows().has(Effect::Publish));
    // A switch missing from the answer is off.
    assert!(switched_on(&manifest, &BTreeMap::new()).is_empty());
}

#[test]
fn a_worker_is_held_to_every_packaged_bot_above_it() {
    let maker: Effects = [Effect::Network].into_iter().collect();
    let top: Effects = [Effect::Network, Effect::Publish].into_iter().collect();
    assert_eq!(narrowed([None, None]), None);
    assert_eq!(narrowed([Some(top), None, Some(maker)]), Some(maker));
    assert_eq!(narrowed([None, Some(top)]), Some(top));
}

/// One accept or refuse rule of `rules.json`, which the marketplace's reader runs too.
#[test]
fn the_shared_rules_accept_and_refuse_as_the_marketplaces_reader_does() {
    let rules: Value = serde_json::from_str(include_str!("rules.json")).unwrap_or_default();
    let cases = rules["cases"].as_array().cloned().unwrap_or_default();
    assert!(cases.len() > 10, "{rules}");
    for case in cases {
        let mut manifest = rules["base"].clone();
        for (key, value) in case["with"].as_object().cloned().unwrap_or_default() {
            manifest[key] = value;
        }
        let name = case["name"].as_str().unwrap_or_default();
        match (read(&manifest, BUILD), case["refused"].as_str()) {
            (Ok(_), None) => {}
            (Err(problems), Some(word)) => assert!(
                problems.iter().any(|p| p.contains(word)),
                "{name}: {problems:?} says nothing of {word:?}"
            ),
            (Ok(_), Some(word)) => panic!("{name}: accepted, but refused for {word:?}"),
            (Err(problems), None) => panic!("{name}: refused: {problems:?}"),
        }
    }
}
