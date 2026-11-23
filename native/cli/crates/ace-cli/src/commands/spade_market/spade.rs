// SPDX-License-Identifier: Apache-2.0
//! Spade's state and bots: `ace spade status`, `ace spade bot list|show`.

use std::io::{IsTerminal as _, Write};

use cli_out::{Env, ErrorCode, Failure, Out, Outcome, OutputMode, Stream, Terminal, use_color};
use cli_parse::Parsed;
use cli_wire::Connection;
use serde::Serialize;

use super::common;
use super::spade_render::{render_bot, render_bot_list, spade_state_lines};
use crate::commands::work::common::{connect, mode, timeout_duration, wire_failure};
use crate::run::fail;
pub(crate) const COMMAND_STATUS: &str = "spade.status";
pub(crate) const COMMAND_LIST: &str = "spade.bot.list";
pub(crate) const COMMAND_SHOW: &str = "spade.bot.show";
pub fn run_status<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let timeout = match timeout_duration(&parsed.flags) {
        Ok(timeout) => timeout,
        Err(failure) => {
            return fail(
                out,
                err,
                Some(&parsed.flags),
                &failure.with_command(parsed.command.id),
            );
        }
    };
    let output = mode(parsed);
    let colour = stdout_colour(&parsed.flags);
    match read_state(timeout) {
        Ok(state) => render_state(&state, output, colour, out, err),
        Err(failure) => fail(
            out,
            err,
            Some(&parsed.flags),
            &failure.with_command(parsed.command.id),
        ),
    }
}

pub fn run_bot_list<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let timeout = match timeout_duration(&parsed.flags) {
        Ok(timeout) => timeout,
        Err(failure) => {
            return fail(
                out,
                err,
                Some(&parsed.flags),
                &failure.with_command(parsed.command.id),
            );
        }
    };
    let output = mode(parsed);
    let colour = stdout_colour(&parsed.flags);
    let mut conn = match connect(&parsed.flags, timeout) {
        Ok(conn) => conn,
        Err(failure) => {
            return fail(
                out,
                err,
                Some(&parsed.flags),
                &failure.with_command(parsed.command.id),
            );
        }
    };
    match super::spade_parse::list_bots(&mut conn, timeout, COMMAND_LIST) {
        Ok(bots) => render_bot_list(&bots, output, colour, out, err),
        Err(failure) => fail(
            out,
            err,
            Some(&parsed.flags),
            &failure.with_command(parsed.command.id),
        ),
    }
}

pub fn run_bot_show<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let timeout = match timeout_duration(&parsed.flags) {
        Ok(timeout) => timeout,
        Err(failure) => {
            return fail(
                out,
                err,
                Some(&parsed.flags),
                &failure.with_command(parsed.command.id),
            );
        }
    };
    let output = mode(parsed);
    let colour = stdout_colour(&parsed.flags);
    let reference = parsed.words.first().copied();
    let mut conn = match connect(&parsed.flags, timeout) {
        Ok(conn) => conn,
        Err(failure) => {
            return fail(
                out,
                err,
                Some(&parsed.flags),
                &failure.with_command(parsed.command.id),
            );
        }
    };
    let bots = match super::spade_parse::list_bots(&mut conn, timeout, COMMAND_SHOW) {
        Ok(bots) => bots,
        Err(failure) => {
            return fail(
                out,
                err,
                Some(&parsed.flags),
                &failure.with_command(parsed.command.id),
            );
        }
    };
    match super::spade_parse::find_bot(&bots, reference, COMMAND_SHOW) {
        Ok(bot) => render_bot(&bot, output, colour, out, err),
        Err(failure) => fail(
            out,
            err,
            Some(&parsed.flags),
            &failure.with_command(parsed.command.id),
        ),
    }
}
fn stdout_colour(flags: &cli_out::Flags<'_>) -> bool {
    let env = Env::from_process();
    let terminal = Terminal {
        stdin: false,
        stdout: std::io::stdout().is_terminal(),
        stderr: false,
    };
    use_color(flags, &env, terminal, Stream::Stdout)
}

