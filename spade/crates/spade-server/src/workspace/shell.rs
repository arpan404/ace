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

/// Sees every chunk of a command's output as it comes, stdout and stderr alike (the bot's
/// terminal shows it live, ADR 0142).
pub type Tee = Arc<dyn Fn(&[u8]) + Send + Sync>;

/// One command run with more than [`Shell::run`] gives it.
pub struct Job<'a> {
    pub dir: &'a Path,
    /// What `sh -c` runs.
    pub script: &'a str,
    pub timeout: Duration,
    /// Set after the built environment, overriding it.
    pub env: &'a [(String, String)],
    pub tee: Option<Tee>,
    /// Told the command's process id (its process group's) once it starts.
    pub started: Option<&'a (dyn Fn(u32) + Send + Sync)>,
}

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
    /// Not everything the command started could be seen to stop: some may still run.
    pub incomplete: bool,
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
        self.run_job(Job {
            dir,
            script: command,
            timeout,
            env: &[],
            tee: None,
            started: None,
        })
        .await
    }

    /// Runs `job`. `HOME` stays the folder the environment was built for (`home`).
    pub async fn run_job(&self, job: Job<'_>) -> Result<Ran, String> {
        self.run_from(job.dir, job).await
    }

    /// [`Shell::run_job`] with `HOME` set to `home`, whatever folder the job starts in.
    pub async fn run_from(&self, home: &Path, job: Job<'_>) -> Result<Ran, String> {
        let (dir, command, timeout) = (job.dir, job.script, job.timeout);
        // Inherited by everything the command starts, so all of it can be found at the end.
        let mark = uuid::Uuid::new_v4().simple().to_string();
        let mut child = platform::command(&self.env, command)
            .current_dir(dir)
            .env_clear()
            .envs(self.environment(home))
            .envs(job.env.iter().cloned())
            .env(platform::MARK, &mark)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| format!("the shell could not start: {error}"))?;
        // Kills everything the command started when this run ends, however it ends.
        let mut contained = platform::contain(&child, &mark);
        if let (Some(started), Some(pid)) = (job.started, child.id()) {
            started(pid);
        }
        let mut readers = Readers::default();
        let stdout = child
            .stdout
            .take()
            .map(|pipe| readers.read(pipe, job.tee.clone()));
        let stderr = child
            .stderr
            .take()
            .map(|pipe| readers.read(pipe, job.tee.clone()));
        let (status, timed_out, settled) = match tokio::time::timeout(timeout, child.wait()).await {
            Ok(status) => {
                contained.reaped();
                (status.ok(), false, true)
            }
            Err(_) => {
                // The leader is still there: it goes first, with everything it started.
                let settled = contained.kill().await;
                let _ = child.start_kill();
                let status = tokio::time::timeout(DRAIN, child.wait()).await;
                (status.ok().and_then(Result::ok), true, settled)
            }
        };
        // Whatever it left running in the background goes now, before the pipes are drained.
        let settled = contained.kill().await && settled;
        let pipes_closed = readers.finish(DRAIN).await;
        let (stdout, out_cut) = stdout.map(|o| o.take()).unwrap_or_default();
        let (stderr, err_cut) = stderr.map(|o| o.take()).unwrap_or_default();
        Ok(Ran {
            stdout,
            stderr,
            code: status.and_then(|s| s.code()),
            timed_out,
            cut: out_cut || err_cut || !pipes_closed,
            incomplete: !settled,
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
    fn read(&mut self, pipe: impl AsyncRead + Unpin + Send + 'static, tee: Option<Tee>) -> Output {
        let output = Output::default();
        let kept = output.clone();
        self.0.push(tokio::spawn(capped(pipe, kept, tee)));
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

async fn capped(mut pipe: impl AsyncRead + Unpin, output: Output, tee: Option<Tee>) {
    let mut buffer = [0u8; 16 * 1024];
    loop {
        match pipe.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                if let Some(tee) = &tee {
                    tee(&buffer[..read]);
                }
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

    pub(super) use super::super::reap::MARK;
    use super::super::reap::{Run, end};

    /// The command (it leads its own process group) and the mark everything it starts carries;
    /// all of it is ended once, by `kill` or else on drop.
    pub(super) struct Contained(Option<Run>);

    fn now_secs() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs())
    }

    pub(super) fn contain(child: &Child, mark: &str) -> Contained {
        Contained(
            child
                .id()
                .and_then(|pid| i32::try_from(pid).ok())
                .map(|leader| Run {
                    leader,
                    mark: mark.to_owned(),
                    reaped: false,
                    started_secs: now_secs(),
                    ended_secs: None,
                }),
        )
    }

    impl Contained {
        /// The leader was reaped: its number is never signalled again.
        pub(super) fn reaped(&mut self) {
            if let Some(run) = self.0.as_mut() {
                run.reaped = true;
                run.ended_secs = Some(now_secs());
            }
        }

        /// Ends the command and everything it started, sessions of their own included, off the
        /// async threads. Disarms: later calls and the drop do nothing. Answers whether it all
        /// stopped.
        pub(super) async fn kill(&mut self) -> bool {
            let Some(run) = self.0.take() else {
                return true;
            };
            tokio::task::spawn_blocking(move || end(&run))
                .await
                .unwrap_or(false)
        }
    }

    impl Drop for Contained {
        /// The run was dropped (a take-over or Stop): ended here, at once.
        fn drop(&mut self) {
            if let Some(run) = self.0.take() {
                end(&run);
            }
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

    /// Unused here: the job object holds everything the command starts.
    pub(super) const MARK: &str = "SPADE_RUN";

    pub(super) fn contain(child: &Child, _mark: &str) -> Contained {
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
        /// Nothing to note: the job holds the command whatever its number.
        pub(super) fn reaped(&mut self) {}

        pub(super) async fn kill(&mut self) -> bool {
            // Closing the last handle with kill-on-close set ends every process in the job.
            self.0 = None;
            true
        }
    }
}
