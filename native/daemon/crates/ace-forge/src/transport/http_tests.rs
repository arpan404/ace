// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::expect_used)]

use std::pin::Pin;
use std::sync::Mutex;

use ace_json::json;

use super::{GhApi, Page, redact_data};
use crate::transport::command::{CommandRequest, CommandResult, Runner, RunnerOptions};
use crate::transport::error::Kind;
use crate::transport::http_errors::{blank_line, headers_of, status_of};

#[derive(Default)]
struct Stub {
    replies: Mutex<Vec<CommandResult>>,
    seen: Mutex<Vec<CommandRequest>>,
}

impl Runner for Stub {
    fn credential_environment(&self) -> Option<ace_redaction::EnvironmentMatcher> {
        None
    }

    fn run<'a>(
        &'a self,
        request: CommandRequest,
    ) -> Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<CommandResult, crate::transport::error::ForgeError>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            if let Some(dispatch) = &request.dispatch {
                dispatch.prepare();
                dispatch.record();
            }
            self.seen.lock().expect("seen").push(request);
            Ok(self.replies.lock().expect("replies").remove(0))
        })
    }
}

fn reply(text: &str) -> CommandResult {
    CommandResult {
        code: Some(0),
        stdout: text.to_owned(),
        truncated: false,
        identity_changed: false,
        http: None,
        unreachable: false,
    }
}

fn api(json: &str, extra: &str) -> String {
    format!("HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n{extra}\r\n{json}")
}

fn stub(replies: &[&str]) -> Stub {
    Stub {
        replies: Mutex::new(replies.iter().map(|text| reply(text)).collect()),
        seen: Mutex::new(Vec::new()),
    }
}

#[test]
fn the_header_split_and_status_are_parsed_from_include_output() {
    let text = "HTTP/1.1 404 Not Found\r\nETag: \"abc\"\r\n\r\n{\"message\":\"missing\"}";
    let split = blank_line(text).expect("a blank line");
    assert_eq!(status_of(&text[..split]), Some(404));
    let headers = headers_of(&text[..split]);
    assert_eq!(headers[0], ("etag".to_owned(), "\"abc\"".to_owned()));
    assert_eq!(&text[split..], "{\"message\":\"missing\"}");
}

#[test]
fn a_get_reuses_its_etag_and_a_304_answers_the_cached_page() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    runtime.block_on(async {
        let first_reply = api(r#"{"login":"octo"}"#, "ETag: \"v1\"\r\n");
        let stub = stub(&[
            first_reply.as_str(),
            "HTTP/2.0 304 Not Modified\r\nETag: \"v2\"\r\n\r\n",
        ]);
        let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0));
        let first = api_client
            .request("user", None, None, None, Default::default())
            .await
            .expect("a page");
        assert_eq!(first.body, json!({ "login": "octo" }));
        let second = api_client
            .request("user", None, None, None, Default::default())
            .await
            .expect("the cached page");
        assert_eq!(second.body, first.body);
        assert_eq!(second.header("etag"), Some("\"v1\""));
        let seen = stub.seen.lock().expect("seen");
        assert!(
            seen[1]
                .args
                .contains(&String::from("If-None-Match: \"v1\"")),
            "{:?}",
            seen[1].args
        );
    });
}

#[test]
fn a_write_clears_the_cache_and_its_graphql_key_is_the_documents_sha256() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    runtime.block_on(async {
        let query_reply = api(r#"{"viewer":{"login":"octo"}}"#, "");
        let mutation_reply = api(r#"{"ok":true}"#, "");
        let stub = stub(&[
            query_reply.as_str(),
            mutation_reply.as_str(),
            query_reply.as_str(),
        ]);
        let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0));
        let query = json!({ "query": "query { viewer { login } }" });
        api_client
            .request(
                "graphql",
                Some(query.clone()),
                None,
                None,
                Default::default(),
            )
            .await
            .expect("a query");
        api_client
            .request(
                "graphql",
                Some(json!({ "query": "mutation { x }" })),
                None,
                None,
                Default::default(),
            )
            .await
            .expect("a mutation");
        let third = api_client
            .request("graphql", Some(query), None, None, Default::default())
            .await
            .expect("the query again");
        assert_eq!(third.body, json!({ "viewer": { "login": "octo" } }));
        let seen = stub.seen.lock().expect("seen");
        assert_eq!(seen.len(), 3);
        assert!(
            !seen[2]
                .args
                .iter()
                .any(|arg| arg.starts_with("If-None-Match")),
            "a write cleared the cache: {:?}",
            seen[2].args
        );
    });
}

