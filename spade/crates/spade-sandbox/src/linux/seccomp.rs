//! Linux's seccomp filter (ADR 0167 decision 1): what a sandboxed command may not call at all,
//! and the calls the supervisor does for it. Built with libseccomp for this machine's own
//! architecture; a call made through another one (32-bit `int 0x80` on x86-64) kills the process.
//!
//! Refused with `EPERM`:
//! - sockets other than TCP (`AF_INET`/`AF_INET6`, `SOCK_STREAM`, protocol 0 or TCP) and Unix
//!   stream or seqpacket ones: no UDP (so no DNS), raw, packet, netlink or other families, and no
//!   Unix datagrams (which could be sent to any socket by path);
//! - TCP Fast Open's `MSG_FASTOPEN`, which connects without `connect`;
//! - reaching other processes or the kernel: `ptrace`, `process_vm_*`, `pidfd_getfd`, `bpf`,
//!   `perf_event_open`, `userfaultfd`, `keyctl` and the key calls, `io_uring` (whose operations
//!   skip this filter);
//! - changing what the file system or the system is: `mount` and the new mount calls,
//!   `pivot_root`, `chroot`, `unshare`, `setns`, new namespaces from `clone`, the module, `kexec`,
//!   `reboot`, `swap` and accounting calls, `open_by_handle_at`;
//! - typing into the terminal (`TIOCSTI`, `TIOCLINUX`), which would reach the person's shell;
//! - a nested seccomp listener, which would let the command answer for itself;
//! - `truncate` by path where Landlock is older than ABI 3 and doesn't hold it.
//!
//! `clone3` answers `ENOSYS` (its flags are behind a pointer), so the C library falls back to
//! `clone`, whose flags the filter reads. `connect`, `bind` and `listen` go to the supervisor.

use libseccomp::{
    ScmpAction, ScmpArch, ScmpArgCompare, ScmpCompareOp, ScmpFilterContext, ScmpSyscall,
};

const AF_UNIX: u64 = 1;
const AF_INET: u64 = 2;
const AF_INET6: u64 = 10;
/// One past the highest address family Linux knows (`AF_MAX`).
const AF_MAX: u64 = 46;
const SOCK_STREAM: u64 = 1;
const SOCK_SEQPACKET: u64 = 5;
/// The type's low bits; the rest are `SOCK_NONBLOCK` and `SOCK_CLOEXEC`.
const SOCK_TYPE_MASK: u64 = 0xf;
const IPPROTO_TCP: u64 = 6;
const MSG_FASTOPEN: u64 = 0x2000_0000;
const TIOCSTI: u64 = 0x5412;
const TIOCLINUX: u64 = 0x541c;
const SECCOMP_FILTER_FLAG_NEW_LISTENER: u64 = 8;
/// `CLONE_NEWNS`, `CLONE_NEWCGROUP`, `CLONE_NEWUTS`, `CLONE_NEWIPC`, `CLONE_NEWUSER`,
/// `CLONE_NEWPID`, `CLONE_NEWNET`, `CLONE_NEWTIME`.
const CLONE_NEW: &[u64] = &[
    0x0002_0000,
    0x0200_0000,
    0x0400_0000,
    0x0800_0000,
    0x1000_0000,
    0x2000_0000,
    0x4000_0000,
    0x80,
];

const EPERM: i32 = 1;
const ENOSYS: i32 = 38;

/// Refused outright. Names this architecture doesn't have are skipped.
const REFUSED: &[&str] = &[
    "ptrace",
    "process_vm_readv",
    "process_vm_writev",
    "pidfd_getfd",
    "bpf",
    "perf_event_open",
    "userfaultfd",
    "keyctl",
    "add_key",
    "request_key",
    "io_uring_setup",
    "io_uring_enter",
    "io_uring_register",
    "mount",
    "umount2",
    "move_mount",
    "open_tree",
    "fsopen",
    "fsconfig",
    "fsmount",
    "fspick",
    "mount_setattr",
    "pivot_root",
    "chroot",
    "unshare",
    "setns",
    "init_module",
    "finit_module",
    "delete_module",
    "kexec_load",
    "kexec_file_load",
    "reboot",
    "swapon",
    "swapoff",
    "acct",
    "open_by_handle_at",
    "name_to_handle_at",
    "fanotify_init",
    "lookup_dcookie",
    "quotactl",
    "syslog",
    "uselib",
    "vhangup",
    "iopl",
    "ioperm",
    "modify_ldt",
];

/// Socket operations are performed by the supervisor; scalar PID targets are checked there.
pub const SUPERVISED: &[&str] = &[
    "connect",
    "bind",
    "listen",
    "prlimit64",
    "sched_setaffinity",
    "sched_setscheduler",
    "sched_setparam",
    "setpriority",
    "ioprio_set",
    "kcmp",
    "pidfd_open",
];

