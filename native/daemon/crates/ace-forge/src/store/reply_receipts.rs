// SPDX-License-Identifier: Apache-2.0
//! Reply receipts and reconciliation (`reply-receipts.ts`): an outstanding reply write is
//! reconciled before any further reply write, including lost responses.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use ace_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::pure::ForgeRepository;
use crate::transport::command::Cancellation;
use crate::transport::error::{ForgeError, Kind};
use crate::transport::http::GhApi;
use crate::transport::limits::ReadBudget;
use crate::transport::mutation::MutationDispatch;

/// `at` is when the reply was reserved; an unconfirmed reply expires after the write window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplyReceipt {
    pub id: Option<u64>,
    pub account: String,
    pub before: u64,
    pub at: i64,
}

/// Receipt store interface (`ReplyReceipts`).
pub trait ReplyReceipts: Send + Sync {
    fn account(&self) -> &str;
    fn get(&self, intent: &str) -> Option<ReplyReceipt>;
    fn reserve(&self, intent: &str, before: u64, at: i64) -> bool;
    fn put(&self, intent: &str, id: u64);
    fn remove(&self, intent: &str);
}

/// In-memory receipt store keyed by intent hash.
pub struct MemoryReplyReceipts {
    account: String,
    entries: Mutex<HashMap<String, ReplyReceipt>>,
}

impl MemoryReplyReceipts {
    pub fn new(account: impl Into<String>) -> Self {
        Self {
            account: account.into(),
            entries: Mutex::new(HashMap::new()),
        }
    }
}

impl ReplyReceipts for MemoryReplyReceipts {
    fn account(&self) -> &str {
        &self.account
    }

    fn get(&self, intent: &str) -> Option<ReplyReceipt> {
        self.entries
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(intent)
            .cloned()
    }

    fn reserve(&self, intent: &str, before: u64, at: i64) -> bool {
        let mut entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        if entries.contains_key(intent) {
            return false;
        }
        entries.insert(
            intent.to_owned(),
            ReplyReceipt {
                id: None,
                account: self.account.clone(),
                before,
                at,
            },
        );
        true
    }

    fn put(&self, intent: &str, id: u64) {
        let mut entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(existing) = entries.get_mut(intent) {
            existing.id = Some(id);
        }
    }

    fn remove(&self, intent: &str) {
        self.entries
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(intent);
    }
}

/// SHA-256 hex digest of `JSON.stringify([repositoryKey(repository), number, commentId, body])`.
pub fn reply_intent(
    repository: &ForgeRepository,
    number: u64,
    comment_id: u64,
    body: &str,
) -> String {
    let payload = Value::Array(
        vec![
            Value::from(repository.key()),
            Value::from(number),
            Value::from(comment_id),
            Value::from(body),
        ]
        .into(),
    );
    let encoded = ace_json::ser::to_string(&payload).unwrap_or_default();
    let digest = Sha256::digest(encoded.as_bytes());
    let mut hex = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut hex, "{byte:02x}");
    }
    hex
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedReplyComment {
    id: u64,
    body: String,
    in_reply_to_id: Option<u64>,
    user_login: Option<String>,
}

fn parse_positive_u64(value: &Value) -> Option<u64> {
    let n = value.as_f64()?;
    if !n.is_finite() || n < 1.0 || n.fract() != 0.0 || n > 9_007_199_254_740_991.0 {
        return None;
    }
    Some(n as u64)
}

fn parse_comment(value: &Value) -> Result<ParsedReplyComment, ForgeError> {
    let obj = value
        .as_object()
        .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
    let id = obj
        .get("id")
        .and_then(parse_positive_u64)
        .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
    let body = obj
        .get("body")
        .and_then(Value::as_str)
        .filter(|s| s.chars().count() <= 65_536)
        .ok_or_else(|| ForgeError::new(Kind::InvalidData))?
        .to_owned();
    let in_reply_to_id = match obj.get("in_reply_to_id") {
        None | Some(Value::Null) => None,
        Some(v) => Some(parse_positive_u64(v).ok_or_else(|| ForgeError::new(Kind::InvalidData))?),
    };
    let user_login = match obj.get("user") {
        Some(Value::Null) => None,
        Some(Value::Object(user)) => {
            let login = user
                .get("login")
                .and_then(Value::as_str)
                .filter(|s| s.chars().count() <= 100)
                .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
            Some(login.to_owned())
        }
        _ => return Err(ForgeError::new(Kind::InvalidData)),
    };
    Ok(ParsedReplyComment {
        id,
        body,
        in_reply_to_id,
        user_login,
    })
}

