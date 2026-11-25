// SPDX-License-Identifier: Apache-2.0
//! Shape checks for incoming adapter facts.

use crate::emit::get;
use crate::json_io::{Json, Map, as_count, as_integer};
use crate::state::ThreadState;

use super::{is_string, optional_string, valid_permission_mode, valid_run_trigger};

use crate::validate_shapes::{
    valid_agent_machine, valid_goal, valid_interaction_request, valid_interaction_resolution,
    valid_native_ref, valid_raw_list, valid_thread_id, valid_thread_lineage, valid_timestamp,
};

fn valid_agent_seen(_state: &ThreadState, map: &Map) -> bool {
    // Origin must be a known agent origin.
    if !matches!(
        map.get("origin").and_then(|origin| origin.as_str()),
        Some("root" | "provider_subagent" | "ace")
    ) {
        return false;
    }
    if !matches!(
        map.get("fidelity").and_then(|fidelity| fidelity.as_str()),
        Some("full" | "summary" | "placeholder")
    ) {
        return false;
    }
    if !valid_native_ref(map.get("native")) {
        return false;
    }
    if !matches!(map.get("cwd"), Some(Json::String(_))) {
        return false;
    }
    for key in ["name", "role", "model"] {
        if !matches!(
            map.get(key),
            None | Some(Json::Null) | Some(Json::String(_))
        ) {
            return false;
        }
    }
    if !matches!(
        map.get("background"),
        None | Some(Json::Null) | Some(Json::Bool(_))
    ) {
        return false;
    }
    if let Some(machine) = map.get("machine")
        && !matches!(machine, Json::Null)
        && !valid_agent_machine(Some(machine))
    {
        return false;
    }
    if let Some(lineage) = map.get("lineage")
        && !matches!(lineage, Json::Null)
        && !valid_thread_lineage(Some(lineage))
    {
        return false;
    }
    true
}