#[test]
fn a_refused_status_maps_to_the_fixed_category() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    runtime.block_on(async {
        let stub = stub(&["HTTP/2.0 403 Forbidden\r\n\r\n"]);
        let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0));
        let error = api_client
            .request("user", None, None, None, Default::default())
            .await
            .expect_err("refused");
        assert_eq!(error.kind, Kind::Forbidden);
        assert_eq!(error.dispatched, Some(false));
    });
}

#[test]
fn a_rate_limited_reply_carries_its_retry_time() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    runtime.block_on(async {
        let stub = stub(&["HTTP/2.0 429 Too Many Requests\r\nRetry-After: 30\r\n\r\n"]);
        let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 1_000.0));
        let error = api_client
            .request("user", None, None, None, Default::default())
            .await
            .expect_err("rate limited");
        assert_eq!(error.kind, Kind::RateLimit);
        assert_eq!(error.retry_at, Some(31_000.0));
    });
}

#[test]
fn bodies_are_redacted_before_they_are_kept_and_colliding_keys_are_suffixed() {
    let page: Page = Page {
        id: 1,
        body: json!({ "visible": "ok", "token": "opaque", "ghp_keyone": { "value": 1 }, "ghp_keytwo": { "value": 2 } }),
        headers: Vec::new(),
        bytes: 1,
        version: String::from("v"),
        identity_changed: false,
    };
    let clean = redact_data(&page.body);
    let text = ace_json::ser::to_string(&clean).expect("serializes");
    assert!(!text.contains("opaque"), "{text}");
    assert!(text.contains(r#""visible":"ok""#), "{text}");
    assert!(text.contains(r#""value":1"#), "{text}");
    assert!(text.contains(r#""value":2"#), "{text}");
    assert!(!text.contains("ghp_keyone"), "{text}");
    assert!(text.contains("[REDACTED]#1"), "{text}");
}

#[allow(clippy::type_complexity)]
fn write<'a>(
    api_client: &'a GhApi<'a>,
    path: &str,
    body: ace_json::Value,
) -> std::pin::Pin<
    Box<
        dyn std::future::Future<
                Output = (
                    Result<Page, crate::transport::error::ForgeError>,
                    std::sync::Arc<crate::transport::mutation::MutationDispatch>,
                ),
            > + 'a,
    >,
> {
    let dispatch = std::sync::Arc::new(crate::transport::mutation::MutationDispatch::new(None));
    let path = path.to_owned();
    Box::pin(async move {
        let outcome = api_client
            .request(&path, Some(body), None, None, dispatch.clone())
            .await;
        (outcome, dispatch)
    })
}

#[test]
fn a_malformed_graphql_error_leaves_a_mutation_uncertain() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(async {
            let stub = stub(&[&api(
                r#"{"data":null,"errors":[{"type":"NOT_FOUND","extensions":null}]}"#,
                "",
            )]);
            let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0));
            let dispatch =
                std::sync::Arc::new(crate::transport::mutation::MutationDispatch::new(None));
            let error = api_client
                .request(
                    "graphql",
                    Some(json!({ "query": "mutation { x }" })),
                    None,
                    None,
                    dispatch.clone(),
                )
                .await
                .expect_err("unreadable");
            assert_eq!(error.kind, Kind::OutcomeUncertain);
            assert!(!dispatch.definitely_failed(), "the fence stays");
        });
}

#[test]
fn the_default_supervised_runner_masks_its_childs_credentials() {
    use std::os::unix::fs::PermissionsExt;

    let token = "opaque-gh-token-value";
    let path = std::env::temp_dir().join(format!("forge-echo-{}", std::process::id()));
    std::fs::write(
        &path,
        "#!/bin/sh\nprintf 'HTTP/2.0 200 OK\\r\\nETag: \"%s\"\\r\\n\\r\\n{\"note\":\"%s\"}' \"$GH_TOKEN\" \"$GH_TOKEN\"\n",
    )
    .expect("script");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    runtime.block_on(async {
        // No `.environment(…)` call: the supervised runner supplies its own.
        let runner = crate::transport::command::SupervisedRunner::new(
            tokio::runtime::Handle::current(),
            crate::transport::command::RunnerOptions {
                env: vec![(String::from("GH_TOKEN"), token.to_owned())],
                ..crate::transport::command::RunnerOptions::default()
            },
        )
        .expect("runner");
        let api_client = GhApi::new(&runner, "github.com", std::sync::Arc::new(|| 0.0))
            .command(path.to_string_lossy().into_owned());
        let page = api_client
            .request("user", None, None, None, Default::default())
            .await
            .expect("a page");
        let text = ace_json::ser::to_string(&page.body).expect("serializes");
        assert!(!text.contains(token), "{text}");
        assert!(text.contains("[REDACTED]"), "{text}");
        assert_eq!(page.header("etag"), None, "a validator is dropped");
    });
    let _ = std::fs::remove_file(&path);
}

#[test]
fn a_lost_write_response_is_an_uncertain_outcome_that_was_dispatched() {
    #[derive(Default)]
    struct Lost {
        seen: Mutex<Vec<CommandRequest>>,
    }

    impl Runner for Lost {
        fn credential_environment(&self) -> Option<ace_redaction::EnvironmentMatcher> {
            None
        }

        fn run<'a>(
            &'a self,
            request: CommandRequest,
        ) -> Pin<
            Box<
                dyn std::future::Future<
                        Output = Result<CommandResult, crate::transport::error::ForgeError>,
                    > + Send
                    + 'a,
            >,
        > {
            Box::pin(async move {
                if let Some(dispatch) = &request.dispatch {
                    dispatch.prepare();
                    dispatch.record();
                }
                self.seen.lock().expect("seen").push(request);
                Err(crate::transport::error::ForgeError::new(Kind::Cli))
            })
        }
    }

    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(async {
            let runner = Lost::default();
            let api_client = GhApi::new(&runner, "github.com", std::sync::Arc::new(|| 0.0));
            let error = api_client
                .request(
                    "repos/octo/ace/issues/1/comments",
                    Some(json!({ "body": "x" })),
                    None,
                    None,
                    Default::default(),
                )
                .await
                .expect_err("the response was lost");
            assert_eq!(error.kind, Kind::OutcomeUncertain);
            assert_eq!(error.dispatched, Some(true));
        });
}

#[test]
fn a_non_string_extension_code_is_unreadable_and_leaves_a_write_uncertain() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(async {
            let stub = stub(&[&api(
                r#"{"data":null,"errors":[{"type":"NOT_FOUND","extensions":{"code":42}}]}"#,
                "",
            )]);
            let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0));
            let dispatch =
                std::sync::Arc::new(crate::transport::mutation::MutationDispatch::new(None));
            let error = api_client
                .request(
                    "graphql",
                    Some(json!({ "query": "mutation { x }" })),
                    None,
                    None,
                    dispatch.clone(),
                )
                .await
                .expect_err("unreadable");
            assert_eq!(error.kind, Kind::OutcomeUncertain);
            assert!(!dispatch.definitely_failed());
        });
}

