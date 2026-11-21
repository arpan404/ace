//! A package's scenario tests (ADR 0200 §9): `tests/<name>.json`, each one run of the agent on
//! Spade's real engine against a scripted model, then what must have happened. Pure: the file is
//! read here and a run's observations are checked here; the run itself (a throwaway Spade, the
//! fake endpoint, fake tools) is the server's.
//!
//! ```json
//! {
//!   "name": "Remembers a trip to watch",
//!   "given": { "message": "Watch KTM to DEL in March, under $200." },
//!   "model": [
//!     { "calls": [{ "tool": "memory_save", "arguments": { "text": "KTM-DEL, March, under 200" } }] },
//!     { "say": "I'll watch KTM to DEL and tell you when it drops under $200." }
//!   ],
//!   "tools": { "web_fetch": "KTM-DEL 182 USD" },
//!   "expect": { "calls": ["memory_save"], "reply_contains": ["watch"] }
//! }
//! ```
//!
//! Each `model` step is one answer of the model: words it says, then tool calls; the last step
//! repeats if the engine asks again. `tools` are fake results by tool name, for the tools that
//! would reach outside (they never run), one answer or a list taken in turn. A call whose effect
//! the package didn't declare is refused by the gate, as it would be for the person; the test
//! fails unless `expect.refused` names it.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::effect::Effect;

/// The id a run gives a scenario's contract call, which its scripted `contract_return` names.
pub const CALL: &str = "cc.scenario";

/// Most model steps a scenario scripts.
pub const MOST_STEPS: usize = 64;
/// Most tool calls in one step.
const MOST_CALLS: usize = 16;

/// What starts the run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Given {
    /// The person writes this to the bot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// One of the package's schedule, event or webhook triggers fires, by name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger: Option<String>,
    /// Another bot of the person's calls one of the package's contracts (ADR 0200 §7).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub call: Option<GivenCall>,
}

/// A contract call a scenario gives the bot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GivenCall {
    /// One of the package's contracts, by name.
    pub contract: String,
    /// The call's input, which fits the contract's input schema.
    pub input: Value,
    /// The calling bot's name; "Another bot" when unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
}

/// A tool call the scripted model makes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ScriptedCall {
    /// The tool's name.
    pub tool: String,
    /// Its arguments, an object.
    #[serde(default = "empty_object")]
    pub arguments: Value,
}

fn empty_object() -> Value {
    Value::Object(serde_json::Map::new())
}

/// One answer of the scripted model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Step {
    /// What the model says.
    #[serde(default)]
    pub say: String,
    /// The tool calls it makes after saying it.
    #[serde(default)]
    pub calls: Vec<ScriptedCall>,
}

/// A fake tool's answers: one, or a list taken in turn (the last repeats).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Answers {
    One(String),
    Many(Vec<String>),
}

impl Answers {
    pub fn list(&self) -> Vec<String> {
        match self {
            Self::One(answer) => vec![answer.clone()],
            Self::Many(answers) => answers.clone(),
        }
    }
}

/// What must have happened.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Expect {
    /// Tools that ran, in this order (others may run between them).
    #[serde(default)]
    pub calls: Vec<String>,
    /// Tools that must not have run.
    #[serde(default)]
    pub not_called: Vec<String>,
    /// Effects the agent asked for (`network`, `publish`, `send_as_person`, …), as the gate read
    /// its calls.
    #[serde(default)]
    pub effects: Vec<String>,
    /// Tools the gate refused, because the package didn't declare their effect.
    #[serde(default)]
    pub refused: Vec<String>,
    /// Cards shown, each by words in its title.
    #[serde(default)]
    pub cards: Vec<String>,
    /// Words the agent's reply contains, case aside.
    #[serde(default)]
    pub reply_contains: Vec<String>,
    /// With `given.call`: fields the call's output holds, each with this value. The output is
    /// always checked against the contract's schema.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<Value>,
}

/// `tests/<name>.json`, read.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Scenario {
    /// What the scenario shows, in a few words.
    pub name: String,
    /// What starts the run: a message, a trigger or a call, one of them.
    pub given: Given,
    /// The scripted model: one step per model call; the last step only says something.
    pub model: Vec<Step>,
    /// Fake results by tool name, for tools that would reach outside.
    #[serde(default)]
    pub tools: BTreeMap<String, Answers>,
    /// What must have happened.
    #[serde(default)]
    pub expect: Expect,
}

