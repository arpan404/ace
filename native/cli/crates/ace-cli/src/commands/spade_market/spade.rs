// SPDX-License-Identifier: Apache-2.0
//! Spade's state and bots: `ace spade status`, `ace spade bot list|show`.

use std::io::{IsTerminal as _, Write};

use cli_out::{Env, ErrorCode, Failure, Out, Outcome, OutputMode, Stream, Terminal, use_color};
use cli_parse::Parsed;
use cli_wire::Connection;
use serde::Serialize;

use super::common;
use crate::commands::work::common::{connect, mode, timeout_duration, wire_failure};
use crate::run::fail;

const COMMAND_STATUS: &str = "spade.status";
const COMMAND_LIST: &str = "spade.bot.list";
const COMMAND_SHOW: &str = "spade.bot.show";

pub fn run_status<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let timeout = match timeout_duration(&parsed.flags) {
        Ok(timeout) => timeout,
        Err(failure) => return fail(out, err, Some(&parsed.flags), &failure),
    };
    let output = mode(parsed);
    let colour = stdout_colour(&parsed.flags);
    match read_state(timeout) {
        Ok(state) => render_state(&state, output, colour, out, err),
        Err(failure) => fail(out, err, Some(&parsed.flags), &failure),
    }
}

pub fn run_bot_list<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let timeout = match timeout_duration(&parsed.flags) {
        Ok(timeout) => timeout,
        Err(failure) => return fail(out, err, Some(&parsed.flags), &failure),
    };
    let output = mode(parsed);
    let colour = stdout_colour(&parsed.flags);
    let mut conn = match connect(&parsed.flags, timeout) {
        Ok(conn) => conn,
        Err(failure) => return fail(out, err, Some(&parsed.flags), &failure),
    };
    match list_bots(&mut conn, timeout, COMMAND_LIST) {
        Ok(bots) => render_bot_list(&bots, output, colour, out, err),
        Err(failure) => fail(out, err, Some(&parsed.flags), &failure),
    }
}

