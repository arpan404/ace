//! Contract calls from the person's own agents outside Spade (ADR 0202 §3, §6): an MCP or A2A
//! client holding one of ace's grants with `spade-contracts`, as ace's daemon vouches for it on
//! each request. A call runs exactly as a bot's call does: delivered once by its key under the
//! callee's record lock, framed as that client's request (never the person's words), under the
//! callee's own gate and ceiling and held to the contract's effects, answered with
//! `contract_return` checked against the output schema, untrusted when the callee read anything
//! untrusted, and stopped by the caller's Stop. Nothing here is offered to other people's agents.
//!
//! - A caller's Stop reaches its own call only (`Engine::stop_call`): the callee's turn stops
//!   when it serves that call alone, else the call ends alone and the turn carries on.
//! - Each call's (grant, key) record (its inbox row, and its outcome once it ended) outlives the
//!   inbox's cleanup until long after it ended, so its task, its Stop and a retry of its key
//!   keep finding it, and the retry never delivers again.
//! - Reading a call reads from where it was delivered, and its outcome once stored: the work is
//!   the call's, never the callee's history. Waits are capped (`outside_admit`).

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use sha2::{Digest, Sha256};
use spade_core::contract::{Ending, Outcome, Request};
use spade_core::event::FromAgent;
use spade_core::package::contract::Contract;
use spade_core::package::link::PackageId;
use spade_store::{Delivered, Delivery, InboxEntry};

use super::Engine;
use super::contracts::call_message;
use super::outside_admit::WaitSlot;

/// The sender an outside client's calls are stored under, its grant's id after it. No paired
/// machine's device id and no thread ask looks like it, so none can read or stop another's.
pub const FROM_OUTSIDE: &str = spade_store::OUTSIDE_HOSTS;
const DAY_MS: i64 = 24 * 60 * 60_000;
/// How long a call's record stays after it ended: a retry of its key is never that late.
const KEEP_ENDED_MS: i64 = 30 * DAY_MS;
/// The longest one wait for a call's end lasts; a caller waiting longer asks again.
pub const LONGEST_WAIT: Duration = Duration::from_secs(25);

/// How an outside client reached Spade.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Via {
    Mcp,
    A2a,
}

impl Via {
    pub fn name(self) -> &'static str {
        match self {
            Self::Mcp => "mcp",
            Self::A2a => "a2a",
        }
    }
}

/// One of the person's own agents outside Spade, as ace's daemon stamped it from its grant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutsideCaller {
    /// The ace grant it holds (ADR 0122).
    pub grant: String,
    /// The client's name on that grant, as the person approved it.
    pub name: String,
}

impl OutsideCaller {
    fn host(&self) -> String {
        format!("{FROM_OUTSIDE}{}", self.grant)
    }

    /// The id of this caller's call with idempotency key `key`: the same key always names the
    /// same call, and two callers' keys never meet in a callee's conversation.
    pub fn call_id(&self, key: &str) -> String {
        let digest = Sha256::digest(format!("{}\n{key}", self.grant).as_bytes());
        let hex: String = digest[..12].iter().map(|b| format!("{b:02x}")).collect();
        format!("cc.outside.{hex}")
    }
}

/// A contract outside callers are offered.
#[derive(Debug, Clone)]
pub struct Offered {
    /// Its name as a tool and as an A2A skill: `<bot slug>__<contract>`.
    pub tool: String,
    pub bot_id: String,
    pub bot: String,
    pub contract: Contract,
    /// The package version the bot runs.
    pub package: PackageId,
}

/// Why an outside call didn't start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refused {
    /// No contract is offered under that name.
    NoSuchTool,
    /// It is offered, and this call can't run: the input doesn't fit, calls are off, too many.
    Problem(String),
}

/// Where an outside call stands.
#[derive(Debug, Clone, PartialEq)]
pub enum CallState {
    /// This caller never made it.
    Unknown,
    /// Still running; `waiting` while its callee waits on the person.
    Open {
        waiting: bool,
    },
    Ended(Outcome),
}