#[test]
fn the_requests_credential_values_never_escape_a_page() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(async {
            let token = "opaque-gh-token-value";
            let body = api(
                &format!(r#"{{"note":"echoed {token}","visible":"ok"}}"#),
                &format!("ETag: \"{token}\"\r\n"),
            );
            let stub = stub(&[body.as_str(), body.as_str()]);
            let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0))
                .environment(ace_redaction::EnvironmentMatcher::new(&[token]));
            let page = api_client
                .request("user", None, None, None, Default::default())
                .await
                .expect("a page");
            let text = ace_json::ser::to_string(&page.body).expect("serializes");
            assert!(!text.contains(token), "{text}");
            assert!(text.contains("[REDACTED]"), "{text}");
            assert_eq!(page.header("etag"), None, "a validator is dropped");
            api_client
                .request("user", None, None, None, Default::default())
                .await
                .expect("a page");
            let seen = stub.seen.lock().expect("seen");
            let request = &seen[1];
            assert!(
                !request.args.iter().any(|arg| arg.contains("If-None-Match")),
                "{:?}",
                request.args
            );
            assert!(!request.args.iter().any(|arg| arg.contains(token)));
        });
}

#[test]
fn a_graphql_refusal_is_classified_before_a_nonzero_exit() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(async {
            let mut output = reply(&api(r#"{"data":null,"errors":[{"type":"NOT_FOUND"}]}"#, ""));
            output.code = Some(1);
            let stub = Stub {
                replies: Mutex::new(vec![output]),
                seen: Mutex::new(Vec::new()),
            };
            let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0));
            let error = api_client
                .request(
                    "graphql",
                    Some(json!({ "query": "query { x }" })),
                    None,
                    None,
                    Default::default(),
                )
                .await
                .expect_err("refused");
            assert_eq!(error.kind, Kind::NotFound);
        });
}