pub fn run_bot_show<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let timeout = match timeout_duration(&parsed.flags) {
        Ok(timeout) => timeout,
        Err(failure) => return fail(out, err, Some(&parsed.flags), &failure),
    };
    let output = mode(parsed);
    let colour = stdout_colour(&parsed.flags);
    let reference = parsed.words.first().copied();
    let mut conn = match connect(&parsed.flags, timeout) {
        Ok(conn) => conn,
        Err(failure) => return fail(out, err, Some(&parsed.flags), &failure),
    };
    let bots = match list_bots(&mut conn, timeout, COMMAND_SHOW) {
        Ok(bots) => bots,
        Err(failure) => return fail(out, err, Some(&parsed.flags), &failure),
    };
    match find_bot(&bots, reference, COMMAND_SHOW) {
        Ok(bot) => render_bot(&bot, output, colour, out, err),
        Err(failure) => fail(out, err, Some(&parsed.flags), &failure),
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

fn spade_state_lines(state: &serde_json::Value, colour: bool) -> Vec<String> {
    let beta = state
        .get("beta")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let enabled = state
        .get("enabled")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    if !beta {
        return vec![
            "Spade is hidden: Settings › Beta has it off.".to_owned(),
            "Turn it on with ace spade on.".to_owned(),
        ];
    }
    if !enabled {
        return vec![
            "Spade is off.".to_owned(),
            "Turn it on with ace spade on.".to_owned(),
        ];
    }
    let live = state
        .get("live")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    if !live {
        return vec!["Spade is on. It starts when the ace daemon runs (ace start).".to_owned()];
    }
    let Some(status) = state.get("status").filter(|status| !status.is_null()) else {
        return vec!["Spade is on.".to_owned()];
    };
    let version = status
        .get("version")
        .and_then(serde_json::Value::as_str)
        .map_or_else(String::new, |version| format!(" (Spade {version})"));
    let mut lines = Vec::new();
    match status.get("state").and_then(serde_json::Value::as_str) {
        Some("ready") => {
            if let Some(reason) = status
                .get("setup")
                .and_then(|setup| setup.get("reason"))
                .and_then(serde_json::Value::as_str)
            {
                lines.push(format!("Spade is setting up: {reason}."));
            } else {
                lines.push(format!("Spade is on and ready{version}."));
            }
        }
        Some("starting") => lines.push("Spade is starting.".to_owned()),
        Some("failed") => {
            lines.push(red(
                &format!("✕ Spade failed{}", off_reason(status)),
                colour,
            ));
        }
        _ => {
            lines.push(format!("Spade is off{}", off_reason(status)));
        }
    }
    if let Some(thread) = status.get("thread")
        && thread.get("busy").and_then(serde_json::Value::as_bool) == Some(true)
    {
        let id = thread
            .get("id")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        lines.push(format!("Its host thread {id} is working."));
    }
    if status
        .get("grant")
        .and_then(|grant| grant.get("state"))
        .and_then(serde_json::Value::as_str)
        == Some("revoked")
    {
        lines.push(
            "Its grant for ace's tools is revoked; turn Spade off and on to make a new one."
                .to_owned(),
        );
    }
    if status.get("state").and_then(serde_json::Value::as_str) == Some("failed") {
        lines.push("See why with ace logs, or run ace doctor.".to_owned());
    }
    lines
}

fn off_reason(status: &serde_json::Value) -> String {
    match status.get("reason").and_then(serde_json::Value::as_str) {
        Some(reason) if !reason.is_empty() => format!(": {reason}"),
        _ => ".".to_owned(),
    }
}

fn red(text: &str, colour: bool) -> String {
    if colour {
        format!("\u{1b}[31m{text}\u{1b}[39m")
    } else {
        text.to_owned()
    }
}

fn amber(text: &str, colour: bool) -> String {
    if colour {
        format!("\u{1b}[33m{text}\u{1b}[39m")
    } else {
        text.to_owned()
    }
}

/* Spade's bots, through the daemon's `spade.http` forwarding. */

#[derive(Clone, Serialize)]
struct BotLastMessage {
    from: String,
    text: String,
    at: i64,
}

#[derive(Clone, Serialize)]
struct BotParent {
    id: String,
    name: String,
}

#[derive(Clone, Serialize)]
pub(crate) struct Bot {
    pub(crate) id: String,
    pub(crate) name: String,
    kind: String,
    task: String,
    model: String,
    conversation: String,
    state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    waiting_for: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    problem: Option<String>,
    unseen: bool,
    pinned: bool,
    #[serde(rename = "lastActivity")]
    last_activity: i64,
    #[serde(rename = "lastMessage", skip_serializing_if = "Option::is_none")]
    last_message: Option<BotLastMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent: Option<BotParent>,
}

#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn list_bots(
    conn: &mut Connection,
    timeout: std::time::Duration,
    command: &'static str,
) -> Result<Vec<Bot>, Failure<'static>> {
    let (_, body) = common::spade_call(conn, timeout, "GET", "/v1/agents", None, command)
        .map_err(|failure| failure.with_command(command))?;
    parse_agents(&body).ok_or_else(|| {
        Failure::new(Outcome::Uncertain, "Spade's answer had no bots in it.")
            .with_code(ErrorCode::Uncertain)
            .with_command(command)
    })
}

fn json_number(value: &serde_json::Value) -> i64 {
    if let Some(int) = value.as_i64() {
        return int;
    }
    if let Some(uint) = value.as_u64() {
        return i64::try_from(uint).unwrap_or(0);
    }
    value.as_f64().map_or(0, round_to_i64)
}

/// A JSON number as an integer, saturating on the way in.
#[allow(
    clippy::cast_possible_truncation,
    reason = "float-to-int `as` saturates; timestamps and counts fit"
)]
fn round_to_i64(number: f64) -> i64 {
    number.round() as i64
}

