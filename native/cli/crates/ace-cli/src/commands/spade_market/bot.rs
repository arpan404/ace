// SPDX-License-Identifier: Apache-2.0
//! Spade's task manager: `ace bot running|stop|pause|resume|unarchive`.

use std::io::{IsTerminal as _, Write};

use chrono::{Datelike as _, Timelike as _};
use cli_out::{Env, Failure, Out, Outcome, OutputMode, Stream, Terminal, use_color};
use cli_parse::Parsed;
use cli_wire::Connection;
use serde::Serialize;

use super::common;
use crate::commands::work::common::{connect, mode, timeout_duration};
use crate::run::fail;

const WEEKDAYS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

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

#[derive(Clone, Serialize)]
struct RunningBot {
    id: String,
    kind: String,
    name: String,
    state: String,
    reads: String,
    doing: String,
    uses: String,
    spend: RunningSpend,
    network: RunningNetwork,
    #[serde(rename = "nextWake", skip_serializing_if = "Option::is_none")]
    next_wake: Option<RunningWake>,
    workers: Vec<RunningWorker>,
    actions: Vec<String>,
}

#[derive(Clone, Serialize)]
struct RunningSpend {
    #[serde(rename = "todayMicros")]
    today_micros: i64,
    #[serde(rename = "monthMicros")]
    month_micros: i64,
    unusual: bool,
}

#[derive(Clone, Serialize)]
struct RunningNetwork {
    bytes: i64,
    hosts: Vec<String>,
    refused: i64,
}

#[derive(Clone, Serialize)]
struct RunningWake {
    at: i64,
    what: String,
}

#[derive(Clone, Serialize)]
struct RunningWorker {
    id: String,
    name: String,
    doing: String,
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

fn parse_running_bot(raw: &serde_json::Value) -> Option<RunningBot> {
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
fn uses_words(uses: &serde_json::Value) -> String {
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

#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn list_running(
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

fn parse_running(body: &str) -> Option<Vec<RunningBot>> {
    let parsed: serde_json::Value = serde_json::from_str(body).ok()?;
    let list = parsed.get("bots")?.as_array()?;
    Some(list.iter().filter_map(parse_running_bot).collect())
}

#[derive(Serialize)]
struct BotAction {
    bot: String,
    name: String,
    action: String,
    changed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    now: Option<RunningBot>,
}

/// Stops, pauses, resumes or unarchives the bot `reference` names.
#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn act_on_bot(
    conn: &mut Connection,
    timeout: std::time::Duration,
    reference: Option<&str>,
    action: &str,
    command: &'static str,
) -> Result<BotAction, Failure<'static>> {
    let (_, agents_body) = common::spade_call(conn, timeout, "GET", "/v1/agents", None, command)
        .map_err(|failure| failure.with_command(command))?;
    let agents = super::spade::parse_agents(&agents_body).ok_or_else(|| {
        Failure::new(Outcome::Uncertain, "Spade's answer had no bots in it.")
            .with_code(cli_out::ErrorCode::Uncertain)
            .with_command(command)
    })?;
    let bot = super::spade::find_bot(&agents, reference, command)?;
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

fn bot_action_words(result: &BotAction) -> String {
    let name = &result.name;
    match result.action.as_str() {
        "stop" => {
            if result.changed {
                format!("Stopped {name} and its workers.")
            } else {
                format!("{name} had nothing running.")
            }
        }
        "pause" => {
            if result.changed {
                format!(
                    "Paused {name}. Nothing of it fires until you resume it: ace bot resume {}.",
                    result.bot
                )
            } else {
                format!("{name} was paused already.")
            }
        }
        "unarchive" => {
            if result.changed {
                format!(
                    "Unarchived {name}. The routines that were on are on again; the rest stay paused."
                )
            } else {
                format!("{name} wasn't archived.")
            }
        }
        _ => {
            if result.changed {
                format!("Resumed {name}. What came due while it was paused runs once now.")
            } else {
                format!("{name} wasn't paused.")
            }
        }
    }
}

/* Words for the task manager rows. Pure: values → lines. */

#[allow(
    clippy::cast_precision_loss,
    reason = "spend micros far below 2^53; matches the TypeScript division"
)]
fn dollars(micros: i64) -> String {
    if micros > 0 && micros < 10_000 {
        "<$0.01".to_owned()
    } else {
        format!("${:.2}", micros as f64 / 1_000_000.0)
    }
}

