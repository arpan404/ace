//! Runs one shell command in a workspace (ADR 0130): `/bin/sh -c` on macOS and Linux,
//! `cmd.exe /C` on Windows; this module is the only place Spade branches on the platform for
//! it. The command runs contained (its own process group; on Windows a job object that kills
//! everything in it when closed), with a built environment that carries none of Spade's secrets
//! and a `PATH` of system folders only, a deadline, and capped output. Whatever it started is
//! killed when the run ends, however it ends (finished, timed out, or the call dropped), and the
//! output readers go with it.
//!
//! When the shell has a [`Confine`] (ADR 0167), a command whose home is a bot's workspace runs in
//! that bot's OS sandbox, with its traffic sent through the egress proxy. Where the machine has a
//! sandbox and a run can't be confined, it doesn't run.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
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
    /// Where the end of everything the command started is recorded, so its owner can wait for
    /// it even when this run is dropped mid-way.
    pub cleanup: Option<Cleanup>,
    /// Written to the command's stdin, which is then closed (a plugin hook's event, ADR 0151).
    /// `None` leaves stdin empty.
    pub stdin: Option<Vec<u8>>,
    /// Whose run it is, for the sandbox: a bot's command, or a plugin's.
    pub kind: Kind,
    /// Run with no sandbox: the gate decided this one call runs outside it (ADR 0171).
    pub outside: bool,
    /// Whether this call is allowed to run uncontained — because it was reviewed (or approved to
    /// run outside), not because the gate skipped its review expecting containment. When a bot run
    /// turns out to need review and this is `false`, it is refused rather than run plainly.
    pub may_run_uncontained: bool,
    /// A command Spade's classifier settled: it runs with a clean, fixed environment built by
    /// Spade, never one inherited from the daemon or carried from an earlier terminal command
    /// (ADR 0172, amendment 4). `job.env` (the hardening overrides) still go on top.
    pub clean: bool,
}

/// Whose a sandboxed run is (ADR 0167): its network policy and what else it may read follow.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum Kind {
    /// The bot's own one-shot command or service: the bot's network policy.
    #[default]
    Command,
    /// A command in the bot's terminal: as [`Kind::Command`], also writing its state files in
    /// `scratch` (Spade's folder, outside the workspace).
    Terminal { scratch: PathBuf },
    /// A plugin's hook or server: it may also read its plugin's folder; its network is the bot's
    /// plugin policy (open by default: the person installed it).
    Plugin { root: PathBuf },
}

/// What confining a run decided (ADR 0167). Never `Ok(None)` for a bot run that can't be held:
/// the ambiguity between "no sandbox applies" and "needs review" was a fail-open, so the two are
/// now distinct and a caller must route [`Confinement::NeedsReview`] to review or refuse it.
pub enum Confinement {
    /// No sandbox applies — not a bot's workspace, or this machine has none. Runs as today.
    None,
    /// Held in the OS sandbox.
    Contained(Box<Confined>),
    /// A bot run that can't be contained here (on Windows, it would need ACL changes on the
    /// person's own folders). It must be reviewed, or refused — never launched plainly.
    NeedsReview(String),
}

/// What the gate authorized when it decided on a command, carried unchanged to the launch so
/// containment is never decided again there (ADR 0167, Windows hardening). A command the gate let
/// skip review because the sandbox held it may only ever launch contained.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Launch {
    /// The gate sent it outside the sandbox (reviewed or approved so).
    Outside,
    /// The gate decided it in the sandbox's light (unreviewed because the sandbox held it, or
    /// reviewed as a sandboxed command): it may launch only contained.
    Contained,
    /// Reviewed or approved without relying on the sandbox: contained when the sandbox holds it at
    /// launch, plainly when it doesn't.
    Reviewed,
}

/// How a command launches, from its [`Launch`] and whether the sandbox holds it now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LaunchPlan {
    pub outside: bool,
    /// Whether the run is expected to be held by the sandbox.
    pub sandboxed: bool,
    /// Whether a run the sandbox turns out not to hold may still launch plainly.
    pub may_run_uncontained: bool,
}

