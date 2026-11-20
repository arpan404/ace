//! Typed calls between the person's bots (ADR 0200 §7; spade/docs/contracts.md).
//!
//! - `contracts_find` lists the contracts of the bots the caller may reach: the person's own, on
//!   this machine and on their other machines, each that takes calls.
//! - `contract_call` is a background job keyed by its call id, the caller's idempotency key. It
//!   stores `contract_called` in the caller's conversation, then delivers the call to the callee
//!   as a message from the caller (never the person's words), once: a run after a restart finds
//!   the call it delivered and waits for it again. Its result arrives once, as a
//!   `<contract_result>`.
//! - The callee works under its own gate, ceiling and grants, held to the contract's effects
//!   while the call is open ([`Engine::call_ceilings`]). It answers with `contract_return`,
//!   checked against the output schema: a misfit goes back to it, the third fails the call.
//! - Stop on the caller stops the callee's turn for the call; Stop on the callee stops the call.
//!
//! Calls to bots of other machines ride on the outbox and inbox of ADR 0132
//! (`contracts_remote.rs`).

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use spade_core::Event;
use spade_core::contract::{self, Called, Ending, Outcome, Request};
use spade_core::event::{FromAgent, Known};
use spade_core::package::contract::Contract;
use spade_store::{Agent, StoreError};
use tokio::sync::broadcast::error::RecvError;

use super::Engine;
use super::bots::MOST_HOPS;
use crate::tools::ToolOutput;

/// The setting that turns a bot's incoming calls off (absent: it takes them).
fn incoming_off_key(bot: &str) -> String {
    format!("contracts_incoming_off:{bot}")
}

/// The id of the call made by the job of `key` (`<conversation>.<job>`): unique across
/// conversations and the same each time the job runs, so it is the call's idempotency key.
pub(crate) fn call_id(key: &str) -> String {
    let safe: String = key
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("cc.{safe}")
}

/// A contract as `contracts_find` lists it.
fn listed(bot: &Value, machine: Option<&str>, contract: &Contract) -> Value {
    json!({
        "bot": bot["name"],
        "bot_id": bot["id"],
        "machine": machine,
        "contract": contract.name,
        "summary": contract.summary,
        "input": contract.input,
        "output": contract.output,
        "effects": contract.effects.iter().map(|e| e.name()).collect::<Vec<_>>(),
    })
}

/// Whether a listed contract answers `need` (any of its words, in its name, summary or bot).
fn answers(entry: &Value, need: &[String]) -> bool {
    if need.is_empty() {
        return true;
    }
    let text = format!(
        "{} {} {}",
        entry["contract"].as_str().unwrap_or_default().replace('_', " "),
        entry["summary"].as_str().unwrap_or_default(),
        entry["bot"].as_str().unwrap_or_default()
    )
    .to_lowercase();
    need.iter().any(|word| text.contains(word.as_str()))
}

/// What the caller is told when a call can't start.
fn refused(why: impl Into<String>) -> ToolOutput {
    ToolOutput::error(why.into())
}

impl Engine {
    /// The contracts bot `agent`'s package publishes now.
    pub(crate) fn contracts_of(&self, agent: &str) -> Vec<Contract> {
        self.bot_package(agent)
            .map(|link| link.manifest.contracts)
            .unwrap_or_default()
    }

    /// Whether bot `agent` takes calls: the person can turn them off per bot.
    pub fn takes_calls(&self, agent: &str) -> bool {
        !matches!(self.store.setting(&incoming_off_key(agent)), Ok(Some(_)))
    }

    pub fn set_takes_calls(&self, agent: &str, on: bool) -> Result<(), StoreError> {
        self.store
            .set_setting(&incoming_off_key(agent), (!on).then_some("off"))
    }

    /// This machine's contracts open to `caller` (`""` for another machine), as listed.
    pub(super) fn offered(&self, caller: &str) -> Vec<Value> {
        let bots = self.bots_for(caller).unwrap_or_default();
        bots.iter()
            .filter(|bot| self.takes_calls(&bot.id))
            .flat_map(|bot| {
                let shown = json!({ "id": bot.id, "name": bot.name });
                self.contracts_of(&bot.id)
                    .into_iter()
                    .map(move |c| listed(&shown, None, &c))
            })
            .collect()
    }

