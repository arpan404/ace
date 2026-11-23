// SPDX-License-Identifier: Apache-2.0
//! Words for `daemon` and `storage` (ADR 0178 §3). Pure: values in, lines out. Every function
//! mirrors `apps/daemon/src/cli/render/daemon.ts` and `render/storage.ts` line for line.

use std::borrow::Cow;
use std::fmt::Write as _;

use serde::Deserialize;

/// The daemon's health from `/v1/status`; unknown fields are kept, never fatal.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Health<'a> {
    pub(crate) running: bool,
    #[serde(borrow, default)]
    pub(crate) version: Option<Cow<'a, str>>,
    #[serde(default)]
    pub(crate) ready: Option<bool>,
}

/// What `ace storage usage` measures, borrowing from the reply buffer.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Usage<'a> {
    #[serde(borrow)]
    pub(crate) categories: Vec<UsageCategory<'a>>,
    pub(crate) database_bytes: u64,
    pub(crate) reclaimable_database_bytes: u64,
    pub(crate) complete: bool,
    #[serde(borrow, default)]
    pub(crate) backups: Vec<UsageBackup<'a>>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct UsageCategory<'a> {
    #[serde(borrow)]
    pub(crate) kind: Cow<'a, str>,
    pub(crate) bytes: u64,
    pub(crate) items: u64,
}

#[derive(Debug, Deserialize)]
pub(crate) struct UsageBackup<'a> {
    #[serde(borrow)]
    pub(crate) path: Cow<'a, str>,
    #[serde(borrow)]
    pub(crate) state: Cow<'a, str>,
    #[serde(borrow, default)]
    pub(crate) error: Option<Cow<'a, str>>,
}

/// A cleanup plan the daemon measured, borrowing from the reply buffer.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Plan<'a> {
    #[serde(borrow)]
    pub(crate) id: Cow<'a, str>,
    #[serde(borrow)]
    pub(crate) revision: Cow<'a, str>,
    pub(crate) bytes: u64,
    #[serde(borrow)]
    pub(crate) items: Vec<PlanItem<'a>>,
    pub(crate) complete: bool,
}

#[derive(Debug, Deserialize)]
pub(crate) struct PlanItem<'a> {
    #[serde(borrow)]
    pub(crate) kind: Cow<'a, str>,
    #[serde(borrow)]
    pub(crate) label: Cow<'a, str>,
    pub(crate) bytes: u64,
    #[serde(borrow)]
    pub(crate) disposition: Cow<'a, str>,
    #[serde(borrow)]
    pub(crate) reasons: Vec<Cow<'a, str>>,
}

/// A cleanup receipt: its plan id and revision name what to read or apply again.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Receipt<'a> {
    #[serde(borrow)]
    pub(crate) plan_id: Cow<'a, str>,
    #[serde(borrow)]
    pub(crate) state: Cow<'a, str>,
    #[serde(borrow)]
    pub(crate) items: Vec<ReceiptItem<'a>>,
    #[serde(borrow, default)]
    pub(crate) revision: Option<Cow<'a, str>>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ReceiptItem<'a> {
    #[serde(borrow)]
    pub(crate) state: Cow<'a, str>,
}

/// The database compaction the daemon keeps the journal of.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Compaction<'a> {
    #[serde(borrow)]
    pub(crate) id: Cow<'a, str>,
    #[serde(borrow)]
    pub(crate) state: Cow<'a, str>,
    pub(crate) incremental_unavailable: bool,
    pub(crate) database_bytes_before: u64,
    pub(crate) database_bytes: u64,
    pub(crate) checkpointed: bool,
}

/// Bytes as a person reads them: `512 B`, `2.0 KB`, `1.5 GB`.
#[allow(
    clippy::cast_precision_loss,
    reason = "byte counts below 2^53 read the same to one decimal; larger ones never occur on a disk"
)]
pub(crate) fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} {}", UNITS[unit])
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

fn plural(count: usize, word: &str) -> String {
    if count == 1 {
        format!("{count} {word}")
    } else {
        format!("{count} {word}s")
    }
}

/// The daemon's health as lines: what runs, and whether it finished starting.
pub(crate) fn health_lines(health: &Health<'_>) -> Vec<String> {
    if !health.running {
        return vec![
            "ace isn't running.".to_owned(),
            "Start it with ace start, or open the app.".to_owned(),
        ];
    }
    let mut lines = vec![format!(
        "ace is running, version {}.",
        health.version.as_deref().unwrap_or("unknown")
    )];
    if health.ready != Some(true) {
        lines.push("It is still starting up.".to_owned());
    }
    lines
}

/// What `ace storage usage` measured, one category per line.
pub(crate) fn usage_lines(usage: &Usage<'_>) -> Vec<String> {
    let total: u64 = usage
        .categories
        .iter()
        .map(|category| category.bytes)
        .sum::<u64>()
        .saturating_add(usage.database_bytes);
    let mut lines: Vec<String> = usage
        .categories
        .iter()
        .map(|category| {
            format!(
                "{:<12} {:>9}  {}",
                category.kind,
                format_bytes(category.bytes),
                plural(
                    usize::try_from(category.items).unwrap_or(usize::MAX),
                    "item"
                )
            )
        })
        .collect();
    lines.push(format!(
        "{:<12} {:>9}",
        "database",
        format_bytes(usage.database_bytes)
    ));
    lines.push(format!("{:<12} {:>9}", "total", format_bytes(total)));
    if usage.reclaimable_database_bytes > 0 {
        lines.push(String::new());
        lines.push(format!(
            "{} of the database is free space; reclaim it with ace storage compact.",
            format_bytes(usage.reclaimable_database_bytes)
        ));
    }
    for backup in usage
        .backups
        .iter()
        .filter(|backup| backup.state == "failed")
    {
        let error = backup.error.as_deref().filter(|error| !error.is_empty());
        lines.push(format!(
            "✕ Worktree backup failed: {}{}",
            backup.path,
            error.map_or_else(String::new, |error| format!(" ({error})"))
        ));
    }
    if !usage.complete {
        lines.push("Still measuring; some sizes are partial.".to_owned());
    }
    lines.push(String::new());
    lines.push("Plan a cleanup with ace storage clean --dry-run.".to_owned());
    lines
}

