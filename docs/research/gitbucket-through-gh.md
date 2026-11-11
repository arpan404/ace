# GitBucket through `gh`

Question: can ace support GitBucket through the user's own GitHub CLI, without ace ever
handling a token (ADR 0002)?

**Verdict: it works, with limits.** `gh api --hostname <host>` is a usable REST transport to
GitBucket, and ace's existing identity probe (`gh api user`) works unchanged. Three limits:

1. `gh auth login` cannot sign in to GitBucket. It reads the login over GraphQL, and GitBucket has
   no GraphQL. The user can still store the token themselves with a `gh config set` workaround
   (below), but gh warns that the key is unknown, so this path may break in a future gh.
2. gh only speaks HTTPS to non-github.com hosts and takes no port in `gh auth login`. GitBucket must
   be served over HTTPS on 443 with a certificate the machine trusts.
3. GitBucket's API covers about half of what ace's review and issue features need. There are no
   PR file lists, review comments, approvals, close/reopen for issues, pagination headers, or a
   head-pinned merge.

An adapter is viable as a reduced-capability REST adapter shaped like the Gitea one
(`tea-*.ts`), not as a reuse of the GitHub integration, which depends on GraphQL.

## Setup

Everything ran locally on 2026-11-10. No real accounts, no provider quota.

- GitBucket **4.48.0** (latest release, 2026-09-20) from its release war on `eclipse-temurin:21-jre`,
  and the official Docker image `gitbucket/gitbucket:latest`, which is stuck at **4.38.4**
  (2022-12). Default admin `root`/`root`.
- Seed data: repo `root/demo`, second user `alice` (collaborator), three issues, a PR with a
  comment from alice, a commit status. The spike made tokens through GitBucket's web form
  (`POST /signin`, then `POST /<user>/_personalToken`); GitBucket has no token API.
- TLS: Caddy 2 with `tls internal` as `gitbucket.test`, in front of GitBucket on a Docker network.
- gh **2.103.3** (linux/arm64) in an Alpine container with `GH_CONFIG_DIR=/tmp/ghcfg` and
  `SSL_CERT_FILE` pointing at the system bundle plus Caddy's root. The user's real gh login was
  never touched. The Mac's gh (2.76.0) was used only for the plain-HTTP attempt.

## Signing in

| Command                                                                                                  | Result                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gh auth login --hostname localhost:18081 --with-token`                                                  | `invalid hostname`: a port is rejected.                                                                                                                                                                       |
| `GH_HOST=localhost:18081 gh api /user`                                                                   | gh requests `https://localhost:18081/api/v3/user`: `server gave HTTP response to HTTPS client`. No HTTP option.                                                                                               |
| `gh auth login --hostname gitbucket.test --with-token` (HTTPS)                                           | `GET /api/v3/` 200 (the scope check passes without an `X-OAuth-Scopes` header), then `POST /api/graphql` `query UserCurrent{viewer{login}}` 404: `error retrieving current user: HTTP 404`. Nothing is saved. |
| `gh config set -h gitbucket.test oauth_token <token>` and `gh config set -h gitbucket.test user <login>` | Writes both to `hosts.yml`, with `warning: 'oauth_token' is not a known configuration key`. The token is stored as plain text, not in the keychain.                                                           |
| `gh auth status --hostname gitbucket.test`                                                               | After the workaround: `✓ Logged in to gitbucket.test account root (hosts.yml)`. It sends `GET /api/v3/` with the token.                                                                                       |
| `gh auth status --hostname gitbucket.test --json hosts`                                                  | `{"state":"success","login":"root","tokenSource":".../hosts.yml",...}`. This is what `readiness.ts` reads.                                                                                                    |
| Same, with a bad token in `GH_ENTERPRISE_TOKEN`                                                          | `X Failed to log in ... The token in GH_ENTERPRISE_TOKEN is invalid.` A bad token is detected.                                                                                                                |
| `GH_HOST=gitbucket.test GH_ENTERPRISE_TOKEN=<token> gh api user`                                         | Works. This is the other way to sign in without `auth login`, but the daemon only sees it if its own environment has the variable.                                                                            |
| `gh api --hostname gitbucket.test user`                                                                  | `{"login":"root",...}`; with a bad token, `Bad credentials (HTTP 401)`. ace's identity probe (`githubIdentity`, `gh api user --hostname`) works as is.                                                        |
| `git clone` with `credential.helper="!gh auth git-credential"`                                           | Works over `https://gitbucket.test/git/root/demo.git`.                                                                                                                                                        |

