// SPDX-License-Identifier: Apache-2.0
//! Human lines for `ace automation` (ADR 0178 §3). Pure: the daemon's answer → lines.

use std::io::Write;

use cli_out::{Out, Outcome, OutputMode};

use super::super::common;
use crate::run::fail;

pub(crate) fn emit_lines<W: Write>(
    out: &mut Out<W>,
    lines: &[String],
) -> Result<(), cli_out::WriteError> {
    for line in lines {
        out.line(line)?;
    }
    Ok(())
}

pub(crate) fn render_admit<W: Write, E: Write>(
    value: &serde_json::Value,
    id: &str,
    command: &'static str,
    output: OutputMode,
    out: &mut Out<W>,
    err: &mut Out<E>,
    key: &str,
) -> Outcome {
    match output {
        OutputMode::Json => match out.json(value) {
            Ok(()) => Outcome::Ok,
            Err(_error) => fail(out, err, None, &common::uncertain_write(command, key)),
        },
        OutputMode::Human => {
            let lines: Vec<String> = if command == "automation.run" {
                automation_run_lines(value, id)
            } else {
                vec![format!("Automation {id} is removed.")]
            };
            match emit_lines(out, &lines) {
                Ok(()) => Outcome::Ok,
                Err(_) => fail(out, err, None, &common::uncertain_write(command, key)),
            }
        }
        OutputMode::Quiet => {
            let quiet_ids: Vec<String> = if command == "automation.run" {
                value
                    .get("run")
                    .and_then(|run| run.get("threadId"))
                    .and_then(serde_json::Value::as_str)
                    .map_or_else(Vec::new, |thread| vec![thread.to_owned()])
            } else {
                Vec::new()
            };
            match emit_lines(out, &quiet_ids) {
                Ok(()) => Outcome::Ok,
                Err(_) => fail(out, err, None, &common::uncertain_write(command, key)),
            }
        }
    }
}

