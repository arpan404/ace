//! `git_push` (ADR 0171 decision 2, amendment 1): pushes one branch of a repository in the bot's
//! workspace with the person's sign-in, without reading anything of the bot's outside its sandbox.
//!
//! 1. Inside the bot's sandbox, in a fresh folder of Spade's that only that run may write, the
//!    branch is bundled and the remote's URL is read as stored (no `insteadOf` of the
//!    repository's applies). A `.git` holding a link or an alternates file is refused there. What
//!    the sandbox can't read (another repository a link points at) can't get into the bundle.
//! 2. On the host, the bundle (a regular file the run left, which nothing of the bot's can reach
//!    once it ended) is fetched into a clean repository of Spade's, and pushed from there with
//!    hooks off to the URL, once the destination, after the person's own URL rewriting, is the
//!    host and repository the call names.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;

use serde::Deserialize;
use spade_core::outward;

use super::host::{Host, HostError, HostRan, Launch, Scratch};
use crate::tools::ToolOutput;

#[derive(Debug, Deserialize)]
pub(super) struct PushArgs {
    /// `host/owner/name`, or `owner/name` on GitHub.
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

/// What staging is asked to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Staging {
    pub workspace: PathBuf,
    /// The repository's folder, relative to the workspace.
    pub path: String,
    pub remote: String,
    pub branch: String,
    /// Spade's fresh folder the bundle is written to.
    pub into: PathBuf,
}

/// What staging left: the bundle's path (in `into`) and the remote's URL as stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Staged {
    pub bundle: PathBuf,
    pub url: String,
}

pub type StageFuture = Pin<Box<dyn Future<Output = Result<Staged, String>> + Send>>;

/// Makes the bundle a push is fetched from, from inside the bot's sandbox.
pub trait Stage: Send + Sync {
    fn stage(&self, staging: Staging) -> StageFuture;
}