#[test]
fn a_host_header_is_redacted_before_it_is_returned() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(async {
            let stub = stub(&[&api(r#"[]"#, "ETag: \"ghp_12345678901234567890\"\r\n")]);
            let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0));
            let page = api_client
                .request("user/repos", None, None, None, Default::default())
                .await
                .expect("a page");
            assert_eq!(page.header("etag"), Some("\"[REDACTED]\""));
        });
}

#[test]
fn a_409_merge_async_acknowledgement_is_the_result_and_not_a_refusal() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(async {
    // `stacks.process.test.ts:18-20`: GitHub's acknowledgement body.
    let body = api(
        r#"{"status":"pending","details":{"uuid":"4f8b2a1c-3d5e-4f6a-8b9c-0d1e2f3a4b5c","message":"Merge requested"}}"#,
        "",
    )
    .replace("200 OK", "409 Conflict");
    let stub = stub(&[body.as_str()]);
    let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0));
    let dispatch =
        std::sync::Arc::new(crate::transport::mutation::MutationDispatch::new(None));
    let page = api_client
        .request(
            "repos/octo/ace/pulls/8/merge-async",
            Some(json!({ "merge_method": "squash" })),
            Some("PUT"),
            None,
            dispatch.clone(),
        )
        .await
        .expect("the acknowledgement is the result");
    assert_eq!(page.body["status"], json!("pending"));
    assert_eq!(
        page.body["details"]["uuid"],
        json!("4f8b2a1c-3d5e-4f6a-8b9c-0d1e2f3a4b5c")
    );
    assert!(!dispatch.definitely_failed(), "the write may not be retried");

        });
}

#[test]
fn an_unrecognised_graphql_error_leaves_a_mutation_uncertain() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    runtime.block_on(async {
        for reply in [
            api(r#"{"data":{"ok":true},"errors":[{"message":"boom"}]}"#, ""),
            String::from("HTTP/2.0 200 OK\r\n\r\nnot json"),
        ] {
            let stub = stub(&[reply.as_str()]);
            let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0));
            let (outcome, dispatch) =
                write(&api_client, "graphql", json!({ "query": "mutation { x }" })).await;
            let error = outcome.expect_err("uncertain");
            assert_eq!(error.kind, Kind::OutcomeUncertain);
            assert!(!dispatch.definitely_failed(), "the write must stay fenced");
        }
    });
}

#[test]
fn a_mutation_that_fails_after_dispatch_is_uncertain() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(async {
            let stub = stub(&["HTTP/2.0 502 Bad Gateway\r\n\r\n{\"message\":\"bad\"}"]);
            let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0));
            let (outcome, dispatch) = write(
                &api_client,
                "repos/octo/ace/issues/1/comments",
                json!({ "body": "x" }),
            )
            .await;
            assert_eq!(outcome.expect_err("uncertain").kind, Kind::OutcomeUncertain);
            assert!(!dispatch.definitely_failed());
        });
}

