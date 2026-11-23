// SPDX-License-Identifier: Apache-2.0
//! Spade's task manager: `ace bot running|stop|pause|resume|unarchive`.

use std::io::{IsTerminal as _, Write};

use cli_out::{Env, Failure, Out, Outcome, OutputMode, Stream, Terminal, use_color};
use cli_parse::Parsed;
use cli_wire::Connection;
use serde::Serialize;

use super::bot_parse::{RunningBot, parse_running_bot};
use super::bot_render::{bot_action_words, running_lines};
use super::common;
use crate::commands::work::common::{connect, mode, timeout_duration};
use crate::run::fail;
pub fn run_running<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    run_list(parsed, out, err, "bot.running")
}

fn run_list<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
    command: &'static str,
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
    match list_running(&mut conn, timeout, command) {
        Ok(bots) => render_running(&bots, output, colour, out, err, command),
        Err(failure) => fail(
            out,
            err,
            Some(&parsed.flags),
            &failure.with_command(parsed.command.id),
        ),
    }
}

pub fn run_action<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
    action: &'static str,
    command: &'static str,
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
    match act_on_bot(&mut conn, timeout, reference, action, command) {
        Ok(result) => render_action(&result, output, out, err, command),
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

/* Rows from `GET /v1/running`, read leniently as the web page does. */

#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
pub(crate) fn list_running(
    conn: &mut Connection,
    timeout: std::time::Duration,
    command: &'static str,
) -> Result<Vec<RunningBot>, Failure<'static>> {
    let (_, body) = common::spade_call(conn, timeout, "GET", "/v1/running", None, command)
        .map_err(|failure| failure.with_command(command))?;
    parse_running(&body).ok_or_else(|| {
        Failure::new(
            Outcome::Uncertain,
            "Spade's answer had no running list in it.",
        )
        .with_code(cli_out::ErrorCode::Uncertain)
        .with_command(command)
    })
}
pub(crate) fn parse_running(body: &str) -> Option<Vec<RunningBot>> {
    let parsed: serde_json::Value = serde_json::from_str(body).ok()?;
    let list = parsed.get("bots")?.as_array()?;
    Some(list.iter().filter_map(parse_running_bot).collect())
}

#[derive(Serialize)]
pub(crate) struct BotAction {
    pub(crate) bot: String,
    pub(crate) name: String,
    pub(crate) action: String,
    pub(crate) changed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) now: Option<RunningBot>,
}

/// Stops, pauses, resumes or unarchives the bot `reference` names.
#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
pub(crate) fn act_on_bot(
    conn: &mut Connection,
    timeout: std::time::Duration,
    reference: Option<&str>,
    action: &str,
    command: &'static str,
) -> Result<BotAction, Failure<'static>> {
    let (_, agents_body) = common::spade_call(conn, timeout, "GET", "/v1/agents", None, command)
        .map_err(|failure| failure.with_command(command))?;
    let agents = super::spade_parse::parse_agents(&agents_body).ok_or_else(|| {
        Failure::new(Outcome::Uncertain, "Spade's answer had no bots in it.")
            .with_code(cli_out::ErrorCode::Uncertain)
            .with_command(command)
    })?;
    let bot = super::spade_parse::find_bot(&agents, reference, command)?;
    let path = format!("/v1/agents/{}/{}", percent_encode(&bot.id), action);
    let (_, answer) = common::spade_call(conn, timeout, "POST", &path, Some("{}"), command)
        .map_err(|failure| failure.with_command(command))?;
    let parsed: serde_json::Value = serde_json::from_str(&answer).map_err(|_| {
        Failure::new(
            Outcome::Uncertain,
            "Spade's answer had no running list in it.",
        )
        .with_code(cli_out::ErrorCode::Uncertain)
        .with_command(command)
    })?;
    let Some(bots) = parsed.get("bots").and_then(serde_json::Value::as_array) else {
        return Err(Failure::new(
            Outcome::Uncertain,
            "Spade's answer had no running list in it.",
        )
        .with_code(cli_out::ErrorCode::Uncertain)
        .with_command(command));
    };
    let changed = parsed
        .get("changed")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let now = bots
        .iter()
        .filter_map(parse_running_bot)
        .find(|row| row.id == bot.id);
    Ok(BotAction {
        bot: bot.id.clone(),
        name: bot.name.clone(),
        action: action.to_owned(),
        changed,
        now,
    })
}

/// Enough encoding for a bot id in a Spade path: what the daemon wouldn't take raw.
fn percent_encode(id: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(id.len());
    for byte in id.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push('%');
            encoded.push(char::from(HEX[(byte >> 4) as usize]));
            encoded.push(char::from(HEX[(byte & 0x0f) as usize]));
        }
    }
    encoded
}
fn render_running<W: Write, E: Write>(
    bots: &[RunningBot],
    output: OutputMode,
    colour: bool,
    out: &mut Out<W>,
    err: &mut Out<E>,
    command: &'static str,
) -> Outcome {
    match output {
        OutputMode::Json => match out.json(bots) {
            Ok(()) => Outcome::Ok,
            Err(error) => common::write_failed(command, &error, out, err),
        },
        OutputMode::Human => {
            let lines = running_lines(bots, common::current_millis(), colour, None);
            match lines.iter().try_for_each(|line| out.line(line)) {
                Ok(()) => Outcome::Ok,
                Err(error) => common::write_failed(command, &error, out, err),
            }
        }
        OutputMode::Quiet => {
            let ids: Vec<&str> = bots.iter().map(|bot| bot.id.as_str()).collect();
            match ids.iter().try_for_each(|id| out.line(id)) {
                Ok(()) => Outcome::Ok,
                Err(error) => common::write_failed(command, &error, out, err),
            }
        }
    }
}
fn render_action<W: Write, E: Write>(
    result: &BotAction,
    output: OutputMode,
    out: &mut Out<W>,
    err: &mut Out<E>,
    command: &'static str,
) -> Outcome {
    match output {
        OutputMode::Json => match out.json(result) {
            Ok(()) => Outcome::Ok,
            Err(error) => common::write_failed(command, &error, out, err),
        },
        OutputMode::Human => match out.line(&bot_action_words(result)) {
            Ok(()) => Outcome::Ok,
            Err(error) => common::write_failed(command, &error, out, err),
        },
        OutputMode::Quiet => match out.line(&result.bot) {
            Ok(()) => Outcome::Ok,
            Err(error) => common::write_failed(command, &error, out, err),
        },
    }
}