impl Engine {
    /// Every contract outside callers are offered: those of each of the person's bots that
    /// take calls, each under a tool name no other takes.
    pub fn outside_offered(&self) -> Vec<Offered> {
        let mut taken = HashSet::new();
        let mut offered = Vec::new();
        for bot in self.bots_for("").unwrap_or_default() {
            if !self.takes_calls(&bot.id) {
                continue;
            }
            let Some(link) = self.bot_package(&bot.id) else {
                continue;
            };
            for contract in link.manifest.contracts {
                let mut tool = spade_mcp::serve::tool_name(&bot.name, &contract.name);
                if !taken.insert(tool.clone()) {
                    // Two bots with one name: the later is told apart by its id.
                    let short: String = bot.id.chars().take(8).collect();
                    tool = spade_mcp::serve::tool_name(
                        &format!("{} {short}", bot.name),
                        &contract.name,
                    );
                    taken.insert(tool.clone());
                }
                offered.push(Offered {
                    tool,
                    bot_id: bot.id.clone(),
                    bot: bot.name.clone(),
                    contract,
                    package: link.package.clone(),
                });
            }
        }
        offered
    }

    /// Delivers `caller`'s call to the contract offered as `tool`, once by `key`: the same key
    /// again finds the call it made, whatever it names. Answers the call's id.
    pub fn outside_call(
        self: &Arc<Self>,
        caller: &OutsideCaller,
        via: Via,
        key: &str,
        tool: &str,
        input: Value,
    ) -> Result<String, Refused> {
        let call = caller.call_id(key);
        let host = caller.host();
        let _ = self.store.prune_outside(self.now_ms() - KEEP_ENDED_MS);
        // The key's record, whatever the tool names now: a retry never delivers again.
        if self.store.inbox(&host, &call).ok().flatten().is_some() {
            return Ok(call);
        }
        let Some(offered) = self.outside_offered().into_iter().find(|o| o.tool == tool) else {
            return Err(Refused::NoSuchTool);
        };
        let agent = match self.store.agent(&offered.bot_id) {
            Ok(Some(agent)) => agent,
            _ => return Err(Refused::NoSuchTool),
        };
        let contract = self
            .callable(&agent, &offered.contract.name, &input)
            .map_err(Refused::Problem)?;
        let name: String = caller.name.chars().take(super::NAME_CHARS).collect();
        let from = FromAgent {
            id: format!("outside:{}", caller.grant),
            name: if name.trim().is_empty() {
                "An outside agent".to_owned()
            } else {
                name
            },
            depth: 1,
            machine: None,
            contract: Some(Box::new(Request {
                call: call.clone(),
                contract: contract.name.clone(),
                input,
                effects: contract.effects.clone(),
                outside: Some(via.name().to_owned()),
            })),
        };
        let entry = InboxEntry {
            from_host: host,
            key: call.clone(),
            from_name: caller.name.clone(),
            agent_id: agent.id.clone(),
            conversation: agent.conversation.clone(),
            seq: 0,
        };
        // The day's count is checked in the transaction that stores the call.
        let delivery = Delivery {
            ask: &entry,
            since_ms: self.now_ms() - DAY_MS,
            most: self.limits.remote_asks_per_day,
        };
        match self.deliver_as(&agent.conversation, &call_message(from), Some(delivery)) {
            Ok(Delivered::Stored(_) | Delivered::Duplicate) => Ok(call),
            Ok(Delivered::OverLimit) => Err(Refused::Problem(
                "This agent made too many calls today; try again tomorrow.".to_owned(),
            )),
            Err(error) => Err(Refused::Problem(format!(
                "The call was not delivered: {error}"
            ))),
        }
    }

    /// The bot that serves `caller`'s call `call`, by name, when the call is this caller's.
    pub fn outside_callee(&self, caller: &OutsideCaller, call: &str) -> Option<String> {
        let entry = self.store.inbox(&caller.host(), call).ok().flatten()?;
        self.store
            .agent(&entry.agent_id)
            .ok()
            .flatten()
            .map(|a| a.name)
    }

    /// Where `caller`'s call `call` stands now: its stored outcome once it ended, else read from
    /// where it was delivered, so a read costs the call's own events, never the callee's
    /// history. The first outcome read is stored, and stays.
    pub fn outside_state(&self, caller: &OutsideCaller, call: &str) -> CallState {
        let host = caller.host();
        let Ok(Some(entry)) = self.store.inbox(&host, call) else {
            return CallState::Unknown;
        };
        if let Some(outcome) = self
            .store
            .outside_outcome(&host, call)
            .ok()
            .flatten()
            .and_then(|stored| outcome_of(&stored))
        {
            return CallState::Ended(outcome);
        }
        let outcome = match self.store.agent(&entry.agent_id) {
            Ok(Some(agent)) => {
                let mut from = Some(entry.seq - 1);
                match self.call_outcome(&agent.conversation, call, &mut from) {
                    Some(outcome) => outcome,
                    None => {
                        return CallState::Open {
                            waiting: self.callee_waiting(&agent.conversation),
                        };
                    }
                }
            }
            Ok(None) => Outcome::Failed {
                problems: vec!["The bot was deleted before it answered.".to_owned()],
            },
            Err(_) => return CallState::Open { waiting: false },
        };
        let stored = self
            .store
            .end_outside(&host, call, &stored_outcome(&outcome), self.now_ms())
            .ok()
            .and_then(|stored| outcome_of(&stored));
        CallState::Ended(stored.unwrap_or(outcome))
    }

