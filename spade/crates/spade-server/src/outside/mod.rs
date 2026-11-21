//! Contracts out (ADR 0202 §3, §6): the person's bots' contracts offered to the person's own
//! agents outside Spade, as MCP tools ([`mcp`]) and as A2A skills ([`a2a`]). Each request
//! reaches Spade through ace's daemon, which signed in the client under an ace grant with
//! `spade-contracts` and stamps the grant on the request; every call runs as a contract call
//! (`crate::engine::OutsideCaller`).

pub mod a2a;
pub mod mcp;

use spade_core::contract::Outcome;

/// A call's outcome as one line or a few, for a caller that reads text.
fn outcome_text(bot: &str, outcome: &Outcome) -> String {
    match outcome {
        Outcome::Returned { .. } => format!("{bot} returned."),
        Outcome::Failed { problems } => {
            format!("{bot} could not answer:\n- {}", problems.join("\n- "))
        }
        Outcome::Stopped { why } => format!("The call to {bot} was stopped: {why}"),
    }
}
