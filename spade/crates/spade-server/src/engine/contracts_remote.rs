//! Contract calls to and from the person's other machines (ADR 0200 §7 over ADR 0132's asks):
//! the caller stores the call in the outbox under its call id before sending it, and the
//! callee's machine keeps that key with the message it delivers, so a retry after a lost answer,
//! a crash or a restart on either side never delivers twice. The answer is read back by key.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use spade_core::contract::{self, Called, Outcome, Request};
use spade_core::event::FromAgent;
use spade_core::package::contract::Contract;
use spade_store::{Agent, Delivered, Delivery, InboxEntry, OutboxEntry};

use super::Engine;
use super::bots::MOST_HOPS;
use super::contracts::{call_message, finished};
use super::inbox::{InboxAnswer, Sender, short};
use crate::tools::ToolOutput;

/// The longest an answer request waits.
const LONGEST_WAIT_MS: u64 = 25_000;
const DAY_MS: i64 = 24 * 60 * 60_000;

/// A call as the caller asked for it.
pub(super) struct Asked<'a> {
    pub me: &'a Agent,
    pub job: &'a str,
    pub call: &'a str,
    pub bot: &'a str,
    pub contract: &'a str,
    pub input: &'a Value,
    pub depth: u32,
}

/// Whether an inbox key is a contract call's.
pub(super) fn is_call(key: &str) -> bool {
    key.starts_with("cc.")
}

/// Whether the callee of a call sent to another machine waits on the person for it, as that
/// machine last said (kept on the outbox entry while the call is open).
pub(super) fn waiting_of(entry: &OutboxEntry) -> bool {
    entry.state == "sent"
        && entry
            .answer
            .as_deref()
            .and_then(|a| serde_json::from_str::<Value>(a).ok())
            .is_some_and(|a| a["waiting"] == true)
}

/// The calling conversation of call `key` (`cc.<conversation>.<job>`).
fn caller_of(key: &str) -> Option<&str> {
    key.strip_prefix("cc.")?
        .split_once('.')
        .map(|(caller, _)| caller)
}

fn refuse(status: u16, error: &str) -> InboxAnswer {
    (status, json!({ "error": error }))
}

/// A listed remote contract, read back into the contract it describes.
fn contract_of(entry: &Value) -> Option<Contract> {
    Some(Contract {
        name: entry["contract"].as_str()?.to_owned(),
        summary: entry["summary"].as_str().unwrap_or_default().to_owned(),
        input: entry["input"].clone(),
        output: entry["output"].clone(),
        effects: Vec::new(),
        examples: Vec::new(),
    })
}

impl Engine {
    /// The contracts of every linked machine whose Spade answers, each named with its machine.
    pub(super) async fn remote_contracts(&self) -> Vec<Value> {
        let Ok(machines) = self.machines().await else {
            return Vec::new();
        };
        let mut found = Vec::new();
        for machine in machines.iter().filter(|m| m.online) {
            for mut entry in self
                .contracts_on(&machine.host_id)
                .await
                .unwrap_or_default()
            {
                entry["machine"] = json!(machine.name);
                found.push(entry);
            }
        }
        found
    }

    /// What machine `host`'s bots offer, as its Spade lists them.
    async fn contracts_on(&self, host: &str) -> Option<Vec<Value>> {
        let remote = self.remote()?;
        let asked = remote.call(host, json!({ "op": "contracts" }));
        let (status, body) = tokio::time::timeout(Duration::from_secs(5), asked)
            .await
            .ok()?
            .ok()?;
        (status == 200).then(|| body["contracts"].as_array().cloned().unwrap_or_default())
    }

