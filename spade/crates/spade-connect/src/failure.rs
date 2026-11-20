//! Why a browser sign-in last failed, kept for [`crate::SIGN_IN_WINDOW_MS`] so the app that
//! started it can say what happened and what fixes it, in its own words. Only a fixed reason is
//! kept: what the app's server said is read to pick one, never shown or stored.

use crate::hub::FinishError;
use crate::{Connectors, SIGN_IN_WINDOW_MS, View, lock};

/// A failed sign-in, by connector.
#[derive(Debug, Clone)]
pub(crate) struct Failure {
    pub(crate) reason: &'static str,
    pub(crate) at_ms: i64,
    pub(crate) name: String,
    pub(crate) url: String,
    pub(crate) catalogue: Option<String>,
    pub(crate) local: bool,
}

/// The reason a sign-in that ended with `error` failed, for the app: `declined` (the person said
/// no or closed it), `needs_admin` (the account needs an admin's approval), `expired`,
/// `wrong_server`, or `failed`.
pub fn reason(error: &FinishError) -> &'static str {
    match error {
        FinishError::Declined => "declined",
        FinishError::NeedsAdmin => "needs_admin",
        FinishError::Expired => "expired",
        FinishError::WrongIssuer => "wrong_server",
        FinishError::UnknownState | FinishError::Failed(_) => "failed",
    }
}

/// What an `error` (and its description) the app's server sent back means: an admin must allow
/// the app first, or the person declined. The words themselves go no further.
pub(crate) fn from_server(error: &str, description: Option<&str>) -> FinishError {
    let said = format!("{error} {}", description.unwrap_or("")).to_lowercase();
    if ["admin", "approval", "consent_required", "policy"]
        .iter()
        .any(|word| said.contains(word))
    {
        FinishError::NeedsAdmin
    } else {
        FinishError::Declined
    }
}

impl Connectors {
    pub(crate) fn note_failure(&self, id: &str, failure: Failure) {
        lock(&self.failures).insert(id.to_owned(), failure);
    }

    pub(crate) fn clear_failure(&self, id: &str) {
        lock(&self.failures).remove(id);
    }

    /// Why `id`'s last sign-in failed, if it did lately.
    pub(crate) fn failure(&self, id: &str) -> Option<&'static str> {
        let now = self.now();
        let mut failures = lock(&self.failures);
        failures.retain(|_, f| now - f.at_ms < SIGN_IN_WINDOW_MS);
        failures.get(id).map(|f| f.reason)
    }

    /// Failed first sign-ins (no connector kept), as views, so the app polling one learns why.
    pub(crate) fn failed_views_without_records(&self, shown: &[View]) -> Vec<View> {
        let now = self.now();
        lock(&self.failures)
            .iter()
            .filter(|(id, f)| {
                now - f.at_ms < SIGN_IN_WINDOW_MS && !shown.iter().any(|v| &v.id == *id)
            })
            .map(|(id, f)| View {
                id: id.clone(),
                name: f.name.clone(),
                url: f.url.clone(),
                catalogue: f.catalogue.clone(),
                local: f.local,
                sign_in: "oauth",
                state: "needs_reconnect",
                account: None,
                tools: 0,
                problem: None,
                device: None,
                via: None,
                notice: None,
                last_used_ms: None,
                failed: Some(f.reason),
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_server_saying_an_admin_must_approve_reads_as_needs_admin() {
        let table = [
            (
                "access_denied",
                Some("admin_policy_enforced"),
                "needs_admin",
            ),
            ("consent_required", None, "needs_admin"),
            (
                "access_denied",
                Some("Your workspace admin must approve this app"),
                "needs_admin",
            ),
            ("access_denied", None, "declined"),
            (
                "access_denied",
                Some("The user denied the request"),
                "declined",
            ),
        ];
        for (error, description, want) in table {
            assert_eq!(
                reason(&from_server(error, description)),
                want,
                "{error} {description:?}"
            );
        }
    }
}
