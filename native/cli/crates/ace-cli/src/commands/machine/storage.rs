// SPDX-License-Identifier: Apache-2.0
//! `storage usage|plan|compact` (ADR 0178 §7): measurement, cleanup previews, and compaction.
//! The daemon owns the inventory and every effect; these only ask and print. The cleanup flow
//! lives in `clean.rs`, reviewed applies in `apply.rs`, and the wire in `request.rs`.

use std::io::Write;

use cli_out::{Out, Outcome};
use cli_parse::Parsed;

use super::error;
use super::plan::PlanOperation;
use super::render::{self, Compaction, Plan, Usage};
use super::request::{self, Answer, StorageOperation};

/// What `ace storage usage` uses on disk.
pub(crate) fn usage<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    const ID: &str = "storage.usage";
    let timeout = match error::request_timeout(parsed.flags.value("timeout"), ID) {
        Ok(timeout) => timeout,
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    let reply = match request::request(&StorageOperation::Usage { force: true }, timeout) {
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
    let raw = match request::payload(&reply, "usage", "The daemon returned no usage.", ID, None) {
        Ok(raw) => raw,
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    let measured: Usage<'_> = match request::decode(raw, ID) {
        Ok(measured) => measured,
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    request::print_answer(
        parsed,
        out,
        err,
        ID,
        &Answer {
            human: &render::usage_lines(&measured),
            json: raw.get(),
            quiet: &[],
            outcome: Outcome::Ok,
        },
    )
}

/// Plans a cleanup to review, without removing anything.
pub(crate) fn plan<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    const ID: &str = "storage.plan";
    super::clean::plan_or_clean(parsed, out, err, ID, true)
}

/// Shows one plan with the command that applies it.
pub(crate) fn print_plan<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
    id: &'static str,
    operation: &PlanOperation,
    timeout: std::time::Duration,
) -> Outcome {
    let reply = match request::plan_request(operation, timeout) {
        Ok(reply) => reply,
        Err(error) => {
            return crate::run::fail(
                out,
                err,
                Some(&parsed.flags),
                &error::wire_failure(&error, id),
            );
        }
    };
    let raw = match request::payload(&reply, "plan", "The daemon returned no plan.", id, None) {
        Ok(raw) => raw,
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    let measured: Plan<'_> = match request::decode(raw, id) {
        Ok(measured) => measured,
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    request::print_answer(
        parsed,
        out,
        err,
        id,
        &Answer {
            human: &render::review_lines(&measured),
            json: raw.get(),
            quiet: &[measured.id.to_string()],
            outcome: Outcome::Ok,
        },
    )
}

/// Gives the database's free space back to the disk.
pub(crate) fn compact<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    const ID: &str = "storage.compact";
    let timeout = match error::request_timeout(parsed.flags.value("timeout"), ID) {
        Ok(timeout) => timeout,
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    let operation = match parsed.flags.value("abandon") {
        Some(id) => StorageOperation::CompactAbandon { compaction_id: id },
        None => StorageOperation::Compact,
    };
    let reply = match request::request(&operation, timeout) {
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
    let raw = match request::payload(
        &reply,
        "compaction",
        "The daemon returned an unexpected storage result.",
        ID,
        None,
    ) {
        Ok(raw) => raw,
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    let compaction: Compaction<'_> = match request::decode(raw, ID) {
        Ok(compaction) => compaction,
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    let done = matches!(compaction.state.as_ref(), "complete" | "abandoned");
    request::print_answer(
        parsed,
        out,
        err,
        ID,
        &Answer {
            human: &render::compaction_lines(&compaction),
            json: raw.get(),
            quiet: &[compaction.id.to_string()],
            outcome: if done {
                Outcome::Ok
            } else {
                Outcome::Uncertain
            },
        },
    )
}
