// SPDX-License-Identifier: Apache-2.0
//! `ace machine list`: this machine's links to the person's other machines.

use std::io::Write;

use cli_out::{Out, Outcome};
use serde::Serialize;
use serde_json::Value;

use super::render::columns;
use super::session::{answer, ws_once};

const COMMAND: &str = "machine.list";

#[derive(Serialize)]
struct FleetLinksRequest<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    operation: FleetLinksOperation<'a>,
}

#[derive(Serialize)]
struct FleetLinksOperation<'a> {
    op: &'a str,
}

fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn status_words(status: &str) -> &str {
    match status {
        "online" => "online",
        "offline" => "offline",
        "refused" => "doesn't let agents in",
        _ => status,
    }
}

pub fn list<W: Write, E: Write>(
    parsed: &cli_parse::Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let reply = match ws_once(
        &parsed.flags,
        COMMAND,
        &FleetLinksRequest {
            kind: "fleet.request",
            operation: FleetLinksOperation { op: "links" },
        },
    ) {
        Ok(reply) => reply,
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    let empty = Vec::new();
    let machines = reply
        .get("result")
        .filter(|result| result.get("kind").and_then(Value::as_str) == Some("links"))
        .and_then(|result| result.get("links"))
        .and_then(Value::as_array)
        .unwrap_or(&empty)
        .clone();
    let value = serde_json::json!({"machines": machines});
    let human = machine_list_lines(&value);
    let quiet = machine_names(&value);
    answer(out, err, &parsed.flags, &value, &human, &quiet)
}

/// Each linked machine by the name agents use, and whether it answers.
fn machine_list_lines(value: &Value) -> Vec<String> {
    let machines = value
        .get("machines")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if machines.is_empty() {
        return vec![
            "No other machines linked. Link one in the app's Fleet page, or ace device pair."
                .to_owned(),
        ];
    }
    columns(
        &machines
            .iter()
            .map(|machine| {
                let profile = str_field(machine, "profile").unwrap_or("");
                let name = str_field(machine, "name").unwrap_or("");
                vec![
                    Some(profile.to_owned()),
                    if name == profile {
                        None
                    } else {
                        Some(name.to_owned())
                    },
                    str_field(machine, "status").map(|status| status_words(status).to_owned()),
                    str_field(machine, "access").map(str::to_owned),
                ]
            })
            .collect::<Vec<_>>(),
    )
}

fn machine_names(value: &Value) -> Vec<String> {
    value
        .get("machines")
        .and_then(Value::as_array)
        .map(|machines| {
            machines
                .iter()
                .filter_map(|machine| str_field(machine, "profile"))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}
