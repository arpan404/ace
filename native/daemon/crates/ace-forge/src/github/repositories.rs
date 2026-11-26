// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::expect_used)]
//! Repositories (`repositories.ts`): the person's repositories, one lookup, and creation,
//! over `GhApi`. Filtering is local and bounded by a snapshot read budget; a create is a
//! dispatched write whose unreadable reply is an uncertain outcome, never a plain failure.

use ace_json::Value;
use serde::Serialize;

use crate::schema::github::{Kind, MAX_PAGE};
use crate::transport::command::Cancellation;
use crate::transport::error::ForgeError;
use crate::transport::http::GhApi;
use crate::transport::limits::ReadBudget;
use crate::transport::mutation::MutationDispatch;

pub use crate::github::status::RepoRef;

/// A repository row (`HostedRepository`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedRepository {
    pub raw: Value,
    pub id: i64,
    pub repository: RepoRef,
    pub description: String,
    pub visibility: String,
    pub archived: bool,
    pub fork: bool,
    pub url: String,
    pub clone_url: String,
}

/// What a list asks for; `query` searches `owner/name` and the description.
#[derive(Debug, Clone, Default)]
pub struct ListInput {
    pub host: String,
    pub account: String,
    pub query: String,
    pub owner: Option<String>,
    /// `all`, `public` or `private`.
    pub visibility: String,
    /// `all`, `yes` or `no`.
    pub archived: String,
    /// `all`, `yes` or `no`.
    pub fork: String,
}

/// What a create names.
#[derive(Debug, Clone)]
pub struct PublishInput {
    pub host: String,
    pub account: String,
    pub owner: String,
    pub name: String,
    pub description: String,
    /// `public` or `private`.
    pub visibility: String,
}

/// One remote repository as the API prints it (`remote`).
#[derive(Debug, Clone, PartialEq, Eq)]
struct Remote {
    id: i64,
    name: String,
    owner: String,
    description: Option<String>,
    private: bool,
    archived: bool,
    fork: bool,
}

fn parse_remote(value: &Value) -> Result<Remote, Kind> {
    let fields = value.as_object().ok_or(Kind::InvalidData)?;
    let number = |name: &str| -> Result<i64, Kind> {
        fields
            .get(name)
            .and_then(|value| value.as_number().and_then(|number| number.as_i64()))
            .filter(|number| *number > 0)
            .ok_or(Kind::InvalidData)
    };
    let string = |name: &str, max: usize| -> Result<String, Kind> {
        fields
            .get(name)
            .and_then(|value| value.as_str())
            .filter(|text| text.chars().count() <= max)
            .map(str::to_owned)
            .ok_or(Kind::InvalidData)
    };
    let flag = |name: &str| -> Result<bool, Kind> {
        match fields.get(name) {
            Some(Value::Bool(flag)) => Ok(*flag),
            _ => Err(Kind::InvalidData),
        }
    };
    let owner = fields
        .get("owner")
        .and_then(|owner| owner.as_object())
        .and_then(|owner| owner.get("login"))
        .and_then(|login| login.as_str())
        .filter(|login| login.chars().count() <= 100)
        .ok_or(Kind::InvalidData)?;
    // `description: z.string().max(4096).nullable()`: the key is required, null allowed.
    let description = match fields.get("description") {
        None => return Err(Kind::InvalidData),
        Some(Value::Null) => None,
        Some(value) => Some(
            value
                .as_str()
                .filter(|text| text.chars().count() <= 4_096)
                .ok_or(Kind::InvalidData)?
                .to_owned(),
        ),
    };
    Ok(Remote {
        id: number("id")?,
        name: string("name", 100)?,
        owner: owner.to_owned(),
        description,
        private: flag("private")?,
        archived: flag("archived")?,
        fork: flag("fork")?,
    })
}

