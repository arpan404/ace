//! Runs one shell command in a workspace (ADR 0130): `/bin/sh -c` on macOS and Linux,
//! `cmd.exe /C` on Windows; this module is the only place Spade branches on the platform for
//! it. The command runs contained (its own process group; on Windows a job object that kills
//! everything in it when closed), with a built environment that carries none of Spade's secrets
//! and a `PATH` of system folders only, a deadline, and capped output. Whatever it started is
//! killed when the run ends, however it ends (finished, timed out, or the call dropped), and the
//! output readers go with it.

use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::task::JoinHandle;

/// Output kept from each of stdout and stderr; the rest is read and dropped.
pub const MOST_OUTPUT: usize = 4 * 1024 * 1024;
/// How long pipes may stay open after the command ended or was killed (a process that left the
/// group can hold them). What was read by then is kept.
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
    /// Output past [`MOST_OUTPUT`] was dropped, or a pipe stayed open past the end.
    pub cut: bool,
}

#[derive(Clone)]
pub struct Shell {
    env: Env,
}

impl Shell {
    /// `env` is Spade's environment; only the few variables a shell needs are taken from it,
    /// and never `PATH`.
    pub fn new(env: Env) -> Self {
        Self { env }
    }

    /// The machine's own environment.
    pub fn system() -> Self {
        Self::new(Arc::new(|name| std::env::var(name).ok()))
    }

    /// The environment a command runs with: built, never inherited. `HOME` is the workspace;
    /// `PATH` is [`platform::trusted_path`], so nothing the bot put in its folder is found by
    /// name.
    pub fn environment(&self, dir: &Path) -> Vec<(String, String)> {
        let home = dir.to_string_lossy().into_owned();
        let mut vars: Vec<(String, String)> = Vec::new();
        let mut keep = |name: &str, fallback: Option<&str>| {
            if let Some(value) = (self.env)(name).or_else(|| fallback.map(str::to_owned)) {
                vars.push((name.to_owned(), value));
            }
        };
        for (name, fallback) in platform::KEPT {
            keep(name, *fallback);
        }
        vars.push(("PATH".to_owned(), platform::trusted_path(&self.env)));
        vars.extend(
            platform::SET
                .iter()
                .map(|(name, value)| ((*name).to_owned(), (*value).to_owned())),
        );
        if cfg!(windows) {
            vars.push(("USERPROFILE".to_owned(), home.clone()));
        }
        vars.push(("HOME".to_owned(), home));
        vars.push(("TERM".to_owned(), "dumb".to_owned()));
        vars
    }

    /// Runs `command` in `dir` for at most `timeout`.
    pub async fn run(&self, dir: &Path, command: &str, timeout: Duration) -> Result<Ran, String> {
        let mut child = platform::command(&self.env, command)
            .current_dir(dir)
            .env_clear()
            .envs(self.environment(dir))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| format!("the shell could not start: {error}"))?;
        // Kills everything the command started when this run ends, however it ends.
        let mut contained = platform::contain(&child);
        let mut readers = Readers::default();
        let stdout = child.stdout.take().map(|pipe| readers.read(pipe));
        let stderr = child.stderr.take().map(|pipe| readers.read(pipe));
        let (status, timed_out) = match tokio::time::timeout(timeout, child.wait()).await {
            Ok(status) => (status.ok(), false),
            Err(_) => {
                contained.kill();
                let _ = child.start_kill();
                let status = tokio::time::timeout(DRAIN, child.wait()).await;
                (status.ok().and_then(Result::ok), true)
            }
        };
        // Whatever it left running in the background goes now, before the pipes are drained.
        contained.kill();
        let pipes_closed = readers.finish(DRAIN).await;
        let (stdout, out_cut) = stdout.map(|o| o.take()).unwrap_or_default();
        let (stderr, err_cut) = stderr.map(|o| o.take()).unwrap_or_default();
        Ok(Ran {
            stdout,
            stderr,
            code: status.and_then(|s| s.code()),
            timed_out,
            cut: out_cut || err_cut || !pipes_closed,
        })
    }
}

/// What a reader has kept so far, readable even if the reader never finishes.
#[derive(Clone, Default)]
struct Output(Arc<Mutex<(Vec<u8>, bool)>>);

impl Output {
    fn take(&self) -> (String, bool) {
        let held = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        (String::from_utf8_lossy(&held.0).into_owned(), held.1)
    }
}

/// The output readers, aborted when dropped, so none outlives its run.
#[derive(Default)]
struct Readers(Vec<JoinHandle<()>>);

impl Readers {
    fn read(&mut self, pipe: impl AsyncRead + Unpin + Send + 'static) -> Output {
        let output = Output::default();
        let kept = output.clone();
        self.0.push(tokio::spawn(capped(pipe, kept)));
        output
    }

    /// Waits up to `longest` for every pipe to close; answers whether they all did.
    async fn finish(&mut self, longest: Duration) -> bool {
        let all = futures_util::future::join_all(self.0.iter_mut());
        tokio::time::timeout(longest, all).await.is_ok()
    }
}

