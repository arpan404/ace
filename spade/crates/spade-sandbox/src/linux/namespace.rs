//! Every command gets its own PID namespace, with a freshly mounted `/proc` that lists only its
//! processes; below Landlock ABI 6 the namespace also contains every form of signal sending.
use std::ffi::OsString;
use std::io::Read;
use std::os::unix::process::ExitStatusExt;
use std::process::{Command, ExitCode};

use super::pty::Dedicated;

/// Starts the launcher again as the init of a new user, PID, IPC and mount namespace and answers
/// how it ended. `terminal`, the command's dedicated pty, is the namespace's stdio where the
/// caller's was a terminal; this outer launcher relays it.
pub fn run(args: &[OsString], terminal: Option<Dedicated>) -> Result<ExitCode, String> {
    // Init opens and unlinks this before starting the command. Both ends retain a CLOEXEC
    // descriptor, inaccessible through the command's Landlock domain, even with /tmp granted.
    let mut ending = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    let mut signals = signal_hook::iterator::Signals::new([
        signal_hook::consts::SIGINT,
        signal_hook::consts::SIGQUIT,
        signal_hook::consts::SIGTERM,
        signal_hook::consts::SIGHUP,
    ])
    .map_err(|e| e.to_string())?;
    let channel = super::namespace_handle::Channel::new().map_err(|e| e.to_string())?;
    let mut unshare = Command::new("/usr/bin/unshare");
    if let Some(terminal) = &terminal {
        let [stdin, stdout, stderr] = terminal.stdio()?;
        unshare.stdin(stdin).stdout(stdout).stderr(stderr);
    }
    let mut child = unshare
        .args([
            "--user",
            "--map-current-user",
            "--pid",
            "--ipc",
            "--fork",
            "--mount-proc",
            "--kill-child",
        ])
        .arg(std::env::current_exe().map_err(|e| e.to_string())?)
        .arg(super::LAUNCHER_ARG)
        .arg("--private-pid-init")
        .arg(ending.path())
        .arg(channel.path())
        .args(args)
        .spawn()
        .map_err(|e| format!("the command's own PID namespace could not start: {e}"))?;
    drop(unshare);
    let init = match channel.receive(&mut child) {
        Ok(init) => init,
        Err(why) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(why);
        }
    };
    // Only now the caller's terminal goes raw: a failed start leaves it as it was.
    let relay = terminal.map(Dedicated::relay);
    std::thread::spawn(move || {
        for signal in signals.forever() {
            let forwarded = match signal {
                signal_hook::consts::SIGINT => Some(rustix::process::Signal::INT),
                signal_hook::consts::SIGQUIT => Some(rustix::process::Signal::QUIT),
                signal_hook::consts::SIGTERM => Some(rustix::process::Signal::TERM),
                signal_hook::consts::SIGHUP => Some(rustix::process::Signal::HUP),
                _ => None,
            };
            if let Some(signal) = forwarded {
                let _ = rustix::process::pidfd_send_signal(&init, signal);
                if matches!(
                    signal,
                    rustix::process::Signal::TERM | rustix::process::Signal::HUP
                ) {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    // Killing namespace init ends every descendant, including new sessions.
                    let _ =
                        rustix::process::pidfd_send_signal(&init, rustix::process::Signal::KILL);
                }
            }
        }
    });
    let status = child.wait().map_err(|e| e.to_string())?;
    if let Some(relay) = relay {
        relay.finish();
    }
    let mut signal = String::new();
    ending
        .read_to_string(&mut signal)
        .map_err(|e| e.to_string())?;
    if let Some(signal) = signal.trim().parse::<i32>().ok().or(status.signal()) {
        let _ = signal_hook::low_level::emulate_default_handler(signal);
        return Ok(ExitCode::from(1));
    }
    Ok(ExitCode::from(
        u8::try_from(status.code().unwrap_or(126)).unwrap_or(126),
    ))
}
