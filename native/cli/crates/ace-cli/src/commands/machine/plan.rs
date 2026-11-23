// SPDX-License-Identifier: Apache-2.0
//! `storage plan` and `storage clean` flags as one daemon plan request (ADR 0178 §8).
#![allow(
    clippy::result_large_err,
    reason = "the failure envelope is returned by value to its one printer; boxing would only add an allocation"
)]

use cli_out::{Failure, Flags};
use cli_parse::Parsed;
use serde::Serialize;

use super::error::usage;

/// Each kind is selectable as its own switch, e.g. `--logs --worktrees`.
const KINDS: [&str; 6] = [
    "threads",
    "attachments",
    "artifacts",
    "logs",
    "worktrees",
    "caches",
];

/// Days of data the host keeps per kind, `None` disabling removal of a category.
#[derive(Clone, Debug)]
pub(crate) struct Retention {
    kinds: [Option<u64>; 6],
    idle_threads: bool,
    worktree_mode: Option<String>,
}

impl Retention {
    fn defaults() -> Self {
        Self {
            kinds: [Some(90), Some(30), Some(30), Some(14), Some(30), Some(7)],
            idle_threads: false,
            worktree_mode: None,
        }
    }
}

#[derive(Serialize)]
struct RetentionWire<'a> {
    threads: Option<u64>,
    attachments: Option<u64>,
    artifacts: Option<u64>,
    logs: Option<u64>,
    worktrees: Option<u64>,
    caches: Option<u64>,
    #[serde(rename = "idleThreads")]
    idle_threads: bool,
    #[serde(rename = "worktreeMode", skip_serializing_if = "Option::is_none")]
    worktree_mode: Option<&'a str>,
}

/// One daemon plan request, as `storage plan` and `storage clean` flags shape it.
#[derive(Debug)]
pub(crate) struct PlanOperation {
    kinds: Option<Vec<String>>,
    retention: Option<Retention>,
    force_items: Vec<String>,
}

impl PlanOperation {
    /// The selected kinds, in the table's order, as the daemon reads them.
    pub(crate) fn kinds(&self) -> Option<&[String]> {
        self.kinds.as_deref()
    }

    /// The protected items to force, in the order given.
    pub(crate) fn force_items(&self) -> &[String] {
        &self.force_items
    }

    /// The retention as the daemon reads it, days per kind with the schema's defaults.
    pub(crate) fn retention_json(&self) -> Option<serde_json::Value> {
        self.retention.as_ref().map(|retention| {
            serde_json::to_value(RetentionWire {
                threads: retention.kinds[0],
                attachments: retention.kinds[1],
                artifacts: retention.kinds[2],
                logs: retention.kinds[3],
                worktrees: retention.kinds[4],
                caches: retention.kinds[5],
                idle_threads: retention.idle_threads,
                worktree_mode: retention.worktree_mode.as_deref(),
            })
            .unwrap_or(serde_json::Value::Null)
        })
    }
}

