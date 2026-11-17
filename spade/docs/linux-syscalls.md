# Linux syscall policy and release workload

The launcher installs a native default-deny seccomp filter on x86_64 and aarch64.
The sources in [allowlist.rs](../crates/spade-sandbox/src/linux/allowlist.rs),
[seccomp.rs](../crates/spade-sandbox/src/linux/seccomp.rs) and
[metadata.rs](../crates/spade-sandbox/src/linux/metadata.rs) define the policy. This inventory
explains its provenance and conditions; changing it also requires reviewing the actual rules.

## Admitted syscall numbers

| Rule                                | x86_64 | aarch64 |
| ----------------------------------- | -----: | ------: |
| Direct allow                        |    168 |     141 |
| Conditional arguments               |     12 |      12 |
| Supervised sockets and task effects |     12 |      12 |
| Supervised file metadata            |     18 |      12 |
| Total                               |    210 |     177 |

Counts are distinct native numbers with an allow or notify rule, on ABI >=3, using Debian
12 libseccomp 2.5.4 plus the explicit fchmodat2 rule. They exclude ENOSYS fallbacks. Native
aliases absent on an architecture receive no allow rule. Foreign architecture calls kill
the process, including i386 int 0x80 from an x86_64 process. Only these two native ABIs are
supported by the filtered probe.

### Direct allow

Landlock checks file data access and namespace operations. The remaining calls implement
address spaces, thread state, process/session lifecycle, scoped signals, local descriptors,
polling/timers and read-only facts. Native names (absent architecture aliases are skipped):

```text
read write readv writev pread64 pwrite64 preadv pwritev preadv2 pwritev2 open openat openat2
creat close close_range dup dup2 dup3 flock lseek getdents getdents64 fstat stat lstat
newfstatat statx statfs fstatfs access faccessat faccessat2 readlink readlinkat getcwd chdir
fchdir mkdir mkdirat rmdir unlink unlinkat rename renameat renameat2 link linkat symlink
symlinkat umask fsync fdatasync sync_file_range ftruncate fallocate fadvise64 readahead
sendfile copy_file_range brk mmap munmap mremap mprotect madvise mincore arch_prctl futex
set_tid_address set_robust_list rseq membarrier pipe pipe2 poll ppoll select pselect6
epoll_create epoll_create1 epoll_ctl epoll_wait epoll_pwait epoll_pwait2 eventfd eventfd2
signalfd signalfd4 timerfd_create timerfd_settime timerfd_gettime clock_gettime clock_getres
clock_nanosleep gettimeofday time nanosleep getitimer setitimer alarm times execve execveat
fork vfork exit exit_group wait4 waitid getpid getppid gettid getpgrp getpgid getsid setsid
setpgid rt_sigaction rt_sigprocmask rt_sigreturn rt_sigpending rt_sigsuspend rt_sigtimedwait
rt_sigqueueinfo rt_tgsigqueueinfo sigaltstack kill tkill tgkill pidfd_send_signal accept
accept4 getsockname getpeername getsockopt setsockopt shutdown recvfrom recvmsg recvmmsg getuid
geteuid getgid getegid getresuid getresgid getgroups getrandom uname sysinfo getcpu getrusage
getrlimit setrlimit capget sched_yield sched_getaffinity sched_getparam sched_getscheduler
sched_getattr sched_rr_get_interval getpriority ioprio_get landlock_create_ruleset
landlock_add_rule landlock_restrict_self restart_syscall
```

Signal delivery is scoped by the command's private PID namespace (every ABI where user
namespaces are allowed), by Landlock ABI 6+, and by its separate session. The kernel restricts wait calls to children and setpgid to the current session.
setrlimit has no external PID argument. Read-only scheduling/priority queries stay allowed.

### Conditional rules

