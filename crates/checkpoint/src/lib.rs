use ace_core::{
    CheckpointDiffSource, CheckpointFile, CheckpointRef, CheckpointStatus, CheckpointSummary,
    MessageId, ReadModel, ThreadId, TurnId,
};
use ace_git::{CommandOutput, CommandRequest, GitToolError, ProcessRunner, TokioProcessRunner};
use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use thiserror::Error;
use uuid::Uuid;

const CHECKPOINT_REFS_PREFIX: &str = "refs/ace/checkpoints";
const CHECKPOINT_FILE_SUMMARY_MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Error)]
pub enum CheckpointError {
    #[error("{0}")]
    Git(#[from] GitToolError),
    #[error("checkpoint ref is unavailable for turn {turn_count}")]
    Unavailable { turn_count: u64 },
    #[error("thread was not found: {0}")]
    ThreadNotFound(String),
    #[error("workspace cwd is unavailable for thread: {0}")]
    WorkspaceUnavailable(String),
    #[error("provider rollback failed: {0}")]
    ProviderRollback(String),
    #[error("checkpoint invariant failed: {0}")]
    Invariant(String),
}

pub type Result<T> = std::result::Result<T, CheckpointError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CaptureCheckpointInput {
    pub cwd: PathBuf,
    pub checkpoint_ref: CheckpointRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RestoreCheckpointInput {
    pub cwd: PathBuf,
    pub checkpoint_ref: CheckpointRef,
    pub fallback_to_head: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffCheckpointsInput {
    pub cwd: PathBuf,
    pub from_checkpoint_ref: CheckpointRef,
    pub to_checkpoint_ref: CheckpointRef,
    pub fallback_from_to_head: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckpointDiffFileSummary {
    pub path: String,
    pub additions: u64,
    pub deletions: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeleteCheckpointRefsInput {
    pub cwd: PathBuf,
    pub checkpoint_refs: Vec<CheckpointRef>,
}

#[derive(Debug, Clone)]
pub struct CheckpointStore<R: ProcessRunner = TokioProcessRunner> {
    runner: Arc<R>,
}

impl CheckpointStore<TokioProcessRunner> {
    #[must_use]
    pub fn new() -> Self {
        Self {
            runner: Arc::new(TokioProcessRunner),
        }
    }
}

impl Default for CheckpointStore<TokioProcessRunner> {
    fn default() -> Self {
        Self::new()
    }
}

impl<R: ProcessRunner> CheckpointStore<R> {
    #[must_use]
    pub fn with_runner(runner: Arc<R>) -> Self {
        Self { runner }
    }

    pub async fn is_git_repository(&self, cwd: &Path) -> Result<bool> {
        let output = self
            .run_git(cwd, ["rev-parse", "--is-inside-work-tree"])
            .await?;
        Ok(output.success() && output.stdout_string() == "true")
    }

    pub async fn has_checkpoint_ref(
        &self,
        cwd: &Path,
        checkpoint_ref: &CheckpointRef,
    ) -> Result<bool> {
        Ok(self
            .resolve_checkpoint_commit(cwd, checkpoint_ref)
            .await?
            .is_some())
    }

    pub async fn capture_checkpoint(&self, input: CaptureCheckpointInput) -> Result<()> {
        let temp = tempfile_dir();
        std::fs::create_dir_all(&temp).map_err(|source| {
            CheckpointError::Git(GitToolError::CommandIo {
                program: "mkdir".to_string(),
                source,
            })
        })?;
        let temp_index = temp.join(format!("index-{}", Uuid::new_v4()));
        let mut env = std::collections::BTreeMap::new();
        env.insert(
            "GIT_INDEX_FILE".to_string(),
            temp_index.to_string_lossy().to_string(),
        );
        env.insert("GIT_AUTHOR_NAME".to_string(), "ace".to_string());
        env.insert(
            "GIT_AUTHOR_EMAIL".to_string(),
            "ace@users.noreply.github.com".to_string(),
        );
        env.insert("GIT_COMMITTER_NAME".to_string(), "ace".to_string());
        env.insert(
            "GIT_COMMITTER_EMAIL".to_string(),
            "ace@users.noreply.github.com".to_string(),
        );

        let result = async {
            if self.has_head_commit(&input.cwd).await? {
                self.git_success_with_env(&input.cwd, ["read-tree", "HEAD"], env.clone())
                    .await?;
            }
            self.git_success_with_env(&input.cwd, ["add", "-A", "--", "."], env.clone())
                .await?;
            let tree_oid = self
                .git_success_with_env(&input.cwd, ["write-tree"], env.clone())
                .await?
                .stdout_string();
            if tree_oid.is_empty() {
                return Err(CheckpointError::Invariant(
                    "git write-tree returned an empty tree oid".to_string(),
                ));
            }
            let commit_oid = self
                .git_success_with_env(
                    &input.cwd,
                    [
                        "commit-tree".to_string(),
                        tree_oid,
                        "-m".to_string(),
                        format!("ace checkpoint ref={}", input.checkpoint_ref.0),
                    ],
                    env,
                )
                .await?
                .stdout_string();
            if commit_oid.is_empty() {
                return Err(CheckpointError::Invariant(
                    "git commit-tree returned an empty commit oid".to_string(),
                ));
            }
            self.git_success(
                &input.cwd,
                ["update-ref", input.checkpoint_ref.0.as_str(), &commit_oid],
            )
            .await?;
            Ok(())
        }
        .await;
        let _ = std::fs::remove_dir_all(&temp);
        result
    }

    pub async fn restore_checkpoint(&self, input: RestoreCheckpointInput) -> Result<bool> {
        let mut commit = self
            .resolve_checkpoint_commit(&input.cwd, &input.checkpoint_ref)
            .await?;
        if commit.is_none() && input.fallback_to_head {
            commit = self.resolve_head_commit(&input.cwd).await?;
        }
        let Some(commit) = commit else {
            return Ok(false);
        };
        self.git_success(
            &input.cwd,
            [
                "restore",
                "--source",
                &commit,
                "--worktree",
                "--staged",
                "--",
                ".",
            ],
        )
        .await?;
        self.git_success(&input.cwd, ["clean", "-fd", "--", "."])
            .await?;
        if self.has_head_commit(&input.cwd).await? {
            self.git_success(&input.cwd, ["reset", "--quiet", "--", "."])
                .await?;
        }
        Ok(true)
    }

    pub async fn diff_checkpoints(&self, input: DiffCheckpointsInput) -> Result<String> {
        let (from, to) = self.resolve_diff_commits(&input).await?;
        let output = self
            .git_success(
                &input.cwd,
                ["diff", "--patch", "--minimal", "--no-color", &from, &to],
            )
            .await?;
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }

    pub async fn diff_checkpoint_files(
        &self,
        input: DiffCheckpointsInput,
    ) -> Result<Vec<CheckpointDiffFileSummary>> {
        let (from, to) = self.resolve_diff_commits(&input).await?;
        let mut request = CommandRequest::new("git")
            .args([
                "diff",
                "--numstat",
                "--find-renames",
                "--no-color",
                &from,
                &to,
            ])
            .cwd(&input.cwd);
        request.max_output_bytes = CHECKPOINT_FILE_SUMMARY_MAX_OUTPUT_BYTES;
        let output = ensure_success("git", self.runner.run(request).await?)?;
        Ok(parse_numstat(&String::from_utf8_lossy(&output.stdout)))
    }

    pub async fn delete_checkpoint_refs(&self, input: DeleteCheckpointRefsInput) -> Result<()> {
        for checkpoint_ref in input.checkpoint_refs {
            let _ = self
                .run_git(&input.cwd, ["update-ref", "-d", checkpoint_ref.0.as_str()])
                .await?;
        }
        Ok(())
    }

    async fn resolve_diff_commits(&self, input: &DiffCheckpointsInput) -> Result<(String, String)> {
        let mut from = self
            .resolve_checkpoint_commit(&input.cwd, &input.from_checkpoint_ref)
            .await?;
        if from.is_none() && input.fallback_from_to_head {
            from = self.resolve_head_commit(&input.cwd).await?;
        }
        let to = self
            .resolve_checkpoint_commit(&input.cwd, &input.to_checkpoint_ref)
            .await?;
        match (from, to) {
            (Some(from), Some(to)) => Ok((from, to)),
            _ => Err(CheckpointError::Unavailable { turn_count: 0 }),
        }
    }

    async fn has_head_commit(&self, cwd: &Path) -> Result<bool> {
        let output = self.run_git(cwd, ["rev-parse", "--verify", "HEAD"]).await?;
        Ok(output.success())
    }

    async fn resolve_head_commit(&self, cwd: &Path) -> Result<Option<String>> {
        let output = self
            .run_git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])
            .await?;
        if output.success() {
            let commit = output.stdout_string();
            Ok((!commit.is_empty()).then_some(commit))
        } else {
            Ok(None)
        }
    }

    async fn resolve_checkpoint_commit(
        &self,
        cwd: &Path,
        checkpoint_ref: &CheckpointRef,
    ) -> Result<Option<String>> {
        let output = self
            .run_git(
                cwd,
                [
                    "rev-parse",
                    "--verify",
                    "--quiet",
                    &format!("{}^{{commit}}", checkpoint_ref.0),
                ],
            )
            .await?;
        if output.success() {
            let commit = output.stdout_string();
            Ok((!commit.is_empty()).then_some(commit))
        } else {
            Ok(None)
        }
    }

    async fn run_git<I, S>(
        &self,
        cwd: &Path,
        args: I,
    ) -> std::result::Result<CommandOutput, GitToolError>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.runner
            .run(CommandRequest::new("git").args(args).cwd(cwd))
            .await
    }

    async fn git_success<I, S>(
        &self,
        cwd: &Path,
        args: I,
    ) -> std::result::Result<CommandOutput, GitToolError>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        ensure_success("git", self.run_git(cwd, args).await?)
    }

    async fn git_success_with_env<I, S>(
        &self,
        cwd: &Path,
        args: I,
        env: std::collections::BTreeMap<String, String>,
    ) -> std::result::Result<CommandOutput, GitToolError>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let mut request = CommandRequest::new("git").args(args).cwd(cwd);
        request.env = env;
        ensure_success("git", self.runner.run(request).await?)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeTurnStarted {
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub cwd: Option<PathBuf>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeTurnCompleted {
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub cwd: Option<PathBuf>,
    pub state: RuntimeTurnState,
    pub assistant_message_id: Option<MessageId>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeTurnState {
    Completed,
    Failed,
    Interrupted,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RevertRequest {
    pub thread_id: ThreadId,
    pub turn_count: u64,
}

#[async_trait]
pub trait CheckpointReadModel: Send + Sync {
    async fn read_model(&self) -> ReadModel;
    async fn upsert_checkpoint(&self, checkpoint: CheckpointSummary) -> Result<()>;
    async fn mark_reverted(
        &self,
        thread_id: ThreadId,
        turn_count: u64,
        created_at: String,
    ) -> Result<()>;
}

#[async_trait]
pub trait ProviderRuntimeControl: Send + Sync {
    async fn rollback_conversation(&self, thread_id: &ThreadId, num_turns: u64) -> Result<()>;
}

#[derive(Debug, Clone)]
pub struct CheckpointReactor<R, M, P>
where
    R: ProcessRunner,
    M: CheckpointReadModel,
    P: ProviderRuntimeControl,
{
    store: CheckpointStore<R>,
    read_model: Arc<M>,
    provider: Arc<P>,
}

impl<R, M, P> CheckpointReactor<R, M, P>
where
    R: ProcessRunner,
    M: CheckpointReadModel,
    P: ProviderRuntimeControl,
{
    #[must_use]
    pub fn new(store: CheckpointStore<R>, read_model: Arc<M>, provider: Arc<P>) -> Self {
        Self {
            store,
            read_model,
            provider,
        }
    }

    pub async fn ensure_pre_turn_baseline(&self, event: RuntimeTurnStarted) -> Result<()> {
        let cwd = self
            .resolve_checkpoint_cwd(&event.thread_id, event.cwd)
            .await?;
        if !self.store.is_git_repository(&cwd).await? {
            return Ok(());
        }
        let current = self.current_turn_count(&event.thread_id).await;
        let checkpoint_ref = checkpoint_ref_for_thread_turn(&event.thread_id, current);
        if !self.store.has_checkpoint_ref(&cwd, &checkpoint_ref).await? {
            self.store
                .capture_checkpoint(CaptureCheckpointInput {
                    cwd,
                    checkpoint_ref,
                })
                .await?;
        }
        Ok(())
    }

    pub async fn capture_turn_completion(
        &self,
        event: RuntimeTurnCompleted,
    ) -> Result<CheckpointSummary> {
        let cwd = self
            .resolve_checkpoint_cwd(&event.thread_id, event.cwd)
            .await?;
        if !self.store.is_git_repository(&cwd).await? {
            return Err(CheckpointError::WorkspaceUnavailable(event.thread_id.0));
        }
        let turn_count = self.current_turn_count(&event.thread_id).await + 1;
        let from_turn_count = turn_count.saturating_sub(1);
        let from_checkpoint_ref = checkpoint_ref_for_thread_turn(&event.thread_id, from_turn_count);
        let to_checkpoint_ref = checkpoint_ref_for_thread_turn(&event.thread_id, turn_count);
        if !self
            .store
            .has_checkpoint_ref(&cwd, &from_checkpoint_ref)
            .await?
        {
            self.store
                .capture_checkpoint(CaptureCheckpointInput {
                    cwd: cwd.clone(),
                    checkpoint_ref: from_checkpoint_ref.clone(),
                })
                .await?;
        }
        self.store
            .capture_checkpoint(CaptureCheckpointInput {
                cwd: cwd.clone(),
                checkpoint_ref: to_checkpoint_ref.clone(),
            })
            .await?;
        let files = self
            .store
            .diff_checkpoint_files(DiffCheckpointsInput {
                cwd,
                from_checkpoint_ref,
                to_checkpoint_ref: to_checkpoint_ref.clone(),
                fallback_from_to_head: false,
            })
            .await?
            .into_iter()
            .map(|file| CheckpointFile {
                path: file.path,
                additions: file.additions,
                deletions: file.deletions,
            })
            .collect();
        let checkpoint = CheckpointSummary {
            thread_id: event.thread_id,
            turn_id: event.turn_id,
            checkpoint_turn_count: turn_count,
            checkpoint_ref: to_checkpoint_ref,
            status: checkpoint_status_from_runtime(&event.state),
            source: CheckpointDiffSource::GitCheckpoint,
            files,
            assistant_message_id: event.assistant_message_id,
            completed_at: event.created_at,
        };
        self.read_model
            .upsert_checkpoint(checkpoint.clone())
            .await?;
        Ok(checkpoint)
    }

    pub async fn revert_to_checkpoint(&self, request: RevertRequest) -> Result<()> {
        let read_model = self.read_model.read_model().await;
        let thread = read_model
            .threads
            .iter()
            .find(|thread| thread.id == request.thread_id)
            .ok_or_else(|| CheckpointError::ThreadNotFound(request.thread_id.0.clone()))?;
        let cwd = thread
            .worktree_path
            .as_ref()
            .map(PathBuf::from)
            .or_else(|| {
                read_model
                    .projects
                    .iter()
                    .find(|project| project.id == thread.project_id)
                    .map(|project| PathBuf::from(&project.workspace_root))
            })
            .ok_or_else(|| CheckpointError::WorkspaceUnavailable(request.thread_id.0.clone()))?;
        let current_turn_count = read_model
            .checkpoints
            .iter()
            .filter(|checkpoint| checkpoint.thread_id == request.thread_id)
            .map(|checkpoint| checkpoint.checkpoint_turn_count)
            .max()
            .unwrap_or_default();
        if request.turn_count > current_turn_count {
            return Err(CheckpointError::Unavailable {
                turn_count: request.turn_count,
            });
        }
        let target_ref = if request.turn_count == 0 {
            checkpoint_ref_for_thread_turn(&request.thread_id, 0)
        } else {
            read_model
                .checkpoints
                .iter()
                .find(|checkpoint| {
                    checkpoint.thread_id == request.thread_id
                        && checkpoint.checkpoint_turn_count == request.turn_count
                })
                .map(|checkpoint| checkpoint.checkpoint_ref.clone())
                .ok_or(CheckpointError::Unavailable {
                    turn_count: request.turn_count,
                })?
        };
        let restored = self
            .store
            .restore_checkpoint(RestoreCheckpointInput {
                cwd: cwd.clone(),
                checkpoint_ref: target_ref,
                fallback_to_head: request.turn_count == 0,
            })
            .await?;
        if !restored {
            return Err(CheckpointError::Unavailable {
                turn_count: request.turn_count,
            });
        }
        let stale_refs = read_model
            .checkpoints
            .iter()
            .filter(|checkpoint| {
                checkpoint.thread_id == request.thread_id
                    && checkpoint.checkpoint_turn_count > request.turn_count
            })
            .map(|checkpoint| checkpoint.checkpoint_ref.clone())
            .collect::<Vec<_>>();
        if !stale_refs.is_empty() {
            self.store
                .delete_checkpoint_refs(DeleteCheckpointRefsInput {
                    cwd,
                    checkpoint_refs: stale_refs,
                })
                .await?;
        }
        let rolled_back_turns = current_turn_count.saturating_sub(request.turn_count);
        if rolled_back_turns > 0 {
            self.provider
                .rollback_conversation(&request.thread_id, rolled_back_turns)
                .await?;
        }
        self.read_model
            .mark_reverted(request.thread_id, request.turn_count, now_iso())
            .await
    }

    async fn current_turn_count(&self, thread_id: &ThreadId) -> u64 {
        self.read_model
            .read_model()
            .await
            .checkpoints
            .iter()
            .filter(|checkpoint| &checkpoint.thread_id == thread_id)
            .map(|checkpoint| checkpoint.checkpoint_turn_count)
            .max()
            .unwrap_or_default()
    }

    async fn resolve_checkpoint_cwd(
        &self,
        thread_id: &ThreadId,
        runtime_cwd: Option<PathBuf>,
    ) -> Result<PathBuf> {
        if let Some(cwd) = runtime_cwd {
            return Ok(cwd);
        }
        let read_model = self.read_model.read_model().await;
        let thread = read_model
            .threads
            .iter()
            .find(|thread| &thread.id == thread_id)
            .ok_or_else(|| CheckpointError::ThreadNotFound(thread_id.0.clone()))?;
        thread
            .worktree_path
            .as_ref()
            .map(PathBuf::from)
            .or_else(|| {
                read_model
                    .projects
                    .iter()
                    .find(|project| project.id == thread.project_id)
                    .map(|project| PathBuf::from(&project.workspace_root))
            })
            .ok_or_else(|| CheckpointError::WorkspaceUnavailable(thread_id.0.clone()))
    }
}

#[derive(Debug, Default)]
pub struct MemoryCheckpointReadModel {
    inner: Mutex<ReadModel>,
}

impl MemoryCheckpointReadModel {
    #[must_use]
    pub fn new(read_model: ReadModel) -> Self {
        Self {
            inner: Mutex::new(read_model),
        }
    }

    #[must_use]
    pub fn snapshot(&self) -> ReadModel {
        self.inner.lock().expect("lock read model").clone()
    }
}

#[async_trait]
impl CheckpointReadModel for MemoryCheckpointReadModel {
    async fn read_model(&self) -> ReadModel {
        self.snapshot()
    }

    async fn upsert_checkpoint(&self, checkpoint: CheckpointSummary) -> Result<()> {
        let mut model = self.inner.lock().expect("lock read model");
        model.checkpoints.retain(|existing| {
            !(existing.thread_id == checkpoint.thread_id
                && existing.checkpoint_turn_count == checkpoint.checkpoint_turn_count)
        });
        model.checkpoints.push(checkpoint);
        model
            .checkpoints
            .sort_by_key(|checkpoint| checkpoint.checkpoint_turn_count);
        Ok(())
    }

    async fn mark_reverted(
        &self,
        thread_id: ThreadId,
        turn_count: u64,
        _created_at: String,
    ) -> Result<()> {
        let mut model = self.inner.lock().expect("lock read model");
        model.checkpoints.retain(|checkpoint| {
            checkpoint.thread_id != thread_id || checkpoint.checkpoint_turn_count <= turn_count
        });
        Ok(())
    }
}

#[derive(Debug, Default)]
pub struct RecordingProviderRuntimeControl {
    rollbacks: Mutex<Vec<(ThreadId, u64)>>,
}

impl RecordingProviderRuntimeControl {
    #[must_use]
    pub fn rollbacks(&self) -> Vec<(ThreadId, u64)> {
        self.rollbacks.lock().expect("lock rollbacks").clone()
    }
}

#[async_trait]
impl ProviderRuntimeControl for RecordingProviderRuntimeControl {
    async fn rollback_conversation(&self, thread_id: &ThreadId, num_turns: u64) -> Result<()> {
        self.rollbacks
            .lock()
            .expect("lock rollbacks")
            .push((thread_id.clone(), num_turns));
        Ok(())
    }
}

pub fn checkpoint_ref_for_thread_turn(thread_id: &ThreadId, turn_count: u64) -> CheckpointRef {
    CheckpointRef(format!(
        "{CHECKPOINT_REFS_PREFIX}/{}/turn/{turn_count}",
        URL_SAFE_NO_PAD.encode(thread_id.0.as_bytes())
    ))
}

pub fn parse_numstat(output: &str) -> Vec<CheckpointDiffFileSummary> {
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\t');
            let additions = parse_numstat_count(parts.next()?)?;
            let deletions = parse_numstat_count(parts.next()?)?;
            let path = parts.next()?.to_string();
            Some(CheckpointDiffFileSummary {
                path,
                additions,
                deletions,
            })
        })
        .collect()
}

fn parse_numstat_count(value: &str) -> Option<u64> {
    if value == "-" {
        Some(0)
    } else {
        value.parse().ok()
    }
}

fn checkpoint_status_from_runtime(state: &RuntimeTurnState) -> CheckpointStatus {
    match state {
        RuntimeTurnState::Completed => CheckpointStatus::Ready,
        RuntimeTurnState::Failed => CheckpointStatus::Error,
        RuntimeTurnState::Interrupted | RuntimeTurnState::Cancelled => CheckpointStatus::Missing,
    }
}

fn tempfile_dir() -> PathBuf {
    std::env::temp_dir().join(format!("ace-fs-checkpoint-{}", Uuid::new_v4()))
}

fn ensure_success(
    program: &str,
    output: CommandOutput,
) -> std::result::Result<CommandOutput, GitToolError> {
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

fn now_iso() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}.{:09}Z", now.as_secs(), now.subsec_nanos())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ace_core::{Project, ProjectId, Thread};
    use std::process::Command;

    fn git(cwd: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .status()
            .expect("git");
        assert!(status.success(), "git {args:?}");
    }

    fn init_repo() -> tempfile::TempDir {
        let temp = tempfile::tempdir().expect("tempdir");
        git(temp.path(), &["init"]);
        git(temp.path(), &["config", "user.email", "test@example.com"]);
        git(temp.path(), &["config", "user.name", "Test"]);
        std::fs::write(temp.path().join("README.md"), "initial\n").expect("write");
        git(temp.path(), &["add", "."]);
        git(temp.path(), &["commit", "-m", "initial"]);
        temp
    }

    #[test]
    fn checkpoint_ref_is_stable_and_url_safe() {
        assert_eq!(
            checkpoint_ref_for_thread_turn(&ThreadId("thread one".to_string()), 3).0,
            "refs/ace/checkpoints/dGhyZWFkIG9uZQ/turn/3"
        );
    }

    #[test]
    fn parses_numstat_entries() {
        assert_eq!(
            parse_numstat("2\t1\tsrc/lib.rs\n-\t-\timage.png\n"),
            vec![
                CheckpointDiffFileSummary {
                    path: "src/lib.rs".to_string(),
                    additions: 2,
                    deletions: 1
                },
                CheckpointDiffFileSummary {
                    path: "image.png".to_string(),
                    additions: 0,
                    deletions: 0
                }
            ]
        );
    }

    #[tokio::test]
    async fn captures_diffs_and_restores_checkpoints() {
        let repo = init_repo();
        let store = CheckpointStore::new();
        let thread_id = ThreadId("thread-a".to_string());
        let baseline = checkpoint_ref_for_thread_turn(&thread_id, 0);
        let next = checkpoint_ref_for_thread_turn(&thread_id, 1);
        store
            .capture_checkpoint(CaptureCheckpointInput {
                cwd: repo.path().to_path_buf(),
                checkpoint_ref: baseline.clone(),
            })
            .await
            .expect("baseline");
        std::fs::write(repo.path().join("README.md"), "changed\n").expect("write");
        store
            .capture_checkpoint(CaptureCheckpointInput {
                cwd: repo.path().to_path_buf(),
                checkpoint_ref: next.clone(),
            })
            .await
            .expect("next");
        let files = store
            .diff_checkpoint_files(DiffCheckpointsInput {
                cwd: repo.path().to_path_buf(),
                from_checkpoint_ref: baseline.clone(),
                to_checkpoint_ref: next,
                fallback_from_to_head: false,
            })
            .await
            .expect("files");
        assert_eq!(files[0].path, "README.md");
        assert!(
            store
                .restore_checkpoint(RestoreCheckpointInput {
                    cwd: repo.path().to_path_buf(),
                    checkpoint_ref: baseline,
                    fallback_to_head: false,
                })
                .await
                .expect("restore")
        );
        assert_eq!(
            std::fs::read_to_string(repo.path().join("README.md")).expect("read"),
            "initial\n"
        );
    }

    #[tokio::test]
    async fn reactor_rolls_back_provider_and_stale_checkpoints() {
        let repo = init_repo();
        let project_id = ProjectId::new();
        let thread_id = ThreadId("thread-reactor".to_string());
        let read_model = Arc::new(MemoryCheckpointReadModel::new(ReadModel {
            projects: vec![Project {
                id: project_id,
                title: "repo".to_string(),
                workspace_root: repo.path().to_string_lossy().to_string(),
                default_model_selection: None,
                scripts: Vec::new(),
                icon: None,
                created_at: "now".to_string(),
                updated_at: "now".to_string(),
                archived_at: None,
                deleted_at: None,
            }],
            threads: vec![Thread {
                id: thread_id.clone(),
                project_id,
                worktree_path: None,
                active_turn_id: None,
                deleted_at: None,
            }],
            checkpoints: Vec::new(),
        }));
        let provider = Arc::new(RecordingProviderRuntimeControl::default());
        let reactor = CheckpointReactor::new(
            CheckpointStore::new(),
            Arc::clone(&read_model),
            Arc::clone(&provider),
        );
        reactor
            .ensure_pre_turn_baseline(RuntimeTurnStarted {
                thread_id: thread_id.clone(),
                turn_id: TurnId("turn-1".to_string()),
                cwd: Some(repo.path().to_path_buf()),
                created_at: "now".to_string(),
            })
            .await
            .expect("baseline");
        std::fs::write(repo.path().join("README.md"), "turn 1\n").expect("write");
        reactor
            .capture_turn_completion(RuntimeTurnCompleted {
                thread_id: thread_id.clone(),
                turn_id: TurnId("turn-1".to_string()),
                cwd: Some(repo.path().to_path_buf()),
                state: RuntimeTurnState::Completed,
                assistant_message_id: Some(MessageId("assistant-1".to_string())),
                created_at: "later".to_string(),
            })
            .await
            .expect("capture");
        reactor
            .revert_to_checkpoint(RevertRequest {
                thread_id: thread_id.clone(),
                turn_count: 0,
            })
            .await
            .expect("revert");
        assert_eq!(provider.rollbacks(), vec![(thread_id, 1)]);
    }
}
