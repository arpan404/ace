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
     made. This is now built (see the amendment below, which corrects the egress mechanism: a
     loopback exemption isn't port-scoped, so a per-run named-pipe bridge carries the network
     instead). Windows reports `contained` only for a run with no network, as a Less Privileged
     AppContainer on folders Spade owns, with the job up — so decision 8's dropped reviews apply to
     those runs; a networked run, or one needing the person's folders, keeps the review path (see the
     amendment's "Narrowing" and "Final review" sections).

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

9. **Platform fallbacks.** Without the sandbox (Windows where no AppContainer can be made, or a
   run it can't contain — Amendment 2; Linux without Landlock, or with network `partial`; macOS
   where the probe fails), commands run as they do today and every
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
- Linux and Windows keep today's reviews until their boundaries are complete and tested; what
  each now holds, and for which runs, is in Amendments 1 (Linux) and 2 (Windows).

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

   A dedicated pty alone still let the command's output drive the person's terminal: OSC 52
   clipboard writes and reads, titles, window and size controls, queries answered back as
   keystrokes, and persistent emulator settings. The relay therefore passes output through an
   allowlist filter, a byte-at-a-time state machine that keeps its place across reads, so a
   sequence split between reads is judged whole. It keeps UTF-8 text, newline, carriage
   return, tab, backspace and bell; SGR; cursor movement, saving and restoring; erasing,
   inserting, deleting, scrolling regions and repeat; the DEC line-drawing set and SO/SI;
   keypad and cursor-key modes, autowrap, cursor visibility and the alternate screens
   (`?47`, `?1047`, `?1048`, `?1049`); and ANSI insert mode. It drops every OSC, DCS, APC, PM and
   SOS string whole, `CSI … t`, every query (`CSI n`, `CSI c`, ENQ, `ESC Z`, DECRQM, XTVERSION),
   mouse, focus and paste modes, other private modes, sequences with a private marker or
   intermediates (cursor style, soft reset, key modifiers), resets, tab-stop changes, other C0
   controls, and 8-bit C1 controls, raw or UTF-8 encoded, with overlong and surrogate encodings
   refused. A string left open ends at the next ESC, as on a terminal. Each kept CSI operation
   is checked with the parameters it takes within the visible screen: erase in display or line
   only with no parameter, 0, 1 or 2 (`ESC[3J`, which erases the person's scrollback, is
   dropped), cursor position and scroll margins with at most two numbers, cursor save and
   restore with none, the other movement, erasing, inserting, deleting, scrolling and repeat
   operations with at most one, sub-parameters only in SGR. The accepted cost: tools that wait
   on a query (a cursor-position report) time out and fall back.

   The end of the output always restores the person's terminal, whatever the command did,
   since tracking modes failed: cursor save and restore and the alternate screen carry
   attributes past a reset (`ESC[8m ESC7 ESC[0m ESC8` left text concealed), and autowrap, insert
   mode and margins weren't tracked. The relay sends `?1049l` if the command is on a `?1049h`
   alternate screen (on the main screen it would move the cursor to the command's last saved
   position), then, unconditionally, leaves any alternate screen (`?1047l`), resets SGR, puts
   ASCII in G0 and G1 and shifts in, turns autowrap on and insert mode off, saves the cursor,
   resets the scroll margins to the full screen and restores the cursor (resetting the margins
   homes it; this also leaves a clean rendition in the cursor-save slot for the person's
   prompt), shows the cursor, and resets cursor-key and keypad modes. These are a normal
   terminal's defaults.

   The restore is sent on every way out. The output worker writes whole sequences under a lock
   that the relay's end also takes, so the restore follows the last complete write and nothing
   follows it. Finishing waits up to two seconds for the last output; then, or when the relay is
   dropped on an error or unwind, the end is sent from its own thread, waited for up to five
   seconds, so a slow reader still gets it and only a terminal that reads nothing misses it. The
   outer launcher drops its copy of the command's stdin as soon as init has it: a kept pty
   descriptor had held the pty open, so every run on a terminal waited out the two seconds.

   Raw mode is held by a guard set before the change is applied and dropped on every way out:
   finishing, an error, a failed thread start (every relay thread starts through
   `thread::Builder`, and a failure stops the run) or an unwind. A relay that can't start
   starts no command.

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
   `/proc` was readable whole, so a command could list every process's command line.
   Namespace PID 1 must successfully call setsid.

   The launchers keep no state at any pathname. Init used to report the command's ending signal
   through a temporary file under `TMPDIR`, which is inside the sandbox's writable workspace, and
   to meet the outer launcher at a socket path under `/tmp`, which a person may grant. A
   contained process could swap either for a link before the unrestricted init opened it, and
   a test showed init then wrote through the link to a file outside. Now the outer launcher makes
   a Unix seqpacket pair before anything is restricted and gives one end to unshare as stdin;
   init takes it from descriptor 0 and points 0 at `/dev/null`. Over it the outer launcher sends
   the command's stdin, stdout and stderr (`SCM_RIGHTS`), init sends its own pidfd, the outer
   launcher checks that the pidfd names unshare's child and answers, and only then does init
   start the command. If the command ends by a signal, init's last message says which. The
   launchers open paths only in `/proc`, `/dev` and the device and grant objects carving
   opens without following links. Signals go directly through init's pidfd, bypassing unshare's
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
   do not escalate. A failed old-kernel namespace or init handshake fails the filtered probe
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
clipboard, title, window and query sequences split across reads never reaching it while `less`
and `top` still render, a terminal model returning to its defaults after every kept mode
(including through cursor save and restore and the alternate screen), the restore reaching a
slow reader and an unfinished relay's drop, a run on a terminal ending well inside the drain
time, `ESC[3J` dropped, raw mode undone after a failure that follows it, a contained process
planting links where launcher state used to live while 40 runs end by a signal,
another process's command line under both `/proc` plans, metadata variants with path/fd and
symlink races, SysV IPC, host POSIX shm, an unlisted syscall, compatibility-ABI refusal and
160 detached children under a 64-fd limit, including forced EMFILE in the actual reaper.
Sandbox, security and effects suites and the six-step proxy smoke run on Linux 6.8 / ABI 4
and 6.12 / ABI 6 in Debian 12 containers as a non-root user with all capabilities dropped,
seccomp unconfined and proc system-path masking disabled. The x86_64 verification uses a full
QEMU VM with a real x86_64 kernel, rather than user-mode syscall translation. The syscall
inventory records observations and release reproduction commands.

