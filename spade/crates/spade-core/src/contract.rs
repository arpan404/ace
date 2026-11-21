//! Typed calls between the person's bots (ADR 0200 §7, spade/docs/contracts.md): what a call is
//! in each conversation, and the folds that say whether one is open and how it ended. Pure: the
//! engine brings the events and stores what this decides.
//!
//! - The caller's `contract_call` is a background job keyed by its call id, the idempotency key:
//!   run again after a restart, it finds the call it already made.
//! - In the callee's conversation the call is a message from the calling bot (`from_agent`, with
//!   its [`Request`]), never the person's words. While it is open the callee's calls are held to
//!   the contract's effects, inside its package's ceiling ([`open`]).
//! - The callee answers with `contract_return`. Output that doesn't fit is a [`Known::ContractMisfit`]
//!   and goes back to it with the problems; the third misfit ends the call as failed. A fitting
//!   output ends it as returned ([`Known::ContractEnded`]). A turn that ends first ends the call:
//!   stopped when it was stopped, failed otherwise ([`ended`]).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::effect::Effect;
use crate::event::{Event, Known};

/// The tools (`spade.v1`'s `agents` module).
pub const CONTRACTS_FIND: &str = "contracts_find";
pub const CONTRACT_CALL: &str = "contract_call";
pub const CONTRACT_RETURN: &str = "contract_return";

/// How many outputs that don't fit a call takes before it fails: the first and two more.
pub const MOST_MISFITS: usize = 3;

/// A call, as the callee's conversation holds it on the message that delivered it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Request {
    /// The caller's idempotency key, the call's id on both sides.
    pub call: String,
    pub contract: String,
    pub input: Value,
    /// The effects its turn may use, from the contract as the callee's package had it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub effects: Vec<Effect>,
    /// Set when one of the person's own agents outside Spade made the call (ADR 0202 §3, §6):
    /// how it came, `mcp` or `a2a`. The caller is then that client, as its ace grant names it,
    /// never a bot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outside: Option<String>,
}

/// A call this bot made, as its own conversation holds it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Called {
    /// The `contract_call` job that carries it.
    pub job: String,
    pub call: String,
    /// The callee's id, and its name as it was then.
    pub bot: String,
    pub name: String,
    /// The callee's machine, by its host id and name, when it is another machine (ADR 0132).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine_name: Option<String>,
    pub contract: String,
}

/// The calls a conversation made whose job still runs, given its running jobs.
pub fn calling<'a>(
    events: impl IntoIterator<Item = &'a Event>,
    running: &[String],
) -> Vec<&'a Called> {
    events
        .into_iter()
        .filter_map(|event| match event {
            Event::Known(Known::ContractCalled(called)) if running.contains(&called.job) => {
                Some(&**called)
            }
            _ => None,
        })
        .collect()
}

/// The call job `job` made, if it made one.
pub fn called_by<'a>(events: &'a [Event], job: &str) -> Option<&'a Called> {
    events.iter().find_map(|event| match event {
        Event::Known(Known::ContractCalled(called)) if called.job == job => Some(&**called),
        _ => None,
    })
}

/// A caller's state with its calls open (ADR 0200 §6.2): working while any is, and waiting while
/// a callee waits on the person, as an ace child's caller does. Never done meanwhile.
pub fn caller_state(
    own: crate::running::State,
    callees: impl IntoIterator<Item = crate::running::State>,
) -> crate::running::State {
    use crate::running::{State, rolled};
    callees.into_iter().fold(own, |state, callee| {
        let under = if callee == State::Waiting {
            State::Waiting
        } else {
            State::Working
        };
        rolled(state, under)
    })
}

/// How a call ended, as the callee stored it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Ending {
    /// Its output fit. `untrusted`: the callee read something untrusted during the call, so the
    /// caller treats the output as it would a page's text (ADR 0152 §6).
    Returned { output: Value, untrusted: bool },
    /// It never fit, or the callee couldn't answer.
    Failed { problems: Vec<String> },
    /// Its caller stopped it while the callee's turn also served others, so that turn carries
    /// on for them and this call alone ends ([`stop_reach`]).
    Stopped { why: String },
}

