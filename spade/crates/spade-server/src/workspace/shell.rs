//! Runs one shell command in a workspace (ADR 0130): `sh -c` on macOS and Linux, `cmd /C` on
//! Windows, the only place Spade branches on the platform for it. The command gets its own
//! process group (on Windows, its process tree), a built environment that carries none of
//! Spade's secrets, a deadline after which the whole group is killed, and capped output. The
//! group is killed when the run ends either way, so nothing it started in the background stays.

use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt};

/// Output kept from each of stdout and stderr; the rest is read and dropped.
pub const MOST_OUTPUT: usize = 4 * 1024 * 1024;
/// How long pipes may stay open after the command ended or was killed (a process that left the
/// group can hold them).
const DRAIN: Duration = Duration::from_secs(2);

/// Reads a variable of Spade's own environment, so tests can pass their own.
pub type Env = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// How a command ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ran {
    pub stdout: String,
    pub stderr: String,
    /// The exit code; `None` when a signal ended it.
    pub code: Option<i32>,
    pub timed_out: bool,
    /// Output past [`MOST_OUTPUT`] was dropped.
    pub cut: bool,
}

#[derive(Clone)]
pub struct Shell {
    env: Env,
}

impl Shell {
    /// `env` is Spade's environment; only the few variables a shell needs are taken from it.
    pub fn new(env: Env) -> Self {
        Self { env }
    }

    /// The machine's own environment.
    pub fn system() -> Self {
        Self::new(Arc::new(|name| std::env::var(name).ok()))
    }

    /// The environment a command runs with: built, never inherited.
    pub fn environment(&self, dir: &Path) -> Vec<(String, String)> {
        let home = dir.to_string_lossy().into_owned();
        let mut vars: Vec<(String, String)> = Vec::new();
        let mut keep = |name: &str, fallback: Option<&str>| {
            if let Some(value) = (self.env)(name).or_else(|| fallback.map(str::to_owned)) {
                vars.push((name.to_owned(), value));
            }
        };
        if cfg!(windows) {
            for name in [
                "PATH",
                "PATHEXT",
                "SystemRoot",
                "SystemDrive",
                "windir",
                "ComSpec",
                "TEMP",
                "TMP",
            ] {
                keep(name, None);
            }
            vars.push(("USERPROFILE".to_owned(), home.clone()));
        } else {
            keep("PATH", Some("/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"));
            keep("LANG", Some("C.UTF-8"));
            keep("TMPDIR", None);
            keep("USER", None);
            keep("LOGNAME", None);
            vars.push(("SHELL".to_owned(), "/bin/sh".to_owned()));
        }
        vars.push(("HOME".to_owned(), home));
        vars.push(("TERM".to_owned(), "dumb".to_owned()));
        vars
    }

    /// Runs `command` in `dir` for at most `timeout`.
    pub async fn run(&self, dir: &Path, command: &str, timeout: Duration) -> Result<Ran, String> {
        let mut child = platform::command(command)
            .current_dir(dir)
            .env_clear()
            .envs(self.environment(dir))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| format!("the shell could not start: {error}"))?;
        // Killed with everything it started when this run ends, however it ends.
        let _group = child.id().map(Group);
        let stdout = child.stdout.take().map(|pipe| tokio::spawn(capped(pipe)));
        let stderr = child.stderr.take().map(|pipe| tokio::spawn(capped(pipe)));
        let (status, timed_out) = match tokio::time::timeout(timeout, child.wait()).await {
            Ok(status) => (status.ok(), false),
            Err(_) => {
                if let Some(pid) = child.id() {
                    platform::kill_group(pid);
                }
                let _ = child.start_kill();
                let status = tokio::time::timeout(DRAIN, child.wait()).await;
                (status.ok().and_then(Result::ok), true)
            }
        };
        let (stdout, out_cut) = drained(stdout).await;
        let (stderr, err_cut) = drained(stderr).await;
        Ok(Ran {
            stdout,
            stderr,
            code: status.and_then(|s| s.code()),
            timed_out,
            cut: out_cut || err_cut,
        })
    }
}

/// Kills the process group on drop.
struct Group(u32);

impl Drop for Group {
    fn drop(&mut self) {
        platform::kill_group(self.0);
    }
}

async fn capped(mut pipe: impl AsyncRead + Unpin) -> (Vec<u8>, bool) {
    let mut kept = Vec::new();
    let mut cut = false;
    let mut buffer = [0u8; 16 * 1024];
    loop {
        match pipe.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                let room = MOST_OUTPUT.saturating_sub(kept.len());
                if read > room {
                    cut = true;
                }
                kept.extend_from_slice(&buffer[..read.min(room)]);
            }
        }
    }
    (kept, cut)
}

async fn drained(reader: Option<tokio::task::JoinHandle<(Vec<u8>, bool)>>) -> (String, bool) {
    let Some(mut reader) = reader else {
        return (String::new(), false);
    };
    match tokio::time::timeout(DRAIN, &mut reader).await {
        Ok(Ok((bytes, cut))) => (String::from_utf8_lossy(&bytes).into_owned(), cut),
        _ => {
            reader.abort();
            (String::new(), true)
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use tokio::process::Command;

    pub(super) fn command(command: &str) -> Command {
        let mut shell = Command::new("/bin/sh");
        shell.arg("-c").arg(command).process_group(0);
        shell
    }

    /// Kills group `pid` (the shell leads its own group). `kill` is a program here because
    /// Spade forbids `unsafe`, which the signal call needs.
    pub(super) fn kill_group(pid: u32) {
        let _ = std::process::Command::new("/bin/kill")
            .args(["-KILL", "--", &format!("-{pid}")])
            .env_clear()
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

#[cfg(windows)]
mod platform {
    use tokio::process::Command;

    /// A new process group, so a console Ctrl-C to Spade does not reach it.
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

    pub(super) fn command(command: &str) -> Command {
        let mut shell = Command::new("cmd.exe");
        shell
            .args(["/D", "/S", "/C"])
            .raw_arg(command)
            .creation_flags(CREATE_NEW_PROCESS_GROUP);
        shell
    }

    /// Kills `pid` and every process it started.
    pub(super) fn kill_group(pid: u32) {
        let _ = std::process::Command::new("taskkill.exe")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}
