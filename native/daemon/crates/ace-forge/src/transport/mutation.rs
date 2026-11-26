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
    // The method flags gh accepts (`gh api -X DELETE`, `-XDELETE`, `--method=DELETE`), then
    // a body field — `-f`, `-F`, `--field`, `--raw-field` — which makes the request a POST.
    let field = args.iter().any(|arg| {
        matches!(arg.as_str(), "-f" | "-F" | "--field" | "--raw-field")
            || arg.starts_with("--field=")
            || arg.starts_with("--raw-field=")
    });
    let method = if let Some(index) = args.iter().position(|arg| arg == "--method" || arg == "-X") {
        args.get(index + 1).map(String::as_str)
    } else if let Some(method) = args.iter().find_map(|arg| {
        arg.strip_prefix("--method=")
            .or_else(|| arg.strip_prefix("-X="))
            .or_else(|| arg.strip_prefix("-X").filter(|rest| !rest.is_empty()))
    }) {
        Some(method)
    } else if field || request.input.is_some() {
        Some("POST")
    } else {
        Some("GET")
    };
    if matches!(method, Some("GET" | "HEAD")) {
        return false;
    }
    // Rendering markdown is a read that happens to be a POST.
    if args.get(1).is_some_and(|arg| arg == "markdown") {
        return false;
    }
    if args.get(1).is_some_and(|arg| arg == "graphql")
        && let Some((document, operation)) = graphql_request(request.input.as_deref())
        && selected_is_query(&document, operation.as_deref())
    {
        return false;
    }
    true
}

/// The document and the `operationName` GraphQL would execute (`GraphqlRequest`).
fn graphql_request(input: Option<&str>) -> Option<(String, Option<String>)> {
    let value: Value = ace_json::parse(input?).ok()?;
    let body = value.as_object()?;
    let document = body.get("query")?.as_str()?.to_owned();
    let operation = body
        .get("operationName")
        .and_then(|name| name.as_str().map(str::to_owned));
    Some((document, operation))
}

/// The operation a document executes is a query (or the anonymous shorthand).
///
/// A document's first word is not enough: `query A { … } mutation B { … }` with
/// `operationName: B` executes the mutation. Operations are scanned (names and `{`/`(`),
/// and the selected one decides; an ambiguous multi-operation document without a name is
/// a write, never a read.
fn selected_is_query(document: &str, operation: Option<&str>) -> bool {
    let operations = graphql_operations(document);
    match operation {
        Some(name) => operations
            .iter()
            .find(|(operation_name, _)| operation_name.as_deref() == Some(name))
            .is_some_and(|(_, is_query)| *is_query),
        None => match operations.len() {
            1 => operations[0].1,
            _ => false,
        },
    }
}

/// The top-level operations of a document: its name (when it has one) and whether it is a
/// query. The anonymous `{ … }` shorthand is one unnamed query.
fn graphql_operations(document: &str) -> Vec<(Option<String>, bool)> {
    let bytes = document.as_bytes();
    let mut operations = Vec::new();
    let mut index = 0;
    let mut depth = 0i32;
    while index < bytes.len() {
        let byte = bytes[index];
        match byte {
            b'#' => {
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
                continue;
            }
            b'{' | b'(' | b'[' => depth += 1,
            b'}' | b')' | b']' => depth -= 1,
            b'q' | b'm' | b's' if depth <= 0 => {
                let rest = &document[index..];
                let (keyword, is_query) = if rest.starts_with("query") {
                    ("query", true)
                } else if rest.starts_with("mutation") {
                    ("mutation", false)
                } else if rest.starts_with("subscription") {
                    ("subscription", false)
                } else {
                    index += 1;
                    continue;
                };
                let after = index + keyword.len();
                // The keyword needs a boundary: `queryX` is a name, not a query.
                if document
                    .as_bytes()
                    .get(after)
                    .is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
                {
                    index += 1;
                    continue;
                }
                // GraphQL's `Name`: letters, digits and `_`, after whitespace and commas
                // (so `query Foo($id:ID!)` is named `Foo`, not the whole signature).
                let named = document.get(after..).and_then(|rest| {
                    let name: String = rest
                        .trim_start_matches([' ', '\t', '\r', '\n', ','])
                        .chars()
                        .take_while(|character| {
                            character.is_ascii_alphanumeric() || *character == '_'
                        })
                        .collect();
                    (!name.is_empty()).then_some(name)
                });
                operations.push((named, is_query));
                index = after;
                continue;
            }
            _ => {}
        }
        index += 1;
    }
    if operations.is_empty() && document.trim_start().starts_with('{') {
        operations.push((None, true));
    }
    operations
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
            let mut error = ForgeError::new(Kind::OutcomeUncertain);
            error.dispatched = Some(true);
            error
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
    fn every_method_and_field_alias_is_read() {
        let read = api(&["api", "repos/o/r", "-XGET"], None);
        assert!(!is_forge_mutation(&read));
        let read = api(&["api", "repos/o/r", "--method=GET"], None);
        assert!(!is_forge_mutation(&read));
        for write in [
            api(&["api", "repos/o/r", "-XDELETE"], None),
            api(&["api", "repos/o/r", "-X=DELETE"], None),
            api(&["api", "repos/o/r", "--method=PATCH"], None),
            api(&["api", "repos/o/r", "-f", "title=x"], None),
            api(&["api", "repos/o/r", "-F", "file=@x"], None),
            api(&["api", "repos/o/r", "--field", "title=x"], None),
            api(&["api", "repos/o/r", "--raw-field=title=x"], None),
        ] {
            assert!(is_forge_mutation(&write), "{:?}", write.args);
        }
    }

    #[test]
    fn a_compact_named_query_with_a_signature_is_a_read() {
        let request = api(
            &["api", "graphql", "--method", "POST"],
            Some(
                r#"{"query":"query Foo($id:ID!){repository(id:$id){name}}","operationName":"Foo"}"#,
            ),
        );
        assert!(
            super::selected_is_query("query Foo($id:ID!){repository(id:$id){name}}", Some("Foo")),
            "the parser names the operation"
        );
        assert!(!is_forge_mutation(&request));
    }

    #[test]
    fn a_named_mutation_second_in_the_document_is_a_write() {
        let request = api(
            &["api", "graphql", "--method", "POST"],
            Some(
                r#"{"query":"query A { viewer { login } } mutation B { x }","operationName":"B"}"#,
            ),
        );
        assert!(is_forge_mutation(&request));
        let query = api(
            &["api", "graphql", "--method", "POST"],
            Some(
                r#"{"query":"query A { viewer { login } } mutation B { x }","operationName":"A"}"#,
            ),
        );
        assert!(!is_forge_mutation(&query));
        let ambiguous = api(
            &["api", "graphql", "--method", "POST"],
            Some(r#"{"query":"query A { x } query B { y }"}"#),
        );
        assert!(
            is_forge_mutation(&ambiguous),
            "an unnamed multi-operation document is a write"
        );
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
