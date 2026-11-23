// SPDX-License-Identifier: Apache-2.0
//! Words for the task manager rows. Pure: values → lines.

use chrono::{Datelike as _, Timelike as _};

use super::bot::BotAction;
use super::bot_parse::RunningBot;
use super::common::{amber, dim, red};

const WEEKDAYS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

pub(crate) fn bot_action_words(result: &BotAction) -> String {
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
pub(crate) fn running_lines(
    bots: &[RunningBot],
    now: i64,
    colour: bool,
    _zone: Option<&str>,
) -> Vec<String> {
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
