// SPDX-License-Identifier: Apache-2.0
//! Spade's running rows, read leniently as the web page does.

use serde::Serialize;

#[derive(Clone, Serialize)]
pub(crate) struct RunningBot {
    pub(crate) id: String,
    pub(crate) kind: String,
    pub(crate) name: String,
    pub(crate) state: String,
    pub(crate) reads: String,
    pub(crate) doing: String,
    pub(crate) uses: String,
    pub(crate) spend: RunningSpend,
    pub(crate) network: RunningNetwork,
    #[serde(rename = "nextWake", skip_serializing_if = "Option::is_none")]
    pub(crate) next_wake: Option<RunningWake>,
    pub(crate) workers: Vec<RunningWorker>,
    pub(crate) actions: Vec<String>,
}

#[derive(Clone, Serialize)]
pub(crate) struct RunningSpend {
    #[serde(rename = "todayMicros")]
    pub(crate) today_micros: i64,
    #[serde(rename = "monthMicros")]
    pub(crate) month_micros: i64,
    pub(crate) unusual: bool,
}

#[derive(Clone, Serialize)]
pub(crate) struct RunningNetwork {
    pub(crate) bytes: i64,
    pub(crate) hosts: Vec<String>,
    pub(crate) refused: i64,
}

#[derive(Clone, Serialize)]
pub(crate) struct RunningWake {
    pub(crate) at: i64,
    pub(crate) what: String,
}

#[derive(Clone, Serialize)]
pub(crate) struct RunningWorker {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) doing: String,
}
fn json_lenient_number(value: Option<&serde_json::Value>) -> i64 {
    value.map_or(0, |value| {
        if let Some(int) = value.as_i64() {
            return int;
        }
        if let Some(uint) = value.as_u64() {
            return i64::try_from(uint).unwrap_or(0);
        }
        value.as_f64().map_or(0, round_to_i64)
    })
}

/// A JSON number as an integer, saturating on the way in.
#[allow(
    clippy::cast_possible_truncation,
    reason = "float-to-int `as` saturates; timestamps and counts fit"
)]
fn round_to_i64(number: f64) -> i64 {
    number.round() as i64
}

fn json_lenient_string(value: Option<&serde_json::Value>) -> String {
    value
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_owned()
}

fn json_lenient_bool(value: Option<&serde_json::Value>) -> bool {
    value.and_then(serde_json::Value::as_bool).unwrap_or(false)
}
pub(crate) fn parse_running_bot(raw: &serde_json::Value) -> Option<RunningBot> {
    let id = raw.get("id")?.as_str()?;
    if id.is_empty() {
        return None;
    }
    let kind = match raw.get("kind").and_then(serde_json::Value::as_str) {
        Some("main") => "main",
        _ => "bot",
    };
    let main = kind == "main";
    let name = if main {
        "Spade".to_owned()
    } else {
        let name = json_lenient_string(raw.get("name"));
        if name.is_empty() {
            "Bot".to_owned()
        } else {
            name
        }
    };
    let reads = raw
        .get("reads")
        .and_then(serde_json::Value::as_str)
        .filter(|reads| {
            matches!(
                reads,
                &"needs_you" | &"working" | &"failed" | &"sleeping" | &"paused" | &"idle"
            )
        })
        .unwrap_or("idle");
    let state = raw
        .get("state")
        .and_then(serde_json::Value::as_str)
        .filter(|state| {
            matches!(
                state,
                &"idle" | &"working" | &"waiting" | &"sleeping" | &"paused" | &"updating"
            )
        })
        .unwrap_or("idle");
    let doing = if reads == "needs_you" {
        needs_you_running(&json_lenient_string(raw.get("doing")))
    } else {
        let doing = json_lenient_string(raw.get("doing"));
        if doing.is_empty() {
            match reads {
                "needs_you" => "Needs you",
                "working" => "Working",
                "failed" => "Failed",
                "sleeping" => "Sleeping",
                "paused" => "Paused",
                _ => "Idle",
            }
            .to_owned()
        } else {
            doing
        }
    };
    let uses = uses_words(&raw.get("uses").cloned().unwrap_or_default());
    let spend = raw.get("spend").cloned().unwrap_or_default();
    let network = raw.get("network").cloned().unwrap_or_default();
    let next_wake = parse_wake(raw.get("next_wake"));
    let empty_workers = Vec::new();
    let workers = raw
        .get("workers")
        .and_then(serde_json::Value::as_array)
        .unwrap_or(&empty_workers);
    let empty_actions = Vec::new();
    let actions = raw
        .get("actions")
        .and_then(serde_json::Value::as_array)
        .unwrap_or(&empty_actions);
    Some(RunningBot {
        id: id.to_owned(),
        kind: kind.to_owned(),
        name,
        state: state.to_owned(),
        reads: reads.to_owned(),
        doing,
        uses,
        spend: parse_spend(&spend),
        network: parse_network(&network),
        next_wake,
        workers: parse_workers(workers),
        actions: parse_actions(actions),
    })
}

