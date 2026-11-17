# Security boundaries

Date: 2026-11-15, amended 2026-11-16. As built for
[ADR 0167](../../docs/adr/0167-spade-security-boundaries.md) and
[ADR 0171](../../docs/adr/0171-spade-decides-on-effects.md), in
`spade-sandbox` (the sandbox, the credential deny-list and the egress proxy), `spade_core::grant`
(grants) and `spade-server` (`security/`, `api/security.rs`, the shell, services and plugin
servers). Extends [workspace.md](workspace.md), [computer.md](computer.md) and
[autonomy.md](autonomy.md).

## What is built where

| Platform | Mechanism                                                  | Files     | Network                                       | Reviews dropped |
| -------- | ---------------------------------------------------------- | --------- | --------------------------------------------- | --------------- |
| macOS    | Seatbelt profile per run, `/usr/bin/sandbox-exec -p`       | contained | contained (TCP to the proxy's port only)      | yes             |
| Linux    | Landlock via `spade sandbox-exec`, `landlock` feature, off | contained | partial (TCP only; UDP and Unix sockets open) | no              |
| Windows  | AppContainer per run + job, via `spade sandbox-exec-win`   | contained (runs on Spade-owned folders only; else review) | contained (through a per-run named-pipe bridge to the proxy) | yes, for Spade-owned-folder runs |

Spade probes the sandbox once at start (`Runner::probe`: macOS runs the real profile on a
throwaway folder against `/usr/bin/true`; Windows makes and deletes a throwaway AppContainer
profile). `SPADE_SANDBOX=off` turns it off. Without a sandbox that holds both files and network,
and the proxy listening, nothing about reviews changes.

## What a sandboxed run may touch

Every command Spade starts for a bot runs in that bot's sandbox: `shell` in the one-shot shell and
in each terminal session, owned services, plugin hooks and plugin MCP servers. The person's own
shell in the bot's terminal is not sandboxed. A run is confined when its home is a bot's workspace
(`<data>/workspace/<bot>`). On a machine with a sandbox, a run that can't be confined is not
started: the shell answers `the sandbox could not start: …`, and a plugin server keeps that as its
problem.

| Place                                                                                                                               | Access                                           |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| The bot's workspace, `.spade/tmp` in it (`TMPDIR`)                                                                                  | read-write                                       |
| Folders granted with `write: true`                                                                                                  | read-write                                       |
| A terminal's state files (Spade's `terminal/<bot>`)                                                                                 | read-write                                       |
| The system's folders (below)                                                                                                        | read-only                                        |
| Confirmed toolchains, folders granted for reading                                                                                   | read-only                                        |
| A plugin's own folder (its hooks and servers only)                                                                                  | read-only                                        |
| Everything else: home folders, `/Users/Shared`, `/Volumes`, the person's temporary storage (`/private/var/folders`, `/private/tmp`) | none (ancestors of an opened place: `stat` only) |
| Spade's data (other bots' workspaces, database, keys), ace's data                                                                   | none                                             |
| The credential deny-list                                                                                                            | none, whatever else allows it                    |
| `/dev/null`, `/dev/zero`, `/dev/random`, `/dev/urandom`, ttys, `/dev/fd`                                                            | read-write                                       |

The system's folders on macOS: `/System`, `/usr`, `/bin`, `/sbin`, `/Library`, `/opt`, `/nix`,
`/private/etc`, `/private/var/db/timezone`, `/private/var/select`,
`/private/var/db/xcode_select_link`, `/Applications/Xcode.app`, and the listing of `/` (the loader
reads it). On Linux: `/usr`, `/bin`, `/sbin`, `/lib`, `/lib32`, `/lib64`, `/etc`, `/opt`, `/nix`,
`/snap`, `/var/lib`, `/proc`, `/sys`, `/dev`. Nothing is readable by default and then hidden: every
read rule names what it opens.

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
readable folder holding a listed place is opened child by child around it, by the launcher
itself and on opened objects: each child is opened with `openat` and `O_PATH | O_NOFOLLOW`
beside its opened folder, a link met while carving is skipped (never followed or granted), an
object that is a denied one (same device and inode, a hard link included) is left out, and the
descriptors carving opened are the ones the rules are installed on. The word list in
`spade_core::autonomy::secrets` still refuses a call naming these places before anything runs.

