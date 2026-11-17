//! The launcher (`spade sandbox-exec <plan> <program> <args>…`); [`super::probe`] tests it.
//!
//! The launcher stays outside the sandbox. Where the plan gives the command its own processes it
//! first starts itself again as the init of a new PID namespace with a fresh `/proc`
//! ([`super::namespace`]); where its stdio is a terminal, the outermost launcher gives the command
//! a dedicated pty and relays it ([`super::pty`]). It carves the plan's roots (opening each place
//! it grants), lowers the process and file limits, then starts one thread that applies Landlock
//! and the seccomp filter to itself alone and starts the command, which inherits both. The
//! launcher's other threads answer the filter's supervised calls ([`super::supervise`]), pass on
//! `SIGTERM` and `SIGHUP`, adopt whatever the command leaves behind (so it stays a descendant the
//! supervisor may reach) and end with the command's own exit.

use std::ffi::{OsStr, OsString};
use std::os::fd::{OwnedFd, RawFd};
use std::process::ExitCode;
use std::process::Stdio;
use std::sync::mpsc;

use landlock::{
    ABI, Access, AccessFs, AccessNet, CompatLevel, Compatible, LandlockStatus, NetPort,
    PathBeneath, Ruleset, RulesetAttr, RulesetCreated, RulesetCreatedAttr, RulesetStatus, Scope,
};
use rustix::process::{Resource, Rlimit};

use super::lifecycle::Ended;
use super::namespace_handle::Init;
use super::net::Rules;
use super::pty::{Dedicated, Relay};
use super::{Network, Plan, Processes, RealFs, carve, seccomp, supervise};

/// The first argument of the launcher started again as a namespace's init.
pub(super) const INIT_ARG: &str = "--private-pid-init";
/// The highest ABI this build asks for; the kernel's own is used where it is lower.
pub(super) const ABI_WANTED: ABI = ABI::V9;
/// Open files per process.
const MAX_FILES: u64 = 65_536;
/// Tasks the run may add to what the machine already has (`RLIMIT_NPROC` counts the person's).
const MORE_TASKS: u64 = 4_096;

