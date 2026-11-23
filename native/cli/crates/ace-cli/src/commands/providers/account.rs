// SPDX-License-Identifier: Apache-2.0
//! `ace account status|logout` and `ace account machine-code clear`: this machine's ace
//! account over the local daemon's `/v1/*` HTTP endpoints.

use std::io::Write;

use cli_out::{Out, Outcome};
use cli_wire::{DEFAULT_HTTP_TIMEOUT, Home, HttpMethod, TcpProbe, http_request_local, reach_local};
use serde_json::Value;

use super::session::{CommandResult, answer_shaped, wire_failure};

const COMMAND_STATUS: &str = "account.status";
const COMMAND_LOGOUT: &str = "account.logout";
const COMMAND_CODE_CLEAR: &str = "account.machine-code.clear";

fn http_home(command: &'static str) -> CommandResult<Home> {
    Home::from_env().map_err(|_| {
        Box::new(
            cli_out::Failure::new(Outcome::Refused, "ace isn't running.")
                .with_code(cli_out::ErrorCode::DaemonDown)
                .with_hint("Start it with ace start, or open the app.")
                .with_command(command),
        )
    })
}

fn http_status(
    command: &'static str,
    method: HttpMethod,
    path: &str,
) -> CommandResult<(Value, String)> {
    let home = http_home(command)?;
    let local =
        reach_local(&home, &TcpProbe).map_err(|error| Box::new(wire_failure(&error, command)))?;
    let response = http_request_local(&local, method, path, None, DEFAULT_HTTP_TIMEOUT)
        .map_err(|error| Box::new(wire_failure(&error, command)))?;
    let raw = response.as_str().to_owned();
    let value: Value = response
        .decode()
        .map_err(|error| Box::new(wire_failure(&error, command)))?;
    Ok((value, raw))
}

pub fn status<W: Write, E: Write>(
    parsed: &cli_parse::Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let (status, raw) = match http_status(COMMAND_STATUS, HttpMethod::Get, "/v1/ace-account") {
        Ok(shaped) => shaped,
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    let human = ace_account_lines(&status);
    let quiet: &[String] = &[];
    answer_shaped(out, err, &parsed.flags, &status, Some(&raw), &human, quiet)
}

pub fn logout<W: Write, E: Write>(
    parsed: &cli_parse::Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let (status, raw) = match http_status(COMMAND_LOGOUT, HttpMethod::Delete, "/v1/ace-account") {
        Ok(shaped) => shaped,
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    let human = ["Signed out of ace on this machine.".to_owned()];
    let quiet: &[String] = &[];
    answer_shaped(out, err, &parsed.flags, &status, Some(&raw), &human, quiet)
}

pub fn machine_code_clear<W: Write, E: Write>(
    parsed: &cli_parse::Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let (status, raw) =
        match http_status(COMMAND_CODE_CLEAR, HttpMethod::Delete, "/v1/machine-code") {
            Ok(shaped) => shaped,
            Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
        };
    let human = ["Machine code cleared.".to_owned()];
    let quiet: &[String] = &[];
    answer_shaped(out, err, &parsed.flags, &status, Some(&raw), &human, quiet)
}

/// This machine's ace account for a person.
fn ace_account_lines(status: &Value) -> Vec<String> {
    let signed_in = status.get("signedIn").and_then(Value::as_bool) == Some(true);
    let who = status
        .get("account")
        .and_then(|account| account.get("email"))
        .and_then(Value::as_str);
    let mut lines = vec![if signed_in {
        who.map_or_else(
            || "Signed in to ace.".to_owned(),
            |email| format!("Signed in to ace as {email}."),
        )
    } else if status.get("login").is_some_and(|login| !login.is_null()) {
        "Signing in to ace: finish in the browser.".to_owned()
    } else {
        "Not signed in to ace. Sign in with ace login.".to_owned()
    }];
    if let Some(url) = status
        .get("login")
        .and_then(|login| login.get("url"))
        .and_then(Value::as_str)
    {
        lines.push(url.to_owned());
    }
    if signed_in {
        let set = status
            .get("machineCode")
            .and_then(|code| code.get("set"))
            .and_then(Value::as_bool)
            == Some(true);
        lines.push(
            if set {
                "Machine code set: devices on your account enter it once."
            } else {
                "No machine code. Set one with ace account machine-code set."
            }
            .to_owned(),
        );
    }
    lines
}
