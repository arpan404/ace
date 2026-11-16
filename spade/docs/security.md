# Security boundaries

Date: 2026-11-15. As built for [ADR 0167](../../docs/adr/0167-spade-security-boundaries.md), in
`spade-sandbox` (the sandbox, the credential deny-list and the egress proxy), `spade_core::grant`
(grants) and `spade-server` (`security/`, `api/security.rs`, the shell, services and plugin
servers). Extends [workspace.md](workspace.md), [computer.md](computer.md) and
[autonomy.md](autonomy.md).

## What is built where

| Platform | Mechanism                                                  | Files     | Network                                       | Reviews dropped |
| -------- | ---------------------------------------------------------- | --------- | --------------------------------------------- | --------------- |
| macOS    | Seatbelt profile per run, `/usr/bin/sandbox-exec -p`       | contained | contained (TCP to the proxy's port only)      | yes             |
| Linux    | Landlock via `spade sandbox-exec`, `landlock` feature, off | contained | partial (TCP only; UDP and Unix sockets open) | no              |
| Windows  | AppContainer, designed, not built                          | none      | none                                          | no              |

Spade probes the sandbox once at start (`Runner::probe`: the real profile on a throwaway folder
running `/usr/bin/true`). `SPADE_SANDBOX=off` turns it off. Without a sandbox that holds both
files and network, and the proxy listening, nothing about reviews changes.

## What a sandboxed run may touch

Every command Spade starts for a bot runs in that bot's sandbox: `shell` in the one-shot shell and
in each terminal session, owned services, plugin hooks and plugin MCP servers. The person's own
shell in the bot's terminal is not sandboxed. A run is confined when its home is a bot's workspace
(`<data>/workspace/<bot>`). On a machine with a sandbox, a run that can't be confined is not
started: the shell answers `the sandbox could not start: …`, and a plugin server keeps that as its
problem.

| Place                                                                    | Access                        |
| ------------------------------------------------------------------------ | ----------------------------- |
| The bot's workspace, `.spade/tmp` in it (`TMPDIR`)                       | read-write                    |
| Folders granted with `write: true`                                       | read-write                    |
| A terminal's state files (Spade's `terminal/<bot>`)                      | read-write                    |
| The system                                                               | read-only                     |
| Confirmed toolchains, folders granted for reading                        | read-only                     |
| A plugin's own folder (its hooks and servers only)                       | read-only                     |
| The rest of the home folder                                              | none (ancestors: `stat` only) |
| Spade's data (other bots' workspaces, database, keys), ace's data        | none                          |
| The credential deny-list                                                 | none, whatever else allows it |
| `/dev/null`, `/dev/zero`, `/dev/random`, `/dev/urandom`, ttys, `/dev/fd` | read-write                    |

