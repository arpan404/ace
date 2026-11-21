//! Replaying a bot's kept cases (ADR 0204 §2) on a package version: the one the bot runs, or
//! one an update would move it to. A wiring replay is free; a model replay runs only when the
//! person asks for it, on a model they name, at their cost, and a case they marked is then
//! compared with its kept run by one call of ADR 0159's verifier. The runs themselves are
//! [`crate::replay`]'s.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use spade_core::package::contract_files;
use spade_core::quality::case::Case;
use spade_core::quality::replay::{self, Comparison, Mode};
use spade_core::routing::Role;
use spade_store::StoreError;

use super::Engine;
use crate::replay::{Model, Report, Version};

/// The kept runs a replay takes when the person names none: the latest.
pub const LATEST: usize = 20;
/// Longest the comparison with a kept run may take.
const COMPARE_TIME: Duration = Duration::from_secs(60);

/// What the person asks to replay.
#[derive(Debug, Clone, Default)]
pub struct ReplayInput {
    /// Case ids; the latest [`LATEST`] when empty.
    pub cases: Vec<String>,
    /// The version's `bot.json`; the version the bot runs when absent.
    pub recipe: Option<Value>,
    /// Its contract schema files by path, written into its contracts first.
    pub files: BTreeMap<String, String>,
    /// Its panels' pages by path.
    pub pages: BTreeMap<String, String>,
    /// A model replay on this model (`current`, a role such as `review`, or `endpoint/model`);
    /// a wiring replay when absent.
    pub model: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum ReplayError {
    #[error("no such agent")]
    NotFound,
    #[error("{0}")]
    Invalid(String),
    #[error("Replays run a packaged bot's version; give the version to replay")]
    NoVersion,
    #[error(transparent)]
    Store(#[from] StoreError),
}

impl Engine {
    /// The cases a replay of `agent` takes: those named, or the latest.
    fn replay_cases_of(&self, agent: &str, named: &[String]) -> Result<Vec<Case>, ReplayError> {
        let stored = if named.is_empty() {
            self.store.cases(agent, LATEST)?
        } else {
            let mut found = Vec::new();
            for id in named {
                match self.store.case(agent, id)? {
                    Some(case) => found.push(case),
                    None => return Err(ReplayError::Invalid(format!("no case {id}"))),
                }
            }
            found
        };
        Ok(stored
            .iter()
            .filter_map(|s| serde_json::from_str::<Case>(&s.body).ok())
            .collect())
    }

    /// The version a replay installs: the one given, its schema files written in, or the one
    /// `agent` runs, written back from its manifest with its panels' kept pages.
    fn replay_version(&self, agent: &str, input: &ReplayInput) -> Result<Version, ReplayError> {
        if let Some(recipe) = &input.recipe {
            let recipe = contract_files::inline(recipe, |path| input.files.get(path).cloned())
                .map_err(|problems| {
                    ReplayError::Invalid(spade_core::rule::joined(&problems, "; "))
                })?;
            let manifest = crate::packages::manifest(&recipe)
                .map_err(|error| ReplayError::Invalid(error.to_string()))?;
            let pages = input
                .pages
                .iter()
                .map(|(path, page)| (path.clone(), Value::String(page.clone())))
                .collect();
            return Ok(Version {
                recipe,
                manifest,
                pages: Value::Object(pages),
            });
        }
        let link = self.bot_package(agent).ok_or(ReplayError::NoVersion)?;
        let pages = spade_core::package::surfaces::panels(&link.manifest.surfaces)
            .filter_map(|panel| {
                let page = crate::packages::panels::page(self, panel.hash.as_deref()?)?;
                Some((panel.file.clone(), Value::String(page)))
            })
            .collect();
        Ok(Version {
            recipe: spade_core::package::written::written(&link.manifest),
            manifest: link.manifest,
            pages: Value::Object(pages),
        })
    }

    /// The model `word` names for the bot of `conversation`: `current` (its own), a role's, or
    /// one of the person's models by `endpoint/model`.
    fn replay_model(&self, conversation: &str, word: &str) -> Result<String, ReplayError> {
        let word = word.trim();
        let model = if word == "current" {
            self.role_model(conversation, Role::Main)
        } else if let Some(role) = Role::ALL.into_iter().find(|r| r.name() == word) {
            self.role_model(conversation, role)
        } else {
            word.to_owned()
        };
        if self.models.resolve(&model).is_none() {
            return Err(ReplayError::Invalid(format!(
                "{word} isn't one of your models; name a role (review, helper…), current, or endpoint/model"
            )));
        }
        Ok(model)
    }

    /// Replays `agent`'s kept cases as `input` asks. `workspace` is the bot's workspace folder,
    /// copied into a model replay's throwaway Spade.
    pub async fn replay(
        self: &Arc<Self>,
        agent: &str,
        input: &ReplayInput,
        workspace: Option<std::path::PathBuf>,
    ) -> Result<Report, ReplayError> {
        let bot = self.store.agent(agent)?.ok_or(ReplayError::NotFound)?;
        let cases = self.replay_cases_of(agent, &input.cases)?;
        let version = self.replay_version(agent, input)?;
        let Some(word) = &input.model else {
            return Ok(crate::replay::run(&cases, &version, &Model::Recorded).await);
        };
        let model = self.replay_model(&bot.conversation, word)?;
        let chosen = Model::Chosen {
            models: self.models.clone(),
            model,
            workspace,
        };
        let mut report = crate::replay::run(&cases, &version, &chosen).await;
        for (case, judged) in cases.iter().zip(report.cases.iter_mut()) {
            if !judged.passed {
                continue;
            }
            match self.compare(&bot.conversation, case, &judged.reply).await {
                Some(compared) if !compared.holds => {
                    judged.passed = false;
                    judged
                        .lines
                        .push(format!("Worse than the kept run: {}", compared.why));
                }
                Some(_) => {}
                None if case.mark.is_some() => judged
                    .lines
                    .push("Not compared with the kept run: the check didn't answer.".into()),
                None => {}
            }
        }
        Ok(report.recounted())
    }

    /// One fresh call by ADR 0159's verifier (the bot's `verify` role: the person's review or
    /// strongest model) comparing a model replay's outcome with the kept run's, for a case they
    /// marked; its cost counts in the bot's caps.
    async fn compare(
        self: &Arc<Self>,
        conversation: &str,
        case: &Case,
        outcome: &str,
    ) -> Option<Comparison> {
        let prompt = replay::comparison(case, outcome)?.session(conversation);
        let model = self.role_model(conversation, Role::Verify);
        let admitted = self.admit(conversation, &model).for_role(Role::Verify);
        let asked = tokio::time::timeout(
            COMPARE_TIME,
            self.models.generate::<Comparison>(&model, &prompt),
        )
        .await;
        match asked {
            Ok(Ok(generated)) => {
                admitted.settle(&generated.usage);
                Some(generated.value)
            }
            Ok(Err(error)) => {
                admitted.settle_if(error.usage());
                tracing::warn!(%error, "a replay's comparison failed");
                None
            }
            Err(_) => None,
        }
    }

    /// What a model replay of `agent`'s latest kept runs on `word` would cost, about.
    pub fn replay_estimate(&self, agent: &str, word: &str) -> Result<Value, ReplayError> {
        let bot = self.store.agent(agent)?.ok_or(ReplayError::NotFound)?;
        let model = self.replay_model(&bot.conversation, word)?;
        let cases = self.replay_cases_of(agent, &[])?;
        let price = self.models.price(&model);
        let (input, output) = price.map_or((0.0, 0.0), |p| (p.input, p.output));
        let micros: u64 = cases
            .iter()
            .map(|case| replay::estimate_micros(case, input, output))
            .sum();
        let name = self
            .models
            .resolve(&model)
            .map_or_else(|| model.clone(), |(_, m)| m.name);
        Ok(json!({
            "model": model,
            "model_name": name,
            "cases": cases.len(),
            "cost_micros": micros,
            "priced": price.is_some(),
            "mode": Mode::Model,
        }))
    }
}
