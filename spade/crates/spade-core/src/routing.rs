//! Model routing (ADR 0162): which model each of a bot's roles uses, what the bot may pick per
//! call and when helper-level work escalates to the bot's own model. Pure: the server says what the person configured.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::brain::CliModel;

pub mod fallback;

/// What a model call is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    /// The bot's own turns: always the bot's model.
    Main,
    Helper,
    Verify,
    Review,
    Compact,
    Title,
}

impl Role {
    pub const ALL: [Self; 6] = [
        Self::Main,
        Self::Helper,
        Self::Verify,
        Self::Review,
        Self::Compact,
        Self::Title,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Self::Main => "main",
            Self::Helper => "helper",
            Self::Verify => "verify",
            Self::Review => "review",
            Self::Compact => "compact",
            Self::Title => "title",
        }
    }

    pub fn parse(word: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|r| r.name() == word.trim())
    }

    /// Whether the person can point the role at a model of its own (every role but `main`,
    /// which is the bot's model).
    pub fn routed(self) -> bool {
        self != Self::Main
    }
}

/// The most models a role's route holds (ADR 0205 §2).
pub const MOST_IN_ROUTE: usize = 4;

/// A role's models in order (ADR 0205 §2): the first that can serve a call serves it. Read from
/// a list or a single model (a list of one), so overrides stored by an older build still read.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct Route(pub Vec<String>);

impl<'de> Deserialize<'de> for Route {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Shape {
            One(String),
            Many(Vec<String>),
        }
        Ok(match Shape::deserialize(deserializer)? {
            Shape::One(model) => Self(vec![model]),
            Shape::Many(models) => Self(models),
        })
    }
}

impl Route {
    pub fn one(model: &str) -> Self {
        Self(vec![model.to_owned()])
    }

    pub fn first(&self) -> Option<&str> {
        self.0.first().map(String::as_str)
    }
}

/// The person's choices for one bot, or for every bot. Stored as JSON.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Overrides {
    /// A route per role, each model `endpoint/model`. `main`'s are the models the bot's own
    /// model falls back to.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub roles: BTreeMap<Role, Route>,
    /// The only models the bot may name per call besides its roles' (per bot only); `None`
    /// allows every model the person configured.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed: Option<Vec<String>>,
    /// Whether failed helper-level work reruns once on the bot's own model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub escalate: Option<bool>,
}

/// What the server knows about the person's models.
pub trait Models {
    /// Whether `reference` is a model listed on one of the person's endpoints.
    fn configured(&self, reference: &str) -> bool;
    /// The listed price, input plus output per million tokens; `None` when unpriced.
    fn strength(&self, reference: &str) -> Option<f64>;
}

/// The facts the defaults are drawn from.
#[derive(Debug, Clone, Default)]
pub struct Defaults {
    /// The person's fast model (`fast_model` in `GET /v1/models`).
    pub fast: Option<String>,
    /// Models the person already uses: other bots', the review, fast and new-bot models.
    pub in_use: Vec<String>,
}

/// Where a role's model came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Bot,
    Global,
    Default,
    /// The bot's own model: `main`, and every role with nothing better.
    Own,
}

impl Source {
    pub fn name(self) -> &'static str {
        match self {
            Self::Bot => "bot",
            Self::Global => "global",
            Self::Default => "default",
            Self::Own => "own",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Choice {
    pub model: String,
    pub source: Source,
}

/// Everything a role's model is chosen from.
pub struct Routing<'a, M: Models> {
    /// The bot's model.
    pub own: &'a str,
    pub bot: &'a Overrides,
    pub global: &'a Overrides,
    pub defaults: &'a Defaults,
    pub models: &'a M,
}

impl<M: Models> Routing<'_, M> {
    /// Whether a one-shot role can run on `reference`: an endpoint model the person configured.
    fn usable(&self, reference: &str) -> bool {
        !CliModel::is(reference) && self.models.configured(reference)
    }

    /// The model `role` uses: the bot's override, else the global one, else the default. An
    /// override whose model is gone is skipped.
    pub fn resolve(&self, role: Role) -> Choice {
        let own = || Choice {
            model: self.own.to_owned(),
            source: Source::Own,
        };
        if !role.routed() {
            return own();
        }
        for (overrides, source) in [(self.bot, Source::Bot), (self.global, Source::Global)] {
            if let Some(model) = overrides
                .roles
                .get(&role)
                .and_then(|route| route.0.iter().find(|m| self.usable(m)))
            {
                return Choice {
                    model: model.clone(),
                    source,
                };
            }
        }
        let default = match role {
            Role::Verify => self.strongest_other(),
            _ => self
                .defaults
                .fast
                .clone()
                .filter(|fast| fast != self.own && self.usable(fast)),
        };
        match default {
            Some(model) => Choice {
                model,
                source: Source::Default,
            },
            None => own(),
        }
    }

