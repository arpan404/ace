//! Default-deny, native-architecture filter. New kernel calls never become permitted implicitly.
use super::{allowlist, metadata, terminal};
use libseccomp::{
    ScmpAction, ScmpArch, ScmpArgCompare, ScmpCompareOp, ScmpFilterContext, ScmpSyscall,
};
const EPERM: i32 = 1;
const ENOSYS: i32 = 38;
const CLONE_NEW: u64 = 0x0002_0000
    | 0x0200_0000
    | 0x0400_0000
    | 0x0800_0000
    | 0x1000_0000
    | 0x2000_0000
    | 0x4000_0000
    | 0x80;
const MSG_FASTOPEN: u64 = 0x2000_0000;

pub const SUPERVISED: &[&str] = &[
    "connect",
    "bind",
    "listen",
    "prlimit64",
    "sched_setaffinity",
    "sched_setscheduler",
    "sched_setparam",
    "sched_setattr",
    "setpriority",
    "ioprio_set",
    "kcmp",
    "pidfd_open",
];
fn native(name: &str) -> Option<ScmpSyscall> {
    ScmpSyscall::from_name(name)
        .ok()
        .filter(|c| i32::from(*c) >= 0)
}
fn equal(arg: u32, n: u64) -> ScmpArgCompare {
    ScmpArgCompare::new(arg, ScmpCompareOp::Equal, n)
}
fn masked(arg: u32, mask: u64, n: u64) -> ScmpArgCompare {
    ScmpArgCompare::new(arg, ScmpCompareOp::MaskedEqual(mask), n)
}

pub fn filter(
    landlock_truncates: bool,
    offline: bool,
    pairs: bool,
) -> Result<ScmpFilterContext, String> {
    if !matches!(ScmpArch::native(), ScmpArch::X8664 | ScmpArch::Aarch64) {
        return Err(
            "the default-deny syscall policy is verified only on x86_64 and aarch64".to_owned(),
        );
    }
    build(landlock_truncates, offline, pairs).map_err(|e| e.to_string())
}
fn build(
    landlock_truncates: bool,
    offline: bool,
    pairs: bool,
) -> Result<ScmpFilterContext, libseccomp::error::SeccompError> {
    let mut ctx = ScmpFilterContext::new(ScmpAction::Errno(EPERM))?;
    ctx.set_act_badarch(ScmpAction::KillProcess)?;
    ctx.set_ctl_nnp(true)?;
    for name in allowlist::DIRECT {
        if let Some(call) = native(name) {
            ctx.add_rule(ScmpAction::Allow, call)?;
        }
    }
    if landlock_truncates {
        ctx.add_rule(ScmpAction::Allow, ScmpSyscall::from_name("truncate")?)?;
    }
    for name in SUPERVISED.iter().chain(metadata::CALLS.iter()) {
        if let Some(call) = native(name) {
            ctx.add_rule(ScmpAction::Notify, call)?;
        }
    }
    // Linux assigned the same post-5.0 numbers on both supported 64-bit architectures.
    // Debian 12's libseccomp does not yet know fchmodat2, so resolve it explicitly.
    ctx.add_rule(ScmpAction::Notify, ScmpSyscall::from(452))?;
    ctx.add_rule_conditional(
        ScmpAction::Allow,
        ScmpSyscall::from_name("clone")?,
        &[masked(0, CLONE_NEW, 0)],
    )?;
    ctx.add_rule(ScmpAction::Errno(ENOSYS), ScmpSyscall::from_name("clone3")?)?;
    for (name, arg) in [("sendto", 3), ("sendmsg", 2), ("sendmmsg", 3)] {
        ctx.add_rule_conditional(
            ScmpAction::Allow,
            ScmpSyscall::from_name(name)?,
            &[masked(arg, MSG_FASTOPEN, 0)],
        )?;
    }
    for request in allowlist::IOCTL {
        ctx.add_rule_conditional(
            ScmpAction::Allow,
            ScmpSyscall::from_name("ioctl")?,
            &[equal(1, *request)],
        )?;
    }
    for request in terminal::CHANGES {
        ctx.add_rule_conditional(
            ScmpAction::Notify,
            ScmpSyscall::from_name("ioctl")?,
            &[equal(1, *request)],
        )?;
    }
    for command in allowlist::FCNTL {
        ctx.add_rule_conditional(
            ScmpAction::Allow,
            ScmpSyscall::from_name("fcntl")?,
            &[equal(1, *command)],
        )?;
    }
    for option in allowlist::PRCTL {
        ctx.add_rule_conditional(
            ScmpAction::Allow,
            ScmpSyscall::from_name("prctl")?,
            &[equal(0, *option)],
        )?;
    }
    // A read-only settled run is offline: no socket is created at all (ADR 0172, amendment 7), so
    // it can reach no machine, bind nothing and open no Unix socket. `socket`/`socketpair` fall to
    // the default EPERM. A normal run may make the TCP and Unix stream sockets its proxy and local
    // services need.
    if !offline {
        for family in [2, 10] {
            for protocol in [0, 6] {
                ctx.add_rule_conditional(
                    ScmpAction::Allow,
                    ScmpSyscall::from_name("socket")?,
                    &[equal(0, family), masked(1, 0xf, 1), equal(2, protocol)],
                )?;
            }
        }
        for name in ["socket", "socketpair"] {
            for kind in [1, 5] {
                ctx.add_rule_conditional(
                    ScmpAction::Allow,
                    ScmpSyscall::from_name(name)?,
                    &[equal(0, 1), masked(1, 0xf, kind), equal(2, 0)],
                )?;
            }
        }
    }
    // An offline run that may still pair (a sealed plugin server, ADR 0171 amendment 4): a
    // connected Unix socket pair reaches nothing outside the run, so only `socketpair(AF_UNIX,
    // SOCK_STREAM | SOCK_DGRAM, 0)` is let through; `socket` stays refused, so nothing can be
    // connected, bound or listened on.
    if offline && pairs {
        for kind in [1, 2] {
            ctx.add_rule_conditional(
                ScmpAction::Allow,
                ScmpSyscall::from_name("socketpair")?,
                &[equal(0, 1), masked(1, 0xf, kind), equal(2, 0)],
            )?;
        }
    }
    // GNU make restores its effective IDs before exec. Only the current real ID and
    // the no-change sentinel are admitted; no command can select another identity.
    for (name, id) in [
        ("setresuid", u64::from(rustix::process::getuid().as_raw())),
        ("setresgid", u64::from(rustix::process::getgid().as_raw())),
    ] {
        for real in [id, u64::from(u32::MAX)] {
            for effective in [id, u64::from(u32::MAX)] {
                for saved in [id, u64::from(u32::MAX)] {
                    ctx.add_rule_conditional(
                        ScmpAction::Allow,
                        ScmpSyscall::from_name(name)?,
                        &[
                            masked(0, 0xffff_ffff, real),
                            masked(1, 0xffff_ffff, effective),
                            masked(2, 0xffff_ffff, saved),
                        ],
                    )?;
                }
            }
        }
    }
    // Unknown numbers in Linux's current allocation range report ENOSYS for libc fallback.
    // Beyond that range the default remains EPERM. The explicit fchmodat2 rule is excluded.
    for number in 0..512 {
        let call = ScmpSyscall::from(number);
        if number != 452 && call.get_name().is_err() {
            ctx.add_rule(ScmpAction::Errno(ENOSYS), call)?;
        }
    }
    debug_assert!(ctx.is_arch_present(ScmpArch::native()).unwrap_or(false));
    Ok(ctx)
}