/// A repository folder in the workspace, as given: relative, with no `..`.
fn folder(path: Option<&str>) -> Result<String, String> {
    let path = path.unwrap_or(".").trim();
    let path = if path.is_empty() { "." } else { path };
    if path.starts_with('/') || path.split('/').any(|part| part == "..") || path.contains('\0') {
        return Err(format!("{path} isn't a folder in your workspace"));
    }
    Ok(path.to_owned())
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

/// Runs one git step on the host; its error, said for the bot.
async fn step(host: &dyn Host, dir: &Path, args: &[&str]) -> Result<HostRan, String> {
    match git(host, dir, args).await {
        Ok(ran) if ran.ok() => Ok(ran),
        Ok(ran) => Err(ran.said()),
        Err(HostError::NotStarted(why) | HostError::Unknown(why)) => Err(why),
    }
}

fn not_run(why: impl std::fmt::Display) -> ToolOutput {
    ToolOutput::error(format!("Not pushed: {why}."))
}

/// The destination a URL names must be `canonical`.
fn destination(url: &str, canonical: &str) -> Result<(), String> {
    let remote = outward::remote_url(url)?;
    if outward::same_destination(&remote, canonical) {
        Ok(())
    } else {
        Err(format!(
            "the remote is {}/{}, not {canonical}",
            remote.host, remote.repo
        ))
    }
}

pub(super) async fn push(
    host: &dyn Host,
    stage: &dyn Stage,
    workspace: &Path,
    scratch_root: &Path,
    args: PushArgs,
) -> ToolOutput {
    let checked = outward::canonical_repo(&args.repo).and_then(|repo| {
        outward::branch(&args.branch)?;
        outward::remote(&args.remote)?;
        Ok((repo, folder(args.path.as_deref())?))
    });
    let (canonical, path) = match checked {
        Ok(checked) => checked,
        Err(why) => return not_run(why),
    };
    let scratch = match Scratch::new(scratch_root) {
        Ok(scratch) => scratch,
        Err(why) => return not_run(why),
    };
    let into = scratch.path().join("stage");
    if let Err(error) = std::fs::create_dir(&into) {
        return not_run(format!("Spade's folder: {error}"));
    }
    let staged = stage
        .stage(Staging {
            workspace: workspace.to_path_buf(),
            path,
            remote: args.remote.clone(),
            branch: args.branch.clone(),
            into: into.clone(),
        })
        .await;
    let staged = match staged {
        Ok(staged) => staged,
        Err(why) => return not_run(why),
    };
    // The bundle is a regular file the run left in Spade's folder, never a link out of it.
    let regular = staged.bundle.parent() == Some(into.as_path())
        && std::fs::symlink_metadata(&staged.bundle).is_ok_and(|m| m.file_type().is_file());
    if !regular {
        return not_run("the repository couldn't be bundled");
    }
    if let Err(why) = destination(&staged.url, &canonical) {
        return not_run(why);
    }
    let clean = scratch.path().join("push.git");
    let clean_dir = clean.to_string_lossy().into_owned();
    let bundle = staged.bundle.to_string_lossy().into_owned();
    let refspec = format!("refs/heads/{0}:refs/heads/{0}", args.branch);
    let here = scratch.path();
    let prepared = async {
        step(host, here, &["init", "--bare", "--quiet", &clean_dir]).await?;
        step(
            host,
            here,
            &[
                "-C",
                &clean_dir,
                "fetch",
                "--quiet",
                "--no-tags",
                &bundle,
                &refspec,
            ],
        )
        .await?;
        step(
            host,
            here,
            &["-C", &clean_dir, "remote", "add", "dest", &staged.url],
        )
        .await?;
        // Where git will really push, after the person's own `insteadOf` and `pushInsteadOf`.
        let rewritten = step(
            host,
            here,
            &["-C", &clean_dir, "remote", "get-url", "--push", "dest"],
        )
        .await?;
        destination(rewritten.stdout.trim(), &canonical)
    };
    if let Err(why) = prepared.await {
        return not_run(why);
    }
    let pushed = git(
        host,
        here,
        &[
            "-C",
            &clean_dir,
            "-c",
            "core.hooksPath=/dev/null",
            "push",
            "--no-verify",
            "--porcelain",
            "dest",
            &refspec,
        ],
    )
    .await;
    match pushed {
        Ok(ran) if ran.ok() => ToolOutput::ok(format!(
            "Pushed {} to {canonical}.\n{}",
            args.branch,
            ran.stdout.trim()
        )),
        Ok(ran) => not_run(ran.said()),
        Err(HostError::NotStarted(why)) => not_run(why),
        Err(HostError::Unknown(why)) => ToolOutput::maybe_ran(format!(
            "The push may or may not have reached {canonical}: {why}. Check the branch before \
             pushing again."
        )),
    }
}

/// Stages a push in the bot's sandbox: the checks, the remote's URL and the bundle, by a fixed
/// script that reads what it is given from its environment.
pub struct SandboxStage {
    shell: crate::workspace::shell::Shell,
}

impl SandboxStage {
    pub fn new(shell: crate::workspace::shell::Shell) -> Self {
        Self { shell }
    }
}

const STAGE: &str = r#"set -eu
if [ ! -d .git ] || [ -L .git ]; then echo "there is no .git folder there" >&2; exit 3; fi
if [ -n "$(find .git -type l -print | head -n 1)" ]; then echo "the repository's .git holds a link" >&2; exit 3; fi
if [ -n "$(find .git -name alternates -print | head -n 1)" ]; then echo "the repository borrows objects from elsewhere" >&2; exit 3; fi
git config --get "remote.$SPADE_REMOTE.url" || { echo "the repository has no remote $SPADE_REMOTE" >&2; exit 3; }
git bundle create "$SPADE_BUNDLE" "refs/heads/$SPADE_BRANCH" >/dev/null 2>"$SPADE_BUNDLE.log" || { cat "$SPADE_BUNDLE.log" >&2; exit 4; }
"#;

impl Stage for SandboxStage {
    fn stage(&self, staging: Staging) -> StageFuture {
        let shell = self.shell.clone();
        Box::pin(async move {
            // Only where the sandbox holds: on the host, a link in `.git` could read anything.
            if !shell.contains(&staging.workspace) {
                return Err(
                    "git_push needs Spade's sandbox to read the repository, and this machine \
                     has none; push with a shell command, which is reviewed"
                        .to_owned(),
                );
            }
            let bundle = staging.into.join("push.bundle");
            let dir = staging.workspace.join(&staging.path);
            let env = [
                ("SPADE_REMOTE".to_owned(), staging.remote.clone()),
                ("SPADE_BRANCH".to_owned(), staging.branch.clone()),
                (
                    "SPADE_BUNDLE".to_owned(),
                    bundle.to_string_lossy().into_owned(),
                ),
            ];
            let ran = shell
                .run_from(
                    &staging.workspace,
                    crate::workspace::shell::Job {
                        dir: &dir,
                        script: STAGE,
                        timeout: super::host::HOST_TIME,
                        env: &env,
                        tee: None,
                        cleanup: None,
                        stdin: None,
                        // The one folder outside the workspace this run may write.
                        kind: crate::workspace::shell::Kind::Terminal {
                            scratch: staging.into.clone(),
                        },
                        outside: false,
                        // Spade's own internal command: always expected to be containable.
                        may_run_uncontained: false,
                        clean: false,
                    },
                )
                .await?;
            if ran.code != Some(0) {
                let said = ran.stderr.trim();
                return Err(if said.is_empty() {
                    "the repository couldn't be bundled".to_owned()
                } else {
                    said.chars().take(2_000).collect()
                });
            }
            let url = ran.stdout.lines().next().unwrap_or("").trim().to_owned();
            Ok(Staged { bundle, url })
        })
    }
}