/// The filter. `landlock_truncates`: Landlock (ABI 3 and later) holds `truncate`.
pub fn filter(
    landlock_truncates: bool,
) -> Result<ScmpFilterContext, libseccomp::error::SeccompError> {
    let mut ctx = ScmpFilterContext::new(ScmpAction::Allow)?;
    ctx.set_act_badarch(ScmpAction::KillProcess)?;
    ctx.set_ctl_nnp(true)?;
    let refuse = ScmpAction::Errno(EPERM);
    for name in REFUSED {
        if let Ok(call) = ScmpSyscall::from_name(name) {
            ctx.add_rule(refuse, call)?;
        }
    }
    // This fd-targeted call cannot safely be continued after checking a mutable fd table.
    // An older libseccomp that cannot name it must fail the probe, never silently allow it.
    ctx.add_rule(refuse, ScmpSyscall::from_name("process_madvise")?)?;
    if !landlock_truncates {
        ctx.add_rule(refuse, ScmpSyscall::from_name("truncate")?)?;
    }
    ctx.add_rule(ScmpAction::Errno(ENOSYS), ScmpSyscall::from_name("clone3")?)?;
    let clone = ScmpSyscall::from_name("clone")?;
    for flag in CLONE_NEW {
        ctx.add_rule_conditional(refuse, clone, &[masked(0, *flag, *flag)])?;
    }
    let seccomp = ScmpSyscall::from_name("seccomp")?;
    ctx.add_rule_conditional(
        refuse,
        seccomp,
        &[masked(
            1,
            SECCOMP_FILTER_FLAG_NEW_LISTENER,
            SECCOMP_FILTER_FLAG_NEW_LISTENER,
        )],
    )?;
    let ioctl = ScmpSyscall::from_name("ioctl")?;
    for request in [TIOCSTI, TIOCLINUX] {
        ctx.add_rule_conditional(refuse, ioctl, &[masked(1, 0xffff_ffff, request)])?;
    }
    sockets(&mut ctx, refuse)?;
    for (name, flags) in [("sendto", 3), ("sendmsg", 2), ("sendmmsg", 3)] {
        ctx.add_rule_conditional(
            refuse,
            ScmpSyscall::from_name(name)?,
            &[masked(flags, MSG_FASTOPEN, MSG_FASTOPEN)],
        )?;
    }
    for name in SUPERVISED {
        ctx.add_rule(ScmpAction::Notify, ScmpSyscall::from_name(name)?)?;
    }
    // The filter is for this machine's architecture alone.
    debug_assert!(ctx.is_arch_present(ScmpArch::native()).unwrap_or(false));
    Ok(ctx)
}

fn masked(arg: u32, mask: u64, value: u64) -> ScmpArgCompare {
    ScmpArgCompare::new(arg, ScmpCompareOp::MaskedEqual(mask), value)
}

fn equal(arg: u32, value: u64) -> ScmpArgCompare {
    ScmpArgCompare::new(arg, ScmpCompareOp::Equal, value)
}

/// `socket` and `socketpair`: only TCP and Unix stream or seqpacket sockets. libseccomp compares
/// an argument once per rule, so what is refused is listed: every other family, every other
/// type, every other protocol.
fn sockets(
    ctx: &mut ScmpFilterContext,
    refuse: ScmpAction,
) -> Result<(), libseccomp::error::SeccompError> {
    let socket = ScmpSyscall::from_name("socket")?;
    let pair = ScmpSyscall::from_name("socketpair")?;
    for family in (0..AF_MAX).filter(|f| ![AF_UNIX, AF_INET, AF_INET6].contains(f)) {
        ctx.add_rule_conditional(refuse, socket, &[equal(0, family)])?;
    }
    ctx.add_rule_conditional(
        refuse,
        socket,
        &[ScmpArgCompare::new(0, ScmpCompareOp::GreaterEqual, AF_MAX)],
    )?;
    ctx.add_rule_conditional(
        refuse,
        pair,
        &[ScmpArgCompare::new(0, ScmpCompareOp::NotEqual, AF_UNIX)],
    )?;
    for kind in (0..=SOCK_TYPE_MASK).filter(|t| *t != SOCK_STREAM) {
        for family in [AF_INET, AF_INET6] {
            ctx.add_rule_conditional(
                refuse,
                socket,
                &[equal(0, family), masked(1, SOCK_TYPE_MASK, kind)],
            )?;
        }
        if kind != SOCK_SEQPACKET {
            for call in [socket, pair] {
                ctx.add_rule_conditional(
                    refuse,
                    call,
                    &[equal(0, AF_UNIX), masked(1, SOCK_TYPE_MASK, kind)],
                )?;
            }
        }
    }
    // TCP only: protocol 0 (the default) or `IPPROTO_TCP`, never MPTCP or SCTP over a stream.
    for family in [AF_INET, AF_INET6] {
        for protocol in 1..IPPROTO_TCP {
            ctx.add_rule_conditional(refuse, socket, &[equal(0, family), equal(2, protocol)])?;
        }
        ctx.add_rule_conditional(
            refuse,
            socket,
            &[
                equal(0, family),
                ScmpArgCompare::new(2, ScmpCompareOp::Greater, IPPROTO_TCP),
            ],
        )?;
    }
    Ok(())
}
