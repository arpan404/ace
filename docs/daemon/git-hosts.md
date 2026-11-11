# Git hosts

Settings → Source control configures GitHub, Cursor Origin, GitLab, GitBucket, Bitbucket, Gitea and Forgejo on the selected computer. A host saved without a provider field takes its public host's provider (`gitlab.com` is GitLab, `codeberg.org` is Forgejo and so on); any other such host remains a GitHub host. Settings refuse only an explicit provider that contradicts a public host, or Cursor Origin on any host but `origin.cursor.com`. Adding a host preserves the other configured hosts. Saving selects the host for connection checks; checkout identity comes from the project's configured Git remote.

| Provider        | Repository recognition                                  | API connection check | Pull requests and issues |
| --------------- | ------------------------------------------------------- | -------------------- | ------------------------ |
| GitHub          | Public and explicitly mapped Enterprise hosts           | Installed `gh`       | Existing integration     |
| GitLab          | Public and explicitly mapped hosts, including subgroups | Installed `glab`     | Read-only merge requests |
| Cursor Origin   | `origin.cursor.com`                                     | Installed `origin`   | Read-only pull requests  |
| GitBucket       | Explicitly mapped hosts                                 | Pending              | Pending                  |
| Bitbucket Cloud | `bitbucket.org`                                         | Pending              | Pending                  |
| Gitea           | Explicitly mapped hosts                                 | Pending              | Pending                  |
| Forgejo         | Codeberg and explicitly mapped hosts                    | Pending              | Pending                  |

GitBucket and Bitbucket are distinct providers. API compatibility is never inferred from a hostname. Bitbucket Server/Data Center URL layouts and installations below a URL path are not supported yet.

GitLab checks run `glab --version` and `glab api user --hostname HOST --include`. Sign in with `glab auth login --hostname HOST` in your terminal, then Rescan. Ace reads the account identity, not provider credentials. An expected account mismatch blocks readiness. These checks do not enable merge request mutations.

Git transport checks use the selected project's Git remote and the computer's existing Git credentials or SSH key. A successful read does not establish push permission. Providers without API adapters explicitly report unavailable API support and are rejected before GitHub identity probes or requests.

## Cursor Origin and hosted review reads

Cursor Origin is recognized at `origin.cursor.com`, including HTTPS, SSH and the older `/git/owner/repo.git` clone path. Its web pages live at `cursor.com/codebase`. It uses the separately installed `origin` CLI, not Cursor's `agent` executable. Ace reads only `origin auth status --json account` for account verification; tokens stay with the CLI.

Code review can list and open Origin pull requests and GitLab merge requests, read descriptions and inspect paginated changed-file patches. These hosts use a read-only review view. Missing comments, review decisions, CI and commit history are not shown as successful or as complete empty results. Use the host's web page for reviews and merge actions. Unsupported filters fail explicitly rather than silently changing a query's meaning.

All reads are pinned to the admitted CLI account and the settings revision. GitLab and Origin reads admit only one explicit `api` GET each (no fields, request body, input file or `--verbose`); anything else is refused before it reaches the CLI. The account is probed at most once a minute per host, beside the read it gates, and always again after a settings change or Rescan; a probe that names another account fails the read. File reads compare the head and base to the selected review version. Origin pagination uses opaque provider tokens; list and file reads have page/item and byte limits. Origin has no server-side state or text filters, so a list reads up to 1,000 pull requests once and reuses that traversal for 30 seconds of page turns and filter changes.

GitLab changed files come from `GET /projects/:id/merge_requests/:iid/diffs`, one 25-file page per request, pinned by the merge request's `diff_refs` before and after the page (the older `/changes` endpoint is deprecated since GitLab 15.7). A file whose diff GitLab withheld (`collapsed` or `too_large`) shows no patch and is marked truncated, and a `changes_count` of `1000+` marks the whole change truncated. The detail's file count is GitLab's `changes_count`, or the diff list's total when GitLab hasn't computed it yet.

A pull request in a state ace doesn't know (GitLab's `locked`, say) is never shown as open: lists leave it out and say they are incomplete, and a linked pull request keeps its last known summary while the rest of its repository refreshes. Titles, descriptions and labels longer than the protocol allows are cut to fit rather than failing the read.

A pasted pull request address is read by its host's provider: a `/-/merge_requests/` path on a GitHub host, or a `/pull/` path on a GitLab host, is not a pull request. GitHub continues through its existing backend, including its mutation receipts and account checks.

Primary contracts: [Origin CLI](https://cursor.com/docs/origin/cli/reference/commands), [Origin API](https://cursor.com/docs/api/origin), [Origin Git transport](https://cursor.com/docs/origin/git), [GitLab merge requests](https://docs.gitlab.com/api/merge_requests/).