/// How a call came out, read from the callee's events.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Returned { output: Value, untrusted: bool },
    Failed { problems: Vec<String> },
    Stopped { why: String },
}

impl Outcome {
    pub fn status(&self) -> &'static str {
        match self {
            Self::Returned { .. } => "returned",
            Self::Failed { .. } => "failed",
            Self::Stopped { .. } => "stopped",
        }
    }
}

/// The call a stored event delivered, if it delivered one.
pub fn request_of(event: &Event) -> Option<&Request> {
    match event {
        Event::Known(Known::UserMessage {
            from_agent: Some(from),
            ..
        }) => from.contract.as_deref(),
        _ => None,
    }
}

/// A reply's end that ends the calls it took up. A restart's interruption doesn't: the call stays
/// open and a new reply carries on with it, so a restart of the callee never loses it.
fn reply_end(event: &Event) -> bool {
    matches!(
        event,
        Event::Known(
            Known::ReplyFinished { .. } | Known::ReplyStopped { .. } | Known::ReplyFailed { .. }
        )
    )
}

fn ending_of<'a>(event: &'a Event, call: &str) -> Option<&'a Ending> {
    match event {
        Event::Known(Known::ContractEnded { call: c, ending }) if c == call => Some(ending),
        _ => None,
    }
}

/// The calls open in a conversation now: delivered, not ended, and no reply has ended since (a
/// restart's interruption isn't an end). Read
/// back from the end to the latest reply's end, so it costs the open turn's events, not history.
pub fn open(events: &[Event]) -> Vec<&Request> {
    let mut ended: Vec<&str> = Vec::new();
    let mut open = Vec::new();
    for event in events.iter().rev() {
        if reply_end(event) {
            break;
        }
        if let Event::Known(Known::ContractEnded { call, .. }) = event {
            ended.push(call);
        }
        if let Some(request) = request_of(event)
            && !ended.contains(&request.call.as_str())
        {
            open.push(request);
        }
    }
    open
}

/// A contract call's hold on what a turn may use: the contract, and the effects it allows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Scope {
    pub contract: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub effects: Vec<Effect>,
}

impl From<&Request> for Scope {
    fn from(request: &Request) -> Self {
        Self {
            contract: request.contract.clone(),
            effects: request.effects.clone(),
        }
    }
}

/// The calls whose effects hold a conversation now: each delivered since the latest reply's end
/// (a restart's interruption isn't one), returned or not. A call holds the reply that serves it
/// until that reply ends, so a tool later in the same reply can't use an effect the contract
/// left out. Read back to the latest reply's end, so it costs the open turn's events.
pub fn scoped(events: &[Event]) -> Vec<&Request> {
    events
        .iter()
        .rev()
        .take_while(|event| !reply_end(event))
        .filter_map(request_of)
        .collect()
}

/// The calls that held reply `reply` while it ran: each delivered before it started, with no
/// reply's end between, or during it (a restart's interruption carries it on in a new reply). A
/// helper the reply started stays held to them for as long as it lives. Read back from the end to
/// that reply, so it costs the events since the reply began, not history.
pub fn scoped_by_reply<'a>(events: &'a [Event], reply: &str) -> Vec<&'a Request> {
    let started = |event: &Event| matches!(event, Event::Known(Known::ReplyStarted { reply: r, .. }) if r == reply);
    let Some(start) = events.iter().rposition(started) else {
        return Vec::new();
    };
    let from = events[..start]
        .iter()
        .rposition(reply_end)
        .map_or(0, |at| at + 1);
    let to = events[start..]
        .iter()
        .position(reply_end)
        .map_or(events.len(), |at| start + at);
    let mut held: Vec<&Request> = Vec::new();
    for request in events[from..to].iter().filter_map(request_of) {
        if !held.iter().any(|h| h.call == request.call) {
            held.push(request);
        }
    }
    held
}