## Amendment 2: Windows' sandbox, as built (2026-11-17)

Decision 1's Windows bullet is now built (`spade-sandbox-windows` for the system calls,
`spade-sandbox::windows` for the policy and launch, `spade-server` for the wiring). Building it
on a real Windows 11 machine changed one thing in the design and firmed up the rest.

- **The egress bridge, not a loopback exemption.** Decision 1 said the proxy would be reached
  "through a loopback exemption for that one profile". Measured on Windows: an AppContainer with
  no capabilities cannot open a loopback connection to a process outside the container at all, and
  the loopback _exemption_ that would let it is **per AppContainer and not port-scoped** — enabling
  it opens every local port to the command, not just the proxy's, and it is a machine-wide,
  admin-only developer setting. That is the opposite of "network only through the proxy", so it is
  rejected (the task anticipated this and asked for a justified choice). Instead each networked run
  gets a **named-pipe bridge**: a tiny bridge process runs _inside_ the container (same SID and
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
  grants: the run's container SID gets an inheritable _Modify_ ACE on the workspace, the run's temp
  folder, granted read-write folders and Spade's own per-run scratch, and a _Read & execute_ ACE on
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

### Hardening (2026-11-17)

Two security reviews of the Windows build asked for six changes before it may report `contained`:

- **Grants land on exactly the approved object.** A grant's path is walked one component at a time,
  each opened relative to its parent's pinned directory handle and refused if it is a reparse point
  (a symbolic link or junction). So no component of the path can be swapped for a link that
  redirects the ACE, and the ACE is set on that pinned handle.
- **Reconciled to exact rights.** A grant removes the SID's previous ACEs on the object before
  setting the new one, so a folder changed from read-write to read-only no longer keeps Modify.
  Staleness is judged by path _and_ rights.
- **Correct inheritance.** ACLs are edited as `SE_FILE_OBJECT` (not `SE_KERNEL_OBJECT`) and written
  `UNPROTECTED`, so an inheritable grant propagates to existing children and revoking a parent
  removes the inherited ACEs on its descendants. A moved file keeps its ACE (Windows doesn't
  re-evaluate on move) and is cleaned up by file id; a hard link shares one ACL, so revoking by any
  name clears it. A denied place is the exception: because an AppContainer's check grants the
  package SID on _any_ allow ACE — a deny does not out-rank an inherited allow as it does for a
  normal token — a deny stops the node inheriting, removes the SID's allow and leaves a protected,
  inheritable deny, so the place is truly unreachable even inside a granted folder.
- **Per-run identity.** Each run gets its own AppContainer profile (derived from the bot and the
  run id) holding only that run's grants, so a plugin's extra folders can't be reached by the bot's
  other running commands. The profile is deleted when the run ends. Because open handles survive
  revocation, a run's grants are taken back only after its processes are gone (the run's hold is
  dropped once the command has finished).
