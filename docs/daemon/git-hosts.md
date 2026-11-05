# Git hosts

Settings → Source control configures GitHub, Cursor Origin, GitLab, GitBucket, Bitbucket, Gitea and Forgejo on the selected computer. Existing hosts without a provider field remain GitHub hosts. Adding a host preserves the other configured hosts. Saving selects the host for connection checks; checkout identity comes from the project's configured Git remote.

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

All reads are pinned to the admitted CLI account and the settings revision. File reads compare the head and base to the selected review version. Origin pagination uses opaque provider tokens; list and file reads have page/item and byte limits. GitHub continues through its existing backend, including its mutation receipts and account checks.

Primary contracts: [Origin CLI](https://cursor.com/docs/origin/cli/reference/commands), [Origin API](https://cursor.com/docs/api/origin), [Origin Git transport](https://cursor.com/docs/origin/git), [GitLab merge requests](https://docs.gitlab.com/api/merge_requests/).
