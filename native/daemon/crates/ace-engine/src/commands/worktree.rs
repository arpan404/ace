// SPDX-License-Identifier: Apache-2.0
//! `worktree-base.ts:13`-`:53` (E5.4e): what a create or prepare asks its worktree to start
//! from, the key the prepared worktree is checked by, and where it is remade from later.

use ace_json::Value;

/// What the payload asks its worktree to start from.
#[derive(Debug, Clone, PartialEq)]
pub enum RequestedBase {
    Branch {
        reference: String,
        remote: Option<String>,
    },
    Revision(String),
    PullRequest(Value),
}

/// `requestedBase`: a pull request, else a branch, else the legacy revision (`HEAD` when absent).
pub fn requested_base(payload: &Value) -> RequestedBase {
    if let Some(selection) = payload.get("pullRequest") {
        return RequestedBase::PullRequest(selection.clone());
    }
    if let Some(base) = payload.get("base") {
        return RequestedBase::Branch {
            reference: base
                .get("ref")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            remote: base
                .get("remote")
                .and_then(Value::as_str)
                .map(str::to_owned),
        };
    }
    RequestedBase::Revision(
        payload
            .get("baseBranch")
            .and_then(Value::as_str)
            .unwrap_or("HEAD")
            .to_owned(),
    )
}

/// `requestedBaseKey`: one string per distinct request. Remote names can't hold `:`.
pub fn requested_base_key(requested: &RequestedBase) -> String {
    match requested {
        RequestedBase::PullRequest(selection) => {
            format!("pr:{}", ace_json::to_string(selection))
        }
        RequestedBase::Revision(revision) => format!("revision:{revision}"),
        RequestedBase::Branch { reference, remote } => match remote {
            None => format!("local:{reference}"),
            Some(remote) => format!("remote:{remote}:{reference}"),
        },
    }
}

/// `baseBranchLabel`: `details.baseBranch` for a request.
pub fn base_branch_label(payload: &Value) -> Option<String> {
    if let Some(base) = payload.get("base") {
        let reference = base.get("ref").and_then(Value::as_str).unwrap_or_default();
        return Some(match base.get("remote").and_then(Value::as_str) {
            Some(remote) => format!("{remote}/{reference}"),
            None => reference.to_owned(),
        });
    }
    payload
        .get("baseBranch")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

/// `recordedBaseRef`: where a thread's worktree is remade from. Never fetches.
pub fn recorded_base_ref(details: Option<&Value>) -> String {
    details
        .and_then(|details| details.get("base"))
        .and_then(|base| base.get("head"))
        .and_then(Value::as_str)
        .or_else(|| {
            details
                .and_then(|details| details.get("baseBranch"))
                .and_then(Value::as_str)
        })
        .unwrap_or("HEAD")
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn value(text: &str) -> Value {
        ace_json::parse(text).expect("json")
    }

    #[test]
    fn a_base_wins_over_the_legacy_revision_and_a_pull_request_wins_over_both() {
        assert_eq!(
            requested_base(&value(
                r#"{"base":{"ref":"main","remote":"origin"},"baseBranch":"old"}"#
            )),
            RequestedBase::Branch {
                reference: "main".into(),
                remote: Some("origin".into())
            }
        );
        assert_eq!(
            requested_base(&value(r#"{"baseBranch":"old"}"#)),
            RequestedBase::Revision("old".into())
        );
        assert_eq!(
            requested_base(&value("{}")),
            RequestedBase::Revision("HEAD".into())
        );
        assert!(matches!(
            requested_base(&value(r#"{"pullRequest":{"number":1}}"#)),
            RequestedBase::PullRequest(_)
        ));
    }

    #[test]
    fn one_key_per_distinct_request_and_a_label_for_the_thread_details() {
        let branch = RequestedBase::Branch {
            reference: "main".into(),
            remote: Some("origin".into()),
        };
        assert_eq!(requested_base_key(&branch), "remote:origin:main");
        assert_eq!(
            base_branch_label(&value(r#"{"base":{"ref":"main","remote":"origin"}}"#)).as_deref(),
            Some("origin/main")
        );
        assert_eq!(
            base_branch_label(&value(r#"{"baseBranch":"legacy"}"#)).as_deref(),
            Some("legacy")
        );
        assert_eq!(
            recorded_base_ref(Some(&value(r#"{"base":{"head":"abc"}}"#))),
            "abc"
        );
        assert_eq!(
            recorded_base_ref(Some(&value(r#"{"baseBranch":"legacy"}"#))),
            "legacy"
        );
        assert_eq!(recorded_base_ref(None), "HEAD");
    }
}
