use super::{GitApiError, service::GitApiState};
use ace_git::{ProcessRunner, TokioProcessRunner};
use ace_protocol::git::{
    GitBranchesRequest, GitCheckoutBranchRequest, GitCreateBranchRequest, GitDiffRequest,
    GitRenameBranchRequest, GitRepositoryRequest, GitStatusRequest, GitWorktreesRequest,
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

async fn worktrees<R>(
    State(state): State<GitApiState<R>>,
    Json(request): Json<GitWorktreesRequest>,
) -> Result<Json<Vec<ace_git::GitWorktree>>, GitApiError>
where
    R: ProcessRunner,
{
    state.service.worktrees(request).await.map(Json)
}
