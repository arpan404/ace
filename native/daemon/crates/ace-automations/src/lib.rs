// SPDX-License-Identifier: Apache-2.0
//! The scheduler for `@ace/automations` (ADR 0225 A1): recurrence and the calendar in the
//! person's IANA zone, next-run computation with jitter, the missed-run and catch-up rules, and
//! the durable definition state both daemons share. Decision logic is pure and takes its clock,
//! random draw and ids from injected ports; SQLite lives in [`store`] and nothing at open scans
//! run history (ADR 0170).

pub mod calendar;
pub mod decisions;
pub mod error;
pub mod github;
pub mod grammar;
pub mod recurrence;
pub mod scheduler;
pub mod service;
pub mod store;
mod store_schema;
pub mod webhook_body;
pub mod webhook_secret_box;
pub mod webhook_signature;
pub mod webhooks;

pub use decisions::{
    PAUSED_REFUSAL, PAUSED_RESULT, RUNNING_LIMIT, admission, can_promote, jitter_deadline,
    recover_occurrence, render_prompt, run_access, scheduled_deadline, with_run_note,
};
pub use error::{AutomationsError, Result};
pub use github::{
    GhClient, GhResponse, GithubEntry, GithubEvent, GithubPage, GithubPoll, GithubState,
    GithubTrigger, endpoint, gh_arguments, github_events, parse_gh_response, poll_github,
    validate_request,
};
pub use recurrence::{Occurrence, Recurrence, Schedule, ScheduleKind, next_occurrence};
pub use scheduler::{Clock, FixedClock, IdSource, Random, Scheduler, StartOutcome, TickOutcome};
pub use service::{Action, Ports, Service, Workspace, manual_id};
pub use store::{AutomationStore, Definition, Job, JobMetadata, ScheduleTrigger, Trigger};
pub use webhook_body::{WEBHOOK_BODY_LIMITS, WebhookBodyError, webhook_variables};
pub use webhook_secret_box::{SecretBox, decode_base64_lenient, new_webhook_secret};
pub use webhook_signature::{
    HeaderError, WEBHOOK_TOLERANCE_MS, WebhookCheck, WebhookHeaders, read_webhook_headers,
    sign_webhook, verify_webhook,
};
pub use webhooks::{
    RotatedSecret, WebhookAnswer, WebhookDeps, WebhookRequest, Webhooks, valid_hook_id,
};