/* Spade's state: the daemon's answers when one runs, the home's files otherwise. */

#[derive(Serialize)]
struct SpadeState {
    beta: bool,
    enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<serde_json::Value>,
    live: bool,
}

#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn read_state(timeout: std::time::Duration) -> Result<SpadeState, Failure<'static>> {
    let empty = cli_out::Flags::new();
    let mut conn = match connect(&empty, timeout) {
        Ok(conn) => conn,
        Err(failure) => {
            if failure.code == ErrorCode::DaemonDown {
                return offline_state();
            }
            return Err(failure);
        }
    };
    let beta = setting_on(&mut conn, "beta.spade", timeout)?;
    let enabled = setting_on(&mut conn, "spade.enabled", timeout)?;
    let status = spade_status(&mut conn, timeout)?;
    Ok(SpadeState {
        beta,
        enabled,
        status: Some(status),
        live: true,
    })
}

#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn offline_state() -> Result<SpadeState, Failure<'static>> {
    let home =
        cli_wire::Home::from_env().map_err(|err| wire_failure(&err, Some(COMMAND_STATUS)))?;
    let beta = match super::feature::boolean_at_rest(home.path(), "beta.spade") {
        Some(on) => on,
        None => super::feature::legacy_spade(home.path()),
    };
    let enabled = super::feature::boolean_at_rest(home.path(), "spade.enabled").unwrap_or(false);
    Ok(SpadeState {
        beta,
        enabled,
        status: None,
        live: false,
    })
}

#[derive(serde::Deserialize)]
struct SettingsResult<'a> {
    #[serde(borrow, default)]
    entries: Vec<SettingsEntry<'a>>,
}

#[derive(serde::Deserialize)]
struct SettingsEntry<'a> {
    #[serde(borrow, default)]
    key: &'a str,
    #[serde(default)]
    value: serde_json::Value,
}

#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn setting_on(
    conn: &mut Connection,
    key: &str,
    timeout: std::time::Duration,
) -> Result<bool, Failure<'static>> {
    let frame = serde_json::json!({"type": "settings.get", "key": key, "scope": {}});
    let reply = conn
        .request_with_timeout(&frame, timeout)
        .map_err(|err| wire_failure(&err, Some(COMMAND_STATUS)))?;
    let result: SettingsResult<'_> = reply
        .decode()
        .map_err(|err| wire_failure(&err, Some(COMMAND_STATUS)))?;
    Ok(result
        .entries
        .iter()
        .find(|entry| entry.key == key)
        .is_some_and(|entry| entry.value == serde_json::Value::Bool(true)))
}

#[derive(serde::Deserialize)]
struct SpadeStatusResult {
    #[serde(default)]
    status: serde_json::Value,
}

#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn spade_status(
    conn: &mut Connection,
    timeout: std::time::Duration,
) -> Result<serde_json::Value, Failure<'static>> {
    let frame = serde_json::json!({"type": "spade.status"});
    let reply = conn
        .request_with_timeout(&frame, timeout)
        .map_err(|err| wire_failure(&err, Some(COMMAND_STATUS)))?;
    let result: SpadeStatusResult = reply
        .decode()
        .map_err(|err| wire_failure(&err, Some(COMMAND_STATUS)))?;
    Ok(result.status)
}
fn render_state<W: Write, E: Write>(
    state: &SpadeState,
    output: OutputMode,
    colour: bool,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    match output {
        OutputMode::Json => match out.json(state) {
            Ok(()) => Outcome::Ok,
            Err(error) => common::write_failed(COMMAND_STATUS, &error, out, err),
        },
        OutputMode::Human => {
            let value = serde_json::to_value(state).unwrap_or_default();
            match spade_state_lines(&value, colour)
                .iter()
                .try_for_each(|line| out.line(line))
            {
                Ok(()) => Outcome::Ok,
                Err(error) => common::write_failed(COMMAND_STATUS, &error, out, err),
            }
        }
        OutputMode::Quiet => Outcome::Ok,
    }
}
