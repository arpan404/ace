//! The runner fails an implementation that breaks the spec, at the case that names the break
//! (ADR 0201, Tests): a reader that accepts a `publisher` field, a reader that says the right
//! words but names no rule, and a runtime that runs a call outside the ceiling when the person
//! allows everything.

use std::path::Path;

use serde_json::{Value, json};
use spade_conform::reader::{self, ReaderDoor};
use spade_conform::runtime::{self, Doors, ScenarioDoor};
use spade_conform::{Level, surfaces};
use spade_core::package::manifest::Build;
use spade_core::spec::door;

const BUILD: Build<'static> = Build {
    version: "0.0.25",
    task_chars: 4000,
};

fn read_folder(folder: &Path) -> Value {
    let bot = std::fs::read_to_string(folder.join("bot.json")).unwrap_or_default();
    door::read(
        &bot,
        |path| std::fs::read_to_string(folder.join(path)).ok(),
        BUILD,
    )
}

fn fit_file(file: &Path) -> Value {
    let asked = std::fs::read_to_string(file).unwrap_or_default();
    door::fit(&serde_json::from_str(&asked).unwrap_or_default())
}

/// Spade's reader, but a package naming its publisher reads as if it didn't.
struct TrustsPublisher;

impl ReaderDoor for TrustsPublisher {
    async fn read(&self, folder: &Path) -> Result<Value, String> {
        let text = std::fs::read_to_string(folder.join("bot.json")).map_err(|e| e.to_string())?;
        let mut bot: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        if let Some(fields) = bot.as_object_mut() {
            fields.remove("publisher");
        }
        std::fs::write(folder.join("bot.json"), bot.to_string()).map_err(|e| e.to_string())?;
        Ok(read_folder(folder))
    }

    async fn fit(&self, file: &Path) -> Result<Value, String> {
        Ok(fit_file(file))
    }
}

/// Spade's reader, refusing what it refuses with the same words, but naming no rule.
struct WordsOnly;

fn without_rules(mut answer: Value) -> Value {
    for problem in answer["problems"].as_array_mut().into_iter().flatten() {
        problem["rule"] = Value::Null;
    }
    answer
}

impl ReaderDoor for WordsOnly {
    async fn read(&self, folder: &Path) -> Result<Value, String> {
        Ok(without_rules(read_folder(folder)))
    }

    async fn fit(&self, file: &Path) -> Result<Value, String> {
        Ok(without_rules(fit_file(file)))
    }
}

fn failed(level: &Level) -> Vec<&str> {
    level.failed().map(|c| c.id.as_str()).collect()
}

#[tokio::test]
async fn a_reader_that_accepts_a_publisher_fails_that_case_alone() {
    let level = reader::run(&TrustsPublisher).await;
    assert_eq!(failed(&level), vec!["package/publisher-in-the-file"]);
    let why = level
        .case("package/publisher-in-the-file")
        .and_then(|c| c.why.clone())
        .unwrap_or_default();
    assert!(why.contains("package.identity"), "{why}");
}

#[tokio::test]
async fn a_reader_that_refuses_by_the_right_words_but_names_no_rule_fails_every_refusal() {
    let level = reader::run(&WordsOnly).await;
    let refusals = spade_conform::suite::MANIFESTS
        .iter()
        .chain(std::iter::once(&spade_conform::suite::SCHEMAS))
        .flat_map(|file| file.cases())
        .filter(|case| case["rule"].is_string())
        .count();
    assert!(refusals > 40, "{refusals}");
    assert_eq!(failed(&level).len(), refusals);
    assert!(
        level
            .case("package/base-manifest")
            .is_some_and(|c| c.passed)
    );
}

/// A runtime whose gate lets every call through when the person allows everything: it reports
/// each scripted call as run, read as `spade.v1` reads it.
struct RunsEverything;

impl ScenarioDoor for RunsEverything {
    async fn run(&self, folder: &Path) -> Result<Value, String> {
        let text = std::fs::read_to_string(folder.join("tests/conformance.json"))
            .map_err(|e| e.to_string())?;
        let scenario: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        let mut calls = Vec::new();
        let mut cards = Vec::new();
        for call in scenario["model"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|step| step["calls"].as_array().cloned().unwrap_or_default())
        {
            let tool = call["tool"].as_str().unwrap_or_default();
            let effect = spade_core::effect::runtime::effect(tool).map(|e| e.name());
            if tool == "card_show" {
                cards.push(call["arguments"]["data"]["title"].clone());
            }
            calls.push(json!({ "tool": tool, "effect": effect, "outcome": "ran" }));
        }
        Ok(json!({ "problems": [], "scenarios": [{ "calls": calls, "cards": cards }] }))
    }
}

#[tokio::test]
async fn a_runtime_that_runs_a_call_outside_the_ceiling_fails_the_ceiling_cases() {
    let doors = Doors {
        http: None,
        scenarios: Some(&RunsEverything),
        run: "broken",
    };
    let level = runtime::run(&doors).await;
    let scenario_failures: Vec<&str> = failed(&level)
        .into_iter()
        .filter(|id| {
            !level
                .case(id)
                .and_then(|c| c.why.as_deref())
                .unwrap_or("")
                .starts_with("not run")
        })
        .collect();
    assert_eq!(
        scenario_failures,
        vec![
            "runtime/a-call-outside-the-ceiling-is-refused-when-the-person-allows-everything",
            "runtime/a-package-cant-change-the-effect-a-call-is-read-as",
        ]
    );
    assert!(
        level
            .case("runtime/a-declared-call-runs")
            .is_some_and(|c| c.passed)
    );
    // Its cards are drawn from data, so that case still passes.
    let shown = surfaces::run(&doors).await;
    assert!(
        shown
            .case("surfaces/a-card-is-drawn-from-data")
            .is_some_and(|c| c.passed)
    );
}

#[tokio::test]
async fn a_level_with_a_missing_door_never_passes() {
    let doors: Doors<'_, RunsEverything> = Doors {
        http: None,
        scenarios: None,
        run: "none",
    };
    let level = runtime::run(&doors).await;
    assert!(!level.passed());
    assert!(
        level
            .cases
            .iter()
            .all(|c| c.why.as_deref().is_some_and(|w| w.starts_with("not run")))
    );
}
