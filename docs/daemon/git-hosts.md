# Git hosts

Settings → Source control configures GitHub, GitLab, GitBucket, Bitbucket, Gitea and Forgejo on the selected computer. Existing hosts without a provider field remain GitHub hosts. Adding a host preserves the other configured hosts. Saving selects the host for connection checks; checkout identity comes from the project's configured Git remote.

| Provider        | Repository recognition                                  | API connection check | Pull requests and issues |
| --------------- | ------------------------------------------------------- | -------------------- | ------------------------ |
| GitHub          | Public and explicitly mapped Enterprise hosts           | Installed `gh`       | Existing integration     |
| GitLab          | Public and explicitly mapped hosts, including subgroups | Installed `glab`     | Pending                  |
| GitBucket       | Explicitly mapped hosts                                 | Pending              | Pending                  |
| Bitbucket Cloud | `bitbucket.org`                                         | Pending              | Pending                  |
| Gitea           | Explicitly mapped hosts                                 | Pending              | Pending                  |
| Forgejo         | Codeberg and explicitly mapped hosts                    | Pending              | Pending                  |

GitBucket and Bitbucket are distinct providers. API compatibility is never inferred from a hostname. Bitbucket Server/Data Center URL layouts and installations below a URL path are not supported yet.

GitLab checks run `glab --version` and `glab api user --hostname HOST --include`. Sign in with `glab auth login --hostname HOST` in your terminal, then Rescan. Ace reads the account identity, not provider credentials. An expected account mismatch blocks readiness. These checks do not enable merge request mutations.

Git transport checks use the selected project's Git remote and the computer's existing Git credentials or SSH key. A successful read does not establish push permission. Providers without API adapters explicitly report unavailable API support and are rejected before GitHub identity probes or requests.