    /// The models `role` tries in order (ADR 0205 §2), at most [`MOST_IN_ROUTE`]: for `main`, the
    /// bot's own model, then the bot's `main` route, else the global one; for another role, its
    /// override's usable models, else its one model. Gone models are skipped, and a route never
    /// holds a subscription: a bot on one runs on it alone, never falling back to an endpoint.
    pub fn route(&self, role: Role) -> Vec<String> {
        if role == Role::Main && CliModel::is(self.own) {
            return vec![self.own.to_owned()];
        }
        let usable_of = |overrides: &Overrides| -> Vec<String> {
            overrides
                .roles
                .get(&role)
                .map(|route| route.0.iter().filter(|m| self.usable(m)).cloned().collect())
                .unwrap_or_default()
        };
        let chosen = [self.bot, self.global]
            .into_iter()
            .map(usable_of)
            .find(|list| !list.is_empty())
            .unwrap_or_default();
        let mut route: Vec<String> = Vec::new();
        let head = match role {
            Role::Main => Some(self.own.to_owned()),
            _ if chosen.is_empty() => Some(self.resolve(role).model),
            _ => None,
        };
        for model in head.into_iter().chain(chosen) {
            if !model.is_empty() && !route.contains(&model) && route.len() < MOST_IN_ROUTE {
                route.push(model);
            }
        }
        route
    }

    /// The strongest model the person already uses that lists at least the bot's own price and
    /// is not the bot's model.
    fn strongest_other(&self) -> Option<String> {
        let floor = self.models.strength(self.own)?;
        let mut best: Option<(f64, &String)> = None;
        for model in self.defaults.in_use.iter().chain(&self.defaults.fast) {
            if model == self.own || !self.usable(model) {
                continue;
            }
            let Some(strength) = self.models.strength(model) else {
                continue;
            };
            let better = match best {
                None => true,
                Some((top, name)) => strength > top || (strength == top && model < name),
            };
            if strength >= floor && better {
                best = Some((strength, model));
            }
        }
        best.map(|(_, model)| model.clone())
    }

    /// Every role with its model, in order.
    pub fn table(&self) -> Vec<(Role, Choice)> {
        Role::ALL
            .into_iter()
            .map(|r| (r, self.resolve(r)))
            .collect()
    }

    /// Whether failed helper-level work reruns on the bot's model: the bot's setting, else the
    /// global one, else off.
    pub fn escalate(&self) -> bool {
        self.bot.escalate.or(self.global.escalate).unwrap_or(false)
    }

    /// The model a call that names `wanted` (a role or `endpoint/model`) runs on, or why not.
    pub fn pick(&self, wanted: &str) -> Result<String, String> {
        let wanted = wanted.trim();
        if let Some(role) = Role::parse(wanted) {
            return Ok(self.resolve(role).model);
        }
        let allowed = self
            .bot
            .allowed
            .as_ref()
            .is_none_or(|list| list.iter().any(|m| m == wanted));
        if self.usable(wanted) && allowed {
            return Ok(wanted.to_owned());
        }
        Err(self.refusal(wanted))
    }

    fn refusal(&self, wanted: &str) -> String {
        let roles: Vec<String> = self
            .table()
            .into_iter()
            .map(|(role, choice)| format!("{} ({})", role.name(), choice.model))
            .collect();
        let mut text = format!(
            "{wanted} is not a model the person set up for you. Name a role: {}",
            roles.join(", ")
        );
        if let Some(list) = &self.bot.allowed {
            let usable: Vec<&str> = list
                .iter()
                .filter(|m| self.usable(m))
                .map(String::as_str)
                .collect();
            if !usable.is_empty() {
                text.push_str(&format!("; or one of these models: {}", usable.join(", ")));
            }
        } else {
            text.push_str("; or a model on the person's endpoints, as endpoint/model");
        }
        text.push('.');
        text
    }
}

/// How a piece of helper-level work ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Done,
    /// It failed or finished without an answer.
    Failed,
    /// A check found it not yet done (verified work, such as a worker's).
    NotYet,
    /// Someone stopped it.
    Stopped,
}

/// The model to rerun work on, once: the bot's own, when escalation is on, this was the first
/// attempt, it failed or was found not yet done, and it ran on another model.
pub fn escalate_to<'a>(
    on: bool,
    attempt: u32,
    outcome: Outcome,
    ran_on: &str,
    own: &'a str,
) -> Option<&'a str> {
    let failed = matches!(outcome, Outcome::Failed | Outcome::NotYet);
    (on && attempt == 0 && failed && ran_on != own && !own.is_empty()).then_some(own)
}

/// What marks a job's second attempt.
const RETRY: &str = "~2";

/// The id the rerun of `job` is stored under.
pub fn retry_job(job: &str) -> String {
    format!("{}{RETRY}", base_job(job))
}

/// The job a rerun belongs to (itself for a first attempt).
pub fn base_job(job: &str) -> &str {
    job.strip_suffix(RETRY).unwrap_or(job)
}

/// Which attempt `job` is: 0 for the first, 1 for its rerun.
pub fn attempt(job: &str) -> u32 {
    u32::from(job.ends_with(RETRY))
}

#[cfg(test)]
mod tests;