/// The shape half of preflight: every field has the right JSON shape.
/// Returns `Ok(false)` for a shape mismatch and `Err` for unreadable data.
#[allow(clippy::result_unit_err)]
pub fn shape_valid(state: &ThreadState, fact: &Map, fact_type: &str, now: i64) -> Result<bool, ()> {
    let valid = match fact_type {
        "agent.external" => {
            valid_thread_id(fact.get("threadId"))
                && {
                    let status = fact.get("status").unwrap_or(&Json::Null);
                    crate::thread_status::valid_external_status(status)
                }
                && get(&state.agents, fact.get("agent").and_then(|agent| agent.as_str()).unwrap_or(""))
                    .is_some_and(|record| record.agent.origin == "ace")
        }
        "agent.seen" => valid_agent_seen(state, fact),
        "agent.linked" => {
            matches!(
                fact.get("background"),
                None | Some(Json::Null) | Some(Json::Bool(_))
            ) && matches!(fact.get("name"), None | Some(Json::Null) | Some(Json::String(_)))
                && matches!(fact.get("model"), None | Some(Json::Null) | Some(Json::String(_)))
        }
        "turn.started" => {
            valid_run_trigger(fact.get("trigger"))
                && valid_permission_mode(fact.get("permissionMode"))
        }
        "turn.ended" => {
            let outcome = matches!(
                fact.get("outcome").and_then(|outcome| outcome.as_str()),
                Some("completed" | "failed" | "interrupted")
            );
            let ended_by = match fact.get("endedBy") {
                None | Some(Json::Null) => true,
                Some(Json::String(ended)) => {
                    ended == "steer"
                        && fact.get("outcome").and_then(|outcome| outcome.as_str())
                            == Some("interrupted")
                }
                _ => false,
            };
            let historical = matches!(
                fact.get("historical"),
                None | Some(Json::Null) | Some(Json::Bool(_))
            );
            let trigger = match fact.get("trigger") {
                None | Some(Json::Null) => true,
                trigger => valid_run_trigger(trigger),
            };
            let error = match fact.get("error") {
                None | Some(Json::Null) => true,
                Some(_) => crate::validate_shapes::valid_agent_error(fact.get("error")),
            };
            outcome && ended_by && historical && trigger && error
        }
        "input.admitted" => {
            matches!(
                fact.get("nativeInputId"),
                Some(Json::String(id)) if !id.is_empty() && id.len() <= 512
            ) && match fact.get("commandId") {
                None | Some(Json::Null) => true,
                Some(Json::String(id)) => !id.is_empty() && id.len() <= 512,
                _ => false,
            }
        }
        "input.consumed" => match fact.get("nativeInputIds") {
            Some(Json::Array(ids)) => {
                ids.len() <= 64
                    && ids.iter().all(
                        |id| matches!(id, Json::String(id) if !id.is_empty() && id.len() <= 512),
                    )
            }
            _ => false,
        },
        "activity" => {
            matches!(
                fact.get("activity").and_then(|activity| activity.as_str()),
                Some(
                    "thinking"
                        | "responding"
                        | "tool"
                        | "compacting"
                        | "retrying"
                        | "starting_turn"
                )
            ) && optional_string(fact.get("detail"))
        }
        "subagents.waiting" => match fact.get("targets") {
            Some(Json::Array(targets)) => targets
                .iter()
                .all(|target| matches!(target, Json::String(_))),
            _ => false,
        },
        "item.reconciled" | "item.upsert" => {
            return match crate::validate_items::item_error(state, fact, fact_type, now) {
                None => Ok(true),
                Some(_) => Ok(false),
            };
        }
        "item.delta" => {
            matches!(
                fact.get("field").and_then(|field| field.as_str()),
                Some("text" | "reasoning" | "output")
            ) && is_string(fact.get("append"))
        }
        "interaction.opened" => {
            matches!(fact.get("blocking"), Some(Json::Bool(_)))
                && valid_interaction_request(fact.get("request"))
                && valid_raw_list(fact.get("raw"))
        }
        "interaction.closed" => {
            matches!(
                fact.get("state").and_then(|state| state.as_str()),
                Some("resolved" | "cancelled" | "expired")
            ) && match fact.get("resolution") {
                None | Some(Json::Null) => true,
                resolution => valid_interaction_resolution(resolution),
            } && matches!(fact.get("resolvedBy"), None | Some(Json::String(_)))
                && matches!(
                    fact.get("autoReviewed"),
                    None | Some(Json::Null) | Some(Json::Bool(_))
                )
        }
        "background.started" => {
            matches!(
                fact.get("kind").and_then(|kind| kind.as_str()),
                Some("shell" | "monitor" | "subagent" | "other")
            ) && match fact.get("owner") {
                None => true,
                Some(Json::String(owner)) => owner == "ace",
                _ => false,
            } && is_string(fact.get("title"))
                && matches!(fact.get("stoppable"), Some(Json::Bool(_)))
                && matches!(fact.get("ambient"), None | Some(Json::Bool(_)))
                && match fact.get("internal") {
                    None => true,
                    Some(Json::Bool(internal)) => *internal,
                    _ => false,
                }
                && optional_string(fact.get("outputPath"))
                && matches!(fact.get("wakesAgent"), None | Some(Json::Bool(false)))
                && matches!(fact.get("blocksPrompts"), None | Some(Json::Bool(true)))
                && matches!(
                    fact.get("endsWithSession"),
                    None | Some(Json::Bool(true))
                )
                && match fact.get("raw") {
                    None => true,
                    Some(Json::Array(raw)) => {
                        raw.iter().all(crate::validate_shapes::valid_raw_payload)
                    }
                    _ => false,
                }
        }
        "background.listening" => match fact.get("ports") {
            Some(Json::Array(ports)) => {
                ports.len() <= 16
                    && ports.iter().all(|port| {
                        matches!(as_integer(Some(port)), Some(port) if (1..=65_535).contains(&port))
                    })
            }
            _ => false,
        },
        "background.waiting" => matches!(fact.get("waiting"), Some(Json::Bool(_))),
        "background.ended" => {
            let status = matches!(
                fact.get("status").and_then(|status| status.as_str()),
                Some("completed" | "failed" | "stopped" | "unknown")
            );
            let uncertain = matches!(
                fact.get("uncertain"),
                None | Some(Json::Null) | Some(Json::Bool(_))
            );
            let uncertain_rule = match fact.get("uncertain") {
                Some(Json::Bool(true)) => {
                    fact.get("status").and_then(|status| status.as_str()) == Some("unknown")
                }
                _ => true,
            };
            status && uncertain && uncertain_rule
        }
        "retry" => {
            let on = matches!(
                fact.get("on").and_then(|on| on.as_str()),
                Some("rate_limit" | "network" | "upstream")
            );
            let attempt = match fact.get("attempt") {
                None => true,
                Some(attempt) => matches!(as_integer(Some(attempt)), Some(attempt) if attempt > 0),
            };
            let until = match fact.get("until") {
                None => true,
                Some(until) => as_count(Some(until)).is_some(),
            };
            let message = optional_string(fact.get("message"));
            on && attempt && until && message
        }
        "wake.expected" => valid_timestamp(fact.get("until")),
        "goal.updated" => match fact.get("goal") {
            Some(Json::Null) => true,
            Some(Json::Object(goal)) => valid_goal(goal),
            _ => false,
        },
        "context.sample" => {
            ensure_sample_keys(fact)
                && as_count(fact.get("usedTokens")).is_some()
                && match fact.get("windowTokens") {
                    None => true,
                    Some(window) => matches!(as_count(Some(window)), Some(window) if window > 0),
                }
                && optional_string(fact.get("sessionId"))
                && optional_string(fact.get("model"))
        }
        "usage" => {
            // The usage fact is validated as a whole, like the spread the
            // TypeScript parses: counts plus metadata, nothing else.
            as_count(fact.get("inputTokens")).is_some()
                && as_count(fact.get("outputTokens")).is_some()
                && valid_usage_facts(fact)
        }
        "process.exited" => {
            matches!(fact.get("deliberate"), Some(Json::Bool(_)))
                && optional_string(fact.get("message"))
                && matches!(
                    fact.get("unconfirmed"),
                    None | Some(Json::Null) | Some(Json::Bool(_))
                )
        }
        "queue.changed" => {
            as_count(fact.get("count")).is_some()
                && match fact.get("source") {
                    None => true,
                    Some(Json::String(source)) => {
                        ["engine", "provider"].contains(&source.as_str())
                    }
                    _ => false,
                }
                && matches!(
                    fact.get("held"),
                    None | Some(Json::Bool(_))
                )
                && (fact.get("held").is_none()
                    || fact.get("source").and_then(|source| source.as_str()) != Some("provider"))
                && matches!(
                    fact.get("stopped"),
                    None | Some(Json::Bool(_))
                )
                && (fact.get("stopped").is_none()
                    || fact.get("source").and_then(|source| source.as_str()) != Some("provider"))
        }
        "thread.moved" => match fact.get("to") {
            Some(Json::Null) => true,
            Some(Json::Object(to)) => {
                ensure_moved_target(to)
            }
            _ => false,
        },
        "agent.disconnected"
        | "agent.reconnected"
        | "retry.cleared"
        | "limit.cleared"
        | "signal"
        | "tick"
        | "process.started" => true,
        _ => false,
    };
    Ok(valid)
}

fn ensure_sample_keys(fact: &Map) -> bool {
    fact.keys().all(|key| {
        [
            "type",
            "agent",
            "usedTokens",
            "windowTokens",
            "sessionId",
            "model",
        ]
        .contains(&key.as_str())
    })
}

fn valid_usage_facts(fact: &Map) -> bool {
    use crate::validate_shapes::valid_usage_like;
    valid_usage_like(fact, &["type", "agent"])
}

fn ensure_moved_target(to: &Map) -> bool {
    to.keys()
        .all(|key| ["hostId", "name", "threadId"].contains(&key.as_str()))
        && matches!(to.get("hostId"), Some(Json::String(id)) if !id.is_empty())
        && matches!(to.get("name"), Some(Json::String(name)) if !name.is_empty() && name.len() <= 256)
        && matches!(to.get("threadId"), Some(Json::String(id)) if !id.is_empty())
}
