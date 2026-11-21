# Security boundaries

Date: 2026-11-15, amended 2026-11-16 and 2026-11-17 (Linux, Windows). As built for
[ADR 0167](../../docs/adr/0167-spade-security-boundaries.md) and
[ADR 0171](../../docs/adr/0171-spade-decides-on-effects.md), in
`spade-sandbox` (the sandbox, the credential deny-list and the egress proxy), `spade_core::grant`
(grants) and `spade-server` (`security/`, `api/security.rs`, the shell, services and plugin
servers). Extends [workspace.md](workspace.md), [computer.md](computer.md) and
[autonomy.md](autonomy.md). A package's WebAssembly components run in `spade-wasm`, a worker
started offline inside the bot's sandbox, which asks Spade for every effect ([code.md](code.md)):
its `tools` calls are routed by the gate with the package's ceiling first and no earlier answer
carried over, and its `http` goes only to declared hosts left on, through the egress proxy.

## What is built where

| Platform | Mechanism                                                                | Files                                                                | Network                                              | Reviews dropped                                 |
| -------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------- |
| macOS    | Seatbelt profile per run, `/usr/bin/sandbox-exec -p`                     | contained                                                            | contained (TCP to the proxy's port only)             | yes                                             |
| Linux    | Landlock and a seccomp filter via `spade sandbox-exec`                   | contained                                                            | contained (TCP to the proxy's port only)             | yes                                             |
| Windows  | Less Privileged AppContainer per run + job, via `spade sandbox-exec-win` | contained (no-network runs on Spade-owned folders only; else review) | not contained: a networked run keeps the review path | yes, for no-network runs on Spade-owned folders |

Spade probes the sandbox once at start (`Runner::probe`). On macOS: the real profile on a
throwaway folder running `/usr/bin/true`. On Linux: a real sandbox through the launcher on a
throwaway folder, whose check (`spade sandbox-check`) writes in its workspace and not beside it,
reaches a listener standing in for the proxy, can't open a UDP socket, and has its own PID
namespace and `/proc` (or, without one, can't read the prober's `/proc` folder) (see
[Linux](#linux)). On Windows: it makes and deletes a throwaway AppContainer profile; whether a run
is contained is then decided per run (see [Windows](#windows)).
`SPADE_SANDBOX=off` turns it off. Without all required sandbox boundaries and the proxy listening,
reviews stay in place.

## What a sandboxed run may touch

Every command Spade starts for a bot runs in that bot's sandbox: `shell` in the one-shot shell and
in each terminal session, owned services, plugin hooks and plugin MCP servers. The person's own
shell in the bot's terminal is not sandboxed. A run is confined when its home is a bot's workspace
(`<data>/workspace/<bot>`). On a machine with a sandbox, a run that can't be confined is not
started: the shell answers `the sandbox could not start: …`, and a plugin server keeps that as its
problem.

| Place                                                                                                                               | Access                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| The bot's workspace, `.spade/tmp` in it (`TMPDIR`)                                                                                  | read-write                                                                                                 |
| Folders granted with `write: true`                                                                                                  | read-write                                                                                                 |
| A terminal's state files (Spade's `terminal/<bot>`)                                                                                 | read-write                                                                                                 |
| The system's folders (below)                                                                                                        | read-only                                                                                                  |
| Confirmed toolchains, folders granted for reading                                                                                   | read-only                                                                                                  |
| A plugin's own folder (its hooks and servers only)                                                                                  | read-only                                                                                                  |
| Everything else: home folders, `/Users/Shared`, `/Volumes`, the person's temporary storage (`/private/var/folders`, `/private/tmp`) | none (ancestors of an opened place: `stat` only)                                                           |
| Spade's data (other bots' workspaces, database, keys), ace's data                                                                   | none                                                                                                       |
| The credential deny-list                                                                                                            | none, whatever else allows it                                                                              |
| Devices                                                                                                                             | macOS: null/zero/random/urandom, ttys, fd; Linux: only the precise minimal devices and dedicated PTY below |

The system's folders on macOS: `/System`, `/usr`, `/bin`, `/sbin`, `/Library`, `/opt`, `/nix`,
`/private/etc`, `/private/var/db/timezone`, `/private/var/select`,
`/private/var/db/xcode_select_link`, `/Applications/Xcode.app`, and the listing of `/` (the loader
reads it). On Linux: `/usr`, `/bin`, `/sbin`, `/lib`, `/lib32`, `/lib64`, `/etc`, `/opt`, `/nix`,
`/snap`, `/var/lib`, `/sys`, and `/proc` as freshly mounted in the command's own PID namespace
(where that namespace can't start, only `/proc`'s machine-wide entries: `cpuinfo`, `meminfo`,
`stat`, `loadavg`, `uptime`, `version`, `filesystems`, `sys`). Nothing is readable by default
and then hidden: every read rule names what it opens.

Network: TCP to the egress proxy on `127.0.0.1` and nothing else, no DNS. Listening on loopback
is allowed, so a dev server can start. On Linux, Unix sockets inside the workspace can also be
connected to and bound (a database a test starts there); none outside it. On macOS there are no Apple Events and no LaunchServices
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
object that is a denied one (same device and inode, a hard link included) is left out, a file
with more than one name is left out (a rule on a file holds its inode, so it would open the
file's other names, a credential's included), and the descriptors carving opened are the ones
the rules are installed on. The word list in
`spade_core::autonomy::secrets` still refuses a call naming these places before anything runs.

## Linux

`spade_sandbox::linux` ([ADR 0167](../../docs/adr/0167-spade-security-boundaries.md) amendment
1). Built by default (`landlock` feature of `spade-sandbox` and `spade-server`; it does nothing
on other systems).

**The launcher.** `spade sandbox-exec <plan> <program> <args>…` stays outside the sandbox as the
run's supervisor. On every ABI it first starts itself again as the init of a private user, PID,
IPC and mount namespace with a fresh `/proc` (below). Where its stdio is a terminal, the
outermost launcher gives the command a dedicated pty and relays it (below). It carves the plan's
roots, lowers its limits, sets itself as the subreaper, and starts one thread that applies
Landlock and the seccomp filter to itself and starts the command, which inherits both. It starts the command in a new session through `/usr/bin/setsid`, forwards `SIGINT`,
`SIGQUIT`, `SIGTERM` and `SIGHUP` to its process group, reaps what it adopted and exits as
the command did: its code, or the same signal. A run that can't be confined answers 126 with
`spade sandbox-exec: …` on stderr.

**Files and metadata.** Landlock uses the highest available ABI (this build asks through
ABI 9). File containment requires ABI 3's truncate right and the metadata supervisor.
Read/write roots are as above. Landlock cannot restrict chmod, chown, xattrs or timestamps,
so every native mutation variant is notified. The supervisor copies arguments, opens a
no-follow pinned target with openat2, and checks the actual write-grant objects installed in
Landlock. It performs the mutation itself on that pinned object, never continuing the
caller's path or fd operation. FD targets are duplicated and their reopened identity must
match. Symlink ancestors, deleted/unresolvable fd paths and device metadata are refused;
explicit no-follow ownership/timestamp calls can change an owned symlink itself. This includes
fchmodat2 even when the system libseccomp does not know its name.

**Default-deny seccomp.** Only explicitly reviewed native x86_64/aarch64 syscalls are admitted.
Everything else returns EPERM; unknown numbers in 0 to 511 and clone3 return ENOSYS for libc
fallback. Higher unknown numbers remain EPERM. A foreign ABI kills the process. Other
architectures fail the filtered probe and keep reviews. The list comes from traced real
shell, git clone through the proxy, Cargo build/test, npm install, Python venv and make
workloads plus the sandbox/security/effects suites and reviewed ABI equivalents. It admits
210 native numbers on x86_64 and 177 on aarch64, including conditional and supervised calls.
See [the syscall inventory](linux-syscalls.md) for names, conditions and reproduction.

The direct list covers Landlock-checked file data/namespace operations, process/thread
runtime, memory, polling, timers and read-only queries. Socket creation, send flags, clone
flags, ioctl requests, prctl options and UID/GID restoration are conditional. Terminal changes
(TCSETS/TCSETSW/TCSETSF, their termios2 forms and TIOCSWINSZ) are supervised (below). io_uring,
namespace changes, kernel administration, arbitrary ioctl, nested seccomp and cross-process
memory effects are unlisted. no_new_privs is set. Open files are capped at 65,536; tasks at
the machine's current count plus 4,096.

**Socket and task supervision.** Connect, bind and listen are performed by the supervisor,
using copied addresses and duplicated sockets. TCP connects reach only loopback at the
proxy's port. Binds are loopback only; Unix stream/seqpacket sockets stay in the workspace,
resolved without symlinks. AF_UNSPEC is refused. A lock keyed by socket device/inode spans
check and operation; listen requires a successful supervised bind and fresh getsockname
check under that lock. Retained descriptors prevent inode reuse. UDP, DNS, raw/packet/netlink
sockets, Unix datagrams, abstract addresses and MSG_FASTOPEN are refused. A dead supervisor
leaves notified calls failing ENOSYS.

PID/TID-targeted resource and scheduling writes, including sched_setattr, allow only self
or the notifying TID, and zero only where defined. Priority selectors must name processes.
Both kcmp targets must be positive self IDs. pidfd_open accepts a positive process ID, or
the notifying TID with PIDFD_THREAD, optionally NONBLOCK; zero/unknown flags are refused.
Older kernels may return EINVAL for THREAD. process_madvise/mrelease, NUMA migration,
process_vm, ptrace and pidfd_getfd are unlisted. Read-only scheduling queries are allowed;
wait/setpgid retain the kernel's child/session restrictions. setrlimit is self-only already.
Socket retention is capped at a quarter of the fd limit (max 4,096), workers at 32; excess
requests return EAGAIN.

**Devices and IPC.** There is no blanket /dev or /dev/pts grant, even under broad folder
consent. Only /dev/null, zero, full, random, urandom, tty and the command's dedicated pty
(below) are granted. The person's own terminal and another terminal of the same user cannot be
opened. A separate session means /dev/tty refers only to the command's own controlling
terminal, its dedicated pty. The launcher uses precise Landlock device rules on every ABI,
without retaining mount privileges for private devpts. /dev/ptmx and /dev/shm are unavailable
to the command. POSIX shared memory and new PTY allocation inside the sandbox are consequently
unsupported. Every SysV IPC syscall is refused, including creation, attach, control and
semaphore/message operations. The private namespace also has its own IPC namespace; where it
can't start, IPC is still contained because every SysV call is refused.

**Terminals.** When the launcher's stdin, stdout or stderr is a terminal, the outermost
launcher opens a fresh pty (through /dev/ptmx, outside the sandbox), copies the caller's modes
and window size to it, and gives the command the pty in place of each terminal; stdio that
isn't a terminal is passed through unchanged, and with no terminal on stdio nothing changes.
With the pty on stdin, `setsid --ctty` makes it the command's controlling terminal. The
launcher relays the pty's output to the caller's terminal and, while it may read stdin (it is
not a background job of that terminal), the caller's keystrokes to the pty, holding the
caller's terminal in raw mode so the line discipline runs once, in the pty; SIGWINCH copies the
caller's new size to the pty. When the command's whole tree has ended it drains the last output
(two seconds at most) and restores the caller's modes before exiting as the command did.
Only the dedicated pty is granted to Landlock, so the command never holds the person's terminal
through its stdio. Raw mode is held by a guard from the moment it is set: finishing, an error,
a relay thread that can't start (they start through `thread::Builder`) or an unwind all give
the terminal back. A relay that can't start starts no command.

The command's output reaches the person's terminal only through an allowlist filter
(`linux/screen.rs`), a state machine that keeps its place across reads, so a sequence split
between reads is judged whole. Kept: UTF-8 text, newline, carriage return, tab, backspace,
bell; SGR colours and attributes; cursor movement, saving and restoring; erasing, inserting,
deleting, scrolling regions and repeat; DEC line drawing and SO/SI; keypad, cursor-key and
autowrap modes, cursor visibility, the alternate screens and ANSI insert mode. Dropped: every
OSC (clipboard, title, hyperlinks, colours), DCS, APC, PM and SOS string; `CSI … t` window
controls; queries whose answers would come back as input (`CSI n`, `CSI c`, ENQ, `ESC Z`,
DECRQM and the like); mouse, focus and paste modes and other private modes; sequences with a
private marker or intermediates; resets and tab stops; other C0 controls; 8-bit C1 controls,
raw or UTF-8 encoded, and overlong or surrogate encodings. Each kept CSI operation takes only
the parameters that act within the visible screen: erase in display or line only with none, 0,
1 or 2 (`ESC[3J` would erase the person's scrollback), cursor position and margins at most two
numbers, cursor save and restore none, the other kept operations at most one, sub-parameters
only in SGR. Tools that wait on a terminal query time out and fall back.

When the output ends the relay always sends the same restore, not one built from tracked
modes (cursor save and restore and the alternate screen defeat tracking): `?1049l` first if the
command is on a `?1049h` alternate screen, then leave any alternate screen, plain SGR, ASCII in
G0 and G1 with SI, autowrap on, insert off, full scroll margins between a cursor save and
restore (so the cursor stays put and the save slot holds a clean rendition), cursor visible,
normal cursor keys and keypad. The output worker and the relay's end share a lock, so the
restore follows the last whole write and nothing follows it. It is sent on every way out:
after the two-second drain, or when the relay is dropped on an error or unwind, from its own
thread, waited for up to five seconds, so a slow reader still gets it. The outer launcher
drops its copy of the command's stdin once init has it, so a run on a terminal no longer waits
out the drain.

As a second layer, the ioctl allowlist admits only read-only terminal requests directly on any
descriptor (TCGETS, TCGETS2, TIOCGWINSZ, TIOCGPGRP, TIOCGSID, TIOCGPTN, FIONREAD). Mode and
size changes are notified: the supervisor copies the new value, duplicates the caller's
descriptor and makes the change itself only when it is the dedicated pty (same device and
inode); another terminal answers EPERM, a non-terminal ENOTTY. Nothing is checked and then
continued. TIOCSCTTY and TIOCSPGRP stay direct: the kernel scopes them to the caller's own
controlling terminal, which in its new session can only be the dedicated pty (taking a terminal
another session controls needs CAP_SYS_ADMIN). TIOCSTI and every other terminal request stay
refused. A terminal changed by the supervisor is not subject to the background-job SIGTTOU
stop; within the command's own pty that is the only difference.

**Processes, signals and cleanup.** On every ABI, util-linux unshare starts with
`--user --map-current-user --pid --ipc --fork --mount-proc --kill-child` before restrictions.
The fresh `/proc` lists only the command's namespace, so no other process's command line,
status or folder can be read; the launcher grants that mount whole. Namespace PID 1 must call
setsid. Its control channel is a Unix seqpacket pair the outer launcher makes before any
restriction and gives unshare as stdin; init takes it from descriptor 0 and points 0 at
/dev/null. Over it the outer launcher sends the command's stdin, stdout and stderr, init sends
its own pidfd (checked to name unshare's child, then answered) before the command starts, and
init reports an ending signal as its last message. No launcher state lives at a pathname: an
earlier status file under TMPDIR (the workspace) and socket under /tmp could be swapped for a
link a contained process planted, and init wrote through it. The launchers open paths only in
/proc, /dev and the grant objects carving opens without following links. The outer launcher forwards INT/QUIT/TERM/HUP directly to init, bypassing unshare's
waiting parent; TERM/HUP escalates to killing init after 500 ms. ABI 6+ adds Landlock signal
scoping. On every ABI the command starts in its own session through /usr/bin/setsid, and
terminal signals are forwarded to its private process group. A failed namespace, session or
handshake starts no command whose plan asked for one.

Where unprivileged user namespaces aren't allowed, the probe falls back to a plan without the
namespace: only `/proc`'s machine-wide entries are granted, never a process's folder or a link
into one (`self`, `thread-self`, `mounts`, `net`). Landlock rules hold inodes, and each process's
`/proc/<pid>` is its own, so the command's own folder can't be granted to it and its
descendants either; it stays closed too, and tools that read `/proc/self` lose that. Status
reports `processes: partial` with the reason and reviews stay. Below ABI 6 signals also need the
namespace, so there the filtered launch fails closed and Landlock alone is used.

TERM/HUP escalates after 250 ms via the pre-opened leader pidfd and owned-child kills.
Normal command exit also drains adopted descendants, including detached sessions. One
reaper lock serializes shutdown and SIGCHLD reaping. Kill/reap passes handle at most 32
children, retain no per-child fd collection and use only nonblocking waits. Pinned proc
identity checks include PPid and start time. EMFILE releases four emergency descriptors;
if pidfd acquisition still fails, a rechecked pinned identity permits a PID kill while the
lock prevents child reaping/PID reuse. An incomplete sweep never enters a blocking wait;
cleanup repeats bounded passes until ECHILD. The leader remains unreaped until group
forwarding is disabled. Interrupts do not escalate. Init's signal report on the control
channel preserves termination signals separately from intentional exit codes such as 143.

**Coverage and fallbacks.** Status exposes files, network, signals, syscalls, devices, ipc,
processes and landlock_abi. `contains()` requires all seven boundaries contained and Linux
ABI >=3.
Default-deny filtering, minimal devices, metadata supervision and IPC isolation/refusal are
mandatory parts of the filtered launch. Missing setup reports partial with a plain reason.

| Kernel/ABI and setup                                                                                      | Coverage and reviews                                                                                                   |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| ABI 1 to 2                                                                                                | Files partial: no truncate right. Reviews stay.                                                                        |
| ABI 3 to 5, full policy and private namespace                                                             | All seven contained; reviews may drop. ABI 4+ adds Landlock TCP-port defense.                                          |
| ABI 6+, full policy and private namespace                                                                 | All seven contained, signals also by Landlock scoping; reviews may drop.                                               |
| ABI 6+, full policy, no unprivileged user namespaces                                                      | Processes partial (no process folder readable); the other six contained. Reviews stay.                                 |
| Landlock alone: unsupported architecture, filter/listener failure, Yama 2 to 3, or failed namespace setup | Files/syscalls/devices/IPC partial; network partial at ABI 4+ or none; signals contained only at ABI 6+. Reviews stay. |
| No Landlock                                                                                               | No sandbox; reviews stay.                                                                                              |

A real launcher probe checks workspace writes, denied outside writes, the proxy and refused
UDP. Every setup step must succeed before filtered coverage is reported, and is repeated on
every run. When the probe falls back to Landlock alone, metadata remains exposed, so files
are partial even on ABI 3+. The [ADR amendment](../../docs/adr/0167-spade-security-boundaries.md#amendment-1-linuxs-sandbox-as-built-2026-11-17)
records the choice and its limits.

**Apps and visibility.** Session bus, Wayland and X11 sockets are outside the workspace or
abstract, so commands cannot reach desktop apps. Their environment omits
DBUS_SESSION_BUS_ADDRESS, DISPLAY, WAYLAND_DISPLAY and XDG_RUNTIME_DIR. There is no desktop
bus/display grant yet. `/proc` shows only the command's own namespace (or no process folder at
all without one); Landlock also blocks other processes' memory, environment, fds and cwd. A credential
hard-linked inside a directory granted whole remains that directory's file, as on macOS.

**Building.** Debian 12/Ubuntu need build-essential, pkg-config and libseccomp-dev (2.5+),
then `cargo build -p spade-server`. Runtime needs libseccomp.so.2, util-linux setsid and
unshare, and unprivileged user namespaces for `contained` (without them processes are partial,
and below ABI 6 the filter can't run). See the
[syscall inventory](linux-syscalls.md) for the real-kernel verification procedure.

## Windows

`spade-sandbox-windows` holds the system calls (the one Spade crate allowed `unsafe`);
`spade-sandbox::windows` holds the policy and the launch; `spade-server` wires it in. **Each run**
gets its own AppContainer profile with **no capabilities** (derived from the bot and the run id),
so it starts with no access to anything and holds only its own grants — a plugin's extra folders
can't be reached by the bot's other running commands. The profile is deleted when the run ends.

A run is `contained` on Windows only when it **has no network** and is a **Less Privileged
AppContainer (LPAC)**: the process opts out of the
`ALL APPLICATION PACKAGES` SID (the `ALL_APPLICATION_PACKAGES_POLICY` proc-thread attribute), so
files, registry keys and COM objects that any app package may read system-wide are _not_ reachable —
only what the run's own container SID is granted, plus the core system binaries that carry the
restricted `ALL RESTRICTED APPLICATION PACKAGES` ACE the loader needs (`System32` keeps that ACE, so
`curl.exe`, `cmd.exe` and the system DLLs still load). (Measured on the VM, including as a standard
user: file-only tools run unchanged under LPAC and a file granted only to `ALL APPLICATION PACKAGES`
is then unreadable.)

**A networked run is not contained on Windows yet; it keeps the review path**, and its bot's
security view says "Windows can't seal off network commands yet, so Spade asks first." Under LPAC
`WSAStartup` fails — the Winsock catalog keys grant read to `ALL APPLICATION PACKAGES` and the
`registryRead` capability, not to the restricted group an LPAC keeps (measured) — so neither the
egress bridge nor the networked command could open a socket. As a plain AppContainer a networked run
would keep ambient read access to what every app package may read (files, some registry keys, COM
objects), which is not what `contained` promises. So: confining a networked run returns
needs-review; an unreviewed one is refused, never launched plainly; a reviewed one runs as on a
machine without the sandbox. The bot's network defaults to the allow list, so on Windows a bot's
commands are contained only once its network is off. A plugin's local server or hook that can't be
sealed off doesn't start until the person allows it to run outside the sandbox, through a request
card bound to the plugin's version, content hash, command and environment ([plugins.md](plugins.md),
"Local MCP servers"); it then runs plainly, labelled `outside_sandbox`, never `contained`, and its
tool calls keep their reviews.

**Why networked runs can't be an LPAC yet (measured, 2026-11-18).** With the `registryRead`
capability, Winsock starts under LPAC and the run's own sockets stay refused, but even a loopback
listener is refused (`WSAEACCES`, 10013): the egress bridge can't bind its port, so no socket path
to the proxy exists, and the tools can't use the SID-scoped pipe instead. A network capability
(`internetClient`) makes sockets work but reopens direct connections and DNS; Windows Firewall rules
for the run's package closed direct TCP and UDP but not name lookups (made by the DNS Client
service) or another loopback port, and would need elevation for every run's package. So networked
Windows runs keep the review path, with no setup step. Future options — an intercepting broker, a
Windows Filtering Platform callout or service-installed filter, or Windows letting an LPAC open
loopback sockets — are in ADR 0167 (Windows amendment, "Networked runs under LPAC").

**Spade only ever edits ACLs on folders it owns** (under its own data directory), because changing
ACLs on the person's folders touches other principals' inheritance and descendant identities.
So a run is `contained` only when its grants are Spade-owned:

- an inheritable _Modify_ ACE (read, write, execute, delete — but not `WRITE_DAC`/`WRITE_OWNER`) on
  the workspace, its `.spade/tmp` (`TEMP`/`TMP`), the terminal scratch, and a plugin folder that
  lives under Spade's data;
- toolchains are **read without any ACL change**: a toolchain Spade installs under its own data is
  granted the container SID like any owned folder, and `System32` binaries (`curl`, and the system
  DLLs) stay reachable under LPAC because they carry the restricted ACE. A toolchain under
  `Program Files` that is readable only by `ALL APPLICATION PACKAGES` is **not** reachable under
  LPAC — such a run is not contained unless the toolchain is a Spade-owned copy, and Spade never
  adds an ACE to the system's or the person's folders to make it work;
- nothing else, so the home folder, other users' folders, other bots' workspaces, and Spade's and
  ace's data are unreachable by default. The AppContainer can't reach the person's folders at all,
  so there is no deny to apply — the credential deny-list needs no ACEs here; the word list still
  refuses a call naming a credential place first.

Whether a run is containable is **proven by file identity, not by string prefixes**: each place it
needs is opened relative to a pinned handle and its identity (volume serial + file index) compared,
so a workspace, scratch folder or toolchain on another drive, behind a UNC path, or reached through
a junction does not pass, and a required place that is missing fails closed. Toolchains pass only
when they resolve inside Spade's data or inside a known system root (`%SystemRoot%`, `Program Files`,
`Program Files (x86)`), verified the same way. Deciding to confine returns an **explicit** result —
contained, needs-review, or no-sandbox — never an absent value a caller could read as "just launch
it": a plugin hook or local server that needs review does not start, a service never launches
unconfined, and the shell tool refuses a needs-review run unless it was already reviewed.

A run that needs any of the person's own folders (a consented project, a toolchain under
`%USERPROFILE%`) is **not** contained: it keeps the review path with the line "This needs your
folders, so Spade asks first", and Spade changes no ACLs. A brokered file-access path for the
person's folders is future work.

**Hard links can't smuggle a file in.** A contained run can't give one of the person's files a second
name inside its granted workspace and then reach the file's data through that name. Measured on the
VM through both the Win32 `CreateHardLink` path and the native
`NtSetInformationFile(FileLinkInformation)` path, under an LPAC token and a plain AppContainer one:
a link between two of the run's own files is made (the control); the person's file is refused at
_opening the source_; the run's own file linked into a folder it wasn't granted opens but is refused
at _creating the link_. The same three were also tried through `CreateHardLinkW` called directly,
with no pre-check of Spade's in front of it, under both tokens: Windows itself refuses the person's
file and the ungranted destination, and no link appears. The person's file keeps its single name.

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
disk (`FlushFileBuffers`) — _before_ the profile is created and before any ACL change, so a failure
anywhere is recoverable; a guard armed right after the grants takes them and the profile back if the
rest of setup (the bridge, the plan) fails. When the run ends — after its processes are gone, so no
open handle survives revocation — its grants are taken back by identity (so a renamed or moved
folder is still found; an object counts as gone only when the id lookup reports not-found, anything
ambiguous stays pending), the profile is deleted, and the journal is removed **last**, so a crash
between them keeps the bot gated. A revocation that can't be confirmed is kept pending, reported
(not swallowed), and the **bot's next run is refused until it clears**; a corrupt or unreadable
journal is itself a blocking error that gates every bot until a person clears it, and so is an entry
the journal folder fails to list (checked before any filtering, never skipped). Journal formats are
**explicit** — a version field, with the legacy `{container, paths}` form accepted (and migrated
forward) only when it carries `paths` and none of the new fields, and anything unparseable blocking
rather than read as empty. Each journal is marked **active, incomplete-setup or incomplete-cleanup**;
reconcile owns its own rollback, and any non-active journal that isn't resolved blocks the bot. A
failure to even enumerate the journals blocks too, except when the directory simply doesn't exist. On
start the daemon recovers every run's pending revocations. Deleting a bot takes back every run's
grants and deletes its profiles.

**Network (the egress bridge).** Built and tested, but not used for a contained run today: since a
networked run isn't contained on Windows yet (above), Spade doesn't launch one through it. An
AppContainer with no capabilities has no DNS and can't open a
loopback connection to a process outside the container, so it can't reach the proxy directly, and
the per-container loopback _exemption_ that would let it isn't port-scoped (it would open every
local port). Instead each networked run gets a bridge: a tiny process inside the container (same
SID and job as the command) listens on `127.0.0.1:<port>` — what `HTTP_PROXY` points at — and
forwards each connection over a named pipe whose DACL grants only that run's container SID to a
daemon-side acceptor, which splices it to the proxy's TCP port on loopback. The run's token still
rides in `HTTP_PROXY`, so the proxy identifies the run; the bridge and acceptor only move bytes,
and the acceptor stops when the run's ticket drops. The only way out of the container is that one
SID-scoped pipe. The acceptor makes its first pipe instance up front and **acknowledges readiness**;
the daemon waits for that and fails the run closed if the bridge can't come up, so a networked run
is never started silently without its egress boundary.

**The status's other boundaries.** The runner's status names `signals`, `syscalls`, `devices`, `ipc`
and `processes` beside files and network (see [Linux](#linux)). On Windows each is measured held by
the AppContainer (LPAC or plain): a contained run can't see or end a process of the person's
outside it, open their named objects, or open a device they can. `syscalls` means the operation, as
on macOS, not a syscall allowlist: every kernel object a run opens is checked against its container
token, and the job bars the desktop, clipboard and global atoms.

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

A bot's Permissions ([ADR 0171](../../docs/adr/0171-spade-decides-on-effects.md) amendment 7)
are switches over these settings, not grants: Computer use, Browser and Simulators decide driving
steps; Apps, Send as you and Payments refuse their effect while off; Commands and Network are the
bot's `commands` and network settings. Each is kept per bot (`security:<bot>`, `permissions`)
over the machine's default (`security.machine`), with the apps bots never use. Turning one on,
and dropping an app from the never-use list, needs the person's stamp (`security::attest`).

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
  server's call that runs in a sandbox holding files, signals and network here, with the proxy
  listening. It runs with no classifier, no credential word list and no review, untrusted
  content in view or not, unless its tool declares a payment, a send or an access change, or
  reads secrets. A checkpoint is taken first when one is due; when it can't be, the call is
  reviewed instead.
- **Outside the sandbox** (`Runs::Outside`): the bot's `commands` setting is `outside`, the
  person allowed this call outside, or the machine has no sandbox. The command is classed by the
  shell classifier and takes ADR 0163's route.

**The gate's decision travels to the launch.** For each call it lets run, the gate records an
immutable launch token under the call's key: _outside_ (sent outside the sandbox), _contained_
(decided in the sandbox's light, whether it skipped review because the sandbox held it or was
reviewed as a sandboxed command), or _reviewed_ (reviewed or approved without relying on the
sandbox). The shell takes the token instead of deciding again: a _contained_ call launches only
contained, and if the sandbox no longer holds it at launch (the person added a consented folder in
between, say) it is refused — "The command wasn't run: it was cleared to run in Spade's sandbox, but
the sandbox no longer holds it. Run it again and Spade will ask first." — never launched plainly; a
call the gate didn't mark counts as _contained_. A setting that changes in between never moves an
unreviewed call outside.

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
  at most once a minute per bot, and before the first such work of each turn whatever the minute,
  so a turn's changes can be undone without undoing an earlier turn's (only one that was taken
  counts; in memory, so a restart may take one sooner). When it can't be taken, the command or write goes to the review instead, and a
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

**Undo in the conversation.** The steps of a reply that changed the bot's files offer "Undo these
changes", and the reply's step line undoes the whole turn (from its first file-changing step).
Undo goes back to the newest checkpoint taken at or before the step started (`security/undo.rs`):
for a turn's first file-changing step that is the turn's own checkpoint. Before anything changes,
`GET …/checkpoints/undo?seq=` compares that copy with the workspace (size and time first, bytes
where they differ) and lists what would go back, be removed and come back; the person confirms and
the restore runs as above. Undo reaches only the workspace: what a step did outside it (a push, a
send, a payment, an app it changed, a command run outside the sandbox) can't be undone, and the
step says so. Which steps those are comes from what each tool declared to the gate (ADR 0171):
`tool_started` records that `effect`, and a `send_as_person`, `pay`, `publish`, `change_access`,
`network`, `drive` or `unknown` step reads as one undo can't reach, never by its tool's name. After a restore that changed anything the bot reads a `person_activity` note saying
its workspace went back and how many files changed, so it reads them again before relying on them.

## API

Under `/v1`, with the bearer token. Only the person's API writes any of this; no bot tool does.

| Method and path                                                                                 | Body                                   | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /security`                                                                                 |                                        | `{sandbox: {platform, mechanism: seatbelt\|landlock\|app_container\|none, files, network, signals, syscalls, devices, ipc, processes: contained\|partial\|none, landlock_abi, reason}, proxy: {running, problem}, contained, defaults: [host], bots: {commands, network: Policy, plugin_network: Policy}, toolchains_found: [path]}`                                                                                                    |
| `PUT /security/commands`                                                                        | `{commands: sandboxed\|outside}`       | The machine's view; what bots without their own inherit                                                                                                                                                                                                                                                                                                                                                                                 |
| `PUT /security/network`                                                                         | `{mode, allow?, dropped?}`             | The machine's view; `400` as for a bot's                                                                                                                                                                                                                                                                                                                                                                                                |
| `PUT /security/plugin-network`                                                                  | `{mode, allow?, dropped?}`             | As above, for plugins                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GET /agents/{id}/security`                                                                     |                                        | `{contained, reason, commands, network: Policy, plugin_network: Policy, own: {commands, network, plugin_network}, toolchains: [path], grants: [Grant], effective_grants: [Grant], folders: [{grant, path, write}]}` (what holds, and whether each is the bot's own; `contained` is this bot's, and `reason` the plain line when the machine has a sandbox but this bot's commands keep the review path, else `null`); `404` unknown bot |
| `PUT /agents/{id}/security/commands`                                                            | `{commands: sandboxed\|outside\|null}` | The bot's view; `null` follows the machine                                                                                                                                                                                                                                                                                                                                                                                              |
| `DELETE /agents/{id}/security/network`                                                          |                                        | The bot's view, its commands following the machine's rule again (`/plugin-network` likewise)                                                                                                                                                                                                                                                                                                                                            |
| `PUT /agents/{id}/security/network`                                                             | `{mode, allow?, dropped?}`             | The bot's view, as above; `400` for an entry that isn't a host, `*.host` or `host:port`, or a dropped name that isn't a default                                                                                                                                                                                                                                                                                                         |
| `PUT /agents/{id}/security/plugin-network`                                                      | `{mode, allow?, dropped?}`             | As above, for its plugins' hooks and servers                                                                                                                                                                                                                                                                                                                                                                                            |
| `PUT /agents/{id}/security/toolchains`                                                          | `{toolchains: [path]}`                 | The bot's view; `400` for a path that isn't an absolute folder or holds sign-ins or data                                                                                                                                                                                                                                                                                                                                                |
| `GET /agents/{id}/security/egress`                                                              | `?limit=` (1 to 5,000, default 200)    | `{entries: [Entry]}`, oldest first                                                                                                                                                                                                                                                                                                                                                                                                      |
| `GET /agents/{id}/grants`                                                                       |                                        | `{grants: [Grant], effective: [Grant]}`                                                                                                                                                                                                                                                                                                                                                                                                 |
| `POST /agents/{id}/grants`                                                                      | `{kind, …scope}`                       | `201 {grant}`; `400` refused (why); `404` unknown bot                                                                                                                                                                                                                                                                                                                                                                                   |
| `DELETE /agents/{id}/grants/{grant}`                                                            |                                        | `204`; `404` no such grant                                                                                                                                                                                                                                                                                                                                                                                                              |
| `GET /agents/{id}/checkpoints`                                                                  |                                        | `{checkpoints: [{id, at, reason}], keep: 20, longest_days: 7, every_seconds: 60}`, newest first                                                                                                                                                                                                                                                                                                                                         |
| `POST /agents/{id}/checkpoints`                                                                 |                                        | `201 {checkpoint}`; `400` when the workspace doesn't exist yet                                                                                                                                                                                                                                                                                                                                                                          |
| `GET /agents/{id}/checkpoints/undo`                                                             | `?seq=` (a `tool_started` position)    | `{checkpoint, changes: {changed, added, deleted, more}}` (paths in the workspace, at most 200 each); `404` no such step, or no checkpoint from before it                                                                                                                                                                                                                                                                                |
| `POST /agents/{id}/checkpoints/{c}/restore`                                                     |                                        | `200 {restored, saved}` (`saved`: the checkpoint taken just before); `404` no such checkpoint; `409` the bot is working                                                                                                                                                                                                                                                                                                                 |
| Settings are one stored setting per bot, `security:<bot id>`, and the machine's defaults,       |
| `security.machine`; a value that doesn't parse reads as the defaults. A bot's own value wins; a |
| stored network policy equal to the built-in default (every earlier build wrote one) reads as    |
| following the machine. A change holds from the bot's next run.                                  |

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

## Org hosts

On a Spade given to an organization, shared bots answer to their access lists and the
organization's policy, and their steps go on a signed audit log: [orgs.md](orgs.md) (ADR 0206).

## Not built yet

- A size bound on checkpoints (count and age only today; clones cost little on APFS, plain
  copies on other volumes don't).
- Egress for Windows runs without opening the network (ADR 0167 amendment 2, "Networked runs
  under LPAC": measured, no route qualified): until then a networked Windows run isn't contained
  and keeps the review path.
- A grant for the session bus or the display server on Linux: a tool that needs either runs
  outside the sandbox.
- Per-value provenance at egress, `derived` trust for network-off runs (each run's proxy usage
  is already counted), and quarantined readers.
- CLI brains in the sandbox (ADR 0133 keeps them on their own read-only modes).
- A publish tool of Spade's own (packages, releases): publishing is a declared effect of
  connector and plugin tools, or a command outside the sandbox.
- ace's plugin import carrying a server's `effects` declaration (ace's `PluginExecution` is
  strict); Spade reads it once it does.
- `own_only` for `pr_comment` grants (whether the bot opened the pull request).
