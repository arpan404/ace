// SPDX-License-Identifier: Apache-2.0
//! `queue-commands.ts`'s resume and limit branches (E5.4d): a scheduled resume, a limit hold, a
//! switch or a migration, each holding the queue until the continuation runs.

use ace_json::Value;

use crate::commands::error;
use crate::queue::{holds, store, write};
use crate::{Core, EngineError, State};

#[allow(clippy::too_many_arguments)]
pub fn limit_or_resume(
    core: &Core,
    state: &mut State,
    command: &Value,
    thread: &str,
    p: &Value,
    id: &str,
    queue: &crate::queue::record::RecoveryRecord,
    now: f64,
    kind: &str,
) -> Result<Value, EngineError> {
    let fail = |code: &str| error(id, code);
    let action = p.get("action").and_then(Value::as_str).unwrap_or_default();
    let limit = kind == "thread.limit";
    if limit && action == "migrate_now" {
        if state.session_backend(&core.store, thread)?.as_deref() == Some("cursor-sdk") {
            return Ok(fail("sdk_account_migration_unsupported"));
        }
        let provider = crate::commands::prelude::thread_row(core, thread)?.and_then(|row| {
            row.get("provider")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
        if provider.as_deref() == Some("acp") {
            return Ok(fail("acp_account_fixed"));
        }
        if !core.ports.has_move_target() {
            return Ok(fail("migration_unavailable"));
        }
    }
    if limit && action == "cancel_resume" {
        if !queue.paused
            || queue.reason.as_deref() != Some("limit")
            || queue.timer_action.as_deref() != Some("resume")
        {
            return Ok(fail("no_scheduled_resume"));
        }
        let lifts = queue.limited && queue.resume_at.is_some();
        let patch = format!(
            r#"{{"holdToken":{},"resumeAt":{},"timerAction":{}}}"#,
            queue.hold_token + 1,
            if lifts {
                queue
                    .resume_at
                    .map_or("null".to_owned(), |at| at.to_string())
            } else {
                "null".to_owned()
            },
            if lifts { "\"clear\"" } else { "null" },
        );
        write::set(&core.store, thread, &patch, now)?;
        holds::schedule(core)?;
        return Ok(crate::commands::ok(id, None));
    }
    if limit && action == "switch" && p.get("selection").is_none() {
        return Ok(fail("switch_selection_required"));
    }
    if limit && matches!(action, "resume_at_reset" | "snooze_until_reset") {
        let reset = if core.ports.has_reset_at() {
            core.ports.reset_at(thread).flatten()
        } else {
            queue.reset_at
        };
        if reset.is_none() || reset.is_some_and(|at| at as f64 <= now) {
            return Ok(fail("reset_time_unknown"));
        }
        let Some(reset) = reset else {
            return Ok(fail("reset_time_unknown"));
        };
        let (reason, timer) = if action == "resume_at_reset" {
            ("limit", "resume")
        } else {
            ("snooze", "snooze")
        };
        let patch = format!(
            r#"{{"paused":true,"holdToken":{},"reason":"{reason}","resumeAt":{},"timerAction":"{timer}"}}"#,
            queue.hold_token + 1,
            reset
        );
        write::set(&core.store, thread, &patch, now)?;
        holds::schedule(core)?;
        return Ok(crate::commands::ok(id, None));
    }
    if store::has_uncertain(core.store.conn(), thread)? {
        return Ok(fail("uncertain_delivery"));
    }
    if crate::intents::store::recovering(core.store.conn(), thread)? {
        return Ok(fail("recovery_in_progress"));
    }
    if !state.repo.reserve(&core.store, thread)? {
        return Ok(fail("engine_capacity_exceeded"));
    }
    crate::intents::lifecycle::add(&core.store, command, thread, None, None)?;
    // The person's own accepted Resume starts a fresh run for the loop guard.
    if kind != "thread.limit"
        && command
            .get("deviceId")
            .and_then(Value::as_str)
            .is_some_and(|device| device != "engine")
    {
        crate::queue::admission::clear_restart_streak(core.store.conn(), thread)?;
    }
    let reason = queue
        .reason
        .as_deref()
        .map_or("\"manual\"".to_owned(), |reason| format!("\"{reason}\""));
    let patch = format!(
        r#"{{"paused":true,"holdToken":{},"reason":{reason},"resumeAt":null,"timerAction":null}}"#,
        queue.hold_token + 1
    );
    write::set(&core.store, thread, &patch, now)?;
    holds::wake(core, thread);
    holds::schedule(core)?;
    Ok(crate::commands::ok(id, None))
}