/// A cleanup plan: what goes, what stays, and its revision.
pub(crate) fn plan_lines(plan: &Plan<'_>) -> Vec<String> {
    let remove: Vec<&PlanItem<'_>> = plan
        .items
        .iter()
        .filter(|item| item.disposition == "remove")
        .collect();
    let keep: Vec<&PlanItem<'_>> = plan
        .items
        .iter()
        .filter(|item| item.disposition == "protect")
        .collect();
    let mut lines = vec![format!("Plan {} (revision {})", plan.id, plan.revision)];
    lines.push(format!(
        "Remove {}, {}:",
        plural(remove.len(), "item"),
        format_bytes(plan.bytes)
    ));
    for item in remove {
        lines.push(format!(
            "  {:<11} {}  {}",
            item.kind,
            item.label,
            format_bytes(item.bytes)
        ));
    }
    if !keep.is_empty() {
        lines.push(format!("Keep {}:", plural(keep.len(), "item")));
    }
    for item in keep {
        let reasons: Vec<String> = item
            .reasons
            .iter()
            .map(|reason| reason.replace('_', " "))
            .collect();
        lines.push(format!(
            "  {:<11} {}  {}",
            item.kind,
            item.label,
            reasons.join(", ")
        ));
    }
    if !plan.complete {
        lines.push("Inventory is incomplete; run the cleanup again after this batch.".to_owned());
    }
    lines
}

/// A plan from `storage plan` or `clean --dry-run`, with the command that applies it.
pub(crate) fn review_lines(plan: &Plan<'_>) -> Vec<String> {
    let mut lines = plan_lines(plan);
    if plan.items.iter().any(|item| item.disposition == "remove") {
        lines.push(format!(
            "Apply it with ace storage apply {} --revision {}",
            plan.id, plan.revision
        ));
    } else {
        lines.push("Nothing to remove.".to_owned());
    }
    lines
}

/// A cleanup receipt: what went, what stayed, and the plan it names.
pub(crate) fn receipt_line(receipt: &Receipt<'_>) -> String {
    let mut where_ = format!("plan {}", receipt.plan_id);
    if let Some(revision) = receipt.revision.as_deref() {
        let _ = write!(where_, ", revision {revision}");
    }
    if receipt.state == "stale" {
        return format!(
            "✕ The plan changed since it was reviewed, so nothing was removed ({where_}). Plan again with ace storage plan."
        );
    }
    let count = |state: &str| {
        receipt
            .items
            .iter()
            .filter(|item| item.state == state)
            .count()
    };
    format!(
        "Cleanup {}: {} removed, {} kept, {} pending ({where_}).",
        receipt.state,
        count("removed"),
        count("protected"),
        count("pending")
    )
}

/// A compaction: what shrank, what is still running, or what never could.
pub(crate) fn compaction_lines(compaction: &Compaction<'_>) -> Vec<String> {
    if compaction.incremental_unavailable {
        return vec![
            "This database predates in-place compaction, so nothing was changed.".to_owned(),
        ];
    }
    let saved = compaction
        .database_bytes_before
        .saturating_sub(compaction.database_bytes);
    let mut lines = vec![match compaction.state.as_ref() {
        "complete" => format!(
            "Compacted the database: {} to {}, {} freed.",
            format_bytes(compaction.database_bytes_before),
            format_bytes(compaction.database_bytes),
            format_bytes(saved)
        ),
        "abandoned" => format!("Compaction {} was given up.", compaction.id),
        _ => format!("Compaction {} is still running.", compaction.id),
    }];
    if !compaction.checkpointed {
        lines.push("A reader kept the log from being truncated; run it again later.".to_owned());
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::{Compaction, Receipt, compaction_lines, format_bytes, receipt_line};

    #[test]
    fn bytes_read_in_binary_units_with_one_decimal() {
        assert_eq!(format_bytes(0), "0 B");
        assert_eq!(format_bytes(1023), "1023 B");
        assert_eq!(format_bytes(1024), "1.0 KB");
        assert_eq!(format_bytes(1_572_864), "1.5 MB");
    }

    #[test]
    fn a_stale_receipt_names_its_plan_and_says_to_plan_again() {
        let receipt = Receipt {
            plan_id: std::borrow::Cow::Borrowed("p1"),
            state: std::borrow::Cow::Borrowed("stale"),
            items: vec![],
            revision: Some(std::borrow::Cow::Borrowed("r")),
        };
        assert_eq!(
            receipt_line(&receipt),
            "✕ The plan changed since it was reviewed, so nothing was removed (plan p1, revision r). Plan again with ace storage plan."
        );
    }

    #[test]
    fn an_old_database_compacts_to_a_sentence_not_an_error() {
        let compaction = Compaction {
            id: std::borrow::Cow::Borrowed("c1"),
            state: std::borrow::Cow::Borrowed("complete"),
            incremental_unavailable: true,
            database_bytes_before: 10,
            database_bytes: 10,
            checkpointed: true,
        };
        assert_eq!(
            compaction_lines(&compaction),
            ["This database predates in-place compaction, so nothing was changed."]
        );
    }
}