impl Drop for Readers {
    fn drop(&mut self) {
        for reader in &self.0 {
            reader.abort();
        }
    }
}

async fn capped(mut pipe: impl AsyncRead + Unpin, output: Output) {
    let mut buffer = [0u8; 16 * 1024];
    loop {
        match pipe.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                let mut held = output
                    .0
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let room = MOST_OUTPUT.saturating_sub(held.0.len());
                if read > room {
                    held.1 = true;
                }
                held.0.extend_from_slice(&buffer[..read.min(room)]);
            }
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use tokio::process::{Child, Command};

    /// Variables taken from Spade's environment, with a fallback.
    pub(super) const KEPT: &[(&str, Option<&str>)] = &[
        ("LANG", Some("C.UTF-8")),
        ("TMPDIR", None),
        ("USER", None),
        ("LOGNAME", None),
    ];
    pub(super) const SET: &[(&str, &str)] = &[("SHELL", "/bin/sh")];

    /// System folders only: never `.`, an empty entry, a relative folder or Spade's own `PATH`.
    const SYSTEM: &[&str] = &[
        "/usr/local/bin",
        "/opt/homebrew/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ];

    pub(super) fn trusted_path(_env: &super::Env) -> String {
        SYSTEM.join(":")
    }

    pub(super) fn command(_env: &super::Env, command: &str) -> Command {
        let mut shell = Command::new("/bin/sh");
        shell.arg("-c").arg(command).process_group(0);
        shell
    }

    /// The command's process group, killed on drop.
    pub(super) struct Contained(Option<u32>);

    pub(super) fn contain(child: &Child) -> Contained {
        Contained(child.id())
    }

    impl Contained {
        /// Kills the group (the shell leads its own). `kill` is a program here because Spade
        /// forbids `unsafe`, which the signal call needs.
        pub(super) fn kill(&mut self) {
            if let Some(pid) = self.0 {
                let _ = std::process::Command::new("/bin/kill")
                    .args(["-KILL", "--", &format!("-{pid}")])
                    .env_clear()
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status();
            }
        }
    }

    impl Drop for Contained {
        fn drop(&mut self) {
            self.kill();
            self.0 = None;
        }
    }
}

#[cfg(windows)]
mod platform {
    use tokio::process::{Child, Command};
    use win32job::{ExtendedLimitInfo, Job};

    pub(super) const KEPT: &[(&str, Option<&str>)] = &[
        ("SystemRoot", None),
        ("SystemDrive", None),
        ("windir", None),
        ("TEMP", None),
        ("TMP", None),
    ];
    /// cmd.exe looks in the current folder before `PATH` unless told not to.
    pub(super) const SET: &[(&str, &str)] = &[("NoDefaultCurrentDirectoryInExePath", "1")];

    /// The Windows folder, when Spade's `SystemRoot` is a plain drive path (`C:\Windows`).
    fn system_root(env: &super::Env) -> String {
        env("SystemRoot")
            .filter(|root| {
                let bytes = root.as_bytes();
                bytes.len() > 3
                    && bytes[0].is_ascii_alphabetic()
                    && &root[1..3] == ":\\"
                    && !root.contains("..")
                    && !root.contains(';')
            })
            .unwrap_or_else(|| "C:\\Windows".to_owned())
    }

    pub(super) fn trusted_path(env: &super::Env) -> String {
        let root = system_root(env);
        [
            format!("{root}\\System32"),
            root.clone(),
            format!("{root}\\System32\\Wbem"),
            format!("{root}\\System32\\WindowsPowerShell\\v1.0"),
        ]
        .join(";")
    }

    /// A new process group, so a console Ctrl-C to Spade does not reach it.
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

    pub(super) fn command(env: &super::Env, command: &str) -> Command {
        let mut shell = Command::new(format!("{}\\System32\\cmd.exe", system_root(env)));
        // With `/S`, cmd.exe drops the first and the last quote of what follows `/C` and runs
        // the rest as it is, so the command goes in one more pair: a command that starts and
        // ends with a quoted word (`"C:\Program Files\x.exe" "a b"`) runs as written.
        shell
            .args(["/D", "/S", "/C"])
            .raw_arg(format!("\"{command}\""))
            .creation_flags(CREATE_NEW_PROCESS_GROUP);
        shell
    }

    /// The job object holding the command and everything it starts. Closing it (on drop, or
    /// `kill`) ends them all.
    pub(super) struct Contained(Option<Job>);

    pub(super) fn contain(child: &Child) -> Contained {
        let job = Job::create().ok().and_then(|job| {
            let mut info = ExtendedLimitInfo::new();
            info.limit_kill_on_job_close();
            job.set_extended_limit_info(&info).ok()?;
            let handle = child.raw_handle()?;
            job.assign_process(handle as isize).ok()?;
            Some(job)
        });
        if job.is_none() {
            tracing::warn!(
                "a shell command runs without a job object; its children may outlive it"
            );
        }
        Contained(job)
    }

    impl Contained {
        pub(super) fn kill(&mut self) {
            // Closing the last handle with kill-on-close set ends every process in the job.
            self.0 = None;
        }
    }
}