#[allow(
    clippy::cast_precision_loss,
    reason = "byte counts far below 2^53; matches the TypeScript division"
)]
#[allow(
    clippy::cast_possible_truncation,
    reason = "byte halves always fit; counts formatted for people"
)]
fn bytes_text(count: i64) -> String {
    if count < 1000 {
        return format!("{count} B");
    }
    let units = ["kB", "MB", "GB", "TB"];
    #[allow(
        clippy::cast_precision_loss,
        reason = "byte counts far below 2^53; matches the TypeScript division"
    )]
    let mut value = count as f64 / 1000.0;
    let mut unit = 0;
    while value >= 1000.0 && unit < units.len() - 1 {
        value /= 1000.0;
        unit += 1;
    }
    if value < 10.0 {
        format!("{value:.1} {}", units[unit])
    } else {
        format!("{} {}", value.round() as i64, units[unit])
    }
}

/// A wake's time: "08:20" within a day, else with its date, in this machine's zone.
fn clock_text(at: i64, now: i64) -> String {
    let time = local_parts(at, true);
    if at - now < 86_400_000 {
        return time;
    }
    format!("{} {time}", local_parts(at, false))
}

/// "08:20", or "Fri, Nov 21" for `date`: this machine's zone, as the app's pages show it.
fn local_parts(at: i64, time_only: bool) -> String {
    let moment = chrono::DateTime::from_timestamp_millis(at).unwrap_or_else(chrono::Utc::now);
    let local = moment.with_timezone(&chrono::Local);
    if time_only {
        return format!("{:02}:{:02}", local.hour(), local.minute());
    }
    let weekday_number = usize::try_from(local.weekday().num_days_from_monday()).unwrap_or(0) % 7;
    let month_number = usize::try_from(local.month0()).unwrap_or(0).min(11);
    format!(
        "{}, {} {}",
        WEEKDAYS[weekday_number],
        MONTHS[month_number],
        local.day()
    )
}

fn doing_text(bot: &RunningBot, colour: bool) -> String {
    if bot.reads == "needs_you" {
        amber(&bot.doing, colour)
    } else if bot.reads == "failed" {
        red(&bot.doing, colour)
    } else {
        bot.doing.clone()
    }
}

/// What a row holds, spends and reaches, after its state.
fn facts_text(bot: &RunningBot, now: i64) -> String {
    let reached = if bot.network.hosts.len() > 1 {
        format!("{} hosts", bot.network.hosts.len())
    } else {
        bot.network.hosts.first().cloned().unwrap_or_default()
    };
    let network = if reached.is_empty() {
        "no network".to_owned()
    } else {
        format!("{} with {reached}", bytes_text(bot.network.bytes))
    };
    let held = bot.reads == "paused";
    let next = bot.next_wake.as_ref().map(|wake| {
        let what = if wake.what.is_empty() {
            String::new()
        } else {
            format!("{} ", wake.what)
        };
        format!(
            "{} {what}{}",
            if held { "held" } else { "next" },
            clock_text(wake.at, now)
        )
    });
    let mut spend = format!("{} today", dollars(bot.spend.today_micros));
    if bot.spend.unusual {
        spend.push_str(", spending fast");
    }
    let mut parts = Vec::new();
    if !bot.uses.is_empty() {
        parts.push(bot.uses.clone());
    }
    parts.push(spend);
    parts.push(network);
    if let Some(next) = next {
        parts.push(next);
    }
    parts.join(" · ")
}

/// Each bot on two lines (its state in words, then its facts) and its workers under it.
fn running_lines(bots: &[RunningBot], now: i64, colour: bool, _zone: Option<&str>) -> Vec<String> {
    if bots.is_empty() {
        return vec!["No bots yet. Make one in the app's Spade.".to_owned()];
    }
    let width = bots
        .iter()
        .map(|bot| bot.name.len())
        .max()
        .unwrap_or(0)
        .min(24);
    let pad = " ".repeat(width);
    let mut lines = Vec::new();
    for bot in bots {
        lines.push(format!(
            "{name:width$}  {doing}",
            name = bot.name,
            doing = doing_text(bot, colour)
        ));
        lines.push(format!("{pad}  {}", dim(&facts_text(bot, now), colour)));
        for worker in &bot.workers {
            lines.push(format!("{pad}  └ {}: {}", worker.name, worker.doing));
        }
    }
    lines
}

fn dim(text: &str, colour: bool) -> String {
    if colour {
        format!("\u{1b}[2m{text}\u{1b}[22m")
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

fn red(text: &str, colour: bool) -> String {
    if colour {
        format!("\u{1b}[31m{text}\u{1b}[39m")
    } else {
        text.to_owned()
    }
}
