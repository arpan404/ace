use ace_platform::AppPaths;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    io,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};
use thiserror::Error;
use tokio::{io::AsyncWriteExt, process::Command, time};

mod github_actions;
mod github_activity;
mod github_checks;
mod github_dashboard;
mod github_detail;
mod github_diff;
mod github_environment;
mod github_mutations;
mod github_search;
mod github_timeline;

pub use github_actions::{
    GithubCheckSummary, GithubPrCheck, GithubPrChecks, GithubWorkflow, GithubWorkflowArtifact,
    GithubWorkflowArtifactRun, GithubWorkflowDeploymentReviewer, GithubWorkflowEnvironment,
    GithubWorkflowJob, GithubWorkflowJobDetail, GithubWorkflowPendingDeployment, GithubWorkflowRun,
    GithubWorkflowRunDetail, GithubWorkflowStep, WorkflowArtifactDownload, WorkflowListFilter,
    WorkflowRunListFilter,
};
pub use github_activity::{GithubPullRequestActivity, PullRequestActivityRequest};
pub use github_checks::{
    CheckRunListFilter, CommitCheckRollupRequest, GithubCheckRun, GithubCheckRunAnnotation,
    GithubCheckRunApp, GithubCheckRunOutput, GithubCheckRunPullRequest, GithubCheckRunSuite,
    GithubCheckSuite, GithubCommitCheckRollup, GithubCommitCheckState, GithubCommitCheckSummary,
    GithubCommitStatus,
};
pub use github_dashboard::{
    GithubPullRequestDashboard, GithubPullRequestDashboardItem, PullRequestDashboardRequest,
};
pub use github_detail::{
    CreatePullRequest, GithubBranchRef, GithubComment, GithubCommitAuthor, GithubCommitRef,
    GithubIssue, GithubIssueThread, GithubLabel, GithubPullRequest, GithubPullRequestCommit,
    GithubPullRequestMergeStatus, GithubPullRequestReview, GithubPullRequestThread,
    GithubRepository, GithubUser,
};
pub use github_diff::{GithubPullRequestDiff, GithubPullRequestFile};
pub use github_environment::GithubEnvironmentStatus;
pub use github_mutations::{
    GithubActionResult, PullRequestCheckout, PullRequestClose, PullRequestComment,
    PullRequestMerge, PullRequestMergeMethod, PullRequestReadyState, PullRequestReopen,
    PullRequestReview, PullRequestReviewDecision, WorkflowDispatch, WorkflowDispatchInput,
    WorkflowRunApprove, WorkflowRunCancel, WorkflowRunPendingDeploymentReview,
    WorkflowRunPendingDeploymentReviewState, WorkflowRunRerun, WorkflowStateChange,
};
pub use github_search::{
    GithubIssueListFilter, GithubIssueSummary, GithubPullRequestListFilter,
    GithubPullRequestSummary, GithubSearchFilter, GithubSearchIssue, GithubSearchPullRequest,
    GithubSearchRepository,
};
pub use github_timeline::GithubTimelineEvent;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Error)]
pub enum GitToolError {
    #[error("missing required binary `{0}`")]
    MissingBinary(String),
    #[error("command `{program}` timed out after {timeout:?}")]
    CommandTimedOut { program: String, timeout: Duration },
    #[error("command `{program}` failed with status {status}: {stderr}")]
    CommandFailed {
        program: String,
        args: Vec<String>,
        status: i32,
        stderr: String,
    },
    #[error("command `{program}` output exceeded {limit} bytes")]
    OutputTooLarge { program: String, limit: usize },
    #[error("failed to run `{program}`: {source}")]
    CommandIo { program: String, source: io::Error },
    #[error("failed to parse {context}: {message}")]
    Parse {
        context: &'static str,
        message: String,
    },
    #[error("unsafe branch name `{0}`")]
    UnsafeBranchName(String),
    #[error("unsafe worktree path `{path}` outside root `{root}`")]
    UnsafeWorktreePath { path: PathBuf, root: PathBuf },
    #[error("commit message must not be empty")]
    EmptyCommitMessage,
    #[error("pathspec must not be empty")]
    EmptyPathspec,
    #[error("operation requires explicit approval on default branch `{0}`")]
    DefaultBranchDenied(String),
    #[error("GitHub CLI is not authenticated")]
    GithubUnauthenticated,
    #[error("current repository is not hosted on GitHub")]
    NotGithubRepository,
}

pub type Result<T> = std::result::Result<T, GitToolError>;

#[derive(Debug, Clone)]
pub struct CommandRequest {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub stdin: Option<Vec<u8>>,
    pub env: BTreeMap<String, String>,
    pub timeout: Duration,
    pub max_output_bytes: usize,
}