    /// A slot for one request of `caller` to wait on its call, or `None` when it, or all outside
    /// callers together, wait on as many as allowed (`outside_admit`).
    pub fn outside_wait_slot(&self, caller: &OutsideCaller) -> Option<WaitSlot<'_>> {
        self.outside.wait_slot(&caller.grant)
    }

    /// Waits up to `wait` for `caller`'s call `call` to end, or for its callee's waiting on the
    /// person to differ from `waiting`, and says where it stands then.
    pub async fn outside_wait(
        &self,
        caller: &OutsideCaller,
        call: &str,
        wait: Duration,
        waiting: bool,
    ) -> CallState {
        let Ok(Some(entry)) = self.store.inbox(&caller.host(), call) else {
            return CallState::Unknown;
        };
        let mut frames = self.live(&entry.conversation).frames.subscribe();
        let until = tokio::time::Instant::now() + wait.min(LONGEST_WAIT);
        loop {
            let state = self.outside_state(caller, call);
            let left = until.saturating_duration_since(tokio::time::Instant::now());
            match &state {
                CallState::Open { waiting: now } if *now == waiting && !left.is_zero() => {}
                _ => return state,
            }
            let _ = tokio::time::timeout(left.min(Duration::from_secs(1)), frames.recv()).await;
        }
    }

    /// The caller's Stop: stops the callee's turn for `caller`'s call `call` while it is open.
    /// False when this caller never made it.
    pub fn outside_stop(self: &Arc<Self>, caller: &OutsideCaller, call: &str) -> bool {
        let Ok(Some(entry)) = self.store.inbox(&caller.host(), call) else {
            return false;
        };
        self.stop_callee(&entry.agent_id, call);
        true
    }

    /// A fresh idempotency key, for a call whose caller gave none.
    pub fn outside_fresh_key(&self) -> String {
        self.ids.next("key")
    }

    /// Claims MCP request `request` (its JSON-RPC id, as JSON) of grant `grant` for call `call`,
    /// so a legacy client's `notifications/cancelled` for that request finds it. False when
    /// that id is in flight already.
    pub fn outside_request_started(&self, grant: &str, request: &Value, call: &str) -> bool {
        self.outside.claim_request(grant, request, call)
    }

    /// The request ended; it no longer names a call.
    pub fn outside_request_ended(&self, grant: &str, request: &Value) {
        self.outside.release_request(grant, request);
    }

    /// The call MCP request `request` of grant `grant` is making, while it runs.
    pub fn outside_request_call(&self, grant: &str, request: &Value) -> Option<String> {
        self.outside.request_call(grant, request)
    }

    /// Takes the nonce of a stamp ace signed at `time`, once within `window_ms` of it.
    pub fn outside_take_nonce(&self, nonce: &str, time: i64, window_ms: i64) -> bool {
        self.outside
            .take_nonce(nonce, time, self.now_ms(), window_ms)
    }
}

/// A call's outcome as its record keeps it.
fn stored_outcome(outcome: &Outcome) -> String {
    let ending = match outcome.clone() {
        Outcome::Returned { output, untrusted } => Ending::Returned { output, untrusted },
        Outcome::Failed { problems } => Ending::Failed { problems },
        Outcome::Stopped { why } => Ending::Stopped { why },
    };
    serde_json::to_string(&ending).unwrap_or_default()
}

/// The outcome a record keeps; `None` for one this build can't read.
fn outcome_of(stored: &str) -> Option<Outcome> {
    Some(match serde_json::from_str::<Ending>(stored).ok()? {
        Ending::Returned { output, untrusted } => Outcome::Returned { output, untrusted },
        Ending::Failed { problems } => Outcome::Failed { problems },
        Ending::Stopped { why } => Outcome::Stopped { why },
    })
}
