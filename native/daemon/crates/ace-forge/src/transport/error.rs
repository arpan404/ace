// SPDX-License-Identifier: Apache-2.0
//! The fixed public failure categories (`errors.ts`), the payload a caller sees.

use std::fmt;

/// Every category `ForgeErrorKind` names, in the TypeScript's order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    NotFound,
    Forbidden,
    RateLimit,
    Offline,
    InvalidData,
    Limit,
    Cli,
    Cancelled,
    Unsupported,
    Conflict,
    BranchInUse,
    BranchGone,
    NoCommits,
    HeadMissing,
    BaseMissing,
    PrExists,
    Unprocessable,
    HeadMoved,
    RunAttemptMoved,
    ForkDeleted,
    OutcomeUncertain,
    PreferencesChanged,
    NotificationsUnavailable,
}

impl Kind {
    /// The `forge_<kind>` token the daemon publishes and the payload carries.
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::NotFound => "not_found",
            Kind::Forbidden => "forbidden",
            Kind::RateLimit => "rate_limit",
            Kind::Offline => "offline",
            Kind::InvalidData => "invalid_data",
            Kind::Limit => "limit",
            Kind::Cli => "cli",
            Kind::Cancelled => "cancelled",
            Kind::Unsupported => "unsupported",
            Kind::Conflict => "conflict",
            Kind::BranchInUse => "branch_in_use",
            Kind::BranchGone => "branch_gone",
            Kind::NoCommits => "no_commits",
            Kind::HeadMissing => "head_missing",
            Kind::BaseMissing => "base_missing",
            Kind::PrExists => "pr_exists",
            Kind::Unprocessable => "unprocessable",
            Kind::HeadMoved => "head_moved",
            Kind::RunAttemptMoved => "run_attempt_moved",
            Kind::ForkDeleted => "fork_deleted",
            Kind::OutcomeUncertain => "outcome_uncertain",
            Kind::PreferencesChanged => "preferences_changed",
            Kind::NotificationsUnavailable => "notifications_unavailable",
        }
    }
}

impl fmt::Display for Kind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// `ForgeError`: a kind, an optional `retryAt`, and whether a write certainly never left.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("Forge request failed: {kind}")]
pub struct ForgeError {
    pub kind: Kind,
    pub retry_at: Option<f64>,
    /// `Some(false)` only when admission proved the CLI never started.
    pub dispatched: Option<bool>,
    /// A read the host accepted whose result could not be published (`ForgeMutationOutcome`).
    pub receipt: Option<ace_json::Value>,
    /// The HTTP status of a 401/403 refusal, so 401 and 403 stay distinguishable.
    pub status: Option<u16>,
    /// True for GraphQL schema refusals (`GRAPHQL_VALIDATION_FAILED`/`undefinedField`),
    /// matching TypeScript's `ForgeQueryRefused` so readers may fall back to a smaller query.
    pub query_refused: bool,
}

impl ForgeError {
    /// A failure with no retry hint and no dispatch claim.
    pub fn new(kind: Kind) -> ForgeError {
        ForgeError {
            kind,
            retry_at: None,
            dispatched: None,
            receipt: None,
            status: None,
            query_refused: false,
        }
    }

    /// A failure that says the write was never sent.
    pub fn not_dispatched(kind: Kind) -> ForgeError {
        ForgeError {
            kind,
            retry_at: None,
            dispatched: Some(false),
            receipt: None,
            status: None,
            query_refused: false,
        }
    }

    /// A GraphQL query refusal (`ForgeQueryRefused`): `invalid_data` and certainly not applied.
    pub fn query_refused() -> ForgeError {
        ForgeError {
            kind: Kind::InvalidData,
            retry_at: None,
            dispatched: Some(false),
            receipt: None,
            status: None,
            query_refused: true,
        }
    }

    /// Whether this error is a GraphQL query refusal (`ForgeQueryRefused`).
    pub fn is_query_refused(&self) -> bool {
        self.query_refused
    }

    /// A failure the caller may retry at `at` (milliseconds since the epoch).
    pub fn retry_at(kind: Kind, at: f64) -> ForgeError {
        ForgeError {
            kind,
            retry_at: Some(at),
            dispatched: Some(false),
            receipt: None,
            status: None,
            query_refused: false,
        }
    }

    /// An access refusal that keeps the host's 401 or 403.
    pub fn refused(kind: Kind, status: u16) -> ForgeError {
        ForgeError {
            kind,
            retry_at: None,
            dispatched: Some(false),
            receipt: None,
            status: Some(status),
            query_refused: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{ForgeError, Kind};

    #[test]
    fn every_category_carries_its_published_token() {
        for (kind, token) in [
            (Kind::NotFound, "not_found"),
            (Kind::RateLimit, "rate_limit"),
            (Kind::OutcomeUncertain, "outcome_uncertain"),
            (Kind::NotificationsUnavailable, "notifications_unavailable"),
        ] {
            assert_eq!(kind.as_str(), token);
            assert_eq!(
                ForgeError::new(kind).to_string(),
                format!("Forge request failed: {token}")
            );
        }
    }

    #[test]
    fn a_not_dispatched_failure_says_the_write_never_left() {
        let error = ForgeError::not_dispatched(Kind::Cli);
        assert_eq!(error.dispatched, Some(false));
        assert_eq!(ForgeError::new(Kind::Cli).dispatched, None);
    }
}