#[test]
fn a_refused_pr_create_names_its_reason_and_is_certain() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(async {
            let stub = stub(&[
                &api(r#"{"message":"No commits between main and work"}"#, "")
                    .replace("200 OK", "422 Unprocessable"),
            ]);
            let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0));
            let dispatch =
                std::sync::Arc::new(crate::transport::mutation::MutationDispatch::new(None));
            let outcome = api_client
                .request(
                    "repos/octo/ace/pulls",
                    Some(json!({ "title": "x", "head": "work", "base": "main" })),
                    None,
                    None,
                    dispatch.clone(),
                )
                .await;
            assert_eq!(outcome.expect_err("refused").kind, Kind::NoCommits);
            assert!(dispatch.definitely_failed());
        });
}

#[test]
fn a_validation_refusal_names_the_field_it_refused() {
    for (body, kind) in [
        (
            r#"{"message":"Validation Failed","errors":[{"field":"head","code":"invalid"}]}"#,
            Kind::HeadMissing,
        ),
        (
            r#"{"message":"Validation Failed","errors":[{"field":"base","code":"invalid"}]}"#,
            Kind::BaseMissing,
        ),
        (
            r#"{"message":"Validation Failed","errors":[{"code":"already_exists","message":"name already exists"}]}"#,
            Kind::Conflict,
        ),
        (
            r#"{"message":"Validation Failed","errors":[{"field":"head","code":"missing"}]}"#,
            Kind::Unprocessable,
        ),
        (
            r#"{"message":"Validation Failed","errors":["No commits between main and work"]}"#,
            Kind::NoCommits,
        ),
        (
            r#"{"message":"Validation Failed","errors":[{"field":"head","code":"invalid"},{"message":"A pull request already exists for octo:work"}]}"#,
            Kind::PrExists,
        ),
        (
            r#"{"message":"Pull Request is not mergeable","errors":[{"code":"other"}]}"#,
            Kind::Unprocessable,
        ),
        (
            r#"{"message":"Validation Failed","errors":[{"code":"custom","message":"A repository with this name already exists"}]}"#,
            Kind::Conflict,
        ),
    ] {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(async {
                let stub = stub(&[&api(body, "").replace("200 OK", "422 Unprocessable")]);
                let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0));
                let dispatch =
                    std::sync::Arc::new(crate::transport::mutation::MutationDispatch::new(None));
                let error = api_client
                    .request(
                        "repos/octo/ace/pulls",
                        Some(json!({ "title": "x" })),
                        None,
                        None,
                        dispatch,
                    )
                    .await
                    .expect_err("refused");
                assert_eq!(error.kind, kind, "{body}");
            });
    }
}

#[test]
fn a_merge_refused_with_405_is_a_conflict() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(async {
            let stub = stub(&[&api(r#"{"message":"Pull Request is not mergeable"}"#, "")
                .replace("200 OK", "405 Method Not Allowed")]);
            let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0));
            let dispatch =
                std::sync::Arc::new(crate::transport::mutation::MutationDispatch::new(None));
            let outcome = api_client
                .request(
                    "repos/octo/ace/pulls/7/merge",
                    Some(json!({ "merge_method": "squash" })),
                    Some("PUT"),
                    None,
                    dispatch.clone(),
                )
                .await;
            assert_eq!(outcome.expect_err("refused").kind, Kind::Conflict);
            assert!(dispatch.definitely_failed());
        });
}

#[test]
fn a_secondary_rate_limit_403_is_rate_limited_before_forbidden() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(async {
            let limited = stub(&[&api(
                r#"{"message":"You have exceeded a secondary rate limit"}"#,
                "Retry-After: 30\r\n",
            )
            .replace("200 OK", "403 Forbidden")]);
            let api_client = GhApi::new(&limited, "github.com", std::sync::Arc::new(|| 1_000.0));
            let error = api_client
                .request("user", None, None, None, Default::default())
                .await
                .expect_err("limited");
            assert_eq!(error.kind, Kind::RateLimit);
            assert_eq!(error.retry_at, Some(31_000.0));
            let forbidden = stub(&[
                &api(r#"{"message":"Bad credentials"}"#, "").replace("200 OK", "403 Forbidden")
            ]);
            let api_client = GhApi::new(&forbidden, "github.com", std::sync::Arc::new(|| 1_000.0));
            let error = api_client
                .request("user", None, None, None, Default::default())
                .await
                .expect_err("forbidden");
            assert_eq!(error.kind, Kind::Forbidden);
            assert_eq!(error.status, Some(403));
        });
}