| Syscall                   | Condition                                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| truncate                  | Landlock ABI >=3, which mediates truncation                                                                                        |
| clone                     | No CLONE_NEW* or CLONE_NEWTIME bits                                                                                                |
| socket, socketpair        | TCP stream on AF_INET/AF_INET6, protocol 0/TCP; Unix stream/seqpacket, protocol 0                                                  |
| sendto, sendmsg, sendmmsg | No MSG_FASTOPEN                                                                                                                    |
| ioctl                     | Read-only terminal queries, TIOCSCTTY/TIOCSPGRP (kernel-scoped to the own ctty), FIONREAD/FIONBIO, CLOEXEC, FICLONE/FICLONERANGE   |
| fcntl                     | Duplication, fd/status flags, POSIX/OFD locks, pipe sizes, seals; no signal ownership/recipient, leases or directory notifications |
| prctl                     | Explicit self-only runtime/security/query options; no SET_MM, ptracer or nested seccomp                                            |
| setresuid, setresgid      | Every low-32-bit argument is the launcher's current real ID or UINT_MAX (no change)                                                |

The numeric ioctl/fcntl/prctl selectors are in allowlist.rs. The direct ioctl requests are
TCGETS, TCGETS2 (glibc 2.42 and later use it for tcgetattr and isatty), TIOCSCTTY, TIOCGPGRP,
TIOCSPGRP, TIOCGWINSZ, TIOCGSID, FIONREAD, FIONBIO, FIONCLEX, FIOCLEX, TIOCGPTN, FICLONE and
FICLONERANGE. Terminal changes are supervised instead (below); TIOCSPTLCK is no longer
admitted, since the command never holds a pty master. Clone3 returns ENOSYS so libc
can use checked clone. Unknown numbers in 0 to 511 return ENOSYS; fchmodat2 (452) is explicitly
notified even when the installed libseccomp does not know it. All other unlisted numbers
return EPERM, including new kernel calls unknown to this build.

### Supervised rules

Socket and PID/TID effects:

```text
connect bind listen prlimit64 sched_setaffinity sched_setscheduler sched_setparam sched_setattr
setpriority ioprio_set kcmp pidfd_open
```

Terminal changes, by ioctl request (same numbers on both architectures):

```text
TCSETS 0x5402  TCSETSW 0x5403  TCSETSF 0x5404  TIOCSWINSZ 0x5414
TCSETS2 0x402c542b  TCSETSW2 0x402c542c  TCSETSF2 0x402c542d
```

The supervisor copies the termios/termios2 or winsize value, duplicates the caller's fd and
performs the change itself only when that fd is the command's dedicated pty (device and inode
of the node the launcher granted). Another terminal answers EPERM, a non-terminal ENOTTY.

Socket operations copy the address, pin the fd and execute in the supervisor under an
inode lock. No pointer-dependent operation continues in the caller. Scalar PID/TID calls
continue only after the self-target checks, with syscall-specific zero/selectors/flags.

Metadata:

```text
chmod fchmod fchmodat fchmodat2 chown fchown lchown fchownat setxattr lsetxattr fsetxattr
removexattr lremovexattr fremovexattr utime utimes futimesat utimensat
```

All metadata operations execute in the supervisor on a no-follow pinned object, authorized
against the actual carved write-grant objects installed in Landlock. Relative paths use the
caller's pinned cwd/dirfd. FD variants duplicate and verify the reopened object identity.
Only explicit no-follow chown/time calls can mutate a symlink itself. Values and paths are
copied, not reused from mutable caller memory. Symlink ancestors and unresolvable/deleted
FD paths are refused. All six legacy metadata aliases absent on aarch64 remain covered on
x86_64; compat ABIs are killed rather than translated.

## What remains refused

An unlisted known call returns EPERM. This includes all SysV IPC: shmget/shmat/shmdt/shmctl,
msgget/msgsnd/msgrcv/msgctl, semget/semop/semtimedop/semctl; io_uring; ptrace/process_vm and
fd-targeted process memory changes; namespace/mount changes; kernel administration; keys;
perf/BPF/userfaultfd; personality; mknod; arbitrary ioctl/fcntl/prctl; and new interfaces not
reviewed here. This is an allowlist, so absence is sufficient to refuse a call.

