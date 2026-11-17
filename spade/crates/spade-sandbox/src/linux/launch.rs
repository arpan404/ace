//! The launcher (`spade sandbox-exec <plan> <program> <args>…`) and the probe that tests it.
//!
//! The launcher stays outside the sandbox. It carves the plan's roots (opening each place it
//! grants), lowers the process and file limits, then starts one thread that applies Landlock and
//! the seccomp filter to itself alone and starts the command, which inherits both. The launcher's
//! other threads answer the filter's network calls ([`super::supervise`]), pass on `SIGTERM` and
//! `SIGHUP`, adopt whatever the command leaves behind (so it stays a descendant the supervisor may
//! reach) and end with the command's own exit.

use std::ffi::{OsStr, OsString};
use std::os::fd::RawFd;
use std::path::Path;
use std::process::ExitCode;
use std::sync::mpsc;

use landlock::{
    ABI, Access, AccessFs, AccessNet, CompatLevel, Compatible, LandlockStatus, NetPort,
    PathBeneath, Ruleset, RulesetAttr, RulesetCreated, RulesetCreatedAttr, RulesetStatus, Scope,
};
use rustix::process::{Pid, Resource, Rlimit, Signal, WaitOptions};

use super::net::Rules;
use super::{Network, Plan, RealFs, carve, seccomp, supervise};

/// The highest ABI this build asks for; the kernel's own is used where it is lower.
const ABI_WANTED: ABI = ABI::V9;
/// Open files per process.
const MAX_FILES: u64 = 65_536;
/// Tasks the run may add to what the machine already has (`RLIMIT_NPROC` counts the person's).
const MORE_TASKS: u64 = 4_096;

/// Applies `plan` around `program args` and answers its exit.
pub fn main(args: &[OsString]) -> ExitCode {
    let namespaced = args.first().is_some_and(|a| a == "--private-pid-init");
    let marker = if namespaced { args.get(1) } else { None };
    let args = if namespaced {
        args.get(2..).unwrap_or_default()
    } else {
        args
    };
    let refused = |why: &str| {
        eprintln!("spade sandbox-exec: {why}");
        ExitCode::from(126)
    };
    let (Some(plan), Some(program)) = (args.first(), args.get(1)) else {
        return refused("a plan and a program are needed");
    };
    let Some(plan) = plan
        .to_str()
        .and_then(|text| serde_json::from_str::<Plan>(text).ok())
    else {
        return refused("the plan doesn't parse");
    };
    if namespaced && rustix::process::getpid().as_raw_nonzero().get() != 1 {
        return refused("the signal supervisor must be the private PID namespace's init");
    }
    // Detect ABI on a disposable thread, so the launcher itself remains unrestricted.
    let abi = std::thread::spawn(|| {
        Ruleset::default()
            .handle_access(AccessFs::from_all(ABI_WANTED))
            .and_then(|r| r.create())
            .and_then(|r| r.restrict_self())
            .map(|s| effective(&s.landlock))
            .unwrap_or(0)
    })
    .join()
    .unwrap_or(0);
    if plan.network == Network::Filtered && abi < 6 && !namespaced {
        // util-linux creates the user, mount and PID namespaces before this launcher starts
        // threads or installs restrictions. Its init is the supervisor, which reaps children.
        return super::namespace::run(args).unwrap_or_else(|why| refused(&why));
    }
    let ending = if let Some(path) = marker {
        let file = std::fs::OpenOptions::new().write(true).open(path);
        if let Err(e) = std::fs::remove_file(path) {
            return refused(&e.to_string());
        }
        match file {
            Ok(file) => Some(file),
            Err(e) => return refused(&e.to_string()),
        }
    } else {
        None
    };
    match run(&plan, program, &args[2..], ending) {
        Ok(code) => code,
        Err(why) => refused(&why),
    }
}

enum Started {
    Listener(RawFd),
    Child(std::process::Child),
    Failed(String),
}

