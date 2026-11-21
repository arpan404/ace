//! Replays of a bot's kept cases (ADR 0204 §2), each on its own throwaway Spade
//! ([`crate::bot_test::throwaway`]): the package version installs there as a local package with
//! its switches on, and every tool that would reach outside answers from the case's recording
//! ([`recorded`]). Nothing reaches a network but the model's own endpoint.
//!
//! - A **wiring replay** scripts the model with the case's recorded steps, on a fake endpoint
//!   on this machine. It spends nothing.
//! - A **model replay** runs the case's given on a model the person chose, through their own
//!   endpoints ([`Models`] as the live Spade has them), at their cost. Spade's own tools run in a
//!   throwaway copy of the bot's workspace, so nothing is written to the real one.
//!
//! What came of it is judged by `spade_core::quality::replay`.

mod recorded;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use spade_core::package::Manifest;
use spade_core::package::scenario::{self, Scenario};
use spade_core::quality::case::{Case, Mark};
use spade_core::quality::replay::{self, Judged, Mode, Recording};
use spade_keys::Keys;
use spade_models::Models;
use spade_testkit::{FakeProvider, Script};

use crate::bot_test::throwaway::{self, Throwaway};
use crate::bot_test::{Failure, MODEL, observe};
use crate::tools::{EngineHandle, Toolbox};

/// How long one wiring replay may take, and one on a real model.
const WIRING_TIME: Duration = Duration::from_secs(60);
const MODEL_TIME: Duration = Duration::from_secs(600);
/// The most files and bytes of the bot's workspace a model replay copies.
const MOST_COPIED_FILES: usize = 5_000;
const MOST_COPIED_BYTES: u64 = 200 * 1024 * 1024;

/// The package version a replay installs: its `bot.json` (its contract files written in), the
/// manifest it reads as, and its panels' pages by path.
pub struct Version {
    pub recipe: Value,
    pub manifest: Manifest,
    pub pages: Value,
}

/// The model a replay runs on.
pub enum Model {
    /// The case's recorded steps, scripted.
    Recorded,
    /// `model`, through the person's endpoints, with the bot's workspace at `workspace` copied
    /// in first when there is one.
    Chosen {
        models: Models,
        model: String,
        workspace: Option<PathBuf>,
    },
}

/// One case's replay.
#[derive(Debug, Clone, Serialize)]
pub struct CaseReport {
    pub id: String,
    /// What the kept run was given, in one line.
    pub given: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mark: Option<Mark>,
    pub passed: bool,
    pub lines: Vec<String>,
    /// Calls outside the recording.
    pub outside: usize,
    /// What the replay's reply said, for the comparison with the kept run.
    #[serde(skip)]
    pub reply: String,
}

/// A replay of several cases.
#[derive(Debug, Clone, Serialize)]
pub struct Report {
    pub mode: Mode,
    /// The model a model replay ran on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub cases: Vec<CaseReport>,
    pub passed: usize,
    pub failed: usize,
    pub outside: usize,
    pub summary: String,
}

impl Report {
    /// The counts and summary again, after a case's verdict changed.
    pub fn recounted(self) -> Self {
        Self::of(self.mode, self.model, self.cases)
    }

    fn of(mode: Mode, model: Option<String>, cases: Vec<CaseReport>) -> Self {
        let judged: Vec<Judged> = cases
            .iter()
            .map(|c| Judged {
                passed: c.passed,
                lines: c.lines.clone(),
                outside: c.outside,
            })
            .collect();
        let refs: Vec<&Judged> = judged.iter().collect();
        Self {
            mode,
            model,
            passed: cases.iter().filter(|c| c.passed).count(),
            failed: cases.iter().filter(|c| !c.passed).count(),
            outside: cases.iter().map(|c| c.outside).sum(),
            summary: replay::summary(&refs, mode),
            cases,
        }
    }
}

/// Replays each of `cases` on `version`, one after another.
pub async fn run(cases: &[Case], version: &Version, model: &Model) -> Report {
    let (mode, name) = match model {
        Model::Recorded => (Mode::Wiring, None),
        Model::Chosen { model, .. } => (Mode::Model, Some(model.clone())),
    };
    let mut reports = Vec::new();
    for case in cases {
        reports.push(one(case, version, model, mode).await);
    }
    Report::of(mode, name, reports)
}