fn trigger_text(automation: &serde_json::Value) -> String {
    let trigger = automation.get("trigger").cloned().unwrap_or_default();
    match trigger.get("kind").and_then(serde_json::Value::as_str) {
        Some("manual") => "by hand".to_owned(),
        Some("schedule") => {
            let kind = trigger
                .get("schedule")
                .and_then(|schedule| schedule.get("kind"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let expression = trigger
                .get("schedule")
                .and_then(|schedule| schedule.get("expression"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            format!("{kind} {expression}")
        }
        Some("github") => {
            let repository = trigger
                .get("repository")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let event = trigger
                .get("event")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .replace('_', " ");
            format!("{repository} {event}")
        }
        Some("file") => {
            let paths = trigger
                .get("paths")
                .and_then(serde_json::Value::as_array)
                .map_or_else(Vec::new, |paths| {
                    paths
                        .iter()
                        .filter_map(serde_json::Value::as_str)
                        .map(str::to_owned)
                        .collect::<Vec<_>>()
                });
            if paths.len() == 1 {
                format!("when {} change", paths[0])
            } else {
                format!("when {} paths change", paths.len())
            }
        }
        Some("webhook") => "webhook".to_owned(),
        _ => String::new(),
    }
}

fn when_text(at: i64) -> String {
    let text = chrono::DateTime::from_timestamp_millis(at)
        .map(|date| date.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_default();
    text.get(..16).unwrap_or(&text).to_owned()
}

fn run_glyph(status: &str) -> &'static str {
    match status {
        "queued" | "running" => "◌",
        "succeeded" => "✓",
        "failed" => "✕",
        _ => "-",
    }
}

pub(crate) fn automation_list_lines(response: &serde_json::Value) -> Vec<String> {
    let empty = Vec::new();
    let automations = response
        .get("automations")
        .and_then(serde_json::Value::as_array)
        .unwrap_or(&empty);
    if automations.is_empty() {
        return vec![
            "No automations yet. Make one in the app, or ace automation create @FILE.".to_owned(),
        ];
    }
    let width = automations
        .iter()
        .map(|automation| {
            automation
                .get("title")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .len()
        })
        .max()
        .unwrap_or(0)
        .min(32);
    let schedules: std::collections::BTreeMap<&str, &serde_json::Value> = response
        .get("schedules")
        .and_then(serde_json::Value::as_array)
        .map_or_else(std::collections::BTreeMap::new, |list| {
            list.iter()
                .filter_map(|schedule| {
                    schedule
                        .get("id")
                        .and_then(serde_json::Value::as_str)
                        .map(|id| (id, schedule))
                })
                .collect()
        });
    automations
        .iter()
        .map(|automation| {
            let id = automation
                .get("id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let title = automation
                .get("title")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let schedule = schedules.get(id).copied();
            let state = if automation
                .get("enabled")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
            {
                ""
            } else {
                "off  "
            };
            let next = schedule
                .and_then(|schedule| schedule.get("nextRunAt"))
                .and_then(serde_json::Value::as_i64)
                .map(|at| format!("  next {}", when_text(at)))
                .unwrap_or_default();
            let last = schedule
                .and_then(|schedule| schedule.get("lastRun"))
                .map(|last| {
                    let status = last
                        .get("status")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("");
                    format!("  {} {status}", run_glyph(status))
                })
                .unwrap_or_default();
            let failing = schedule.is_some_and(|schedule| {
                schedule.get("triggerError").is_some() || schedule.get("lastPollError").is_some()
            });
            let problem = if failing { "  ✕ trigger failing" } else { "" };
            format!(
                "{title:<width$}  {id}  {state}{}{next}{last}{problem}",
                trigger_text(automation)
            )
        })
        .collect()
}

pub(crate) fn automation_lines(
    automation: &serde_json::Value,
    schedule: Option<&serde_json::Value>,
) -> Vec<String> {
    let title = automation
        .get("title")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let id = automation
        .get("id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let enabled = automation
        .get("enabled")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let workspace = automation
        .get("workspace")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let worktree = automation
        .get("worktree")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let provider = automation
        .get("provider")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let model = automation
        .get("model")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let mut lines = vec![
        format!("{title}  {id}{}", if enabled { "" } else { "  (off)" }),
        format!("Runs         {}", trigger_text(automation)),
        format!(
            "In           {workspace}{}",
            if worktree { ", in a worktree" } else { "" }
        ),
        format!(
            "With         {provider}{}",
            if model.is_empty() {
                String::new()
            } else {
                format!(" {model}")
            }
        ),
    ];
    if let Some(next) = schedule
        .and_then(|schedule| schedule.get("nextRunAt"))
        .and_then(serde_json::Value::as_i64)
    {
        lines.push(format!("Next run     {}", when_text(next)));
    }
    if let Some(last) = schedule.and_then(|schedule| schedule.get("lastRun")) {
        let status = last
            .get("status")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let started = last
            .get("startedAt")
            .and_then(serde_json::Value::as_i64)
            .map_or_else(String::new, when_text);
        let thread = last
            .get("threadId")
            .and_then(serde_json::Value::as_str)
            .map_or_else(String::new, |thread| format!(", thread {thread}"));
        lines.push(format!(
            "Last run     {} {status}, {started}{thread}",
            run_glyph(status)
        ));
    }
    let error = schedule
        .and_then(|schedule| {
            schedule
                .get("triggerError")
                .or_else(|| schedule.get("lastPollError"))
        })
        .and_then(|error| error.get("message"))
        .and_then(serde_json::Value::as_str);
    if let Some(error) = error {
        lines.push(format!("✕ {error}"));
    }
    if let Some(url) = schedule
        .and_then(|schedule| schedule.get("webhook"))
        .and_then(|webhook| webhook.get("url"))
        .and_then(serde_json::Value::as_str)
    {
        lines.push(format!("Webhook      {url}"));
    }
    let prompt = automation
        .get("prompt")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    lines.push(String::new());
    lines.push(prompt.split('\n').next().unwrap_or("").to_owned());
    lines.push(String::new());
    lines.push(format!("Run it now with ace automation run {id}"));
    lines
}

pub(crate) fn automation_run_lines(result: &serde_json::Value, automation_id: &str) -> Vec<String> {
    let run = result.get("run");
    let Some(run) = run else {
        return vec![format!("Automation {automation_id} was started.")];
    };
    let status = run
        .get("status")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let thread = run
        .get("threadId")
        .and_then(serde_json::Value::as_str)
        .map_or_else(String::new, |thread| format!(" in thread {thread}"));
    let mut lines = vec![if status == "queued" {
        format!("Automation {automation_id} is queued behind its running one{thread}.")
    } else {
        format!("Automation {automation_id} is {status}{thread}.")
    }];
    if let Some(thread) = run.get("threadId").and_then(serde_json::Value::as_str) {
        lines.push(format!("Follow it with ace thread wait {thread}"));
    }
    lines
}
