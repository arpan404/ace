# 0167: Spade's security boundaries

Status: accepted; amended 2026-11-17 (amendment 1: Linux). Date: 2026-11-15. Decided by: the
owner (2026-11-15: the capability waves are done; add security at the real boundaries so the
blanket asks can go). From the Spade harness
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
     made. This is designed and stubbed: the runner reports `unavailable` on Windows, which keeps
     today's reviews (decision 9).

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

## Amendment 1: Linux's sandbox, as built (2026-11-17)

Replaces the Linux bullet of decision 1, the Linux part of decision 9 and the last consequence.
Linux counts as `contained` only when files, network and signals are held. Only then does
ADR 0171's sandboxed path (no classifier, no reviewer) apply there as on macOS.

1. **The launcher stays outside as the run's supervisor.** `spade sandbox-exec <plan> <program>
<args>…` carves the plan's roots (opening each place it grants), lowers its limits, and starts
   one thread that applies Landlock and a seccomp filter to itself alone and then starts the
   command, which inherits both. The launcher's other threads answer the filter and forward
   terminal and stop signals to the command's private process group.
   adopt what the command leaves running (`PR_SET_CHILD_SUBREAPER`) and end with the command's
   own exit code or signal. Spade forbids `unsafe`, so the work is done through crates: `landlock`,
   `libseccomp` (bindings to the system's libseccomp 2.5 or later, LGPL, linked dynamically),
   `rustix` and `signal-hook`.
2. **Files: Landlock at the highest ABI the kernel offers.** Read-write: the workspace, its
   `.spade/tmp`, folders granted for writing, a terminal's state files, `/dev/null`, `/dev/zero`,
   `/dev/tty`, `/dev/pts`. Read-only: the system's folders (`/usr`, `/bin`, `/sbin`, `/lib*`,
   `/etc`, `/opt`, `/nix`, `/snap`, `/var/lib`, `/proc`, `/sys`, `/dev`), confirmed toolchains,
   folders granted for reading and a plugin's own folder. Nothing else. Landlock can't deny inside
   an allowed folder, so a folder holding a deny-list place is carved: opened child by child
   without following links, links skipped, a child that is a denied object (same device and
   inode) left out. A file met while carving that has more than one name is left out too: a rule
   on a file holds its inode, so granting a hard link would open every other name of it,
   `~/.ssh/id_ed25519` included. On ABI 4 and later TCP connects are allowed only to the proxy's
   port, and on ABI 6 and later signals and abstract Unix sockets stay inside the sandbox. The
   ABI in force is in the sandbox status (`landlock_abi`).
3. **Network: a seccomp filter and its supervisor.** Landlock's TCP rule holds a port, not an
   address, and seccomp can't read an address behind a pointer. So the filter sends every
   `connect`, `bind` and `listen` to the launcher. It reads the address from the command's memory,
   decides, takes the command's socket (`pidfd_getfd`) and makes the call itself, with the address
   it judged, never continuing the command's own call. A thread that rewrites the address after
   it was read changes nothing. What is allowed: TCP to `127.0.0.1:<proxy port>` and `[::1]` (as
   `::ffff:127.0.0.1`), binds on loopback, `listen` on a socket bound on loopback, and Unix
   sockets in the workspace, reached through `/proc/self/fd` after a walk that opens each folder
   without following a link. Everything else is `EPERM`. The filter itself refuses: sockets
   other than TCP and Unix stream or seqpacket (no UDP and so no DNS, no raw, packet or netlink
   sockets, no Unix datagrams, which could be sent to any socket by path), `MSG_FASTOPEN`,
   `ptrace`, `process_vm_*`, `pidfd_getfd`, `bpf`, `perf_event_open`, `userfaultfd`, the key
   calls, `io_uring` (its operations skip seccomp), `mount` and the new mount calls, `pivot_root`,
   `chroot`, `unshare`, `setns`, namespace flags on `clone` (`clone3` answers `ENOSYS`, so the C
   library falls back), modules, `kexec`, `reboot`, `swap`, `TIOCSTI` and `TIOCLINUX`, a nested
   seccomp listener (which would answer for itself), and `truncate` by path below Landlock ABI 3.
   A call made through another architecture's ABI kills the process. `no_new_privs` is set, the
   open-file limit is at most 65,536 and the task limit is what the machine runs now plus 4,096.
4. **Apps.** Nothing on a Linux desktop starts or drives an app without the session bus or the
   display server, and both are sockets outside the workspace (`$XDG_RUNTIME_DIR/bus`,
   `wayland-0`, `/tmp/.X11-unix/X0`) or in the abstract namespace. All are refused, and the
   built environment carries none of `DBUS_SESSION_BUS_ADDRESS`, `DISPLAY`, `WAYLAND_DISPLAY` or
   `XDG_RUNTIME_DIR`. So `xdg-open`, `gio open`, `notify-send` and `systemd-run --user` fail.
   There is no grant for the bus or the display yet. A tool that needs them runs outside the
   sandbox (ADR 0171 decision 5).
5. **The probe and the fallbacks.** At start Spade runs a real sandbox through the launcher on a
   throwaway folder: the check inside writes in its workspace and not beside it, reaches a
   listener standing in for the proxy, and can't open a UDP socket. If that holds, the status is
   `contained`. If only Landlock holds (the filter can't load, or Yama's `ptrace_scope` 2 or 3
   stops the supervisor), runs use Landlock alone, the network is `partial` (ABI 4 and later) or
   `none`, and commands keep their reviews. Without Landlock (a kernel that lacks it or doesn't
   enable it, as Docker Desktop's), the sandbox is unavailable and nothing changes. Each case
   says why in one sentence.
6. **What it doesn't hold.** `/proc` stays readable, so the command lines and status of the
   person's other processes are visible (their memory, environment, files and working folders
   are not: Landlock refuses ptrace access to processes outside the sandbox). Below ABI 6,
   signals require the private PID namespace described below. A hard link to a credential the person
   put inside a folder granted whole reads as that folder's file (as on macOS). Builds need
   `libseccomp-dev` and the machine needs `libseccomp.so.2`, which Ubuntu, Debian, Fedora and Arch
   ship as part of systemd.

### Hardening before Linux ships

- Files require Landlock ABI 3 or newer, which adds the truncate right. ABI 1 and 2
  report `files: partial` with a plain reason and retain command reviews. Refusing the
  path-based `truncate` syscall alone does not contain `open(O_TRUNC)` or `ftruncate`.
- The supervisor refuses AF_UNSPEC connects. It duplicates the socket, keys a shared lock
  by its device and inode from `fstat`, and holds that lock from the address check through
  the operation. A successful supervised bind records permission to listen. `listen`
  requires that record and checks `getsockname` under the same lock. Unix sockets must
  likewise have been bound by this supervisor in the workspace. Retained descriptors
  prevent inode reuse from inheriting permission; the descriptor limit bounds this state
  and exhaustion refuses further operations.
- PID-targeted resource and scheduling calls are notified and continued only for PID 0 or
  the caller's process ID or, for task targets, its notifying TID. `setpriority` and
  `ioprio_set` permit only process selectors,
  never groups or users; `kcmp` checks both PIDs. `setrlimit` has no target PID and already
  acts only on the caller. `process_madvise` is refused entirely: checking an fd and then
  continuing would race the caller's fd table. No pointer or fd-based target is continued.
- Below Landlock ABI 6, a filtered launch first starts util-linux `/usr/bin/unshare` with a
  private user, PID and mount namespace and a fresh `/proc`. It maps the person's current
  UID, forks the launcher as namespace init, and kills that init if unshare dies. This happens
  before confinement. The supervisor reaps the namespace's children. PID namespaces make
  outside processes unaddressable by signal calls, including queued signals, with the session
  separation below for process-group signals. This avoids pidfd emulation of thread signals. The filter prevents further namespace changes.
  ABI 6 and newer use Landlock signal scoping instead, without requiring user namespaces.
- The real filtered probe exercises the same namespace setup on old kernels. If user
  namespaces, util-linux or its mount setup are unavailable, it fails and falls back to
  Landlock alone: `signals: partial` below ABI 6, and reviews remain. `contains()` requires
  all three coverage fields to be contained and Linux ABI at least 3. A filtered launch
  retries setup on every run and refuses to start the command if it fails.

### Session and process lifecycle hardening

1. **Separate sessions on every ABI.** PID namespaces do not by themselves detach an inherited
   host process group. Namespace PID 1 must successfully call `setsid` before confinement or
   command startup. Every command also starts through util-linux `/usr/bin/setsid`, which calls
   `setsid` in the launcher's freshly spawned child before exec. This avoids an unsafe Rust
   `pre_exec` hook and applies on ABI 6 and newer as well. Failure starts no command. The launcher
   forwards `SIGINT`, `SIGQUIT`, `SIGTERM` and `SIGHUP` to the new command group because the
   command no longer belongs to its terminal's original session. Interrupts are forwarded
   without escalation so a shell may handle them normally.
2. **Stop the tree, not unshare's waiting parent.** Below ABI 6, init transfers its own pidfd
   over a private Unix socket before starting the command. The outer launcher verifies the
   peer is unshare's child and the pidfd names that peer, unlinks the socket, and acknowledges
   receipt. Startup fails if this handshake fails. Stop signals go straight to init through
   that host-side pidfd, independent of util-linux signal-forwarding support. After 500 ms,
   TERM or HUP escalates to killing namespace init, which kills every descendant.
3. **Reap before reporting done.** On every ABI, TERM or HUP first reaches the command group;
   after 250 ms the launcher kills the leader through a pre-opened pidfd and kills owned
   children. As a subreaper it repeatedly kills and reaps adopted children until `ECHILD`,
   including descendants that changed session or ignored TERM. Normal command exit drains
   remaining descendants too. Proc directories are pinned before pidfd acquisition and PPid
   is checked through the pinned directory, so a reused PID cannot select a host process.
   `waitid(WNOWAIT)` and a shared forwarding lock keep the leader unreaped until group-signal
   forwarding is disabled. SIGCHLD reaps other adopted children while the command runs.
4. **Leave shutdown descriptors available.** Retained socket entries use at most one quarter
   of the launcher's fd limit, capped at 4,096. Concurrent notification workers are bounded
   against that limit too, capped at 32. Excess calls return EAGAIN. This keeps pidfd and proc
   operations available for cleanup, including when a run has a 64-fd limit.
5. **Audit all PID/TID effects.** `sched_setattr` joins the other supervised scheduling writes.
   Resource, scheduling, nice and I/O-priority task targets may name zero, the current process,
   or the notifying thread, never an arbitrary sibling TID. Only process selectors are allowed
   for priority calls. Both `kcmp` targets must be positive self IDs. `pidfd_open` accepts the
   caller's positive process ID without PIDFD_THREAD, or the notifying TID with PIDFD_THREAD; NONBLOCK
   is optional. Zero and unknown flags are refused. Older kernels may return EINVAL for an
   otherwise permitted thread-handle request. `process_mrelease`, `migrate_pages` and
   `move_pages` are refused outright, alongside `process_madvise`, `pidfd_getfd`, ptrace and
   process_vm calls. An unknown critical syscall name fails the filter probe. Read-only
   sched_getattr/getparam/getscheduler/getaffinity/rr_get_interval, getpriority, ioprio_get,
   getpgid/getsid and get_robust_list remain allowed. The kernel restricts wait calls to
   children and setpgid to self/children in the same session; signal calls remain subject to
   Landlock scoping or the private PID namespace and session.
