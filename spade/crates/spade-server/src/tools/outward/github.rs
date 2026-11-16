//! `pr_comment` and `issue_comment` (ADR 0171 decision 2): one comment with the person's GitHub
//! sign-in, through `gh` in a folder of Spade's (so no repository's settings are read), the
//! body on stdin.

use std::path::Path;

use serde::Deserialize;
use serde_json::Value;
use spade_core::outward;

use super::host::{Host, HostError, Launch, Scratch};
use crate::tools::ToolOutput;

#[derive(Debug, Deserialize)]
pub(super) struct CommentArgs {
    pub repo: String,
    pub number: Value,
    pub body: String,
}

/// What is commented on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum On {
    PullRequest,
    Issue,
}

pub(super) async fn comment(
    host: &dyn Host,
    scratch_root: &Path,
    on: On,
    args: CommentArgs,
) -> ToolOutput {
    let checked = outward::canonical_repo(&args.repo).and_then(|repo| {
        outward::body(&args.body)?;
        Ok((repo, outward::number(&args.number)?))
    });
    let (repo, number) = match checked {
        Ok(checked) => checked,
        Err(why) => return ToolOutput::error(format!("Not sent: {why}.")),
    };
    let scratch = match Scratch::new(scratch_root) {
        Ok(scratch) => scratch,
        Err(why) => return ToolOutput::error(format!("Not sent: {why}.")),
    };
    let what = match on {
        On::PullRequest => "pr",
        On::Issue => "issue",
    };
    let ran = host
        .run(Launch {
            program: "gh".to_owned(),
            args: vec![
                what.to_owned(),
                "comment".to_owned(),
                number.to_string(),
                "--repo".to_owned(),
                repo.clone(),
                "--body-file".to_owned(),
                "-".to_owned(),
            ],
            dir: scratch.path().to_path_buf(),
            stdin: Some(args.body),
        })
        .await;
    match ran {
        Ok(ran) if ran.ok() => ToolOutput::ok(format!(
            "Commented on {repo}#{number}. {}",
            ran.stdout.trim()
        )),
        Ok(ran) => ToolOutput::error(format!("Not sent: {}", ran.said())),
        Err(HostError::NotStarted(why)) => ToolOutput::error(format!(
            "Not sent: GitHub's command line (gh) couldn't start: {why}. The person can install \
             it and sign in with gh auth login."
        )),
        Err(HostError::Unknown(why)) => ToolOutput::maybe_ran(format!(
            "The comment may or may not have been posted on {repo}#{number}: {why}. Check \
             before sending it again."
        )),
    }
}