Minimal /dev rules grant null/zero/full/random/urandom/tty and the command's dedicated pty,
which the outermost launcher opens in place of any terminal on its stdio and relays; the
person's own terminal is never granted. No whole /dev or /dev/pts, no ptmx, and no /dev/shm.
Broad consent cannot reopen /dev. The launcher uses exact Landlock rules instead of retaining
mount privileges for private devpts/tmpfs; commands can't create new PTYs or POSIX shm. On every
ABI the launcher requests a private user, PID, IPC and mount namespace with a fresh /proc, so
/proc lists only the command's processes. Without unprivileged user namespaces it grants only
/proc's machine-wide entries and reports processes partial; SysV refusal and absent /dev/shm
still provide the IPC boundary.

## Workload evidence

The initial default-allow workload was traced with strace -ff on the real 6.8 kernel before
installing the allowlist. Existing sandbox/security/effects suites supplied socket, process,
service and proxy cases. The policy includes observed calls and reviewed architecture aliases
and runtime primitives, rather than permitting everything seen in the outer supervisor.
For example, unshare and host pidfd_getfd belong to the unrestricted supervisor and are
never admitted to the command. Metadata observations became notifications, not direct grants.

The first filtered smoke exposed make's setresuid(-1,1000,-1) restoration, so the policy
added only same-ID/no-change setresuid and setresgid combinations. Traces also exercised
rseq, close_range, epoll_pwait, faccessat2, statx, prlimit64 and supervised fchmod/utimensat.
Cross-architecture validation covers x86 legacy open/stat/pipe/dup2/arch_prctl and metadata
aliases, as well as aarch64's *at/pipe2/dup3 forms. Fcntl signal-owner refusal has a real
regression test; its previous unrestricted rule accepted F_SETOWN.

The reproducible smoke is [tests/smoke.rs](../crates/spade-sandbox/tests/smoke.rs). It uses
Spade's actual egress proxy and verifies at least three proxy connections. It performs:

1. Depth-one HTTPS git clone of octocat/Hello-World through the proxy and verifies README.
2. Cargo build of a fixture depending on itoa downloaded from crates.io and runs the binary.
3. npm install --ignore-scripts --no-audit --no-fund of is-number 7.0.0 (a package without install scripts) and a Node require/assertion.
4. python3 -m venv including ensurepip and a check that the venv interpreter is isolated.
5. make of a C program with cc and checks its output.
6. cargo test --offline on the fixture, including a real formatting assertion.

Each has a smoke:<step> completion marker. Network failures remain test failures; there is
no canned proxy or offline dependency substitution. Optional SPADE_SMOKE_TRACE=/work/trace
runs strace around the launcher and preserves per-process traces outside the test workspace.

## Real-kernel reproduction

Use Debian 12 containers on actual Linux 6.8 (Landlock ABI 4) and 6.12 (ABI 6). Run as a
non-root user with all capabilities dropped and --security-opt seccomp=unconfined so Spade
can install its own filter. Disable the container's proc system-path masking as well
(nerdctl --security-opt systempaths=unconfined), permitting unprivileged mount-proc setup.
The host supervisor remains unconfined; the command receives the product's restrictions.
An x86_64 QEMU system VM supplies a real x86_64 kernel on an aarch64 development machine;
user-mode syscall translation is not a kernel verification.

Install the Rust toolchain, libseccomp development headers, git, node/npm, python3-venv,
make, cc, strace, dbus utilities, util-linux and CA roots. From spade/:

```sh
cargo fmt --all --check
cargo clippy --all-targets
cargo test -p spade-sandbox --no-fail-fast
cargo test -p spade-server --test security --test effects --no-fail-fast
cargo test -p spade-sandbox --test smoke -- --ignored --nocapture
```

The smoke is ignored during ordinary tests because it downloads public dependencies and
needs all developer tools; the explicit release command runs it. Compatibility-ABI refusal
is x86_64-only. Regression tests use actual same-user PTYs, writable versus readable grant
objects, metadata symlink races, host shared memory and SysV objects. Cleanup tests create
160 detached children at RLIMIT_NOFILE=64, then separately lower the actual reaper's limit
to force EMFILE, on both namespace and Landlock-scoped paths. They assert a shutdown deadline
and no continuing descendant heartbeat.