/// Applies `plan` around `program args` and answers its exit.
pub fn main(args: &[OsString]) -> ExitCode {
    let namespaced = args.first().is_some_and(|a| a == INIT_ARG);
    let args = if namespaced {
        args.get(1..).unwrap_or_default()
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
    if namespaced && let Err(error) = rustix::process::setsid() {
        return refused(&format!(
            "the namespace init could not create its session: {error}"
        ));
    }
    // Init's state goes over the control channel on its stdin, never through a pathname.
    let init = if namespaced {
        let adopted = Init::adopt().and_then(|init| {
            let stdio = init.stdio()?;
            init.send_handle()?;
            Ok((init, stdio))
        });
        match adopted {
            Ok(init) => Some(init),
            Err(why) => return refused(&format!("the namespace init could not start: {why}")),
        }
    } else {
        None
    };
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
    let private = plan.processes == Processes::Private;
    if plan.network == Network::Filtered && abi < 6 && !private {
        return refused(
            "below Landlock ABI 6 signals are held only in the command's own PID namespace",
        );
    }
    // The outermost launcher gives the command its own terminal; a namespace init's stdio
    // already is that terminal.
    let terminal = if namespaced {
        None
    } else {
        match Dedicated::open() {
            Ok(terminal) => terminal,
            Err(why) => return refused(&why),
        }
    };
    if private && !namespaced {
        // util-linux creates the user, mount and PID namespaces before this launcher starts
        // threads or installs restrictions. Its init is the supervisor, which reaps children.
        return super::namespace::run(args, terminal).unwrap_or_else(|why| refused(&why));
    }
    let io = match init {
        Some((init, stdio)) => Io::Init(init, stdio),
        None => Io::Direct(terminal),
    };
    match run(&plan, program, &args[2..], io) {
        Ok(code) => code,
        Err(why) => refused(&why),
    }
}

/// The command's stdio, as this launcher holds it.
enum Io {
    /// The outermost launcher: its own stdio, or the dedicated pty in place of its terminals.
    Direct(Option<Dedicated>),
    /// A namespace init: the command's stdio as the outer launcher sent it.
    Init(Init, [OwnedFd; 3]),
}

/// Ends as the command did, once the caller has its terminal back: with its code, or (a
/// namespace init reporting it to the outer launcher) its signal.
fn exit(ended: Ended, init: Option<Init>, relay: Option<Relay>) -> Result<ExitCode, String> {
    if let Some(relay) = relay {
        relay.finish();
    }
    let signal = match ended {
        Ended::Code(code) => return Ok(ExitCode::from(code)),
        Ended::Signal(signal) => signal,
    };
    if let Some(init) = init {
        // Namespace init cannot restore its own default fatal signal; the outer launcher can.
        init.ended_by(signal)?;
    } else {
        let _ = signal_hook::low_level::emulate_default_handler(signal);
    }
    Ok(ExitCode::from(u8::try_from(128 + signal).unwrap_or(1)))
}

enum Started {
    Listener(RawFd),
    Child(std::process::Child),
    Failed(String),
}

fn run(plan: &Plan, program: &OsStr, args: &[OsString], io: Io) -> Result<ExitCode, String> {
    // The only terminal the command may open: its dedicated pty, as this launcher made it or
    // (namespace init) as the outer launcher passed it on.
    let (nodes, stdio, controlling, terminal, init) = match io {
        Io::Direct(Some(terminal)) => (
            vec![terminal.node()?],
            Some(terminal.fds()?.map(Stdio::from)),
            terminal.layout().controlling,
            Some(terminal),
            None,
        ),
        Io::Direct(None) => (Vec::new(), None, false, None, None),
        Io::Init(init, fds) => {
            let nodes = super::devices::terminals(&fds);
            let controlling = rustix::termios::isatty(&fds[0]);
            (
                nodes,
                Some(fds.map(Stdio::from)),
                controlling,
                None,
                Some(init),
            )
        }
    };
    let dedicated = nodes.first().and_then(|node| {
        let stat = rustix::fs::fstat(node).ok()?;
        #[allow(clippy::unnecessary_cast)]
        Some((stat.st_dev as u64, stat.st_ino as u64))
    });
    let (ruleset, metadata) =
        ruleset(plan, nodes).map_err(|e| format!("the sandbox could not be applied: {e}"))?;
    limit().map_err(|e| format!("the sandbox's limits could not be set: {e}"))?;
    // What the command leaves running stays the launcher's, so the supervisor may still reach
    // its sockets (`pidfd_getfd` needs a descendant where Yama is on).
    rustix::process::set_child_subreaper(Some(rustix::process::getpid()))
        .map_err(|e| format!("the launcher could not adopt the command's processes: {e}"))?;
    let signals = signal_hook::iterator::Signals::new([
        signal_hook::consts::SIGINT,
        signal_hook::consts::SIGQUIT,
        signal_hook::consts::SIGTERM,
        signal_hook::consts::SIGHUP,
        signal_hook::consts::SIGCHLD,
    ])
    .map_err(|e| format!("the launcher could not hold its signals: {e}"))?;
    // Relaying starts before the command does: a relay that can't start starts no command, and
    // a command that can't start drops the relay, which gives the caller its terminal back.
    let relay = terminal.map(Dedicated::relay).transpose()?;
    let (send, started) = mpsc::channel();
    let network = plan.network;
    let (program, args) = (program.to_owned(), args.to_vec());
    std::thread::spawn(move || {
        confined(
            ruleset,
            network,
            Start {
                program: &program,
                args: &args,
                stdio,
                controlling,
            },
            &send,
        );
    });
    let metadata = std::sync::Arc::new(metadata);
    let mut child = None;
    for message in started {
        match message {
            Started::Listener(listener) => {
                let rules = Rules {
                    proxy_port: plan.proxy_port,
                    sockets: plan.sockets.clone(),
                };
                let metadata = std::sync::Arc::clone(&metadata);
                std::thread::spawn(move || {
                    supervise::serve(listener, rules, metadata, dedicated);
                });
            }
            Started::Child(started) => child = Some(started),
            Started::Failed(why) => return Err(why),
        }
    }
    let child = child.ok_or("the command could not start")?;
    let ended = super::lifecycle::wait(child, signals)?;
    exit(ended, init, relay)
}

/// The command as the sandbox thread starts it.
struct Start<'a> {
    program: &'a OsStr,
    args: &'a [OsString],
    /// Its stdin, stdout and stderr where the launcher's are replaced by a dedicated pty.
    stdio: Option<[Stdio; 3]>,
    /// Its stdin is its dedicated pty, which becomes its controlling terminal.
    controlling: bool,
}

