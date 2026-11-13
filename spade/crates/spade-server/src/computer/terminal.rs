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
//! The person's shell draws a mark before each prompt, carrying a token set through a startup
//! file that is deleted once read and never exported. A line the person enters counts as a
//! command only when it answers that mark; anything typed into a program (a password prompt,
//! `read`) is never kept.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tokio::sync::{broadcast, oneshot};
use tokio::time::Instant;

use super::plain::{Lines, PromptMarks, as_terminal, prompt_mark};
use super::ring::{Ring, SCROLLBACK};
use crate::clock::Clock;
use crate::workspace::shell::{Job, Ran, Shell, Tee};

/// How long a terminal may sit unused before it is ended; the next use starts a new one.
pub const IDLE: Duration = Duration::from_secs(6 * 60 * 60);
/// How long a stopped command's process group may take to be gone.
const GONE: Duration = Duration::from_secs(5);
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
    /// When the running shell started.
    pub since: Option<i64>,
    /// When anything last happened in it.
    pub last: Option<i64>,
    /// The last command the bot ran in it.
    pub title: Option<String>,
}

/// Called with the bot's id when what [`Info`] shows may have changed.
pub type Changed = Arc<dyn Fn(&str) + Send + Sync>;

/// Every bot's terminal.
pub struct Terminals {
    /// Spade's own folder for each bot's startup file and command state, outside every workspace.
    scratch: PathBuf,
    workspaces: crate::workspace::Workspaces,
    shell: Shell,
    clock: Arc<dyn Clock>,
    all: Mutex<HashMap<String, Arc<Terminal>>>,
    changed: Mutex<Option<Changed>>,
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
        })
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
                lines: Lines::default(),
                marks: None,
                at_prompt: false,
            }),
            carried: Mutex::default(),
            writer: Mutex::new(None),
            frames: broadcast::channel(1024).0,
            commands: Arc::new(tokio::sync::Mutex::new(())),
            running: AtomicBool::new(false),
            group: AtomicU32::new(0),
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
    vars
}

