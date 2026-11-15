//! A background `delegate` or `wait` call stays open until ace says the children settled
//! (AGENTS.md priority 1): ace's own wait ends after at most ten minutes with `timeout` (or
//! `interrupted` while the daemon restarts) and the children keep working, so the job asks ace to
//! wait again instead of ending. While the job runs the bot reads as working; its result arrives
//! once, when the children are done, need the person, or are held at a usage limit.

use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};
use spade_ace::{AceToolResult, AceTools, Part, ToolsError};

/// How long each wait Spade sends asks ace to wait: ace's most.
const WAIT_SECONDS: u64 = 600;
/// A wait that answers sooner than this with nothing settled is followed by a pause, so a daemon
/// that answers at once never makes Spade spin.
const SHORTEST_WAIT: Duration = Duration::from_secs(1);
/// While ace can't be reached, how long between tries: doubling up to the most.
const FIRST_RETRY: Duration = Duration::from_secs(2);
const LONGEST_RETRY: Duration = Duration::from_secs(60);

/// The threads to wait on again and the wait's mode, when ace's wait in `result` (the answer to
/// `name`, `delegate` or `wait`) ended before they settled.
pub(super) fn unsettled(name: &str, result: &AceToolResult) -> Option<(Vec<String>, String)> {
    let body = body(result)?;
    if body.get("ok") == Some(&Value::Bool(false)) || result.is_error {
        return None;
    }
    let data = body.get("data")?;
    let (wait, ids) = match name {
        "delegate" => {
            let ids = data.get("threadIds")?.as_array()?;
            (
                data.get("wait")?,
                ids.iter().filter_map(Value::as_str).collect::<Vec<_>>(),
            )
        }
        "wait" => {
            let threads = data.get("threads")?.as_array()?;
            let ids = threads
                .iter()
                .filter_map(|t| t.get("threadId").and_then(Value::as_str))
                .collect();
            (data, ids)
        }
        _ => return None,
    };
    let status = wait.get("status").and_then(Value::as_str)?;
    if !matches!(status, "timeout" | "interrupted") || ids.is_empty() {
        return None;
    }
    let mode = wait.get("mode").and_then(Value::as_str).unwrap_or("all");
    Some((
        ids.into_iter().map(str::to_owned).collect(),
        mode.to_owned(),
    ))
}

/// The answer as JSON: `structuredContent`, else the text parts.
fn body(result: &AceToolResult) -> Option<Value> {
    if let Some(structured) = &result.structured {
        return Some(structured.clone());
    }
    let text: String = result
        .parts
        .iter()
        .filter_map(|part| match part {
            Part::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    serde_json::from_str(&text).ok()
}

/// Waits again, as long as ace says the children still run, and answers with the call's own
/// result once they settled: for `delegate` its thread ids with the last wait's result. Errors
/// reaching ace meanwhile are waited out (the children run on in ace); Stop ends the job.
pub(super) async fn until_settled(
    client: &AceTools,
    bot: Option<&str>,
    name: &str,
    first: Result<AceToolResult, ToolsError>,
) -> Result<AceToolResult, ToolsError> {
    let Ok(answer) = &first else { return first };
    let Some((ids, mode)) = unsettled(name, answer) else {
        return first;
    };
    let mut pending = (ids.clone(), mode);
    let mut retry = FIRST_RETRY;
    let last = loop {
        let asked = Instant::now();
        let arguments =
            json!({ "threadIds": pending.0, "mode": pending.1, "timeoutSeconds": WAIT_SECONDS });
        let answer = match bot {
            Some(bot) => client.call_for("wait", arguments, bot).await,
            None => client.call("wait", arguments).await,
        };
        match answer {
            Ok(answer) => {
                retry = FIRST_RETRY;
                let Some(next) = unsettled("wait", &answer) else {
                    break answer;
                };
                pending = next;
                if asked.elapsed() < SHORTEST_WAIT {
                    tokio::time::sleep(SHORTEST_WAIT).await;
                }
            }
            Err(error) => {
                tracing::warn!(%error, "could not ask ace about delegated children; trying again");
                tokio::time::sleep(retry).await;
                retry = (retry * 2).min(LONGEST_RETRY);
            }
        }
    };
    if name != "delegate" {
        return Ok(last);
    }
    // The delegate's answer, its wait replaced by the one that settled.
    let wait = body(&last)
        .and_then(|b| b.get("data").cloned())
        .unwrap_or(Value::Null);
    let combined = json!({ "ok": true, "data": { "threadIds": ids, "wait": wait } });
    Ok(AceToolResult {
        parts: vec![Part::Text {
            text: combined.to_string(),
            extra: Map::new(),
        }],
        is_error: false,
        structured: None,
        extra: Map::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer(value: Value) -> AceToolResult {
        AceToolResult {
            parts: vec![Part::Text {
                text: value.to_string(),
                extra: Map::new(),
            }],
            is_error: false,
            structured: None,
            extra: Map::new(),
        }
    }

    fn thread(id: &str, state: &str) -> Value {
        json!({ "threadId": id, "state": state, "title": "t", "elapsedSeconds": 1 })
    }

    #[test]
    fn a_wait_that_ran_out_before_the_children_settled_is_waited_again() {
        let delegated = answer(json!({ "ok": true, "data": {
            "threadIds": ["t1", "t2"],
            "wait": { "status": "timeout", "mode": "all",
                      "threads": [thread("t1", "working"), thread("t2", "done")] } } }));
        assert_eq!(
            unsettled("delegate", &delegated),
            Some((vec!["t1".into(), "t2".into()], "all".into()))
        );
        let interrupted = answer(json!({ "ok": true, "data": {
            "status": "interrupted", "mode": "any", "threads": [thread("t3", "working")] } }));
        assert_eq!(
            unsettled("wait", &interrupted),
            Some((vec!["t3".into()], "any".into()))
        );
    }

    #[test]
    fn settled_children_one_needing_the_person_or_a_refusal_end_the_wait() {
        for status in ["ready", "needs_you", "limited"] {
            let waited = answer(json!({ "ok": true, "data": {
                "status": status, "mode": "all", "threads": [thread("t1", "done")] } }));
            assert_eq!(unsettled("wait", &waited), None, "{status}");
        }
        let refused = answer(json!({ "ok": false, "code": "not_found" }));
        assert_eq!(unsettled("wait", &refused), None);
        // A delegate that was not asked to wait answers with its ids alone.
        let started = answer(json!({ "ok": true, "data": { "threadIds": ["t1"] } }));
        assert_eq!(unsettled("delegate", &started), None);
    }
}