    /// `contracts_find {need?}` for the agent of `caller`.
    pub(crate) async fn contracts_find(&self, caller: &str, arguments: &Value) -> ToolOutput {
        let need: Vec<String> = arguments["need"]
            .as_str()
            .unwrap_or_default()
            .to_lowercase()
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| w.len() > 2)
            .map(str::to_owned)
            .collect();
        let mut found = self.offered(caller);
        found.extend(self.remote_contracts().await);
        found.retain(|entry| answers(entry, &need));
        if found.is_empty() {
            return ToolOutput::ok(if need.is_empty() {
                "None of the person's bots offers a contract."
            } else {
                "None of the person's bots offers a contract for that."
            });
        }
        ToolOutput::ok(Value::Array(found).to_string())
    }

    /// `contract_call {bot, contract, input, machine?}`, run as the job of `key`: delivers the call
    /// once and waits for its end.
    pub(crate) async fn contract_call(
        self: &Arc<Self>,
        caller: &str,
        key: &str,
        arguments: Value,
    ) -> ToolOutput {
        let text = |field: &str| {
            arguments[field]
                .as_str()
                .map(str::trim)
                .unwrap_or_default()
                .to_owned()
        };
        let (bot, name) = (text("bot"), text("contract"));
        let input = arguments.get("input").cloned().unwrap_or(Value::Null);
        let Ok(Some(me)) = self.store.agent_for_conversation(caller) else {
            return refused("Only a bot can call a contract.");
        };
        let depth = self.hops(caller) + 1;
        if depth > MOST_HOPS {
            return refused(format!(
                "Refused: this would be a chain of more than {MOST_HOPS} calls between bots. \
                 Answer with what you have."
            ));
        }
        let job = key.split_once('.').map_or(key, |(_, job)| job).to_owned();
        let call = call_id(key);
        let machine = text("machine");
        if !machine.is_empty() {
            let asked = super::contracts_remote::Asked {
                me: &me,
                job: &job,
                call: &call,
                bot: &bot,
                contract: &name,
                input: &input,
                depth,
            };
            return self.contract_call_elsewhere(caller, &machine, asked).await;
        }
        let target = match self.find_bot(caller, &bot) {
            Ok(target) => target,
            Err(why) => return refused(why),
        };
        if !self.takes_calls(&target.id) {
            return refused(format!(
                "{} takes no calls: the person turned them off.",
                target.name
            ));
        }
        let Some(contract) = self
            .contracts_of(&target.id)
            .into_iter()
            .find(|c| c.name == name)
        else {
            return refused(format!(
                "{} has no contract {name:?}; contracts_find lists what it offers.",
                target.name
            ));
        };
        if let Some(problems) = contract.misfit_input(&input) {
            return refused(format!(
                "The input doesn't fit {name}:\n- {}",
                problems.join("\n- ")
            ));
        }
        let called = Called {
            job,
            call: call.clone(),
            bot: target.id.clone(),
            name: target.name.clone(),
            machine: None,
            machine_name: None,
            contract: name.clone(),
        };
        if let Err(error) = self.note_called(caller, called) {
            return refused(format!("The call was not stored: {error}"));
        }
        let request = Request {
            call: call.clone(),
            contract: name.clone(),
            input,
            effects: contract.effects.clone(),
        };
        let from = FromAgent {
            id: me.id.clone(),
            name: me.name.clone(),
            depth,
            machine: None,
            contract: Some(Box::new(request)),
        };
        // Subscribed first, so its end can't slip by between delivering and listening.
        let frames = self.live(&target.conversation).frames.subscribe();
        if let Err(error) = self.deliver(&target.conversation, &call_message(from)) {
            return refused(format!("The call was not delivered: {error}"));
        }
        let outcome = self.wait_call(&target, &call, frames).await;
        finished(&call, &target.name, &contract, outcome)
    }

    /// Stores `contract_called` in the caller's conversation, once per call.
    pub(super) fn note_called(&self, caller: &str, called: Called) -> Result<(), StoreError> {
        let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
        let events = self.load(caller)?;
        if contract::called_by(&events, &called.job).is_some() {
            return Ok(());
        }
        self.append(caller, &Event::Known(Known::ContractCalled(Box::new(called))))?;
        Ok(())
    }

    /// Waits until call `call` to `target` ends. `frames` was subscribed before it was
    /// delivered, so nothing slips by; only what was stored since the delivery is read.
    async fn wait_call(
        &self,
        target: &Agent,
        call: &str,
        mut frames: tokio::sync::broadcast::Receiver<super::Frame>,
    ) -> Outcome {
        let mut from: Option<i64> = None;
        loop {
            if self.store.agent(&target.id).ok().flatten().is_none() {
                return Outcome::Failed {
                    problems: vec![format!("{} was deleted before it answered.", target.name)],
                };
            }
            if let Some(outcome) = self.call_outcome(&target.conversation, call, &mut from) {
                return outcome;
            }
            match tokio::time::timeout(Duration::from_secs(1), frames.recv()).await {
                Ok(Ok(_)) | Ok(Err(RecvError::Lagged(_))) | Err(_) => {}
                Ok(Err(RecvError::Closed)) => {
                    frames = self.live(&target.conversation).frames.subscribe();
                }
            }
        }
    }

    /// How call `call` in `conversation` ended, if it did. `from` keeps where it was delivered,
    /// so each read after the first takes only the events since.
    pub(super) fn call_outcome(
        &self,
        conversation: &str,
        call: &str,
        from: &mut Option<i64>,
    ) -> Option<Outcome> {
        if from.is_none() {
            let stored = self.store.events(conversation, 0).ok()?;
            *from = stored
                .iter()
                .find(|s| contract::request_of(&s.event).is_some_and(|r| r.call == call))
                .map(|s| s.seq - 1);
        }
        let after = (*from)?;
        let stored = self.store.events(conversation, after).ok()?;
        let events: Vec<Event> = stored.into_iter().map(|s| s.event).collect();
        contract::ended(&events, call)
    }

    /// `contract_return {call, output}` from the agent of `conversation`.
    pub(crate) fn contract_return(&self, conversation: &str, arguments: &Value) -> ToolOutput {
        let call = arguments["call"].as_str().unwrap_or_default().trim();
        let output = arguments.get("output").cloned().unwrap_or(Value::Null);
        let agent = self.agent_of(conversation);
        let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
        let Ok(events) = self.load(conversation) else {
            return ToolOutput::error("The conversation could not be read.");
        };
        let Some(at) = contract::delivered_at(&events, call) else {
            return ToolOutput::error(format!(
                "There is no call {call:?} to this bot; the call's id is in its <contract_call>."
            ));
        };
        if contract::ended(&events, call).is_some() {
            return ToolOutput::error("That call already ended; nothing was sent.");
        }
        let Some(request) = contract::request_of(&events[at]) else {
            return ToolOutput::error("That call can't be read.");
        };
        let found = agent
            .as_deref()
            .map(|bot| self.contracts_of(bot))
            .unwrap_or_default()
            .into_iter()
            .find(|c| c.name == request.contract);
        let problems = match &found {
            Some(contract) => contract.misfit_output(&output),
            None => Some(vec![format!(
                "this bot no longer offers {}",
                request.contract
            )]),
        };
        let record = |event: Event| self.append(conversation, &event).map(|_| ());
        if let Some(problems) = problems {
            let tries = contract::misfits(&events, call) + 1;
            let misfit = Event::Known(Known::ContractMisfit {
                call: call.to_owned(),
                problems: problems.clone(),
            });
            if let Err(error) = record(misfit) {
                return ToolOutput::error(format!("Not sent: {error}"));
            }
            let lines = problems.join("\n- ");
            if tries >= contract::MOST_MISFITS {
                let ended = Event::Known(Known::ContractEnded {
                    call: call.to_owned(),
                    ending: Ending::Failed { problems },
                });
                if let Err(error) = record(ended) {
                    return ToolOutput::error(format!("Not sent: {error}"));
                }
                return ToolOutput::error(format!(
                    "The output still doesn't fit, so the call failed and the caller was told:\n- {lines}"
                ));
            }
            let left = contract::MOST_MISFITS - tries;
            return ToolOutput::error(format!(
                "The output doesn't fit the contract's output schema; fix it and return again \
                 ({left} more {}):\n- {lines}",
                if left == 1 { "try" } else { "tries" }
            ));
        }
        // What the callee read during the call (not the call itself) decides whether the caller
        // treats the output as untrusted, as a helper's result is (ADR 0152 §6).
        let registry = self.registry_for(conversation);
        let untrusted = events[at + 1..]
            .iter()
            .any(|event| spade_core::context::untrusted_event(event, &registry));
        let ended = Event::Known(Known::ContractEnded {
            call: call.to_owned(),
            ending: Ending::Returned { output, untrusted },
        });
        match record(ended) {
            Ok(()) => ToolOutput::ok("Returned. The caller has the answer."),
            Err(error) => ToolOutput::error(format!("Not sent: {error}")),
        }
    }

    /// Stop on a caller (ADR 0200 §7): each contract call among `jobs` stops the callee's turn
    /// for it, here or on its machine. Nothing happens for a call that already ended.
    pub(super) fn stop_calls(self: &Arc<Self>, id: &str, jobs: &[String]) {
        let Ok(events) = self.load(id) else { return };
        for called in contract::calling(events.iter(), jobs) {
            match &called.machine {
                Some(_) => {
                    if let Err(error) = self.stop_remote(&called.call) {
                        tracing::warn!(%error, "could not stop a contract call on its machine");
                    }
                }
                None => self.stop_callee(&called.bot, &called.call),
            }
        }
    }

    /// Stops callee `bot`'s turn for call `call`, while the call is open.
    pub(super) fn stop_callee(self: &Arc<Self>, bot: &str, call: &str) {
        let Ok(Some(callee)) = self.store.agent(bot) else {
            return;
        };
        let Ok(events) = self.load(&callee.conversation) else {
            return;
        };
        let open = contract::open(&events).iter().any(|r| r.call == call);
        if open && let Err(error) = self.stop(&callee.conversation) {
            tracing::warn!(%error, "could not stop a callee's turn");
        }
    }

    /// The ceilings an open contract call holds `conversation` to: the contract's effects for
    /// each call open in it, refused in the contract's name.
    pub(crate) fn call_ceilings(&self, conversation: &str) -> Vec<(String, Vec<spade_core::effect::Effect>)> {
        let Ok(events) = self.load(conversation) else {
            return Vec::new();
        };
        contract::open(&events)
            .into_iter()
            .map(|request| {
                (
                    format!("The {} call", request.contract),
                    request.effects.clone(),
                )
            })
            .collect()
    }

}