fn run(
    plan: &Plan,
    program: &OsStr,
    args: &[OsString],
    ending: Option<std::fs::File>,
) -> Result<ExitCode, String> {
    let ruleset = ruleset(plan).map_err(|e| format!("the sandbox could not be applied: {e}"))?;
    limit().map_err(|e| format!("the sandbox's limits could not be set: {e}"))?;
    // What the command leaves running stays the launcher's, so the supervisor may still reach
    // its sockets (`pidfd_getfd` needs a descendant where Yama is on).
    rustix::process::set_child_subreaper(Some(rustix::process::getpid()))
        .map_err(|e| format!("the launcher could not adopt the command's processes: {e}"))?;
    let mut signals = signal_hook::iterator::Signals::new([
        signal_hook::consts::SIGINT,
        signal_hook::consts::SIGQUIT,
        signal_hook::consts::SIGTERM,
        signal_hook::consts::SIGHUP,
    ])
    .map_err(|e| format!("the launcher could not hold its signals: {e}"))?;
    let (send, started) = mpsc::channel();
    let network = plan.network;
    let (program, args) = (program.to_owned(), args.to_vec());
    std::thread::spawn(move || confined(ruleset, network, &program, &args, &send));
    let mut child = None;
    for message in started {
        match message {
            Started::Listener(listener) => {
                let rules = Rules {
                    proxy_port: plan.proxy_port,
                    sockets: plan.sockets.clone(),
                };
                std::thread::spawn(move || supervise::serve(listener, rules));
            }
            Started::Child(started) => child = Some(started),
            Started::Failed(why) => return Err(why),
        }
    }
    let child = child.ok_or("the command could not start")?;
    let pid = Pid::from_child(&child);
    // Ctrl-C and Ctrl-\ reach the command from its terminal; the launcher only outlives them.
    // A `SIGTERM` or `SIGHUP` sent to the launcher alone is passed on.
    std::thread::spawn(move || {
        for signal in signals.forever() {
            let forwarded = match signal {
                signal_hook::consts::SIGTERM => Some(Signal::TERM),
                signal_hook::consts::SIGHUP => Some(Signal::HUP),
                _ => None,
            };
            if let Some(forwarded) = forwarded {
                let _ = rustix::process::kill_process(pid, forwarded);
            }
        }
    });
    Ok(reap(pid, ending))
}

/// The thread that becomes the sandbox: applies the ruleset and the filter to itself, then
/// starts the command, which inherits both.
fn confined(
    ruleset: RulesetCreated,
    network: Network,
    program: &OsStr,
    args: &[OsString],
    send: &mpsc::Sender<Started>,
) {
    let fail = |why: String| {
        let _ = send.send(Started::Failed(why));
    };
    let abi = match ruleset.restrict_self() {
        Ok(status) if status.ruleset != RulesetStatus::NotEnforced => effective(&status.landlock),
        Ok(_) => return fail("this kernel doesn't enforce Landlock".to_owned()),
        Err(error) => return fail(format!("the sandbox could not be applied: {error}")),
    };
    if network == Network::Filtered {
        let loaded = seccomp::filter(abi >= 3).and_then(|filter| {
            filter.load()?;
            filter.get_notify_fd()
        });
        match loaded {
            Ok(listener) => {
                let _ = send.send(Started::Listener(listener));
            }
            Err(error) => return fail(format!("the network filter could not be applied: {error}")),
        }
    }
    match std::process::Command::new(program).args(args).spawn() {
        Ok(child) => {
            let _ = send.send(Started::Child(child));
        }
        Err(error) => fail(format!("the command could not start: {error}")),
    }
}

/// The Landlock ABI in force, as a number (a newer kernel's own when this build knows less).
fn effective(status: &LandlockStatus) -> u8 {
    let LandlockStatus::Available {
        effective_abi,
        kernel_abi,
    } = status
    else {
        return 0;
    };
    if let Some(kernel) = kernel_abi.and_then(|k| u8::try_from(k).ok()) {
        return kernel;
    }
    match effective_abi {
        ABI::V1 => 1,
        ABI::V2 => 2,
        ABI::V3 => 3,
        ABI::V4 => 4,
        ABI::V5 => 5,
        ABI::V6 => 6,
        ABI::V7 => 7,
        ABI::V8 => 8,
        ABI::V9 => 9,
        _ => 0,
    }
}

