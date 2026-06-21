use super::{WsApiState, WsDispatchError};
use ace_git::ProcessRunner;
use ace_protocol::{
    git::{
        GitBranchesRequest, GitCheckoutBranchRequest, GitCommitRequest, GitCreateBranchRequest,
        GitDeleteBranchRequest, GitDiffRequest, GitFetchRequest, GitPullRequest, GitPushRequest,
        GitRenameBranchRequest, GitRepositoryRequest, GitStageRequest, GitStashApplyRequest,
        GitStashDropRequest, GitStashPopRequest, GitStashSaveRequest, GitStashesRequest,
        GitStatusRequest, GitUnstageRequest, GitWorkflowRequest, GitWorktreeCreateRequest,
        GitWorktreeRemoveRequest, GitWorktreesRequest,
    },
    ws::methods,
};
use serde_json::Value;

impl<R: ProcessRunner> WsApiState<R> {
    pub(super) async fn dispatch_git_method(
        &self,
        method: &str,
        payload: Value,
    ) -> Result<Value, WsDispatchError> {
        match method {
            methods::GIT_REPOSITORY => {
                self.git_json::<GitRepositoryRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.repository(request).await },
                )
                .await
            }
            methods::GIT_STATUS => {
                self.git_json::<GitStatusRequest, _, _, _>(payload, |service, request| async move {
                    service.status(request).await
                })
                .await
            }
            methods::GIT_DIFF => {
                self.git_json::<GitDiffRequest, _, _, _>(payload, |service, request| async move {
                    service.diff(request).await
                })
                .await
            }
            methods::GIT_BRANCHES => {
                self.git_json::<GitBranchesRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.branches(request).await },
                )
                .await
            }
            methods::GIT_BRANCHES_CREATE => {
                self.git_json::<GitCreateBranchRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.create_branch(request).await },
                )
                .await
            }
            methods::GIT_BRANCHES_CHECKOUT => {
                self.git_json::<GitCheckoutBranchRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.checkout_branch(request).await },
                )
                .await
            }
            methods::GIT_BRANCHES_RENAME => {
                self.git_json::<GitRenameBranchRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.rename_branch(request).await },
                )
                .await
            }
            methods::GIT_BRANCHES_DELETE => {
                self.git_json::<GitDeleteBranchRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.delete_branch(request).await },
                )
                .await
            }
            methods::GIT_FETCH => {
                self.git_json::<GitFetchRequest, _, _, _>(payload, |service, request| async move {
                    service.fetch(request).await
                })
                .await
            }
            methods::GIT_PULL => {
                self.git_json::<GitPullRequest, _, _, _>(payload, |service, request| async move {
                    service.pull(request).await
                })
                .await
            }
            methods::GIT_PUSH => {
                self.git_json::<GitPushRequest, _, _, _>(payload, |service, request| async move {
                    service.push(request).await
                })
                .await
            }
            methods::GIT_STAGE => {
                self.git_json::<GitStageRequest, _, _, _>(payload, |service, request| async move {
                    service.stage(request).await
                })
                .await
            }
            methods::GIT_UNSTAGE => {
                self.git_json::<GitUnstageRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.unstage(request).await },
                )
                .await
            }
            methods::GIT_COMMIT => {
                self.git_json::<GitCommitRequest, _, _, _>(payload, |service, request| async move {
                    service.commit(request).await
                })
                .await
            }
            methods::GIT_STASHES => {
                self.git_json::<GitStashesRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.stashes(request).await },
                )
                .await
            }
            methods::GIT_STASHES_SAVE => {
                self.git_json::<GitStashSaveRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.save_stash(request).await },
                )
                .await
            }
            methods::GIT_STASHES_APPLY => {
                self.git_json::<GitStashApplyRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.apply_stash(request).await },
                )
                .await
            }
            methods::GIT_STASHES_POP => {
                self.git_json::<GitStashPopRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.pop_stash(request).await },
                )
                .await
            }
            methods::GIT_STASHES_DROP => {
                self.git_json::<GitStashDropRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.drop_stash(request).await },
                )
                .await
            }
            methods::GIT_WORKTREES => {
                self.git_json::<GitWorktreesRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.worktrees(request).await },
                )
                .await
            }
            methods::GIT_WORKTREES_CREATE => {
                self.git_json::<GitWorktreeCreateRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.create_worktree(request).await },
                )
                .await
            }
            methods::GIT_WORKTREES_REMOVE => {
                self.git_json::<GitWorktreeRemoveRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.remove_worktree(request).await },
                )
                .await
            }
            methods::GIT_WORKFLOW_RUN => {
                self.git_json::<GitWorkflowRequest, _, _, _>(
                    payload,
                    |service, request| async move { service.run_workflow(request).await },
                )
                .await
            }
            _ => Err(WsDispatchError::UnknownMethod(method.to_string())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{git::GitService, github::GithubService};
    use ace_git::{
        CommandOutput, CommandRequest, GitClient, GitToolError, GithubCliClient, ProcessRunner,
    };
    use ace_protocol::{
        PROTOCOL_VERSION,
        ws::{WsServerPayload, WsServerResponse},
    };
    use async_trait::async_trait;
    use std::{
        collections::VecDeque,
        sync::{Arc, Mutex},
    };

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
        async fn run(&self, request: CommandRequest) -> ace_git::Result<CommandOutput> {
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

    fn test_state(runner: Arc<FakeRunner>) -> WsApiState<FakeRunner> {
        WsApiState::new_services(
            GitService::new_with_github(
                GitClient::with_runner(runner.clone()),
                GithubCliClient::with_runner(runner.clone()),
            ),
            GithubService::new(GithubCliClient::with_runner(runner)),
        )
    }

    fn test_state_with_worktree_root(
        runner: Arc<FakeRunner>,
        worktree_root: std::path::PathBuf,
    ) -> WsApiState<FakeRunner> {
        WsApiState::new_services(
            GitService::new_with_github(
                GitClient::with_runner(runner.clone()),
                GithubCliClient::with_runner(runner.clone()),
            )
            .with_worktree_root(worktree_root),
            GithubService::new(GithubCliClient::with_runner(runner)),
        )
    }

    async fn dispatch(
        state: &WsApiState<FakeRunner>,
        request: serde_json::Value,
    ) -> WsServerResponse {
        let response = state.dispatch_text(&request.to_string()).await;
        serde_json::from_str(&response).expect("response")
    }

    #[tokio::test]
    async fn dispatches_status_diff_and_branches_over_ws_rpc() {
        let runner = Arc::new(FakeRunner::new(vec![
            ok("## feature/x...origin/feature/x [ahead 2, behind 1]\n M src/lib.rs\n"),
            ok("diff --git a/src/lib.rs b/src/lib.rs\n+hello\n"),
            ok("feature/x|*|origin/feature/x\nmain||origin/main\n"),
        ]));
        let state = test_state(runner.clone());

        let status = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-status",
                "method": methods::GIT_STATUS,
                "payload": { "repo_path": "/repo" }
            }),
        )
        .await;
        let diff = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-diff",
                "method": methods::GIT_DIFF,
                "payload": { "repo_path": "/repo" }
            }),
        )
        .await;
        let branches = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-branches",
                "method": methods::GIT_BRANCHES,
                "payload": { "repo_path": "/repo" }
            }),
        )
        .await;

        let WsServerPayload::Result { body: status } = status.payload else {
            panic!("expected status result");
        };
        let WsServerPayload::Result { body: diff } = diff.payload else {
            panic!("expected diff result");
        };
        let WsServerPayload::Result { body: branches } = branches.payload else {
            panic!("expected branches result");
        };
        assert_eq!(status["current_branch"], "feature/x");
        assert_eq!(status["ahead"], 2);
        assert!(diff["diff"].as_str().expect("diff").contains("diff --git"));
        assert_eq!(branches[0]["name"], "feature/x");
        let requests = runner.requests();
        assert_eq!(requests[0].args, vec!["status", "--porcelain=v1", "-b"]);
        assert_eq!(requests[1].args, vec!["diff"]);
        assert_eq!(
            requests[2].args,
            vec![
                "branch",
                "--format=%(refname:short)|%(HEAD)|%(upstream:short)"
            ]
        );
    }

    #[tokio::test]
    async fn dispatches_branch_and_remote_actions_over_ws_rpc() {
        let runner = Arc::new(FakeRunner::new(vec![
            ok(""),
            ok(""),
            ok(""),
            ok(""),
            ok(""),
            ok("feature/y\n"),
            ok(""),
        ]));
        let state = test_state(runner.clone());

        for (request_id, method, payload) in [
            (
                "req-create",
                methods::GIT_BRANCHES_CREATE,
                serde_json::json!({
                    "repo_path": "/repo",
                    "branch": "feature/x",
                    "start_point": "main"
                }),
            ),
            (
                "req-checkout",
                methods::GIT_BRANCHES_CHECKOUT,
                serde_json::json!({
                    "repo_path": "/repo",
                    "branch": "feature/x"
                }),
            ),
            (
                "req-rename",
                methods::GIT_BRANCHES_RENAME,
                serde_json::json!({
                    "repo_path": "/repo",
                    "old": "feature/x",
                    "new": "feature/y"
                }),
            ),
            (
                "req-delete",
                methods::GIT_BRANCHES_DELETE,
                serde_json::json!({
                    "repo_path": "/repo",
                    "branch": "feature/y",
                    "force": true
                }),
            ),
            (
                "req-fetch",
                methods::GIT_FETCH,
                serde_json::json!({
                    "repo_path": "/repo",
                    "prune": true
                }),
            ),
            (
                "req-push",
                methods::GIT_PUSH,
                serde_json::json!({
                    "repo_path": "/repo",
                    "set_upstream": true
                }),
            ),
        ] {
            let response = dispatch(
                &state,
                serde_json::json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": request_id,
                    "method": method,
                    "payload": payload
                }),
            )
            .await;
            assert!(
                matches!(response.payload, WsServerPayload::Result { .. }),
                "{response:?}"
            );
        }

        let requests = runner.requests();
        assert_eq!(requests[0].args, vec!["branch", "feature/x", "main"]);
        assert_eq!(requests[1].args, vec!["checkout", "feature/x"]);
        assert_eq!(
            requests[2].args,
            vec!["branch", "-m", "feature/x", "feature/y"]
        );
        assert_eq!(requests[3].args, vec!["branch", "-D", "feature/y"]);
        assert_eq!(requests[4].args, vec!["fetch", "--prune"]);
        assert_eq!(requests[5].args, vec!["branch", "--show-current"]);
        assert_eq!(requests[6].args, vec!["push", "-u", "origin", "feature/y"]);
    }

    #[tokio::test]
    async fn dispatches_stage_commit_stash_and_worktree_over_ws_rpc() {
        let runner = Arc::new(FakeRunner::new(vec![
            ok(""),
            ok(""),
            ok(""),
            ok(""),
            ok("stash@{0}\0WIP on feature/x: wip\n"),
            ok(""),
            ok("worktree /repo\nHEAD abc\nbranch refs/heads/main\n\n"),
        ]));
        let state = test_state(runner.clone());

        for (request_id, method, payload) in [
            (
                "req-stage",
                methods::GIT_STAGE,
                serde_json::json!({
                    "repo_path": "/repo",
                    "paths": ["src/lib.rs"],
                    "all": false
                }),
            ),
            (
                "req-unstage",
                methods::GIT_UNSTAGE,
                serde_json::json!({
                    "repo_path": "/repo",
                    "paths": [],
                    "all": true
                }),
            ),
            (
                "req-commit",
                methods::GIT_COMMIT,
                serde_json::json!({
                    "repo_path": "/repo",
                    "message": "update git ws"
                }),
            ),
            (
                "req-stash-save",
                methods::GIT_STASHES_SAVE,
                serde_json::json!({
                    "repo_path": "/repo",
                    "message": "wip",
                    "include_untracked": true
                }),
            ),
            (
                "req-stashes",
                methods::GIT_STASHES,
                serde_json::json!({
                    "repo_path": "/repo"
                }),
            ),
            (
                "req-stash-pop",
                methods::GIT_STASHES_POP,
                serde_json::json!({
                    "repo_path": "/repo",
                    "selector": "stash@{0}",
                    "index": true
                }),
            ),
            (
                "req-worktrees",
                methods::GIT_WORKTREES,
                serde_json::json!({
                    "repo_path": "/repo"
                }),
            ),
        ] {
            let response = dispatch(
                &state,
                serde_json::json!({
                    "version": PROTOCOL_VERSION,
                    "request_id": request_id,
                    "method": method,
                    "payload": payload
                }),
            )
            .await;
            assert!(
                matches!(response.payload, WsServerPayload::Result { .. }),
                "{response:?}"
            );
        }

        let requests = runner.requests();
        assert_eq!(requests[0].args, vec!["add", "--", "src/lib.rs"]);
        assert_eq!(requests[1].args, vec!["restore", "--staged", "--", "."]);
        assert_eq!(requests[2].args, vec!["commit", "-m", "update git ws"]);
        assert_eq!(
            requests[3].args,
            vec!["stash", "push", "--include-untracked", "--message", "wip"]
        );
        assert_eq!(
            requests[4].args,
            vec!["stash", "list", "--format=%gd%x00%gs"]
        );
        assert_eq!(
            requests[5].args,
            vec!["stash", "pop", "--index", "stash@{0}"]
        );
        assert_eq!(requests[6].args, vec!["worktree", "list", "--porcelain"]);
    }

    #[tokio::test]
    async fn dispatches_worktree_create_and_remove_over_ws_rpc() {
        let temp = tempfile::tempdir().expect("tempdir");
        let worktree_root = temp.path().join("worktrees");
        let runner = Arc::new(FakeRunner::new(vec![
            ok("main||origin/main\nfeature/task||\n"),
            ok("/repo\n"),
            ok("true\n"),
            ok(""),
            ok("## feature/task-2\n"),
            ok("/repo\n"),
            ok("true\n"),
            ok(""),
        ]));
        let state = test_state_with_worktree_root(runner.clone(), worktree_root.clone());

        let create_response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-worktree-create",
                "method": methods::GIT_WORKTREES_CREATE,
                "payload": {
                    "repo_path": "/repo",
                    "preferred_branch": "feature/task",
                    "start_point": "main"
                }
            }),
        )
        .await;
        let WsServerPayload::Result { body: created } = create_response.payload else {
            panic!("expected create result");
        };
        let created_path = created["path"].as_str().expect("created path").to_string();
        assert_eq!(created["branch"], "feature/task-2");
        assert!(created_path.starts_with(worktree_root.to_string_lossy().as_ref()));

        let remove_response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-worktree-remove",
                "method": methods::GIT_WORKTREES_REMOVE,
                "payload": {
                    "repo_path": "/repo",
                    "path": created_path,
                    "force": true
                }
            }),
        )
        .await;
        let WsServerPayload::Result { body: removed } = remove_response.payload else {
            panic!("expected remove result");
        };
        assert_eq!(removed["removed"], true);

        let requests = runner.requests();
        assert_eq!(
            requests[0].args,
            vec![
                "branch",
                "--format=%(refname:short)|%(HEAD)|%(upstream:short)"
            ]
        );
        assert_eq!(
            requests[3].args[0..4],
            ["worktree", "add", "-b", "feature/task-2"]
        );
        assert_eq!(requests[7].args[0..3], ["worktree", "remove", "--force"]);
    }

    #[tokio::test]
    async fn worktree_remove_rejects_paths_outside_app_root_over_ws_rpc() {
        let temp = tempfile::tempdir().expect("tempdir");
        let runner = Arc::new(FakeRunner::new(Vec::new()));
        let state = test_state_with_worktree_root(runner.clone(), temp.path().join("worktrees"));

        let response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-worktree-remove-unsafe",
                "method": methods::GIT_WORKTREES_REMOVE,
                "payload": {
                    "repo_path": "/repo",
                    "path": temp.path().join("outside").to_string_lossy(),
                    "force": false
                }
            }),
        )
        .await;

        let WsServerPayload::Error { code, message } = response.payload else {
            panic!("expected error");
        };
        assert_eq!(code, "git_error");
        assert!(message.contains("unsafe worktree path"));
        assert!(runner.requests().is_empty());
    }

    #[tokio::test]
    async fn dispatches_stacked_workflow_over_ws_rpc() {
        let runner = Arc::new(FakeRunner::new(vec![
            ok("feature/work\n"),
            ok("main\n"),
            ok("[feature/work abc] ship it\n"),
            ok("feature/work\n"),
            ok(""),
            ok("https://github.com/ace/app/pull/42\n"),
        ]));
        let state = test_state(runner.clone());

        let response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-workflow",
                "method": methods::GIT_WORKFLOW_RUN,
                "payload": {
                    "repo_path": "/repo",
                    "action": {
                        "type": "commit_push_pr",
                        "message": "ship it",
                        "set_upstream": false,
                        "request": {
                            "title": "Ship it",
                            "body": "Body",
                            "head": "feature/work",
                            "base": "main",
                            "draft": false
                        },
                        "default_branch_policy": "Deny"
                    }
                }
            }),
        )
        .await;

        let WsServerPayload::Result { body } = response.payload else {
            panic!("expected workflow result");
        };
        assert_eq!(body["pr"]["number"], 42);
        assert_eq!(
            body["events"],
            serde_json::json!([
                "Validating",
                "Committing",
                "Pushing",
                "CreatingPullRequest",
                "Completed"
            ])
        );
        let requests = runner.requests();
        assert_eq!(requests[0].args, vec!["branch", "--show-current"]);
        assert_eq!(
            requests[1].args,
            vec!["symbolic-ref", "refs/remotes/origin/HEAD", "--short"]
        );
        assert_eq!(requests[2].args, vec!["commit", "-m", "ship it"]);
        assert_eq!(requests[3].args, vec!["branch", "--show-current"]);
        assert_eq!(requests[4].args, vec!["push"]);
        assert_eq!(requests[5].args[0..2], ["pr", "create"]);
    }

    #[tokio::test]
    async fn stacked_workflow_denies_default_branch_push_over_ws_rpc() {
        let runner = Arc::new(FakeRunner::new(vec![ok("main\n"), ok("main\n")]));
        let state = test_state(runner.clone());

        let response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-workflow-denied",
                "method": methods::GIT_WORKFLOW_RUN,
                "payload": {
                    "repo_path": "/repo",
                    "action": {
                        "type": "push",
                        "set_upstream": false,
                        "default_branch_policy": "Deny"
                    }
                }
            }),
        )
        .await;

        let WsServerPayload::Error { code, message } = response.payload else {
            panic!("expected denied workflow error");
        };
        assert_eq!(code, "git_error");
        assert!(message.contains("default branch"));
        assert_eq!(runner.requests().len(), 2);
    }

    #[tokio::test]
    async fn returns_git_ws_error_for_invalid_payload() {
        let state = test_state(Arc::new(FakeRunner::new(Vec::new())));

        let response = dispatch(
            &state,
            serde_json::json!({
                "version": PROTOCOL_VERSION,
                "request_id": "req-invalid-git",
                "method": methods::GIT_STATUS,
                "payload": {}
            }),
        )
        .await;

        let WsServerPayload::Error { code, .. } = response.payload else {
            panic!("expected error");
        };
        assert_eq!(code, "invalid_payload");
    }
}