fn json_string(value: Option<&serde_json::Value>) -> String {
    value
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_owned()
}

pub(crate) fn parse_agents(body: &str) -> Option<Vec<Bot>> {
    let parsed: serde_json::Value = serde_json::from_str(body).ok()?;
    let list = parsed.get("agents")?.as_array()?;
    let mut bots = Vec::new();
    for raw in list {
        let id = raw.get("id")?.as_str()?;
        if id.is_empty() {
            continue;
        }
        let conversation = raw.get("conversation")?.as_str()?;
        if conversation.is_empty() {
            continue;
        }
        let kind = match raw.get("kind").and_then(serde_json::Value::as_str) {
            Some("main") => "main",
            _ => "bot",
        };
        let main = kind == "main";
        let name = if main {
            "Spade".to_owned()
        } else {
            let name = json_string(raw.get("name"));
            if name.is_empty() {
                "Bot".to_owned()
            } else {
                name
            }
        };
        let state = match raw.get("state").and_then(serde_json::Value::as_str) {
            Some(state @ ("idle" | "working" | "waiting" | "paused" | "updating")) => {
                state.to_owned()
            }
            _ => {
                if raw.get("working").and_then(serde_json::Value::as_bool) == Some(true) {
                    "working".to_owned()
                } else {
                    "idle".to_owned()
                }
            }
        };
        let waiting_for = match raw.get("waiting_for").and_then(serde_json::Value::as_str) {
            Some(waiting @ ("approval" | "question" | "worker" | "callee")) => {
                Some(waiting.to_owned())
            }
            _ => None,
        };
        let status = match raw.get("status").and_then(serde_json::Value::as_str) {
            Some(status) if !status.is_empty() => Some(status.to_owned()),
            _ => None,
        };
        let problem = match raw.get("problem").and_then(serde_json::Value::as_str) {
            Some(problem) if !problem.is_empty() => Some(problem.to_owned()),
            _ => None,
        };
        let last_message = parse_last_message(raw.get("last_message"));
        let parent = parse_parent(raw.get("parent"));
        bots.push(Bot {
            id: id.to_owned(),
            kind: kind.to_owned(),
            name,
            task: raw
                .get("task")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_owned(),
            model: json_string(raw.get("model")),
            conversation: conversation.to_owned(),
            state,
            waiting_for,
            status,
            problem,
            unseen: raw
                .get("unseen")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            pinned: raw.get("pinned_at").is_some_and(|pinned| !pinned.is_null()),
            last_activity: raw.get("last_activity").map_or(0, json_number),
            last_message,
            parent,
        });
    }
    Some(bots)
}

fn parse_last_message(last: Option<&serde_json::Value>) -> Option<BotLastMessage> {
    let last = last?;
    if last.is_null() {
        return None;
    }
    let from = match last.get("from").and_then(serde_json::Value::as_str) {
        Some("person") => "person",
        _ => "agent",
    };
    Some(BotLastMessage {
        from: from.to_owned(),
        text: json_string(last.get("text")),
        at: last.get("at").map_or(0, json_number),
    })
}

fn parse_parent(parent: Option<&serde_json::Value>) -> Option<BotParent> {
    let parent = parent?;
    if parent.is_null() {
        return None;
    }
    let id = parent.get("id")?.as_str()?;
    if id.is_empty() {
        return None;
    }
    Some(BotParent {
        id: id.to_owned(),
        name: json_string(parent.get("name")),
    })
}

