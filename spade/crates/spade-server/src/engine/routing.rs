//! Model routing (ADR 0162, spade/docs/agents.md "Models per role"): the person's overrides,
//! globally and per bot, kept as JSON in the `settings` table; each role's model for a
//! conversation; and spend by role. The rules are `spade_core::routing`.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde_json::{Value, json};
use spade_core::routing::{Budget, Defaults, Models, Overrides, Role, Routing};
use spade_models::Endpoint;
use spade_store::StoreError;

use super::Engine;
use super::oversight::{GlobalChange, OversightError};

use spade_store::{MODEL_ROLES as GLOBAL, roles_key as agent_key};

/// Tokens a summary needs beyond its prompt.
const COMPACT_HEADROOM: u64 = 8_192;
/// The most models a bot's allowed list holds.
const MOST_ALLOWED: usize = 200;

/// The person's endpoints as routing reads them.
struct Person(Arc<Vec<Endpoint>>);

impl Person {
    fn model(&self, reference: &str) -> Option<&spade_models::Model> {
        let (endpoint, id) = reference.split_once('/')?;
        self.0
            .iter()
            .find(|e| e.id == endpoint)?
            .models
            .iter()
            .find(|m| m.id == id)
    }
}

impl Models for Person {
    fn configured(&self, reference: &str) -> bool {
        self.model(reference).is_some()
    }

    fn strength(&self, reference: &str) -> Option<f64> {
        let price = self.model(reference)?.price?;
        Some(price.input + price.output)
    }
}

/// A change to overrides: `Some(None)` clears a value, `None` keeps it.
#[derive(Debug, Default)]
pub struct RolesChange {
    pub roles: BTreeMap<String, Option<String>>,
    pub allowed: Option<Option<Vec<String>>>,
    pub escalate: Option<Option<bool>>,
}

/// Everything a conversation's roles are resolved from.
struct Facts {
    own: String,
    bot: Overrides,
    global: Overrides,
    defaults: Defaults,
    person: Person,
}

impl Facts {
    fn routing(&self) -> Routing<'_, Person> {
        Routing {
            own: &self.own,
            bot: &self.bot,
            global: &self.global,
            defaults: &self.defaults,
            models: &self.person,
        }
    }
}

impl Engine {
    fn read_overrides(&self, key: &str) -> Result<Overrides, StoreError> {
        Ok(self
            .store
            .setting(key)?
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default())
    }

    /// The global overrides as stored, with the review model from oversight (one setting, one
    /// place: ADR 0162).
    fn global_overrides(&self) -> Overrides {
        let mut global = self.read_overrides(GLOBAL).unwrap_or_default();
        global.roles.remove(&Role::Review);
        if let Ok(super::oversight::Global {
            review_model: Some(model),
            ..
        }) = self.oversight()
        {
            global.roles.insert(Role::Review, model);
        }
        global
    }

    /// What the person already uses: every bot's model, and the review, fast and new-bot models.
    fn defaults(&self) -> Defaults {
        let fast = self.fast_model().ok().flatten();
        let mut in_use: Vec<String> = self
            .store
            .agents()
            .map(|agents| agents.into_iter().map(|a| a.model).collect())
            .unwrap_or_default();
        in_use.extend(self.oversight().ok().and_then(|g| g.review_model));
        in_use.extend(self.new_bot_model().ok().flatten());
        in_use.sort();
        in_use.dedup();
        Defaults { fast, in_use }
    }

    fn facts(&self, conversation: &str) -> Facts {
        let agent = self.agent_of(conversation);
        Facts {
            own: self.reply_model(conversation),
            bot: agent
                .map(|a| self.read_overrides(&agent_key(&a)).unwrap_or_default())
                .unwrap_or_default(),
            global: self.global_overrides(),
            defaults: self.defaults(),
            person: Person(self.models.endpoints()),
        }
    }

    /// The model `role` uses in `conversation` (a helper's conversation answers for its bot).
    pub(crate) fn role_model(&self, conversation: &str, role: Role) -> String {
        self.facts(conversation).routing().resolve(role).model
    }