/// What a Stop on call `call` may reach in its callee's conversation, given the jobs running
/// there. A caller owns its call, never the callee's turn: the turn stops only when it serves
/// that call alone, so one caller (an outside grant, another bot) can't stop work it doesn't own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StopReach {
    /// The call isn't open: nothing to stop.
    Ended,
    /// The open turn serves this call and nothing else: stop reply `reply` and the jobs it
    /// started (`jobs`), and nothing older the conversation runs.
    Reply { reply: String, jobs: Vec<String> },
    /// The turn serves others too, or none has taken the call up: end this call alone.
    Call,
}

/// [`StopReach`] for call `call`, `running` the conversation's running jobs. Read back to the
/// latest reply's end (a restart's interruption isn't one), so it costs the open turn's events.
pub fn stop_reach(events: &[Event], call: &str, running: &[String]) -> StopReach {
    if !open(events).iter().any(|r| r.call == call) {
        return StopReach::Ended;
    }
    let from = events.iter().rposition(reply_end).map_or(0, |at| at + 1);
    let turn = &events[from..];
    let replies: Vec<&str> = turn
        .iter()
        .filter_map(|event| match event {
            Event::Known(Known::ReplyStarted { reply, .. }) => Some(reply.as_str()),
            _ => None,
        })
        .collect();
    let Some(reply) = replies.last() else {
        return StopReach::Call;
    };
    // Anyone's words in the turn but this call's (the person's, another call's) are work this
    // caller doesn't own.
    let alone = turn.iter().all(|event| match event {
        Event::Known(Known::UserMessage { .. }) => {
            request_of(event).is_some_and(|r| r.call == call)
        }
        _ => true,
    });
    if !alone {
        return StopReach::Call;
    }
    let jobs = turn
        .iter()
        .filter_map(|event| match event {
            Event::Known(Known::JobStarted { reply, job, .. })
                if replies.contains(&reply.as_str()) && running.contains(job) =>
            {
                Some(job.clone())
            }
            _ => None,
        })
        .collect();
    StopReach::Reply {
        reply: (*reply).to_owned(),
        jobs,
    }
}

/// Where the call `call` was delivered, if it was.
pub fn delivered_at(events: &[Event], call: &str) -> Option<usize> {
    events
        .iter()
        .position(|event| request_of(event).is_some_and(|r| r.call == call))
}

/// How the call `call` ended, if it did: its stored ending, else the end of the reply that took
/// it up. A turn that finished without returning fails it; a stopped one stops it; one a restart
/// interrupted leaves it open for the reply that carries on.
pub fn ended(events: &[Event], call: &str) -> Option<Outcome> {
    let at = delivered_at(events, call)?;
    for event in &events[at..] {
        if let Some(ending) = ending_of(event, call) {
            return Some(match ending {
                Ending::Returned { output, untrusted } => Outcome::Returned {
                    output: output.clone(),
                    untrusted: *untrusted,
                },
                Ending::Failed { problems } => Outcome::Failed {
                    problems: problems.clone(),
                },
                Ending::Stopped { why } => Outcome::Stopped { why: why.clone() },
            });
        }
        let failed = |why: String| {
            Some(Outcome::Failed {
                problems: vec![why],
            })
        };
        match event {
            Event::Known(Known::ReplyStopped { .. }) => {
                return Some(Outcome::Stopped {
                    why: "It was stopped before it answered.".to_owned(),
                });
            }
            Event::Known(Known::ReplyFinished { .. }) => {
                return failed("It ended its turn without returning an answer.".to_owned());
            }
            Event::Known(Known::ReplyFailed { error, .. }) => {
                return failed(format!("It couldn't answer: {error}"));
            }
            _ => {}
        }
    }
    None
}