Process visibility and the dedicated terminal need no container setup beyond the above: run
the suites as an ordinary user with no capabilities. tests/processes.rs starts an outside
process whose command line carries a marker and checks it can't be read, by number or by
listing /proc, in both plans; tests/terminal.rs hands the launcher a real same-user pty as the
person's terminal (and leaks it as fd 9) and checks that size and mode changes land only on the
dedicated pty, keystrokes are relayed, and pipes stay pipes. The no-user-namespace fallback
can be exercised without root by lowering user.max_user_namespaces to 0 inside a throwaway user
namespace, dropping every capability (setpriv) and probing there.

Capture test exit statuses plus grep -c -- '--- FAILED' and grep -c '^error: test failed'
on each final suite/smoke log. Intentional red runs are kept separately. Remove test
containers and stop every test VM after preserving logs.

## Release verification on 2026-11-17

All runs used Debian 12, UID/GID 1000 and zero inherited, permitted, effective, bounding and
ambient capabilities. Runtime versions were Cargo 1.95.0, git 2.39.5, Node 18.20.4,
npm 9.2.0, Python 3.11.2, GNU Make 4.3 and GCC 12.2.0.

| Native architecture | Kernel                       | Landlock ABI | Sandbox + security + effects passed | Smoke steps | Both requested grep counts |
| ------------------- | ---------------------------- | -----------: | ----------------------------------: | ----------: | -------------------------- |
| aarch64             | 6.8.0-134-generic            |            4 |                                 121 |         6/6 | 0 / 0                      |
| aarch64             | 6.12.117+deb13-cloud-arm64   |            6 |                                 121 |         6/6 | 0 / 0                      |
| x86_64              | 6.8.0-134-generic            |            4 |                                 122 |         6/6 | 0 / 0                      |
| x86_64              | 6.12.115+deb13.1-cloud-amd64 |            6 |                                 122 |         6/6 | 0 / 0                      |

The normal suite reports one ignored smoke test; it was then explicitly run and passed on
each machine. x86_64 has the additional compatibility-ABI regression. The 121/122 counts
exclude the separately run smoke harness and its inner Cargo fixture test. Fmt and clippy
--all-targets passed, including x86_64 cross-target clippy before native execution.

An additional isolated cargo test --workspace --no-fail-fast on aarch64/ABI 4 had 1,508
passing tests, two failing tests and four ignored tests. Both failures also reproduced from
origin/main (3abdafcc57) in the same container:

- spade-mcp/stdio: a_local_server_lists_its_tools_answers_a_call_and_gets_none_of_spades_environment
- spade-mcp/stdio: closing_a_local_server_ends_what_it_started_too

That broader log has grep counts 0 / 1 (one failing target); the four requested boundary
runs and smoke logs each have 0 / 0. Earlier setup/transient logs are separate from final
results: the full workspace needed the hosted client-document fixture, comparison builds
must not share live workspace artifacts, and the QEMU cleanup fixture needed a start barrier
before descendant heartbeat traffic. Its shutdown assertion still uses a deadline, 160
detached children, a 64-fd limit and explicit reaper EMFILE injection.

## Process visibility and dedicated terminal, 2026-11-17

Verified natively on an x86_64 Arch-based desktop, kernel 7.2.15 (Landlock ABI 10), glibc
2.44, util-linux 2.42.4, libseccomp 2.6.0 and Rust 1.95.0, as UID 1000 with zero capabilities.
Unprivileged user namespaces are allowed there, so the probe reported all seven boundaries
contained. Before this change, glibc 2.44's tcgetattr and ttyname failed with EPERM inside the
sandbox on a terminal, because they use TCGETS2; it is now a direct read-only request.

| Suite                                                      | Passed | Ignored | Both requested grep counts |
| ---------------------------------------------------------- | -----: | ------: | -------------------------- |
| cargo test -p spade-sandbox                                |    125 |       1 | 0 / 0                      |
| cargo test -p spade-server --test security --test effects  |     24 |       0 | 0 / 0                      |
| cargo test -p spade-server --test computer (terminal tool) |     29 |       0 | 0 / 0                      |

The ignored test is the networked smoke, not run here. The sandbox count is after the
review follow-up (launcher state over the control channel, the output filter and the raw-mode
guard); it was 113 before it. The no-user-namespace fallback was
probed inside a user namespace with user.max_user_namespaces set to 0 and every capability
dropped: processes partial with the plain reason, the other six boundaries contained.