/// A BOT argument: an id, a name (any case), or an unambiguous start of either.
#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
pub(crate) fn find_bot(
    bots: &[Bot],
    reference: Option<&str>,
    command: &'static str,
) -> Result<Bot, Failure<'static>> {
    let Some(reference) = reference else {
        if let Some(main) = bots.iter().find(|bot| bot.kind == "main") {
            return Ok(main.clone());
        }
        return Err(Failure::new(Outcome::Refused, "Spade has no main bot yet.")
            .with_code(ErrorCode::NotFound)
            .with_hint("Name a bot: see them with ace spade bot list.")
            .with_command(command));
    };
    let typed = reference.to_lowercase();
    let exact: Vec<&Bot> = bots
        .iter()
        .filter(|bot| bot.id == reference || bot.name.to_lowercase() == typed)
        .collect();
    if exact.len() == 1
        && let Some(only) = exact.first()
    {
        return Ok((*only).clone());
    }
    let starts: Vec<&Bot> = bots
        .iter()
        .filter(|bot| bot.id.starts_with(reference) || bot.name.to_lowercase().starts_with(&typed))
        .collect();
    if starts.len() == 1
        && let Some(only) = starts.first()
    {
        return Ok((*only).clone());
    }
    if starts.len() > 1 || exact.len() > 1 {
        let ids: Vec<&str> = exact
            .iter()
            .chain(starts.iter())
            .map(|bot| bot.id.as_str())
            .collect();
        return Err(
            Failure::usage(format!("More than one bot matches {reference}."))
                .with_code(ErrorCode::BadArgument)
                .with_argument("BOT")
                .with_hint(format!("Use its id: {}.", ids.join(", ")))
                .with_command(command),
        );
    }
    Err(
        Failure::new(Outcome::Refused, format!("Spade has no bot {reference}."))
            .with_code(ErrorCode::NotFound)
            .with_argument("BOT")
            .with_hint("See your bots with ace spade bot list.")
            .with_command(command),
    )
}

fn render_bot_list<W: Write, E: Write>(
    bots: &[Bot],
    output: OutputMode,
    colour: bool,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let ordered = bot_order(bots);
    match output {
        OutputMode::Json => match out.json(&ordered) {
            Ok(()) => Outcome::Ok,
            Err(error) => common::write_failed(COMMAND_LIST, &error, out, err),
        },
        OutputMode::Human => {
            let lines = bot_list_lines(&ordered, common::current_millis(), colour);
            match lines.iter().try_for_each(|line| out.line(line)) {
                Ok(()) => Outcome::Ok,
                Err(error) => common::write_failed(COMMAND_LIST, &error, out, err),
            }
        }
        OutputMode::Quiet => {
            let ids: Vec<&str> = ordered.iter().map(|bot| bot.id.as_str()).collect();
            match ids.iter().try_for_each(|id| out.line(id)) {
                Ok(()) => Outcome::Ok,
                Err(error) => common::write_failed(COMMAND_LIST, &error, out, err),
            }
        }
    }
}

fn render_bot<W: Write, E: Write>(
    bot: &Bot,
    output: OutputMode,
    colour: bool,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    match output {
        OutputMode::Json => match out.json(bot) {
            Ok(()) => Outcome::Ok,
            Err(error) => common::write_failed(COMMAND_SHOW, &error, out, err),
        },
        OutputMode::Human => {
            let lines = bot_lines(bot, common::current_millis(), colour);
            match lines.iter().try_for_each(|line| out.line(line)) {
                Ok(()) => Outcome::Ok,
                Err(error) => common::write_failed(COMMAND_SHOW, &error, out, err),
            }
        }
        OutputMode::Quiet => match out.line(&bot.id) {
            Ok(()) => Outcome::Ok,
            Err(error) => common::write_failed(COMMAND_SHOW, &error, out, err),
        },
    }
}

fn bot_rank(bot: &Bot) -> u8 {
    if bot.pinned {
        0
    } else if bot.state == "waiting" {
        1
    } else if bot.state == "working" {
        2
    } else if bot.unseen {
        3
    } else {
        4
    }
}

/// Spade's bots in the app's order: pinned, needs you, working, unseen, then the rest.
fn bot_order(bots: &[Bot]) -> Vec<Bot> {
    let mut ordered = bots.to_vec();
    ordered.sort_by(|a, b| {
        bot_rank(a)
            .cmp(&bot_rank(b))
            .then_with(|| b.last_activity.cmp(&a.last_activity))
    });
    ordered
}