/// Why a command cleared to run contained didn't run once the sandbox no longer held it.
pub const NO_LONGER_CONTAINED: &str = "The command wasn't run: it was cleared to run in Spade's \
     sandbox, but the sandbox no longer holds it. Run it again and Spade will ask first.";

impl Launch {
    /// The launch for this authorization when the sandbox does (`contains_now`) or doesn't hold the
    /// command now. A command cleared as contained is refused, never launched plainly, once the
    /// sandbox stops holding it; running it again goes back through the gate and its review.
    pub fn plan(self, contains_now: bool) -> Result<LaunchPlan, String> {
        match self {
            Self::Outside => Ok(LaunchPlan {
                outside: true,
                sandboxed: false,
                may_run_uncontained: true,
            }),
            Self::Contained if contains_now => Ok(LaunchPlan {
                outside: false,
                sandboxed: true,
                may_run_uncontained: false,
            }),
            Self::Contained => Err(NO_LONGER_CONTAINED.to_owned()),
            Self::Reviewed => Ok(LaunchPlan {
                outside: false,
                sandboxed: contains_now,
                may_run_uncontained: true,
            }),
        }
    }
}

/// The OS sandbox a bot's runs go through (ADR 0167), set by the server.
pub trait Confine: Send + Sync {
    /// How to run a command whose home is `home`. `Err` means a sandbox should hold it but can't,
    /// so it never runs unconfined; `Ok(Confinement::NeedsReview)` means it can't be contained by
    /// design and must be reviewed or refused.
    fn confine(&self, home: &Path, kind: &Kind) -> Result<Confinement, String>;

    /// Whether a bot command with home `home` runs contained (files and network) on this machine.
    fn contains(&self, home: &Path) -> bool;

    /// Whether the bot whose workspace is `home` runs its commands outside the sandbox (its own
    /// setting, else the machine's; ADR 0171).
    fn outside(&self, _home: &Path) -> bool {
        false
    }

    /// Why a run of `kind` with home `home` can't be contained here and would need review, as the
    /// person reads it, or `None` when it can be (or no sandbox applies). Answered without side
    /// effects, so a plugin can ask the person before it starts; `confine` decides the same way.
    fn review(&self, _home: &Path, _kind: &Kind) -> Option<String> {
        None
    }

    /// Blocking work to do before a run of `kind` with home `home` starts (a checkpoint of the
    /// workspace, ADR 0167 decision 8); `None` when there is none.
    /// Its error means the run must not start.
    fn before(
        &self,
        _home: &Path,
        _kind: &Kind,
    ) -> Option<Box<dyn FnOnce() -> Result<(), String> + Send>> {
        None
    }
}

/// Wraps `program args` in a run's sandbox: the program and arguments to start instead.
pub type Launcher =
    Box<dyn Fn(&Path, &[OsString]) -> Result<(PathBuf, Vec<OsString>), String> + Send>;

/// One run's sandbox: how to start it, what to add to its environment, and what to hold while
/// it runs (its proxy ticket).
pub struct Confined {
    /// Wraps `program args` in the sandbox.
    pub launch: Launcher,
    /// Set after everything else.
    pub env: Vec<(String, String)>,
    /// Folders put before the system ones on `PATH` (the bot's confirmed toolchains).
    pub path_first: Vec<String>,
    /// The run's proxy access, ended when the run is.
    pub hold: Box<dyn std::any::Any + Send + Sync>,
}

/// The ends of a command's processes, as they happen: each recorded before it runs and settled
/// when it is done, whether the run that started it finished or was dropped (a take-over,
/// Stop). The owner of the command waits on it before anything else may run.
#[derive(Clone, Default)]
pub struct Cleanup(Arc<Mutex<CleanupState>>);

#[derive(Default)]
struct CleanupState {
    pending: Vec<tokio::sync::watch::Receiver<Option<bool>>>,
    incomplete: bool,
}