async fn one(case: &Case, version: &Version, model: &Model, mode: Mode) -> CaseReport {
    let report = |judged: Judged, reply: String| CaseReport {
        id: case.id.clone(),
        given: replay::one_line(case.given.messages.first().map_or_else(
            || case.trigger.name.as_deref().unwrap_or("A kept run"),
            String::as_str,
        )),
        mark: case.mark,
        passed: judged.passed,
        lines: judged.lines,
        outside: judged.outside,
        reply,
    };
    let triggers: Vec<&str> = version
        .manifest
        .routines()
        .map(|(name, _, _)| name)
        .collect();
    let problems = replay::unplayable(case, &triggers, &version.manifest.contracts);
    if !problems.is_empty() {
        return report(
            Judged {
                passed: false,
                lines: problems,
                outside: 0,
            },
            String::new(),
        );
    }
    let scenario = replay::scenario(case, scenario::CALL);
    let recording = Arc::new(Mutex::new(Recording::new(case)));
    let limit = if mode == Mode::Wiring {
        WIRING_TIME
    } else {
        MODEL_TIME
    };
    let ran = tokio::time::timeout(
        limit,
        replayed(case, &scenario, version, model, recording.clone()),
    )
    .await
    .unwrap_or_else(|_| Err(format!("it didn't finish within {}s", limit.as_secs()).into()));
    let outside = recording.lock().map_or(0, |r| r.outside());
    match ran {
        Ok(events) => {
            let observed = observe::observed(&events);
            report(
                replay::judge(case, &observed, outside, mode),
                observed.reply,
            )
        }
        Err(error) => report(
            Judged {
                passed: false,
                lines: vec![format!("It couldn't run: {error}")],
                outside,
            },
            String::new(),
        ),
    }
}

/// The tools of a replay: Spade's own in the throwaway folder, and every outside tool answering
/// from the recording.
fn toolbox(
    case: &Case,
    scenario: &Scenario,
    recording: &Arc<Mutex<Recording>>,
    workspace: &Path,
    bots: &EngineHandle,
) -> Toolbox {
    let mut tools = throwaway::own_tools(workspace, bots);
    let mut called = scenario.called_tools();
    called.extend(case.tool_results.iter().map(|r| r.tool.clone()));
    for name in throwaway::outside_names(called) {
        tools.push(recorded::Recorded::new(&name, recording.clone()));
    }
    Toolbox::new(tools)
}

async fn replayed(
    case: &Case,
    scenario: &Scenario,
    version: &Version,
    model: &Model,
    recording: Arc<Mutex<Recording>>,
) -> Result<Vec<Value>, Failure> {
    let tools = |workspace: &Path, bots: &EngineHandle| {
        toolbox(case, scenario, &recording, workspace, bots)
    };
    let package = (&version.recipe, &version.manifest, &version.pages);
    match model {
        Model::Recorded => {
            let fake = FakeProvider::start_turns(
                throwaway::scripts(scenario),
                Script::reply("").plain(r#"{"title":"Replay"}"#),
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
            let spade = Throwaway::start(models, tools).await?;
            let (_, events) = throwaway::run_on(&spade, package, scenario, MODEL, None).await?;
            Ok(events)
        }
        Model::Chosen {
            models,
            model,
            workspace,
        } => {
            let spade = Throwaway::start(models.clone(), tools).await?;
            let seed = workspace.as_deref().map(|from| {
                move |into: &Path| copy_bounded(from, into, MOST_COPIED_FILES, MOST_COPIED_BYTES)
            });
            let seed = seed
                .as_ref()
                .map(|f| f as &(dyn Fn(&Path) -> std::io::Result<()> + Sync));
            let (_, events) = throwaway::run_on(&spade, package, scenario, model, seed).await?;
            Ok(events)
        }
    }
}

/// Copies the files of `from` into `into`, at most `files` of them and `bytes` in all, never
/// following a link. What is past either bound is left out.
fn copy_bounded(from: &Path, into: &Path, files: usize, bytes: u64) -> std::io::Result<()> {
    let mut left = (files, bytes);
    let mut stack = vec![(from.to_path_buf(), into.to_path_buf())];
    while let Some((source, target)) = stack.pop() {
        std::fs::create_dir_all(&target)?;
        let Ok(entries) = std::fs::read_dir(&source) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let to = target.join(entry.file_name());
            if kind.is_dir() {
                stack.push((entry.path(), to));
            } else if kind.is_file() {
                let size = entry.metadata().map_or(u64::MAX, |m| m.len());
                if left.0 == 0 || size > left.1 {
                    continue;
                }
                std::fs::copy(entry.path(), &to)?;
                left = (left.0 - 1, left.1 - size);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