    /// The model a compaction summary of `prompt`, built for `turn_model`, runs on (ADR 0162
    /// decision 7): the `compact` role's when its context holds the prompt and it reads what the
    /// prompt carries, and (unless the person chose it) when it costs less cold than the turn's
    /// model reading its cache; else the turn's model.
    pub(super) fn compact_model(
        &self,
        conversation: &str,
        turn_model: &str,
        prompt: &spade_models::Prompt,
        hint: super::ledger::Hint,
    ) -> String {
        use spade_core::routing::Source;
        use spade_models::Capability;
        let choice = self.facts(conversation).routing().resolve(Role::Compact);
        let candidate = choice.model;
        if candidate == turn_model || choice.source == Source::Own {
            return turn_model.to_owned();
        }
        let facts = |m: &str| self.models.resolve(m).map(|(_, facts)| facts);
        let (Some(theirs), ours) = (facts(&candidate), facts(turn_model)) else {
            return turn_model.to_owned();
        };
        let needed = u64::from(super::ledger::prompt_tokens(prompt)) + COMPACT_HEADROOM;
        let fits = theirs.context.is_some_and(|c| c >= needed);
        let reads = [Capability::Images, Capability::PdfInput, Capability::Tools]
            .into_iter()
            .all(|c| theirs.can(c) || !ours.as_ref().is_some_and(|m| m.can(c)));
        if !fits || !reads {
            return turn_model.to_owned();
        }
        let chosen = matches!(choice.source, Source::Bot | Source::Global);
        let cold = super::ledger::estimate(theirs.price, prompt, super::ledger::Hint::default());
        let warm = super::ledger::estimate(self.models.price(turn_model), prompt, hint);
        if chosen || cold < warm {
            candidate
        } else {
            turn_model.to_owned()
        }
    }

    /// The model a helper call that names `wanted` runs on, or why it can't.
    pub(crate) fn pick_model(&self, conversation: &str, wanted: &str) -> Result<String, String> {
        self.facts(conversation).routing().pick(wanted)
    }

    /// Whether the bot's failed helper-level work reruns once on its own model.
    pub(crate) fn escalates(&self, conversation: &str) -> bool {
        self.facts(conversation).routing().escalate()
    }

    /// Whether `model` is listed on one of the person's endpoints.
    pub(crate) fn configured(&self, model: &str) -> bool {
        Person(self.models.endpoints()).configured(model)
    }

    /// What `conversation` spent from `since_ms` on, by role.
    fn spend_by_role(&self, conversation: &str, since_ms: i64) -> BTreeMap<String, u64> {
        self.store
            .spent_by_role(conversation, since_ms)
            .unwrap_or_default()
    }

    /// `{today, month}` spend by role for the bot of `conversation`.
    pub(crate) fn role_spend_json(&self, conversation: &str) -> Value {
        let periods = self.periods();
        json!({
            "today": self.spend_by_role(conversation, periods.day_start),
            "month": self.spend_by_role(conversation, periods.month_start),
        })
    }

    /// The `<budget>` note for the bot of `conversation` (ADR 0162): information only.
    pub(crate) fn budget_note(&self, conversation: &str) -> String {
        let Ok(Some(agent)) = self.store.agent_for_conversation(conversation) else {
            return String::new();
        };
        let Ok((spent, settings, _)) = self.spending(&agent) else {
            return String::new();
        };
        let periods = self.periods();
        let today_by_role = self
            .spend_by_role(&agent.conversation, periods.day_start)
            .into_iter()
            .filter(|(_, spent)| *spent > 0)
            .filter_map(|(role, spent)| Role::parse(&role).map(|r| (r, spent)))
            .collect();
        let facts = self.facts(conversation);
        let roles = facts
            .routing()
            .table()
            .into_iter()
            .map(|(role, choice)| (role, choice.model))
            .collect();
        spade_core::routing::note(&Budget {
            today_micros: spent.today_micros,
            month_micros: spent.month_micros,
            daily_cap_micros: settings.daily_cap_micros,
            monthly_cap_micros: settings.monthly_cap_micros,
            today_by_role,
            roles,
        })
    }

    /// `GET /v1/models/roles`: the global overrides, `null` for none.
    pub fn global_roles_view(&self) -> Result<Value, StoreError> {
        let global = self.global_overrides();
        Ok(json!({
            "roles": routed_json(&global),
            "escalate": global.escalate,
        }))
    }

    /// `GET /v1/agents/{id}/models`: each role's model and where it came from, the bot's own
    /// overrides, and what each role spent. `None` for an unknown agent.
    pub fn agent_roles_view(&self, agent: &str) -> Result<Option<Value>, StoreError> {
        let Some(stored) = self.store.agent(agent)? else {
            return Ok(None);
        };
        let facts = self.facts(&stored.conversation);
        let routing = facts.routing();
        let roles: Vec<Value> = routing
            .table()
            .into_iter()
            .map(|(role, choice)| {
                json!({"role": role.name(), "model": choice.model, "source": choice.source.name()})
            })
            .collect();
        Ok(Some(json!({
            "roles": roles,
            "overrides": {
                "roles": routed_json(&facts.bot),
                "allowed": facts.bot.allowed,
                "escalate": facts.bot.escalate,
            },
            "escalate": routing.escalate(),
            "spend": self.role_spend_json(&stored.conversation),
        })))
    }