    /// `contract_call` to a bot of another machine: stored in the outbox under the call's id, so
    /// it is delivered once and waits while that machine is away.
    pub(super) async fn contract_call_elsewhere(
        self: &Arc<Self>,
        caller: &str,
        machine: &str,
        asked: Asked<'_>,
    ) -> ToolOutput {
        let machines = match self.machines().await {
            Ok(machines) => machines,
            Err(error) => return ToolOutput::error(format!("Could not reach ace: {error}")),
        };
        let Some(target) = machines
            .iter()
            .find(|m| m.host_id == machine || m.name.eq_ignore_ascii_case(machine))
        else {
            return ToolOutput::error(format!(
                "There is no linked machine {machine:?}; contracts_find shows the machines."
            ));
        };
        // Checked here while that machine answers; its Spade checks again either way.
        let offered = self.contracts_on(&target.host_id).await;
        let mine = |e: &&Value| {
            (e["bot_id"] == asked.bot || e["bot"] == asked.bot) && e["contract"] == asked.contract
        };
        let (to, contract) = match &offered {
            Some(entries) => {
                let Some(entry) = entries.iter().find(mine) else {
                    return ToolOutput::error(format!(
                        "No bot {:?} on {} offers {:?}; contracts_find lists what they offer.",
                        asked.bot, target.name, asked.contract
                    ));
                };
                let contract = contract_of(entry);
                if let Some(problems) = contract.as_ref().and_then(|c| c.misfit_input(asked.input))
                {
                    return ToolOutput::error(format!(
                        "The input doesn't fit {}:\n- {}",
                        asked.contract,
                        problems.join("\n- ")
                    ));
                }
                (
                    entry["bot_id"].as_str().unwrap_or(asked.bot).to_owned(),
                    contract,
                )
            }
            // An id works while the machine is away; its name is learned when it answers.
            None => (asked.bot.to_owned(), None),
        };
        let name = offered
            .iter()
            .flatten()
            .find(mine)
            .and_then(|e| e["bot"].as_str())
            .unwrap_or(asked.bot)
            .to_owned();
        let called = Called {
            job: asked.job.to_owned(),
            call: asked.call.to_owned(),
            bot: to.clone(),
            name: name.clone(),
            machine: Some(target.host_id.clone()),
            machine_name: Some(target.name.clone()),
            contract: asked.contract.to_owned(),
        };
        if let Err(error) = self.note_called(caller, called) {
            return ToolOutput::error(format!("The call was not stored: {error}"));
        }
        let request = call_request(&asked, &to);
        if let Err(error) = self.send_remote(asked.call, &target.host_id, &target.name, request) {
            return ToolOutput::error(format!("The call was not stored: {error}"));
        }
        let shown = format!("{name} on {}", target.name);
        // Without the schema here (that machine was away), its Spade checked the output.
        self.remote_finished(asked.call, &shown, asked.contract, contract.as_ref())
            .await
    }

    /// Carries on with call `called` to machine `machine` after a restart: sent under its key to
    /// the bot it pinned (a key already stored keeps its first request), never resolved again.
    pub(super) async fn resume_elsewhere(
        self: &Arc<Self>,
        me: &Agent,
        called: &Called,
        machine: &str,
        input: Value,
        depth: u32,
    ) -> ToolOutput {
        let machine_name = called.machine_name.as_deref().unwrap_or(machine);
        let asked = Asked {
            me,
            job: &called.job,
            call: &called.call,
            bot: &called.bot,
            contract: &called.contract,
            input: &input,
            depth,
        };
        let request = call_request(&asked, &called.bot);
        if let Err(error) = self.send_remote(&called.call, machine, machine_name, request) {
            return ToolOutput::error(format!("The call was not stored: {error}"));
        }
        let shown = format!("{} on {machine_name}", called.name);
        self.remote_finished(&called.call, &shown, &called.contract, None)
            .await
    }

    /// Waits for the outbox entry of call `call` to end, and answers as its job.
    async fn remote_finished(
        &self,
        call: &str,
        shown: &str,
        name: &str,
        schema: Option<&Contract>,
    ) -> ToolOutput {
        let mut last: Option<OutboxEntry> = None;
        let _ = self
            .wait_remote(call, |entry| last = Some(entry.clone()))
            .await;
        finished(call, shown, name, schema, outcome_of(last.as_ref()))
    }

    /// `contracts`: what this machine's bots offer another of the person's machines.
    pub(super) fn inbox_contracts(&self) -> InboxAnswer {
        (200, json!({ "contracts": self.offered("") }))
    }

