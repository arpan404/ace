// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
//! Ports the decision cases of `packages/automations/src/github.process.test.ts` and
//! `gh-process.process.test.ts`: baseline, conditional pages, per-event filters, bounded
//! pagination, malformed resources, and the `gh --include` response and request checks. The
//! process spawning, abort and byte-limit cases belong to the `ace-supervisor` wiring.

use std::cell::RefCell;
use std::collections::VecDeque;

use ace_automations::Result;
use ace_automations::github::{
    GhClient, GhResponse, GithubTrigger, gh_arguments, parse_gh_response, poll_github,
    validate_request,
};
use ace_json::Value;

const PULLS: &str = "repos/user/project/pulls?state=all&sort=updated&direction=desc&per_page=100";
const PAGE2: &str =
    "repos/user/project/pulls?state=all&sort=updated&direction=desc&per_page=100&page=2";

fn trigger(event: &str) -> GithubTrigger {
    GithubTrigger {
        repository: "user/project".to_owned(),
        event: event.to_owned(),
        label: None,
        pull_request: None,
        poll_interval_ms: 60_000,
    }
}

fn json(text: &str) -> Value {
    ace_json::parse(text).expect("json")
}

fn resource(id: i64, version: &str) -> String {
    format!(
        r#"{{"id":{id},"number":{id},"updated_at":"{version}","html_url":"https://github.com/user/project/pull/{id}","title":"Review","body":"Untrusted {{{{value}}}}"}}"#
    )
}

#[derive(Default)]
struct FakeGh {
    responses: RefCell<VecDeque<GhResponse>>,
    calls: RefCell<Vec<(String, Option<String>)>>,
}

impl FakeGh {
    fn push(&self, response: GhResponse) {
        self.responses.borrow_mut().push_back(response);
    }

    fn calls(&self) -> Vec<(String, Option<String>)> {
        self.calls.borrow().clone()
    }
}

impl GhClient for FakeGh {
    fn get(&self, endpoint: &str, etag: Option<&str>) -> Result<GhResponse> {
        self.calls
            .borrow_mut()
            .push((endpoint.to_owned(), etag.map(str::to_owned)));
        self.responses
            .borrow_mut()
            .pop_front()
            .ok_or_else(|| ace_automations::AutomationsError::message("no fake response"))
    }
}

fn ok(etag: Option<&str>, data: &str, next: Option<&str>) -> GhResponse {
    GhResponse {
        status: 200,
        etag: etag.map(str::to_owned),
        next: next.map(str::to_owned),
        data: Some(json(data)),
    }
}

fn not_modified() -> GhResponse {
    GhResponse {
        status: 304,
        etag: None,
        next: None,
        data: None,
    }
}

#[test]
fn uses_conditional_gets_establishes_a_baseline_and_emits_only_changed_prs() {
    let gh = FakeGh::default();
    gh.push(ok(
        Some("\"v1\""),
        &format!("[{}]", resource(1, "2024-01-01T00:00:00Z")),
        None,
    ));
    let first = poll_github(&gh, &trigger("pr_changed"), &json("{}")).expect("baseline");
    assert!(first.events.is_empty());
    gh.push(not_modified());
    let unchanged =
        poll_github(&gh, &trigger("pr_changed"), &serde_state(&first.state)).expect("unchanged");
    assert!(unchanged.events.is_empty());
    assert_eq!(gh.calls()[1].1.as_deref(), Some("\"v1\""));
    assert_eq!(gh.calls()[0].0, PULLS);
    gh.push(ok(
        Some("\"v2\""),
        &format!(
            "[{},{}]",
            resource(1, "2024-01-02T00:00:00Z"),
            resource(2, "2024-01-01T00:00:00Z")
        ),
        None,
    ));
    let changed =
        poll_github(&gh, &trigger("pr_changed"), &serde_state(&unchanged.state)).expect("changed");
    let keys: Vec<&str> = changed
        .events
        .iter()
        .map(|event| event.key.as_str())
        .collect();
    assert_eq!(
        keys,
        vec![
            "github:pr_changed:1:2024-01-02T00:00:00Z",
            "github:pr_changed:2:2024-01-01T00:00:00Z"
        ]
    );
    assert_eq!(
        changed.events[0].variables.get("body").map(String::as_str),
        Some("Untrusted {{value}}")
    );
    gh.push(not_modified());
    assert!(
        poll_github(&gh, &trigger("pr_changed"), &serde_state(&changed.state))
            .expect("again")
            .events
            .is_empty()
    );
}

