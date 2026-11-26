// SPDX-License-Identifier: Apache-2.0
//! The scheduler for `@ace/automations` (ADR 0225 A1): recurrence and the calendar in the
//! person's IANA zone, next-run computation with jitter, the missed-run and catch-up rules, and
//! the durable definition state both daemons share. Decision logic is pure and takes its clock,
//! random draw and ids from injected ports; SQLite lives in [`store`] and nothing at open scans
//! run history (ADR 0170).

pub mod calendar;
pub mod decisions;
pub mod error;
pub mod grammar;
pub mod recurrence;
pub mod scheduler;
pub mod store;

pub use decisions::{
    PAUSED_REFUSAL, PAUSED_RESULT, RUNNING_LIMIT, admission, can_promote, jitter_deadline,
    recover_occurrence, render_prompt, run_access, scheduled_deadline, with_run_note,
};
pub use error::{AutomationsError, Result};
pub use recurrence::{Occurrence, Recurrence, next_occurrence};
pub use scheduler::{Clock, FixedClock, IdSource, Random, Scheduler, StartOutcome, TickOutcome};
pub use store::{AutomationStore, Definition, Job, JobMetadata, ScheduleTrigger, Trigger};