/// The thread that becomes the sandbox: applies the ruleset and the filter to itself, then
/// starts the command, which inherits both.
fn confined(
    ruleset: RulesetCreated,
    network: Network,
    start: Start<'_>,
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
            filter.load().map_err(|e| e.to_string())?;
            filter.get_notify_fd().map_err(|e| e.to_string())
        });
        match loaded {
            Ok(listener) => {
                let _ = send.send(Started::Listener(listener));
            }
            Err(error) => return fail(format!("the network filter could not be applied: {error}")),
        }
    }
    // util-linux calls setsid in this child before exec, without an unsafe pre_exec hook.
    // A freshly spawned child is not a process-group leader, so setsid does not fork. With
    // `--ctty` it makes its stdin, the dedicated pty, the new session's controlling terminal.
    let mut command = std::process::Command::new("/usr/bin/setsid");
    if start.controlling {
        command.arg("--ctty");
    }
    command.arg("--").arg(start.program).args(start.args);
    if let Some([stdin, stdout, stderr]) = start.stdio {
        command.stdin(stdin).stdout(stdout).stderr(stderr);
    }
    match command.spawn() {
        Ok(child) => {
            let _ = send.send(Started::Child(child));
        }
        Err(error) => fail(format!("the command could not start: {error}")),
    }
}

/// The Landlock ABI in force, as a number (a newer kernel's own when this build knows less).
pub(super) fn effective(status: &LandlockStatus) -> u8 {
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
fn ruleset(
    plan: &Plan,
    terminals: Vec<OwnedFd>,
) -> Result<(RulesetCreated, super::metadata_access::Grants), String> {
    // Every TCP connect is handled, so with no port in the plan none is allowed. Signals and
    // abstract Unix sockets stay inside the sandbox where the kernel scopes them (ABI 6).
    let mut metadata = super::metadata_access::Grants::default();
    let mut created = Ruleset::default()
        .handle_access(AccessFs::from_all(ABI_WANTED))
        .map_err(|e| e.to_string())?
        .handle_access(AccessNet::ConnectTcp)
        .map_err(|e| e.to_string())?
        .scope(Scope::from_all(ABI_WANTED))
        .map_err(|e| e.to_string())?
        .create()
        .map_err(|e| e.to_string())?;
    for root in &plan.roots {
        let access = if root.write {
            AccessFs::from_all(ABI_WANTED)
        } else {
            AccessFs::from_read(ABI_WANTED)
        };
        for (_, fd) in carve(&RealFs, root) {
            if root.write {
                metadata.add(&fd).map_err(|e| e.to_string())?;
            }
            created = created
                .add_rule(PathBeneath::new(fd, access))
                .map_err(|e| e.to_string())?;
        }
    }
    for fd in terminals {
        created = created
            .add_rule(PathBeneath::new(fd, AccessFs::from_all(ABI_WANTED)))
            .map_err(|e| e.to_string())?;
    }
    if let Some(port) = plan.proxy_port {
        created = created
            .add_rule(NetPort::new(port, AccessNet::ConnectTcp))
            .map_err(|e| e.to_string())?;
    }
    Ok((created, metadata))
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

/// Whether this kernel enforces Landlock at all.
pub fn landlock_supported() -> bool {
    Ruleset::default()
        .set_compatibility(CompatLevel::HardRequirement)
        .handle_access(AccessFs::from_all(ABI::V1))
        .and_then(|r| r.create())
        .is_ok()
}