#[test]
fn a_304_keeps_the_cached_link_header() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(async {
            let first = api(
                r#"[]"#,
                "ETag: \"v1\"\r\nLink: <https://api.github.com/x?page=2>; rel=\"next\"\r\n",
            );
            let stub = stub(&[
                first.as_str(),
                "HTTP/2.0 304 Not Modified\r\nETag: \"v2\"\r\nX-Poll-Interval: 60\r\n\r\n",
            ]);
            let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0));
            api_client
                .request("user/repos", None, None, None, Default::default())
                .await
                .expect("first");
            let second = api_client
                .request("user/repos", None, None, None, Default::default())
                .await
                .expect("cached");
            assert!(second.header("link").is_some(), "{:?}", second.headers);
            assert_eq!(second.header("etag"), Some("\"v1\""));
            assert_eq!(second.header("x-poll-interval"), Some("60"));
        });
}

#[test]
fn an_authorisation_error_path_is_not_a_missing_field() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(async {
            let body = api(
                r#"{"data":{"r0":null},"errors":[{"type":"FORBIDDEN","path":["r0"]}]}"#,
                "",
            );
            let stub = stub(&[body.as_str()]);
            let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0));
            let error = api_client
                .request(
                    "graphql",
                    Some(json!({ "query": "query { r0 }" })),
                    None,
                    None,
                    Default::default(),
                )
                .await
                .expect_err("refused");
            assert_eq!(error.kind, Kind::Forbidden);
        });
}

#[test]
fn a_missing_field_across_a_nested_path_is_tolerated() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(async {
            let body = api(
                r#"{"data":{"repository":{"pullRequest":null}},"errors":[{"type":"NOT_FOUND","path":["repository","pullRequest"]}]}"#,
                "",
            );
            let stub = stub(&[body.as_str()]);
            let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0));
            api_client
                .request(
                    "graphql",
                    Some(json!({ "query": "query { repository { pullRequest } }" })),
                    None,
                    None,
                    Default::default(),
                )
                .await
                .expect("a read may name a missing field");
        });
}

#[test]
fn a_graphql_error_is_a_refusal_the_reader_may_smaller_ask() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    runtime.block_on(async {
        let text = api(r#"{"data":null,"errors":[{"type":"NOT_FOUND"}]}"#, "");
        let stub = stub(&[text.as_str()]);
        let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0));
        let error = api_client
            .request(
                "graphql",
                Some(json!({ "query": "query { x }" })),
                None,
                None,
                Default::default(),
            )
            .await
            .expect_err("refused");
        assert_eq!(error.kind, Kind::NotFound);
    });
}

#[test]
fn graphql_schema_validation_refusal_sets_query_refused_flag() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    runtime.block_on(async {
        let text = api(
            r#"{"data":null,"errors":[{"extensions":{"code":"undefinedField"}}]}"#,
            "",
        );
        let stub = stub(&[text.as_str()]);
        let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0));
        let error = api_client
            .request(
                "graphql",
                Some(json!({ "query": "query { unknownField }" })),
                None,
                None,
                Default::default(),
            )
            .await
            .expect_err("schema refusal");
        assert_eq!(error.kind, Kind::InvalidData);
        assert!(error.is_query_refused());
        assert_eq!(error.dispatched, Some(false));
    });
}