### On Windows (AppContainer)

`spade-sandbox-windows` holds the system calls (the one Spade crate allowed `unsafe`);
`spade-sandbox::windows` holds the policy and the launch; `spade-server` wires it in. **Each run**
gets its own AppContainer profile with **no capabilities** (derived from the bot and the run id),
so it starts with no access to anything and holds only its own grants — a plugin's extra folders
can't be reached by the bot's other running commands. The profile is deleted when the run ends.

**Spade only ever edits ACLs on folders it owns** (under its own data directory), because changing
ACLs on the person's folders touches other principals' inheritance and descendant identities.
So a run is `contained` only when its grants are Spade-owned:

- an inheritable *Modify* ACE (read, write, execute, delete — but not `WRITE_DAC`/`WRITE_OWNER`) on
  the workspace, its `.spade/tmp` (`TEMP`/`TMP`), the terminal scratch, and a plugin folder that
  lives under Spade's data;
- toolchains are **read without any ACL change**: they are already readable by `ALL APPLICATION
  PACKAGES` (`Program Files`, `Windows`) or are copies Spade controls;
- nothing else, so the home folder, other users' folders, other bots' workspaces, and Spade's and
  ace's data are unreachable by default. The AppContainer can't reach the person's folders at all,
  so there is no deny to apply — the credential deny-list needs no ACEs here; the word list still
  refuses a call naming a credential place first.

A run that needs any of the person's own folders (a consented project, a toolchain under
`%USERPROFILE%`) is **not** contained: it keeps the review path with the line "This needs your
folders, so Spade asks first", and Spade changes no ACLs. A brokered file-access path for the
person's folders is future work.

