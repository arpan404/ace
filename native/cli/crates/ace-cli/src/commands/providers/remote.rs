// SPDX-License-Identifier: Apache-2.0
//! `ace remote list|use|remove`: profiles for other machines (no daemon needed).

use std::io::Write;

use cli_out::{ErrorCode, Failure, Out, Outcome};
use cli_wire::Home;
use cli_wire::profile::RemoteProfile;
use serde_json::{Value, json};

use super::render::columns;
use super::session::{CommandResult, answer};

const COMMAND_LIST: &str = "remote.list";
const COMMAND_USE: &str = "remote.use";
const COMMAND_REMOVE: &str = "remote.remove";

fn home_of(command: &'static str) -> CommandResult<Home> {
    Home::from_env().map_err(|_| {
        Box::new(
            Failure::new(Outcome::Refused, "ace isn't running.")
                .with_code(ErrorCode::DaemonDown)
                .with_hint("Start it with ace start, or open the app.")
                .with_command(command),
        )
    })
}

fn no_profile(name: &str, command: &'static str) -> Failure<'static> {
    Failure::new(Outcome::Refused, format!("No remote profile {name}."))
        .with_code(ErrorCode::NotFound)
        .with_hint("See the profiles with ace remote list.")
        .with_command(command)
}

/// A profile without its token, as `--json` lists it.
fn profile_summary(profile: &RemoteProfile) -> Value {
    let mut summary = json!({
        "id": profile.id,
        "name": profile.name.as_str(),
    });
    if let Some(origin) = &profile.origin {
        summary["origin"] = Value::String(origin.as_str().to_owned());
    }
    if let Some(fingerprint) = &profile.fingerprint {
        summary["fingerprint"] = Value::String(fingerprint.as_str().to_owned());
    }
    if let Some(relay) = &profile.relay {
        summary["relay"] = json!({"url": relay.url(), "relayHostId": relay.relay_host_id()});
    }
    summary["deviceId"] = Value::String(profile.device_id.as_str().to_owned());
    if let Some(host_id) = &profile.host_id {
        summary["hostId"] = Value::String(host_id.as_str().to_owned());
    }
    if let Some(label) = &profile.label {
        summary["label"] = Value::String(label.clone());
    }
    summary
}

/// Where the machine is reached: its address, or the relay it was linked through.
fn where_of(summary: &Value) -> String {
    if let Some(origin) = summary.get("origin").and_then(Value::as_str) {
        return origin.to_owned();
    }
    if let Some(url) = summary
        .get("relay")
        .and_then(|relay| relay.get("url"))
        .and_then(Value::as_str)
    {
        return format!("through {url}");
    }
    String::new()
}

fn mark(name: &str, active: &str) -> String {
    if name == active {
        "*".to_owned()
    } else {
        " ".to_owned()
    }
}

pub fn list<W: Write, E: Write>(
    parsed: &cli_parse::Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let home = match home_of(COMMAND_LIST) {
        Ok(home) => home,
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    let store = match super::store::open(home.path(), COMMAND_LIST) {
        Ok(store) => store,
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    let profiles = match store.list(COMMAND_LIST) {
        Ok(profiles) => profiles,
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    let active = match store.selected(COMMAND_LIST) {
        Ok(selected) => selected.unwrap_or_else(|| "local".to_owned()),
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    let summaries: Vec<Value> = profiles.iter().map(profile_summary).collect();
    let value = json!({"active": active, "profiles": summaries});
    let human = remote_list_lines(&value);
    let quiet = remote_names(&value);
    answer(out, err, &parsed.flags, &value, &human, &quiet)
}

pub fn use_profile<W: Write, E: Write>(
    parsed: &cli_parse::Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let name = parsed.words.first().copied().unwrap_or("");
    let home = match home_of(COMMAND_USE) {
        Ok(home) => home,
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    let mut store = match super::store::open(home.path(), COMMAND_USE) {
        Ok(store) => store,
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    if name != "local" {
        let known = match store.list(COMMAND_USE) {
            Ok(profiles) => profiles,
            Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
        };
        if !known.iter().any(|profile| profile.name.as_str() == name) {
            return crate::run::fail(
                out,
                err,
                Some(&parsed.flags),
                &no_profile(name, COMMAND_USE),
            );
        }
    }
    if let Err(failure) = store.use_profile(name, COMMAND_USE) {
        return crate::run::fail(out, err, Some(&parsed.flags), &failure);
    }
    let value = json!({"active": name});
    let human = if name == "local" {
        "Commands go to this machine.".to_owned()
    } else {
        format!("Commands go to {name} until ace remote use local.")
    };
    answer(out, err, &parsed.flags, &value, &[human], &[])
}

pub fn remove<W: Write, E: Write>(
    parsed: &cli_parse::Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let name = parsed.words.first().copied().unwrap_or("");
    let home = match home_of(COMMAND_REMOVE) {
        Ok(home) => home,
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    let mut store = match super::store::open(home.path(), COMMAND_REMOVE) {
        Ok(store) => store,
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    if name != "local" {
        let known = match store.list(COMMAND_REMOVE) {
            Ok(profiles) => profiles,
            Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
        };
        if !known.iter().any(|profile| profile.name.as_str() == name) {
            return crate::run::fail(
                out,
                err,
                Some(&parsed.flags),
                &no_profile(name, COMMAND_REMOVE),
            );
        }
    }
    if let Err(failure) = store.remove(name, COMMAND_REMOVE) {
        return crate::run::fail(out, err, Some(&parsed.flags), &failure);
    }
    let value = json!({"removed": name});
    let human = [format!("Removed {name}.")];
    let quiet: &[String] = &[];
    answer(out, err, &parsed.flags, &value, &human, quiet)
}

/// The one in use marked, then the rest.
fn remote_list_lines(value: &Value) -> Vec<String> {
    let active = value
        .get("active")
        .and_then(Value::as_str)
        .unwrap_or("local");
    let profiles = value
        .get("profiles")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut rows = vec![vec![
        Some(mark("local", active)),
        Some("local".to_owned()),
        Some("this machine".to_owned()),
        None,
    ]];
    for profile in &profiles {
        let name = profile.get("name").and_then(Value::as_str).unwrap_or("");
        rows.push(vec![
            Some(mark(name, active)),
            Some(name.to_owned()),
            Some(where_of(profile)),
            profile
                .get("label")
                .and_then(Value::as_str)
                .map(str::to_owned),
        ]);
    }
    let mut lines = columns(&rows);
    if profiles.is_empty() {
        lines.push(String::new());
        lines.push("Add another machine with ace remote add NAME --link URL.".to_owned());
    }
    lines
}

fn remote_names(value: &Value) -> Vec<String> {
    value
        .get("profiles")
        .and_then(Value::as_array)
        .map(|profiles| {
            profiles
                .iter()
                .filter_map(|profile| profile.get("name").and_then(Value::as_str))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}