#[test]
fn link_header_repository_id_alias_requires_numeric_id() {
    let stub = stub(&[]);
    let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0));
    let valid = Page {
        id: 1,
        body: ace_json::Value::Null,
        headers: vec![(
            String::from("link"),
            String::from("<https://api.github.com/repositories/42/pulls?page=2>; rel=\"next\""),
        )],
        bytes: 0,
        version: String::new(),
        identity_changed: false,
    };
    assert_eq!(
        api_client
            .next(&valid, "repos/octo/ace/pulls")
            .expect("valid"),
        Some(String::from("repos/octo/ace/pulls?page=2"))
    );
    let invalid = Page {
        headers: vec![(
            String::from("link"),
            String::from(
                "<https://api.github.com/repositories/not-a-number/pulls?page=2>; rel=\"next\"",
            ),
        )],
        ..valid
    };
    assert_eq!(
        api_client
            .next(&invalid, "repos/octo/ace/pulls")
            .expect_err("non-numeric repo id refused")
            .kind,
        Kind::InvalidData
    );
}

#[test]
fn render_markdown_plain_text_403_rate_limit_and_log_tail_bytes() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    runtime.block_on(async {
        let limited = "HTTP/2.0 403 Forbidden\r\n\r\nYou have exceeded a secondary rate limit.";
        let md_stub = stub(&[limited]);
        let api_client = GhApi::new(&md_stub, "github.com", std::sync::Arc::new(|| 1_000.0));
        let err = api_client
            .render_markdown("hi", "octo/ace", None)
            .await
            .expect_err("rate limited");
        assert_eq!(err.kind, Kind::RateLimit);
        assert_eq!(err.retry_at, Some(61_000.0));

        let log_stub = stub(&["last lines"]);
        let log_api = GhApi::new(&log_stub, "github.com", std::sync::Arc::new(|| 0.0));
        let res = log_api
            .log("repos/octo/ace/actions/jobs/9/logs", None, Some(4_096))
            .await
            .expect("log");
        assert_eq!(res.stdout, "last lines");
        let seen = log_stub.seen.lock().expect("seen");
        assert_eq!(seen[0].tail_bytes, Some(4_096));
    });
}

#[test]
fn write_clears_cache_order_and_redact_data_keeps_lone_surrogates() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    runtime.block_on(async {
        let mut replies = Vec::new();
        let ok = api(r#"{"ok":true}"#, "ETag: \"v1\"\r\n");
        let written = api(r#"{"ok":true}"#, "");
        replies.push(reply(&ok));
        replies.push(reply(&written));
        replies.push(reply(&ok));
        let stub = Stub {
            replies: Mutex::new(replies),
            seen: Mutex::new(Vec::new()),
        };
        let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0));
        api_client
            .request(
                "repos/octo/ace/pulls/1",
                None,
                None,
                None,
                Default::default(),
            )
            .await
            .expect("get 1");
        api_client
            .request(
                "repos/octo/ace/issues/1/comments",
                Some(json!({ "body": "hi" })),
                Some("POST"),
                None,
                Default::default(),
            )
            .await
            .expect("write");
        assert!(api_client.order.lock().expect("order").is_empty());
        api_client
            .request(
                "repos/octo/ace/pulls/1",
                None,
                None,
                None,
                Default::default(),
            )
            .await
            .expect("get 2");
        assert_eq!(api_client.order.lock().expect("order").len(), 1);
    });

    // Lone surrogate beside a token survives redact_data without replacement-char corruption.
    let mut units: Vec<u16> = vec![0xd800];
    units.extend("ghp_12345678901234567890".encode_utf16());
    let value = ace_json::Value::String(ace_json::JsString::from_units(&units));
    let masked = redact_data(&value);
    let ace_json::Value::String(js) = masked else {
        panic!("expected string");
    };
    let out: Vec<u16> = js.units().collect();
    assert_eq!(out[0], 0xd800);
    assert_eq!(String::from_utf16(&out[1..]).expect("utf16"), "[REDACTED]");

    // RunnerOptions Debug never prints credential values.
    let opts = RunnerOptions {
        env: vec![(
            String::from("GH_TOKEN"),
            String::from("ghp_super_secret_debug_leak"),
        )],
        ..RunnerOptions::default()
    };
    let debug = format!("{opts:?}");
    assert!(!debug.contains("ghp_super_secret_debug_leak"));
    assert!(debug.contains("GH_TOKEN"));
}
