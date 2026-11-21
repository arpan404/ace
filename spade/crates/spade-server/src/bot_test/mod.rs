//! `spade --bot-test <package>` (ADR 0200 §9): runs a package's scenario tests on Spade's real
//! engine, offline. Each scenario gets a throwaway Spade in a temporary folder: its one endpoint
//! is `spade-testkit`'s fake model on this machine, scripted by the scenario; the tools that
//! would reach outside are fakes answering the scenario's results; there is no keychain, no ace,
//! no app and no plugin. The package installs through the same path an install from the market
//! takes, as a linked bot with its switches on (the developer is the person), and the person's
//! part of each approval is answered yes. What happened is read from the conversation's events
//! and checked by [`spade_core::package::scenario::check`].

pub(crate) mod fakes;
pub(crate) mod observe;
pub(crate) mod throwaway;

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use spade_core::package::Manifest;
use spade_core::package::scenario::{self, Observed, Scenario};
use spade_keys::Keys;
use spade_models::Models;
use spade_testkit::{FakeProvider, Script};
use throwaway::Throwaway;

use crate::tools::{EngineHandle, Toolbox};

/// How long one scenario may take before it fails as stuck.
pub(crate) const SCENARIO_TIME: Duration = Duration::from_secs(60);
pub(crate) const TOKEN: &str = "bot-test";
/// The fake endpoint's model, as a bot names it.
pub(crate) const MODEL: &str = "fake/m";
/// The reviewer: an address nothing listens on, so every held call is the person's to answer.
pub(crate) const REVIEWER: &str = "unreached/r";

/// One scenario's result.
#[derive(Debug, Clone, Serialize)]
pub struct ScenarioReport {
    pub file: String,
    pub name: String,
    pub passed: bool,
    pub failures: Vec<String>,
    /// The calls the run made, as the gate read them.
    pub calls: Vec<scenario::Seen>,
    /// The titles of the cards it showed.
    pub cards: Vec<String>,
}

/// What `spade --bot-test` prints.
#[derive(Debug, Clone, Serialize)]
pub struct Report {
    /// The package's name, once its manifest read.
    pub name: Option<String>,
    /// Why the package or a scenario file couldn't be read, each with its place.
    pub problems: Vec<String>,
    pub scenarios: Vec<ScenarioReport>,
}

impl Report {
    pub fn passed(&self) -> bool {
        self.problems.is_empty() && self.scenarios.iter().all(|s| s.passed)
    }
}

pub(crate) type Failure = Box<dyn std::error::Error + Send + Sync>;

/// Reads the package at `folder` and runs every scenario its manifest names.
pub async fn run(folder: &Path) -> Report {
    let mut report = Report {
        name: None,
        problems: Vec::new(),
        scenarios: Vec::new(),
    };
    let (recipe, manifest) = match crate::packages::folder::manifest(folder) {
        Ok(read) => read,
        Err(problems) => {
            report.problems.extend(problems);
            return report;
        }
    };
    // Its code is checked as the signer and an install check it (ADR 0203 §5).
    if let Err(problems) = crate::packages::folder::code(folder, &manifest) {
        report.problems.extend(problems);
        return report;
    }
    report.name = Some(manifest.name.clone());
    if manifest.tests.is_empty() {
        report
            .problems
            .push("bot.json: tests names no scenario; add one under tests/".to_owned());
    }
    // Its panels' pages install with it, as the daemon sends them (ADR 0200 §5.2).
    let pages: serde_json::Map<String, Value> =
        spade_core::package::surfaces::panels(&manifest.surfaces)
            .filter_map(|panel| {
                let page = std::fs::read_to_string(folder.join(&panel.file)).ok()?;
                Some((panel.file.clone(), Value::String(page)))
            })
            .collect();
    let pages = Value::Object(pages);
    let triggers: Vec<&str> = manifest.routines().map(|(name, _, _)| name).collect();
    for file in &manifest.tests {
        let scenario = std::fs::read_to_string(folder.join(file))
            .map_err(|error| vec![error.to_string()])
            .and_then(|text| scenario::read_scenario(&text, &triggers))
            .and_then(|scenario| {
                let problems = scenario::call_problems(&scenario, &manifest.contracts);
                if problems.is_empty() {
                    Ok(scenario)
                } else {
                    Err(problems)
                }
            })
            .and_then(|scenario| fakes_problems(&scenario).map(|()| scenario));
        match scenario {
            Ok(scenario) => {
                let ran =
                    tokio::time::timeout(SCENARIO_TIME, one(&recipe, &manifest, &pages, &scenario))
                        .await
                        .unwrap_or_else(|_| {
                            Err(
                                format!("it didn't finish within {}s", SCENARIO_TIME.as_secs())
                                    .into(),
                            )
                        });
                let (failures, calls, cards) = match ran {
                    Ok(observed) => (
                        scenario::check(&scenario, &observed),
                        observed.calls,
                        observed.cards,
                    ),
                    Err(error) => (
                        vec![format!("It couldn't run: {error}")],
                        Vec::new(),
                        Vec::new(),
                    ),
                };
                report.scenarios.push(ScenarioReport {
                    file: file.clone(),
                    name: scenario.name.clone(),
                    passed: failures.is_empty(),
                    failures,
                    calls,
                    cards,
                });
            }
            Err(problems) => report
                .problems
                .extend(problems.into_iter().map(|p| format!("{file}: {p}"))),
        }
    }
    report
}