/// The hosted row a remote becomes on `host`.
pub fn hosted(host: &str, value: &Value) -> Result<HostedRepository, Kind> {
    let remote = parse_remote(value)?;
    let path = format!("{}/{}", remote.owner, remote.name);
    Ok(HostedRepository {
        raw: value.clone(),
        id: remote.id,
        repository: RepoRef {
            forge: String::from("github"),
            host: host.to_owned(),
            owner: remote.owner.clone(),
            name: remote.name.clone(),
        },
        description: remote.description.unwrap_or_default(),
        visibility: String::from(if remote.private { "private" } else { "public" }),
        archived: remote.archived,
        fork: remote.fork,
        url: format!("https://{host}/{path}"),
        clone_url: format!("https://{host}/{path}.git"),
    })
}

/// The person's repositories on GitHub.
pub struct Repositories<'a> {
    api: GhApi<'a>,
    host: String,
    account: String,
}

impl<'a> Repositories<'a> {
    /// The repositories the given account reads on `host`.
    pub fn new(
        api: GhApi<'a>,
        host: impl Into<String>,
        account: impl Into<String>,
    ) -> Repositories<'a> {
        Repositories {
            api,
            host: host.into(),
            account: account.into(),
        }
    }

    /// Up to 20 pages of the person's repositories, filtered locally.
    pub async fn list(
        &self,
        input: &ListInput,
        cancellation: Option<std::sync::Arc<Cancellation>>,
    ) -> Result<Vec<HostedRepository>, ForgeError> {
        if !matches!(input.visibility.as_str(), "all" | "public" | "private")
            || !matches!(input.archived.as_str(), "all" | "yes" | "no")
            || !matches!(input.fork.as_str(), "all" | "yes" | "no")
            || input.query.chars().count() > 256
        {
            return Err(ForgeError::new(Kind::InvalidData));
        }
        if input.host != self.host || input.account != self.account {
            return Err(ForgeError::new(Kind::Forbidden));
        }
        let mut result = Vec::new();
        let mut budget = ReadBudget::new();
        let query = input.query.trim().to_lowercase();
        for page in 1..=20 {
            let response = self
                .api
                .request(
                    &format!(
                        "user/repos?affiliation=owner,collaborator,organization_member&sort=full_name&per_page=100&page={page}"
                    ),
                    None,
                    None,
                    cancellation.clone(),
                    Default::default(),
                )
                .await?;
            budget.add(response.bytes as u64)?;
            let items = response
                .body
                .as_array()
                .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
            if items.len() > MAX_PAGE {
                return Err(ForgeError::new(Kind::InvalidData));
            }
            for row in items {
                let remote = parse_remote(row).map_err(|_| ForgeError::new(Kind::InvalidData))?;
                let repository =
                    hosted(&self.host, row).map_err(|_| ForgeError::new(Kind::InvalidData))?;
                if let Some(owner) = &input.owner
                    && !owner.eq_ignore_ascii_case(&remote.owner)
                {
                    continue;
                }
                if input.visibility != "all" && input.visibility != repository.visibility {
                    continue;
                }
                if input.archived != "all" && repository.archived != (input.archived == "yes") {
                    continue;
                }
                if input.fork != "all" && repository.fork != (input.fork == "yes") {
                    continue;
                }
                if !query.is_empty() {
                    let haystack = format!(
                        "{}/{} {}",
                        remote.owner,
                        remote.name,
                        remote.description.clone().unwrap_or_default()
                    )
                    .to_lowercase();
                    if !haystack.contains(&query) {
                        continue;
                    }
                }
                result.push(repository);
            }
            if items.len() < 100 {
                return Ok(result);
            }
        }
        Err(ForgeError::new(Kind::Limit))
    }

    /// One repository, or `None` when the host says it is gone.
    pub async fn find(
        &self,
        owner: &str,
        name: &str,
        cancellation: Option<std::sync::Arc<Cancellation>>,
    ) -> Result<Option<HostedRepository>, ForgeError> {
        if !valid_owner(owner) || !valid_name(name) {
            return Err(ForgeError::new(Kind::InvalidData));
        }
        match self
            .api
            .request(
                &format!("repos/{owner}/{name}"),
                None,
                None,
                cancellation,
                Default::default(),
            )
            .await
        {
            Ok(page) => Ok(Some(
                hosted(&self.host, &page.body).map_err(|_| ForgeError::new(Kind::InvalidData))?,
            )),
            Err(error) if error.kind == Kind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// Creates the repository; the caller journals intent and reconciles an uncertain outcome.
    pub async fn create(
        &self,
        input: &PublishInput,
        cancellation: Option<std::sync::Arc<Cancellation>>,
        dispatch: std::sync::Arc<MutationDispatch>,
    ) -> Result<HostedRepository, ForgeError> {
        if !valid_owner(&input.owner)
            || !valid_name(&input.name)
            || !matches!(input.visibility.as_str(), "public" | "private")
            || input.description.chars().count() > 350
        {
            return Err(ForgeError::new(Kind::InvalidData));
        }
        if input.host != self.host || input.account != self.account {
            return Err(ForgeError::new(Kind::Forbidden));
        }
        let path = if input.owner.eq_ignore_ascii_case(&self.account) {
            String::from("user/repos")
        } else {
            format!("orgs/{}/repos", input.owner)
        };
        let mut body = ace_json::Map::new();
        body.insert(String::from("name"), Value::from(input.name.as_str()));
        body.insert(
            String::from("description"),
            Value::from(input.description.as_str()),
        );
        body.insert(
            String::from("private"),
            Value::from(input.visibility == "private"),
        );
        body.insert(String::from("auto_init"), Value::from(false));
        let response = self
            .api
            .request(
                &path,
                Some(Value::Object(body)),
                Some("POST"),
                cancellation,
                dispatch,
            )
            .await?;
        // The host accepted the write: a reply we cannot read is uncertain, never failed.
        let repository = hosted(&self.host, &response.body).map_err(|_| {
            let mut error = ForgeError::new(Kind::OutcomeUncertain);
            error.dispatched = Some(true);
            error
        })?;
        if response.identity_changed {
            // The result exists but cannot be published under this identity: keep it.
            let mut error = ForgeError::new(Kind::OutcomeUncertain);
            error.receipt = ace_json::ser::to_string(&repository)
                .ok()
                .and_then(|text| ace_json::parse(&text).ok());
            return Err(error);
        }
        Ok(repository)
    }
}

/// `GitHubAccount`: a login starts alphanumeric and holds letters, digits or hyphens.
fn valid_owner(owner: &str) -> bool {
    let mut characters = owner.chars();
    !owner.is_empty()
        && owner.chars().count() <= 100
        && characters
            .next()
            .is_some_and(|first| first.is_ascii_alphanumeric())
        && characters.all(|character| character.is_ascii_alphanumeric() || character == '-')
}

/// `ForgeRepository.name`: word characters, dots and hyphens, bounded as the schema is.
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= 100
        && name != "."
        && name != ".."
        && name.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-')
        })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used)]

    use std::pin::Pin;
    use std::sync::Mutex;

    use super::{ListInput, PublishInput, Repositories};
    use crate::schema::github::Kind;
    use crate::transport::command::{CommandRequest, CommandResult, Runner};
    use crate::transport::error::ForgeError;
    use crate::transport::http::GhApi;

    #[derive(Default)]
    struct Stub {
        replies: Mutex<Vec<(u16, String, bool)>>,
        seen: Mutex<Vec<CommandRequest>>,
    }

    impl Runner for Stub {
        fn run<'a>(
            &'a self,
            request: CommandRequest,
        ) -> Pin<Box<dyn std::future::Future<Output = Result<CommandResult, ForgeError>> + Send + 'a>>
        {
            Box::pin(async move {
                self.seen.lock().expect("seen").push(request);
                let (status, body, identity_changed) =
                    self.replies.lock().expect("replies").remove(0);
                Ok(CommandResult {
                    code: Some(0),
                    stdout: format!("HTTP/2.0 {status} X\r\n\r\n{body}"),
                    truncated: false,
                    identity_changed,
                    http: None,
                    unreachable: false,
                })
            })
        }
    }

    fn remote(
        id: i64,
        owner: &str,
        name: &str,
        private: bool,
        archived: bool,
        fork: bool,
    ) -> String {
        format!(
            r#"{{"id":{id},"name":"{name}","owner":{{"login":"{owner}"}},"description":"about {name}","private":{private},"archived":{archived},"fork":{fork}}}"#
        )
    }

    fn client(stub: &Stub) -> Repositories<'_> {
        Repositories::new(
            GhApi::new(stub, "github.com", std::sync::Arc::new(|| 0.0)),
            "github.com",
            "octo",
        )
    }

    fn list_input() -> ListInput {
        ListInput {
            host: String::from("github.com"),
            account: String::from("octo"),
            query: String::new(),
            owner: None,
            visibility: String::from("all"),
            archived: String::from("all"),
            fork: String::from("all"),
        }
    }

    fn respond(stub: &Stub, status: u16, body: String) {
        stub.replies
            .lock()
            .expect("replies")
            .push((status, body, false));
    }

    #[test]
    fn a_list_filters_visibility_archived_fork_owner_and_query_locally() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(async {
                let stub = Stub::default();
                let page = format!(
                    "[{},{},{},{}]",
                    remote(1, "octo", "ace", true, false, false),
                    remote(2, "octo", "site", false, true, false),
                    remote(3, "other", "tool", false, false, true),
                    remote(4, "octo", "ace-tools", false, false, false)
                );
                for _ in 0..3 {
                    respond(&stub, 200, page.clone());
                }
                let repositories = client(&stub);
                let mut input = list_input();
                input.visibility = String::from("public");
                input.query = String::from("ACE");
                let rows = repositories.list(&input, None).await.expect("rows");
                assert_eq!(rows.len(), 1, "{rows:?}");
                assert_eq!(rows[0].repository.name, "ace-tools");
                assert_eq!(rows[0].clone_url, "https://github.com/octo/ace-tools.git");
                let mut input = list_input();
                input.archived = String::from("yes");
                let rows = repositories.list(&input, None).await.expect("rows");
                assert_eq!(rows.len(), 1);
                assert!(rows[0].archived);
                let mut input = list_input();
                input.fork = String::from("yes");
                let rows = repositories.list(&input, None).await.expect("rows");
                assert_eq!(rows.len(), 1);
                assert!(rows[0].fork);
            });
    }

    #[test]
    fn a_list_is_refused_for_another_host_or_account() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(async {
                let stub = Stub::default();
                let repositories = client(&stub);
                let mut input = list_input();
                input.account = String::from("someone-else");
                let error = repositories.list(&input, None).await.expect_err("refused");
                assert_eq!(error.kind, Kind::Forbidden);
                assert!(stub.seen.lock().expect("seen").is_empty());
            });
    }

    #[test]
    fn a_publish_refuses_a_visibility_or_description_the_schema_refuses() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(async {
                let stub = Stub::default();
                let repositories = client(&stub);
                let mut publish = PublishInput {
                    host: String::from("github.com"),
                    account: String::from("octo"),
                    owner: String::from("octo"),
                    name: String::from("new-one"),
                    description: String::new(),
                    visibility: String::from("PRIVATE"),
                };
                assert_eq!(
                    repositories
                        .create(&publish, None, Default::default())
                        .await
                        .expect_err("invalid")
                        .kind,
                    Kind::InvalidData
                );
                publish.visibility = String::from("public");
                publish.description = "d".repeat(351);
                assert_eq!(
                    repositories
                        .create(&publish, None, Default::default())
                        .await
                        .expect_err("invalid")
                        .kind,
                    Kind::InvalidData
                );
                assert!(stub.seen.lock().expect("seen").is_empty(), "no process");
            });
    }

    #[test]
    fn an_owner_or_name_the_protocol_refuses_is_invalid_data() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(async {
                let stub = Stub::default();
                let repositories = client(&stub);
                for (owner, name) in [("bad_owner", "ace"), ("octo", "bad:name")] {
                    assert_eq!(
                        repositories
                            .find(owner, name, None)
                            .await
                            .expect_err("invalid")
                            .kind,
                        Kind::InvalidData,
                        "{owner}/{name}"
                    );
                    let publish = PublishInput {
                        host: String::from("github.com"),
                        account: String::from("octo"),
                        owner: owner.to_owned(),
                        name: name.to_owned(),
                        description: String::new(),
                        visibility: String::from("public"),
                    };
                    assert_eq!(
                        repositories
                            .create(&publish, None, Default::default())
                            .await
                            .expect_err("invalid")
                            .kind,
                        Kind::InvalidData
                    );
                }
                assert!(stub.seen.lock().expect("seen").is_empty());
            });
    }

    #[test]
    fn a_lookup_refuses_an_owner_that_is_not_a_name() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(async {
                let stub = Stub::default();
                let repositories = client(&stub);
                let error = repositories
                    .find("bad/name", "ace", None)
                    .await
                    .expect_err("invalid");
                assert_eq!(error.kind, Kind::InvalidData);
                assert!(stub.seen.lock().expect("seen").is_empty());
            });
    }

    #[test]
    fn input_the_schema_refuses_is_invalid_data() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(async {
                let stub = Stub::default();
                let repositories = client(&stub);
                let mut input = list_input();
                input.visibility = String::from("PUBLIC");
                assert_eq!(
                    repositories
                        .list(&input, None)
                        .await
                        .expect_err("invalid")
                        .kind,
                    Kind::InvalidData
                );
                let mut publish = PublishInput {
                    host: String::from("github.com"),
                    account: String::from("octo"),
                    owner: String::from("a/../../x"),
                    name: String::from("x"),
                    description: String::new(),
                    visibility: String::from("public"),
                };
                assert_eq!(
                    repositories
                        .create(&publish, None, Default::default())
                        .await
                        .expect_err("invalid")
                        .kind,
                    Kind::InvalidData
                );
                publish.owner = String::from("octo");
                assert!(stub.seen.lock().expect("seen").is_empty());
            });
    }

    #[test]
    fn a_lookup_answers_none_when_the_host_says_gone() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(async {
                let stub = Stub::default();
                respond(&stub, 404, String::from(r#"{"message":"Not Found"}"#));
                let repositories = client(&stub);
                assert_eq!(
                    repositories.find("octo", "gone", None).await.expect("none"),
                    None
                );
            });
    }

    #[test]
    fn a_create_posts_to_the_users_root_or_the_organisations() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(async {
                let stub = Stub::default();
                respond(&stub, 201, remote(5, "octo", "new-one", true, false, false));
                let repositories = client(&stub);
                let input = PublishInput {
                    host: String::from("github.com"),
                    account: String::from("octo"),
                    owner: String::from("OCTO"),
                    name: String::from("new-one"),
                    description: String::new(),
                    visibility: String::from("private"),
                };
                let repository = repositories
                    .create(&input, None, Default::default())
                    .await
                    .expect("created");
                assert_eq!(repository.repository.name, "new-one");
                let seen = stub.seen.lock().expect("seen");
                assert_eq!(seen[0].args[1], "user/repos");
                assert!(
                    seen[0]
                        .input
                        .as_deref()
                        .is_some_and(|body| body.contains("\"private\":true"))
                );
            });
    }

    #[test]
    fn a_create_whose_reply_cannot_be_read_or_who_changed_account_is_uncertain() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(async {
                let input = PublishInput {
                    host: String::from("github.com"),
                    account: String::from("octo"),
                    owner: String::from("team"),
                    name: String::from("x"),
                    description: String::new(),
                    visibility: String::from("public"),
                };
                let stub = Stub::default();
                respond(&stub, 201, String::from(r#"{"id":"not a number"}"#));
                let repositories = client(&stub);
                let error = repositories
                    .create(&input, None, Default::default())
                    .await
                    .expect_err("uncertain");
                assert_eq!(error.kind, Kind::OutcomeUncertain);
                let stub = Stub::default();
                stub.replies.lock().expect("replies").push((
                    201,
                    remote(6, "team", "x", false, false, false),
                    true,
                ));
                let repositories = client(&stub);
                let error = repositories
                    .create(&input, None, Default::default())
                    .await
                    .expect_err("uncertain");
                assert_eq!(error.kind, Kind::OutcomeUncertain);
                assert_eq!(
                    stub.seen.lock().expect("seen")[0].args[1],
                    "orgs/team/repos"
                );
            });
    }
}
