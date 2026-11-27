// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::expect_used)]
//! A pull's checks (`github-checks.ts`): the Actions check runs and the legacy commit
//! statuses for one head commit, mapped into the rows the panel and `ciStatus` read.

use ace_json::Value;

use crate::github::status::{CheckRow, ci_status, map_check, map_legacy_status};
use crate::schema::github::{Kind, page, parse_check_page};
use crate::transport::command::Cancellation;
use crate::transport::error::ForgeError;
use crate::transport::http::GhApi;

/// One repository's owner and name, as the API path spells them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Repository {
    pub owner: String,
    pub name: String,
}

impl Repository {
    /// The API root for one head commit's checks.
    pub fn checks_path(&self, sha: &str) -> String {
        format!(
            "repos/{}/{}/commits/{sha}/check-runs?per_page=100&filter=latest",
            self.owner, self.name
        )
    }

    /// The API root for one head commit's legacy statuses.
    pub fn statuses_path(&self, sha: &str) -> String {
        format!(
            "repos/{}/{}/commits/{sha}/statuses?per_page=100",
            self.owner, self.name
        )
    }
}

/// One head commit's checks: current check runs and legacy statuses, current first.
pub async fn check_rows(
    api: &GhApi<'_>,
    repository: &Repository,
    sha: &str,
    cancellation: Option<std::sync::Arc<Cancellation>>,
) -> Result<Vec<CheckRow>, ForgeError> {
    let mut budget = crate::transport::limits::ReadBudget::new();
    let mut rows = Vec::new();
    let run_pages = api
        .pages(
            &repository.checks_path(sha),
            cancellation.clone(),
            &mut budget,
        )
        .await?;
    for runs in run_pages {
        for check in parse_check_page(&runs.body).map_err(|_| ForgeError::new(Kind::InvalidData))? {
            let value = value_of(&runs.body, "check_runs", &check.id)
                .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
            rows.push(map_check(&value).map_err(|_| ForgeError::new(Kind::InvalidData))?);
        }
    }
    let status_pages = api
        .pages(&repository.statuses_path(sha), cancellation, &mut budget)
        .await?;
    for statuses in status_pages {
        // `StatusPage` is a top-level array (`github-schemas.ts:47`), not a wrapper object.
        for status in page(&statuses.body, |value| Ok(value.clone()))
            .map_err(|_| ForgeError::new(Kind::InvalidData))?
        {
            rows.push(map_legacy_status(&status).map_err(|_| ForgeError::new(Kind::InvalidData))?);
        }
    }
    Ok(rows)
}

/// The aggregate CI state `checkRows` callers publish.
pub fn aggregate(rows: &[CheckRow]) -> &'static str {
    ci_status(rows)
}

/// The entry with `id` inside a named array of the same redacted body.
fn value_of(body: &Value, array: &str, id: &i64) -> Option<Value> {
    body.as_object()?
        .get(array)?
        .as_array()?
        .iter()
        .find(|entry| {
            entry
                .as_object()
                .and_then(|fields| fields.get("id"))
                .and_then(|value| value.as_number().and_then(|number| number.as_i64()))
                == Some(*id)
        })
        .cloned()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used)]

    use std::pin::Pin;
    use std::sync::Mutex;

    use super::{Repository, aggregate, check_rows};
    use crate::transport::command::{CommandRequest, CommandResult, Runner};
    use crate::transport::http::GhApi;

    #[derive(Default)]
    struct Stub {
        replies: Mutex<Vec<String>>,
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
                self.seen.lock().expect("seen").push(request);
                let reply = self.replies.lock().expect("replies").remove(0);
                Ok(CommandResult {
                    code: Some(0),
                    stdout: format!("HTTP/2.0 200 OK\r\n\r\n{reply}"),
                    truncated: false,
                    identity_changed: false,
                    http: None,
                    unreachable: false,
                })
            })
        }
    }

    #[test]
    fn the_api_paths_pin_one_repository_and_one_commit() {
        let repository = Repository {
            owner: String::from("octo"),
            name: String::from("ace"),
        };
        assert_eq!(
            repository.checks_path("abc"),
            "repos/octo/ace/commits/abc/check-runs?per_page=100&filter=latest"
        );
        assert_eq!(
            repository.statuses_path("abc"),
            "repos/octo/ace/commits/abc/statuses?per_page=100"
        );
    }

    #[test]
    fn current_runs_and_legacy_statuses_map_into_one_list() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(async {
                let stub = Stub {
                    replies: Mutex::new(vec![
                        String::from(r#"{"check_runs":[{"id":11,"name":"test","status":"completed","conclusion":"failure","completed_at":"2026-10-02T10:00:07Z","details_url":"https://github.com/octo/ace/actions/runs/42/job/99"}]}"#),
                        String::from(r#"[{"id":3,"context":"deploy","state":"success","updated_at":"now","target_url":null}]"#),
                    ]),
                    seen: Mutex::new(Vec::new()),
                };
                let api = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0));
                let repository = Repository {
                    owner: String::from("octo"),
                    name: String::from("ace"),
                };
                let rows = check_rows(&api, &repository, "abc", None).await.expect("rows");
                assert_eq!(rows.len(), 2);
                assert_eq!(rows[0].id, "check:11");
                assert_eq!(rows[1].id, "status:3");
                assert_eq!(aggregate(&rows), "failure");
                let seen = stub.seen.lock().expect("seen");
                assert!(seen[0].args[1].contains("check-runs"), "{:?}", seen[0].args);
                assert!(seen[1].args[1].contains("statuses?"), "{:?}", seen[1].args);
            });
    }

    #[test]
    fn a_check_page_without_its_runs_is_invalid_data() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(async {
                let stub = Stub {
                    replies: Mutex::new(vec![String::from(r#"{"check_runs":"nope"}"#)]),
                    seen: Mutex::new(Vec::new()),
                };
                let api = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0));
                let repository = Repository {
                    owner: String::from("octo"),
                    name: String::from("ace"),
                };
                let error = check_rows(&api, &repository, "abc", None)
                    .await
                    .expect_err("invalid");
                assert_eq!(error.kind, crate::transport::error::Kind::InvalidData);
            });
    }
}
