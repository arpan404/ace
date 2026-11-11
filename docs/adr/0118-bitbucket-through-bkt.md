# 0118: Bitbucket Cloud through the `bkt` CLI

Date: 2026-11-10. Status: accepted by the repo owner, who approved a vetted third-party CLI for
Bitbucket.

## Context

ADR 0002 reaches every host only through the user's own installed, logged-in CLI, and ADR 0117
left Bitbucket blocked until an official CLI existed. Atlassian's own CLI, `acli`, has `admin`,
`jira` and `rovodev` commands and nothing for Bitbucket
([command reference](https://developer.atlassian.com/cloud/acli/reference/commands/)).

ace needs three things from a host CLI: the CLI owns sign-in and stores the credential, it has a
raw authenticated API command so ace can admit exact requests (ADR 0117), and it can name the
signed-in account. Candidates, checked on 2026-11-10 against their source and documentation:

- **`bkt`** ([avivsinai/bitbucket-cli](https://github.com/avivsinai/bitbucket-cli), MIT, Go,
  v0.38.1 released 2026-11-09, Homebrew core `bitbucket-cli`, WinGet, Scoop, Nix). `bkt auth login`
  signs in by browser OAuth or a scoped Atlassian API token and keeps the token in the OS keychain
  (macOS Keychain, Windows Credential Manager, Secret Service); `config.yml` holds no token.
  `bkt api <path>` sends one request to the context's host with `--method` and an `--input` JSON
  body, and prints `Error: <status> <text>` on stderr for a non-2xx reply. `bkt auth status
--json` lists hosts and contexts. Cloud and Data Center.
- **`bb`** ([biokraft/bbcloud](https://github.com/biokraft/bbcloud), MIT, Rust): keychain storage
  but no raw API command, so ace can't admit exact requests.
- **`bb`** ([volcmen/bb-cli](https://github.com/volcmen/bb-cli), MIT, Rust, 0.1.1): has `bb api`,
  but keeps credentials in a plain file, has no Homebrew release and no Data Center.
- **`atlassian-cli`** ([omar16100/atlassian-cli](https://github.com/omar16100/atlassian-cli)):
  named Bitbucket commands only, no raw API command.
- **Appfire's Bitbucket CLI**: paid, closed source.

Two facts about Bitbucket Cloud shape the adapter:

- App passwords are gone; Atlassian disabled the remaining ones on 2026-06-09
  ([Atlassian](https://www.atlassian.com/blog/bitbucket/bitbucket-cloud-enters-phase-2-of-app-password-deprecation)).
  `bkt` signs in with OAuth or API tokens, so ace needs nothing for this.
- Atlassian removed Bitbucket Cloud Issues on 2026-08-20. The current OpenAPI document
  (`dac-static.atlassian.com/cloud/bitbucket/swagger.v3.json`) has no issue endpoints, and `bkt
issue` now exits saying so.

## Decision

1. **Bitbucket Cloud is reached through `bkt`**, the one candidate meeting all three needs. ADR
   0002's "the user's own installed, logged-in CLI" now includes `bkt`, for Bitbucket only. ace
   never runs `bkt auth login` with a token, reads the keychain or sees the credential. Settings
   tell the user to run `bkt auth login https://bitbucket.org --kind cloud --web` and to create a
   context for the Cloud host.
2. **Requests are pinned to one `bkt` context on the Cloud host.** `bkt api` picks its host from a
   context, so ace reads `bkt auth status --json` and pins the context whose host is Cloud
   (`api.bitbucket.org`), preferring the one whose workspace is the repository's, then the first
   by name. It re-reads that mapping on every identity probe, so an edited context fails closed.
   The account is `GET /2.0/user`'s `username`, Bitbucket's unique handle.
3. **Admitted shapes, nothing else** (ADR 0117):
   - reads: `bkt api <endpoint> --method GET --context <context>`;
   - writes: `bkt api <endpoint> --method <METHOD> --context <context>`, plus
     `--input <JSON object>` when the write has a body.

   `<endpoint>` is a `/2.0/` path under `user` or `repositories/<workspace>/<slug>`: no absolute
   URL (bkt would send the token to it), no traversal or encoded path characters. Writes are
   pinned to one repository and one pull request. `bkt api` reads the body only from its
   `--input` argument, not stdin, so a body is visible in the process list to the same user. It
   carries comment text, never a credential.

4. **Write certainty uses the status bkt prints.** A reply of 400, 401, 403, 404, 405, 409, 412,
   422 or 429 under an unchanged identity has definitely failed; any other failure after dispatch,
   and an identity change after any reply, is uncertain and reconciles by reading (ADR 0117). bkt
   retries a 5xx only for PUT and DELETE, which Bitbucket treats as idempotent here, and never for
   POST.
5. **No merge.** Bitbucket's merge endpoint takes no expected source commit
   (`pullrequest_merge_parameters` has only `type`, `message`, `close_source_branch` and
   `merge_strategy`), so a merge can't be pinned to the head the person reviewed. ace doesn't
   offer it.
6. **No issues**, since Bitbucket Cloud no longer has them.
7. **Data Center is not supported.** `bkt` supports it, but Data Center's REST API is a different
   API (`/rest/api/1.0`); it would be a separate adapter.

## Consequences

Bitbucket gets reviews without a new protocol shape. ace depends on a community-maintained CLI;
its exact request shape is pinned in `read-only-api.ts` and its error format in `command.ts`, so
a change to either fails closed (refused or uncertain), never as a silent success.
