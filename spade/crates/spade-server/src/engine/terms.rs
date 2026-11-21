//! Subscriptions' terms in the engine (ADR 0205 §1, §4). A bot runs on a subscription only as
//! the person's informed choice: choosing one needs their acknowledgement of what it means for
//! that provider, stored as `cli_terms_ack:<provider>` with the date and the record's version
//! and status (a status change asks again). A provider whose record turns `refused` is offered to
//! no new bot, and a bot already on it waits for the person to pick another model: nothing is
//! switched for them, since a switch can move cost from a subscription to a paid endpoint.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use spade_core::brain::CliModel;
use spade_core::routing::{Overrides, Role};
use spade_models::{CliTerms, TermsRecord, TermsStatus};
use spade_store::{MODEL_ROLES, StoreError, roles_key};

use super::{AgentError, Engine};

const ACK: &str = "cli_terms_ack:";
/// The most one-tap choices a held bot's card offers.
const MOST_CHOICES: usize = 4;

/// The person's acknowledgement of one provider's terms.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Acknowledged {
    pub at_ms: i64,
    pub version: u32,
    pub status: TermsStatus,
}

impl Engine {
    /// The terms record in force.
    pub fn cli_terms(&self) -> Arc<CliTerms> {
        self.cli_terms
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    /// Puts `terms` in force in place of the shipped record (tests; later, a signed notice).
    /// A bot newly held by it waits from its next turn; nothing changes any bot's model.
    pub fn set_cli_terms(&self, terms: CliTerms) {
        *self.cli_terms.write().unwrap_or_else(|p| p.into_inner()) = Arc::new(terms);
    }

    fn acknowledged(&self, provider: &str) -> Option<Acknowledged> {
        let raw = self.store.setting(&format!("{ACK}{provider}")).ok()??;
        serde_json::from_str(&raw).ok()
    }

    /// Whether the person's acknowledgement for `provider` still stands: it was given for the
    /// status the provider has now.
    fn acknowledges(&self, record: &TermsRecord) -> bool {
        self.acknowledged(&record.provider)
            .is_some_and(|ack| ack.status == record.status)
    }

    /// The terms of `provider` as the picker shows them.
    pub fn terms_view(&self, provider: &str) -> Value {
        let terms = self.cli_terms();
        let record = terms.record(provider);
        json!({
            "status": record.status.name(),
            "checked": record.checked,
            "source": record.source,
            "note": record.note,
            "version": terms.version,
            "acknowledgement": record.acknowledgement(),
            "acknowledged": self.acknowledges(&record),
        })
    }

    /// The person ticked Use it for `provider`. Refused for a provider whose terms refuse it,
    /// and for one ace can't run.
    pub fn acknowledge_terms(&self, provider: &str) -> Result<Value, AgentError> {
        if !spade_core::brain::PROVIDERS.contains(&provider) {
            return Err(AgentError::Invalid(format!(
                "there is no provider {provider}"
            )));
        }
        let terms = self.cli_terms();
        let record = terms.record(provider);
        if record.status == TermsStatus::Refused {
            return Err(AgentError::Invalid(record.refusal()));
        }
        let ack = Acknowledged {
            at_ms: self.now_ms(),
            version: terms.version,
            status: record.status,
        };
        let raw = serde_json::to_string(&ack).unwrap_or_default();
        self.store
            .set_setting(&format!("{ACK}{provider}"), Some(&raw))?;
        Ok(self.terms_view(provider))
    }

    /// Whether a bot may be put on `model` now: an endpoint model always; a subscription only
    /// when its terms don't refuse it and the person acknowledged them.
    pub(super) fn check_terms(&self, model: &str) -> Result<(), AgentError> {
        let Some(cli) = CliModel::parse(model) else {
            return Ok(());
        };
        let record = self.cli_terms().record(&cli.provider);
        if record.status == TermsStatus::Refused {
            return Err(AgentError::Invalid(format!(
                "{}'s terms don't allow this; pick another model",
                record.shown_name()
            )));
        }
        if !self.acknowledges(&record) {
            return Err(AgentError::Terms {
                provider: cli.provider,
                text: record.acknowledgement(),
            });
        }
        Ok(())
    }

    /// The terms that hold a bot on `model` back, when its provider's record refuses it.
    pub(crate) fn refused_terms(&self, model: &str) -> Option<TermsRecord> {
        let cli = CliModel::parse(model)?;
        let record = self.cli_terms().record(&cli.provider);
        (record.status == TermsStatus::Refused).then_some(record)
    }

    /// Whether no turn of `conversation` may start because its bot's subscription is refused.
    pub(super) fn held_by_terms(&self, conversation: &str) -> bool {
        match self.store.agent_for_conversation(conversation) {
            Ok(Some(agent)) => self.refused_terms(&agent.model).is_some(),
            _ => false,
        }
    }

    /// What a held bot shows, once: the refusal and the person's own models as one-tap choices
    /// (the bot's `main` route, else the global one, then the first usable model). `None` for a
    /// bot that isn't held.
    pub(crate) fn terms_hold(&self, agent: &spade_store::Agent) -> Option<Value> {
        let record = self.refused_terms(&agent.model)?;
        let mut choices: Vec<String> = Vec::new();
        let routes = [roles_key(&agent.id), MODEL_ROLES.to_owned()];
        for key in routes {
            let overrides: Overrides = self
                .store
                .setting(&key)
                .ok()
                .flatten()
                .and_then(|raw| serde_json::from_str(&raw).ok())
                .unwrap_or_default();
            if let Some(route) = overrides.roles.get(&Role::Main) {
                choices.extend(route.0.iter().cloned());
            }
        }
        choices.push(self.default_model());
        let mut usable: Vec<String> = Vec::new();
        for model in choices {
            if !CliModel::is(&model)
                && self.configured(&model)
                && !usable.contains(&model)
                && usable.len() < MOST_CHOICES
            {
                usable.push(model);
            }
        }
        Some(json!({
            "provider": record.provider,
            "name": record.shown_name(),
            "text": record.refusal(),
            "choices": usable,
        }))
    }

    /// Whether `agent` waits for the person because its subscription's terms refuse it.
    pub fn agent_held_by_terms(&self, agent: &str) -> bool {
        matches!(self.store.agent(agent), Ok(Some(found)) if self.refused_terms(&found.model).is_some())
    }

    /// Answers what a bot held by its terms was sent meanwhile, once the person picked another
    /// model for it.
    pub fn release_terms_hold(self: &Arc<Self>, agent: &str) -> Result<(), StoreError> {
        let Some(found) = self.store.agent(agent)? else {
            return Ok(());
        };
        if self.refused_terms(&found.model).is_some() {
            return Ok(());
        }
        self.resume(&found.conversation)
    }
}
