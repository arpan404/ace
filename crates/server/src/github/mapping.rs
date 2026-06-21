use ace_git::{
    GithubIssueListFilter, GithubPullRequestListFilter, GithubSearchFilter, WorkflowRunListFilter,
};
use ace_protocol::github::{IssueListFilter, PullRequestListFilter, SearchFilter};

pub(super) fn issue_list_filter(filter: IssueListFilter) -> GithubIssueListFilter {
    GithubIssueListFilter {
        limit: filter.limit,
        state: filter.state,
        author: filter.author,
        assignee: filter.assignee,
        mention: filter.mention,
        milestone: filter.milestone,
        search: filter.search,
        labels: filter.labels,
    }
}

pub(super) fn pull_request_list_filter(
    filter: PullRequestListFilter,
) -> GithubPullRequestListFilter {
    GithubPullRequestListFilter {
        limit: filter.limit,
        state: filter.state,
        author: filter.author,
        assignee: filter.assignee,
        base: filter.base,
        head: filter.head,
        search: filter.search,
        labels: filter.labels,
        draft_only: filter.draft_only,
    }
}

pub(super) fn search_filter(filter: SearchFilter) -> GithubSearchFilter {
    GithubSearchFilter {
        limit: filter.limit,
        state: filter.state,
        author: filter.author,
        assignee: filter.assignee,
        owner: filter.owner,
        repo: filter.repo,
        labels: filter.labels,
        sort: filter.sort,
        order: filter.order,
        include_prs_in_issue_search: filter.include_prs_in_issue_search,
    }
}

pub(super) fn workflow_run_list_filter(
    filter: ace_protocol::github::WorkflowRunListFilter,
) -> WorkflowRunListFilter {
    WorkflowRunListFilter {
        limit: filter.limit,
        branch: filter.branch,
        commit: filter.commit,
        status: filter.status,
        workflow: filter.workflow,
        event: filter.event,
        user: filter.user,
        include_disabled: filter.include_disabled,
    }
}

pub(super) fn pull_request_review_decision(
    decision: ace_protocol::github::PullRequestReviewDecision,
) -> ace_git::PullRequestReviewDecision {
    match decision {
        ace_protocol::github::PullRequestReviewDecision::Approve => {
            ace_git::PullRequestReviewDecision::Approve
        }
        ace_protocol::github::PullRequestReviewDecision::Comment => {
            ace_git::PullRequestReviewDecision::Comment
        }
        ace_protocol::github::PullRequestReviewDecision::RequestChanges => {
            ace_git::PullRequestReviewDecision::RequestChanges
        }
    }
}

pub(super) fn pull_request_merge_method(
    method: ace_protocol::github::PullRequestMergeMethod,
) -> ace_git::PullRequestMergeMethod {
    match method {
        ace_protocol::github::PullRequestMergeMethod::Merge => {
            ace_git::PullRequestMergeMethod::Merge
        }
        ace_protocol::github::PullRequestMergeMethod::Squash => {
            ace_git::PullRequestMergeMethod::Squash
        }
        ace_protocol::github::PullRequestMergeMethod::Rebase => {
            ace_git::PullRequestMergeMethod::Rebase
        }
    }
}