fn bot_glyph(bot: &Bot, colour: bool) -> String {
    if bot.state == "waiting" {
        let glyph = if bot.waiting_for.as_deref() == Some("question") {
            "?"
        } else {
            "◆"
        };
        return amber(glyph, colour);
    }
    if bot.state == "working" {
        return "◌".to_owned();
    }
    if bot.problem.is_some() {
        return red("✕", colour);
    }
    if bot.unseen {
        return "✓".to_owned();
    }
    " ".to_owned()
}

fn bot_age(at: i64, now: i64) -> String {
    let seconds = (now - at).max(0) / 1000;
    if seconds < 60 {
        return "now".to_owned();
    }
    if seconds < 3600 {
        return format!("{}m", seconds / 60);
    }
    if seconds < 86_400 {
        return format!("{}h", seconds / 3600);
    }
    format!("{}d", seconds / 86_400)
}

fn bot_list_lines(bots: &[Bot], now: i64, colour: bool) -> Vec<String> {
    if bots.is_empty() {
        return vec!["No bots yet. Make one in the app's Spade.".to_owned()];
    }
    let width = bots
        .iter()
        .map(|bot| bot.name.len())
        .max()
        .unwrap_or(0)
        .min(28);
    bots.iter()
        .map(|bot| {
            let glyph = bot_glyph(bot, colour);
            let doing = if bot.state == "working" {
                bot.status.clone().unwrap_or_else(|| "working".to_owned())
            } else if bot.state == "waiting" {
                format!(
                    "needs you: {}",
                    bot.waiting_for
                        .clone()
                        .unwrap_or_else(|| "an answer".to_owned())
                )
            } else if bot.state == "paused" {
                "paused".to_owned()
            } else {
                bot.problem
                    .clone()
                    .unwrap_or_else(|| bot_age(bot.last_activity, now))
            };
            format!(
                "{glyph} {name:width$}  {id}  {doing}",
                name = bot.name,
                id = bot.id
            )
        })
        .collect()
}

fn bot_lines(bot: &Bot, now: i64, colour: bool) -> Vec<String> {
    let glyph = bot_glyph(bot, colour);
    let mut lines = vec![if glyph.trim().is_empty() {
        format!("{}  {}", bot.name, bot.id)
    } else {
        format!("{glyph} {}  {}", bot.name, bot.id)
    }];
    if !bot.task.is_empty() {
        lines.push(bot.task.clone());
    }
    lines.push(format!("Model         {}", bot.model));
    lines.push(format!("Conversation  {}", bot.conversation));
    if let Some(parent) = &bot.parent {
        lines.push(format!("Made by       {} ({})", parent.name, parent.id));
    }
    if bot.state == "working" {
        lines.push(
            format!("Working       {}", bot.status.clone().unwrap_or_default())
                .trim_end()
                .to_owned(),
        );
    }
    if bot.state == "waiting" {
        lines.push(format!(
            "Needs you     {}",
            bot.waiting_for
                .clone()
                .unwrap_or_else(|| "an answer".to_owned())
        ));
    }
    if bot.state == "paused" {
        lines.push(format!(
            "Paused        until you resume it: ace bot resume {}",
            bot.id
        ));
    }
    if let Some(problem) = &bot.problem {
        lines.push(red(&format!("✕ {problem}"), colour));
    }
    if let Some(last) = &bot.last_message {
        let from = if last.from == "person" {
            "you".to_owned()
        } else {
            bot.name.clone()
        };
        lines.push(format!(
            "Last          {from}, {} ago: {}",
            bot_age(last.at, now),
            one_line(&last.text)
        ));
    }
    lines.push("Talk with it in the ace app's Spade.".to_owned());
    lines
}

fn one_line(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > 100 {
        format!("{}…", flat.chars().take(99).collect::<String>())
    } else {
        flat
    }
}
