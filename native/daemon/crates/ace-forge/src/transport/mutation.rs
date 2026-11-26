// SPDX-License-Identifier: Apache-2.0
//! Write classification and dispatch certainty (`mutation.ts`, ADR 0117): a request is a
//! write unless it is a GET/HEAD, `api markdown`, or a GraphQL `query`; certainty comes from
//! process admission, never from a probe's error.

use std::collections::HashSet;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use ace_json::Value;

use crate::transport::command::CommandRequest;
use crate::transport::error::{ForgeError, Kind};

/// How long an uncertain write fences a retry of the same write: ten minutes.
pub const UNCERTAIN_WRITE_WINDOW_MS: f64 = 600_000.0;

/// HTTP statuses after which a host has certainly not applied a write, under an unchanged
/// identity. Any other failure after dispatch is uncertain.
pub static REFUSED_WRITE_STATUSES: [u16; 9] = [400, 401, 403, 404, 405, 409, 412, 422, 429];

/// Whether `request` may change state on a host.
pub fn is_forge_mutation(request: &CommandRequest) -> bool {
    let args = &request.args;
    if args.first().is_some_and(|arg| arg == "pr") && args.get(1).is_some_and(|arg| arg == "merge")
    {
        return true;
    }
    if args.first().is_none_or(|arg| arg != "api") {
        return false;
    }
    let method = match args.iter().position(|arg| arg == "--method") {
        Some(index) => args.get(index + 1).map(String::as_str),
        None if request.input.is_none() => Some("GET"),
        None => Some("POST"),
    };
    if matches!(method, Some("GET" | "HEAD")) {
        return false;
    }
    // Rendering markdown is a read that happens to be a POST.
    if args.get(1).is_some_and(|arg| arg == "markdown") {
        return false;
    }
    if args.get(1).is_some_and(|arg| arg == "graphql") {
        let query = graphql_query(request.input.as_deref());
        if let Some(query) = query
            && starts_with_query(&query)
        {
            return false;
        }
    }
    true
}

/// `GraphqlRequest.parse(JSON.parse(input)).query`: a string field, else nothing.
fn graphql_query(input: Option<&str>) -> Option<String> {
    let value: Value = ace_json::parse(input?).ok()?;
    let body = value.as_object()?;
    body.get("query")
        .and_then(|query| query.as_str().map(str::to_owned))
}

/// `^\s*(?:query\b|\{)`: a complete query cannot change state.
fn starts_with_query(query: &str) -> bool {
    let trimmed = query.trim_start();
    trimmed.starts_with('{')
        || trimmed
            .strip_prefix("query")
            .is_some_and(|rest| !rest.chars().next().is_some_and(is_word))
}

fn is_word(character: char) -> bool {
    character.is_ascii_alphanumeric() || character == '_'
}

/// True once a write reserved at `at` has outlived the uncertainty window.
pub fn uncertain_write_expired(at: f64, now: f64) -> bool {
    now - at >= UNCERTAIN_WRITE_WINDOW_MS
}

/// The write's state as admission records it: prepared before the spawn, dispatched after.
#[derive(Default)]
pub struct MutationDispatch {
    dispatched: AtomicBool,
    rejected: AtomicBool,
    before_dispatch: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
}

impl MutationDispatch {
    /// A dispatch record that journals possible dispatch before spawning.
    pub fn new(before_dispatch: Option<Box<dyn Fn() + Send + Sync>>) -> MutationDispatch {
        MutationDispatch {
            dispatched: AtomicBool::new(false),
            rejected: AtomicBool::new(false),
            before_dispatch: Mutex::new(before_dispatch),
        }
    }

    /// Journals possible dispatch before spawning, closing the crash gap. The closure appends
    /// a journal line and never re-enters this record, so the lock is held across it.
    pub fn prepare(&self) {
        let journal = self
            .before_dispatch
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(before) = journal.as_ref() {
            before();
        }
    }

    /// The CLI started: from now on a failure is uncertain unless the host refused it.
    pub fn record(&self) {
        self.dispatched.store(true, Ordering::SeqCst);
    }

    /// The request certainly failed before dispatch, or the host certainly refused it.
    pub fn reject(&self) {
        self.rejected.store(true, Ordering::SeqCst);
    }

    /// Whether the CLI started.
    pub fn dispatched(&self) -> bool {
        self.dispatched.load(Ordering::SeqCst)
    }

    /// Whether the failure certainly left no effect.
    pub fn definitely_failed(&self) -> bool {
        !self.dispatched() || self.rejected.load(Ordering::SeqCst)
    }

