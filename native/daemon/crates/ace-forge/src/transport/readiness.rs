// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::expect_used)]
//! GitHub readiness (`readiness.ts`): the CLI's version, the accounts it stores, and the API
//! identity a request would use, with instructions that name what to do next. Network and
//! quota failures are not sign-in answers.

use serde::Serialize;

use crate::transport::command::{Cancellation, CommandRequest, Runner};
use crate::transport::error::{ForgeError, Kind};
use crate::transport::http::GhApi;
use crate::transport::identity::valid_login;

/// One stored account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Account {
    pub login: String,
    pub active: bool,
}

/// What the settings panel shows.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Readiness {
    /// `SourceControlReadiness.preferences` comes first and is required.
    pub preferences: ace_json::Value,
    pub cli: &'static str,
    pub version: Option<String>,
    pub accounts: Vec<Account>,
    pub account: Option<String>,
    pub api: &'static str,
    pub instructions: String,
    pub transport: &'static str,
    pub transport_instructions: &'static str,
}

const TRANSPORT: &str = "API sign-in does not verify Git clone or push access. Check a project's remote, or configure your Git credential helper / SSH key on this computer.";

/// `gh version <version>` as `gh --version` prints it, when the shape is the known one.
pub fn parse_version(output: &str) -> Option<String> {
    let rest = output.strip_prefix("gh version ")?;
    // The regex takes the first 100 characters of the version shape.
    let version: String = rest
        .chars()
        .take_while(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '+' | '-')
        })
        .take(100)
        .collect();
    (!version.is_empty()).then_some(version)
}

/// `[{"login":"octo","active":true}]`, at most 100 accounts, each with a valid login.
pub fn parse_accounts(text: &str) -> Option<Vec<Account>> {
    let value: ace_json::Value = ace_json::parse(text).ok()?;
    let items = value.as_array()?;
    if items.len() > 100 {
        return None;
    }
    let mut accounts = Vec::with_capacity(items.len());
    for item in items {
        let fields = item.as_object()?;
        let login = fields.get("login")?.as_str()?;
        // Zod drops the whole array when `active` is not the boolean it requires.
        let active = match fields.get("active") {
            Some(ace_json::Value::Bool(active)) => *active,
            _ => return None,
        };
        if !valid_login(login) {
            return None;
        }
        accounts.push(Account {
            login: login.to_owned(),
            active,
        });
    }
    Some(accounts)
}

fn status(cli: &'static str, version: Option<String>, preferences: ace_json::Value) -> Readiness {
    Readiness {
        preferences,
        cli,
        version,
        accounts: Vec::new(),
        account: None,
        api: "unavailable",
        instructions: String::from("Install GitHub CLI (gh) on this computer, then Rescan."),
        transport: "unchecked",
        transport_instructions: TRANSPORT,
    }
}

/// The effective API identity a `gh` request would use, through `GhApi`'s classifier.
pub async fn github_identity(
    runner: &dyn Runner,
    host: &str,
    now: std::sync::Arc<dyn Fn() -> f64 + Send + Sync>,
    cancellation: Option<std::sync::Arc<Cancellation>>,
) -> Result<String, ForgeError> {
    let api = GhApi::new(runner, host.to_owned(), now);
    let page = api
        .request("user", None, None, cancellation, Default::default())
        .await?;
    let login = page
        .body
        .as_object()
        .and_then(|fields| fields.get("login"))
        .and_then(|login| login.as_str())
        .filter(|login| valid_login(login))
        .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
    Ok(login.to_owned())
}