/// What it holds open, in words: "Answering · 2 jobs · 1 worker · 1 service"; empty for none.
pub(crate) fn uses_words(uses: &serde_json::Value) -> String {
    let answering = uses
        .get("answering")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let mut words = Vec::new();
    if answering {
        words.push("Answering".to_owned());
    }
    for (key, one) in [
        ("jobs", "job"),
        ("workers", "worker"),
        ("services", "service"),
    ] {
        let count = uses.get(key).map_or(0, json_lenient_number_inner);
        if count > 0 {
            words.push(plural(count, one));
        }
    }
    if json_lenient_bool(uses.get("agents")) {
        words.push("Coding agents".to_owned());
    }
    words.join(" · ")
}
fn parse_spend(spend: &serde_json::Value) -> RunningSpend {
    RunningSpend {
        today_micros: json_lenient_number(spend.get("today_micros")),
        month_micros: json_lenient_number(spend.get("month_micros")),
        unusual: json_lenient_bool(spend.get("unusual")),
    }
}

fn parse_network(network: &serde_json::Value) -> RunningNetwork {
    let empty = Vec::new();
    let hosts: Vec<String> = network
        .get("hosts")
        .and_then(serde_json::Value::as_array)
        .unwrap_or(&empty)
        .iter()
        .filter_map(serde_json::Value::as_str)
        .map(str::to_owned)
        .collect();
    RunningNetwork {
        bytes: json_lenient_number(network.get("sent_bytes"))
            + json_lenient_number(network.get("received_bytes")),
        hosts,
        refused: json_lenient_number(network.get("refused")),
    }
}

fn parse_wake(wake: Option<&serde_json::Value>) -> Option<RunningWake> {
    let wake = wake?;
    if wake.is_null() {
        return None;
    }
    Some(RunningWake {
        at: json_lenient_number(wake.get("at_ms")),
        what: json_lenient_string(wake.get("what")),
    })
}

fn parse_workers(workers: &[serde_json::Value]) -> Vec<RunningWorker> {
    workers
        .iter()
        .filter_map(|worker| {
            let id = worker.get("id")?.as_str()?;
            if id.is_empty() {
                return None;
            }
            let name = json_lenient_string(worker.get("name"));
            Some(RunningWorker {
                id: id.to_owned(),
                name: if name.is_empty() {
                    "Worker".to_owned()
                } else {
                    name
                },
                doing: json_lenient_string(worker.get("doing")),
            })
        })
        .collect()
}

fn parse_actions(actions: &[serde_json::Value]) -> Vec<String> {
    actions
        .iter()
        .filter_map(serde_json::Value::as_str)
        .filter(|action| matches!(*action, "stop" | "pause" | "resume" | "unarchive"))
        .map(str::to_owned)
        .collect()
}

fn json_lenient_number_inner(value: &serde_json::Value) -> i64 {
    json_lenient_number(Some(value))
}

fn plural(count: i64, one: &str) -> String {
    format!("{count} {one}{}", if count == 1 { "" } else { "s" })
}

/// The daemon's own catch-all phrasings say nothing of what is asked.
fn needs_you_words(ask: &str) -> String {
    let words = ask.trim();
    let lower = words.to_lowercase();
    let bare = lower.strip_suffix('.').unwrap_or(&lower);
    let generic = matches!(
        bare,
        "needs you"
            | "waiting for you"
            | "waiting on you"
            | "asked you a question"
            | "a worker needs you"
    );
    if words.is_empty() || generic {
        "Needs you".to_owned()
    } else {
        words.to_owned()
    }
}

/// The daemon's Running line for a bot that waits, in the one phrase.
fn needs_you_running(doing: &str) -> String {
    let trimmed = doing.trim();
    for prefix in ["waiting for you:", "waiting on you:"] {
        if trimmed.len() >= prefix.len()
            && trimmed
                .get(..prefix.len())
                .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
        {
            let rest = trimmed.get(prefix.len()..).unwrap_or("").trim();
            if rest.is_empty() {
                break;
            }
            if rest.eq_ignore_ascii_case("a question") {
                return "Asks you a question".to_owned();
            }
            if rest.eq_ignore_ascii_case("an approval") {
                return "Asks for your approval".to_owned();
            }
            return needs_you_words(rest);
        }
    }
    needs_you_words(doing)
}