fn serde_state(state: &ace_automations::GithubState) -> Value {
    let text = ace_json::ser::to_string(state).expect("state");
    ace_json::parse(&text).expect("json")
}

#[test]
fn retains_all_conditional_pages_and_does_not_duplicate_resources_that_move_pages() {
    let gh = FakeGh::default();
    gh.push(ok(
        Some("\"one\""),
        &format!("[{}]", resource(1, "2024-01-01T00:00:00Z")),
        Some(PAGE2),
    ));
    gh.push(ok(
        Some("\"two\""),
        &format!("[{}]", resource(2, "2024-01-01T00:00:00Z")),
        None,
    ));
    let baseline = poll_github(&gh, &trigger("pr_changed"), &json("{}")).expect("baseline");
    gh.push(ok(
        Some("\"new\""),
        &format!(
            "[{},{}]",
            resource(1, "2024-01-02T00:00:00Z"),
            resource(2, "2024-01-01T00:00:00Z")
        ),
        Some(PAGE2),
    ));
    gh.push(not_modified());
    let changed =
        poll_github(&gh, &trigger("pr_changed"), &serde_state(&baseline.state)).expect("changed");
    assert_eq!(changed.events.len(), 1);
    assert_eq!(
        gh.calls().last().and_then(|call| call.1.as_deref()),
        Some("\"two\"")
    );
}

#[test]
fn emits_failed_ci_runs_only_for_the_configured_pull_request() {
    let gh = FakeGh::default();
    gh.push(ok(None, r#"{"workflow_runs":[]}"#, None));
    let mut ci = trigger("ci_failed");
    ci.pull_request = Some(42);
    let first = poll_github(&gh, &ci, &json("{}")).expect("baseline");
    gh.push(ok(
    None,
    r#"{"workflow_runs":[
      {"id":1,"updated_at":"2024-01-01T00:00:00Z","html_url":"u1","conclusion":"failure","pull_requests":[{"number":42}]},
      {"id":2,"updated_at":"2024-01-01T00:00:00Z","html_url":"u2","conclusion":"success","pull_requests":[{"number":42}]},
      {"id":3,"updated_at":"2024-01-01T00:00:00Z","html_url":"u3","conclusion":"failure","pull_requests":[{"number":7}]}
    ]}"#,
    None,
  ));
    let current = poll_github(&gh, &ci, &serde_state(&first.state)).expect("changed");
    assert_eq!(current.events.len(), 1);
    assert_eq!(
        current.events[0]
            .variables
            .get("pull_requests")
            .map(String::as_str),
        Some("42")
    );
}

#[test]
fn emits_review_comments_and_newly_applied_matching_issue_labels() {
    let gh = FakeGh::default();
    gh.push(ok(None, "[]", None));
    let mut review = trigger("review_comment");
    review.pull_request = Some(42);
    let before = poll_github(&gh, &review, &json("{}")).expect("baseline");
    gh.push(ok(
    None,
    r#"[{"id":1,"updated_at":"2024-01-01T00:00:00Z","html_url":"u","pull_request_url":"https://api.github.com/repos/user/project/pulls/42"}]"#,
    None,
  ));
    let events = poll_github(&gh, &review, &serde_state(&before.state))
        .expect("changed")
        .events;
    assert!(events[0].key.contains("review_comment"));

    let gh = FakeGh::default();
    gh.push(ok(None, "[]", None));
    let mut issue = trigger("issue_labelled");
    issue.label = Some("fix".to_owned());
    let before = poll_github(&gh, &issue, &json("{}")).expect("baseline");
    gh.push(ok(
    None,
    r#"[{"id":1,"updated_at":"2024-01-01T00:00:00Z","html_url":"u","labels":[{"name":"old"}]}]"#,
    None,
  ));
    let previous = poll_github(&gh, &issue, &serde_state(&before.state)).expect("first");
    let _ = previous;
    gh.push(ok(
    None,
    r#"[
      {"id":1,"updated_at":"2024-01-02T00:00:00Z","html_url":"u","labels":[{"name":"old"},{"name":"fix"},{"name":"unrelated"}]},
      {"id":2,"updated_at":"2024-01-01T00:00:00Z","html_url":"u","pull_request":{},"labels":[{"name":"fix"}]}
    ]"#,
    None,
  ));
    let current = poll_github(&gh, &issue, &serde_state(&previous.state)).expect("labels");
    assert_eq!(current.events.len(), 1);
    assert_eq!(
        current.events[0].variables.get("label").map(String::as_str),
        Some("fix")
    );
    gh.push(ok(
    None,
    r#"[{"id":1,"updated_at":"2024-01-03T00:00:00Z","html_url":"u","labels":[{"name":"old"},{"name":"fix"}]}]"#,
    None,
  ));
    assert!(
        poll_github(&gh, &issue, &serde_state(&current.state))
            .expect("again")
            .events
            .is_empty()
    );
}

