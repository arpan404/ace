use super::{GitApiError, service::GitApiState};
use ace_git::{ProcessRunner, TokioProcessRunner};
use ace_protocol::git::{
    GitBranchesRequest, GitCheckoutBranchRequest, GitCommitRequest, GitCreateBranchRequest,
    GitDeleteBranchRequest, GitDiffRequest, GitFetchRequest, GitPullRequest, GitPushRequest,
    GitRenameBranchRequest, GitRepositoryRequest, GitStageRequest, GitStatusRequest,
    GitUnstageRequest, GitWorktreesRequest,
};
use axum::{Json, Router, extract::State, routing::post};

pub fn router() -> Router {
    router_with_state(GitApiState::<TokioProcessRunner>::production())
}

pub fn router_with_state<R>(state: GitApiState<R>) -> Router
where
    R: ProcessRunner + 'static,
{
    Router::new()
        .route("/repository", post(repository::<R>))
        .route("/status", post(status::<R>))
        .route("/diff", post(diff::<R>))
        .route("/branches", post(branches::<R>))
        .route("/branches/create", post(create_branch::<R>))
        .route("/branches/checkout", post(checkout_branch::<R>))
        .route("/branches/rename", post(rename_branch::<R>))
        .route("/branches/delete", post(delete_branch::<R>))
        .route("/fetch", post(fetch::<R>))
        .route("/pull", post(pull::<R>))
        .route("/push", post(push::<R>))
        .route("/stage", post(stage::<R>))
        .route("/unstage", post(unstage::<R>))
        .route("/commit", post(commit::<R>))
        .route("/worktrees", post(worktrees::<R>))
        .with_state(state)
}

async fn repository<R>(
    State(state): State<GitApiState<R>>,
    Json(request): Json<GitRepositoryRequest>,
) -> Result<Json<ace_git::GitRepository>, GitApiError>
where
    R: ProcessRunner,
{
    state.service.repository(request).await.map(Json)
}

async fn status<R>(
    State(state): State<GitApiState<R>>,
    Json(request): Json<GitStatusRequest>,
) -> Result<Json<ace_git::GitStatus>, GitApiError>
where
    R: ProcessRunner,
{
    state.service.status(request).await.map(Json)
}

async fn diff<R>(
    State(state): State<GitApiState<R>>,
    Json(request): Json<GitDiffRequest>,
) -> Result<Json<super::GitDiffResponse>, GitApiError>
where
    R: ProcessRunner,
{
    state.service.diff(request).await.map(Json)
}

async fn branches<R>(
    State(state): State<GitApiState<R>>,
    Json(request): Json<GitBranchesRequest>,
) -> Result<Json<Vec<ace_git::GitBranch>>, GitApiError>
where
    R: ProcessRunner,
{
    state.service.branches(request).await.map(Json)
}

async fn create_branch<R>(
    State(state): State<GitApiState<R>>,
    Json(request): Json<GitCreateBranchRequest>,
) -> Result<Json<super::GitActionResponse>, GitApiError>
where
    R: ProcessRunner,
{
    state.service.create_branch(request).await.map(Json)
}

async fn checkout_branch<R>(
    State(state): State<GitApiState<R>>,
    Json(request): Json<GitCheckoutBranchRequest>,
) -> Result<Json<super::GitActionResponse>, GitApiError>
where
    R: ProcessRunner,
{
    state.service.checkout_branch(request).await.map(Json)
}

async fn rename_branch<R>(
    State(state): State<GitApiState<R>>,
    Json(request): Json<GitRenameBranchRequest>,
) -> Result<Json<super::GitActionResponse>, GitApiError>
where
    R: ProcessRunner,
{
    state.service.rename_branch(request).await.map(Json)
}

async fn delete_branch<R>(
    State(state): State<GitApiState<R>>,
    Json(request): Json<GitDeleteBranchRequest>,
) -> Result<Json<super::GitActionResponse>, GitApiError>
where
    R: ProcessRunner,
{
    state.service.delete_branch(request).await.map(Json)
}

async fn fetch<R>(
    State(state): State<GitApiState<R>>,
    Json(request): Json<GitFetchRequest>,
) -> Result<Json<super::GitActionResponse>, GitApiError>
where
    R: ProcessRunner,
{
    state.service.fetch(request).await.map(Json)
}

async fn pull<R>(
    State(state): State<GitApiState<R>>,
    Json(request): Json<GitPullRequest>,
) -> Result<Json<super::GitActionResponse>, GitApiError>
where
    R: ProcessRunner,
{
    state.service.pull(request).await.map(Json)
}

async fn push<R>(
    State(state): State<GitApiState<R>>,
    Json(request): Json<GitPushRequest>,
) -> Result<Json<super::GitActionResponse>, GitApiError>
where
    R: ProcessRunner,
{
    state.service.push(request).await.map(Json)
}

async fn stage<R>(
    State(state): State<GitApiState<R>>,
    Json(request): Json<GitStageRequest>,
) -> Result<Json<super::GitActionResponse>, GitApiError>
where
    R: ProcessRunner,
{
    state.service.stage(request).await.map(Json)
}

async fn unstage<R>(
    State(state): State<GitApiState<R>>,
    Json(request): Json<GitUnstageRequest>,
) -> Result<Json<super::GitActionResponse>, GitApiError>
where
    R: ProcessRunner,
{
    state.service.unstage(request).await.map(Json)
}

async fn commit<R>(
    State(state): State<GitApiState<R>>,
    Json(request): Json<GitCommitRequest>,
) -> Result<Json<super::GitActionResponse>, GitApiError>
where
    R: ProcessRunner,
{
    state.service.commit(request).await.map(Json)
}

async fn worktrees<R>(
    State(state): State<GitApiState<R>>,
    Json(request): Json<GitWorktreesRequest>,
) -> Result<Json<Vec<ace_git::GitWorktree>>, GitApiError>
where
    R: ProcessRunner,
{
    state.service.worktrees(request).await.map(Json)
}
