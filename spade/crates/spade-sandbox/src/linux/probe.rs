//! The probe (ADR 0167 amendment 1, decision 8): a real sandbox, started by the launcher on a
//! throwaway folder, and the check that runs inside it (`spade sandbox-check …`).

use std::ffi::{OsStr, OsString};
use std::path::Path;
use std::process::ExitCode;

use landlock::{Access, AccessFs, Ruleset, RulesetAttr};

use super::launch::{ABI_WANTED, effective};
use super::{Network, Processes};

/// What the probe found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Probed {
    /// The Landlock ABI in force.
    pub abi: u8,
    /// Whether the network filter held, or why not.
    pub filtered: Result<(), String>,
    /// Whether the command got its own PID namespace and `/proc`, or why not.
    pub processes: Result<(), String>,
}

/// Runs a real sandbox, by `launcher`, on a throwaway folder: the check inside writes in its
/// workspace and not beside it, (filtered) reaches a listener standing in for the proxy and
/// can't open a UDP socket, and either has its own process namespace and `/proc` or can't read
/// the prober's `/proc` folder. The filter is tried first, then Landlock alone; each with a
/// private PID namespace first, then with `/proc`'s process folders closed.
pub fn probe(launcher: &Path) -> Result<Probed, String> {
    let with = |network, processes| attempt(launcher, network, processes);
    let private = match with(Network::Filtered, Processes::Private) {
        Ok(abi) => {
            return Ok(Probed {
                abi,
                filtered: Ok(()),
                processes: Ok(()),
            });
        }
        Err(why) => why,
    };
    let filtered = match with(Network::Filtered, Processes::Hidden) {
        Ok(abi) => {
            return Ok(Probed {
                abi,
                filtered: Ok(()),
                processes: Err(private),
            });
        }
        Err(why) => why,
    };
    let processes = match with(Network::Landlock, Processes::Private) {
        Ok(abi) => {
            return Ok(Probed {
                abi,
                filtered: Err(filtered),
                processes: Ok(()),
            });
        }
        Err(why) => why,
    };
    with(Network::Landlock, Processes::Hidden).map(|abi| Probed {
        abi,
        filtered: Err(filtered),
        processes: Err(processes),
    })
}

fn attempt(launcher: &Path, network: Network, processes: Processes) -> Result<u8, String> {
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
    let plan = serde_json::to_string(&super::plan(&policy, network, processes, false))
        .map_err(|e| e.to_string())?;
    let mode = if network == Network::Filtered {
        "filtered"
    } else {
        "landlock"
    };
    let view = if processes == Processes::Private {
        "private"
    } else {
        "hidden"
    };
    // The prober's own process and namespace: what the check must not see as its own.
    let prober = std::process::id().to_string();
    let namespace = std::fs::read_link("/proc/self/ns/pid").map_err(|e| e.to_string())?;
    let ran = std::process::Command::new(launcher)
        .arg(super::LAUNCHER_ARG)
        .arg(plan)
        .arg(launcher)
        .args([super::CHECK_ARG, mode, &port.to_string()])
        .arg(dir.join("outside"))
        .args([view, &prober])
        .arg(namespace)
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
/// <outside> <private|hidden> <prober's pid> <prober's PID namespace>`. Prints
/// `landlock-abi <n>` and exits 0 when the sandbox held.
pub fn check(args: &[OsString]) -> ExitCode {
    use std::io::Write;

    let failed = |why: &str| {
        eprintln!("{why}");
        ExitCode::from(1)
    };
    let (Some(mode), Some(port), Some(outside), Some(view), Some(prober), Some(namespace)) = (
        args.first().and_then(|a| a.to_str()),
        args.get(1)
            .and_then(|a| a.to_str())
            .and_then(|p| p.parse::<u16>().ok()),
        args.get(2),
        args.get(3).and_then(|a| a.to_str()),
        args.get(4).and_then(|a| a.to_str()),
        args.get(5),
    ) else {
        return failed("the check needs a mode, a port, a place outside and the prober");
    };
    if let Err(why) = processes(view, prober, namespace) {
        return failed(why);
    }
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

/// What the check sees of processes: in `private`, a PID namespace other than the prober's whose
/// `/proc` is its own (`/proc/self` names this process); in `hidden`, no readable `/proc` folder
/// of the prober.
fn processes(view: &str, prober: &str, namespace: &OsStr) -> Result<(), &'static str> {
    if view == "private" {
        let own = std::fs::read_link("/proc/self/ns/pid").map_err(|_| "no PID namespace")?;
        if own.as_os_str() == namespace {
            return Err("the command shares the prober's PID namespace");
        }
        let me = std::fs::read_link("/proc/self").map_err(|_| "no /proc in the sandbox")?;
        if me.as_os_str() != std::process::id().to_string().as_str() {
            return Err("the sandbox's /proc is not its own namespace's");
        }
        return Ok(());
    }
    if std::fs::read(format!("/proc/{prober}/cmdline")).is_ok() {
        return Err("another process's /proc folder could be read in the sandbox");
    }
    Ok(())
}