- **Durable revocation.** The journal records each object's identity (volume serial and file id,
  not just its path) and is written as intent _before_ any ACL change, so a crash mid-apply is
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

### Closing the fail-open paths (2026-11-17)

A fourth review found places that would quietly launch a command unconfined, or read a damaged
journal as empty, or judge a path by its spelling. All are now closed, test-first.

- **Confinement is an explicit result.** Deciding to confine returns `Contained(run)`,
  `NeedsReview(reason)` or `None` (no sandbox applies) — never an `Option` whose `None` a caller
  could read as "just launch it". Every caller routes `NeedsReview` to the review path or refuses:
  the shell tool refuses unless the run was already reviewed, a plugin hook or local server that
  needs review does not start, and a service never launches unconfined. If containment is decided
  after review was skipped, the launch re-enters review rather than running plainly.
- **Journal formats are explicit, and lifecycle is tracked.** A journal carries a version; the
  legacy `{container, paths}` form is accepted only when it has `paths` and none of the new fields,
  and anything unparseable blocks the bot rather than falling back to an empty set. Each journal is
  marked active, incomplete-setup or incomplete-cleanup; reconcile owns its own rollback, and every
  non-active journal that isn't resolved blocks. Enumeration errors propagate and block, except a
  directory that truly doesn't exist (which is simply "no journals").
- **Containability is proven by file identity, not string prefixes.** A run is containable only when
  every place it needs is proven — by opening it relative to a pinned handle and comparing file
  identity (volume serial + file index) — to be inside Spade's data directory, except toolchains,
  which may instead be inside a known system root (`%SystemRoot%`, `Program Files`,
  `Program Files (x86)`), verified the same way. A toolchain on another drive, a UNC path, or one
  reached through a junction does not pass; the workspace and scratch are checked too, not just
  consented folders; and a required place that is missing fails closed. String prefixes are gone.
