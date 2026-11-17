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
Linux counts as `contained` only with Landlock ABI 3 or newer and contained files, network,
signals, syscalls, devices, IPC and processes. Only then does ADR 0171's sandboxed path (no classifier,
no reviewer) apply there as on macOS.

1. **Keep the launcher outside the command's restrictions.** `spade sandbox-exec <plan>
<program> <args>…` carves and opens the plan's roots, lowers its limits, becomes a subreaper,
   and starts one thread that applies Landlock and seccomp to itself. The command inherits
   both. Other launcher threads answer notifications, forward signals and reap descendants.
   Spade forbids `unsafe`; this uses `landlock`, `libseccomp` (system libseccomp 2.5 or later,
   LGPL, dynamically linked), `rustix`, `signal-hook` and util-linux.
2. **Default-deny syscalls on the two verified native ABIs.** Repeated reviews of a
   default-allow filter found missed ways to affect host state. Replace it with an explicit
   developer-tool allowlist on x86_64 and aarch64. Known unlisted calls return `EPERM`.
   Numbers unknown to libseccomp in the current 0 to 511 allocation range return `ENOSYS` for
   libc fallback; higher numbers remain `EPERM`. `clone3` also returns `ENOSYS` because its
   namespace flags are behind a pointer. Foreign ABIs kill the process. Other native
   architectures fail the filtered probe and retain reviews.

   The policy was built from the sandbox/security/effects suites and traced real git clone
   through the proxy, Cargo build/test, npm install, Python venv and make workloads. It also
   includes reviewed native equivalents and runtime primitives needed across the two ABIs.
   The admitted list is 210 native syscall numbers on x86_64 and 177 on aarch64, including
   conditional and supervised calls. `linux/allowlist.rs`, `linux/seccomp.rs` and
   `linux/metadata.rs` are authoritative; [the syscall inventory](../../spade/docs/linux-syscalls.md)
   records the names, conditions and smoke evidence. Future compatibility fixes must add a
   specific reviewed call, rather than restore a default-allow branch. The accepted cost is
   that an untested tool may need an allowlist addition.

3. **Landlock for files, with supervised metadata.** Require ABI 3's truncate right.
   ABI 1 to 2 report `files: partial` and retain reviews; denying path-based truncate alone
   cannot contain `open(O_TRUNC)` and `ftruncate`. Read-write roots are the workspace,
   `.spade/tmp`, consented write folders and a terminal's state files. System folders,
   confirmed toolchains, read grants and plugin folders are read-only. `/dev` is excluded
   even from a broad consented root. Roots containing denied places are carved on opened
   objects without following links; denied inodes and multiply linked files met during
   carving are omitted. The same descriptors receive Landlock rules.

   Landlock does not mediate chmod, chown, xattr or timestamp writes. Notify all their
   native variants, including `fchmodat2` (number 452 even on Debian 12's older libseccomp).
   The supervisor copies arguments, opens targets no-follow with `openat2`, authorizes them
   against the actual pinned write objects installed in Landlock, and performs the operation
   on the pinned object. It never continues a path or fd mutation in the caller. Descriptor
   targets are duplicated and their reopened identity must match. Symlink ancestors and
   unresolved/deleted fd paths are refused. Only explicit no-follow ownership/timestamp
   operations may change a symlink itself. Device metadata cannot be changed.

4. **Minimal devices, a dedicated terminal and no shared host IPC.** Grant only `/dev/null`,
   `/dev/zero`, `/dev/full`, `/dev/random`, `/dev/urandom`, `/dev/tty`, and the command's
   dedicated pty. Never grant all of `/dev` or `/dev/pts`. The person's own terminal and a
   different terminal of the same user cannot be opened. Separate sessions mean `/dev/tty` can
   refer only to the command's own controlling terminal.

   A command used to inherit the person's terminal on stdio, and a terminal-control ioctl on it
   (TIOCSWINSZ, TCSETS) changed the person's terminal. Now, when any of the launcher's stdin,
   stdout or stderr is a terminal, the outermost launcher (before any namespace) opens a fresh
   pty itself, copies the caller's modes and size, and gives the command the pty in place of
   each terminal; non-terminal stdio passes through, and with no terminal nothing changes.
   With the pty on stdin, `setsid --ctty` makes it the controlling terminal. The launcher relays
   output, and keystrokes while it may read stdin, holding the caller's terminal raw so the line
   discipline runs once; SIGWINCH copies the size. After the whole tree ends it drains the last
   output (at most two seconds) and restores the caller's modes before ending as the command
   did. The Landlock rule names that pty's node, verified against the opened pty by device and
   inode, so the command never holds the person's terminal through stdio.

   Use this precise Landlock policy rather than retaining mount privileges or depending on
   private devpts support. The unprivileged launcher after exec has no mount capabilities;
   signal namespaces do not give its command those privileges. No `/dev/ptmx` or `/dev/shm`
   is granted, including on namespace-capable hosts. Tools needing new PTYs or POSIX shared
   memory therefore need further design. If a future private devpts/tmpfs path is added,
   it must preserve the same boundary and be probed before claiming coverage.

   The private user/PID/mount namespace launch (decision 6) also requests a private IPC
   namespace before confinement. Every SysV IPC call is unlisted on every ABI: shm, semaphore
   and message creation, attachment, operations and control all fail `EPERM`, so IPC stays
   contained where the namespace can't start. Below ABI 6 an unavailable namespace fails the
   filtered launch; no path falls back to shared host IPC while claiming containment.

5. **Supervise socket addresses and PID/TID effects.** Landlock ABI 4 limits TCP ports,
   but cannot limit an address. Notify connect, bind and listen. Copy and judge the address,
   duplicate the socket through a pidfd, then perform the operation in the supervisor.
   Permit TCP only to loopback at the proxy's port, loopback binds, and Unix stream/seqpacket
   sockets in the workspace. Refuse AF_UNSPEC. Hold a shared lock keyed by socket device/inode
   from the check through the operation. Listen requires this supervisor's successful bind
   and a fresh getsockname check under that lock; retained descriptors prevent inode reuse.
   Socket creation is conditional; UDP, DNS, raw/packet/netlink sockets, Unix datagrams,
   abstract sockets and MSG_FASTOPEN are refused.

   Notify prlimit64, sched_setaffinity/setscheduler/setparam/setattr, setpriority, ioprio_set,
   kcmp and pidfd_open. Only zero or self IDs are accepted where the syscall defines them;
   task operations accept the notifying TID as well as the current process. Priority
   selectors must name processes. Both kcmp IDs must be positive self IDs. pidfd_open
   accepts a positive process ID, or the notifying TID with PIDFD_THREAD; NONBLOCK is optional,
   unknown flags and zero are refused. Older kernels may reject THREAD with EINVAL. setrlimit
   is already self-only. process_madvise/mrelease, process_vm, ptrace, NUMA migration and
   pidfd_getfd stay unlisted. No fd/pointer target is checked and then continued.

   ioctl has an explicit request list: read-only terminal queries on any descriptor (TCGETS,
   TCGETS2, TIOCGWINSZ, TIOCGPGRP, TIOCGSID, TIOCGPTN, FIONREAD), fd controls and file
   cloning. Terminal changes (TCSETS, TCSETSW, TCSETSF, their termios2 forms and TIOCSWINSZ)
   are notified as a second layer behind the dedicated pty: the supervisor copies the value,
   duplicates the caller's descriptor and makes the change itself only on the dedicated pty;
   another terminal answers `EPERM`. Nothing is checked and then continued. The cost: a
   background job's mode change on its own pty is applied instead of stopping it with SIGTTOU.
   TIOCSCTTY and TIOCSPGRP stay direct because the kernel scopes them to the caller's own
   controlling terminal, which in its new session can only be the dedicated pty; taking a
   terminal another session controls needs CAP_SYS_ADMIN. TIOCSPTLCK is dropped. prctl has
   self-only options. Make's UID/GID restoration is conditional on the launcher's current real
   IDs or the no-change sentinel. Namespace changes, arbitrary ioctls, nested seccomp,
   io_uring and kernel administration remain unlisted. no_new_privs is set; open files are
   capped at 65,536 and tasks at the machine's current count plus 4,096.

6. **A private PID namespace and `/proc`, separate sessions and every signal form isolated.**
   On every Landlock ABI, util-linux unshare creates a private user, PID, IPC and mount
   namespace with a fresh proc before confinement; the launcher grants that `/proc` whole. It
   lists only the command's own processes. Before, ABI 6+ shared the host's PID namespace and
   `/proc` was readable whole, so a command could list every process's command line. Namespace PID 1 must successfully call setsid. It sends its own pidfd over
   a private authenticated Unix handshake to the outer launcher before command startup.
   The outer launcher verifies the peer is unshare's child and that the pidfd names it,
   then unlinks the socket. Signals go directly through this handle, bypassing unshare's
   waiting parent. TERM/HUP escalates to killing namespace init after 500 ms, ending all
   descendants. This contains queued/thread signals without emulating their semantics.
   ABI 6+ also uses Landlock signal and abstract-socket scoping.

   Where unprivileged user namespaces aren't allowed the probe falls back to a plan without
   the namespace, which grants only `/proc`'s machine-wide entries (`cpuinfo`, `meminfo`,
   `stat`, `loadavg`, `uptime`, `version`, `filesystems`, `sys`), never a process's folder or a
   link into one. Granting `/proc/self` and `/proc/thread-self` alone isn't possible: Landlock
   rules hold inodes, the links resolve to `/proc/<pid>` of whoever follows them, and every
   descendant has its own, so the command's own folder stays closed as well. Such runs report
   `processes: partial` with a plain reason and keep reviews; below ABI 6 the filtered launch
   fails closed there too and Landlock alone is used.

   On every ABI the freshly spawned child runs through `/usr/bin/setsid` before exec.
   This creates a private session/group without an unsafe Rust pre_exec hook. Failure
   starts no command. INT, QUIT, TERM and HUP are forwarded to that private group; interrupts
   do not escalate. A failed old-kernel namespace or pidfd handshake fails the filtered probe
   and leaves signals partial. A filtered launch repeats setup and fails closed on each run.

7. **Serialize and bound shutdown work.** TERM/HUP escalates after 250 ms through a
   pre-opened leader pidfd and owned-child kills. Normal exit also drains adopted descendants.
   A single reaper mutex serializes SIGCHLD, shutdown killing and wait operations. Kill and
   reap at most 32 children per pass, without retaining a descriptor per child. Pin proc
   directories and check PPid and start time around pidfd acquisition. On EMFILE release four
   reserved descriptors; if a pidfd still cannot be obtained, re-check the pinned identity
   and kill by PID while the reaper lock prevents child reaping and PID reuse. Every reap is
   nonblocking; an incomplete sweep never enters a blocking wait. Repeat discovery and
   bounded passes until authoritative ECHILD. WNOWAIT keeps the leader reserved until group
   forwarding is disabled. Socket state uses at most a quarter of the fd limit (max 4,096)
   and notification workers at most 32, leaving room for cleanup.
8. **Probe the complete policy before dropping reviews.** The real launcher probe writes
   inside its workspace, cannot write beside it, reaches a stand-in proxy and cannot open
   UDP. With the namespace it checks that its PID namespace differs from the prober's and that
   `/proc/self` names itself; without, that the prober's `/proc` folder can't be read. All
   filter, device, metadata, IPC and namespace setup is mandatory on that path. Status
   exposes files, network, signals, syscalls, devices, ipc, processes and landlock_abi.
   `contains()` requires all seven fields contained and ABI >=3. Missing setup reports partial with a
   plain reason. Landlock alone reports files partial too, because metadata remains exposed;
   network is partial at ABI 4+ or none below, signals contained only at ABI 6+, and commands
   retain reviews. No Landlock means no sandbox. The policy is retried on every run.
9. **Apps and remaining visibility.** The desktop bus and display sockets lie outside the
   workspace or in the refused abstract namespace. The environment omits their variables,
   so xdg-open, gio, notify-send and systemd-run --user cannot reach desktop apps. There is
   no bus/display grant yet. `/proc` shows only the command's own namespace, or no process
   folder at all without one; Landlock also blocks other processes' memory, environment, file
   descriptors and cwd. A terminal leaked to the command on a descriptor other than stdio can
   still be read and written (only its modes and size are protected); Spade's own runs never
   pass one. A credential hard-linked inside a directory granted whole is
   still that directory's file, as on macOS. Runtime needs libseccomp.so.2; builds need its
   development headers.

### Verification

Real-kernel regression tests cover the person's terminal and another same-user PTY (only the
dedicated pty opens; size and mode changes land only on it, even through a leaked descriptor),
another process's command line under both `/proc` plans, metadata variants with path/fd and
symlink races, SysV IPC, host POSIX shm, an unlisted syscall, compatibility-ABI refusal and
160 detached children under a 64-fd limit, including forced EMFILE in the actual reaper.
Sandbox, security and effects suites and the six-step proxy smoke run on Linux 6.8 / ABI 4
and 6.12 / ABI 6 in Debian 12 containers as a non-root user with all capabilities dropped,
seccomp unconfined and proc system-path masking disabled. The x86_64 verification uses a full
QEMU VM with a real x86_64 kernel, rather than user-mode syscall translation. The syscall
inventory records observations and release reproduction commands.