    /// `contract_call`: delivers a call from another machine once, by its key.
    pub(super) fn inbox_contract_call(
        self: &Arc<Self>,
        sender: &Sender,
        body: &Value,
    ) -> InboxAnswer {
        let key = body["key"].as_str().unwrap_or("");
        if !is_call(key) || key.len() > 160 {
            return refuse(400, "a call's key is cc. and at most 160 characters");
        }
        // Only a bot of another of the person's machines calls a contract here, through that
        // machine's Spade: never ace's own thread asks.
        if sender.host.starts_with(super::thread_asks::FROM_ACE) {
            return refuse(
                403,
                "only a bot on another machine can call a contract here",
            );
        }
        if self.store.inbox(&sender.host, key).ok().flatten().is_some() {
            return (200, json!({ "status": "duplicate" }));
        }
        let Some((from_id, from_name)) = caller_of_call(&body["from"]) else {
            return refuse(
                400,
                "a call names the bot it comes from, by its id and name",
            );
        };
        // The caller is a bot of the sending machine, which its daemon vouched for: it can't be
        // one of this machine's bots.
        if self.store.agent(&from_id).ok().flatten().is_some() {
            return refuse(
                403,
                "a call from another machine can't come from a bot of this one",
            );
        }
        let depth = body["depth"]
            .as_u64()
            .unwrap_or(1)
            .clamp(1, u64::from(MOST_HOPS) + 1) as u32;
        if depth > MOST_HOPS {
            return refuse(
                409,
                &format!("Refused: a chain of more than {MOST_HOPS} calls between bots."),
            );
        }
        let to = body["to"].as_str().unwrap_or("");
        let agent = match self.bots_for("") {
            Ok(bots) => bots.into_iter().find(|b| b.id == to),
            Err(error) => return refuse(500, &error),
        };
        // A shared bot takes calls only from its organization's bots on this host (ADR 0206).
        if let Some(agent) = &agent
            && let Some(why) = spade_core::org::crossing(
                &spade_core::org::Space::Personal,
                &self.agent_space(&agent.id),
                spade_core::org::Crossing::Contract,
            )
        {
            return refuse(403, why);
        }
        let Some(agent) = agent else {
            if let Some((host, name)) = self.moved_away(to) {
                return (
                    410,
                    json!({ "error": format!("That bot moved to {name}."), "moved_to": host, "name": name }),
                );
            }
            return refuse(404, "no such bot on this machine");
        };
        if !self.takes_calls(&agent.id) {
            return refuse(
                403,
                &format!("{} takes no calls: the person turned them off.", agent.name),
            );
        }
        let name = body["contract"].as_str().unwrap_or("");
        let Some(contract) = self
            .contracts_of(&agent.id)
            .into_iter()
            .find(|c| c.name == name)
        else {
            return refuse(404, &format!("{} has no contract {name:?}", agent.name));
        };
        let input = body.get("input").cloned().unwrap_or(Value::Null);
        if let Some(problems) = contract.misfit_input(&input) {
            return refuse(
                400,
                &format!("The input doesn't fit {name}: {}", problems.join("; ")),
            );
        }
        let from = FromAgent {
            id: from_id,
            name: from_name,
            depth,
            // Bound to the machine that sent it, as its daemon stamped and signed it.
            machine: Some(sender.name.clone()),
            contract: Some(Box::new(Request {
                call: key.to_owned(),
                contract: name.to_owned(),
                input,
                effects: contract.effects.clone(),
            })),
        };
        let entry = InboxEntry {
            from_host: sender.host.clone(),
            key: key.to_owned(),
            from_name: sender.name.clone(),
            agent_id: agent.id.clone(),
            conversation: agent.conversation.clone(),
            seq: 0,
        };
        let now = self.now_ms();
        let delivery = Delivery {
            ask: &entry,
            since_ms: now - DAY_MS,
            most: self.limits.remote_asks_per_day,
        };
        match self.deliver_as(&agent.conversation, &call_message(from), Some(delivery)) {
            Ok(Delivered::Stored(_)) => (200, json!({ "status": "accepted" })),
            Ok(Delivered::Duplicate) => (200, json!({ "status": "duplicate" })),
            Ok(Delivered::OverLimit) => refuse(
                429,
                "that machine sent too many asks today; try again tomorrow",
            ),
            Err(error) => refuse(409, &format!("not delivered: {error}")),
        }
    }

    /// Tells the caller of call `key` its state changed: its callee started or stopped waiting.
    pub(super) fn announce_caller(&self, key: &str) {
        if let Some(caller) = caller_of(key) {
            self.announce(caller);
        }
    }

    /// Whether the callee in `conversation` waits on the person while call `call` is open.
    fn call_waiting(&self, conversation: &str, call: &str) -> bool {
        let open = self
            .load(conversation)
            .is_ok_and(|events| contract::open(&events).iter().any(|r| r.call == call));
        open && self
            .activity(conversation)
            .is_ok_and(|a| a.state == super::roster::State::Waiting)
    }

    /// The calls a conversation made to other machines whose callee waits on the person now.
    pub(super) fn remote_waiting(&self, calls: &[String]) -> bool {
        calls.iter().any(|call| {
            self.store
                .outbox(call)
                .ok()
                .flatten()
                .is_some_and(|entry| waiting_of(&entry))
        })
    }