impl Scenario {
    /// Every tool the scripted model calls, once each, in order of first call.
    pub fn called_tools(&self) -> Vec<String> {
        let mut names: Vec<String> = Vec::new();
        for call in self.model.iter().flat_map(|step| &step.calls) {
            if !names.contains(&call.tool) {
                names.push(call.tool.clone());
            }
        }
        names
    }
}

/// Reads a scenario file's text; every problem with its place otherwise.
pub fn read_scenario(text: &str, triggers: &[&str]) -> Result<Scenario, Vec<String>> {
    let scenario: Scenario = serde_json::from_str(text).map_err(|error| vec![error.to_string()])?;
    let mut problems = Vec::new();
    if scenario.name.trim().is_empty() {
        problems.push("name says in a few words what the scenario shows".to_owned());
    }
    let given = &scenario.given;
    match (&given.message, &given.trigger, &given.call) {
        (Some(message), None, None) if !message.trim().is_empty() => {}
        (None, Some(trigger), None) if triggers.contains(&trigger.as_str()) => {}
        (None, Some(trigger), None) => problems.push(format!(
            "given.trigger: {trigger:?} isn't one of the package's schedule, event or webhook triggers"
        )),
        (None, None, Some(_)) => {}
        _ => problems.push("given is a message, a trigger or a call, one of them".to_owned()),
    }
    if scenario.expect.output.is_some() && given.call.is_none() {
        problems.push("expect.output is for a scenario that gives the bot a call".to_owned());
    }
    if scenario
        .expect
        .output
        .as_ref()
        .is_some_and(|output| !output.is_object())
    {
        problems.push("expect.output names fields and their values".to_owned());
    }
    if scenario.model.is_empty() {
        problems.push("model has at least one step: what the model answers".to_owned());
    }
    if scenario.model.len() > MOST_STEPS {
        problems.push(format!("model has at most {MOST_STEPS} steps"));
    }
    for (at, step) in scenario.model.iter().enumerate() {
        if step.calls.len() > MOST_CALLS {
            problems.push(format!("model[{at}] makes at most {MOST_CALLS} calls"));
        }
        for (index, call) in step.calls.iter().enumerate() {
            if !tool_name(&call.tool) {
                problems.push(format!(
                    "model[{at}].calls[{index}].tool: {:?} isn't a tool name",
                    call.tool
                ));
            }
            if !call.arguments.is_object() {
                problems.push(format!("model[{at}].calls[{index}].arguments is an object"));
            }
        }
    }
    if scenario
        .model
        .last()
        .is_some_and(|step| !step.calls.is_empty())
    {
        problems.push(
            "model's last step only says something: the engine asks again after each call"
                .to_owned(),
        );
    }
    for word in &scenario.expect.effects {
        if Effect::parse(word).is_none() {
            problems.push(format!("expect.effects: {word:?} isn't an effect"));
        }
    }
    if problems.is_empty() {
        Ok(scenario)
    } else {
        Err(problems)
    }
}

fn tool_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && name.len() <= 64
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// What's wrong with a scenario's `given.call` against the package's contracts: one it doesn't
/// publish, or input that doesn't fit.
pub fn call_problems(scenario: &Scenario, contracts: &[super::contract::Contract]) -> Vec<String> {
    let Some(call) = &scenario.given.call else {
        return Vec::new();
    };
    match contracts.iter().find(|c| c.name == call.contract) {
        None => vec![format!(
            "given.call.contract: the package has no contract {:?}",
            call.contract
        )],
        Some(contract) => contract
            .misfit_input(&call.input)
            .unwrap_or_default()
            .into_iter()
            .map(|p| format!("given.call: {p}"))
            .collect(),
    }
}

/// What a contract call given to the bot came to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Returned {
    /// Its output, which fit the contract's schema.
    Output(Value),
    /// It failed, with why.
    Failed(Vec<String>),
}

/// How one call the model made ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// It ran (after the person allowed it, if it was put to them).
    Ran,
    /// The gate refused it, with the reason.
    Refused(String),
    /// It ran and answered with an error.
    Failed(String),
}

/// One call, as the run saw it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Seen {
    pub tool: String,
    /// What the gate read it as.
    pub effect: Option<Effect>,
    pub outcome: Outcome,
}