    /// `PUT /v1/models/roles`. The review model is oversight's own setting, changed there.
    pub fn set_global_roles(&self, change: RolesChange) -> Result<Value, OversightError> {
        let review = change.roles.get(Role::Review.name()).cloned();
        if change.allowed.is_some() {
            return Err(OversightError::Invalid(
                "an allowed list is set per bot".to_owned(),
            ));
        }
        {
            let _held = self.agent_lock.lock().unwrap_or_else(|p| p.into_inner());
            let mut global = self.read_overrides(GLOBAL)?;
            self.apply(&mut global, change)?;
            global.roles.remove(&Role::Review);
            self.store.set_setting(GLOBAL, Some(&to_json(&global)))?;
        }
        if let Some(model) = review {
            self.set_oversight(GlobalChange {
                review_model: Some(model),
                ..GlobalChange::default()
            })?;
        }
        Ok(self.global_roles_view()?)
    }

    /// `PUT /v1/agents/{id}/models`.
    pub fn set_agent_roles(
        &self,
        agent: &str,
        change: RolesChange,
    ) -> Result<Value, OversightError> {
        {
            let _held = self.agent_lock.lock().unwrap_or_else(|p| p.into_inner());
            if self.store.agent(agent)?.is_none() {
                return Err(OversightError::NotFound);
            }
            let key = agent_key(agent);
            let mut overrides = self.read_overrides(&key)?;
            self.apply(&mut overrides, change)?;
            self.store.set_setting(&key, Some(&to_json(&overrides)))?;
        }
        self.agent_roles_view(agent)?
            .ok_or(OversightError::NotFound)
    }

    /// Applies `change` to `overrides`, checking each model names one the person configured.
    fn apply(&self, overrides: &mut Overrides, change: RolesChange) -> Result<(), OversightError> {
        let invalid = |text: String| OversightError::Invalid(text);
        for (name, model) in change.roles {
            let role = Role::parse(&name)
                .ok_or_else(|| invalid(format!("there is no role named {name}")))?;
            if !role.routed() {
                return Err(invalid(
                    "main is the bot's own model; change it on the bot".to_owned(),
                ));
            }
            match model {
                Some(model) => {
                    let model = self.one_shot_model(&model)?;
                    overrides.roles.insert(role, model);
                }
                None => {
                    overrides.roles.remove(&role);
                }
            }
        }
        if let Some(allowed) = change.allowed {
            overrides.allowed = match allowed {
                None => None,
                Some(list) if list.len() > MOST_ALLOWED => {
                    return Err(invalid(format!("at most {MOST_ALLOWED} allowed models")));
                }
                Some(list) => {
                    let mut checked = Vec::new();
                    for model in list {
                        let model = self.one_shot_model(&model)?;
                        if !checked.contains(&model) {
                            checked.push(model);
                        }
                    }
                    Some(checked)
                }
            };
        }
        if let Some(escalate) = change.escalate {
            overrides.escalate = escalate;
        }
        Ok(())
    }

    /// `model` checked as one a role can run on: on the person's endpoints, never a CLI.
    fn one_shot_model(&self, model: &str) -> Result<String, OversightError> {
        let model = model.trim();
        if spade_core::brain::CliModel::is(model) {
            return Err(OversightError::Invalid(
                "a subscription runs whole sessions; give this role a model from an endpoint"
                    .to_owned(),
            ));
        }
        if !self.configured(model) {
            return Err(OversightError::Invalid(format!(
                "{model} is not a model on your endpoints"
            )));
        }
        Ok(model.to_owned())
    }
}

/// Every routed role with its override, `null` for none.
fn routed_json(overrides: &Overrides) -> Value {
    let mut map = serde_json::Map::new();
    for role in Role::ALL.into_iter().filter(|r| r.routed()) {
        map.insert(
            role.name().to_owned(),
            overrides.roles.get(&role).map_or(Value::Null, |m| json!(m)),
        );
    }
    Value::Object(map)
}

fn to_json(overrides: &Overrides) -> String {
    serde_json::to_string(overrides).unwrap_or_default()
}

/// The role an activity entry's cost was for, when it carries one (ADR 0162).
pub fn entry_role(entry: &spade_core::activity::Entry) -> Option<&'static str> {
    use spade_core::activity::Kind;
    entry.cost_micros?;
    Some(match entry.kind {
        Kind::Review => Role::Review.name(),
        Kind::Spend => Role::Main.name(),
        _ if entry.name.as_deref() == Some(spade_core::helper::TOOL) => Role::Helper.name(),
        _ => return None,
    })
}
