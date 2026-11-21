//! The MCP server the person's own agents call contracts on (ADR 0202 §3): one tool per
//! contract of each bot that takes calls. `tools/call` delivers a contract call once, by the
//! caller's key in `_meta` (a fresh one when it gave none), waits for `contract_return` and
//! answers `structuredContent`. A modern client's closed stream, or a legacy client's
//! `notifications/cancelled`, is its Stop: the callee's work for that call ends, and nobody
//! else's (`Engine::stop_call`). A request id keeps its JSON type (`7` and `"7"` are two
//! requests), and one id is in flight once per grant: a second `tools/call` with an id still
//! running is refused before anything is delivered. A call waits holding one of its grant's
//! wait slots; one beyond the cap is refused, undelivered.

use std::sync::Arc;

use serde_json::Value;
use spade_core::contract::Outcome;
use spade_mcp::serve::{self, Answer, Called, Era, Headers, Message, Method, Offer, Server};

use crate::engine::{Engine, OutsideCallState, OutsideCaller, OutsideRefused, OutsideVia};

pub const SERVER: Server<'static> = Server {
    name: "spade",
    version: env!("CARGO_PKG_VERSION"),
    instructions: "Each tool is a contract of one of the person's Spade bots: typed input, typed \
                   output. A call runs as that bot's work under its own rules, and may wait \
                   while the person decides something in ace.",
};
/// The longest caller key taken.
const LONGEST_KEY: usize = 200;

/// The tools offered now.
pub fn offers(engine: &Engine) -> Vec<Offer> {
    engine
        .outside_offered()
        .into_iter()
        .map(|o| Offer {
            title: format!("{}: {}", o.bot, o.contract.name),
            description: o.contract.summary.clone(),
            input: o.contract.input.clone(),
            output: o.contract.output.clone(),
            effects: o
                .contract
                .effects
                .iter()
                .map(|e| e.name().to_owned())
                .collect(),
            name: o.tool,
        })
        .collect()
}

/// One message posted by `caller`.
pub async fn answer(
    engine: Arc<Engine>,
    caller: OutsideCaller,
    headers: Headers<'_>,
    body: &[u8],
) -> Answer {
    let message = match serve::read(body, headers) {
        Ok(message) => message,
        Err(refused) => return refused,
    };
    match &message.method {
        Method::Discover => serve::discovered(&message, SERVER),
        Method::Initialize(asked) => serve::initialized(&message, SERVER, asked),
        Method::Ping => serve::pong(&message, SERVER),
        Method::ListTools => serve::listed(&message, SERVER, &offers(&engine)),
        Method::CallTool {
            name,
            arguments,
            key,
        } => {
            let called = call(&engine, &caller, &message, name, arguments, key.as_deref()).await;
            serve::called(&message, SERVER, &called)
        }
        Method::Cancelled(request) => {
            if let Some(call) = engine.outside_request_call(&caller.grant, request) {
                engine.outside_stop(&caller, &call);
            }
            serve::accepted()
        }
        Method::Notification => serve::accepted(),
    }
}

/// While a `tools/call` runs, from before its call is delivered: dropped when it ends or its
/// request goes away. For a modern client a request that went away was cancelled, and the
/// callee's work for an open call stops.
struct Running {
    engine: Arc<Engine>,
    caller: OutsideCaller,
    request: Value,
    call: String,
    era: Era,
}

impl Drop for Running {
    fn drop(&mut self) {
        self.engine
            .outside_request_ended(&self.caller.grant, &self.request);
        let open = matches!(
            self.engine.outside_state(&self.caller, &self.call),
            OutsideCallState::Open { .. }
        );
        if open && self.era == Era::Modern {
            self.engine.outside_stop(&self.caller, &self.call);
        }
    }
}

async fn call(
    engine: &Arc<Engine>,
    caller: &OutsideCaller,
    message: &Message,
    tool: &str,
    input: &Value,
    key: Option<&str>,
) -> Called {
    let key = match key {
        Some(key) if key.is_empty() || key.len() > LONGEST_KEY => {
            return Called::Failed(format!("A call's key is 1 to {LONGEST_KEY} characters."));
        }
        Some(key) => key.to_owned(),
        None => engine.outside_fresh_key(),
    };
    // The wait is admitted before anything is delivered.
    let Some(_slot) = engine.outside_wait_slot(caller) else {
        return Called::Failed(
            "This client has too many calls waiting; try again when one has ended.".to_owned(),
        );
    };
    // So is the request's id: one in flight at a time, claimed before the call is delivered.
    // The call's id follows from its key, so the guard can hold it from here.
    let request = message.id.clone().unwrap_or(Value::Null);
    let call = caller.call_id(&key);
    if !engine.outside_request_started(&caller.grant, &request, &call) {
        return Called::DuplicateId;
    }
    let _running = Running {
        engine: engine.clone(),
        caller: caller.clone(),
        request,
        call: call.clone(),
        era: message.era,
    };
    if let Err(refused) = engine.outside_call(caller, OutsideVia::Mcp, &key, tool, input.clone()) {
        return match refused {
            OutsideRefused::NoSuchTool => Called::NoSuchTool(tool.to_owned()),
            OutsideRefused::Problem(why) => Called::Failed(why),
        };
    }
    let bot = engine
        .outside_callee(caller, &call)
        .unwrap_or_else(|| "The bot".to_owned());
    let mut waiting = false;
    loop {
        match engine
            .outside_wait(caller, &call, crate::engine::OUTSIDE_LONGEST_WAIT, waiting)
            .await
        {
            OutsideCallState::Open { waiting: now } => waiting = now,
            OutsideCallState::Unknown => {
                return Called::Failed("The call was lost before it ended.".to_owned());
            }
            OutsideCallState::Ended(Outcome::Returned { output, untrusted }) => {
                return Called::Returned { output, untrusted };
            }
            OutsideCallState::Ended(outcome) => {
                return Called::Failed(super::outcome_text(&bot, &outcome));
            }
        }
    }
}
