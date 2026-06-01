# GitHub Triage And Protection

This repository uses rule-based GitHub Actions labels for issues and pull requests.

## Pull Request Labels

- `size:*` is applied by `.github/workflows/pr-size.yml`.
- `area:*`, `author:*`, `status:*`, `risk:*`, `dependencies`, `docs-only`, and `tests-only` are applied by `.github/workflows/pr-labels.yml`.
- `status:approved`, `status:changes-requested`, and `status:needs-review` are synchronized by `.github/workflows/pr-review-state.yml`.
- `status:needs-response` is synchronized by `.github/workflows/issue-response.yml`.
- `status:stale` is applied by `.github/workflows/stale.yml`.

## Branch Protection

Configure this in GitHub repository settings for the default branch:

- Require a pull request before merging.
- Require at least 1 approving review.
- Require review from Code Owners.
- Dismiss stale pull request approvals when new commits are pushed.
- Require status checks to pass before merging.
- Require branches to be up to date before merging.
- Require conversation resolution before merging.
- Restrict force pushes and branch deletions.

Recommended required checks:

- `CI`
- `PR Size`
- `PR Labels`
- `PR Review State`

## Action Approval

Configure Actions security in GitHub repository settings:

- Set workflow permissions to "Read and write permissions" so label workflows can call the Issues API.
- Require approval for first-time contributors before running workflows.
- Keep `pull_request_target` workflows limited to GitHub API reads/writes and avoid checking out or executing untrusted PR code.

## Dependency Updates

`.github/dependabot.yml` enables weekly Bun and GitHub Actions update PRs with conservative open PR limits and dependency labels.

## Code Owners

`.github/CODEOWNERS` routes high-risk protocol, provider runtime, CI, release, and desktop changes to the repository owner.
