//! What a scenario run did, read from its conversation's stored events: each call and how it
//! ended, the cards shown or refused, and the reply. Pure.

use serde_json::Value;
use spade_core::effect::Effect;
use spade_core::package::scenario::{Observed, Outcome, Returned, Seen};

/// The words a refused call's result starts with (`spade_core::autonomy::refused`).
const NOT_RUN: &str = "Not run: ";

/// Whether the turn has ended: a reply finished, failed or stopped.
pub fn ended(events: &[Value]) -> bool {
    events.iter().any(|e| {
        matches!(
            e["type"].as_str(),
            Some("reply_finished" | "reply_failed" | "reply_stopped")
        )
    })
}

fn text(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_owned()
}

pub fn observed(events: &[Value]) -> Observed {
    let mut seen = Observed::default();
    // Each call by its id, in the order it first showed: (id, tool, effect, outcome).
    let mut calls: Vec<(String, Seen)> = Vec::new();
    for event in events {
        let id = text(&event["call_id"]);
        let name = text(&event["name"]);
        match event["type"].as_str() {
            Some("tool_started") => {
                let effect = event["effect"].as_str().and_then(Effect::parse);
                calls.push((
                    id,
                    Seen {
                        tool: name,
                        effect,
                        outcome: Outcome::Ran,
                    },
                ));
            }
            Some("tool_finished") => {
                let content = text(&event["content"]);
                let error = event["is_error"] == true;
                if name == spade_core::card::CARD_SHOW && error {
                    seen.card_problems.push(content.clone());
                }
                match calls.iter_mut().find(|(call, _)| *call == id) {
                    Some((_, call)) if error => call.outcome = Outcome::Failed(content),
                    Some(_) => {}
                    // A result with no start: the gate refused it before it ran.
                    None => {
                        let reason = content
                            .strip_prefix(NOT_RUN)
                            .map_or(content.as_str(), |rest| {
                                rest.split(" Don't work around this.")
                                    .next()
                                    .unwrap_or(rest)
                            })
                            .to_owned();
                        calls.push((
                            id,
                            Seen {
                                effect: super::fakes::effect_of(&name),
                                tool: name,
                                outcome: Outcome::Refused(reason),
                            },
                        ));
                    }
                }
            }
            Some("card_shown") => seen.cards.push(text(&event["data"]["title"])),
            // A call the scenario gave the bot ended (ADR 0200 §7).
            Some("contract_ended") if event["status"] == "returned" => {
                seen.returned = Some(Returned::Output(event["output"].clone()));
            }
            Some("contract_ended") => {
                let problems = event["problems"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(text)
                    .collect();
                seen.returned = Some(Returned::Failed(problems));
            }
            Some("reply_finished") => seen.reply = text(&event["text"]),
            Some("reply_failed") => {
                seen.ended = Some(format!(
                    "it failed: {}",
                    event["error"].as_str().unwrap_or("no reason given")
                ));
            }
            Some("reply_stopped") => seen.ended = Some("it was stopped".to_owned()),
            _ => {}
        }
    }
    if !ended(events) {
        seen.ended = Some("it was still working when the scenario's time ran out".to_owned());
    }
    seen.calls = calls.into_iter().map(|(_, call)| call).collect();
    seen
}