The grants are set on **open handles opened by walking the path one component at a time** — each
opened relative to its parent's pinned handle and refused if it is a reparse point, so no component
can be swapped for a link that redirects the grant. Ancestors are opened with traverse access only,
never `WRITE_DAC` (which a standard user lacks at `C:\`); the ACL rights are asked for only on the
final owned object. A grant is reconciled to **exact rights** (the SID's previous ACEs are removed
before the new one is set). ACLs are edited as `SE_FILE_OBJECT` and written unprotected, so an
inheritable grant on an owned root reaches existing children and revoking the root clears the
inherited ACEs on its descendants — the container never holds `WRITE_DAC`, so it can't add explicit
descendant ACEs of its own.

The command runs through `spade sandbox-exec-win <plan> <program> <args>`: the daemon spawns
Spade's own binary as the launcher with the command's stdio piped, and the launcher creates the
command inside the AppContainer, puts it in a **job object** (kill-on-close, die-on-unhandled, caps
on active processes and total memory, and UI restrictions — no clipboard read or write, no desktop
switch, no global atoms, no system-parameter or display changes — so it can't drive other apps)
before resuming it. The run only counts as ready on **per-run acknowledgements**: the launcher
assigns the command to the job and resumes it (checking the resume), and the in-container bridge
signals an inherited event once it has bound its loopback port, which the launcher waits for before
the command starts. On any failure the launcher terminates and waits for the suspended process, so
the run is contained or it does not run. Dropping the run closes the job and ends the whole tree.

**ACL hygiene (durable).** Each run records, in a per-run journal
(`<data>/sandbox-acls/<container>.json`), every object its SID is granted on **with that object's
identity (volume serial and file id, not just its path)**. The journal is written — and flushed to
disk (`FlushFileBuffers`) — *before* the profile is created and before any ACL change, so a failure
anywhere is recoverable; a guard armed right after the grants takes them and the profile back if the
rest of setup (the bridge, the plan) fails. When the run ends — after its processes are gone, so no
open handle survives revocation — its grants are taken back by identity (so a renamed or moved
folder is still found; an object counts as gone only when the id lookup reports not-found, anything
ambiguous stays pending), the profile is deleted, and the journal is removed **last**, so a crash
between them keeps the bot gated. A revocation that can't be confirmed is kept pending, reported
(not swallowed), and the **bot's next run is refused until it clears**; a corrupt or unreadable
journal is itself a blocking error that gates every bot until a person clears it. The old
`{container, paths}` journal format is migrated forward. On start the daemon recovers every run's
pending revocations. Deleting a bot takes back every run's grants and deletes its profiles.

**Network (the egress bridge).** An AppContainer with no capabilities has no DNS and can't open a
loopback connection to a process outside the container, so it can't reach the proxy directly, and
the per-container loopback *exemption* that would let it isn't port-scoped (it would open every
local port). Instead each networked run gets a bridge: a tiny process inside the container (same
SID and job as the command) listens on `127.0.0.1:<port>` — what `HTTP_PROXY` points at — and
forwards each connection over a named pipe whose DACL grants only that run's container SID to a
daemon-side acceptor, which splices it to the proxy's TCP port on loopback. The run's token still
rides in `HTTP_PROXY`, so the proxy identifies the run; the bridge and acceptor only move bytes,
and the acceptor stops when the run's ticket drops. The only way out of the container is that one
SID-scoped pipe. The acceptor makes its first pipe instance up front and **acknowledges readiness**;
the daemon waits for that and fails the run closed if the bridge can't come up, so a networked run
is never started silently without its egress boundary.

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
| `429`  | The run already has its cap of connections open (64)                         |
| `502`  | Allowed, but the name didn't resolve or the host didn't answer (within 30 s) |

**Bounds** (`egress::Limits`): at most 512 connections at once across every run, admitted before
any task is spawned (past it a new connection is closed unread); 10 s for a client to send its
request's head; 64 open per run; a tunnel with no bytes either way for 5 minutes is closed (a side
that half-closes keeps the other direction open until then). Dropping a run's ticket cancels its
session: its open tunnels close and connections still being made are abandoned.

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

**Log.** JSON lines in `<data>/egress/<bot>.jsonl`, `{at, connection, phase, bot, run, host, port,
method, allowed, reason?, sent, received}`. `phase`: `refused` or `failed` (at once), `opened` (at
admission, before any bytes), `progress` (the bytes so far, every 30 s while they change) and
`closed` (the final bytes). Bytes are counted as they move, so a run's usage is current while its
tunnels are open. `connection` ties a connection's lines together. Past 1 MiB the file becomes `<bot>.1.jsonl` and a new one starts.

## Grants

`spade_core::grant`. A grant is `{id, kind, …scope, by, created_at}`; `by` is `person` (or a
parent bot's id, once workers can pass grants down at creation).

| `kind`       | Fields              | Allows                                                    | Enforced now                                        |
| ------------ | ------------------- | --------------------------------------------------------- | --------------------------------------------------- |
| `folder`     | `path`, `write`     | The folder read-only, or read-write, in the bot's sandbox | yes, at each run                                    |
| `tool`       | `tool`, `arguments` | Calling `tool` when every named argument matches its glob | yes, at the gate                                    |
| `git_push`   | `repo`, `branch`    | Pushing matching branches of matching repos               | yes, by `git_push`                                  |
| `pr_comment` | `repo`, `own_only`  | Commenting on PRs of matching repos (only its own)        | yes, by `pr_comment`; `own_only` covers nothing yet |

Globs: `*` within a `/` segment, `**` across. A call a `tool` grant covers runs without a review
while nothing untrusted is in view; with untrusted content in view it is reviewed, the grant named
as the concern. Refused at creation: a `tool` grant for a tool that declares `pay`,
`send_as_person`, `drive`, `change_access`, `unknown` or `credential`, or declares nothing
(`effect::never_granted`, read from the bot's tool as it is now: those always go to the
person); a push grant for every branch (`*`, `**`); a folder that is relative, `/`, uses `..`,
isn't a folder, or is or holds a credential place or Spade's or ace's data.

A folder grant is stored as the folder it names (links resolved), and every folder grant up the
tree is resolved again each time grants are used, so a folder that later becomes a link out of
its parent's is dropped; each launch resolves once more when it builds the policy.

**Down the tree.** A bot's effective grants are its own for a top-level bot; for a worker, those
of its own that one of its parent's effective grants covers (`grant::within`, conservative: a
pair it can't prove is dropped), applied from the top down. The person granting a worker
something its parent lacks gets `400`. Revoking a parent's grant narrows every worker at once.

## What the gate does with it

`spade_core::effect::route` ([autonomy.md](autonomy.md), "Where a call goes"), with these facts:

- **Sandboxed** (`Runs::Sandbox`): a `shell` call, a terminal command, a service or a plugin
  server's call that runs in a sandbox holding files and network here, with the proxy
  listening. It runs with no classifier, no credential word list and no review, untrusted
  content in view or not, unless its tool declares a payment, a send or an access change, or
  reads secrets. A checkpoint is taken first when one is due; when it can't be, the call is
  reviewed instead.
- **Outside the sandbox** (`Runs::Outside`): the bot's `commands` setting is `outside`, the
  person allowed this call outside, or the machine has no sandbox. The command is classed by the
  shell classifier and takes ADR 0163's route. The gate marks the call's key, and the shell runs
  only marked calls unconfined; a setting that changes in between never moves an unreviewed call
  outside.
- **Asking to run outside** (`outside_sandbox: true` on `shell`): a request with
  `ask: outside_sandbox`. Allow once runs that call outside; Always for this bot runs it and sets
  the bot's `commands` to `outside`; Deny declines it.
- **Granted**: a `git_push` or `pr_comment` grant covers its typed tool, matched by
  `host/owner/name` (a grant written `owner/name` means GitHub); a `tool` grant covers only a tool
  that declares `read`, `write_local`, `network` or `publish`, never one that declares nothing.
- **Unprotected**: sandboxed, but the checkpoint couldn't be taken: reviewed, after the
  person-only rules.

`workspace_write` and `workspace_edit` run without a review where the sandbox holds (a
checkpoint first), untrusted content in view or not. What they write under taint still isn't
trusted (workspace.md, Trust). Routines set up under taint and notes keep their rules.

When a sandboxed command fails and its output shows the sandbox stopped it (`effect::blocked`:
`Operation not permitted`, the proxy's 403 or a name that can't resolve, an app it can't reach),
the result ends with a line telling the bot it may call `shell` again with
`outside_sandbox: true`.

## Checkpoints

`security/checkpoints.rs`. A copy of the bot's workspace at `<data>/checkpoints/<bot>/<id>/`
(`/bin/cp -c -R -p` on macOS, a clone on APFS, else a plain copy; `cp -a --reflink=auto` on
Linux; a plain recursive copy on Windows), its record `<id>.json` `{id, at, reason}` written once the copy is
whole. A folder without a record is an unfinished copy and is removed when the list is read.
`.spade/tmp` isn't kept. Taken:

- `auto`: before a sandboxed bot command, terminal command or service, or a contained file write,
  at most once a minute per bot (only one that was taken counts; in memory, so a restart may take
  one sooner). When it can't be taken, the command or write goes to the review instead, and a
  service doesn't start;
- `person`: on `POST /agents/{id}/checkpoints`;
- `before_restore`: just before a restore.

Operations on one bot's checkpoints run one at a time; a copy is made as `.stage-<id>` and
published by a rename, its record after it, so a listing never meets one in progress. Kept: the
newest 20, none older than 7 days.

A restore first reserves the bot's workspace: until it is released no turn of the bot or its
helpers starts (they wait), no contained command or file write runs, and another restore answers
`409`. Then it is refused (`409`) while the bot is working or its services run. It takes a
`before_restore` checkpoint, moves the workspace aside, copies the checkpoint in its place, and
puts the old one back if the copy fails. Consented folders aren't copied. Files a restore brings back are trusted only
where their content still matches the trust record.

## API

Under `/v1`, with the bearer token. Only the person's API writes any of this; no bot tool does.

| Method and path                             | Body                                   | Answer                                                                                                                                                                                                                                                                         |
| ------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /security`                             |                                        | `{sandbox: {platform, mechanism: seatbelt\|landlock\|app_container\|none, files, network: contained\|partial\|none, reason}, proxy: {running, problem}, contained, defaults: [host], bots: {commands, network: Policy, plugin_network: Policy}, toolchains_found: [path]}`     |
| `PUT /security/commands`                    | `{commands: sandboxed\|outside}`       | The machine's view; what bots without their own inherit                                                                                                                                                                                                                        |
| `PUT /security/network`                     | `{mode, allow?, dropped?}`             | The machine's view; `400` as for a bot's                                                                                                                                                                                                                                       |
| `PUT /security/plugin-network`              | `{mode, allow?, dropped?}`             | As above, for plugins                                                                                                                                                                                                                                                          |
| `GET /agents/{id}/security`                 |                                        | `{contained, commands, network: Policy, plugin_network: Policy, own: {commands, network, plugin_network}, toolchains: [path], grants: [Grant], effective_grants: [Grant], folders: [{grant, path, write}]}` (what holds, and whether each is the bot's own); `404` unknown bot |
| `PUT /agents/{id}/security/commands`        | `{commands: sandboxed\|outside\|null}` | The bot's view; `null` follows the machine                                                                                                                                                                                                                                     |
| `DELETE /agents/{id}/security/network`      |                                        | The bot's view, its commands following the machine's rule again (`/plugin-network` likewise)                                                                                                                                                                                   |
| `PUT /agents/{id}/security/network`         | `{mode, allow?, dropped?}`             | The bot's view, as above; `400` for an entry that isn't a host, `*.host` or `host:port`, or a dropped name that isn't a default                                                                                                                                                |
| `PUT /agents/{id}/security/plugin-network`  | `{mode, allow?, dropped?}`             | As above, for its plugins' hooks and servers                                                                                                                                                                                                                                   |
| `PUT /agents/{id}/security/toolchains`      | `{toolchains: [path]}`                 | The bot's view; `400` for a path that isn't an absolute folder or holds sign-ins or data                                                                                                                                                                                       |
| `GET /agents/{id}/security/egress`          | `?limit=` (1–5,000, default 200)       | `{entries: [Entry]}`, oldest first                                                                                                                                                                                                                                             |
| `GET /agents/{id}/grants`                   |                                        | `{grants: [Grant], effective: [Grant]}`                                                                                                                                                                                                                                        |
| `POST /agents/{id}/grants`                  | `{kind, …scope}`                       | `201 {grant}`; `400` refused (why); `404` unknown bot                                                                                                                                                                                                                          |
| `DELETE /agents/{id}/grants/{grant}`        |                                        | `204`; `404` no such grant                                                                                                                                                                                                                                                     |
| `GET /agents/{id}/checkpoints`              |                                        | `{checkpoints: [{id, at, reason}], keep: 20, longest_days: 7, every_seconds: 60}`, newest first                                                                                                                                                                                |
| `POST /agents/{id}/checkpoints`             |                                        | `201 {checkpoint}`; `400` when the workspace doesn't exist yet                                                                                                                                                                                                                 |
| `POST /agents/{id}/checkpoints/{c}/restore` |                                        | `200 {restored, saved}` (`saved`: the checkpoint taken just before); `404` no such checkpoint; `409` the bot is working                                                                                                                                                        |

Settings are one stored setting per bot, `security:<bot id>`, and the machine's defaults,
`security.machine`; a value that doesn't parse reads as the defaults. A bot's own value wins; a
stored network policy equal to the built-in default (every earlier build wrote one) reads as
following the machine. A change holds from the bot's next run.

## What the UI shows

**Settings › Spade › Security** (the machine): the sandbox line; Commands, `Sandboxed` or
`Outside the sandbox`, with one line about what Outside means; the network rules for commands
and plugins every bot follows unless it sets its own, editable; the sites listed by default.

**The bot's profile, Details › Security**: Commands (`Same as this Mac`, `Sandboxed`, `Outside
the sandbox`); each network rule marked as its own or the Mac's, with a way back to the Mac's;
consented folders, toolchains, grants, network activity and checkpoints as before.

**Requests**: `ask: outside_sandbox` shows "Run this outside the sandbox?" with the command and
Allow once, Always for this bot, Deny; `ask: undeclared` shows Allow and Deny, since the answer
is kept for the bot and tool.

## Not built yet

- A size bound on checkpoints (count and age only today; clones cost little on APFS, plain
  copies on other volumes don't).
- Linux's seccomp filter (UDP, raw and Unix sockets), the next phase (ADR 0171 decision 6): once
  it counts as contained, its commands skip the classifier and the review as macOS's and
  Windows' do. (Windows' AppContainer is built; see below.)
- Per-value provenance at egress, `derived` trust for network-off runs (each run's proxy usage
  is already counted), and quarantined readers.
- CLI brains in the sandbox (ADR 0133 keeps them on their own read-only modes).
- A publish tool of Spade's own (packages, releases): publishing is a declared effect of
  connector and plugin tools, or a command outside the sandbox.
- ace's plugin import carrying a server's `effects` declaration (ace's `PluginExecution` is
  strict); Spade reads it once it does.
- `own_only` for `pr_comment` grants (whether the bot opened the pull request).