/// The message that delivers a call: from the calling bot, its input as the text clients show.
pub(super) fn call_message(from: FromAgent) -> Event {
    let text = from
        .contract
        .as_ref()
        .map(|r| format!("{}: {}", r.contract, r.input))
        .unwrap_or_default();
    Event::Known(Known::UserMessage {
        text,
        context: None,
        images: Vec::new(),
        documents: Vec::new(),
        voice: None,
        from_agent: Some(from),
        from_routine: None,
        from_group: None,
        from_thread: None,
    })
}

/// The job's answer once a call ended: its `<contract_result>`, an error unless it returned, and
/// untrusted when the callee read anything untrusted. The output is checked against the schema
/// on this side too.
pub(super) fn finished(call: &str, bot: &str, contract: &Contract, outcome: Outcome) -> ToolOutput {
    let outcome = match outcome {
        Outcome::Returned { output, untrusted } => match contract.misfit_output(&output) {
            Some(problems) => Outcome::Failed { problems },
            None => Outcome::Returned { output, untrusted },
        },
        other => other,
    };
    let text = contract::result_text(call, bot, &contract.name, &outcome);
    match outcome {
        Outcome::Returned { untrusted, .. } => {
            let mut output = ToolOutput::ok(text);
            output.untrusted = untrusted;
            output
        }
        _ => ToolOutput::error(text),
    }
}