impl CommandRequest {
    #[must_use]
    pub fn new(program: impl Into<String>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            cwd: None,
            stdin: None,
            env: BTreeMap::new(),
            timeout: DEFAULT_TIMEOUT,
            max_output_bytes: DEFAULT_MAX_OUTPUT_BYTES,
        }
    }

    #[must_use]
    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.args = args.into_iter().map(Into::into).collect();
        self
    }

    #[must_use]
    pub fn cwd(mut self, cwd: impl Into<PathBuf>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }

    #[must_use]
    pub fn stdin(mut self, stdin: impl Into<Vec<u8>>) -> Self {
        self.stdin = Some(stdin.into());
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandOutput {
    pub status: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl CommandOutput {
    #[must_use]
    pub fn stdout_string(&self) -> String {
        String::from_utf8_lossy(&self.stdout).trim().to_string()
    }

    #[must_use]
    pub fn stderr_string(&self) -> String {
        String::from_utf8_lossy(&self.stderr).trim().to_string()
    }

    #[must_use]
    pub fn success(&self) -> bool {
        self.status == 0
    }
}

#[async_trait]
pub trait ProcessRunner: Send + Sync {
    async fn run(&self, request: CommandRequest) -> Result<CommandOutput>;
}

#[derive(Debug, Default, Clone)]
pub struct TokioProcessRunner;

#[async_trait]
impl ProcessRunner for TokioProcessRunner {
    async fn run(&self, request: CommandRequest) -> Result<CommandOutput> {
        let mut command = Command::new(&request.program);
        command.args(&request.args);
        if let Some(cwd) = &request.cwd {
            command.current_dir(cwd);
        }
        for (key, value) in &request.env {
            command.env(key, value);
        }
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        if request.stdin.is_some() {
            command.stdin(Stdio::piped());
        }

        let mut child = command.spawn().map_err(|source| {
            if source.kind() == io::ErrorKind::NotFound {
                GitToolError::MissingBinary(request.program.clone())
            } else {
                GitToolError::CommandIo {
                    program: request.program.clone(),
                    source,
                }
            }
        })?;

        if let Some(stdin) = request.stdin
            && let Some(mut child_stdin) = child.stdin.take()
        {
            child_stdin
                .write_all(&stdin)
                .await
                .map_err(|source| GitToolError::CommandIo {
                    program: request.program.clone(),
                    source,
                })?;
        }

        let output = time::timeout(request.timeout, child.wait_with_output())
            .await
            .map_err(|_| GitToolError::CommandTimedOut {
                program: request.program.clone(),
                timeout: request.timeout,
            })?
            .map_err(|source| GitToolError::CommandIo {
                program: request.program.clone(),
                source,
            })?;

        let size = output.stdout.len().saturating_add(output.stderr.len());
        if size > request.max_output_bytes {
            return Err(GitToolError::OutputTooLarge {
                program: request.program,
                limit: request.max_output_bytes,
            });
        }

        Ok(CommandOutput {
            status: output.status.code().unwrap_or(1),
            stdout: output.stdout,
            stderr: output.stderr,
        })
    }
}

pub struct GitClient<R: ProcessRunner = TokioProcessRunner> {
    runner: Arc<R>,
}

impl<R: ProcessRunner> Clone for GitClient<R> {
    fn clone(&self) -> Self {
        Self {
            runner: Arc::clone(&self.runner),
        }
    }
}

impl GitClient<TokioProcessRunner> {
    #[must_use]
    pub fn new() -> Self {
        Self {
            runner: Arc::new(TokioProcessRunner),
        }
    }
}

impl Default for GitClient<TokioProcessRunner> {
    fn default() -> Self {
        Self::new()
    }
}

impl<R: ProcessRunner> GitClient<R> {
    #[must_use]
    pub fn with_runner(runner: Arc<R>) -> Self {
        Self { runner }
    }

    pub async fn run_git<I, S>(&self, cwd: &Path, args: I) -> Result<CommandOutput>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let args = args.into_iter().map(Into::into).collect::<Vec<_>>();
        self.runner
            .run(CommandRequest::new("git").args(args).cwd(cwd))
            .await
    }

    async fn git_success<I, S>(&self, cwd: &Path, args: I) -> Result<CommandOutput>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let output = self.run_git(cwd, args).await?;
        ensure_success("git", output)
    }

    pub async fn repository(&self, cwd: &Path) -> Result<GitRepository> {
        let root = self
            .git_success(cwd, ["rev-parse", "--show-toplevel"])
            .await?
            .stdout_string();
        let inside_work_tree = self
            .git_success(cwd, ["rev-parse", "--is-inside-work-tree"])
            .await?
            .stdout_string()
            == "true";
        Ok(GitRepository {
            root: PathBuf::from(root),
            inside_work_tree,
        })
    }

    pub async fn status(&self, cwd: &Path) -> Result<GitStatus> {
        let output = self
            .git_success(cwd, ["status", "--porcelain=v1", "-b"])
            .await?;
        parse_status(&output.stdout_string())
    }

    pub async fn diff(&self, cwd: &Path) -> Result<String> {
        Ok(self.git_success(cwd, ["diff"]).await?.stdout_string())
    }

    pub async fn list_branches(&self, cwd: &Path) -> Result<Vec<GitBranch>> {
        let output = self
            .git_success(
                cwd,
                [
                    "branch",
                    "--format=%(refname:short)|%(HEAD)|%(upstream:short)",
                ],
            )
            .await?;
        output
            .stdout_string()
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(parse_branch)
            .collect::<Result<Vec<_>>>()
    }

    pub async fn current_branch(&self, cwd: &Path) -> Result<String> {
        Ok(self
            .git_success(cwd, ["branch", "--show-current"])
            .await?
            .stdout_string())
    }

    pub async fn default_branch(&self, cwd: &Path) -> Result<Option<String>> {
        let remote = self
            .run_git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"])
            .await?;
        if remote.success() {
            let branch = remote
                .stdout_string()
                .trim_start_matches("origin/")
                .to_string();
            if !branch.is_empty() {
                return Ok(Some(branch));
            }
        }
        for candidate in ["main", "master"] {
            if self
                .run_git(
                    cwd,
                    [
                        "show-ref",
                        "--verify",
                        "--quiet",
                        &format!("refs/heads/{candidate}"),
                    ],
                )
                .await?
                .success()
            {
                return Ok(Some(candidate.to_string()));
            }
        }
        Ok(None)
    }

    pub async fn config_value(&self, cwd: &Path, key: &str) -> Result<Option<String>> {
        let output = self.run_git(cwd, ["config", "--get", key]).await?;
        if output.success() {
            Ok(Some(output.stdout_string()))
        } else {
            Ok(None)
        }
    }

    pub async fn pull_ff_only(&self, cwd: &Path) -> Result<()> {
        self.git_success(cwd, ["pull", "--ff-only"]).await?;
        Ok(())
    }

    pub async fn fetch(&self, cwd: &Path, prune: bool) -> Result<()> {
        if prune {
            self.git_success(cwd, ["fetch", "--prune"]).await?;
        } else {
            self.git_success(cwd, ["fetch"]).await?;
        }
        Ok(())
    }

    pub async fn commit(&self, cwd: &Path, message: &str) -> Result<()> {
        if message.trim().is_empty() {
            return Err(GitToolError::EmptyCommitMessage);
        }
        self.git_success(cwd, ["commit", "-m", message]).await?;
        Ok(())
    }

    pub async fn stage(&self, cwd: &Path, paths: &[String], all: bool) -> Result<()> {
        if all {
            self.git_success(cwd, ["add", "-A"]).await?;
            return Ok(());
        }
        if paths.is_empty() {
            return Err(GitToolError::EmptyPathspec);
        }
        let mut args = vec!["add".to_string(), "--".to_string()];
        args.extend(paths.iter().cloned());
        self.git_success(cwd, args).await?;
        Ok(())
    }

    pub async fn unstage(&self, cwd: &Path, paths: &[String], all: bool) -> Result<()> {
        let mut args = vec![
            "restore".to_string(),
            "--staged".to_string(),
            "--".to_string(),
        ];
        if all {
            args.push(".".to_string());
        } else {
            if paths.is_empty() {
                return Err(GitToolError::EmptyPathspec);
            }
            args.extend(paths.iter().cloned());
        }
        self.git_success(cwd, args).await?;
        Ok(())
    }

    pub async fn list_stashes(&self, cwd: &Path) -> Result<Vec<GitStashEntry>> {
        let output = self
            .git_success(cwd, ["stash", "list", "--format=%gd%x00%gs"])
            .await?;
        parse_stashes(&output.stdout_string())
    }

    pub async fn save_stash(
        &self,
        cwd: &Path,
        message: Option<&str>,
        include_untracked: bool,
    ) -> Result<()> {
        let mut args = vec!["stash".to_string(), "push".to_string()];
        if include_untracked {
            args.push("--include-untracked".to_string());
        }
        if let Some(message) = message
            && !message.trim().is_empty()
        {
            args.extend(["--message".to_string(), message.to_string()]);
        }
        self.git_success(cwd, args).await?;
        Ok(())
    }

    pub async fn apply_stash(&self, cwd: &Path, selector: Option<&str>, index: bool) -> Result<()> {
        let mut args = vec!["stash".to_string(), "apply".to_string()];
        if index {
            args.push("--index".to_string());
        }
        if let Some(selector) = selector {
            args.push(selector.to_string());
        }
        self.git_success(cwd, args).await?;
        Ok(())
    }

    pub async fn pop_stash(&self, cwd: &Path, selector: Option<&str>, index: bool) -> Result<()> {
        let mut args = vec!["stash".to_string(), "pop".to_string()];
        if index {
            args.push("--index".to_string());
        }
        if let Some(selector) = selector {
            args.push(selector.to_string());
        }
        self.git_success(cwd, args).await?;
        Ok(())
    }

    pub async fn drop_stash(&self, cwd: &Path, selector: Option<&str>) -> Result<()> {
        let mut args = vec!["stash".to_string(), "drop".to_string()];
        if let Some(selector) = selector {
            args.push(selector.to_string());
        }
        self.git_success(cwd, args).await?;
        Ok(())
    }

    pub async fn push_current_branch(&self, cwd: &Path, set_upstream: bool) -> Result<()> {
        let branch = self.current_branch(cwd).await?;
        if branch.is_empty() {
            return Err(GitToolError::Parse {
                context: "current branch",
                message: "repository is in detached HEAD state".to_string(),
            });
        }
        if set_upstream {
            self.git_success(cwd, ["push", "-u", "origin", &branch])
                .await?;
        } else {
            self.git_success(cwd, ["push"]).await?;
        }
        Ok(())
    }

    pub async fn create_branch(
        &self,
        cwd: &Path,
        branch: &str,
        start_point: Option<&str>,
    ) -> Result<()> {
        validate_branch_name(branch)?;
        let mut args = vec!["branch".to_string(), branch.to_string()];
        if let Some(start_point) = start_point {
            args.push(start_point.to_string());
        }
        self.git_success(cwd, args).await?;
        Ok(())
    }

    pub async fn checkout_branch(&self, cwd: &Path, branch: &str) -> Result<()> {
        validate_branch_name(branch)?;
        self.git_success(cwd, ["checkout", branch]).await?;
        Ok(())
    }

    pub async fn rename_branch(&self, cwd: &Path, old: Option<&str>, new: &str) -> Result<()> {
        validate_branch_name(new)?;
        let mut args = vec!["branch".to_string(), "-m".to_string()];
        if let Some(old) = old {
            validate_branch_name(old)?;
            args.push(old.to_string());
        }
        args.push(new.to_string());
        self.git_success(cwd, args).await?;
        Ok(())
    }

    pub async fn delete_branch(&self, cwd: &Path, branch: &str, force: bool) -> Result<()> {
        validate_branch_name(branch)?;
        self.git_success(cwd, ["branch", if force { "-D" } else { "-d" }, branch])
            .await?;
        Ok(())
    }

    pub async fn list_worktrees(&self, cwd: &Path) -> Result<Vec<GitWorktree>> {
        let output = self
            .git_success(cwd, ["worktree", "list", "--porcelain"])
            .await?;
        parse_worktrees(&output.stdout_string())
    }

    pub async fn create_worktree(
        &self,
        repo: &Path,
        path: &Path,
        branch: &str,
        start_point: Option<&str>,
    ) -> Result<()> {
        validate_branch_name(branch)?;
        let mut args = vec![
            "worktree".to_string(),
            "add".to_string(),
            "-b".to_string(),
            branch.to_string(),
            path.display().to_string(),
        ];
        if let Some(start_point) = start_point {
            args.push(start_point.to_string());
        }
        self.git_success(repo, args).await?;
        Ok(())
    }

    pub async fn remove_worktree(&self, repo: &Path, path: &Path, force: bool) -> Result<()> {
        let mut args = vec!["worktree".to_string(), "remove".to_string()];
        if force {
            args.push("--force".to_string());
        }
        args.push(path.display().to_string());
        self.git_success(repo, args).await?;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitRepository {
    pub root: PathBuf,
    pub inside_work_tree: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitStatus {
    pub current_branch: Option<String>,
    pub dirty: bool,
    pub ahead: u32,
    pub behind: u32,
    pub entries: Vec<GitStatusEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitStatusEntry {
    pub index: char,
    pub worktree: char,
    pub path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitBranch {
    pub name: String,
    pub current: bool,
    pub upstream: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitWorktree {
    pub path: PathBuf,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub detached: bool,
    pub bare: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitStashEntry {
    pub index: u32,
    pub selector: String,
    pub branch: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct WorktreeConfig {
    pub root: PathBuf,
}

impl WorktreeConfig {
    #[must_use]
    pub fn from_app_paths(paths: &AppPaths) -> Self {
        Self {
            root: paths.state_dir.join("worktrees"),
        }
    }
}

#[derive(Clone)]
pub struct WorktreeManager<R: ProcessRunner = TokioProcessRunner> {
    git: GitClient<R>,
    config: WorktreeConfig,
}

impl<R: ProcessRunner> WorktreeManager<R> {
    #[must_use]
    pub fn new(git: GitClient<R>, config: WorktreeConfig) -> Self {
        Self { git, config }
    }

    pub async fn create(
        &self,
        repo: &Path,
        preferred_branch: &str,
        existing_branches: &[String],
        start_point: Option<&str>,
    ) -> Result<WorktreeCreateResult> {
        let branch = resolve_auto_feature_branch_name(existing_branches, Some(preferred_branch));
        let repo_root = self.git.repository(repo).await?.root;
        let repo_id = sanitize_path_fragment(repo_root.to_string_lossy().as_ref());
        let branch_id = sanitize_path_fragment(&branch);
        let repo_dir = self.config.root.join(repo_id);
        tokio::fs::create_dir_all(&repo_dir)
            .await
            .map_err(|source| GitToolError::CommandIo {
                program: "filesystem".to_string(),
                source,
            })?;

        let path = available_path(&repo_dir, &branch_id);
        ensure_path_inside_root(&self.config.root, &path)?;
        self.git
            .create_worktree(&repo_root, &path, &branch, start_point)
            .await?;
        let status = self.git.status(&path).await.ok();
        Ok(WorktreeCreateResult {
            path,
            branch,
            repo_root,
            dirty: status.is_some_and(|status| status.dirty),
        })
    }

    pub async fn remove(
        &self,
        repo: &Path,
        path: &Path,
        force: bool,
    ) -> Result<WorktreeRemoveResult> {
        ensure_path_inside_root(&self.config.root, path)?;
        let repo_root = self.git.repository(repo).await?.root;
        self.git.remove_worktree(&repo_root, path, force).await?;
        Ok(WorktreeRemoveResult {
            path: path.to_path_buf(),
            removed: true,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeCreateResult {
    pub path: PathBuf,
    pub branch: String,
    pub repo_root: PathBuf,
    pub dirty: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeRemoveResult {
    pub path: PathBuf,
    pub removed: bool,
}

pub struct GithubCliClient<R: ProcessRunner = TokioProcessRunner> {
    runner: Arc<R>,
}

impl<R: ProcessRunner> Clone for GithubCliClient<R> {
    fn clone(&self) -> Self {
        Self {
            runner: Arc::clone(&self.runner),
        }
    }
}

impl GithubCliClient<TokioProcessRunner> {
    #[must_use]
    pub fn new() -> Self {
        Self {
            runner: Arc::new(TokioProcessRunner),
        }
    }
}

impl Default for GithubCliClient<TokioProcessRunner> {
    fn default() -> Self {
        Self::new()
    }
}

impl<R: ProcessRunner> GithubCliClient<R> {
    #[must_use]
    pub fn with_runner(runner: Arc<R>) -> Self {
        Self { runner }
    }

    pub(crate) async fn gh_allow_statuses<I, S>(
        &self,
        cwd: &Path,
        args: I,
        allowed_statuses: &[i32],
    ) -> Result<CommandOutput>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let args = args.into_iter().map(Into::into).collect::<Vec<_>>();
        let output = self
            .runner
            .run(CommandRequest::new("gh").args(args.clone()).cwd(cwd))
            .await?;
        if allowed_statuses.contains(&output.status) {
            Ok(output)
        } else {
            Err(classify_gh_failure(output, args))
        }
    }

    pub(crate) async fn gh_with_stdin_allow_statuses<I, S>(
        &self,
        cwd: &Path,
        args: I,
        stdin: impl Into<Vec<u8>>,
        allowed_statuses: &[i32],
    ) -> Result<CommandOutput>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let args = args.into_iter().map(Into::into).collect::<Vec<_>>();
        let output = self
            .runner
            .run(
                CommandRequest::new("gh")
                    .args(args.clone())
                    .cwd(cwd)
                    .stdin(stdin),
            )
            .await?;
        if allowed_statuses.contains(&output.status) {
            Ok(output)
        } else {
            Err(classify_gh_failure(output, args))
        }
    }
}

#[derive(Clone)]
pub struct GitWorkflow<R: ProcessRunner = TokioProcessRunner> {
    git: GitClient<R>,
    github: GithubCliClient<R>,
}

impl<R: ProcessRunner> GitWorkflow<R> {
    #[must_use]
    pub fn new(git: GitClient<R>, github: GithubCliClient<R>) -> Self {
        Self { git, github }
    }

    pub async fn run(&self, cwd: &Path, action: GitStackedAction) -> Result<GitWorkflowOutcome> {
        let mut events = Vec::new();
        events.push(GitProgressEvent::Validating);
        self.enforce_default_branch_policy(cwd, &action).await?;

        match action {
            GitStackedAction::Commit { message } => {
                self.commit(cwd, &message, &mut events).await?;
            }
            GitStackedAction::Push { set_upstream, .. } => {
                self.push(cwd, set_upstream, &mut events).await?;
            }
            GitStackedAction::CreatePr { request, .. } => {
                let pr = self.create_pr(cwd, &request, &mut events).await?;
                events.push(GitProgressEvent::Completed);
                return Ok(GitWorkflowOutcome {
                    events,
                    pr: Some(pr),
                });
            }
            GitStackedAction::CommitPush {
                message,
                set_upstream,
                ..
            } => {
                self.commit(cwd, &message, &mut events).await?;
                self.push(cwd, set_upstream, &mut events).await?;
            }
            GitStackedAction::CommitPushPr {
                message,
                set_upstream,
                request,
                ..
            } => {
                self.commit(cwd, &message, &mut events).await?;
                self.push(cwd, set_upstream, &mut events).await?;
                let pr = self.create_pr(cwd, &request, &mut events).await?;
                events.push(GitProgressEvent::Completed);
                return Ok(GitWorkflowOutcome {
                    events,
                    pr: Some(pr),
                });
            }
        }
        events.push(GitProgressEvent::Completed);
        Ok(GitWorkflowOutcome { events, pr: None })
    }

    async fn enforce_default_branch_policy(
        &self,
        cwd: &Path,
        action: &GitStackedAction,
    ) -> Result<()> {
        if !action.touches_remote() || action.default_branch_policy() == DefaultBranchPolicy::Allow
        {
            return Ok(());
        }
        let current = self.git.current_branch(cwd).await?;
        if let Some(default_branch) = self.git.default_branch(cwd).await?
            && current == default_branch
        {
            return Err(GitToolError::DefaultBranchDenied(default_branch));
        }
        Ok(())
    }

    async fn commit(
        &self,
        cwd: &Path,
        message: &str,
        events: &mut Vec<GitProgressEvent>,
    ) -> Result<()> {
        events.push(GitProgressEvent::Committing);
        self.git.commit(cwd, message).await
    }

    async fn push(
        &self,
        cwd: &Path,
        set_upstream: bool,
        events: &mut Vec<GitProgressEvent>,
    ) -> Result<()> {
        events.push(GitProgressEvent::Pushing);
        self.git.push_current_branch(cwd, set_upstream).await
    }

    async fn create_pr(
        &self,
        cwd: &Path,
        request: &CreatePullRequest,
        events: &mut Vec<GitProgressEvent>,
    ) -> Result<GithubPullRequest> {
        events.push(GitProgressEvent::CreatingPullRequest);
        self.github.create_pull_request(cwd, request).await
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitStackedAction {
    Commit {
        message: String,
    },
    Push {
        set_upstream: bool,
        default_branch_policy: DefaultBranchPolicy,
    },
    CreatePr {
        request: CreatePullRequest,
        default_branch_policy: DefaultBranchPolicy,
    },
    CommitPush {
        message: String,
        set_upstream: bool,
        default_branch_policy: DefaultBranchPolicy,
    },
    CommitPushPr {
        message: String,
        set_upstream: bool,
        request: CreatePullRequest,
        default_branch_policy: DefaultBranchPolicy,
    },
}

impl GitStackedAction {
    fn touches_remote(&self) -> bool {
        !matches!(self, Self::Commit { .. })
    }

    fn default_branch_policy(&self) -> DefaultBranchPolicy {
        match self {
            Self::Commit { .. } => DefaultBranchPolicy::Deny,
            Self::Push {
                default_branch_policy,
                ..
            }
            | Self::CreatePr {
                default_branch_policy,
                ..
            }
            | Self::CommitPush {
                default_branch_policy,
                ..
            }
            | Self::CommitPushPr {
                default_branch_policy,
                ..
            } => *default_branch_policy,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DefaultBranchPolicy {
    Deny,
    Allow,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum GitProgressEvent {
    Validating,
    Committing,
    Pushing,
    CreatingPullRequest,
    Completed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitWorkflowOutcome {
    pub events: Vec<GitProgressEvent>,
    pub pr: Option<GithubPullRequest>,
}

#[must_use]
pub fn sanitize_branch_fragment(raw: &str) -> String {
    let mut output = String::new();
    let mut last_was_separator = false;
    let trimmed = raw
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .to_lowercase();
    for char in trimmed.chars() {
        let next = if char.is_ascii_alphanumeric() {
            Some(char)
        } else if matches!(char, '/' | '-' | '_' | '.' | ' ') {
            Some('-')
        } else {
            None
        };
        if let Some(next) = next {
            if next == '-' {
                if !last_was_separator && !output.is_empty() {
                    output.push(next);
                    last_was_separator = true;
                }
            } else {
                output.push(next);
                last_was_separator = false;
            }
        }
        if output.len() >= 64 {
            break;
        }
    }
    let sanitized = output.trim_matches('-').trim_matches('.').to_string();
    if sanitized.is_empty() {
        "update".to_string()
    } else {
        sanitized
    }
}

#[must_use]
pub fn sanitize_feature_branch_name(raw: &str) -> String {
    let normalized = raw.trim().to_lowercase();
    if normalized.contains('/') {
        let mut segments = normalized
            .split('/')
            .map(sanitize_branch_fragment)
            .filter(|segment| !segment.is_empty())
            .collect::<Vec<_>>();
        if segments.is_empty() {
            segments.push("update".to_string());
        }
        segments.join("/")
    } else {
        format!("feature/{}", sanitize_branch_fragment(raw))
    }
}

#[must_use]
pub fn resolve_auto_feature_branch_name(existing: &[String], preferred: Option<&str>) -> String {
    let base = sanitize_feature_branch_name(preferred.unwrap_or("update"));
    let existing = existing
        .iter()
        .map(|branch| branch.to_lowercase())
        .collect::<HashSet<_>>();
    if !existing.contains(&base) {
        return base;
    }
    for suffix in 2.. {
        let candidate = format!("{base}-{suffix}");
        if !existing.contains(&candidate) {
            return candidate;
        }
    }
    unreachable!("unbounded suffix loop must return");
}

fn ensure_success(program: &str, output: CommandOutput) -> Result<CommandOutput> {
    if output.success() {
        Ok(output)
    } else {
        Err(GitToolError::CommandFailed {
            program: program.to_string(),
            args: Vec::new(),
            status: output.status,
            stderr: output.stderr_string(),
        })
    }
}

fn parse_status(raw: &str) -> Result<GitStatus> {
    let mut current_branch = None;
    let mut ahead = 0;
    let mut behind = 0;
    let mut entries = Vec::new();
    for line in raw.lines() {
        if let Some(header) = line.strip_prefix("## ") {
            let branch = header.split("...").next().unwrap_or(header);
            current_branch = if branch == "HEAD (no branch)" {
                None
            } else {
                Some(branch.to_string())
            };
            if let Some(position) = header.find("ahead ") {
                ahead = parse_counter(&header[position + 6..]);
            }
            if let Some(position) = header.find("behind ") {
                behind = parse_counter(&header[position + 7..]);
            }
            continue;
        }
        if line.len() >= 4 {
            let mut chars = line.chars();
            let index = chars.next().unwrap_or(' ');
            let worktree = chars.next().unwrap_or(' ');
            let path = line[3..].split(" -> ").last().unwrap_or("").to_string();
            entries.push(GitStatusEntry {
                index,
                worktree,
                path: PathBuf::from(path),
            });
        }
    }
    Ok(GitStatus {
        current_branch,
        dirty: !entries.is_empty(),
        ahead,
        behind,
        entries,
    })
}

fn parse_counter(raw: &str) -> u32 {
    raw.chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .unwrap_or(0)
}

fn parse_branch(line: &str) -> Result<GitBranch> {
    let mut parts = line.split('|');
    let name = parts.next().unwrap_or_default().to_string();
    let head = parts.next().unwrap_or_default();
    let upstream = parts
        .next()
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    if name.is_empty() {
        return Err(GitToolError::Parse {
            context: "git branch",
            message: format!("invalid branch line `{line}`"),
        });
    }
    Ok(GitBranch {
        name,
        current: head == "*",
        upstream,
    })
}

fn parse_stashes(raw: &str) -> Result<Vec<GitStashEntry>> {
    raw.lines()
        .filter(|line| !line.trim().is_empty())
        .map(parse_stash)
        .collect()
}

fn parse_stash(line: &str) -> Result<GitStashEntry> {
    let (selector, subject) = line.split_once('\0').ok_or_else(|| GitToolError::Parse {
        context: "git stash",
        message: format!("invalid stash line `{line}`"),
    })?;
    let index = selector
        .strip_prefix("stash@{")
        .and_then(|rest| rest.strip_suffix('}'))
        .and_then(|raw| raw.parse::<u32>().ok())
        .ok_or_else(|| GitToolError::Parse {
            context: "git stash",
            message: format!("invalid stash selector `{selector}`"),
        })?;
    let branch = subject
        .strip_prefix("WIP on ")
        .and_then(|rest| rest.split_once(':').map(|(branch, _)| branch.to_string()));
    Ok(GitStashEntry {
        index,
        selector: selector.to_string(),
        branch,
        message: subject.to_string(),
    })
}

fn parse_worktrees(raw: &str) -> Result<Vec<GitWorktree>> {
    let mut worktrees = Vec::new();
    let mut current: Option<GitWorktree> = None;
    for line in raw.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            if let Some(worktree) = current.take() {
                worktrees.push(worktree);
            }
            current = Some(GitWorktree {
                path: PathBuf::from(path),
                branch: None,
                head: None,
                detached: false,
                bare: false,
            });
        } else if let Some(worktree) = current.as_mut() {
            if let Some(head) = line.strip_prefix("HEAD ") {
                worktree.head = Some(head.to_string());
            } else if let Some(branch) = line.strip_prefix("branch ") {
                worktree.branch = Some(branch.trim_start_matches("refs/heads/").to_string());
            } else if line == "detached" {
                worktree.detached = true;
            } else if line == "bare" {
                worktree.bare = true;
            }
        }
    }
    if let Some(worktree) = current {
        worktrees.push(worktree);
    }
    Ok(worktrees)
}

pub(crate) fn validate_branch_name(branch: &str) -> Result<()> {
    if branch.is_empty()
        || branch.starts_with('-')
        || branch.starts_with('/')
        || branch.ends_with('/')
        || branch.contains("..")
        || branch.contains("//")
        || branch.contains('\\')
        || branch.chars().any(char::is_whitespace)
    {
        Err(GitToolError::UnsafeBranchName(branch.to_string()))
    } else {
        Ok(())
    }
}

fn sanitize_path_fragment(raw: &str) -> String {
    sanitize_branch_fragment(raw)
}

fn available_path(root: &Path, base: &str) -> PathBuf {
    let path = root.join(base);
    if !path.exists() {
        return path;
    }
    for suffix in 2.. {
        let candidate = root.join(format!("{base}-{suffix}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!("unbounded suffix loop must return");
}

fn ensure_path_inside_root(root: &Path, path: &Path) -> Result<()> {
    let root = normalize_path(root);
    let path = normalize_path(path);
    if path.starts_with(&root) {
        Ok(())
    } else {
        Err(GitToolError::UnsafeWorktreePath { path, root })
    }
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            std::path::Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

fn classify_gh_failure(output: CommandOutput, args: Vec<String>) -> GitToolError {
    let stderr = output.stderr_string();
    let lower = stderr.to_lowercase();
    if lower.contains("not logged into")
        || lower.contains("authentication")
        || lower.contains("auth login")
    {
        GitToolError::GithubUnauthenticated
    } else if lower.contains("not a github repository") || lower.contains("none of the git remotes")
    {
        GitToolError::NotGithubRepository
    } else {
        GitToolError::CommandFailed {
            program: "gh".to_string(),
            args,
            status: output.status,
            stderr,
        }
    }
}

pub(crate) fn parse_json<T>(context: &'static str, bytes: &[u8]) -> Result<T>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_slice(bytes).map_err(|error| GitToolError::Parse {
        context,
        message: error.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::VecDeque, ffi::OsStr, fs, sync::Mutex};
    use tempfile::TempDir;

    #[derive(Debug)]
    struct FakeRunner {
        outputs: Mutex<VecDeque<CommandOutput>>,
        requests: Mutex<Vec<CommandRequest>>,
    }

    impl FakeRunner {
        fn new(outputs: Vec<CommandOutput>) -> Self {
            Self {
                outputs: Mutex::new(VecDeque::from(outputs)),
                requests: Mutex::new(Vec::new()),
            }
        }

        fn requests(&self) -> Vec<CommandRequest> {
            self.requests.lock().expect("lock requests").clone()
        }
    }

    #[async_trait]
    impl ProcessRunner for FakeRunner {
        async fn run(&self, request: CommandRequest) -> Result<CommandOutput> {
            self.requests.lock().expect("lock requests").push(request);
            self.outputs
                .lock()
                .expect("lock outputs")
                .pop_front()
                .ok_or_else(|| GitToolError::Parse {
                    context: "fake runner",
                    message: "no fake output queued".to_string(),
                })
        }
    }

    fn ok(stdout: impl AsRef<[u8]>) -> CommandOutput {
        CommandOutput {
            status: 0,
            stdout: stdout.as_ref().to_vec(),
            stderr: Vec::new(),
        }
    }

    fn fail(stderr: impl AsRef<[u8]>) -> CommandOutput {
        CommandOutput {
            status: 1,
            stdout: Vec::new(),
            stderr: stderr.as_ref().to_vec(),
        }
    }

    #[test]
    fn sanitizes_feature_branch_names() {
        assert_eq!(
            sanitize_branch_fragment("  Fix: LOGIN Bug!!  "),
            "fix-login-bug"
        );
        assert_eq!(sanitize_branch_fragment(""), "update");
        assert_eq!(
            sanitize_feature_branch_name("Checkout Flow"),
            "feature/checkout-flow"
        );
        assert_eq!(sanitize_feature_branch_name("hotfix/Login"), "hotfix/login");
    }

    #[test]
    fn resolves_unique_feature_branch_names_case_insensitively() {
        let existing = vec!["feature/login".to_string(), "feature/login-2".to_string()];
        assert_eq!(
            resolve_auto_feature_branch_name(&existing, Some("Login")),
            "feature/login-3"
        );
    }

    #[test]
    fn parses_status_with_ahead_behind_and_entries() {
        let status = parse_status(
            "## feature/x...origin/feature/x [ahead 2, behind 1]\n M src/lib.rs\n?? README.md",
        )
        .expect("parse status");
        assert_eq!(status.current_branch.as_deref(), Some("feature/x"));
        assert!(status.dirty);
        assert_eq!(status.ahead, 2);
        assert_eq!(status.behind, 1);
        assert_eq!(status.entries.len(), 2);
    }

    #[test]
    fn parses_worktree_porcelain() {
        let worktrees = parse_worktrees(
            "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo-wt\nHEAD def\nbranch refs/heads/feature/x\n",
        )
        .expect("parse worktrees");
        assert_eq!(worktrees.len(), 2);
        assert_eq!(worktrees[1].branch.as_deref(), Some("feature/x"));
    }

    #[test]
    fn parses_stash_entries() {
        let stashes = parse_stashes(
            "stash@{0}\0WIP on feature/x: abc123 working tree\nstash@{1}\0On main: manual save\n",
        )
        .expect("parse stashes");

        assert_eq!(stashes.len(), 2);
        assert_eq!(stashes[0].index, 0);
        assert_eq!(stashes[0].selector, "stash@{0}");
        assert_eq!(stashes[0].branch.as_deref(), Some("feature/x"));
        assert_eq!(stashes[1].branch, None);
    }

    #[tokio::test]
    async fn stash_actions_build_expected_commands() {
        let runner = Arc::new(FakeRunner::new(vec![ok(""), ok(""), ok(""), ok("")]));
        let git = GitClient::with_runner(runner.clone());

        git.save_stash(Path::new("."), Some("save work"), true)
            .await
            .expect("save");
        git.apply_stash(Path::new("."), Some("stash@{0}"), true)
            .await
            .expect("apply");
        git.pop_stash(Path::new("."), Some("stash@{0}"), false)
            .await
            .expect("pop");
        git.drop_stash(Path::new("."), Some("stash@{0}"))
            .await
            .expect("drop");

        let requests = runner.requests();
        assert_eq!(
            requests[0].args,
            vec![
                "stash",
                "push",
                "--include-untracked",
                "--message",
                "save work"
            ]
        );
        assert_eq!(
            requests[1].args,
            vec!["stash", "apply", "--index", "stash@{0}"]
        );
        assert_eq!(requests[2].args, vec!["stash", "pop", "stash@{0}"]);
        assert_eq!(requests[3].args, vec!["stash", "drop", "stash@{0}"]);
    }

    #[tokio::test]
    async fn github_repository_json_is_parsed() {
        let runner = Arc::new(FakeRunner::new(vec![ok(
            br#"{"nameWithOwner":"a/b","defaultBranchRef":{"name":"main"},"url":"https://github.com/a/b","sshUrl":"git@github.com:a/b.git"}"#,
        )]));
        let github = GithubCliClient::with_runner(runner);
        let repo = github.repository(Path::new(".")).await.expect("repo");
        assert_eq!(repo.name_with_owner, "a/b");
        assert_eq!(repo.default_branch_ref.name, "main");
    }

    #[tokio::test]
    async fn github_auth_failure_is_classified() {
        let runner = Arc::new(FakeRunner::new(vec![fail(
            "You are not logged into any GitHub hosts. Run gh auth login",
        )]));
        let github = GithubCliClient::with_runner(runner);
        let error = github
            .repository(Path::new("."))
            .await
            .expect_err("auth error");
        assert!(matches!(error, GitToolError::GithubUnauthenticated));
    }

    #[tokio::test]
    async fn workflow_denies_default_branch_remote_action() {
        let runner = Arc::new(FakeRunner::new(vec![ok("main"), ok("main")]));
        let git = GitClient::with_runner(runner.clone());
        let github = GithubCliClient::with_runner(runner);
        let workflow = GitWorkflow::new(git, github);
        let error = workflow
            .run(
                Path::new("."),
                GitStackedAction::Push {
                    set_upstream: false,
                    default_branch_policy: DefaultBranchPolicy::Deny,
                },
            )
            .await
            .expect_err("default branch denied");
        assert!(matches!(error, GitToolError::DefaultBranchDenied(branch) if branch == "main"));
    }

    #[tokio::test]
    async fn workflow_runs_commit_push_pr_in_order() {
        let runner = Arc::new(FakeRunner::new(vec![
            ok("feature/work"),
            ok("main"),
            ok(""),
            ok("feature/work"),
            ok(""),
            ok("https://github.com/a/b/pull/42\n"),
        ]));
        let git = GitClient::with_runner(runner.clone());
        let github = GithubCliClient::with_runner(runner.clone());
        let workflow = GitWorkflow::new(git, github);
        let outcome = workflow
            .run(
                Path::new("."),
                GitStackedAction::CommitPushPr {
                    message: "ship it".to_string(),
                    set_upstream: false,
                    request: CreatePullRequest {
                        title: "Ship it".to_string(),
                        body: "Body".to_string(),
                        head: "feature/work".to_string(),
                        base: "main".to_string(),
                        draft: false,
                    },
                    default_branch_policy: DefaultBranchPolicy::Deny,
                },
            )
            .await
            .expect("workflow");
        assert_eq!(
            outcome.events,
            vec![
                GitProgressEvent::Validating,
                GitProgressEvent::Committing,
                GitProgressEvent::Pushing,
                GitProgressEvent::CreatingPullRequest,
                GitProgressEvent::Completed,
            ]
        );
        assert_eq!(outcome.pr.and_then(|pr| pr.number), Some(42));

        let requests = runner.requests();
        assert_eq!(requests[2].args, vec!["commit", "-m", "ship it"]);
        assert_eq!(requests[4].args, vec!["push"]);
        assert_eq!(requests[5].args[0..2], ["pr", "create"]);
    }

    #[tokio::test]
    async fn git_primitives_work_against_temp_repo() {
        let temp = TempDir::new().expect("temp");
        let repo = temp.path().join("repo");
        fs::create_dir(&repo).expect("repo dir");
        run_git(&repo, ["init", "-b", "main"]);
        run_git(&repo, ["config", "user.email", "ace@example.test"]);
        run_git(&repo, ["config", "user.name", "Ace Test"]);
        fs::write(repo.join("README.md"), "hello\n").expect("write readme");
        run_git(&repo, ["add", "README.md"]);
        run_git(&repo, ["commit", "-m", "initial"]);

        let client = GitClient::new();
        let repository = client.repository(&repo).await.expect("repository");
        assert_eq!(
            repository.root.canonicalize().expect("repo root"),
            repo.canonicalize().expect("repo path")
        );

        client
            .create_branch(&repository.root, "feature/test", None)
            .await
            .expect("create branch");
        client
            .checkout_branch(&repository.root, "feature/test")
            .await
            .expect("checkout branch");
        fs::write(repository.root.join("README.md"), "hello\nchanged\n").expect("modify");
        let status = client.status(&repository.root).await.expect("status");
        assert!(status.dirty);
        assert_eq!(status.current_branch.as_deref(), Some("feature/test"));
    }

    #[tokio::test]
    async fn worktree_create_and_remove_use_safe_app_root() {
        let temp = TempDir::new().expect("temp");
        let repo = temp.path().join("repo");
        let worktrees = temp.path().join("state").join("worktrees");
        fs::create_dir(&repo).expect("repo dir");
        run_git(&repo, ["init", "-b", "main"]);
        run_git(&repo, ["config", "user.email", "ace@example.test"]);
        run_git(&repo, ["config", "user.name", "Ace Test"]);
        fs::write(repo.join("README.md"), "hello\n").expect("write readme");
        run_git(&repo, ["add", "README.md"]);
        run_git(&repo, ["commit", "-m", "initial"]);

        let git = GitClient::new();
        let manager = WorktreeManager::new(
            git,
            WorktreeConfig {
                root: worktrees.clone(),
            },
        );
        let created = manager
            .create(&repo, "Feature One", &[], Some("main"))
            .await
            .expect("create worktree");
        assert!(created.path.starts_with(&worktrees));
        assert_eq!(created.branch, "feature/feature-one");
        assert!(created.path.join("README.md").exists());

        let removed = manager
            .remove(&repo, &created.path, true)
            .await
            .expect("remove worktree");
        assert!(removed.removed);
    }

    #[tokio::test]
    async fn push_current_branch_to_local_bare_remote() {
        let temp = TempDir::new().expect("temp");
        let repo = temp.path().join("repo");
        let remote = temp.path().join("remote.git");
        fs::create_dir(&repo).expect("repo dir");
        run_git(
            temp.path(),
            ["init", "--bare", remote.to_str().expect("remote path")],
        );
        run_git(&repo, ["init", "-b", "main"]);
        run_git(&repo, ["config", "user.email", "ace@example.test"]);
        run_git(&repo, ["config", "user.name", "Ace Test"]);
        run_git(
            &repo,
            [
                "remote",
                "add",
                "origin",
                remote.to_str().expect("remote path"),
            ],
        );
        fs::write(repo.join("README.md"), "hello\n").expect("write readme");
        run_git(&repo, ["add", "README.md"]);
        run_git(&repo, ["commit", "-m", "initial"]);

        let client = GitClient::new();
        client
            .push_current_branch(&repo, true)
            .await
            .expect("push current branch");
        assert!(remote.join("refs").join("heads").join("main").exists());
    }

    fn run_git<I, S>(cwd: &Path, args: I)
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .status()
            .expect("run git");
        assert!(status.success());
    }
}