impl Cleanup {
    /// Records an end about to run; answers where it says how it went.
    fn begin(&self) -> tokio::sync::watch::Sender<Option<bool>> {
        let (done, waiting) = tokio::sync::watch::channel(None);
        self.lock().pending.push(waiting);
        done
    }

    /// An end that already ran.
    fn ended(&self, settled: bool) {
        if !settled {
            self.lock().incomplete = true;
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, CleanupState> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Waits until every end recorded so far is done; answers whether all of them settled.
    /// A wait given up on (a deadline) loses nothing: the ends stay recorded until one is
    /// seen done.
    pub async fn settled(&self) -> bool {
        let pending = self.lock().pending.clone();
        let mut settled = true;
        for mut waiting in pending {
            match waiting.wait_for(Option::is_some).await {
                Ok(result) => settled &= result.unwrap_or(false),
                Err(_) => settled = false,
            }
        }
        let mut state = self.lock();
        state.pending.retain(|waiting| waiting.borrow().is_none());
        settled && !std::mem::take(&mut state.incomplete)
    }
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
    /// The sandbox, when the server set one.
    confine: Option<Arc<dyn Confine>>,
    /// How long ending a command's processes waits before it starts (zero but in tests, which
    /// stand in for a machine too loaded to end them at once).
    end_delay: Duration,
}

impl Shell {
    /// `env` is Spade's environment; only the few variables a shell needs are taken from it,
    /// and never `PATH`.
    pub fn new(env: Env) -> Self {
        Self {
            env,
            confine: None,
            end_delay: Duration::ZERO,
        }
    }

    /// The same shell, running bots' commands in `confine`'s sandbox.
    pub fn confined(mut self, confine: Arc<dyn Confine>) -> Self {
        self.confine = Some(confine);
        self
    }

    /// How a run of `kind` with home `home` is confined, for a process this shell doesn't start
    /// itself (a plugin's server): as [`Confine::confine`].
    pub fn confine(&self, home: &Path, kind: &Kind) -> Result<Confinement, String> {
        match &self.confine {
            Some(confine) => confine.confine(home, kind),
            None => Ok(Confinement::None),
        }
    }

    /// Whether a bot command with home `home` runs contained (files and network) here.
    pub fn contains(&self, home: &Path) -> bool {
        self.confine
            .as_ref()
            .is_some_and(|confine| confine.contains(home))
    }

    /// Why a run of `kind` with home `home` would need review here: as [`Confine::review`].
    pub fn review(&self, home: &Path, kind: &Kind) -> Option<String> {
        self.confine
            .as_ref()
            .and_then(|confine| confine.review(home, kind))
    }

    /// Whether the bot with home `home` runs its commands outside the sandbox.
    pub fn outside(&self, home: &Path) -> bool {
        self.confine
            .as_ref()
            .is_some_and(|confine| confine.outside(home))
    }

    /// Makes every end of a command's processes wait `delay` first: for tests of what happens
    /// while an end is still going on. Only with the `test-hooks` feature.
    #[cfg(feature = "test-hooks")]
    pub fn with_end_delay(mut self, delay: Duration) -> Self {
        self.end_delay = delay;
        self
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

    /// The clean, fixed environment a settled command runs with (ADR 0172, amendment 4): an
    /// allowlist built entirely by Spade, nothing read from the process or carried from an earlier
    /// command. `PATH` is the system folders, `HOME` and `TMPDIR` are the bot's folder, and the
    /// locale, shell and terminal are fixed. The hardening overrides are layered on by `run_from`.
    pub fn settled_environment(&self, dir: &Path) -> Vec<(String, String)> {
        let home = dir.to_string_lossy().into_owned();
        let mut vars = vec![
            ("PATH".to_owned(), platform::trusted_path(&self.env)),
            ("SHELL".to_owned(), "/bin/sh".to_owned()),
            ("LANG".to_owned(), "C.UTF-8".to_owned()),
            ("LC_ALL".to_owned(), "C.UTF-8".to_owned()),
            ("TERM".to_owned(), "dumb".to_owned()),
            ("TMPDIR".to_owned(), home.clone()),
        ];
        if cfg!(windows) {
            vars.push(("USERPROFILE".to_owned(), home.clone()));
            vars.push((
                "NoDefaultCurrentDirectoryInExePath".to_owned(),
                "1".to_owned(),
            ));
        }
        vars.push(("HOME".to_owned(), home));
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
            cleanup: None,
            stdin: None,
            kind: Kind::Command,
            outside: false,
            // Spade's own internal command: always expected to be containable.
            may_run_uncontained: false,
            clean: false,
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
        // Before it starts, so everything of its group started after this.
        let spawned_us = platform::now_us();
        let confined: Option<Confined> = match &self.confine {
            // Outside the sandbox: no checkpoint, no proxy, the person's machine as it is.
            Some(_) if job.outside => None,
            Some(confine) => {
                if let Some(work) = confine.before(home, &job.kind) {
                    match tokio::task::spawn_blocking(work).await {
                        Ok(Ok(())) => {}
                        Ok(Err(why)) => return Err(format!("The command didn't run: {why}.")),
                        Err(_) => {
                            return Err("The command didn't run: its checkpoint failed.".to_owned());
                        }
                    }
                }
                match confine.confine(home, &job.kind)? {
                    Confinement::None => None,
                    Confinement::Contained(confined) => Some(*confined),
                    // A bot run that can't be contained. If it was reviewed (or approved to run
                    // outside) it may run plainly; otherwise the gate skipped its review expecting
                    // containment, and it must not launch — it fails closed and is re-reviewed.
                    Confinement::NeedsReview(reason) => {
                        if job.may_run_uncontained {
                            None
                        } else {
                            return Err(format!("The command wasn't run. {reason}"));
                        }
                    }
                }
            }
            None => None,
        };
        let mut environment = if job.clean {
            self.settled_environment(home)
        } else {
            self.environment(home)
        };
        let mut shell = match &confined {
            None => platform::command(&self.env, command),
            Some(confined) => {
                let (program, args) = platform::shell_args(&self.env, command);
                let (program, args) = (confined.launch)(&program, &args)?;
                if !confined.path_first.is_empty()
                    && let Some((_, path)) = environment.iter_mut().find(|(n, _)| n == "PATH")
                {
                    *path = format!(
                        "{}{}{path}",
                        confined.path_first.join(platform::PATH_SEP),
                        platform::PATH_SEP
                    );
                }
                platform::wrapped(program, args)
            }
        };
        let mut child = shell
            .current_dir(dir)
            .env_clear()
            .envs(environment)
            .envs(job.env.iter().cloned())
            .envs(confined.iter().flat_map(|c| c.env.iter().cloned()))
            .env(platform::MARK, &mark)
            .stdin(if job.stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| format!("the shell could not start: {error}"))?;
        // Kills everything the command started when this run ends, however it ends.
        let mut contained = platform::contain(
            &child,
            &mark,
            spawned_us,
            job.cleanup.clone().unwrap_or_default(),
        );
        contained.delay(self.end_delay);
        let mut readers = Readers::default();
        if let (Some(mut pipe), Some(bytes)) = (child.stdin.take(), job.stdin) {
            // A command that never reads its stdin must not hold the run up: the write is its
            // own task, aborted with the readers.
            readers.0.push(tokio::spawn(async move {
                use tokio::io::AsyncWriteExt;
                let _ = pipe.write_all(&bytes).await;
            }));
        }
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
        // The run's proxy access ends with it.
        drop(confined);
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

    pub(super) const PATH_SEP: &str = ":";

    /// The shell and its arguments for `command`, for a sandbox to wrap.
    pub(super) fn shell_args(
        _env: &super::Env,
        command: &str,
    ) -> (std::path::PathBuf, Vec<std::ffi::OsString>) {
        ("/bin/sh".into(), vec!["-c".into(), command.into()])
    }

    /// The sandbox's launch, in its own process group like any command.
    pub(super) fn wrapped(program: std::path::PathBuf, args: Vec<std::ffi::OsString>) -> Command {
        let mut shell = Command::new(program);
        shell.args(args).process_group(0);
        shell
    }

    pub(super) use super::super::reap::MARK;
    use super::super::reap::{Run, end};

    /// The command (it leads its own process group) and the mark everything it starts carries;
    /// all of it is ended once, by `kill` or else on drop.
    pub(super) struct Contained(Option<Run>, super::Cleanup);

    pub(super) fn now_us() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| u64::try_from(d.as_micros()).unwrap_or(u64::MAX))
    }

    pub(super) fn contain(
        child: &Child,
        mark: &str,
        spawned_us: u64,
        cleanup: super::Cleanup,
    ) -> Contained {
        Contained(
            child
                .id()
                .and_then(|pid| i32::try_from(pid).ok())
                .map(|leader| Run {
                    leader,
                    mark: mark.to_owned(),
                    reaped: false,
                    started_us: spawned_us,
                    ended_us: None,
                    delay: std::time::Duration::ZERO,
                }),
            cleanup,
        )
    }

    impl Contained {
        pub(super) fn delay(&mut self, delay: std::time::Duration) {
            if let Some(run) = self.0.as_mut() {
                run.delay = delay;
            }
        }

        /// The leader was reaped: its number is never signalled again.
        pub(super) fn reaped(&mut self) {
            if let Some(run) = self.0.as_mut() {
                run.reaped = true;
                run.ended_us = Some(now_us());
            }
        }

        /// Ends the command and everything it started, sessions of their own included, off the
        /// async threads. Disarms: later calls and the drop do nothing. The end is recorded in
        /// the cleanup before it starts, and runs to its end even if this run is dropped
        /// meanwhile, so the command's owner can wait for it. Answers whether it all stopped.
        pub(super) async fn kill(&mut self) -> bool {
            let Some(run) = self.0.take() else {
                return true;
            };
            let done = self.1.begin();
            let mut told = done.subscribe();
            tokio::task::spawn_blocking(move || {
                let settled = end(&run);
                done.send_replace(Some(settled));
            });
            match told.wait_for(Option::is_some).await {
                Ok(settled) => settled.unwrap_or(false),
                Err(_) => false,
            }
        }
    }

    impl Drop for Contained {
        /// The run was dropped (a take-over or Stop) before its end: ended here, at once.
        fn drop(&mut self) {
            if let Some(run) = self.0.take() {
                self.1.ended(end(&run));
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

    pub(super) const PATH_SEP: &str = ";";

    /// Windows has no sandbox yet (ADR 0167): nothing is ever wrapped, but the shape matches.
    pub(super) fn shell_args(
        env: &super::Env,
        command: &str,
    ) -> (std::path::PathBuf, Vec<std::ffi::OsString>) {
        (
            format!("{}\\System32\\cmd.exe", system_root(env)).into(),
            vec![
                "/D".into(),
                "/S".into(),
                "/C".into(),
                format!("\"{command}\"").into(),
            ],
        )
    }

    pub(super) fn wrapped(program: std::path::PathBuf, args: Vec<std::ffi::OsString>) -> Command {
        let mut shell = Command::new(program);
        shell.args(args).creation_flags(CREATE_NEW_PROCESS_GROUP);
        shell
    }

    /// The job object holding the command and everything it starts. Closing it (on drop, or
    /// `kill`) ends them all.
    pub(super) struct Contained(Option<Job>);

    /// Unused here: the job object holds everything the command starts.
    pub(super) const MARK: &str = "SPADE_RUN";

    pub(super) fn now_us() -> u64 {
        0
    }

    pub(super) fn contain(
        child: &Child,
        _mark: &str,
        _spawned_us: u64,
        _cleanup: super::Cleanup,
    ) -> Contained {
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
        pub(super) fn delay(&mut self, _delay: std::time::Duration) {}

        /// Nothing to note: the job holds the command whatever its number.
        pub(super) fn reaped(&mut self) {}

        pub(super) async fn kill(&mut self) -> bool {
            // Closing the last handle with kill-on-close set ends every process in the job.
            self.0 = None;
            true
        }
    }
}