    /// `answer` for a call: how it ended, waiting up to `wait_ms` while it is open. It answers
    /// `pending` early when its callee's waiting on the person differs from what the caller
    /// last read (`waiting`), and says which it is.
    pub(super) async fn inbox_call_answer(&self, sender: &Sender, body: &Value) -> InboxAnswer {
        let key = body["key"].as_str().unwrap_or("");
        let Ok(Some(entry)) = self.store.inbox(&sender.host, key) else {
            return (200, json!({ "status": "unknown" }));
        };
        let wait = body["wait_ms"].as_u64().unwrap_or(0).min(LONGEST_WAIT_MS);
        let Ok(Some(agent)) = self.store.agent(&entry.agent_id) else {
            return (
                200,
                json!({ "status": "failed", "problems": ["The bot was deleted."], "text": "The bot was deleted." }),
            );
        };
        let known = body["waiting"].as_bool() == Some(true);
        let mut frames = self.live(&agent.conversation).frames.subscribe();
        let until = tokio::time::Instant::now() + Duration::from_millis(wait);
        let mut from = None;
        loop {
            if let Some(outcome) = self.call_outcome(&agent.conversation, key, &mut from) {
                return (200, answer_of(&outcome));
            }
            let waiting = self.call_waiting(&agent.conversation, key);
            let left = until.saturating_duration_since(tokio::time::Instant::now());
            if left.is_zero() || waiting != known {
                return (200, json!({ "status": "pending", "waiting": waiting }));
            }
            let _ = tokio::time::timeout(left.min(Duration::from_secs(1)), frames.recv()).await;
        }
    }

    /// `stop` for a call: stops the callee's turn for it, while it is open.
    pub(super) fn inbox_call_stop(self: &Arc<Self>, sender: &Sender, body: &Value) -> InboxAnswer {
        let key = body["key"].as_str().unwrap_or("");
        let Ok(Some(entry)) = self.store.inbox(&sender.host, key) else {
            return (200, json!({ "status": "unknown" }));
        };
        self.stop_callee(&entry.agent_id, key);
        (200, json!({ "status": "stopped" }))
    }
}

/// The calling bot a call names: its id and name, each one short line, or `None` when either is
/// missing.
fn caller_of_call(from: &Value) -> Option<(String, String)> {
    let line = |field: &str, most: usize| {
        let text = from.get(field)?.as_str()?.trim();
        (!text.is_empty()).then(|| short(Some(&Value::from(text)), most, ""))
    };
    Some((line("id", 128)?, line("name", crate::engine::NAME_CHARS)?))
}

/// The inbox request that delivers a call to bot `to` there.
fn call_request(asked: &Asked<'_>, to: &str) -> Value {
    json!({
        "op": "contract_call",
        "key": asked.call,
        "to": to,
        "contract": asked.contract,
        "input": asked.input,
        "from": { "id": asked.me.id, "name": asked.me.name },
        "depth": asked.depth,
    })
}

/// An ended call as the caller's machine reads it back.
fn answer_of(outcome: &Outcome) -> Value {
    match outcome {
        Outcome::Returned { output, untrusted } => {
            json!({ "status": "answered", "output": output, "untrusted": untrusted, "text": "" })
        }
        Outcome::Failed { problems } => {
            json!({ "status": "failed", "problems": problems, "text": problems.join("\n") })
        }
        Outcome::Stopped { why } => json!({ "status": "stopped", "text": why }),
    }
}

/// How a call sent to another machine ended, from its outbox entry.
fn outcome_of(entry: Option<&OutboxEntry>) -> Outcome {
    let answer: Value = entry
        .and_then(|e| e.answer.as_deref())
        .and_then(|a| serde_json::from_str(a).ok())
        .unwrap_or(Value::Null);
    let text = answer["text"].as_str().unwrap_or_default().to_owned();
    match entry.map(|e| e.state.as_str()) {
        Some("answered") => Outcome::Returned {
            output: answer["output"].clone(),
            // Another machine's word on what its bot read: untrusted unless it says otherwise.
            untrusted: answer["untrusted"].as_bool() != Some(false),
        },
        Some("stopped" | "withdrawn") => Outcome::Stopped {
            why: if text.is_empty() {
                "It was stopped before it answered.".to_owned()
            } else {
                text
            },
        },
        _ => {
            let problems: Vec<String> = answer["problems"]
                .as_array()
                .map(|p| {
                    p.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .filter(|p: &Vec<String>| !p.is_empty())
                .unwrap_or_else(|| {
                    vec![if text.is_empty() {
                        "The bot there could not answer.".to_owned()
                    } else {
                        text
                    }]
                });
            Outcome::Failed { problems }
        }
    }
}