/// The readiness a settings panel reads, never failing: every failure is an `api` state.
pub async fn github_readiness(
    runner: &dyn Runner,
    host: &str,
    expected: Option<&str>,
    preferences: ace_json::Value,
    now: std::sync::Arc<dyn Fn() -> f64 + Send + Sync>,
    cancellation: Option<std::sync::Arc<Cancellation>>,
) -> Readiness {
    let mut readiness = status("unavailable", None, preferences);
    let run = |args: Vec<String>| {
        let mut request = CommandRequest::new("gh", args);
        if let Some(cancellation) = &cancellation {
            request = request.cancellable(cancellation.clone());
        }
        request
    };
    let version = runner
        .run(run(vec![String::from("--version")]))
        .await
        .ok()
        .filter(|output| output.code == Some(0));
    let Some(version) = version else {
        return readiness;
    };
    readiness.cli = "available";
    readiness.version = parse_version(&version.stdout);
    readiness.api = "login_required";
    readiness.instructions =
        format!("Run gh auth login --hostname {host} on this computer, then Rescan.");
    let help = runner
        .run(run(vec![
            String::from("auth"),
            String::from("status"),
            String::from("--help"),
        ]))
        .await
        .ok();
    if help.is_some_and(|help| help.stdout.contains("--json")) {
        let status = runner
            .run(run(vec![
                String::from("auth"),
                String::from("status"),
                String::from("--hostname"),
                host.to_owned(),
                String::from("--json"),
                String::from("hosts"),
                String::from("--jq"),
                String::from("[.hosts[][] | {login,active}]"),
            ]))
            .await
            .ok()
            .filter(|output| output.code == Some(0));
        if let Some(status) = status
            && let Some(accounts) = parse_accounts(&status.stdout)
        {
            readiness.accounts = accounts;
        }
    }
    match github_identity(runner, host, now, cancellation.clone()).await {
        Ok(account) => {
            if !readiness
                .accounts
                .iter()
                .any(|entry| entry.login == account)
            {
                readiness.accounts.push(Account {
                    login: account.clone(),
                    active: true,
                });
            }
            readiness.api = match expected {
                Some(expected) if expected != account => "account_mismatch",
                _ => "ready",
            };
            readiness.instructions = if readiness.api == "ready" {
                format!("GitHub API access verified as {account} on {host}.")
            } else {
                format!(
                    "Run gh auth switch --hostname {host} --user {} on this computer, then Rescan. Environment authentication may override stored accounts.",
                    expected.unwrap_or_default()
                )
            };
            readiness.account = Some(account);
        }
        Err(error) => match error.kind {
            Kind::Offline => {
                readiness.api = "offline";
                readiness.instructions = format!(
                    "ace couldn't reach {host}. Check this computer's network connection, then Rescan."
                );
            }
            Kind::RateLimit => {
                readiness.api = "rate_limited";
                readiness.instructions = format!(
                    "The {host} API rate limit was reached. Wait a few minutes, then Rescan."
                );
            }
            _ => {}
        },
    }
    readiness
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used)]

    use std::pin::Pin;
    use std::sync::Mutex;

    use super::{github_readiness, parse_accounts, parse_version};
    use crate::transport::command::{CommandRequest, CommandResult, Runner};

    #[derive(Default)]
    struct Stub {
        replies: Mutex<Vec<(Option<i32>, String)>>,
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
                let mut replies = self.replies.lock().expect("replies");
                if replies.is_empty() {
                    return Err(crate::transport::error::ForgeError::new(
                        crate::transport::error::Kind::Cli,
                    ));
                }
                let (code, stdout) = replies.remove(0);
                Ok(CommandResult {
                    code,
                    stdout,
                    truncated: false,
                    identity_changed: false,
                    http: None,
                    unreachable: false,
                })
            })
        }
    }

    fn api(json: &str) -> String {
        format!("HTTP/2.0 200 OK\r\n\r\n{json}")
    }

    #[test]
    fn a_version_reads_only_its_known_shape() {
        assert_eq!(
            parse_version("gh version 2.63.2 (2025-01-01)"),
            Some(String::from("2.63.2"))
        );
        assert_eq!(
            parse_version("gh version 2.63.2"),
            Some(String::from("2.63.2"))
        );
        assert_eq!(parse_version("is not gh"), None);
    }

    #[test]
    fn accounts_are_at_most_a_hundred_valid_logins() {
        let accounts =
            parse_accounts(r#"[{"login":"octo","active":true},{"login":"other","active":false}]"#)
                .expect("accounts");
        assert_eq!(accounts.len(), 2);
        assert!(accounts[0].active);
        assert_eq!(parse_accounts(r#"[{"login":"-bad","active":true}]"#), None);
        assert_eq!(parse_accounts("not json"), None);
    }

    #[test]
    fn without_gh_the_panel_says_install_it() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(async {
                let stub = Stub::default();
                let readiness = github_readiness(
                    &stub,
                    "github.com",
                    None,
                    ace_json::json!({}),
                    std::sync::Arc::new(|| 0.0),
                    None,
                )
                .await;
                assert_eq!(readiness.cli, "unavailable");
                assert_eq!(readiness.api, "unavailable");
                assert!(readiness.instructions.contains("Install GitHub CLI"));
                assert_eq!(readiness.transport, "unchecked");
            });
    }

    #[test]
    fn a_signed_in_account_reads_ready_with_its_version_and_accounts() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(async {
                let stub = Stub {
                    replies: Mutex::new(vec![
                        (Some(0), String::from("gh version 2.63.2 (2025-01-01)")),
                        (Some(0), String::from("--json")),
                        (Some(0), String::from(r#"[{"login":"octo","active":true}]"#)),
                        (Some(0), api(r#"{"login":"octo"}"#)),
                    ]),
                    seen: Mutex::new(Vec::new()),
                };
                let readiness = github_readiness(
                    &stub,
                    "github.com",
                    Some("octo"),
                    ace_json::json!({}),
                    std::sync::Arc::new(|| 0.0),
                    None,
                )
                .await;
                assert_eq!(readiness.cli, "available");
                assert_eq!(readiness.version.as_deref(), Some("2.63.2"));
                assert_eq!(readiness.api, "ready");
                assert_eq!(readiness.account.as_deref(), Some("octo"));
                assert_eq!(readiness.accounts.len(), 1);
                assert!(readiness.instructions.contains("verified as octo"));
            });
    }

    #[test]
    fn another_account_than_the_one_chosen_is_a_mismatch() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(async {
                let stub = Stub {
                    replies: Mutex::new(vec![
                        (Some(0), String::from("gh version 2.63.2")),
                        (Some(0), String::from("no json flag")),
                        (Some(0), api(r#"{"login":"someone-else"}"#)),
                    ]),
                    seen: Mutex::new(Vec::new()),
                };
                let readiness = github_readiness(
                    &stub,
                    "github.com",
                    Some("octo"),
                    ace_json::json!({}),
                    std::sync::Arc::new(|| 0.0),
                    None,
                )
                .await;
                assert_eq!(readiness.api, "account_mismatch");
                assert!(readiness.instructions.contains("gh auth switch"));
            });
    }
}
