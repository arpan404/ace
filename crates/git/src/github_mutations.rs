use crate::{GithubCliClient, ProcessRunner, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::Path;

impl<R: ProcessRunner> GithubCliClient<R> {
    pub async fn checkout_pull_request(
        &self,
        cwd: &Path,
        request: &PullRequestCheckout,
    ) -> Result<GithubActionResult> {
        let mut args = vec![
            "pr".to_string(),
            "checkout".to_string(),
            request.selector.clone(),
        ];
        if let Some(branch) = &request.branch {
            args.extend(["--branch".to_string(), branch.clone()]);
        }
        if request.detach {
            args.push("--detach".to_string());
        }
        if request.force {
            args.push("--force".to_string());
        }
        if request.recurse_submodules {
            args.push("--recurse-submodules".to_string());
        }
        self.run_action(cwd, "checkout_pull_request", args).await
    }

    pub async fn comment_pull_request(
        &self,
        cwd: &Path,
        request: &PullRequestComment,
    ) -> Result<GithubActionResult> {
        let args = vec![
            "pr".to_string(),
            "comment".to_string(),
            request.selector.clone(),
            "--body".to_string(),
            request.body.clone(),
        ];
        self.run_action(cwd, "comment_pull_request", args).await
    }

    pub async fn review_pull_request(
        &self,
        cwd: &Path,
        request: &PullRequestReview,
    ) -> Result<GithubActionResult> {
        let mut args = vec![
            "pr".to_string(),
            "review".to_string(),
            request.selector.clone(),
        ];
        match request.decision {
            PullRequestReviewDecision::Approve => args.push("--approve".to_string()),
            PullRequestReviewDecision::Comment => args.push("--comment".to_string()),
            PullRequestReviewDecision::RequestChanges => args.push("--request-changes".to_string()),
        }
        if let Some(body) = &request.body {
            args.extend(["--body".to_string(), body.clone()]);
        }
        self.run_action(cwd, "review_pull_request", args).await
    }

    pub async fn set_pull_request_ready_state(
        &self,
        cwd: &Path,
        request: &PullRequestReadyState,
    ) -> Result<GithubActionResult> {
        let mut args = vec![
            "pr".to_string(),
            "ready".to_string(),
            request.selector.clone(),
        ];
        if request.draft {
            args.push("--undo".to_string());
        }
        self.run_action(cwd, "set_pull_request_ready_state", args)
            .await
    }

    pub async fn close_pull_request(
        &self,
        cwd: &Path,
        request: &PullRequestClose,
    ) -> Result<GithubActionResult> {
        let mut args = vec![
            "pr".to_string(),
            "close".to_string(),
            request.selector.clone(),
        ];
        if let Some(comment) = &request.comment {
            args.extend(["--comment".to_string(), comment.clone()]);
        }
        if request.delete_branch {
            args.push("--delete-branch".to_string());
        }
        self.run_action(cwd, "close_pull_request", args).await
    }

    pub async fn reopen_pull_request(
        &self,
        cwd: &Path,
        request: &PullRequestReopen,
    ) -> Result<GithubActionResult> {
        let mut args = vec![
            "pr".to_string(),
            "reopen".to_string(),
            request.selector.clone(),
        ];
        if let Some(comment) = &request.comment {
            args.extend(["--comment".to_string(), comment.clone()]);
        }
        self.run_action(cwd, "reopen_pull_request", args).await
    }

    pub async fn merge_pull_request(
        &self,
        cwd: &Path,
        request: &PullRequestMerge,
    ) -> Result<GithubActionResult> {
        let mut args = vec![
            "pr".to_string(),
            "merge".to_string(),
            request.selector.clone(),
        ];
        match request.method {
            PullRequestMergeMethod::Merge => args.push("--merge".to_string()),
            PullRequestMergeMethod::Squash => args.push("--squash".to_string()),
            PullRequestMergeMethod::Rebase => args.push("--rebase".to_string()),
        }
        if request.auto {
            args.push("--auto".to_string());
        }
        if request.admin {
            args.push("--admin".to_string());
        }
        if request.delete_branch {
            args.push("--delete-branch".to_string());
        }
        if request.disable_auto {
            args.push("--disable-auto".to_string());
        }
        if let Some(subject) = &request.subject {
            args.extend(["--subject".to_string(), subject.clone()]);
        }
        if let Some(body) = &request.body {
            args.extend(["--body".to_string(), body.clone()]);
        }
        if let Some(author_email) = &request.author_email {
            args.extend(["--author-email".to_string(), author_email.clone()]);
        }
        if let Some(match_head_commit) = &request.match_head_commit {
            args.extend(["--match-head-commit".to_string(), match_head_commit.clone()]);
        }
        self.run_action(cwd, "merge_pull_request", args).await
    }

    pub async fn rerun_workflow_run(
        &self,
        cwd: &Path,
        request: &WorkflowRunRerun,
    ) -> Result<GithubActionResult> {
        let mut args = vec![
            "run".to_string(),
            "rerun".to_string(),
            request.run_id.to_string(),
        ];
        if request.failed_only {
            args.push("--failed".to_string());
        }
        if request.debug {
            args.push("--debug".to_string());
        }
        if let Some(job_id) = request.job_id {
            args.extend(["--job".to_string(), job_id.to_string()]);
        }
        self.run_action(cwd, "rerun_workflow_run", args).await
    }

    pub async fn cancel_workflow_run(
        &self,
        cwd: &Path,
        request: &WorkflowRunCancel,
    ) -> Result<GithubActionResult> {
        self.run_action(
            cwd,
            "cancel_workflow_run",
            vec![
                "run".to_string(),
                "cancel".to_string(),
                request.run_id.to_string(),
            ],
        )
        .await
    }

    pub async fn force_cancel_workflow_run(
        &self,
        cwd: &Path,
        request: &WorkflowRunForceCancel,
    ) -> Result<GithubActionResult> {
        let repository = self.repository(cwd).await?;
        let output = self
            .gh_allow_statuses(
                cwd,
                [
                    "api".to_string(),
                    format!(
                        "repos/{}/actions/runs/{}/force-cancel",
                        repository.name_with_owner, request.run_id
                    ),
                    "-X".to_string(),
                    "POST".to_string(),
                ],
                &[0],
            )
            .await?;
        Ok(GithubActionResult {
            action: "force_cancel_workflow_run",
            stdout: output.stdout_string(),
            stderr: output.stderr_string(),
        })
    }

    pub async fn approve_workflow_run(
        &self,
        cwd: &Path,
        request: &WorkflowRunApprove,
    ) -> Result<GithubActionResult> {
        let repository = self.repository(cwd).await?;
        let output = self
            .gh_allow_statuses(
                cwd,
                [
                    "api".to_string(),
                    format!(
                        "repos/{}/actions/runs/{}/approve",
                        repository.name_with_owner, request.run_id
                    ),
                    "-X".to_string(),
                    "POST".to_string(),
                ],
                &[0],
            )
            .await?;
        Ok(GithubActionResult {
            action: "approve_workflow_run",
            stdout: output.stdout_string(),
            stderr: output.stderr_string(),
        })
    }

    pub async fn review_workflow_run_pending_deployments(
        &self,
        cwd: &Path,
        request: &WorkflowRunPendingDeploymentReview,
    ) -> Result<GithubActionResult> {
        let repository = self.repository(cwd).await?;
        let output = self
            .gh_with_stdin_allow_statuses(
                cwd,
                [
                    "api".to_string(),
                    format!(
                        "repos/{}/actions/runs/{}/pending_deployments",
                        repository.name_with_owner, request.run_id
                    ),
                    "-X".to_string(),
                    "POST".to_string(),
                    "--input".to_string(),
                    "-".to_string(),
                ],
                json!({
                    "environment_ids": request.environment_ids,
                    "state": request.state.as_api_value(),
                    "comment": request.comment,
                })
                .to_string(),
                &[0],
            )
            .await?;
        Ok(GithubActionResult {
            action: "review_workflow_pending_deployments",
            stdout: output.stdout_string(),
            stderr: output.stderr_string(),
        })
    }

    pub async fn dispatch_workflow(
        &self,
        cwd: &Path,
        request: &WorkflowDispatch,
    ) -> Result<GithubActionResult> {
        let mut args = vec![
            "workflow".to_string(),
            "run".to_string(),
            request.workflow.clone(),
        ];
        if let Some(ref_name) = &request.ref_name {
            args.extend(["--ref".to_string(), ref_name.clone()]);
        }
        for input in &request.inputs {
            args.extend([
                "--raw-field".to_string(),
                format!("{}={}", input.name, input.value),
            ]);
        }
        self.run_action(cwd, "dispatch_workflow", args).await
    }

    pub async fn enable_workflow(
        &self,
        cwd: &Path,
        request: &WorkflowStateChange,
    ) -> Result<GithubActionResult> {
        self.run_action(
            cwd,
            "enable_workflow",
            vec![
                "workflow".to_string(),
                "enable".to_string(),
                request.workflow.clone(),
            ],
        )
        .await
    }

    pub async fn disable_workflow(
        &self,
        cwd: &Path,
        request: &WorkflowStateChange,
    ) -> Result<GithubActionResult> {
        self.run_action(
            cwd,
            "disable_workflow",
            vec![
                "workflow".to_string(),
                "disable".to_string(),
                request.workflow.clone(),
            ],
        )
        .await
    }

    async fn run_action(
        &self,
        cwd: &Path,
        action: &'static str,
        args: Vec<String>,
    ) -> Result<GithubActionResult> {
        let output = self.gh_allow_statuses(cwd, args, &[0]).await?;
        Ok(GithubActionResult {
            action,
            stdout: output.stdout_string(),
            stderr: output.stderr_string(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubActionResult {
    pub action: &'static str,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestCheckout {
    pub selector: String,
    pub branch: Option<String>,
    pub detach: bool,
    pub force: bool,
    pub recurse_submodules: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestComment {
    pub selector: String,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestReview {
    pub selector: String,
    pub decision: PullRequestReviewDecision,
    pub body: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PullRequestReviewDecision {
    Approve,
    Comment,
    RequestChanges,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestReadyState {
    pub selector: String,
    pub draft: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestClose {
    pub selector: String,
    pub comment: Option<String>,
    pub delete_branch: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestReopen {
    pub selector: String,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestMerge {
    pub selector: String,
    pub method: PullRequestMergeMethod,
    pub auto: bool,
    pub admin: bool,
    pub delete_branch: bool,
    pub disable_auto: bool,
    pub subject: Option<String>,
    pub body: Option<String>,
    pub author_email: Option<String>,
    pub match_head_commit: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PullRequestMergeMethod {
    Merge,
    Squash,
    Rebase,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowRunRerun {
    pub run_id: u64,
    pub failed_only: bool,
    pub debug: bool,
    pub job_id: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowRunCancel {
    pub run_id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowRunForceCancel {
    pub run_id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowRunApprove {
    pub run_id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowRunPendingDeploymentReview {
    pub run_id: u64,
    pub environment_ids: Vec<u64>,
    pub state: WorkflowRunPendingDeploymentReviewState,
    pub comment: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WorkflowRunPendingDeploymentReviewState {
    Approve,
    Reject,
}

impl WorkflowRunPendingDeploymentReviewState {
    const fn as_api_value(self) -> &'static str {
        match self {
            Self::Approve => "approved",
            Self::Reject => "rejected",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowDispatch {
    pub workflow: String,
    pub ref_name: Option<String>,
    pub inputs: Vec<WorkflowDispatchInput>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowDispatchInput {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowStateChange {
    pub workflow: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CommandOutput, CommandRequest, GitToolError};
    use async_trait::async_trait;
    use std::{collections::VecDeque, path::Path, sync::Mutex};

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
    impl crate::ProcessRunner for FakeRunner {
        async fn run(&self, request: CommandRequest) -> crate::Result<CommandOutput> {
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

    #[tokio::test]
    async fn checkout_pull_request_builds_command() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![ok("checked out\n")]));
        let github = GithubCliClient::with_runner(runner.clone());

        let result = github
            .checkout_pull_request(
                Path::new("."),
                &PullRequestCheckout {
                    selector: "42".to_string(),
                    branch: Some("review/42".to_string()),
                    detach: false,
                    force: true,
                    recurse_submodules: true,
                },
            )
            .await
            .expect("checkout");

        assert_eq!(result.action, "checkout_pull_request");
        assert_eq!(
            runner.requests()[0].args,
            vec![
                "pr",
                "checkout",
                "42",
                "--branch",
                "review/42",
                "--force",
                "--recurse-submodules"
            ]
        );
    }

    #[tokio::test]
    async fn review_pull_request_builds_request_changes_command() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![ok("")]));
        let github = GithubCliClient::with_runner(runner.clone());

        github
            .review_pull_request(
                Path::new("."),
                &PullRequestReview {
                    selector: "42".to_string(),
                    decision: PullRequestReviewDecision::RequestChanges,
                    body: Some("needs tests".to_string()),
                },
            )
            .await
            .expect("review");

        assert_eq!(
            runner.requests()[0].args,
            vec![
                "pr",
                "review",
                "42",
                "--request-changes",
                "--body",
                "needs tests"
            ]
        );
    }

    #[tokio::test]
    async fn merge_pull_request_builds_full_command() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![ok("merged\n")]));
        let github = GithubCliClient::with_runner(runner.clone());

        github
            .merge_pull_request(
                Path::new("."),
                &PullRequestMerge {
                    selector: "42".to_string(),
                    method: PullRequestMergeMethod::Squash,
                    auto: true,
                    admin: false,
                    delete_branch: true,
                    disable_auto: false,
                    subject: Some("Ship feature".to_string()),
                    body: Some("Body".to_string()),
                    author_email: Some("ace@example.test".to_string()),
                    match_head_commit: Some("abc123".to_string()),
                },
            )
            .await
            .expect("merge");

        assert_eq!(
            runner.requests()[0].args,
            vec![
                "pr",
                "merge",
                "42",
                "--squash",
                "--auto",
                "--delete-branch",
                "--subject",
                "Ship feature",
                "--body",
                "Body",
                "--author-email",
                "ace@example.test",
                "--match-head-commit",
                "abc123"
            ]
        );
    }

    #[tokio::test]
    async fn close_and_reopen_pull_request_build_commands() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![ok(""), ok("")]));
        let github = GithubCliClient::with_runner(runner.clone());

        github
            .close_pull_request(
                Path::new("."),
                &PullRequestClose {
                    selector: "42".to_string(),
                    comment: Some("closing".to_string()),
                    delete_branch: true,
                },
            )
            .await
            .expect("close");
        github
            .reopen_pull_request(
                Path::new("."),
                &PullRequestReopen {
                    selector: "42".to_string(),
                    comment: Some("reopening".to_string()),
                },
            )
            .await
            .expect("reopen");

        let requests = runner.requests();
        assert_eq!(
            requests[0].args,
            vec![
                "pr",
                "close",
                "42",
                "--comment",
                "closing",
                "--delete-branch"
            ]
        );
        assert_eq!(
            requests[1].args,
            vec!["pr", "reopen", "42", "--comment", "reopening"]
        );
    }

    #[tokio::test]
    async fn ready_state_comment_and_workflow_actions_build_commands() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![ok(""), ok(""), ok(""), ok("")]));
        let github = GithubCliClient::with_runner(runner.clone());

        github
            .set_pull_request_ready_state(
                Path::new("."),
                &PullRequestReadyState {
                    selector: "42".to_string(),
                    draft: true,
                },
            )
            .await
            .expect("draft");
        github
            .comment_pull_request(
                Path::new("."),
                &PullRequestComment {
                    selector: "42".to_string(),
                    body: "Looks good".to_string(),
                },
            )
            .await
            .expect("comment");
        github
            .rerun_workflow_run(
                Path::new("."),
                &WorkflowRunRerun {
                    run_id: 100,
                    failed_only: true,
                    debug: true,
                    job_id: Some(200),
                },
            )
            .await
            .expect("rerun");
        github
            .cancel_workflow_run(Path::new("."), &WorkflowRunCancel { run_id: 100 })
            .await
            .expect("cancel");

        let requests = runner.requests();
        assert_eq!(requests[0].args, vec!["pr", "ready", "42", "--undo"]);
        assert_eq!(
            requests[1].args,
            vec!["pr", "comment", "42", "--body", "Looks good"]
        );
        assert_eq!(
            requests[2].args,
            vec!["run", "rerun", "100", "--failed", "--debug", "--job", "200"]
        );
        assert_eq!(requests[3].args, vec!["run", "cancel", "100"]);
    }

    #[tokio::test]
    async fn approve_workflow_run_resolves_repo_and_posts_endpoint() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![
            ok(
                br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
            ),
            ok("approved\n"),
        ]));
        let github = GithubCliClient::with_runner(runner.clone());

        let result = github
            .approve_workflow_run(Path::new("."), &WorkflowRunApprove { run_id: 100 })
            .await
            .expect("approve");

        assert_eq!(result.action, "approve_workflow_run");
        assert_eq!(result.stdout, "approved");
        assert_eq!(
            runner.requests()[1].args,
            vec![
                "api",
                "repos/ace/app/actions/runs/100/approve",
                "-X",
                "POST"
            ]
        );
    }

    #[tokio::test]
    async fn force_cancel_workflow_run_resolves_repo_and_posts_endpoint() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![
            ok(
                br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
            ),
            ok("force cancelled\n"),
        ]));
        let github = GithubCliClient::with_runner(runner.clone());

        let result = github
            .force_cancel_workflow_run(Path::new("."), &WorkflowRunForceCancel { run_id: 100 })
            .await
            .expect("force cancel");

        assert_eq!(result.action, "force_cancel_workflow_run");
        assert_eq!(result.stdout, "force cancelled");
        assert_eq!(
            runner.requests()[1].args,
            vec![
                "api",
                "repos/ace/app/actions/runs/100/force-cancel",
                "-X",
                "POST"
            ]
        );
    }

    #[tokio::test]
    async fn review_pending_deployments_posts_review_body() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![
            ok(
                br#"{"nameWithOwner":"ace/app","defaultBranchRef":{"name":"main"},"url":"https://github.com/ace/app","sshUrl":"git@github.com:ace/app.git"}"#,
            ),
            ok("reviewed\n"),
        ]));
        let github = GithubCliClient::with_runner(runner.clone());

        let result = github
            .review_workflow_run_pending_deployments(
                Path::new("."),
                &WorkflowRunPendingDeploymentReview {
                    run_id: 100,
                    environment_ids: vec![9, 10],
                    state: WorkflowRunPendingDeploymentReviewState::Reject,
                    comment: "Needs manual verification".to_string(),
                },
            )
            .await
            .expect("review pending deployments");

        assert_eq!(result.action, "review_workflow_pending_deployments");
        assert_eq!(result.stdout, "reviewed");
        let requests = runner.requests();
        assert_eq!(
            requests[1].args,
            vec![
                "api",
                "repos/ace/app/actions/runs/100/pending_deployments",
                "-X",
                "POST",
                "--input",
                "-"
            ]
        );
        let stdin = requests[1].stdin.as_deref().expect("stdin body");
        let body: serde_json::Value = serde_json::from_slice(stdin).expect("json body");
        assert_eq!(body["environment_ids"], serde_json::json!([9, 10]));
        assert_eq!(body["state"], "rejected");
        assert_eq!(body["comment"], "Needs manual verification");
    }

    #[tokio::test]
    async fn dispatch_workflow_builds_command_with_ref_and_inputs() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![ok("queued\n")]));
        let github = GithubCliClient::with_runner(runner.clone());

        let result = github
            .dispatch_workflow(
                Path::new("."),
                &WorkflowDispatch {
                    workflow: "ci.yml".to_string(),
                    ref_name: Some("feature/x".to_string()),
                    inputs: vec![
                        WorkflowDispatchInput {
                            name: "suite".to_string(),
                            value: "linux".to_string(),
                        },
                        WorkflowDispatchInput {
                            name: "retries".to_string(),
                            value: "2".to_string(),
                        },
                    ],
                },
            )
            .await
            .expect("dispatch");

        assert_eq!(result.action, "dispatch_workflow");
        assert_eq!(result.stdout, "queued");
        assert_eq!(
            runner.requests()[0].args,
            vec![
                "workflow",
                "run",
                "ci.yml",
                "--ref",
                "feature/x",
                "--raw-field",
                "suite=linux",
                "--raw-field",
                "retries=2"
            ]
        );
    }

    #[tokio::test]
    async fn workflow_state_actions_build_commands() {
        let runner = std::sync::Arc::new(FakeRunner::new(vec![ok("enabled\n"), ok("disabled\n")]));
        let github = GithubCliClient::with_runner(runner.clone());

        let enabled = github
            .enable_workflow(
                Path::new("."),
                &WorkflowStateChange {
                    workflow: "ci.yml".to_string(),
                },
            )
            .await
            .expect("enable");
        let disabled = github
            .disable_workflow(
                Path::new("."),
                &WorkflowStateChange {
                    workflow: "ci.yml".to_string(),
                },
            )
            .await
            .expect("disable");

        assert_eq!(enabled.action, "enable_workflow");
        assert_eq!(enabled.stdout, "enabled");
        assert_eq!(disabled.action, "disable_workflow");
        assert_eq!(disabled.stdout, "disabled");
        let requests = runner.requests();
        assert_eq!(requests[0].args, vec!["workflow", "enable", "ci.yml"]);
        assert_eq!(requests[1].args, vec!["workflow", "disable", "ci.yml"]);
    }
}
