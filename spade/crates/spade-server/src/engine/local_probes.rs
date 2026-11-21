//! Local models' checks in the engine (ADR 0205 §3; the checks are `spade_models::probes`). A
//! model added from a server on this computer starts with no `tools`, so nothing runs a bot on
//! it before it is measured; its three checks then run in the background, their results are
//! kept as `local_probes:<endpoint>/<model>`, and they set its `tools`. A model that can't call
//! tools serves only `title` and `compact`, and can't be a bot's model.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use spade_models::{Capability, Probe, ProbeResults};

use super::{AgentError, Engine, ModelInput};

const PROBES: &str = "local_probes:";

/// What a model's checks found, and when.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Probed {
    pub at_ms: i64,
    #[serde(flatten)]
    pub results: ProbeResults,
}

/// What the picker says about a model whose checks found it can't call tools.
pub const NO_TOOLS: &str = "This model didn't call tools in Spade's check, so it can't run a bot.";
/// What it says while the checks run.
pub const CHECKING: &str = "Spade is still checking what this model can do; try again in a moment.";
/// What it says while the checks couldn't reach the model.
pub const UNCHECKED: &str =
    "Spade couldn't reach this model to check it, so it can't run a bot yet. Check it again once \
     its server is running.";

/// Models whose checks are running now.
#[derive(Default)]
pub(crate) struct Probing(Mutex<HashSet<String>>);

/// Takes `reference` off the running list however its checks end.
struct Done<'a>(&'a Probing, String);

impl Drop for Done<'_> {
    fn drop(&mut self) {
        self.0.0.lock().unwrap_or_else(|p| p.into_inner()).remove(&self.1);
    }
}

impl Engine {
    /// The family ace measured local model `id` in, if it did (`models.json`'s `local`).
    pub fn known_good(&self, id: &str) -> Option<spade_models::KnownGood> {
        self.models.catalog().known_good(id).cloned()
    }

    /// Whether `reference`'s endpoint is on this computer.
    pub fn is_local(&self, reference: &str) -> bool {
        self.is_local_model(reference)
    }

    /// Endpoint `id`, if the person has it.
    pub fn models_endpoint(&self, id: &str) -> Option<spade_models::Endpoint> {
        self.models.endpoint(id)
    }

    /// What `reference`'s checks last found, if they ran.
    pub fn probed(&self, reference: &str) -> Option<Probed> {
        let raw = self
            .store
            .setting(&format!("{PROBES}{reference}"))
            .ok()??;
        serde_json::from_str(&raw).ok()
    }

    /// Whether `reference`'s checks are running now.
    pub fn probing(&self, reference: &str) -> bool {
        self.probing
            .0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .contains(reference)
    }

    /// Starts `reference`'s checks in the background, unless they are already running; answers
    /// whether they started. Only for a model on this computer: checks cost nothing there.
    pub fn start_probe(self: &Arc<Self>, reference: &str) -> bool {
        if !self.is_local_model(reference) {
            return false;
        }
        let fresh = self
            .probing
            .0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(reference.to_owned());
        if !fresh {
            return false;
        }
        let engine = Arc::clone(self);
        let reference = reference.to_owned();
        tokio::spawn(async move {
            let _done = Done(&engine.probing, reference.clone());
            let results = engine.models.probe(&reference).await;
            engine.keep_probe(&reference, results);
        });
        true
    }

    /// Keeps what the checks found and, when they reached the model, sets its `tools`.
    fn keep_probe(&self, reference: &str, results: ProbeResults) {
        let record = Probed {
            at_ms: self.now_ms(),
            results,
        };
        let raw = serde_json::to_string(&record).unwrap_or_default();
        if let Err(error) = self
            .store
            .set_setting(&format!("{PROBES}{reference}"), Some(&raw))
        {
            tracing::warn!(%error, reference, "a local model's checks couldn't be kept");
        }
        let current = self
            .models
            .resolve(reference)
            .map(|(_, model)| model.capabilities)
            .unwrap_or_default();
        let (Some(measured), Some((endpoint, id))) =
            (results.capabilities(&current), reference.split_once('/'))
        else {
            return;
        };
        let input = ModelInput {
            id: id.to_owned(),
            capabilities: Some(measured.iter().map(|c| c.name().to_owned()).collect()),
            ..ModelInput::default()
        };
        if let Err(error) = self.save_model(endpoint, input) {
            tracing::warn!(%error, reference, "a local model's measured abilities couldn't be saved");
        }
    }

    /// The checks as the person's settings show them: `checking`, `checked` with each result,
    /// or `unchecked`; with the line the picker shows when the model can't run a bot.
    pub fn probe_view(&self, reference: &str) -> Value {
        if self.probing(reference) {
            return json!({ "state": "checking" });
        }
        let Some(probed) = self.probed(reference) else {
            return json!({ "state": "unchecked" });
        };
        let r = probed.results;
        let why = if !r.measured() {
            Some(UNCHECKED)
        } else if !r.calls_tools() {
            Some(NO_TOOLS)
        } else {
            None
        };
        json!({
            "state": "checked",
            "at_ms": probed.at_ms,
            "plain": r.plain,
            "tools": r.tools,
            "structured": r.structured,
            "why": why,
        })
    }

    /// Whether `model` can run a bot: it calls tools, as the person's endpoints list it (as
    /// measured, for a local model). A model nobody described is taken to.
    pub(super) fn check_runs_bots(&self, model: &str) -> Result<(), AgentError> {
        let Some((_, facts)) = self.models.resolve(model) else {
            return Ok(());
        };
        if facts.can(Capability::Tools) {
            return Ok(());
        }
        let measured = self
            .probed(model)
            .map(|p| p.results)
            .filter(ProbeResults::measured);
        Err(AgentError::Invalid(match measured {
            Some(results) if results.tools == Probe::Failed => NO_TOOLS.to_owned(),
            None if self.probing(model) => CHECKING.to_owned(),
            None if self.is_local_model(model) => UNCHECKED.to_owned(),
            _ => format!(
                "{} can't call tools, so it can't run a bot; it can still write titles and summaries",
                facts.name
            ),
        }))
    }
}
