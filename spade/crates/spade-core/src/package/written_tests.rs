use super::*;
use crate::package::manifest::Build;

const BUILD: Build<'static> = Build {
    version: "0.0.25",
    task_chars: 4_000,
};

/// Every manifest the conformance suite accepts, written back and read again, is the same
/// manifest: a replay of the version a bot runs installs exactly what the bot has.
#[test]
fn every_accepted_manifest_written_back_reads_as_the_same_manifest() {
    let mut read_cases = 0;
    for suite in crate::spec::conformance::MANIFESTS {
        let all = suite.json();
        for case in suite.cases() {
            if case["rule"].is_string() {
                continue;
            }
            let id = case["id"].as_str().unwrap_or_default();
            let files = case["files"].clone();
            let read_file = |path: &str| files[path].as_str().map(str::to_owned);
            let bot = crate::package::contract_files::inline(
                &crate::spec::conformance::manifest(&all, &case),
                read_file,
            )
            .unwrap_or_else(|p| panic!("{id}: {p:?}"));
            let Ok(first) = crate::package::read(&bot, BUILD) else {
                panic!("{id}: the case reads");
            };
            let again = crate::package::read(&written(&first), BUILD)
                .unwrap_or_else(|p| panic!("{id}: written back, it is refused: {p:?}"));
            let unused = |mut m: Manifest| {
                m.unused.clear();
                m
            };
            assert_eq!(unused(again), unused(first), "{id}");
            read_cases += 1;
        }
    }
    assert!(read_cases >= 10, "{read_cases} cases");
}

#[test]
fn a_package_with_every_kind_of_trigger_effect_and_limit_reads_the_same_written_back() {
    let bot = serde_json::json!({
        "format": "spade-bot", "version": 3, "requires": { "runtime": "1" },
        "name": "Flight watcher", "blurb": "Watches fares.", "task": "You watch fares.",
        "face": { "eyes": "round" }, "style": { "accent": "#2f7bea" },
        "personality": { "tone": "warm", "humour": true, "emoji": false },
        "model": "fast", "uses": ["task", "web"],
        "needs": { "tools": ["web_fetch"], "connectors": [{ "id": "gmail" }, { "url": "https://mcp.example.com/" }] },
        "triggers": [
            { "kind": "message" }, { "kind": "mention", "in": ["clubs"] },
            { "kind": "schedule", "name": "Morning", "instruction": "Check.", "schedule": "daily at 7:00", "verify": true },
            { "kind": "event", "name": "Failed", "instruction": "Look.", "event": "thread.failed" },
            { "kind": "webhook", "name": "Feed", "instruction": "Read it." }
        ],
        "effects": [
            { "effect": "network", "hosts": ["api.example-fares.com"], "why": "Reads fares." },
            { "effect": "network", "grant": { "kind": "drive_site", "host": "fares.example" }, "why": "Opens the fare page." },
            { "effect": "send_as_person", "why": "Drafts a mail you send." }
        ],
        "limits": { "spend_alert": { "usd_per_day": 0.5 }, "workers_at_once": 2, "workspace_mb": 100 },
        "notes": ["The person books."], "skills": ["fares"], "plugins": [],
        "pricing": { "kind": "free" }
    });
    let first = crate::package::read(&bot, BUILD).unwrap_or_else(|p| panic!("{p:?}"));
    let again = crate::package::read(&written(&first), BUILD).unwrap_or_else(|p| panic!("{p:?}"));
    assert_eq!(again, first);
}