The `login` in `auth status` comes from what the user stored. `gh api user` reports the token's
real owner, so ace's pinned-account check still holds.

On macOS, gh uses the system trust store. A GitBucket with a private CA needs its root in the
Keychain. That is the user's job, and most real installs have a public certificate anyway.

## REST reads through `gh api --hostname gitbucket.test --include`

4.48.0. 4.38.4 matched except where noted.

| Endpoint                                                                         | Status                     | Notes                                                                                                                          |
| -------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `user`                                                                           | 200                        | `id` is 1-based on 4.48; always `0` on 4.38.4.                                                                                 |
| `repos/{o}/{r}`                                                                  | 200                        | Default branch `main` on 4.48, `master` on 4.38.4.                                                                             |
| `pulls?state=all`, `pulls/{n}`                                                   | 200                        | Has `merged`, `merged_at`, `draft`, `head.sha`. No `mergeable` (always null), no `merge_commit_sha`, no `requested_reviewers`. |
| `pulls/{n}/commits`                                                              | 200                        |                                                                                                                                |
| `pulls/{n}/files`                                                                | 404                        | Not implemented.                                                                                                               |
| `pulls/{n}/comments`, `pulls/{n}/reviews`, `pulls/{n}/requested_reviewers`       | 404                        | No review comments, approvals or reviewer requests in the API.                                                                 |
| `pulls/{n}/merge` (GET)                                                          | 404                        | 404 even for a merged PR, so use `pulls/{n}.merged`.                                                                           |
| `issues?state=all`, `issues/{n}`                                                 | 200                        | Issue lists leave out PRs (GitHub includes them). Issue `id` is always `0`, so key on `number`.                                |
| `issues/{n}/comments`                                                            | 200                        | Comment ids are real.                                                                                                          |
| `issues/comments`, `issues/{n}/events`, `issues/{n}/timeline`                    | 404                        |                                                                                                                                |
| `commits/{sha}/statuses`, `commits/{sha}/status`                                 | 200                        | Combined status works.                                                                                                         |
| `commits/{sha}/check-runs`                                                       | 404                        | No checks API, only statuses.                                                                                                  |
| `commits/{sha}`, `commits?sha=`                                                  | 200                        |                                                                                                                                |
| `compare/{a}...{b}`                                                              | 404                        |                                                                                                                                |
| `branches`, `branches/{b}`, `branches/{b}/protection`                            | 200                        |                                                                                                                                |
| `contents/{path}?ref=`, `git/refs/heads/{b}`                                     | 200                        |                                                                                                                                |
| `labels`, `milestones`, `collaborators`, `collaborators/{u}/permission`, `hooks` | 200                        | `permission` uses GitBucket names (`DEVELOPER`), not GitHub's.                                                                 |
| `assignees`                                                                      | 404                        |                                                                                                                                |
| `user/repos`, `user/orgs`                                                        | 404 on 4.48, 200 on 4.38.4 | 4.48 added `GET /api/v3/user/:id`, which catches these paths first.                                                            |
| `search/issues`, `notifications`, `actions/runs`, `markdown`                     | 404                        | No search, inbox, Actions or markdown render.                                                                                  |
| `rate_limit`                                                                     | 404                        | Body: `Rate limiting is not enabled.`                                                                                          |
| `graphql`                                                                        | 404                        | HTML error page.                                                                                                               |

**Pagination.** `per_page` is ignored; pages are a fixed 25. No `Link` header is sent, so
`gh api --paginate` stops after page one: with 34 issues, `--paginate ... --jq length` printed
`25`. `page=2` returned the other 9. An adapter must page by hand until a short page.

## REST writes