- **Less Privileged AppContainer (LPAC), for runs with no network.** A run with no network sets the
  `ALL_APPLICATION_PACKAGES_POLICY` proc-thread attribute to opt out, so the token does not carry the
  `ALL APPLICATION PACKAGES` SID. A plain AppContainer can read anything granted to that SID
  system-wide; an LPAC cannot. Such a run reaches only what its own container SID is granted (the
  folders Spade ACLs under its data directory) plus the core system binaries that carry the
  restricted `ALL RESTRICTED APPLICATION PACKAGES` ACE the loader needs — `System32` binaries
  (`curl.exe`, `cmd.exe` and the system DLLs) keep that ACE, so they still load, and the file,
  registry and COM read access that an app package has system-wide is gone. **Measured behaviour:**
  the file-only tests (writes, reads, listings, the hard-link attempts) pass unchanged under LPAC,
  and a file granted only to `ALL APPLICATION PACKAGES` is unreadable to an LPAC run — confirmed on
  the VM, including as a standard user.
  - **Why not networked runs.** Also measured on the VM: under LPAC, `WSAStartup` fails, so the
    in-container egress bridge cannot bind its loopback port and a networked run fails closed. The
    Winsock catalog keys (`HKLM\SYSTEM\CurrentControlSet\Services\WinSock2\Parameters` and its
    `Protocol_Catalog9` and `NameSpace_Catalog5`) grant read to `ALL APPLICATION PACKAGES` and to
    the `registryRead` capability (`S-1-15-3-1024-1065365936-…`, confirmed with
    `DeriveCapabilitySidsFromName`), never to `ALL RESTRICTED APPLICATION PACKAGES`. So a networked
    run can't be an LPAC with no capabilities; it would have to be a plain AppContainer, and that is
    no longer reported `contained` (see "Final review" below). The answer to "which LPAC capabilities
    do common tools need" is: file-only runs need none (LPAC costs nothing, since those tools never
    open a socket); networked tools need at least Winsock's catalog, which today means a capability
    (`registryRead`) that also reopens every other key granted to it. This supersedes the earlier
    note that toolchains are "already readable by `ALL APPLICATION PACKAGES`": under LPAC that is no
    longer true, and a no-network run's containable toolchains are the Spade-owned ones (granted the
    container SID) and `System32` binaries (restricted ACE).
- **Hard links cannot smuggle a file in.** A contained run could have asked for a second name, inside
  its granted workspace, for one of the person's files, then reached the file's data through the
  name it controls. **Measured behaviour:** both the Win32 `CreateHardLink` path and the native
  `NtSetInformationFile(FileLinkInformation)` path fail, because creating a hard link must open the
  source file first and the run has no access to it; the person's file keeps its single name. No run
  whose workspace could host such a link is allowed — the open gate makes the attempt fail closed,
  so no extra refusal in `containable` is needed.

### Final review: the launch token, networked runs, hard-link stages (2026-11-17)

A final review found the journal parsing, lifecycle states, pinned ancestry and no-network LPAC sound,
and four things left, fixed test-first in the VM:

