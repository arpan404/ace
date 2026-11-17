# 0167: Spade's security boundaries

Status: accepted. Date: 2026-11-15. Decided by: the owner (2026-11-15: the capability waves are
done; add security at the real boundaries so the blanket asks can go). From the Spade harness
audit (part C, the security model; wave 1 and the security items of wave 4) and its research
notes (topic 5). Amends [ADR 0130](0130-spade-skills-and-workspace.md) (the shell's rules),
[ADR 0142](0142-a-bots-computer.md) (what a bot's commands run in) and
[ADR 0144](0144-spade-autonomous-bots.md) decision 5 (the sandbox it promised), as amended by
[ADR 0163](0163-spade-auto-review-only.md). Keeps [ADR 0161](0161-spade-orchestration-trees.md)'s
rule that a worker never has more than its parent and
[ADR 0166](0166-spade-has-no-spending-limits.md) (no spending limits). The contract is in
[spade/docs/security.md](../../spade/docs/security.md).

## Context

Every Spade bot runs on the auto-review (ADR 0163). Today the shell classifier, a word list for
credentials and the reviewer are the only things between a bot and the person's machine, and ADR
0144 says so plainly: the classifier is a guard rail, not a sandbox. So every shell command goes
to the reviewer, a turn that read untrusted content is held for every write after it, and shell
output taints the turn that ran it. A coding bot working for a week pays a review for each
`cargo test` and is under taint from its second command on.

The audit names six real boundaries: credentials; the person's machine and data outside what they
consented to; external and irreversible actions; money; prompt injection steering a bot into any
of these; and the integrity of agent state. Writing files in the bot's own folder, running builds
or starting helpers isn't one of them. Those calls are gated today only because the real
boundaries aren't enforced where they live. The research is consistent that an OS sandbox with
proxied egress is the one layer that holds whatever the model is talked into doing, and that
filesystem and network isolation are both required.

## Decision

1. **Each bot's commands run in an OS sandbox.** That covers everything Spade starts for a bot:
   `shell` in the one-shot shell and in each terminal session, owned services (ADR 0160), plugin
   hooks and plugin MCP servers (ADR 0151). The person's own shell in the bot's terminal is theirs
   and isn't sandboxed. One crate, `spade-sandbox`, turns a policy into a launch, and it's the
   only place Spade branches on the platform for this. Every platform gets the same policy:
   - **read-write:** the bot's workspace; its own temporary folder `.spade/tmp` inside it (set as
     `TMPDIR`); the person's consented folders granted for writing (decision 5); `/dev/null`,
     `/dev/zero`, the terminal and `/dev/fd`;
   - **read-only:** the system; toolchain folders the person confirmed for the bot (each one's
     `bin` joins `PATH`); consented folders granted for reading; a plugin's own folder for its
     hooks and servers;
   - **no read:** the person's home folder, apart from the above; every other bot's workspace;
     Spade's and ace's data; and the credential deny-list (decision 2), which comes last so no
     other rule opens it again;
   - **network:** none, except TCP to Spade's egress proxy on loopback (decision 3). Commands may
     listen on loopback, so a dev server can run. Other processes can't be reached through
     their sockets. There's no DNS, so a lookup can't carry data out.

   The platforms:
   - **macOS: Seatbelt.** A profile generated per run, passed to `/usr/bin/sandbox-exec -p`. It
     denies by default and allows process, signal and sysctl reads within the sandbox, plus the
     few system services a command needs (directory lookup, logging, notifications). There are
     no Apple Events and no LaunchServices, so `osascript` can't drive an app and `open` can't
     start one outside the sandbox. `sandbox-exec` is deprecated, but it's the only public way
     in without FFI, and Spade forbids `unsafe`. Spade probes it when it starts. If the probe
     fails, the sandbox is unavailable (decision 9).
   - **Linux: Landlock.** Built behind the `landlock` feature. Spade starts its own binary as a
     launcher (`spade sandbox-exec <policy>`), which applies a Landlock ruleset to itself and then
     runs the command. File rules come from the policy. On ABI 4 and later, TCP connects are
     allowed only to the proxy's port. Landlock doesn't cover UDP, raw or Unix sockets, so the
     network boundary also needs a seccomp filter that refuses those socket families. Until that
     filter exists, Linux reports `network: partial`, and decision 8 doesn't apply there.
     Bubblewrap was considered. It needs user namespaces, which some distributions turn off, and
     a socket bridge to reach the proxy, so it's a fallback for later, not the first build.
   - **Windows: AppContainer.** Each bot gets an AppContainer profile with no capabilities. Its
     workspace and consented folders get ACLs for the container's SID, and the existing job
     object holds and ends everything the command starts. Loopback is blocked for AppContainers by
     default. The proxy is reached through a loopback exemption for that one profile. A
     restricted token with a low integrity level is the fallback where AppContainer can't be
     made. This is now built (see the amendment below, which corrects the egress mechanism: a
     loopback exemption isn't port-scoped, so a per-run named-pipe bridge carries the network
     instead). Windows reports `contained` when an AppContainer, the job and the proxy are all
     up, so decision 8's dropped reviews apply there too.

2. **A credential deny-list backs the word list.** These places are denied for reading in every
   sandbox, whatever else is allowed:
   - SSH, GnuPG and `pass` stores: `~/.ssh`, `~/.gnupg`, `~/.password-store`;
   - cloud CLI configs: `~/.aws`, `~/.azure`, `~/.config/gcloud`, `~/.kube`, `~/.oci`,
     `~/.docker/config.json`;
   - git and package tokens: `~/.netrc`, `~/.git-credentials`, `~/.config/gh`, `~/.config/hub`,
     `~/.npmrc`, `~/.yarnrc.yml`, `~/.pypirc`, `~/.gem/credentials`, `~/.cargo/credentials` and
     `~/.cargo/credentials.toml`, `~/.terraform.d/credentials.tfrc.json`;
   - coding-agent sign-ins: `~/.codex`, `~/.claude`, `~/.claude.json`, `~/.config/opencode`,
     `~/.local/share/opencode`, `~/.cursor`, `~/.gemini`, `~/.config/github-copilot`;
   - keychains and secret stores: `~/Library/Keychains`, `/Library/Keychains`,
     `~/.local/share/keyrings`;
   - ace's data (`~/.ace`), Spade's data folder (its database, tokens, keys, the trust record),
     and every bot's workspace but the bot's own.

   The list is one value in `spade-sandbox`, tested against the profiles it produces. The word
   list in `spade_core::autonomy::secrets` stays as a second line and still refuses a call that
   names these places, before anything runs, on every level.

3. **A local egress proxy carries every connection a sandboxed command makes.** Spade listens on
   one loopback port. Each sandboxed run gets a fresh session token, which reaches the command
   only through `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY` (and their lowercase forms, plus
   `NODE_USE_ENV_PROXY=1`), as `http://spade:<token>@127.0.0.1:<port>`. The proxy accepts
   `CONNECT host:port` and absolute-form HTTP requests. A request with no live token gets `407`.
   The token names the bot, the run and the policy.
   - **Policy per bot.** The `mode` is `off`, `allow_list` (the default for a bot's commands) or
     `open` (any public host, the default for plugin servers, which the person installed). In
     `allow_list`, a host is allowed when it matches the defaults or the person's additions:
     exact names, or `*.example.com` for subdomains. The person can drop any default.
   - **Defaults suited to dev work.** Package registries (npm, Yarn, PyPI, crates.io, Go modules,
     RubyGems, Maven Central, Packagist, NuGet, Hex, pub.dev, CocoaPods, Homebrew bottles) and git
     hosts (GitHub and its content hosts, GitLab, Bitbucket, Codeberg, sourcehut).
   - **Private addresses.** Loopback, private, link-local and unique-local addresses are refused,
     including when a public name resolves to one (DNS rebinding). The only exception is an entry
     the person wrote that names such a host literally (`localhost:3000`).
   - **Logging.** Every connection is logged per bot: when, the run, host, port, method, allowed
     or why refused, and bytes each way. The log is kept on disk, bounded (it rolls over at
     1 MiB, keeping one older file), and readable over the API.
   - **Stricter policy.** A run can be given a stricter policy than its bot's. Quarantined readers
     (decision 7) get `off`.

4. **Credentials never enter the sandbox.** The built environment carries none of Spade's
   secrets (kept from ADR 0130). The deny-list keeps the person's credentials out of reach. The
   proxy passes TLS through end to end and never sees or adds an `Authorization` header. An
   outward action that needs the person's sign-in (a push, a comment, a send) goes through a
   Spade, ace or connector tool that holds the credential outside the sandbox. That tool is
   gated by grants (decision 5) and the review. Otherwise the bot asks the person. Injecting
   tokens at the proxy would mean ending TLS there with a Spade root trusted inside the sandbox.
   That's left for later, for plain token APIs only, and would be a new decision.

5. **Scoped capability grants for outside actions.** A grant is
   `{id, kind, scope, by, created_at}`, made by the person (`by: person`) or passed down by a
   parent (`by: <parent bot>`). The kinds:
   - `git_push {repo, branch}`: push only to matching branches (`spade/*`) of matching repos;
   - `pr_comment {repo, own_only}`: comment on pull requests in a repo, or only on ones the bot
     opened;
   - `folder {path, write}`: a consented project folder, read-only or read-write in the sandbox;
   - `tool {tool, arguments}`: one tool, with each named argument matching a pattern.

   Patterns are globs: `*` matches within a segment, `**` across `/`. A call a grant covers runs
   without a review while no untrusted content is in view. Under taint it's still reviewed, with
   the grant named as context, until per-value provenance (decision 6) can show that none of its
   arguments came from untrusted text. Some calls are never granted, and they always go to the
   person: a payment, sending as the person, and changing sign-ins, keys or access. The API
   refuses such a grant. Sending these straight to the person at the gate also needs a
   classification that can tell ace's `agent_message` to a bot's own worker from a message to
   someone else. Until that exists, they keep ADR 0163's route: the reviewer is told the
   concern, and a bot that retries a refused one reaches the person. Grants pass down as subsets. A worker's effective grants are its own,
   kept only where a grant of its parent covers them, applied up the tree to the top. So a
   person who narrows or revokes a parent's grant narrows every worker under it at once. The
   person may give a worker its own grants, but they never exceed the parent's.

6. **Trust by origin, and taint that gates egress only.**
   - Taint stops gating work the sandbox contains: a sandboxed command runs unreviewed whether or
     not untrusted content is in view (decision 8). Taint still gates outward calls, grants,
     standing work (routines) and notes, as before.
   - Next comes per-value provenance at egress. When an outward call is made under taint, Spade
     marks each argument span that matches untrusted text in view (substrings and word n-grams,
     computed without a model). Matched spans go to the person; the rest goes to the reviewer
     with the matches named. Files get origins too: a file written by a sandboxed run whose proxy
     log shows no bytes sent or received is `derived` and trusted when its inputs were. Network
     runs, downloads and files the person dropped stay untrusted. The engine records each run's
     egress summary, so this follows without another boundary.

7. **Quarantined reading.** Untrusted pages, emails and app output can be read by a tool-less
   helper. It has no grants and network `off`, and it returns typed data: the schema the planner
   asked for (facts, URLs, numbers), never free text. The planner's view stays clean, and raw text
   reaches it only when it asks, which taints it. It's built on helpers (ADR 0152) and model
   routing (ADR 0162) in a later step.

8. **What these boundaries remove, once built and tested.**
   - **Per-command shell reviews, where the sandbox contains the command.** When a bot's sandbox
     contains both files and network on this machine (`contained`), a `shell` call runs with no
     review. That holds when the classifier found nothing, and when its finding is one the
     sandbox now enforces: network, writes or deletes outside the folder, driving other apps, a
     command it can't read, or a script it can't show. Taint doesn't change this. Findings whose
     effect could travel through an allowed path still go to the reviewer, with the rule as its
     concern: publishing, changing a server, mail, payments and admin rights. A credential read
     is still refused before anything runs.
   - **Checkpoints, then the review of inside work under taint.** Before a run that isn't
     reviewed, Spade snapshots the workspace (copy-on-write where the file system allows), at
     most once a minute. It keeps the newest 20 for at most 7 days (a size bound for volumes that can't clone
     comes later). The person
     can list them, take one and restore one; a restore first snapshots the current state.
     Consented folders aren't snapshotted: they're the person's, often under their own version
     control, and a copy of a whole project per minute isn't bounded. Once checkpoints are in
     place, file writes in the workspace under taint run without a review too. Until then they
     keep it.

9. **Platform fallbacks.** Without the sandbox (Windows today; Linux without Landlock, or with
   network `partial`; macOS where the probe fails), commands run as they do today and every
   review above stays. Spade reports why in the sandbox status. A failure to confine one run on a
   machine where the sandbox is available fails that run, so it never runs unconfined. It fails
   closed.

10. **Settings and API.** The person sees and changes, per bot: the network policy (mode,
    defaults, additions), consented folders, toolchains, grants (and a worker's effective ones),
    checkpoints, and the egress log; and, for the machine, the sandbox status. All of it is under
    `/v1`, in [spade/docs/security.md](../../spade/docs/security.md). Only the person's API
    writes it. No bot tool changes a policy, folder, toolchain or grant. The UI is Settings ›
    Spade › Security and the profile's Details, and it's built separately.

## Options considered

- **Keep the classifier and the reviewer as the containment.** A shell can do more than any
  reading of its words follows (`python -c`, a build script, a package's install hook). The
  research and the audit agree a model or a word list isn't a boundary.
- **Network off entirely for commands.** Safer, but a coding bot can't install a dependency.
  The allow-list keeps the common case working and logs every connection.
- **One proxy port per bot** instead of tokens. Port-per-bot identifies the bot without a header,
  but it costs a listener per bot, and a stale port could be reused by a later bot. Per-run
  tokens also tell each run's egress apart, which provenance needs.
- **MITM TLS at the proxy** to filter methods and paths, or to inject tokens. It puts a Spade root
  in every sandbox and holds the person's tokens in the request path. Destinations by host plus
  grants at the tool boundary cover the need without it.
- **Bubblewrap first on Linux.** See decision 1. User namespaces aren't always available, and the
  proxy needs a bridge.

## Consequences

- On macOS, a bot's commands, services and plugin servers can't read the person's files,
  credentials or other bots' folders, can't write outside the workspace and consented folders,
  and reach the network only through hosts the policy allows. A shell call the sandbox contains
  runs without a review.
- Toolchains under the home folder are invisible until the person confirms them for the bot.
  Package caches under `~` are rebuilt inside the workspace. A tool that ignores proxy variables
  has no network.
- A plugin server that reads files outside its folder, or reaches the network without honouring
  proxy variables, stops working until the person grants a folder or the server honours them.
  The egress log names refused hosts, so the person can add them.
- Linux and Windows keep today's reviews until their boundaries are complete and tested.

## Tests

- `spade-sandbox`: tables for profiles, policies, the deny-list and host matching.
- macOS process tests run small real commands under the generated profile: writes in and out of
  the workspace, credential and home reads, other bots' folders, direct network and the proxy,
  Apple Events, and hard links out.
- The proxy is tested against real local listeners: allowed and refused hosts, missing tokens,
  private addresses, `CONNECT` and plain HTTP, and the log.
- `spade_core::grant` gets tables for matching and subsets.
- The engine is tested through the API: a contained shell call runs unreviewed, and a call that
  isn't contained, or one with a kept finding, is still reviewed.

## Amendment: Windows' sandbox is built (2026-11-17)

Decision 1's Windows bullet is now built (`spade-sandbox-windows` for the system calls,
`spade-sandbox::windows` for the policy and launch, `spade-server` for the wiring). Building it
on a real Windows 11 machine changed one thing in the design and firmed up the rest.

- **The egress bridge, not a loopback exemption.** Decision 1 said the proxy would be reached
  "through a loopback exemption for that one profile". Measured on Windows: an AppContainer with
  no capabilities cannot open a loopback connection to a process outside the container at all, and
  the loopback *exemption* that would let it is **per AppContainer and not port-scoped** — enabling
  it opens every local port to the command, not just the proxy's, and it is a machine-wide,
  admin-only developer setting. That is the opposite of "network only through the proxy", so it is
  rejected (the task anticipated this and asked for a justified choice). Instead each networked run
  gets a **named-pipe bridge**: a tiny bridge process runs *inside* the container (same SID and
  job as the command), listening on `127.0.0.1:<port>` — what `HTTP_PROXY` points at — and
  forwarding each connection over a named pipe whose DACL grants only that run's container SID to a
  daemon-side acceptor, which splices it to the real TCP proxy on loopback. The command can reach a
  listener inside its own container and can open the SID-scoped pipe (both verified), but nothing
  else: there is no DNS and no loopback to any other local service, so the only way out is the one
  pipe, and the run's proxy token still rides in `HTTP_PROXY` so the proxy identifies the run. A
  named pipe is used rather than an `AF_UNIX` socket because `tokio` supports a named-pipe server
  with a raw security descriptor directly, and because the pipe's DACL is the natural place to name
  the one SID allowed to connect.
- **Files.** The AppContainer denies everything by default (no capabilities), so the policy is all
  grants: the run's container SID gets an inheritable *Modify* ACE on the workspace, the run's temp
  folder, granted read-write folders and Spade's own per-run scratch, and a *Read & execute* ACE on
  toolchains, granted read-only folders and the plugin folder. The Modify and Read masks leave out
  `WRITE_DAC`/`WRITE_OWNER`, so a command can't rewrite an ACL to reopen a denied place.
- **The job.** The process tree runs in a job object with kill-on-close and die-on-unhandled, a
  cap on active processes and total memory, and UI restrictions (no reading or writing the
  clipboard, no desktop switch, no global atoms, no system-parameter or display changes, no handle
  inheritance across the boundary), so a sandboxed command can't drive another app's windows.
  Dropping the run closes the job and ends the whole tree, the bridge included.
- **Building.** Spade builds for Windows. On ARM64 the aws-lc/ring dependencies need `clang`, which
  the test machine lacks, so the build and the tests use the `x86_64-pc-windows-msvc` target (which
  runs under emulation); native ARM64 is a toolchain follow-up, not a code change. The one crate
  that uses `unsafe` is `spade-sandbox-windows`; the rest of Spade keeps `unsafe` forbidden.

Linux is unchanged: it still reports `network: partial` until its seccomp filter lands.

### Hardening (2026-11-17)

Two security reviews of the Windows build asked for six changes before it may report `contained`:

- **Grants land on exactly the approved object.** A grant's path is walked one component at a time,
  each opened relative to its parent's pinned directory handle and refused if it is a reparse point
  (a symbolic link or junction). So no component of the path can be swapped for a link that
  redirects the ACE, and the ACE is set on that pinned handle.
- **Reconciled to exact rights.** A grant removes the SID's previous ACEs on the object before
  setting the new one, so a folder changed from read-write to read-only no longer keeps Modify.
  Staleness is judged by path *and* rights.
- **Correct inheritance.** ACLs are edited as `SE_FILE_OBJECT` (not `SE_KERNEL_OBJECT`) and written
  `UNPROTECTED`, so an inheritable grant propagates to existing children and revoking a parent
  removes the inherited ACEs on its descendants. A moved file keeps its ACE (Windows doesn't
  re-evaluate on move) and is cleaned up by file id; a hard link shares one ACL, so revoking by any
  name clears it. A denied place is the exception: because an AppContainer's check grants the
  package SID on *any* allow ACE — a deny does not out-rank an inherited allow as it does for a
  normal token — a deny stops the node inheriting, removes the SID's allow and leaves a protected,
  inheritable deny, so the place is truly unreachable even inside a granted folder.
- **Per-run identity.** Each run gets its own AppContainer profile (derived from the bot and the
  run id) holding only that run's grants, so a plugin's extra folders can't be reached by the bot's
  other running commands. The profile is deleted when the run ends. Because open handles survive
  revocation, a run's grants are taken back only after its processes are gone (the run's hold is
  dropped once the command has finished).
- **Durable revocation.** The journal records each object's identity (volume serial and file id,
  not just its path) and is written as intent *before* any ACL change, so a crash mid-apply is
  fully recoverable. A revocation finds the object by id even after it is renamed or moved, keeps
  any revocation it can't confirm pending, refuses the bot's next run until cleanup succeeds, and
  reports the failure rather than swallowing it. Recovery at start retries every run's pending
  revocations.
- **Status honesty.** `contained` reflects the layers actually running: the egress-bridge acceptor
  makes its first pipe instance up front and acknowledges readiness, and the daemon fails the run
  closed when the bridge can't come up rather than running it silently without network; the
  launcher puts the command in its job before resuming it (killing it if it can't), and always
  creates it in the AppContainer, so a run that bypasses review is contained or it does not run.

### Narrowing to Spade-owned folders (2026-11-17)

A third review found that editing ACLs on the person's own folders is hard to do safely — it
touches other principals' inheritance and descendant identities. So the design narrowed: **Spade
never edits ACLs on folders it doesn't own**, and this supersedes the "Correct inheritance" deny
mechanism above (`deny_node` and all deny ACEs are removed).

- **Contained means Spade-owned.** Windows reports `contained` only for runs whose writable and
  readable grants are folders Spade owns under its own data directory — the workspace, its temp
  folder, the terminal scratch, and a plugin folder that lives there. Toolchains are read without
  any ACL change: they are already readable by `ALL APPLICATION PACKAGES` (`Program Files`,
  `Windows`) or are copies Spade controls. A run that needs any of the person's own folders (a
  consented project, a toolchain under `%USERPROFILE%`) is **not** contained: it keeps the review
  path, with a plain status line ("This needs your folders, so Spade asks first"), and Spade
  changes no ACLs. The AppContainer has no access to the person's folders by default, so there is
  nothing to deny — the credential deny-list needs no ACEs here. A brokered file-access path for
  the person's folders is future work.
- **Revocation within owned trees is complete.** Only the owned roots are granted, inheritably;
  descendants are covered by inheritance, never by explicit ACEs (the container has no `WRITE_DAC`
  to add any). Revocation takes back each root by its file id, and cleanup restores the folder
  exactly — its protection and inheritance are never changed, since denies and protection are gone.
  An object counts as deleted only when the id lookup reports not-found; anything ambiguous stays
  pending.
- **Minimal traversal access.** The pinned walk opens `C:\` and the other ancestors with traverse
  and read-attributes access only, never `WRITE_DAC` (which a standard user lacks there); the ACL
  rights are asked for only on the final owned object — verified by a test run as a standard,
  non-admin user.
- **A durable, honest journal.** The journal is flushed to disk (`FlushFileBuffers`) before any ACL
  change; a corrupt or unreadable journal is a blocking error that gates every bot until a person
  clears it, never silently dropped; the earlier `{container, paths}` format migrates forward.
- **Rollback owned from the start.** The journal (naming the profile to be created) is written
  before the profile is created and before the bridge starts, and a guard is armed right after the
  grants, so a failure anywhere below takes the grants and the profile back. Cleanup revokes the
  grants and deletes the profile before removing the journal **last**, so a crash between them keeps
  the bot gated until a clean pass; failed setup gates the bot's next run.
- **Per-run acknowledgements.** The in-container bridge signals an inherited event once it has bound
  its loopback port, and the launcher waits for that before it lets the command start; the launcher
  assigns the command to its job and resumes it (checking the resume), and on any failure
  terminates and waits for the suspended process. A missing acknowledgement fails the run closed,
  so `contained` for a run rests on the layers that actually came up, not only the start-up probe.