/// Whether the output of the call delivered at `at` is untrusted: the callee had untrusted content
/// in view when the call arrived (a summary drawn from it, or an untrusted event since the last
/// compaction before the call: an earlier bot's message, a page it read), or read some during the
/// call. The call's own message isn't counted: it is the caller's words, which the caller knows.
/// `untrusted` says whether one event is (`context::untrusted_event`).
pub fn output_untrusted(events: &[Event], at: usize, untrusted: impl Fn(&Event) -> bool) -> bool {
    let before = &events[..at.min(events.len())];
    if crate::context::untrusted_summary(before) {
        return true;
    }
    let in_view = before
        .iter()
        .rev()
        .find_map(|event| match event {
            Event::Known(Known::ContextCompacted { keep_from, .. }) => Some(*keep_from),
            _ => None,
        })
        .unwrap_or(0)
        .min(before.len());
    before[in_view..].iter().any(&untrusted) || events.iter().skip(at + 1).any(&untrusted)
}

/// The outputs of `call` that didn't fit so far.
pub fn misfits(events: &[Event], call: &str) -> usize {
    events
        .iter()
        .filter(|event| {
            matches!(event, Event::Known(Known::ContractMisfit { call: c, .. }) if c == call)
        })
        .count()
}

/// How the callee reads a call: the calling bot's request, framed so it is never the person's
/// words, with how to answer it. A call from another machine names that machine, as its daemon
/// vouched for it, so it never reads as a bot of this one.
pub fn framed(request: &Request, from: &crate::event::FromAgent) -> String {
    // Each in its attribute, whatever it holds.
    let attribute = |text: &str| text.replace('"', "'");
    let (from_name, from_id) = (attribute(&from.name), attribute(&from.id));
    let machine = from
        .machine
        .as_deref()
        .map(|m| format!(" machine=\"{}\"", attribute(m)))
        .unwrap_or_default();
    let outside = request
        .outside
        .as_deref()
        .map(|via| format!(" outside=\"{}\"", attribute(via)))
        .unwrap_or_default();
    // An outside client is one of the person's agents, never the person: its words are its own.
    let who = if request.outside.is_some() {
        "This is a request from one of the person's own agents outside Spade, not the person's \
         words."
    } else {
        "This is another bot's request, not the person's."
    };
    let input = serde_json::to_string_pretty(&request.input).unwrap_or_default();
    let effects = if request.effects.is_empty() {
        "reading and your own notes and files".to_owned()
    } else {
        let words: Vec<&str> = request.effects.iter().map(|e| e.name()).collect();
        format!("reading, your own things and {}", words.join(", "))
    };
    format!(
        "<contract_call from=\"{from_name}\" id=\"{from_id}\"{machine}{outside} call=\"{call}\" contract=\"{contract}\">\n\
{input}\n</contract_call>\n\
{from_name} called your contract {contract}. {who} \
Answer it with {CONTRACT_RETURN} {{call: \"{call}\", output}}, the output in the contract's \
output schema. During this call you may use only {effects}.",
        call = request.call,
        contract = request.contract,
    )
}

/// What the caller reads when its call ends: a `<contract_result>` that opens a reply.
pub fn result_text(call: &str, bot: &str, contract: &str, outcome: &Outcome) -> String {
    let (body, untrusted) = match outcome {
        Outcome::Returned { output, untrusted } => (
            serde_json::to_string_pretty(output).unwrap_or_default(),
            *untrusted,
        ),
        Outcome::Failed { problems } => (problems.join("\n"), false),
        Outcome::Stopped { why } => (why.clone(), false),
    };
    let mut open = format!(
        "<contract_result call=\"{call}\" bot=\"{bot}\" contract=\"{contract}\" status=\"{}\"",
        outcome.status()
    );
    if untrusted {
        open.push_str(" untrusted=\"true\"");
    }
    format!("{open}>\n{body}\n</contract_result>")
}

/// A `contract_call` job's result as the caller reads it: the engine's `<contract_result>`, or a
/// stopped or lost job's words inside one.
pub fn job_text(job: &str, content: &str, is_error: bool) -> String {
    if content.starts_with("<contract_result") {
        return content.to_owned();
    }
    let status = if is_error { "failed" } else { "returned" };
    format!("<contract_result call=\"{job}\" status=\"{status}\">\n{content}\n</contract_result>")
}

#[cfg(test)]
mod tests;