/// Reads the plan flags the table parsed; `read_file` is the only way out.
pub(crate) fn plan_operation(
    flags: &Flags<'_>,
    lists: &[(&'static str, Vec<&str>)],
    read_file: impl Fn(&str) -> Result<String, std::io::Error>,
    command: &'static str,
) -> Result<PlanOperation, Failure<'static>> {
    let switched: Vec<&str> = KINDS
        .iter()
        .filter(|kind| flags.on(kind))
        .copied()
        .collect();
    let listed = flags.value("kinds");
    if !switched.is_empty() && listed.is_some() {
        return Err(usage(
            "Use either kind switches or --kinds, not both.",
            "--kinds",
            command,
        )
        .with_hint("Pass the kinds as switches, like --logs --worktrees."));
    }
    let kinds = if !switched.is_empty() {
        Some(switched.iter().map(ToString::to_string).collect())
    } else if let Some(listed) = listed {
        Some(kind_list(listed, command)?)
    } else {
        None
    };
    let older_than = flags.value("older-than");
    let retention_flag = flags.value("retention");
    if older_than.is_some() && retention_flag.is_some() {
        return Err(usage(
            "Use either --older-than or --retention, not both.",
            "--older-than",
            command,
        ));
    }
    // An explicit selection keeps a threshold from re-enabling kinds disabled in settings.
    if older_than.is_some() && kinds.is_none() {
        return Err(usage(
            "--older-than needs at least one kind.",
            "--older-than",
            command,
        )
        .with_hint("Name what to clean, like ace storage clean --logs --older-than 30d."));
    }
    let retention = if let (Some(days), Some(kinds)) = (older_than, kinds.as_ref()) {
        Some(retention_for(kinds, older_than_days(days, command)?))
    } else if let Some(flag) = retention_flag {
        Some(parse_retention(
            &json_flag("--retention", flag, &read_file, command)?,
            command,
        )?)
    } else {
        None
    };
    Ok(PlanOperation {
        kinds,
        retention,
        force_items: forced_items(flags, lists, command)?,
    })
}

fn kind_list(listed: &str, command: &'static str) -> Result<Vec<String>, Failure<'static>> {
    let kinds: Vec<String> = listed.split(',').map(ToString::to_string).collect();
    if kinds.is_empty()
        || kinds.len() > KINDS.len()
        || kinds.iter().any(|kind| !KINDS.contains(&kind.as_str()))
    {
        return Err(usage(
            format!("--kinds takes {}, comma-separated.", KINDS.join(", ")),
            "--kinds",
            command,
        ));
    }
    Ok(kinds)
}

/// `--force-item ID`, repeated, or the old `--force-items JSON`; never both.
fn forced_items(
    flags: &Flags<'_>,
    lists: &[(&'static str, Vec<&str>)],
    command: &'static str,
) -> Result<Vec<String>, Failure<'static>> {
    let repeated: Vec<String> = lists
        .iter()
        .find(|(name, _)| *name == "force-item")
        .map_or_else(Vec::new, |(_, values)| {
            values.iter().map(ToString::to_string).collect()
        });
    let old = flags.value("force-items");
    if !repeated.is_empty() && old.is_some() {
        return Err(usage(
            "Use --force-item ID, not both it and --force-items.",
            "--force-items",
            command,
        ));
    }
    let items: Vec<String> = if let Some(old) = old {
        let parsed: serde_json::Value = serde_json::from_str(old).map_err(|_| {
            usage(
                "--force-items takes a JSON list of item ids.",
                "--force-items",
                command,
            )
            .with_hint("Pass each one as --force-item ID instead.")
        })?;
        let Some(list) = parsed.as_array() else {
            return Err(usage(
                "--force-items takes a JSON list of item ids.",
                "--force-items",
                command,
            )
            .with_hint("Pass each one as --force-item ID instead."));
        };
        list.iter()
            .map(|item| item.as_str().unwrap_or_default().to_owned())
            .collect()
    } else {
        repeated
    };
    if items.len() > 256 || items.iter().any(|item| item.is_empty() || item.len() > 256) {
        return Err(usage(
            "--force-item takes an item id from the plan, at most 256 of them.",
            "--force-item",
            command,
        ));
    }
    Ok(items)
}

/// `@FILE` reads JSON from a file; anything else is the first CLI's inline JSON.
fn json_flag(
    flag: &'static str,
    value: &str,
    read_file: impl Fn(&str) -> Result<String, std::io::Error>,
    command: &'static str,
) -> Result<serde_json::Value, Failure<'static>> {
    let path = value.strip_prefix('@');
    let mut text = value.to_owned();
    if let Some(path) = path {
        text = read_file(path).map_err(|_| {
            usage(format!("Couldn't read {path} for {flag}."), flag, command)
                .with_hint(format!("Pass {flag} @FILE with the path of a JSON file."))
        })?;
    }
    serde_json::from_str(&text).map_err(|_| {
        let complaint = path.map_or_else(
            || format!("{flag} needs JSON."),
            |path| format!("{flag} needs JSON, and {path} isn't."),
        );
        usage(complaint, flag, command).with_hint(format!(
            "Write the retention as JSON in a file and pass {flag} @FILE."
        ))
    })
}

/// Days per kind from a retention file or inline JSON; unknown keys are ignored.
fn parse_retention(
    value: &serde_json::Value,
    command: &'static str,
) -> Result<Retention, Failure<'static>> {
    let invalid = || {
        usage(
            "--retention must give days per kind, like {\"logs\": 14}, or null to keep.",
            "--retention",
            command,
        )
        .with_hint(format!("Kinds: {}.", KINDS.join(", ")))
    };
    let object = value.as_object().ok_or_else(invalid)?;
    let mut retention = Retention::defaults();
    for (index, kind) in KINDS.iter().enumerate() {
        if let Some(value) = object.get(*kind) {
            retention.kinds[index] = if value.is_null() {
                None
            } else if let Some(days) = value.as_u64() {
                if !(1..=36_500).contains(&days) {
                    return Err(invalid());
                }
                Some(days)
            } else {
                return Err(invalid());
            };
        }
    }
    if let Some(idle) = object.get("idleThreads") {
        retention.idle_threads = idle.as_bool().ok_or_else(invalid)?;
    }
    if let Some(mode) = object.get("worktreeMode") {
        let mode = mode.as_str().ok_or_else(invalid)?;
        if !matches!(mode, "archived" | "settled" | "all_settled") {
            return Err(invalid());
        }
        retention.worktree_mode = Some(mode.to_owned());
    }
    Ok(retention)
}

/// Whole days from `1d` to `36500d`, like `30d`.
fn older_than_days(value: &str, command: &'static str) -> Result<u64, Failure<'static>> {
    let invalid = || {
        usage(
            "--older-than takes whole days from 1d to 36500d, like 30d.",
            "--older-than",
            command,
        )
    };
    let digits = value.strip_suffix('d').ok_or_else(invalid)?;
    if digits.is_empty() || digits.len() > 5 || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(invalid());
    }
    let days: u64 = digits.parse().map_err(|_| invalid())?;
    if !(1..=36_500).contains(&days) {
        return Err(invalid());
    }
    Ok(days)
}

/// Unselected kinds are disabled (null) so an age threshold never widens the selection.
fn retention_for(kinds: &[String], days: u64) -> Retention {
    let mut retention = Retention {
        kinds: [None, None, None, None, None, None],
        idle_threads: false,
        worktree_mode: None,
    };
    for (index, kind) in KINDS.iter().enumerate() {
        if kinds.iter().any(|selected| selected == kind) {
            retention.kinds[index] = Some(days);
        }
    }
    retention
}

/// Every value of a flag given more than once, for `--force-item ID --force-item ID`.
pub(crate) fn flag_lists<'a>(parsed: &'a Parsed<'a>) -> Vec<(&'static str, Vec<&'a str>)> {
    parsed
        .lists
        .iter()
        .map(|(name, values)| (*name, values.clone()))
        .collect()
}