/// A fake result named for a tool Spade runs itself in a scenario: it would never be used.
fn fakes_problems(scenario: &Scenario) -> Result<(), Vec<String>> {
    let problems: Vec<String> = scenario
        .tools
        .keys()
        .filter(|name| !throwaway::faked(name))
        .map(|name| {
            format!(
                "tools.{name}: Spade runs {name} itself in a scenario; only tools that reach outside take a fake result"
            )
        })
        .collect();
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems)
    }
}

/// The tools of a scenario's run: Spade's own, and a fake answering the scenario's results for
/// every tool that would reach outside.
fn toolbox(scenario: &Scenario, workspace: &Path, bots: &EngineHandle) -> Toolbox {
    let mut tools = throwaway::own_tools(workspace, bots);
    for name in throwaway::outside_names(scenario.called_tools()) {
        let answers = scenario
            .tools
            .get(&name)
            .map(scenario::Answers::list)
            .unwrap_or_default();
        tools.push(fakes::Fake::new(&name, answers));
    }
    Toolbox::new(tools)
}

/// The id a scenario's given call has, which its scripted `contract_return` names.
pub use spade_core::package::scenario::CALL;

/// One scenario on its own throwaway Spade.
async fn one(
    recipe: &Value,
    manifest: &Manifest,
    pages: &Value,
    scenario: &Scenario,
) -> Result<Observed, Failure> {
    let fake = FakeProvider::start_turns(
        throwaway::scripts(scenario),
        Script::reply("").plain(r#"{"title":"Scenario"}"#),
    )
    .await?;
    let models = Models::new(
        throwaway::catalog(&fake.root)?,
        Keys::keychain_then_env(
            |_| None,
            |var| (var == "SPADE_BOT_TEST_KEY").then(|| "scripted".to_owned()),
        ),
        crate::home::VERSION,
    )?;
    let spade =
        Throwaway::start(models, |workspace, bots| toolbox(scenario, workspace, bots)).await?;
    let (_, events) =
        throwaway::run_on(&spade, (recipe, manifest, pages), scenario, MODEL, None).await?;
    Ok(observe::observed(&events))
}

/// `spade --bot-test <folder>`: the report as JSON on stdout; exit 0 when every scenario passes,
/// 1 when one fails or the package can't be read, 2 for a wrong command line.
pub fn main(args: &[std::ffi::OsString]) -> std::process::ExitCode {
    let Some(folder) = args.first().map(PathBuf::from) else {
        eprintln!("usage: spade --bot-test <package folder>");
        return std::process::ExitCode::from(2);
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("spade could not start its runtime: {error}");
            return std::process::ExitCode::FAILURE;
        }
    };
    let report = runtime.block_on(run(&folder));
    match serde_json::to_string(&report) {
        Ok(json) => println!("{json}"),
        Err(error) => {
            eprintln!("the report couldn't be written: {error}");
            return std::process::ExitCode::FAILURE;
        }
    }
    if report.passed() {
        std::process::ExitCode::SUCCESS
    } else {
        std::process::ExitCode::FAILURE
    }
}

#[cfg(test)]
mod checks_tests;
#[cfg(test)]
mod tests;