Network: TCP to the egress proxy on `127.0.0.1` and nothing else, no DNS. Listening on loopback
is allowed, so a dev server can start. On macOS there are no Apple Events and no LaunchServices
(`open` and `osascript` can't reach other apps); the mach services allowed are directory lookups,
logging, notifications and certificate checks (`trustd`), never `SecurityServer`.

The environment is the shell's built one (no Spade secrets, `HOME` the workspace) plus `TMPDIR`,
the proxy variables below, and for confirmed toolchains their `bin` folders first on `PATH`
(`RUSTUP_HOME` for `~/.rustup`, `PYENV_ROOT` and `shims` for `~/.pyenv`).

### The credential deny-list

`spade_sandbox::credentials`: `~/.ssh`, `~/.gnupg`, `~/.password-store`, `~/.aws`, `~/.azure`,
`~/.config/gcloud`, `~/.kube`, `~/.oci`, `~/.docker/config.json`, `~/.netrc`, `~/.git-credentials`,
`~/.config/git/credentials`, `~/.config/gh`, `~/.config/hub`, `~/.npmrc`, `~/.yarnrc.yml`,
`~/.pypirc`, `~/.gem/credentials`, `~/.cargo/credentials`, `~/.cargo/credentials.toml`,
`~/.terraform.d/credentials.tfrc.json`, `~/.codex`, `~/.claude`, `~/.claude.json`,
`~/.config/opencode`, `~/.local/share/opencode`, `~/.cursor`, `~/.gemini`,
`~/.config/github-copilot`, `~/Library/Keychains`, `~/.local/share/keyrings`,
`/Library/Keychains`. Spade's and ace's data folders are closed the same way. In the Seatbelt
profile it comes after every grant, so nothing opens it again; a plugin folder reopened inside
ace's data is followed by the credential places closed once more. Landlock has no deny rule, so a
readable folder holding a listed place is opened child by child around it. The word list in
`spade_core::autonomy::secrets` still refuses a call naming these places before anything runs.

## The egress proxy

One listener on `127.0.0.1` at a free port. Each run gets a ticket whose token reaches it only in
`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` (and lowercase), as `http://spade:<token>@127.0.0.1:<port>`;
`NO_PROXY` is empty and `NODE_USE_ENV_PROXY=1`. The ticket ends with the run (a plugin server's
with the server). `CONNECT host:port` is tunnelled and `http://` absolute-form requests are
forwarded in origin form without `Proxy-Authorization`, `Proxy-Connection`, `Connection` or
`Keep-Alive`, closed after one exchange. TLS is passed through untouched.

| Answer | When                                                                         |
| ------ | ---------------------------------------------------------------------------- |
| `407`  | No `Proxy-Authorization: Basic`, or a token of no live run                   |
| `400`  | A head that doesn't parse, `https://` absolute form, credentials in the URL  |
| `403`  | The policy refuses the host, or a public name resolves to a private address  |
| `502`  | Allowed, but the name didn't resolve or the host didn't answer (within 30 s) |

**Network policy** `{mode, allow, dropped}`:

- `mode`: `off` (no connection at all), `allow_list` (commands' default) or `open` (any public
  host; plugins' default).
- `allow`: the person's additions, `host`, `*.host` (subdomains only) or either with `:port`.
  Without a port an entry covers 443 and 80.
- `dropped`: defaults the person removed.
- Defaults: npm, Yarn, Bun, JSR, PyPI, crates.io and rustup's static host, the Go proxy and sum
  database, RubyGems, Maven Central, the Gradle plugin portal, Packagist, NuGet, Hex, pub.dev,
  CocoaPods, Homebrew's formulae and bottles, GitHub (with `api.`, `codeload.`, `objects.` and
  `raw.githubusercontent.com`), GitLab, Bitbucket, Codeberg and sourcehut
  (`spade_sandbox::egress::DEFAULTS`).
- Loopback, private, link-local, CGNAT, unique-local and reserved addresses are refused, in
  `open` mode too and when a public name resolves to one. An entry that names a local host
  literally (`localhost:3000`, `10.0.0.5:5432`) is the only way in.

**Log.** Every request is one JSON line in `<data>/egress/<bot>.jsonl`, written when the
connection ends (a refusal at once): `{at, bot, run, host, port, method, allowed, reason?, sent,
received}`. Past 1 MiB the file becomes `<bot>.1.jsonl` and a new one starts.

## Grants

`spade_core::grant`. A grant is `{id, kind, …scope, by, created_at}`; `by` is `person` (or a
parent bot's id, once workers can pass grants down at creation).

| `kind`       | Fields              | Allows                                                    | Enforced now                |
| ------------ | ------------------- | --------------------------------------------------------- | --------------------------- |
| `folder`     | `path`, `write`     | The folder read-only, or read-write, in the bot's sandbox | yes, at each run            |
| `tool`       | `tool`, `arguments` | Calling `tool` when every named argument matches its glob | yes, at the gate            |
| `git_push`   | `repo`, `branch`    | Pushing matching branches of matching repos               | stored; no push tool yet    |
| `pr_comment` | `repo`, `own_only`  | Commenting on PRs of matching repos (only its own)        | stored; no comment tool yet |

Globs: `*` within a `/` segment, `**` across. A call a `tool` grant covers runs without a review
while nothing untrusted is in view; with untrusted content in view it is reviewed, the grant named
as the concern. Refused at creation: a `tool` grant whose name says a payment, sending as the
person, or changing sign-ins, keys or access (`autonomy::never_granted`: those always go to the
person); a push grant for every branch (`*`, `**`); a folder that is relative, `/`, uses `..`,
isn't a folder, or is or holds a credential place or Spade's or ace's data.

**Down the tree.** A bot's effective grants are its own for a top-level bot; for a worker, those
of its own that one of its parent's effective grants covers (`grant::within`, conservative: a
pair it can't prove is dropped), applied from the top down. The person granting a worker
something its parent lacks gets `400`. Revoking a parent's grant narrows every worker at once.

## What the gate does with it

`spade_core::autonomy::route`, with two facts beside ADR 0163's:

- `contained`: a `shell` call whose bot's sandbox holds files and network here. It runs with no
  review, untrusted content in view or not, when the classifier found nothing or one of: network,
  writes or deletes outside the folder, driving other apps, unclear, unseen script. Publishing,
  a server change, mail, payments and admin rights are still reviewed with their concern. A
  credential read is refused first, as before.
- `granted`: a grant covers the call (above).

`workspace_write` and `workspace_edit` count as contained too where the sandbox holds: a
checkpoint is taken first when one is due, and they run without a review, untrusted content in
view or not. What they write under taint still isn't trusted (workspace.md, Trust). Routines set
up under taint, notes and outward calls keep their rules.

## Checkpoints

`security/checkpoints.rs`. A copy of the bot's workspace at `<data>/checkpoints/<bot>/<id>/`
(`/bin/cp -c -R -p` on macOS, a clone on APFS, else a plain copy; `cp -a --reflink=auto` on
Linux; none on Windows), its record `<id>.json` `{id, at, reason}` written once the copy is
whole. A folder without a record is an unfinished copy and is removed when the list is read.
`.spade/tmp` isn't kept. Taken:

- `auto`: before a sandboxed bot command, terminal command or service, or a contained file write,
  at most once a minute per bot (in memory, so a restart may take one sooner);
- `person`: on `POST /agents/{id}/checkpoints`;
- `before_restore`: just before a restore.

Kept: the newest 20, none older than 7 days. A restore moves the workspace aside, copies the
checkpoint in its place, and puts the old one back if the copy fails; it is refused (`409`) while
the bot is working. Consented folders aren't copied. Files a restore brings back are trusted only
where their content still matches the trust record.

## API

Under `/v1`, with the bearer token. Only the person's API writes any of this; no bot tool does.

| Method and path                             | Body                             | Answer                                                                                                                                                                                                          |
| ------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /security`                             |                                  | `{sandbox: {platform, mechanism: seatbelt\|landlock\|app_container\|none, files, network: contained\|partial\|none, reason}, proxy: {running, problem}, contained, defaults: [host], toolchains_found: [path]}` |
| `GET /agents/{id}/security`                 |                                  | `{contained, network: Policy, plugin_network: Policy, toolchains: [path], grants: [Grant], effective_grants: [Grant], folders: [{grant, path, write}]}`; `404` unknown bot                                      |
| `PUT /agents/{id}/security/network`         | `{mode, allow?, dropped?}`       | The bot's view, as above; `400` for an entry that isn't a host, `*.host` or `host:port`, or a dropped name that isn't a default                                                                                 |
| `PUT /agents/{id}/security/plugin-network`  | `{mode, allow?, dropped?}`       | As above, for its plugins' hooks and servers                                                                                                                                                                    |
| `PUT /agents/{id}/security/toolchains`      | `{toolchains: [path]}`           | The bot's view; `400` for a path that isn't an absolute folder or holds sign-ins or data                                                                                                                        |
| `GET /agents/{id}/security/egress`          | `?limit=` (1–5,000, default 200) | `{entries: [Entry]}`, oldest first                                                                                                                                                                              |
| `GET /agents/{id}/grants`                   |                                  | `{grants: [Grant], effective: [Grant]}`                                                                                                                                                                         |
| `POST /agents/{id}/grants`                  | `{kind, …scope}`                 | `201 {grant}`; `400` refused (why); `404` unknown bot                                                                                                                                                           |
| `DELETE /agents/{id}/grants/{grant}`        |                                  | `204`; `404` no such grant                                                                                                                                                                                      |
| `GET /agents/{id}/checkpoints`              |                                  | `{checkpoints: [{id, at, reason}], keep: 20, longest_days: 7, every_seconds: 60}`, newest first                                                                                                                 |
| `POST /agents/{id}/checkpoints`             |                                  | `201 {checkpoint}`; `400` when the workspace doesn't exist yet                                                                                                                                                  |
| `POST /agents/{id}/checkpoints/{c}/restore` |                                  | `200 {restored, saved}` (`saved`: the checkpoint taken just before); `404` no such checkpoint; `409` the bot is working                                                                                         |

Settings are one stored setting per bot, `security:<bot id>`; a value that doesn't parse reads as
the defaults. A change holds from the bot's next run.

## What the UI needs

Not built here. **Settings › Spade › Security** (the machine):

- The sandbox line: "Commands run in macOS's sandbox" or the `reason` when they don't, and
  whether shell commands skip the review (`contained`).
- Whether the proxy runs (`proxy.problem` when not).
- The default allow-list (`defaults`), read-only.
- Toolchains found (`toolchains_found`), offered when confirming them for a bot.

**The bot's profile, Details › Security**:

- Network for commands: mode (`Off`, `Allow list`, `Any public host`), the defaults with a switch
  each (`dropped`), the person's additions with add and remove (show the `400` text inline).
- Network for plugins: the same, defaulting to any public host.
- Consented folders: the `folder` grants, each with read-only or read-write, add (a folder
  picker) and remove; a worker's effective ones marked as narrowed by its parent.
- Toolchains: confirmed folders, added from `toolchains_found`.
- Grants: the `tool`, `git_push` and `pr_comment` grants with their scope in words ("Push to
  `spade/*` of arpan404/ace"), add and revoke; never offer payments, sending as the person or
  access changes.
- Network activity: the egress log, newest first, refused rows marked with their `reason`, and a
  "Allow this host" action on a refused row (adds it to `allow`).
- Checkpoints: the list with when and why (`auto`, `person`, `before_restore`), "Take one now",
  and "Restore" with a confirm saying the current state is kept as a checkpoint first; disabled
  while the bot works (`409`).

## Not built yet

- A size bound on checkpoints (count and age only today; clones cost little on APFS, plain
  copies on other volumes don't).
- Linux's seccomp filter (UDP, raw and Unix sockets), so Linux can count as contained.
- Windows' AppContainer.
- Tools that use `git_push` and `pr_comment` grants (a push or comment that holds the person's
  sign-in outside the sandbox).
- Per-value provenance at egress, `derived` trust for network-off runs (each run's proxy usage
  is already counted), and quarantined readers.
- CLI brains in the sandbox (ADR 0133 keeps them on their own read-only modes).
- Payments and sending as the person going straight to the person at the gate: today no grant
  covers them and the reviewer sees them as concerns (ADR 0163); routing them past the reviewer
  waits on a classification that doesn't also catch ace's `agent_message` to a bot's own child.