fn parse_comments_page(value: &Value) -> Result<Vec<ParsedReplyComment>, ForgeError> {
    let items = value
        .as_array()
        .filter(|arr| arr.len() <= 100)
        .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
    items.iter().map(parse_comment).collect()
}

async fn read_comments(
    api: &GhApi<'_>,
    root: &str,
    number: u64,
    cancellation: Option<Arc<Cancellation>>,
) -> Result<Vec<ParsedReplyComment>, ForgeError> {
    let mut budget = ReadBudget::new();
    let pages = api
        .pages(
            &format!("{root}/pulls/{number}/comments?per_page=100"),
            cancellation,
            &mut budget,
        )
        .await?;
    let mut out = Vec::new();
    for page in pages {
        out.extend(parse_comments_page(&page.body)?);
    }
    Ok(out)
}

/// Highest existing review comment ID on the pull request before posting a reply (`replyCutoff`).
pub async fn reply_cutoff(
    api: &GhApi<'_>,
    root: &str,
    number: u64,
    cancellation: Option<Arc<Cancellation>>,
) -> Result<u64, ForgeError> {
    let comments = read_comments(api, root, number, cancellation).await?;
    Ok(comments.into_iter().fold(0_u64, |last, c| last.max(c.id)))
}

/// Expected fields of a pending reply being reconciled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpectedReply<'a> {
    pub account: &'a str,
    pub body: &'a str,
    pub comment_id: u64,
    pub number: u64,
}

fn receipt_error(id: Option<u64>) -> ForgeError {
    let mut receipt = Map::new();
    receipt.insert(
        String::from("id"),
        match id {
            Some(v) => Value::from(v),
            None => Value::Null,
        },
    );
    let mut err = ForgeError::new(Kind::OutcomeUncertain);
    err.receipt = Some(Value::Object(receipt));
    err
}

