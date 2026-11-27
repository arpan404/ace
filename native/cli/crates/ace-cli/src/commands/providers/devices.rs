// SPDX-License-Identifier: Apache-2.0
//! `ace device list|revoke`: who is paired with this machine.

use std::fmt::Write as _;
use std::io::Write;

use cli_out::{ErrorCode, Failure, Out, Outcome};
use cli_wire::{DEFAULT_HTTP_TIMEOUT, Home, HttpMethod, TcpProbe, http_request_local, reach_local};
use serde_json::Value;

use super::render::{columns, format_age, format_ago};
use super::session::{CommandResult, answer_shaped, wire_failure};

const COMMAND_LIST: &str = "device.list";
const COMMAND_REVOKE: &str = "device.revoke";

fn http_home(command: &'static str) -> CommandResult<Home> {
    Home::from_env().map_err(|_| {
        Box::new(
            Failure::new(Outcome::Refused, "ace isn't running.")
                .with_code(ErrorCode::DaemonDown)
                .with_hint("Start it with ace start, or open the app.")
                .with_command(command),
        )
    })
}

pub fn list<W: Write, E: Write>(
    parsed: &cli_parse::Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let home = match http_home(COMMAND_LIST) {
        Ok(home) => home,
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    let local = match reach_local(&home, &TcpProbe) {
        Ok(local) => local,
        Err(error) => {
            return crate::run::fail(
                out,
                err,
                Some(&parsed.flags),
                &wire_failure(&error, COMMAND_LIST),
            );
        }
    };
    let response = match http_request_local(
        &local,
        HttpMethod::Get,
        "/v1/devices",
        None,
        DEFAULT_HTTP_TIMEOUT,
    ) {
        Ok(response) => response,
        Err(error) => {
            return crate::run::fail(
                out,
                err,
                Some(&parsed.flags),
                &wire_failure(&error, COMMAND_LIST),
            );
        }
    };
    let raw = response.as_str().to_owned();
    let devices: Value = match response.decode() {
        Ok(devices) => devices,
        Err(error) => {
            return crate::run::fail(
                out,
                err,
                Some(&parsed.flags),
                &wire_failure(&error, COMMAND_LIST),
            );
        }
    };
    let human = device_list_lines(&devices, super::render::now_ms());
    let quiet = device_ids(&devices);
    answer_shaped(
        out,
        err,
        &parsed.flags,
        &devices,
        Some(&raw),
        &human,
        &quiet,
    )
}

pub fn revoke<W: Write, E: Write>(
    parsed: &cli_parse::Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let id = parsed.words.first().copied().unwrap_or("");
    let home = match http_home(COMMAND_REVOKE) {
        Ok(home) => home,
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    let local = match reach_local(&home, &TcpProbe) {
        Ok(local) => local,
        Err(error) => {
            return crate::run::fail(
                out,
                err,
                Some(&parsed.flags),
                &wire_failure(&error, COMMAND_REVOKE),
            );
        }
    };
    let path = format!("/v1/devices/{}", encode_device_id(id));
    let response = match http_request_local(
        &local,
        HttpMethod::Delete,
        &path,
        None,
        DEFAULT_HTTP_TIMEOUT,
    ) {
        Ok(response) => response,
        Err(error) => {
            if error.to_string().starts_with("HTTP 404") {
                return crate::run::fail(
                    out,
                    err,
                    Some(&parsed.flags),
                    &Failure::new(Outcome::Refused, format!("No paired device {id}."))
                        .with_code(ErrorCode::NotFound)
                        .with_hint("See them with ace device list.")
                        .with_command(COMMAND_REVOKE),
                );
            }
            return crate::run::fail(
                out,
                err,
                Some(&parsed.flags),
                &wire_failure(&error, COMMAND_REVOKE),
            );
        }
    };
    let raw = response.as_str().to_owned();
    let revoked: Value = match response.decode() {
        Ok(revoked) => revoked,
        Err(error) => {
            return crate::run::fail(
                out,
                err,
                Some(&parsed.flags),
                &wire_failure(&error, COMMAND_REVOKE),
            );
        }
    };
    let human = [format!("Revoked {id}.")];
    let quiet: &[String] = &[];
    answer_shaped(out, err, &parsed.flags, &revoked, Some(&raw), &human, quiet)
}

fn encode_device_id(id: &str) -> String {
    let mut encoded = String::with_capacity(id.len());
    for byte in id.bytes() {
        if matches!(byte, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')')
        {
            encoded.push(byte as char);
        } else {
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}

/// Paired devices for a person; revoked ones stay in `--json` only.
fn device_list_lines(devices: &Value, now: i64) -> Vec<String> {
    let all = devices.as_array().cloned().unwrap_or_default();
    let shown: Vec<&Value> = all
        .iter()
        .filter(|device| device.get("revokedAt").is_some_and(Value::is_null))
        .collect();
    let revoked = all.len().saturating_sub(shown.len());
    if shown.is_empty() {
        let mut lines = vec!["No devices paired. Pair one with ace device pair.".to_owned()];
        if revoked > 0 {
            lines.push(format!("{revoked} revoked."));
        }
        return lines;
    }
    let mut lines = columns(
        &shown
            .iter()
            .map(|device| {
                vec![
                    device.get("id").and_then(Value::as_str).map(str::to_owned),
                    device
                        .get("name")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    device
                        .get("lastSeenAt")
                        .and_then(super::render::as_i64)
                        .map(|seen| format!("seen {}", format_ago(seen, now))),
                    device
                        .get("expiresAt")
                        .and_then(super::render::as_i64)
                        .map(|at| expiry(at, now)),
                ]
            })
            .collect::<Vec<_>>(),
    );
    if revoked > 0 {
        lines.push(String::new());
        lines.push(format!(
            "{revoked} revoked. Their records stay; --json lists them."
        ));
    }
    lines
}

fn expiry(at: i64, now: i64) -> String {
    if at <= now {
        "access ended".to_owned()
    } else {
        format!("access ends in {}", format_age(now, at))
    }
}

fn device_ids(devices: &Value) -> Vec<String> {
    devices
        .as_array()
        .map(|all| {
            all.iter()
                .filter(|device| device.get("revokedAt").is_some_and(Value::is_null))
                .filter_map(|device| device.get("id").and_then(Value::as_str))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}