/// The plan as a Landlock ruleset, its roots carved and opened now: the descriptors carving
/// opened are the ones the rules hold.
fn ruleset(plan: &Plan) -> Result<RulesetCreated, landlock::RulesetError> {
    // Every TCP connect is handled, so with no port in the plan none is allowed. Signals and
    // abstract Unix sockets stay inside the sandbox where the kernel scopes them (ABI 6).
    let mut created = Ruleset::default()
        .handle_access(AccessFs::from_all(ABI_WANTED))?
        .handle_access(AccessNet::ConnectTcp)?
        .scope(Scope::from_all(ABI_WANTED))?
        .create()?;
    for root in &plan.roots {
        let access = if root.write {
            AccessFs::from_all(ABI_WANTED)
        } else {
            AccessFs::from_read(ABI_WANTED)
        };
        for (_, fd) in carve(&RealFs, root) {
            created = created.add_rule(PathBeneath::new(fd, access))?;
        }
    }
    if let Some(port) = plan.proxy_port {
        created = created.add_rule(NetPort::new(port, AccessNet::ConnectTcp))?;
    }
    Ok(created)
}

/// Lowers the open-file limit to [`MAX_FILES`] and the task limit to what runs now plus
/// [`MORE_TASKS`]: a fork bomb stops there.
fn limit() -> rustix::io::Result<()> {
    let lower = |resource: Resource, most: u64| {
        let now = rustix::process::getrlimit(resource);
        let maximum = Some(now.maximum.map_or(most, |m| m.min(most)));
        let current = Some(now.current.map_or(most, |c| c.min(most)).min(most));
        rustix::process::setrlimit(resource, Rlimit { current, maximum })
    };
    lower(Resource::Nofile, MAX_FILES)?;
    let running = std::fs::read_to_string("/proc/loadavg")
        .ok()
        .and_then(|text| {
            let field = text.split_whitespace().nth(3)?;
            field.split('/').nth(1)?.parse::<u64>().ok()
        })
        .unwrap_or(32_768);
    lower(Resource::Nproc, running.saturating_add(MORE_TASKS))
}

/// Waits for `pid`, reaping what the launcher adopted, and ends as it ended.
fn reap(pid: Pid, mut ending: Option<std::fs::File>) -> ExitCode {
    loop {
        match rustix::process::wait(WaitOptions::empty()) {
            Ok(Some((reaped, status))) if reaped == pid => {
                if let Some(code) = status.exit_status() {
                    return ExitCode::from(u8::try_from(code & 0xff).unwrap_or(1));
                }
                if let Some(signal) = status.terminating_signal() {
                    if let Some(file) = ending.as_mut() {
                        use std::io::Write;
                        // PID namespace init cannot die from its own default SIGTERM. Tell
                        // the outer launcher, which restores the real signal after waiting.
                        if writeln!(file, "{signal}").is_err() {
                            return ExitCode::from(126);
                        }
                        return ExitCode::from(128 + signal as u8);
                    }
                    // Ends the launcher the same way, so its own parent sees the signal.
                    let _ = signal_hook::low_level::emulate_default_handler(signal);
                    return ExitCode::from(u8::try_from(128 + (signal & 0x7f)).unwrap_or(1));
                }
            }
            Ok(_) => {}
            Err(rustix::io::Errno::INTR) => {}
            Err(_) => return ExitCode::from(1),
        }
    }
}

/// Whether this kernel enforces Landlock at all.
pub fn landlock_supported() -> bool {
    Ruleset::default()
        .set_compatibility(CompatLevel::HardRequirement)
        .handle_access(AccessFs::from_all(ABI::V1))
        .and_then(|r| r.create())
        .is_ok()
}

/// What the probe found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Probed {
    /// The Landlock ABI in force.
    pub abi: u8,
    /// Whether the network filter held, or why not.
    pub filtered: Result<(), String>,
}

/// Runs a real sandbox, by `launcher`, on a throwaway folder: the check inside writes in its
/// workspace and not beside it, and (filtered) reaches a listener standing in for the proxy and
/// can't open a UDP socket. The filter is tried first, then Landlock alone.
pub fn probe(launcher: &Path) -> Result<Probed, String> {
    let filtered = attempt(launcher, Network::Filtered);
    match filtered {
        Ok(abi) => Ok(Probed {
            abi,
            filtered: Ok(()),
        }),
        Err(why) => attempt(launcher, Network::Landlock).map(|abi| Probed {
            abi,
            filtered: Err(why),
        }),
    }
}