#[test]
fn rejects_malformed_resource_data() {
    let gh = FakeGh::default();
    gh.push(ok(Some("\"bad\""), r#"[{"id":"not an ID"}]"#, None));
    let error = poll_github(&gh, &trigger("pr_changed"), &json("{}")).expect_err("bad resource");
    assert!(error.to_string().contains("\"id\""), "{error}");
}

#[test]
fn rejects_pagination_loops_and_cross_repository_next_pages() {
    let gh = FakeGh::default();
    gh.push(ok(None, "[]", Some(PULLS)));
    let error = poll_github(&gh, &trigger("pr_changed"), &json("{}")).expect_err("loop");
    assert!(error.to_string().contains("window"), "{error}");
    let gh = FakeGh::default();
    gh.push(ok(None, "[]", Some("repos/other/project/pulls?page=2")));
    let error = poll_github(&gh, &trigger("pr_changed"), &json("{}")).expect_err("escape");
    assert!(error.to_string().contains("repository"), "{error}");
}

#[test]
fn parses_gh_include_responses_with_etags_and_next_links() {
    let output = b"HTTP/2.0 200 OK\r\nETag: \"v1\"\r\nLink: <https://api.github.com/repos/user/project/pulls?page=2>; rel=\"next\"\r\n\r\n[]";
    let response = parse_gh_response(output, Some(0)).expect("response");
    assert_eq!(response.status, 200);
    assert_eq!(response.etag.as_deref(), Some("\"v1\""));
    assert_eq!(
        response.next.as_deref(),
        Some("repos/user/project/pulls?page=2")
    );
    let not_modified = parse_gh_response(
        b"HTTP/2.0 304 Not Modified\r\nETag: \"v1\"\r\n\r\n",
        Some(1),
    )
    .expect("304");
    assert_eq!(not_modified.status, 304);
    assert!(not_modified.data.is_none());
    assert!(parse_gh_response(b"HTTP/2.0 500 Oops\r\n\r\n", Some(0)).is_err());
    assert!(parse_gh_response(b"no headers", Some(0)).is_err());
    assert!(
        parse_gh_response(
            b"HTTP/2.0 200 OK\r\nLink: <https://attacker.example/x>; rel=\"next\"\r\n\r\n[]",
            Some(0)
        )
        .is_err()
    );
}

#[test]
fn refuses_noncanonical_endpoints_and_header_injection_before_spawning() {
    assert!(validate_request("https://attacker.example", None).is_err());
    assert!(validate_request("repos/user/project/../../other/project/issues", None).is_err());
    assert!(validate_request("repos/user/project/./issues", None).is_err());
    assert!(validate_request(PULLS, Some("bad\r\nHeader: injected")).is_err());
    assert!(validate_request(PULLS, Some("\"v1\"")).is_ok());
    let args = gh_arguments(PULLS, Some("\"v1\""));
    assert!(args.iter().any(|arg| arg == "If-None-Match: \"v1\""));
    assert!(args.iter().any(|arg| arg == "github.com"));
}
