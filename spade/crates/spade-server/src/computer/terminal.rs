//! Each bot's terminal (ADR 0142): one interactive `/bin/sh` in a pseudo-terminal, in the bot's
//! workspace, kept between commands. The bot's `shell` tool types its commands into it; the
//! person watches it live and types into it while they drive. Started on demand, ended when idle
//! for a long time or when the bot goes, and everything left in its session ends with it.
//!
//! A bot command is written to a file in Spade's scratch folder and sourced, between two marker
//! sequences the reader looks for (`plain::Capture`), so it runs in the terminal's own shell
//! (its folder and variables carry over) with stdin from `/dev/null`. The shell's job control
//! puts each foreground job in its own process group; when the terminal's foreground group is
//! not the shell's, something is running there, and the bot waits its turn rather than typing
//! into it.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tokio::sync::{Notify, broadcast};
use tokio::time::Instant;

use super::plain::{Capture, Lines, marker_printf};
use super::ring::{Ring, SCROLLBACK};
use crate::clock::Clock;
use crate::workspace::shell::{Ran, Shell};

/// How long a terminal may sit unused before it is ended; the next use starts a new one.
pub const IDLE: Duration = Duration::from_secs(6 * 60 * 60);
/// How long a bot command gets to stop after Ctrl-C before its job is killed.
const INTERRUPT_GRACE: Duration = Duration::from_secs(1);
/// The size a terminal starts at, until a viewer says otherwise.
const START_SIZE: (u16, u16) = (120, 32);

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
    /// Spade's own folder for the files bot commands are sourced from, outside every workspace.
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
            dir: dir.clone(),
            scratch: self.scratch.join(bot),
            environment: environment(&self.shell, &dir),
            clock: self.clock.clone(),
            state: Mutex::new(State {
                session: None,
                generation: 0,
                ring: Ring::new(SCROLLBACK, first_seq(self.clock.as_ref())),
                size: START_SIZE,
                capture: None,
                since: None,
                last: None,
                last_use: Instant::now(),
                title: None,
                lines: Lines::default(),
            }),
            writer: Mutex::new(None),
            frames: broadcast::channel(1024).0,
            commands: tokio::sync::Mutex::new(()),
            wake: Notify::new(),
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
        }
        let _ = std::fs::remove_dir_all(self.scratch.join(bot));
    }

    /// Ends every terminal unused for `idle`, except those `keep` names (a bot whose computer
    /// the person has). Answers how many ended.
    pub fn reap(&self, idle: Duration, keep: impl Fn(&str) -> bool) -> usize {
        let terminals: Vec<Arc<Terminal>> = lock(&self.all).values().cloned().collect();
        let mut ended = 0;
        for terminal in terminals {
            if keep(&terminal.bot) {
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

    /// Ends every terminal, when Spade stops.
    pub fn end_all(&self) {
        for terminal in lock(&self.all).values() {
            terminal.end();
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

/// The shell's environment: the one-shot shell's (none of Spade's secrets, system `PATH`, `HOME`
/// the workspace), with a terminal type a person's programs can draw with and a plain prompt.
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
    clock: Arc<dyn Clock>,
    state: Mutex<State>,
    /// Kept apart from `state`: a write can wait on a shell that is not reading.
    writer: Mutex<Option<(u64, Box<dyn Write + Send>)>>,
    frames: broadcast::Sender<Frame>,
    /// One bot command at a time.
    commands: tokio::sync::Mutex<()>,
    /// Woken when output arrives or the shell ends.
    wake: Notify,
    changed: Option<Changed>,
}

struct State {
    session: Option<Session>,
    /// Counts shells started, so a finished one's threads never touch the next.
    generation: u64,
    ring: Ring,
    size: (u16, u16),
    /// The bot command whose output is being cut out of the stream.
    capture: Option<Capture>,
    since: Option<i64>,
    last: Option<i64>,
    last_use: Instant,
    title: Option<String>,
    lines: Lines,
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    pid: u32,
    generation: u64,
}

impl Session {
    /// Whether the shell itself is in the foreground: at its prompt, or running a builtin. A
    /// running program has its own process group there.
    fn at_shell(&self) -> bool {
        match self.master.process_group_leader() {
            Some(leader) => i64::from(leader) == i64::from(self.pid),
            None => true,
        }
    }

    fn foreground(&self) -> Option<i64> {
        self.master.process_group_leader().map(i64::from)
    }
}

impl Terminal {
    pub fn info(&self) -> Info {
        let state = lock(&self.state);
        Info {
            running: state.session.is_some(),
            since: state.session.as_ref().and(state.since),
            last: state.last,
            title: state.title.clone(),
        }
    }

    fn touched(&self) {
        if let Some(changed) = &self.changed {
            changed(&self.bot);
        }
    }

    /// Starts the shell unless it runs.
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
        let mut child = pty
            .slave
            .spawn_command(command)
            .map_err(|e| format!("the terminal's shell could not start: {e}"))?;
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
            generation,
        });
        let now = self.clock.now_ms();
        state.since = Some(now);
        state.last = Some(now);
        state.last_use = Instant::now();
        state.lines = Lines::default();
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
            {
                let mut state = lock(&self.state);
                if state.generation != generation {
                    return;
                }
                let seq = state.ring.push(chunk);
                state.last = Some(self.clock.now_ms());
                state.last_use = Instant::now();
                if let Some(capture) = state.capture.as_mut() {
                    capture.feed(chunk);
                }
                let _ = self.frames.send(Frame::Output {
                    seq,
                    data: Arc::from(chunk),
                });
            }
            self.wake.notify_waiters();
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
        if let Some(pid) = pid {
            kill_session(pid);
        }
        let _ = self.frames.send(Frame::Exit { code });
        self.wake.notify_waiters();
        self.touched();
    }

    /// Ends the shell and everything in its session. The next use starts a new one.
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

    /// Types the person's input. Answers the lines they entered at the shell's prompt (never one
    /// typed into a running program, such as a password at a `sudo` prompt).
    pub async fn input(self: &Arc<Self>, data: Vec<u8>) -> Result<Vec<String>, String> {
        self.ensure()?;
        let entered = {
            let mut state = lock(&self.state);
            state.last_use = Instant::now();
            let at_shell = state.session.as_ref().is_some_and(Session::at_shell);
            let lines = state.lines.feed(&data);
            if at_shell { lines } else { Vec::new() }
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

    /// Runs the bot's `command` in the terminal for at most `timeout`. Refused while a program
    /// holds the terminal's foreground. A command past its deadline gets Ctrl-C, then its job is
    /// killed; the shell itself stays.
    pub async fn run(self: &Arc<Self>, command: &str, timeout: Duration) -> Result<Ran, String> {
        let _one = self.commands.lock().await;
        self.ensure()?;
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        let (generation, busy) = {
            let state = lock(&self.state);
            let session = state.session.as_ref();
            (
                session.map_or(0, |s| s.generation),
                session.is_some_and(|s| !s.at_shell()),
            )
        };
        if busy {
            return Err(
                "Your terminal is busy: a program is running in its foreground (the \
                        person may have left one open). Ask the person, or try again later."
                    .to_owned(),
            );
        }
        let files = Scratch::write(&self.scratch, &nonce, command)?;
        {
            let mut state = lock(&self.state);
            state.capture = Some(Capture::new(&nonce));
            state.title = Some(
                command
                    .lines()
                    .next()
                    .unwrap_or_default()
                    .chars()
                    .take(80)
                    .collect(),
            );
            state.last_use = Instant::now();
        }
        self.touched();
        // Ctrl-U first: anything half typed at the prompt is dropped, not run with the command.
        let line = format!("\x15 . {}\n", quoted(&files.run));
        let deadline = Instant::now() + timeout;
        let wrote = self.write(line.into_bytes()).await;
        let mut timed_out = false;
        let mut shell_ended = false;
        if wrote.is_ok() {
            loop {
                let woken = self.wake.notified();
                tokio::pin!(woken);
                woken.as_mut().enable();
                {
                    let state = lock(&self.state);
                    if state.capture.as_ref().is_some_and(|c| c.code().is_some()) {
                        break;
                    }
                    if state
                        .session
                        .as_ref()
                        .is_none_or(|s| s.generation != generation)
                    {
                        shell_ended = true;
                        break;
                    }
                }
                tokio::select! {
                    () = &mut woken => {}
                    () = tokio::time::sleep_until(deadline) => {
                        timed_out = true;
                        break;
                    }
                }
            }
        }
        if timed_out {
            self.interrupt(generation).await;
        }
        let capture = lock(&self.state).capture.take();
        drop(files);
        wrote?;
        let (text, cut) = capture.as_ref().map(Capture::output).unwrap_or_default();
        let mut stdout = text;
        if shell_ended && !timed_out {
            stdout.push_str("\n[The terminal's shell ended; the next command starts a new one.]");
        }
        Ok(Ran {
            stdout,
            stderr: String::new(),
            code: capture.as_ref().and_then(Capture::code),
            timed_out,
            cut,
        })
    }

    /// Stops what a timed-out command left running: Ctrl-C, then the foreground job is killed.
    async fn interrupt(self: &Arc<Self>, generation: u64) {
        let _ = self.write(b"\x03".to_vec()).await;
        tokio::time::sleep(INTERRUPT_GRACE).await;
        let foreground = {
            let state = lock(&self.state);
            state
                .session
                .as_ref()
                .filter(|s| s.generation == generation && !s.at_shell())
                .and_then(Session::foreground)
        };
        if let Some(group) = foreground {
            kill_group(group);
        }
    }
}

/// The two files a bot command is sourced from, removed when dropped.
struct Scratch {
    command: PathBuf,
    run: PathBuf,
}

impl Scratch {
    fn write(folder: &Path, nonce: &str, command: &str) -> Result<Self, String> {
        let failed = |e: std::io::Error| format!("the command could not be prepared: {e}");
        std::fs::create_dir_all(folder).map_err(failed)?;
        let files = Self {
            command: folder.join(format!("{nonce}.cmd")),
            run: folder.join(format!("{nonce}.sh")),
        };
        std::fs::write(&files.command, format!("{command}\n")).map_err(failed)?;
        // The command is sourced on its own, so a syntax error in it still reaches the end
        // marker with its status.
        let run = format!(
            "{}\n. {} </dev/null\n{} \"$?\"\n",
            marker_printf(nonce, "start"),
            quoted(&files.command),
            marker_printf(nonce, "end;%s"),
        );
        std::fs::write(&files.run, run).map_err(failed)?;
        Ok(files)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.command);
        let _ = std::fs::remove_file(&self.run);
    }
}

/// `path` in single quotes for `sh`.
fn quoted(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

/// Kills one process group. `kill` is a program because Spade forbids `unsafe`.
fn kill_group(group: i64) {
    if group <= 1 {
        return;
    }
    let _ = std::process::Command::new("/bin/kill")
        .args(["-KILL", "--", &format!("-{group}")])
        .env_clear()
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

/// Kills everything in the session `leader` leads: its own group and every job's.
fn kill_session(leader: u32) {
    if leader <= 1 {
        return;
    }
    kill_group(i64::from(leader));
    for pkill in ["/usr/bin/pkill", "/bin/pkill"] {
        if Path::new(pkill).exists() {
            let _ = std::process::Command::new(pkill)
                .args(["-KILL", "-s", &leader.to_string()])
                .env_clear()
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
            break;
        }
    }
}
