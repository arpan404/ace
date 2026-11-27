// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::expect_used)]
//! The inbox's request (`github-inbox.ts`): the account's notifications, or one repository's,
//! with GitHub's paging parameters. The rows and their states follow in this module.

use crate::schema::github::Kind;
use crate::transport::error::ForgeError;

/// The most rows one inbox page keeps (`perPage`).
pub const PER_PAGE: usize = 50;
/// The largest page number a list asks for.
pub const MAX_PAGE: i64 = 20;

/// What an inbox list asks for (`ForgeInboxQuery`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InboxQuery {
    pub all: bool,
    pub participating: bool,
    pub since: Option<String>,
    pub page: i64,
    /// The repository's host, owner and name, when the list is one repository's inbox.
    pub repository: Option<(String, String, String)>,
}

/// The REST endpoint a list asks for; a repository's host must be this inbox's host.
pub fn query_path(host: &str, query: &InboxQuery) -> Result<String, ForgeError> {
    if query.page < 1 || query.page > MAX_PAGE {
        return Err(ForgeError::new(Kind::InvalidData));
    }
    let mut params = vec![
        format!("all={}", query.all),
        format!("participating={}", query.participating),
        format!("per_page={PER_PAGE}"),
        format!("page={}", query.page),
    ];
    if let Some(since) = &query.since {
        params.push(format!("since={}", url_encode(since)));
    }
    let root = match &query.repository {
        Some((repository_host, owner, name)) => {
            if repository_host != host {
                return Err(ForgeError::new(Kind::Unsupported));
            }
            format!("repos/{owner}/{name}/notifications")
        }
        None => String::from("notifications"),
    };
    Ok(format!("{root}?{}", params.join("&")))
}

/// `encodeURIComponent` for the one query value a caller can set.
fn url_encode(text: &str) -> String {
    let mut encoded = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::{InboxQuery, MAX_PAGE, PER_PAGE, query_path};
    use crate::schema::github::Kind;

    fn account() -> InboxQuery {
        InboxQuery {
            all: true,
            participating: false,
            since: Some(String::from("2026-10-01T00:00:00Z")),
            page: 2,
            repository: None,
        }
    }

    #[test]
    fn the_account_inbox_asks_for_one_page_of_fifty() {
        assert_eq!(PER_PAGE, 50);
        assert_eq!(
            query_path("github.com", &account()).expect("a path"),
            "notifications?all=true&participating=false&per_page=50&page=2&since=2026-10-01T00%3A00%3A00Z"
        );
    }

    #[test]
    fn a_repository_inbox_is_pinned_to_that_repository() {
        let query = InboxQuery {
            repository: Some((
                String::from("github.com"),
                String::from("octo"),
                String::from("ace"),
            )),
            ..account()
        };
        assert!(
            query_path("github.com", &query)
                .expect("a path")
                .starts_with("repos/octo/ace/notifications?")
        );
    }

    #[test]
    fn another_hosts_repository_is_unsupported() {
        let query = InboxQuery {
            repository: Some((
                String::from("ghe.example"),
                String::from("octo"),
                String::from("ace"),
            )),
            page: 1,
            ..InboxQuery::default()
        };
        assert_eq!(
            query_path("github.com", &query)
                .expect_err("unsupported")
                .kind,
            Kind::Unsupported
        );
    }

    #[test]
    fn a_page_outside_the_listing_is_invalid_data() {
        for page in [0, -1, MAX_PAGE + 1] {
            let query = InboxQuery {
                page,
                ..InboxQuery::default()
            };
            assert_eq!(
                query_path("github.com", &query).expect_err("invalid").kind,
                Kind::InvalidData,
                "{page}"
            );
        }
    }

    #[test]
    fn a_since_value_is_encoded_as_one_query_value() {
        let query = InboxQuery {
            since: Some(String::from("a b&c=d")),
            page: 1,
            ..InboxQuery::default()
        };
        assert!(
            query_path("github.com", &query)
                .expect("a path")
                .ends_with("since=a%20b%26c%3Dd")
        );
    }
}
