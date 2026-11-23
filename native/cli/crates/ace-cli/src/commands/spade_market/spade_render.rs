// SPDX-License-Identifier: Apache-2.0
//! Words for Spade, Beta switches and Spade's bots (ADR 0178 §3). Pure: value → lines.

use std::io::Write;

use cli_out::{Out, Outcome, OutputMode};

use super::common::{self, amber, red};
use super::spade::{COMMAND_LIST, COMMAND_SHOW};
use super::spade_parse::Bot;

pub(crate) fn spade_state_lines(state: &serde_json::Value, colour: bool) -> Vec<String> {
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
pub(crate) fn bot_order(bots: &[Bot]) -> Vec<Bot> {
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
pub(crate) fn bot_list_lines(bots: &[Bot], now: i64, colour: bool) -> Vec<String> {
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
pub(crate) fn bot_lines(bot: &Bot, now: i64, colour: bool) -> Vec<String> {
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

pub(crate) fn render_bot_list<W: Write, E: Write>(
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

pub(crate) fn render_bot<W: Write, E: Write>(
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