- **The gate's decision is carried to the launch.** The shell tool recomputed `contains()` at
  execution, so a command that skipped review because the sandbox held it could launch plainly if
  containment changed before it started (the person adds a consented folder). The gate now records
  an immutable launch token per call — _outside_, _contained_ (decided in the sandbox's light), or
  _reviewed_ (without relying on the sandbox) — and the shell takes it instead of deciding again. A
  _contained_ call launches only contained; if the sandbox no longer holds it, it is refused and
  running it again goes back through the gate. An unmarked call counts as _contained_. A process test
  drives the race with a sandbox that holds the command when the gate asks and has lapsed by launch:
  the command is refused and never runs (before the fix it ran plainly).
- **A journal-listing error blocks.** Directory entries were filtered before their errors were
  checked, so an entry the listing failed to yield was dropped. Every entry is now checked before any
  filtering, and one that fails fails the listing, which blocks every bot.
- **Networked Windows runs are not `contained`; they keep the review path.** The owner's priority is
  security. A networked run can't be an LPAC (above), and as a plain AppContainer it keeps ambient
  read access to what every app package may read — files, some registry keys, COM objects — which
  is not what `contained` promises. So on Windows only a no-network LPAC run on Spade-owned folders is
  `contained`. Confining a networked run returns needs-review with the line "Windows can't seal off
  network commands yet, so Spade asks first." (a run needing the person's folders says "This needs
  your folders, so Spade asks first."); the bot's security view now reports its own `contained` and
  that `reason`. Consequences: a bot's network defaults to the allow list, so a Windows bot's commands
  are contained only once its network is off; and a plugin's local server or hook with network can't
  be contained on Windows (it starts only with the person's consent, below). A Windows process test on the real AppContainer
  probe checks both sides: the default-network bot is not contained and its run needs review with the
  network line; with network off the same bot is contained and its run is held.
- **The egress broker is not built; it is future work.** The idea was a broker in the bridge process
  that holds the network and talks to the LPAC command over the SID-scoped pipe, so the command never
  needs Winsock. That works only for a command that can speak to a pipe; the commands that need
  network (`curl`, `git`, `npm`, `pip`, `cargo`) all open TCP sockets through Winsock to reach
  `HTTP_PROXY`, so under LPAC they fail at `WSAStartup` whatever the broker does. Making them work
  would mean interposing the socket API inside each command's process (a DLL that turns Winsock calls
  into pipe I/O), which is fragile across tools and architectures (ARM64, x64, emulated x64) and is
  itself security-sensitive. Ways forward to evaluate: that interposing broker; an LPAC holding only
  `registryRead` (does Winsock then start, while the absence of network capabilities still keeps the
  container off the network? — untested, and it reopens every key granted to `registryRead`); or a
  network capability whose reach is cut to the proxy's port by Windows Filtering Platform rules
  installed by a service.
- **Hard links: a control, the failing stage, both tokens.** Both link paths now report where they
  stopped. Measured under an LPAC token and a plain AppContainer one, through both the Win32
  `CreateHardLink` and native `NtSetInformationFile(FileLinkInformation)` paths: a link between two
  of the run's own files is made and is the same file (the control); the person's file is refused at
  opening the source; the run's own file linked into a folder it wasn't granted opens, but the link
  is refused. The person's file keeps its single name.

### Before merge: plugin consent, the unguarded hard-link call (2026-11-17)

A last review confirmed the no-network LPAC boundary — no path for a `contained` command to write
outside its grants, read the person's files or credentials, reach the network or act as the person —
and asked for two more things, done test-first in the VM.

- **Plugins the sandbox can't seal off start only with consent.** Plugin networking defaults to open,
  so on Windows network-enabled plugin servers and hooks stopped starting. They now start through an
  explicit consent, never by turning needs-review into plain execution. Before a plugin's server or
  hook starts, Spade asks the sandbox without side effects (`Confine::review`, the same decision
  `confine` makes); when it can't be held, Spade raises a request card in the bot's conversation —
  "<plugin> needs the network, and Windows can't seal that off yet. Run it outside the sandbox?" —
  with **Allow** (one start) and **Always for this plugin version** (and **Deny**). The answer is
  bound to a digest of the bot, the plugin's id, version and content hash, server or hook, the
  command and its environment; an update, or a changed command or environment, asks again. Until
  approved the server waits (`waiting_for_you`) and a hook fails with that reason. Once approved it
  runs plainly and its status says `outside_sandbox` — never `contained`, and never a plain
  AppContainer labelled contained — and the server's tool calls keep their usual reviews. Tests:
  refused before approval, runs after, an update asks again, a once-allowed hook runs once, and the
  server's write call still goes to the person; the hook test runs on Windows too, and a Windows
  test checks the probe gives the same answer as `confine` for plugin runs (network: the network
  line; network off and a folder Spade doesn't own: the folders line; network off and Spade's own
  folder: contained).
- **The unguarded `CreateHardLinkW`.** The Win32 hard-link check opened the source itself first, so a
  refusal there could be Spade's open rather than Windows'. That diagnostic stays (it names the
  failing stage), and the test now also calls `CreateHardLinkW` directly with no pre-check, under
  both the LPAC and plain AppContainer tokens: a link between the run's own files is made; the
  person's file and a link into an ungranted folder are refused by Windows itself, and no
  destination link appears.

### The status's other boundaries, beside Linux's (2026-11-17)

Amendment 1 made the runner's status name every boundary — `files`, `network`, `signals`,
`syscalls`, `devices`, `ipc`, `processes` — and `contained` needs all of them. On Windows each is
held by the AppContainer, measured in the VM under the LPAC token and a plain one alike: a contained
run can't see a process of the person's outside it (`processes`), can't open it to end it
(`signals`), can't open their named objects (`ipc`), and can't open a device they can (`devices`).
`syscalls` has no Windows counterpart to Linux's seccomp allowlist; as with macOS's Seatbelt the
boundary is the operation rather than the call — every kernel object a run opens is checked against
its container token, and the job bars the desktop, clipboard and global atoms — so it is reported
held on that basis, not as a syscall filter. Which runs are contained is still decided per run
(no network, Spade-owned folders).

### Networked runs under LPAC: measured, not qualified (2026-11-18)

The owner asked whether networked Windows runs could be contained too. Each route was measured in
the VM (`spade-sandbox/tests/windows_network.rs`, ignored measurement tests), against the bar a
networked run would have to clear: the tools (`curl`, `git`, `npm`, `pip`, `cargo`) work through
the proxy; nothing else is reachable (no direct connection, DNS, UDP or other loopback port); LPAC
file isolation from `ALL APPLICATION PACKAGES` holds; the registry it opens holds no secrets; and
it all works as a standard user.

- **LPAC alone:** Winsock doesn't start (`WSAStartup` fails), as recorded above. No socket of any
  kind; file isolation holds.
- **LPAC plus `registryRead`** (route a, no elevation): Winsock starts, the run's own sockets stay
  refused (no direct connection, DNS, UDP or other loopback port) and file isolation holds — but
  even a loopback listener is refused (`WSAEACCES`, 10013). The in-container egress bridge can't
  bind its port, so there is no socket path to the proxy at all: every tool fails before it
  reaches it. The tools can't use the SID-scoped pipe instead; they only speak TCP. Granting read
  on only the Winsock catalog keys to a Spade capability (instead of `registryRead`) was narrower
  but not enough even for Winsock to start. Because this route already fails the first check, what
  `registryRead` opens beyond the Winsock catalog was not taken further.
- **LPAC plus a network capability** (route b, `internetClient`, with `registryRead` so Winsock
  starts): sockets work, and so do direct connections, DNS and UDP — the capability reopens the
  network the sandbox exists to close. Windows Firewall rules for the run's package (outbound TCP
  blocked except the proxy's loopback port, UDP blocked) plus a loopback exemption closed direct
  TCP and UDP, but name lookups still resolved (they go through the DNS Client service, not the
  run's own socket) and another loopback port stayed reachable. Every rule and exemption is also
  per package, and each run has its own package SID, so it would need elevation on every run.
  Route (b) is dropped from the build.
- **An intercepting broker** (route c) remains as described under "Final review": the tools open
  TCP sockets themselves, so a broker would have to interpose the socket API inside each command's
  process — fragile across tools and architectures, and itself security-sensitive. Not built.

**Decision: networked Windows runs keep the review path.** They are not `contained`, and the line
the person reads stays "Windows can't seal off network commands yet, so Spade asks first." No
elevation or setup step is added. Ways to revisit it later: an intercepting broker; a Windows
Filtering Platform callout or a filter installed by a privileged Spade service, which could allow a
run's package exactly one loopback destination (the proxy) and nothing else, DNS included; or a
change in Windows that lets an LPAC open loopback sockets without a network capability. The launch
token now carries capability SIDs (`launch::Token`, `Sid::capability`) and the test helper has the
probes (`winsock`, `bind-why`, `resolve`, `tcp`, `udp-dns`, `run-env`), so a later attempt can
measure the same things.
