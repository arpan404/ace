// SPDX-License-Identifier: Apache-2.0
//! `storage apply|status` (ADR 0178 §7): applying a reviewed cleanup plan, and reading where a
//! cleanup plan stands. A stale plan removes nothing; its receipt says to plan again.
#![allow(
    clippy::result_large_err,
    reason = "the failure envelope is returned by value to its one printer; boxing would only add an allocation"
)]

use std::io::Write;

use cli_out::{Failure, Out, Outcome};
use cli_parse::Parsed;

use super::error;
use super::render::{self, Receipt};
use super::request::{self, Answer, StorageOperation};

/// The reviewed plan an apply carries: its raw JSON, id and revision.
pub(crate) struct Reviewed<'a> {
    pub(crate) plan_raw: &'a str,
    pub(crate) plan_id: &'a str,
    pub(crate) revision: &'a str,
}

/// Applies the exact reviewed plan and revision, then prints its receipt.
pub(crate) fn apply_reviewed<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
    id: &'static str,
    timeout: std::time::Duration,
    reviewed: &Reviewed<'_>,
) -> Outcome {
    let reply = match request::request(
        &StorageOperation::Apply {
            plan_id: reviewed.plan_id,
            revision: reviewed.revision,
        },
        timeout,
    ) {
        Ok(reply) => reply,
        Err(error) => {
            let failure = request::apply_transport(&error, reviewed.plan_id, reviewed.revision, id);
            return crate::run::fail(out, err, Some(&parsed.flags), &failure);
        }
    };
    finish_apply(
        parsed,
        out,
        err,
        id,
        &reply,
        &ApplyView::Clean {
            plan_raw: reviewed.plan_raw,
            plan_id: reviewed.plan_id,
            revision: reviewed.revision,
        },
    )
}

/// A plan id from the command line; the daemon checks that it names a plan.
fn plan_id(parsed: &Parsed<'_>, id: &'static str) -> Result<String, Failure<'static>> {
    let plan = parsed.words.first().copied().unwrap_or("");
    if plan.is_empty() || plan.len() > 256 {
        return Err(error::usage(
            "PLAN must be a plan id from ace storage plan.",
            "PLAN",
            id,
        ));
    }
    Ok(plan.to_owned())
}

/// Applies a reviewed cleanup plan.
pub(crate) fn apply<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    const ID: &str = "storage.apply";
    let plan = match plan_id(parsed, ID) {
        Ok(plan) => plan,
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    let revision = parsed.flags.value("revision");
    let Some(revision) = revision else {
        let failure = Failure::usage("--revision must be the revision the plan printed.")
            .with_code(cli_out::ErrorCode::MissingArgument)
            .with_argument("--revision")
            .with_hint(format!(
                "See it with ace storage plan, then ace storage apply {plan} --revision REVISION."
            ))
            .with_command(ID);
        return crate::run::fail(out, err, Some(&parsed.flags), &failure);
    };
    if revision.len() != 64
        || !revision
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        let failure = error::usage(
            "--revision must be the revision the plan printed.",
            "--revision",
            ID,
        )
        .with_hint(format!(
            "See it with ace storage plan, then ace storage apply {plan} --revision REVISION."
        ));
        return crate::run::fail(out, err, Some(&parsed.flags), &failure);
    }
    let timeout = match error::request_timeout(parsed.flags.value("timeout"), ID) {
        Ok(timeout) => timeout,
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    let reply = match request::request(
        &StorageOperation::Apply {
            plan_id: &plan,
            revision,
        },
        timeout,
    ) {
        Ok(reply) => reply,
        Err(error) => {
            let failure = request::apply_transport(&error, &plan, revision, ID);
            return crate::run::fail(out, err, Some(&parsed.flags), &failure);
        }
    };
    finish_apply(
        parsed,
        out,
        err,
        ID,
        &reply,
        &ApplyView::Apply {
            plan_id: &plan,
            revision,
        },
    )
}