fn attempt(launcher: &Path, network: Network) -> Result<u8, String> {
    use std::io::Read;

    let dir = std::env::temp_dir().join(format!("spade-sandbox-probe-{}", uuid::Uuid::new_v4()));
    let workspace = dir.join("data/ws");
    std::fs::create_dir_all(&workspace).map_err(|e| e.to_string())?;
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let policy = crate::Policy::build(&crate::Facts {
        home: dir.join("home"),
        spade_data: dir.join("data"),
        workspace: workspace.clone(),
        toolchains: vec![launcher.to_path_buf()],
        proxy_port: Some(port),
        ..Default::default()
    });
    let plan = serde_json::to_string(&super::plan(&policy, network)).map_err(|e| e.to_string())?;
    let mode = if network == Network::Filtered {
        "filtered"
    } else {
        "landlock"
    };
    let ran = std::process::Command::new(launcher)
        .arg(super::LAUNCHER_ARG)
        .arg(plan)
        .arg(launcher)
        .args([super::CHECK_ARG, mode, &port.to_string()])
        .arg(dir.join("outside"))
        .current_dir(&workspace)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .stdin(std::process::Stdio::null())
        .output();
    let mut heard = String::new();
    if network == Network::Filtered
        && listener.set_nonblocking(true).is_ok()
        && let Ok((mut stream, _)) = listener.accept()
    {
        let _ = stream.set_nonblocking(false);
        let _ = stream.read_to_string(&mut heard);
    }
    let _ = std::fs::remove_dir_all(&dir);
    let out = ran.map_err(|e| format!("the launcher could not start: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let said = String::from_utf8_lossy(&out.stderr);
    if !out.status.success() {
        return Err(said.trim().to_owned());
    }
    if network == Network::Filtered && heard != "spade-probe" {
        return Err("the proxy's port could not be reached inside the sandbox".to_owned());
    }
    text.lines()
        .find_map(|line| line.strip_prefix("landlock-abi "))
        .and_then(|abi| abi.trim().parse().ok())
        .ok_or_else(|| "the check inside the sandbox didn't report".to_owned())
}

/// The probe's check, run inside the sandbox: `sandbox-check <filtered|landlock> <port>
/// <outside>`. Prints `landlock-abi <n>` and exits 0 when the sandbox held.
pub fn check(args: &[OsString]) -> ExitCode {
    use std::io::Write;

    let failed = |why: &str| {
        eprintln!("{why}");
        ExitCode::from(1)
    };
    let (Some(mode), Some(port), Some(outside)) = (
        args.first().and_then(|a| a.to_str()),
        args.get(1)
            .and_then(|a| a.to_str())
            .and_then(|p| p.parse::<u16>().ok()),
        args.get(2),
    ) else {
        return failed("the check needs a mode, a port and a place outside");
    };
    if std::fs::write("inside", "x").is_err() {
        return failed("the workspace could not be written in the sandbox");
    }
    if std::fs::write(outside, "x").is_ok() {
        return failed("a place outside the workspace could be written in the sandbox");
    }
    if mode == "filtered" {
        if std::net::UdpSocket::bind("127.0.0.1:0").is_ok() {
            return failed("a UDP socket could be opened in the sandbox");
        }
        let reached = std::net::TcpStream::connect(("127.0.0.1", port))
            .and_then(|mut stream| stream.write_all(b"spade-probe"));
        if let Err(error) = reached {
            return failed(&format!("the proxy's port could not be reached: {error}"));
        }
    }
    // The ABI, from a ruleset this process applies to itself last (it only narrows).
    let abi = Ruleset::default()
        .handle_access(AccessFs::from_all(ABI_WANTED))
        .and_then(|r| r.create())
        .and_then(|r| r.restrict_self())
        .map(|status| effective(&status.landlock))
        .unwrap_or(0);
    println!("landlock-abi {abi}");
    ExitCode::SUCCESS
}