| Call                                                               | Status     | Notes                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST issues`                                                      | 200        | Returns the issue (GitHub returns 201).                                                                                                                                                                                                                                                  |
| `POST issues/{n}/comments`                                         | 200        | Works on PRs too (the PR comment).                                                                                                                                                                                                                                                       |
| `PATCH issues/comments/{id}`                                       | 200        |                                                                                                                                                                                                                                                                                          |
| `DELETE issues/comments/{id}`                                      | empty body | Status code not recorded.                                                                                                                                                                                                                                                                |
| `POST issues/{n}/labels`                                           | 200        |                                                                                                                                                                                                                                                                                          |
| `PATCH issues/{n}`                                                 | 404        | No route, so no **close, reopen or retitle** for issues through the API.                                                                                                                                                                                                                 |
| `POST issues/{n}/assignees`                                        | 404        |                                                                                                                                                                                                                                                                                          |
| `POST pulls/{n}/comments` (line comment), `POST pulls/{n}/reviews` | 404        |                                                                                                                                                                                                                                                                                          |
| `POST pulls`, `PATCH pulls/{n}`                                    | 200        | Create and edit PRs work.                                                                                                                                                                                                                                                                |
| `POST statuses/{sha}`                                              | 200        |                                                                                                                                                                                                                                                                                          |
| `PUT pulls/{n}/merge`                                              | 200        | Merges, but the body is `{"status":200,"body":"{\"sha\":\"MergeResult(AnyObjectId[...]...","headers":{}}`: a JSON string holding a Scala `toString`. The source has `// TODO: Implement sha parameter` and ignores `commit_title`, so a merge **cannot be pinned to the reviewed head**. |
| `gh pr merge`                                                      | fails      | `non-200 OK status code: 404 Not Found body: ""`                                                                                                                                                                                                                                         |

On 4.38.4, some write responses (`POST pulls`, `POST admin/users`) came back as a JSON string
wrapping the JSON object. A lenient decoder has to unwrap that.

## High-level `gh` commands

`gh pr list`, `gh pr view`, `gh pr checks`, `gh issue list`, `gh issue comment` and `gh repo view`
all fail with `HTTP 404: 404 Not Found (https://gitbucket.test/api/graphql)`. Only `gh api` is
usable.

## What an adapter would need

A `gitbucket-*` adapter beside `tea-*`, using ace's existing `gh api --hostname` runner. Roughly
1,200–1,600 lines plus tests; the Gitea adapter is about 1,550 lines without tests.

- **Detection and readiness.** Treat a host as GitBucket when `GET /api/v3/` returns only
  `{"rate_limit_url":...}` and `/api/graphql` 404s. Readiness tells the user to sign in with the
  two `gh config set -h <host>` commands, or with `GH_ENTERPRISE_TOKEN` plus `GH_HOST`, instead of
  `gh auth login`. Identity is `gh api user` as today. ace never reads or writes the token.
- **Reads.** Pull list and detail, commits, issue list and detail, comments, combined commit
  status. Page by hand in steps of 25. Key issues by `number`. Accept both `main` and `master`,
  and unwrap string-wrapped JSON.
- **Files and diffs.** The API has none, so take them from local git: fetch the PR head and diff
  against the base. ace already has the worktree.
- **Writes.** Issue create, comment create/edit/delete, labels, PR create/edit, commit status.
- **Merge.** Only with a guard: read `pulls/{n}` and check that `head.sha` matches the reviewed
  head, then `PUT .../merge`, then confirm through `pulls/{n}.merged`. A window remains between
  the check and the merge, because GitBucket ignores `sha`. ace should also check the user's write
  permission with `collaborators/{u}/permission` before offering merge, and not rely on the server
  to refuse.
- **Capabilities (ADR 0117).** About `reviews.read`, `reviews.files` (from git), `reviews.commits`,
  `reviews.comments.read` and `reviews.comments.write` (conversation comments only), `reviews.checks`,
  `reviews.checks.write`, `reviews.create`, `reviews.edit`, `issues.read`, and `reviews.merge` if
  the unpinned merge is acceptable. Not possible: line comments, replies, approvals, reviewer
  requests, auto-merge, stacks, suggestions, inbox, reactions, media. `issues.write` is partial,
  because issues can't be closed or reopened.

## Blockers to accept before building

- Sign-in uses an undocumented gh config path that prints a warning and stores the token as plain
  text. If gh drops the `oauth_token` key, GitBucket sign-in through gh stops working, and only
  the environment-variable route is left.
- HTTPS on the default port is required.
- The merge can't be pinned to a head SHA.
- Issues can't be closed or reopened.
- GitBucket 4.48.0 broke `user/repos` and `user/orgs`, so repository discovery has to use
  `users/{login}/repos`, which the 4.48.0 source still routes (not tested in this spike).