/// Where a cleanup plan stands.
pub(crate) fn receipt_status<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    const ID: &str = "storage.status";
    let plan = match plan_id(parsed, ID) {
        Ok(plan) => plan,
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    let timeout = match error::request_timeout(parsed.flags.value("timeout"), ID) {
        Ok(timeout) => timeout,
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    let reply = match request::request(&StorageOperation::Status { plan_id: &plan }, timeout) {
        Ok(reply) => reply,
        Err(error) => {
            return crate::run::fail(
                out,
                err,
                Some(&parsed.flags),
                &error::wire_failure(&error, ID),
            );
        }
    };
    finish_apply(parsed, out, err, ID, &reply, &ApplyView::Status)
}

/// What a cleanup receipt prints as: an apply names its reviewed plan, a status read does not.
enum ApplyView<'a> {
    Apply {
        plan_id: &'a str,
        revision: &'a str,
    },
    Clean {
        plan_raw: &'a str,
        plan_id: &'a str,
        revision: &'a str,
    },
    Status,
}

impl ApplyView<'_> {
    /// The plan identity a lost acknowledgement would carry to read or retry it.
    fn evidence(&self) -> Option<serde_json::Value> {
        match self {
            Self::Apply { plan_id, revision }
            | Self::Clean {
                plan_id, revision, ..
            } => Some(serde_json::json!({ "planId": plan_id, "revision": revision })),
            Self::Status => None,
        }
    }
}

/// Prints a cleanup receipt with its outcome: complete, stale, or still pending.
fn finish_apply<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
    id: &'static str,
    reply: &cli_wire::Reply,
    view: &ApplyView<'_>,
) -> Outcome {
    let raw = match request::payload(
        reply,
        "apply",
        "The daemon returned no cleanup receipt",
        id,
        view.evidence(),
    ) {
        Ok(raw) => raw,
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    let receipt: Receipt<'_> = match request::decode(raw, id) {
        Ok(receipt) => receipt,
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    let outcome = match receipt.state.as_ref() {
        "complete" => Outcome::Ok,
        "stale" => Outcome::Refused,
        _ => Outcome::Uncertain,
    };
    // A receipt read back stands alone; one just applied names the plan it was reviewed under.
    // The daemon's receipt already names its plan; only a missing revision is appended.
    let json;
    let (shown, text) = match view {
        ApplyView::Apply { revision, .. } => {
            json = with_revision_json(raw.get(), receipt.revision.is_some(), revision);
            (with_revision(&receipt, Some(revision)), json.as_str())
        }
        ApplyView::Clean {
            plan_raw, revision, ..
        } => {
            json = format!(
                "{{\"plan\":{plan_raw},\"apply\":{}}}",
                with_revision_json(raw.get(), receipt.revision.is_some(), revision)
            );
            (with_revision(&receipt, Some(revision)), json.as_str())
        }
        ApplyView::Status => (with_revision(&receipt, None), raw.get()),
    };
    request::print_answer(
        parsed,
        out,
        err,
        id,
        &Answer {
            human: &[render::receipt_line(&shown)],
            json: text,
            quiet: &[],
            outcome,
        },
    )
}

/// The receipt as a person reads it: one just applied names the revision reviewed.
fn with_revision<'a>(receipt: &'a Receipt<'a>, revision: Option<&'a str>) -> Receipt<'a> {
    Receipt {
        plan_id: std::borrow::Cow::Borrowed(receipt.plan_id.as_ref()),
        state: std::borrow::Cow::Borrowed(receipt.state.as_ref()),
        items: receipt
            .items
            .iter()
            .map(|item| super::render::ReceiptItem {
                state: std::borrow::Cow::Borrowed(item.state.as_ref()),
            })
            .collect(),
        revision: revision
            .map(std::borrow::Cow::Borrowed)
            .or_else(|| receipt.revision.clone()),
    }
}

/// The receipt just applied, with the revision it was reviewed under. The daemon's receipt
/// already names its plan; the reviewed revision is appended after it, as the spread would.
/// A receipt that already names one keeps it.
fn with_revision_json(raw: &str, has_revision: bool, revision: &str) -> String {
    if has_revision {
        return raw.trim_end().to_owned();
    }
    merged_receipt(raw, revision)
}

/// Appends one key after the receipt's own, keeping the daemon's order.
fn merged_receipt(raw: &str, revision: &str) -> String {
    let trimmed = raw.trim_end();
    let Some(inner) = trimmed
        .strip_prefix('{')
        .and_then(|inner| inner.strip_suffix('}'))
    else {
        return trimmed.to_owned();
    };
    let revision = serde_json::to_string(revision).unwrap_or_else(|_| "\"\"".to_owned());
    format!("{{{inner},\"revision\":{revision}}}")
}