/// Everything a run shows, from the conversation's own events.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Observed {
    pub calls: Vec<Seen>,
    /// Titles of the cards shown.
    pub cards: Vec<String>,
    /// Why a card the agent tried to show was refused.
    pub card_problems: Vec<String>,
    pub reply: String,
    /// The turn didn't end in a reply: why.
    pub ended: Option<String>,
    /// With `given.call`: what the call came to, once it ended.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub returned: Option<Returned>,
}

/// What failed, in sentences; empty when the scenario passes.
pub fn check(scenario: &Scenario, observed: &Observed) -> Vec<String> {
    let expect = &scenario.expect;
    let mut failures = Vec::new();
    if let Some(ended) = &observed.ended {
        failures.push(format!("The turn didn't finish with a reply: {ended}"));
    }
    for problem in &observed.card_problems {
        failures.push(format!("A card didn't fit and wasn't shown: {problem}"));
    }
    let started: Vec<&Seen> = observed
        .calls
        .iter()
        .filter(|c| !matches!(c.outcome, Outcome::Refused(_)))
        .collect();
    let ran: Vec<&str> = started.iter().map(|c| c.tool.as_str()).collect();
    let mut from = 0;
    for wanted in &expect.calls {
        match ran[from..].iter().position(|tool| tool == wanted) {
            Some(at) => {
                if let Outcome::Failed(error) = &started[from + at].outcome {
                    failures.push(format!("{wanted} ran and answered an error: {error}"));
                }
                from += at + 1;
            }
            None if ran.contains(&wanted.as_str()) => {
                failures.push(format!(
                    "{wanted} ran, but not in the order expect.calls gives"
                ));
            }
            None => failures.push(format!("{wanted} was expected to run and didn't")),
        }
    }
    for unwanted in &expect.not_called {
        if ran.contains(&unwanted.as_str()) {
            failures.push(format!(
                "{unwanted} ran, and expect.not_called says it mustn't"
            ));
        }
    }
    for seen in &observed.calls {
        if let Outcome::Refused(why) = &seen.outcome
            && !expect.refused.contains(&seen.tool)
        {
            failures.push(format!(
                "{} was refused: {why} Declare its effect in bot.json, or name it in expect.refused",
                seen.tool
            ));
        }
    }
    for wanted in &expect.refused {
        let refused = observed
            .calls
            .iter()
            .any(|c| &c.tool == wanted && matches!(c.outcome, Outcome::Refused(_)));
        if !refused {
            failures.push(format!("{wanted} was expected to be refused and wasn't"));
        }
    }
    for word in &expect.effects {
        let asked = observed
            .calls
            .iter()
            .any(|c| c.effect.is_some_and(|e| e.name() == word));
        if !asked {
            failures.push(format!("No call asked for {word}"));
        }
    }
    for title in &expect.cards {
        let shown = observed.cards.iter().any(|card| contains(card, title));
        if !shown {
            failures.push(format!("No card titled with {title:?} was shown"));
        }
    }
    for words in &expect.reply_contains {
        if !contains(&observed.reply, words) {
            failures.push(format!("The reply doesn't say {words:?}"));
        }
    }
    if scenario.given.call.is_some() {
        failures.extend(returned_failures(expect, observed.returned.as_ref()));
    }
    failures
}

/// What failed about a given call's answer: none came, it failed, or a field differs.
fn returned_failures(expect: &Expect, returned: Option<&Returned>) -> Vec<String> {
    let output = match returned {
        None => {
            return vec!["The call got no answer: the bot never used contract_return".to_owned()];
        }
        Some(Returned::Failed(problems)) => {
            return vec![format!("The call failed: {}", problems.join("; "))];
        }
        Some(Returned::Output(output)) => output,
    };
    let wanted = expect.output.as_ref().and_then(Value::as_object);
    wanted
        .into_iter()
        .flatten()
        .filter(|(field, value)| output.get(field.as_str()) != Some(value))
        .map(|(field, value)| {
            format!(
                "The output's {field} is {}, not {value}",
                output.get(field.as_str()).unwrap_or(&Value::Null)
            )
        })
        .collect()
}

fn contains(text: &str, words: &str) -> bool {
    text.to_lowercase().contains(&words.to_lowercase())
}

#[cfg(test)]
#[path = "scenario_tests.rs"]
mod tests;