/// Whether a variable a bot's command exported is carried to its next command: never those that
/// decide which program a name runs, what a shell reads at start, or what Spade sets itself.
fn carried_over(name: &str) -> bool {
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
    ];
    !(NEVER.contains(&name)
        || name.starts_with("LD_")
        || name.starts_with("DYLD_")
        || name.starts_with("BASH_FUNC_")
        || name.starts_with("__spade")
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
    /// The running command's process group.
    group: AtomicU32,
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
    lines: Lines,
    /// Finds the running shell's prompt mark.
    marks: Option<PromptMarks>,
    /// The shell drew its prompt and no line has answered it yet.
    at_prompt: bool,
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
        }
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
        let token = uuid::Uuid::new_v4().simple().to_string();
        let startup = self.startup_file(&token)?;
        let mut command = CommandBuilder::new("/bin/sh");
        command.arg("-i");
        command.env_clear();
        for (name, value) in &self.environment {
            command.env(name, value);
        }
        command.env("ENV", &startup);
        command.cwd(&self.dir);
        let mut child = match pty.slave.spawn_command(command) {
            Ok(child) => child,
            Err(error) => {
                let _ = std::fs::remove_file(&startup);
                return Err(format!("the terminal's shell could not start: {error}"));
            }
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
        state.lines = Lines::default();
        state.marks = Some(PromptMarks::new(&token));
        state.at_prompt = false;
        drop(state);
        *lock(&self.writer) = Some((generation, writer));
        let terminal = self.clone();
        std::thread::Builder::new()
            .name("spade-terminal-read".into())
            .spawn(move || terminal.read_loop(reader, generation, startup))
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

    /// The file the shell reads at start (`ENV`): its prompt, with the mark, set but not
    /// exported, and `ENV` itself unset. Deleted once the first prompt is drawn.
    fn startup_file(&self, token: &str) -> Result<PathBuf, String> {
        let failed = |e: std::io::Error| format!("the terminal could not be prepared: {e}");
        std::fs::create_dir_all(&self.scratch).map_err(failed)?;
        let path = self.scratch.join(format!(".{token}.rc"));
        let mut text = b"PS1='".to_vec();
        text.extend_from_slice(&prompt_mark(token));
        text.extend_from_slice(b"$ '\nunset ENV\n");
        std::fs::write(&path, text).map_err(failed)?;
        Ok(path)
    }

    fn read_loop(&self, mut reader: Box<dyn Read + Send>, generation: u64, startup: PathBuf) {
        let mut buffer = vec![0u8; 16 * 1024];
        let mut startup = Some(startup);
        loop {
            let read = match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => read,
            };
            let chunk = &buffer[..read];
            let prompted = {
                let mut state = lock(&self.state);
                if state.generation != generation {
                    break;
                }
                let seq = state.ring.push(chunk);
                state.last = Some(self.clock.now_ms());
                state.last_use = Instant::now();
                let prompted = state.marks.as_mut().is_some_and(|m| m.feed(chunk));
                if prompted {
                    state.at_prompt = true;
                }
                let _ = self.frames.send(Frame::Output {
                    seq,
                    data: Arc::from(chunk),
                });
                prompted
            };
            if prompted && let Some(file) = startup.take() {
                let _ = std::fs::remove_file(file);
            }
        }
        if let Some(file) = startup {
            let _ = std::fs::remove_file(file);
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
            state.at_prompt = false;
            state.marks = None;
            pid
        };
        {
            let mut writer = lock(&self.writer);
            if writer.as_ref().is_some_and(|(g, _)| *g == generation) {
                *writer = None;
            }
        }
        if let Some(pid) = pid {
            kill_session(pid);
        }
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

    /// Kills the running bot command's process group, if any.
    fn stop_command(&self) {
        let group = self.group.load(Ordering::SeqCst);
        if group > 1 {
            kill_group(i64::from(group));
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

    /// Types the person's input. Answers the lines they entered at the shell's prompt: each
    /// must answer a prompt the shell drew, so a line typed into a program (a password at a
    /// `sudo` prompt, `read`) or a second line pasted with the first is never kept.
    pub async fn input(self: &Arc<Self>, data: Vec<u8>) -> Result<Vec<String>, String> {
        self.ensure()?;
        let entered = {
            let mut state = lock(&self.state);
            state.last_use = Instant::now();
            let lines = state.lines.feed(&data);
            let mut kept = Vec::new();
            for line in lines {
                let answered_prompt = std::mem::replace(&mut state.at_prompt, false);
                if answered_prompt && !line.is_empty() {
                    kept.push(line);
                }
            }
            kept
        };
        self.write(data).await?;
        Ok(entered)
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
    /// supervisor owns it: if this call is dropped, the command's whole process group is killed,
    /// and the next command starts only once that group is gone.
    pub async fn run(self: &Arc<Self>, command: &str, timeout: Duration) -> Result<Ran, String> {
        let one = self.commands.clone().lock_owned().await;
        let (answer, answered) = oneshot::channel();
        let (held, abandoned) = oneshot::channel::<()>();
        let terminal = self.clone();
        let command = command.to_owned();
        self.running.store(true, Ordering::SeqCst);
        tokio::spawn(async move {
            let finished = tokio::select! {
                ran = terminal.supervised(&command, timeout) => Some(ran),
                _ = abandoned => None,
            };
            // Dropped, the command's future killed its group; wait until no process is left. (A
            // command that finished was reaped and its group killed already, and its id may be
            // another process's by now, so it is left alone.)
            if finished.is_none() {
                terminal.stop_command();
                terminal.wait_gone().await;
            }
            terminal.group.store(0, Ordering::SeqCst);
            terminal.running.store(false, Ordering::SeqCst);
            drop(one);
            terminal.touched();
            if let Some(ran) = finished {
                let _ = answer.send(ran);
            }
        });
        let _held = held;
        answered
            .await
            .unwrap_or_else(|_| Err("the command was stopped".to_owned()))
    }

    /// Waits until the running command's process group has no process left.
    async fn wait_gone(&self) {
        let group = self.group.load(Ordering::SeqCst);
        if group <= 1 {
            return;
        }
        let until = Instant::now() + GONE;
        while group_alive(group) && Instant::now() < until {
            kill_group(i64::from(group));
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn supervised(self: &Arc<Self>, command: &str, timeout: Duration) -> Result<Ran, String> {
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
        let group = &self.group;
        let started = move |pid: u32| group.store(pid, Ordering::SeqCst);
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
                    started: Some(&started),
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
                if !carried_over(name) {
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

/// Whether any process is left in `group`.
fn group_alive(group: u32) -> bool {
    group > 1 && quiet("/bin/kill", &["-0", "--", &format!("-{group}")])
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
