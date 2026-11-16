//! `git_push` (ADR 0171 decision 2): pushes one branch of a repository in the bot's workspace with
//! the person's sign-in, without running anything the bot wrote. The bot's commits are fetched
//! into a clean repository Spade owns (fetching from a repository runs none of its hooks or
//! configured programs), and pushed from there to the remote's URL with hooks off. The URL must
//! be `https` or ssh and point at the repository the call names, which is what grants match.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use spade_core::outward;

use super::host::{Host, HostError, HostRan, Launch, Scratch};
use crate::tools::ToolOutput;

#[derive(Debug, Deserialize)]
pub(super) struct PushArgs {
    pub repo: String,
    pub branch: String,
    #[serde(default = "origin")]
    pub remote: String,
    /// The repository's folder in the workspace.
    #[serde(default)]
    pub path: Option<String>,
}

fn origin() -> String {
    "origin".to_owned()
}

/// The repository's `.git` folder, inside the workspace with links resolved; refused when it
/// borrows objects from elsewhere (an alternates file), since those could be the person's.
fn git_dir(workspace: &Path, path: Option<&str>) -> Result<PathBuf, String> {
    let root = std::fs::canonicalize(workspace).map_err(|e| format!("the workspace: {e}"))?;
    let dir = root.join(path.unwrap_or(".")).join(".git");
    let real = std::fs::canonicalize(&dir)
        .map_err(|_| "there is no git repository there (a .git folder)".to_owned())?;
    if !real.starts_with(&root) || !real.is_dir() {
        return Err("the repository isn't a .git folder inside your workspace".to_owned());
    }
    if real.join("objects/info/alternates").exists() {
        return Err("the repository borrows objects from elsewhere, so Spade won't push it".into());
    }
    Ok(real)
}

async fn git(host: &dyn Host, dir: &Path, args: &[&str]) -> Result<HostRan, HostError> {
    host.run(Launch {
        program: "git".to_owned(),
        args: args.iter().map(|a| (*a).to_owned()).collect(),
        dir: dir.to_path_buf(),
        stdin: None,
    })
    .await
}

fn not_run(why: impl std::fmt::Display) -> ToolOutput {
    ToolOutput::error(format!("Not pushed: {why}."))
}

pub(super) async fn push(
    host: &dyn Host,
    workspace: &Path,
    scratch_root: &Path,
    args: PushArgs,
) -> ToolOutput {
    let checked = outward::repo(&args.repo)
        .and_then(|()| outward::branch(&args.branch))
        .and_then(|()| outward::remote(&args.remote));
    if let Err(why) = checked {
        return not_run(why);
    }
    let dir = match git_dir(workspace, args.path.as_deref()) {
        Ok(dir) => dir,
        Err(why) => return not_run(why),
    };
    let scratch = match Scratch::new(scratch_root) {
        Ok(scratch) => scratch,
        Err(why) => return not_run(why),
    };
    // `--file` reads only that file: no includes, nothing run.
    let config = dir.join("config").to_string_lossy().into_owned();
    let key = format!("remote.{}.url", args.remote);
    let url = match git(
        host,
        scratch.path(),
        &["config", "--file", &config, "--get", &key],
    )
    .await
    {
        Ok(ran) if ran.ok() => ran.stdout.trim().to_owned(),
        Ok(_) => return not_run(format!("the repository has no remote {}", args.remote)),
        Err(HostError::NotStarted(why) | HostError::Unknown(why)) => return not_run(why),
    };
    match outward::remote_url(&url) {
        Ok(remote) if outward::same_repo(&remote, &args.repo) => {}
        Ok(remote) => {
            return not_run(format!(
                "{} points at {}, not {}",
                args.remote, remote.repo, args.repo
            ));
        }
        Err(why) => return not_run(why),
    }
    let clean = scratch.path().join("push.git");
    let clean_dir = clean.to_string_lossy().into_owned();
    let from = dir.to_string_lossy().into_owned();
    let refspec = format!("refs/heads/{0}:refs/heads/{0}", args.branch);
    let steps: [Vec<&str>; 2] = [
        vec!["init", "--bare", "--quiet", &clean_dir],
        vec![
            "-C",
            &clean_dir,
            "fetch",
            "--quiet",
            "--no-tags",
            &from,
            &refspec,
        ],
    ];
    for step in steps {
        match git(host, scratch.path(), &step).await {
            Ok(ran) if ran.ok() => {}
            Ok(ran) => return not_run(ran.said()),
            Err(HostError::NotStarted(why) | HostError::Unknown(why)) => return not_run(why),
        }
    }
    let pushed = git(
        host,
        scratch.path(),
        &[
            "-C",
            &clean_dir,
            "-c",
            "core.hooksPath=/dev/null",
            "push",
            "--no-verify",
            "--porcelain",
            &url,
            &refspec,
        ],
    )
    .await;
    match pushed {
        Ok(ran) if ran.ok() => ToolOutput::ok(format!(
            "Pushed {} to {} ({}).\n{}",
            args.branch,
            args.repo,
            args.remote,
            ran.stdout.trim()
        )),
        Ok(ran) => not_run(ran.said()),
        Err(HostError::NotStarted(why)) => not_run(why),
        Err(HostError::Unknown(why)) => ToolOutput::maybe_ran(format!(
            "The push may or may not have reached {}: {why}. Check the branch before pushing \
             again.",
            args.repo
        )),
    }
}