    /// The error to report: the original when it certainly failed, else `outcome_uncertain`.
    pub fn failure(&self, error: ForgeError) -> ForgeError {
        if self.definitely_failed() || error.kind == Kind::OutcomeUncertain {
            error
        } else {
            ForgeError::new(Kind::OutcomeUncertain)
        }
    }
}

impl std::fmt::Debug for MutationDispatch {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("MutationDispatch")
            .field("dispatched", &self.dispatched())
            .field("rejected", &self.rejected.load(Ordering::SeqCst))
            .finish()
    }
}

/// The refused statuses as a set, for a caller comparing one reply.
pub fn refused_write_statuses() -> HashSet<u16> {
    REFUSED_WRITE_STATUSES.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::{
        MutationDispatch, UNCERTAIN_WRITE_WINDOW_MS, is_forge_mutation, refused_write_statuses,
        uncertain_write_expired,
    };
    use crate::transport::command::CommandRequest;
    use crate::transport::error::{ForgeError, Kind};

    fn api(args: &[&str], input: Option<&str>) -> CommandRequest {
        let mut request = CommandRequest::new(
            "gh",
            args.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>(),
        );
        if let Some(input) = input {
            request = request.with_input(input);
        }
        request
    }

    #[test]
    fn a_get_or_a_markdown_render_or_a_graphql_query_is_a_read() {
        for request in [
            api(&["api", "repos/o/r/pulls/7", "--method", "GET"], None),
            api(&["api", "repos/o/r/pulls/7", "--method", "HEAD"], None),
            api(&["api", "markdown", "--method", "POST"], None),
            api(
                &["api", "graphql"],
                Some(r#"{"query":"query { viewer { login } }"}"#),
            ),
            api(
                &["api", "graphql"],
                Some(r#"{"query":"{ viewer { login } }"}"#),
            ),
            api(&["pr", "view", "7"], None),
            api(&["api", "repos/o/r/issues"], None),
        ] {
            assert!(!is_forge_mutation(&request), "{:?}", request.args);
        }
    }

    #[test]
    fn anything_else_that_may_change_state_is_a_write() {
        for request in [
            api(&["pr", "merge", "7"], None),
            api(
                &["api", "repos/o/r/pulls/7/merge", "--method", "PUT"],
                Some("{}"),
            ),
            api(&["api", "graphql"], Some(r#"{"query":"mutation { x }"}"#)),
            api(&["api", "graphql"], Some("not json")),
            api(
                &["api", "graphql"],
                Some(r#"{"query":"queryX { viewer { login } }"}"#),
            ),
            api(&["api", "repos/o/r/issues"], Some("{}")),
        ] {
            assert!(is_forge_mutation(&request), "{:?}", request.args);
        }
    }

    #[test]
    fn an_uncertain_write_is_fenced_for_ten_minutes() {
        assert_eq!(UNCERTAIN_WRITE_WINDOW_MS, 600_000.0);
        assert!(!uncertain_write_expired(1_000.0, 1_000.0 + 599_999.0));
        assert!(uncertain_write_expired(1_000.0, 1_000.0 + 600_000.0));
    }

    #[test]
    fn the_refused_statuses_are_exactly_the_hosts_certain_refusals() {
        let statuses = refused_write_statuses();
        for status in [400, 401, 403, 404, 405, 409, 412, 422, 429] {
            assert!(statuses.contains(&status), "{status}");
        }
        assert!(!statuses.contains(&500));
        assert!(!statuses.contains(&202));
        assert_eq!(statuses.len(), 9);
    }

    #[test]
    fn a_failure_after_dispatch_is_uncertain_and_before_it_is_not() {
        let dispatch = MutationDispatch::new(None);
        let failing = || ForgeError::new(Kind::Cli);
        assert_eq!(dispatch.failure(failing()).kind, Kind::Cli);
        dispatch.record();
        assert_eq!(dispatch.failure(failing()).kind, Kind::OutcomeUncertain);
        dispatch.reject();
        assert_eq!(dispatch.failure(failing()).kind, Kind::Cli);
        assert!(dispatch.definitely_failed());
    }

    #[test]
    fn an_outcome_uncertain_error_keeps_its_own_kind() {
        let dispatch = MutationDispatch::new(None);
        dispatch.record();
        let error = ForgeError::new(Kind::OutcomeUncertain);
        assert_eq!(dispatch.failure(error.clone()), error);
    }
}