/// Reconciles an outstanding receipt before any further reply write (`reconcileReply`).
///
/// Returns `Ok(Some(id))` when confirmed, `Ok(None)` when a complete read proves no such
/// reply exists, or `Err(ForgeError { kind: OutcomeUncertain, receipt })` when proof failed
/// or was ambiguous.
pub async fn reconcile_reply(
    api: &GhApi<'_>,
    root: &str,
    receipt: &ReplyReceipt,
    expected: ExpectedReply<'_>,
    cancellation: Option<Arc<Cancellation>>,
) -> Result<Option<u64>, ForgeError> {
    if receipt.account != expected.account {
        return Err(receipt_error(receipt.id));
    }
    let values = match receipt.id {
        None => match read_comments(api, root, expected.number, cancellation).await {
            Ok(list) => list,
            Err(_) => return Err(receipt_error(None)),
        },
        Some(id) => match api
            .request(
                &format!("{root}/pulls/comments/{id}"),
                None,
                None,
                cancellation,
                Arc::new(MutationDispatch::default()),
            )
            .await
        {
            Ok(page) => match parse_comment(&page.body) {
                Ok(parsed) => vec![parsed],
                Err(_) => return Err(receipt_error(Some(id))),
            },
            Err(error) if error.kind == Kind::NotFound => return Ok(None),
            Err(_) => return Err(receipt_error(Some(id))),
        },
    };
    let matches: Vec<u64> = values
        .into_iter()
        .filter(|value| {
            value.id > receipt.before
                && value.body == expected.body
                && value.in_reply_to_id == Some(expected.comment_id)
                && value.user_login.as_deref() == Some(receipt.account.as_str())
                && receipt.id.is_none_or(|id| value.id == id)
        })
        .map(|value| value.id)
        .collect();
    if matches.len() > 1 {
        return Err(receipt_error(receipt.id));
    }
    Ok(matches.first().copied())
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use ace_redaction::EnvironmentMatcher;

    use super::*;
    use crate::pure::ForgeKind;
    use crate::transport::command::{CommandRequest, CommandResult, Runner};

    struct ScriptedRunner {
        replies: Mutex<Vec<CommandResult>>,
    }

    impl ScriptedRunner {
        fn new(replies: Vec<CommandResult>) -> Self {
            Self {
                replies: Mutex::new(replies),
            }
        }
    }

    impl Runner for ScriptedRunner {
        fn credential_environment(&self) -> Option<EnvironmentMatcher> {
            None
        }

        fn run<'a>(
            &'a self,
            _request: CommandRequest,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<CommandResult, ForgeError>> + Send + 'a>,
        > {
            let next = self.replies.lock().unwrap().remove(0);
            Box::pin(async move { Ok(next) })
        }
    }

    fn ok_http(status: u16, json: &str) -> CommandResult {
        CommandResult {
            code: Some(if status < 400 { 0 } else { 1 }),
            stdout: format!("HTTP/2 {status}\r\ncontent-type: application/json\r\n\r\n{json}"),
            truncated: false,
            identity_changed: false,
            http: None,
            unreachable: false,
        }
    }

    #[test]
    fn reply_intent_is_deterministic_and_case_insensitive_on_repo() {
        let a = ForgeRepository::validate(ForgeKind::Github, "GitHub.com", "Octo", "Ace").unwrap();
        let b = ForgeRepository::validate(ForgeKind::Github, "github.com", "octo", "ace").unwrap();
        assert_eq!(
            reply_intent(&a, 42, 7, "done"),
            reply_intent(&b, 42, 7, "done")
        );
        assert_ne!(
            reply_intent(&a, 42, 7, "done"),
            reply_intent(&a, 42, 8, "done")
        );
        assert_eq!(reply_intent(&a, 42, 7, "done").len(), 64);
    }

    #[tokio::test]
    async fn reconcile_reply_finds_matching_comment_after_cutoff_or_returns_none() {
        let runner = ScriptedRunner::new(vec![
            ok_http(
                200,
                r#"[{"id":10,"body":"hello","in_reply_to_id":5,"user":{"login":"alice"}},{"id":12,"body":"hello","in_reply_to_id":5,"user":{"login":"alice"}}]"#,
            ),
            ok_http(404, r#"{"message":"Not Found"}"#),
            ok_http(
                200,
                r#"[{"id":11,"body":"hello","in_reply_to_id":5,"user":{"login":"alice"}},{"id":12,"body":"hello","in_reply_to_id":5,"user":{"login":"alice"}}]"#,
            ),
        ]);
        let api = GhApi::new(&runner, "github.com", Arc::new(|| 1_700_000_000_000.0));
        let receipt = ReplyReceipt {
            id: None,
            account: "alice".into(),
            before: 10,
            at: 100,
        };
        let expected = ExpectedReply {
            account: "alice",
            body: "hello",
            comment_id: 5,
            number: 9,
        };
        assert_eq!(
            reconcile_reply(&api, "repos/o/r", &receipt, expected.clone(), None)
                .await
                .unwrap(),
            Some(12)
        );
        let with_id = ReplyReceipt {
            id: Some(99),
            ..receipt.clone()
        };
        assert_eq!(
            reconcile_reply(&api, "repos/o/r", &with_id, expected.clone(), None)
                .await
                .unwrap(),
            None
        );
        let err = reconcile_reply(&api, "repos/o/r", &receipt, expected.clone(), None)
            .await
            .unwrap_err();
        assert_eq!(err.kind, Kind::OutcomeUncertain);
        let switched = ExpectedReply {
            account: "bob",
            ..expected
        };
        let err = reconcile_reply(&api, "repos/o/r", &receipt, switched, None)
            .await
            .unwrap_err();
        assert_eq!(err.kind, Kind::OutcomeUncertain);
    }

    #[tokio::test]
    async fn reply_cutoff_returns_highest_comment_id() {
        let runner = ScriptedRunner::new(vec![ok_http(
            200,
            r#"[{"id":3,"body":"a","user":{"login":"x"}},{"id":17,"body":"b","user":null}]"#,
        )]);
        let api = GhApi::new(&runner, "github.com", Arc::new(|| 1_700_000_000_000.0));
        assert_eq!(reply_cutoff(&api, "repos/o/r", 4, None).await.unwrap(), 17);
    }
}
