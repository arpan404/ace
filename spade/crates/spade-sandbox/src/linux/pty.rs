//! A dedicated pseudo-terminal per command (ADR 0167 amendment 1, decision 4). When the
//! launcher's stdin, stdout or stderr is a terminal, the command gets a fresh pty in its place and
//! the launcher relays between the two, so the command never holds the person's own terminal:
//! its terminal modes, window size and foreground group are the dedicated pty's alone. When no
//! stdio is a terminal nothing changes.
//!
//! What goes where is [`layout`] (pure); [`Dedicated`] opens the pty and [`Relay`] copies bytes,
//! window sizes and, while it relays input, holds the caller's terminal in raw mode so the line
//! discipline runs once, in the dedicated pty. The command's output reaches the caller only
//! through [`Screen`], which drops every control sequence that reaches past the screen. Raw mode
//! is held by a guard from the moment it is set: every path out, an error or an unwind included,
//! gives the caller its terminal back.

use std::io::Write;
use std::os::fd::{AsRawFd, OwnedFd};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use super::screen::Screen;

use rustix::fs::{Mode, OFlags};
use rustix::pty::OpenptFlags;
use rustix::termios::{OptionalActions, Termios};

/// How long the relay drains the command's last output once every process has ended.
const DRAIN: Duration = Duration::from_secs(2);
/// How long the launcher waits to hand the person's terminal its restore sequence when the
/// terminal reads slowly; only a terminal that reads nothing at all misses it.
const RESTORE: Duration = Duration::from_secs(5);

/// Where the caller's terminal output goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sink {
    /// The caller's stdout (1) or stderr (2), as inherited.
    Inherited(usize),
    /// Only stdin is a terminal: it is reopened for writing.
    Stdin,
}

/// What the dedicated pty replaces and how it is relayed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Layout {
    /// Which of stdin, stdout and stderr the command gets the pty for.
    pub replaced: [bool; 3],
    /// The caller's keystrokes are relayed (stdin is a terminal and the launcher may read it:
    /// a background read of its controlling terminal would stop it).
    pub input: bool,
    /// The caller's terminal is put in raw mode while input is relayed.
    pub raw: bool,
    /// The pty becomes the command's controlling terminal (its stdin is the pty).
    pub controlling: bool,
    pub sink: Sink,
}

/// The layout for stdio where `terminals` says which of stdin, stdout and stderr are terminals.
/// `None` when none is: the command keeps its stdio as it is.
pub fn layout(terminals: [bool; 3], foreground: bool) -> Option<Layout> {
    if !terminals.iter().any(|t| *t) {
        return None;
    }
    let sink = if terminals[1] {
        Sink::Inherited(1)
    } else if terminals[2] {
        Sink::Inherited(2)
    } else {
        Sink::Stdin
    };
    let input = terminals[0] && foreground;
    Some(Layout {
        replaced: terminals,
        input,
        raw: input,
        controlling: terminals[0],
        sink,
    })
}

/// Which of the caller's terminals the pty copies its modes and size from.
fn model_of(layout: &Layout) -> usize {
    match layout.sink {
        Sink::Inherited(index) if !layout.replaced[0] => index,
        _ => 0,
    }
}

/// A pty opened for one command.
pub struct Dedicated {
    master: OwnedFd,
    slave: OwnedFd,
    layout: Layout,
    /// The caller's stdin, stdout and stderr.
    caller: [OwnedFd; 3],
}

/// Starts one of the relay's threads. Injected so a failure to start one can be tested.
pub type Spawn<'a> = &'a dyn Fn(&'static str, Box<dyn FnOnce() + Send>) -> std::io::Result<()>;

/// Starts a named thread, reporting a failure to start it instead of panicking.
pub fn threads(name: &'static str, work: Box<dyn FnOnce() + Send>) -> std::io::Result<()> {
    std::thread::Builder::new()
        .name(name.to_owned())
        .spawn(work)
        .map(drop)
}

/// The launcher's own stdin, stdout and stderr, as descriptors it holds.
pub fn caller() -> Result<[OwnedFd; 3], String> {
    let one = |fd| rustix::io::fcntl_dupfd_cloexec(fd, 3).map_err(|e| format!("stdio: {e}"));
    Ok([
        one(rustix::stdio::stdin())?,
        one(rustix::stdio::stdout())?,
        one(rustix::stdio::stderr())?,
    ])
}

impl Dedicated {
    /// A pty for this launcher's stdio, or `None` when no stdio is a terminal.
    pub fn open() -> Result<Option<Self>, String> {
        Self::open_for(caller()?)
    }

    /// A pty for a caller whose stdin, stdout and stderr are `caller`.
    pub fn open_for(caller: [OwnedFd; 3]) -> Result<Option<Self>, String> {
        let terminals = [0, 1, 2].map(|i| rustix::termios::isatty(&caller[i]));
        // Only a controlling terminal stops a background reader. One that isn't the launcher's
        // (`tcgetpgrp` refuses it) is read freely.
        let foreground = terminals[0]
            && rustix::termios::tcgetpgrp(&caller[0])
                .map_or(true, |group| group == rustix::process::getpgrp());
        let Some(layout) = layout(terminals, foreground) else {
            return Ok(None);
        };
        let failed = |e: rustix::io::Errno| format!("a terminal for the command: {e}");
        let flags = OpenptFlags::RDWR | OpenptFlags::NOCTTY | OpenptFlags::CLOEXEC;
        let master = rustix::pty::openpt(flags).map_err(failed)?;
        rustix::pty::grantpt(&master).map_err(failed)?;
        rustix::pty::unlockpt(&master).map_err(failed)?;
        // Through the master, never by a path someone could swap.
        let slave = rustix::pty::ioctl_tiocgptpeer(&master, flags).map_err(failed)?;
        let model = &caller[model_of(&layout)];
        if let Ok(modes) = rustix::termios::tcgetattr(model) {
            rustix::termios::tcsetattr(&slave, OptionalActions::Now, &modes).map_err(failed)?;
        }
        if let Ok(size) = rustix::termios::tcgetwinsize(model) {
            rustix::termios::tcsetwinsize(&master, size).map_err(failed)?;
        }
        Ok(Some(Self {
            master,
            slave,
            layout,
            caller,
        }))
    }

    pub fn layout(&self) -> Layout {
        self.layout
    }

    /// The pty's own node, opened as a path (for its Landlock rule): the one in `/dev/pts` with
    /// the same device and inode as the opened pty.
    pub fn node(&self) -> Result<OwnedFd, String> {
        let name = rustix::pty::ptsname(&self.master, Vec::new()).map_err(|e| e.to_string())?;
        let node = rustix::fs::open(
            name.as_c_str(),
            OFlags::PATH | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|e| e.to_string())?;
        let (a, b) = (
            rustix::fs::fstat(&node).map_err(|e| e.to_string())?,
            rustix::fs::fstat(&self.slave).map_err(|e| e.to_string())?,
        );
        if (a.st_dev, a.st_ino, a.st_rdev) != (b.st_dev, b.st_ino, b.st_rdev) {
            return Err("the command's terminal changed under its name".to_owned());
        }
        Ok(node)
    }

    /// The command's stdin, stdout and stderr: the pty where the caller's was a terminal, the
    /// caller's own elsewhere.
    pub fn fds(&self) -> Result<[OwnedFd; 3], String> {
        let one = |index: usize| {
            let from = if self.layout.replaced[index] {
                &self.slave
            } else {
                &self.caller[index]
            };
            rustix::io::fcntl_dupfd_cloexec(from, 3).map_err(|e| e.to_string())
        };
        Ok([one(0)?, one(1)?, one(2)?])
    }

    /// Starts relaying. The launcher's own handle on the pty's command side is closed here, so
    /// the relay ends once the command and everything it started have let go of it.
    pub fn relay(self) -> Result<Relay, String> {
        self.relay_with(&threads)
    }

    fn relay_with(self, spawn: Spawn<'_>) -> Result<Relay, String> {
        let Self {
            master,
            slave,
            layout,
            caller,
        } = self;
        drop(slave);
        let failed =
            |e: std::io::Error| format!("the command's terminal could not be relayed: {e}");
        let copy = |fd: &OwnedFd| fd.try_clone().map_err(failed);
        let sink = match layout.sink {
            Sink::Inherited(index) => copy(&caller[index]).ok(),
            Sink::Stdin => rustix::fs::open(
                format!("/proc/self/fd/{}", caller[0].as_raw_fd()),
                OFlags::WRONLY | OFlags::NOCTTY | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .ok(),
        };
        let (input, size) = (copy(&master)?, copy(&master)?);
        let (keys, model) = (copy(&caller[0])?, copy(&caller[model_of(&layout)])?);
        let (done, drained) = mpsc::channel();
        let output = Arc::new(Output {
            sink: Mutex::new(Shown {
                sink: sink.map(std::fs::File::from),
                ended: false,
            }),
            alternate: AtomicBool::new(false),
        });
        // From here on dropping `relay` gives the caller its screen and its terminal's modes
        // back, on every way out.
        let relay = Relay {
            drained,
            output: Arc::clone(&output),
            raw: if layout.raw {
                RawMode::set(&caller[0])
            } else {
                None
            },
        };
        spawn(
            "spade-pty-output",
            Box::new(move || {
                drain(&master, &output);
                let _ = done.send(());
            }),
        )
        .map_err(failed)?;
        if layout.input {
            spawn(
                "spade-pty-input",
                Box::new(move || forward(&keys, std::fs::File::from(input))),
            )
            .map_err(failed)?;
        }
        spawn(
            "spade-pty-size",
            Box::new(move || follow_size(&size, &model)),
        )
        .map_err(failed)?;
        Ok(relay)
    }
}

/// The caller's terminal in raw mode, given back as it was when this is dropped.
struct RawMode {
    terminal: OwnedFd,
    saved: Termios,
}

impl RawMode {
    fn set(terminal: &OwnedFd) -> Option<Self> {
        let terminal = terminal.try_clone().ok()?;
        let saved = rustix::termios::tcgetattr(&terminal).ok()?;
        let mut modes = saved.clone();
        modes.make_raw();
        // The guard exists before the change, so even a partly applied change is undone.
        let guard = Self { terminal, saved };
        rustix::termios::tcsetattr(&guard.terminal, OptionalActions::Now, &modes).ok()?;
        Some(guard)
    }
}

impl Drop for RawMode {
    fn drop(&mut self) {
        let _ = rustix::termios::tcsetattr(&self.terminal, OptionalActions::Now, &self.saved);
    }
}

/// A running relay. Dropping it, finished or not, sends the person's terminal its restore
/// sequence and gives its modes back.
pub struct Relay {
    drained: mpsc::Receiver<()>,
    output: Arc<Output>,
    raw: Option<RawMode>,
}

impl Relay {
    /// After the command's whole tree has ended: shows what it last wrote, for at most
    /// [`DRAIN`], then (on drop) restores the person's screen and terminal.
    pub fn finish(self) {
        let _ = self.drained.recv_timeout(DRAIN);
    }
}

impl Drop for Relay {
    fn drop(&mut self) {
        // The output worker may be blocked writing to a slow terminal: ending waits for that
        // write, then sends the restore and stops the worker for good. It runs on its own
        // thread so a terminal that reads nothing can't hold the launcher past [`RESTORE`].
        let output = Arc::clone(&self.output);
        let (done, ended) = mpsc::channel();
        let started = threads(
            "spade-pty-restore",
            Box::new(move || {
                output.end();
                let _ = done.send(());
            }),
        );
        match started {
            Ok(()) => {
                let _ = ended.recv_timeout(RESTORE);
            }
            // No thread to spare: end here, as the launcher is ending anyway.
            Err(_) => self.output.end(),
        }
        drop(self.raw.take());
    }
}

/// Where the command's filtered output goes, shared by the output worker and the relay.
struct Output {
    sink: Mutex<Shown>,
    /// The command is on a `?1049h` alternate screen, as [`Screen`] last saw.
    alternate: AtomicBool,
}

struct Shown {
    /// The person's terminal; `None` once a write to it failed, or with nowhere to show.
    sink: Option<std::fs::File>,
    /// The restore was sent: nothing is written after it.
    ended: bool,
}

impl Output {
    /// Shows `bytes`, unless the relay has ended. Each call writes whole sequences only, so the
    /// restore sent after it never lands inside one.
    fn show(&self, bytes: &[u8]) -> bool {
        let mut shown = self.sink.lock().unwrap_or_else(|e| e.into_inner());
        if shown.ended {
            return false;
        }
        if let Some(out) = shown.sink.as_mut()
            && out.write_all(bytes).is_err()
        {
            shown.sink = None;
        }
        true
    }

    /// Sends the restore sequence once, after any write in progress, and stops all output.
    fn end(&self) {
        let mut shown = self.sink.lock().unwrap_or_else(|e| e.into_inner());
        if shown.ended {
            return;
        }
        shown.ended = true;
        let restore = super::screen::restore(self.alternate.load(Ordering::SeqCst));
        if let Some(out) = shown.sink.as_mut() {
            let _ = out.write_all(&restore);
        }
        shown.sink = None;
    }
}

/// Copies the caller's keystrokes into the pty until either side ends.
fn forward(from: &OwnedFd, mut to: std::fs::File) {
    let mut buffer = [0u8; 4096];
    loop {
        match rustix::io::read(from, &mut buffer) {
            Ok(0) => return,
            Ok(n) => {
                if to.write_all(&buffer[..n]).is_err() {
                    return;
                }
            }
            Err(rustix::io::Errno::INTR) => {}
            Err(_) => return,
        }
    }
}

/// Shows what the command writes, through [`Screen`], until the pty ends (its master reads
/// `EIO` once the last command-side descriptor closes), then ends the output with the restore.
/// Once the relay has ended, or with nowhere to show it, the output is still read, so the
/// command never blocks on a full pty.
fn drain(master: &OwnedFd, output: &Output) {
    let mut buffer = [0u8; 16 * 1024];
    let mut screen = Screen::default();
    let mut shown = Vec::with_capacity(buffer.len());
    loop {
        match rustix::io::read(master, &mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                shown.clear();
                screen.feed(&buffer[..n], &mut shown);
                output.alternate.store(screen.alternate(), Ordering::SeqCst);
                output.show(&shown);
            }
            Err(rustix::io::Errno::INTR) => {}
            Err(_) => break,
        }
    }
    output.end();
}

/// Gives the pty the caller's window size each time the caller's terminal is resized.
fn follow_size(master: &OwnedFd, caller: &OwnedFd) {
    let Ok(mut signals) = signal_hook::iterator::Signals::new([signal_hook::consts::SIGWINCH])
    else {
        return;
    };
    for _ in signals.forever() {
        if let Ok(size) = rustix::termios::tcgetwinsize(caller) {
            let _ = rustix::termios::tcsetwinsize(master, size);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn without_a_terminal_on_stdio_the_command_keeps_its_stdio() {
        assert_eq!(layout([false; 3], true), None);
        assert_eq!(layout([false; 3], false), None);
    }

    #[test]
    fn every_terminal_on_stdio_is_replaced_and_only_those() {
        for terminals in [
            [true, true, true],
            [true, false, false],
            [false, true, false],
            [false, false, true],
            [false, true, true],
        ] {
            let layout = layout(terminals, true).unwrap_or_else(|| panic!("{terminals:?}"));
            assert_eq!(layout.replaced, terminals);
            // Only a pty on stdin can be made the controlling terminal.
            assert_eq!(layout.controlling, terminals[0]);
        }
    }

    #[test]
    fn keystrokes_are_relayed_in_raw_mode_only_from_the_foreground() {
        let front = layout([true, true, true], true).unwrap_or_else(|| panic!());
        assert!(front.input && front.raw);
        let back = layout([true, true, true], false).unwrap_or_else(|| panic!());
        assert!(!back.input && !back.raw);
        // Output to a terminal with stdin from a pipe: nothing is read, the caller's modes stay.
        let piped = layout([false, true, false], true).unwrap_or_else(|| panic!());
        assert!(!piped.input && !piped.raw);
    }

    #[test]
    fn output_goes_to_stdout_then_stderr_then_stdins_terminal() {
        let sink = |t| layout(t, true).map(|l| l.sink);
        assert_eq!(sink([true, true, true]), Some(Sink::Inherited(1)));
        assert_eq!(sink([true, false, true]), Some(Sink::Inherited(2)));
        assert_eq!(sink([true, false, false]), Some(Sink::Stdin));
    }

    /// A same-user pty standing in for the person's terminal: its master and the terminal.
    fn person() -> (OwnedFd, OwnedFd) {
        let flags = OpenptFlags::RDWR | OpenptFlags::NOCTTY | OpenptFlags::CLOEXEC;
        let master = rustix::pty::openpt(flags).unwrap_or_else(|e| panic!("{e}"));
        rustix::pty::unlockpt(&master).unwrap_or_else(|e| panic!("{e}"));
        let terminal =
            rustix::pty::ioctl_tiocgptpeer(&master, flags).unwrap_or_else(|e| panic!("{e}"));
        (master, terminal)
    }

    fn modes(terminal: &OwnedFd) -> (u32, u32, u32) {
        let t = rustix::termios::tcgetattr(terminal).unwrap_or_else(|e| panic!("{e}"));
        (
            t.input_modes.bits(),
            t.output_modes.bits(),
            t.local_modes.bits(),
        )
    }

    fn dedicated_for(terminal: &OwnedFd) -> Dedicated {
        let copy = || terminal.try_clone().unwrap_or_else(|e| panic!("{e}"));
        Dedicated::open_for([copy(), copy(), copy()])
            .unwrap_or_else(|e| panic!("{e}"))
            .unwrap_or_else(|| panic!("a terminal on stdio gets a dedicated pty"))
    }

    #[test]
    fn a_failure_after_raw_mode_gives_the_person_their_terminal_back() {
        let (_master, terminal) = person();
        let before = modes(&terminal);
        let dedicated = dedicated_for(&terminal);
        assert!(dedicated.layout().raw);
        let started = std::sync::atomic::AtomicUsize::new(0);
        let raw_when_failing = std::sync::Mutex::new(None);
        // The first thread starts; the second can't, as when the process is out of threads.
        let spawn = |name: &'static str, work: Box<dyn FnOnce() + Send>| {
            if started.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                return threads(name, work);
            }
            *raw_when_failing.lock().unwrap_or_else(|e| e.into_inner()) =
                Some(modes(&terminal) != before);
            Err(std::io::Error::from_raw_os_error(11))
        };
        let relayed = dedicated.relay_with(&spawn);
        assert!(relayed.is_err());
        assert_eq!(
            *raw_when_failing.lock().unwrap_or_else(|e| e.into_inner()),
            Some(true),
            "the failure came after raw mode was set"
        );
        assert_eq!(modes(&terminal), before);
    }

    #[test]
    fn a_relay_dropped_without_finishing_gives_the_terminal_back() {
        let (_master, terminal) = person();
        let before = modes(&terminal);
        let relay = dedicated_for(&terminal)
            .relay()
            .unwrap_or_else(|e| panic!("{e}"));
        assert_ne!(modes(&terminal), before, "raw while relaying");
        drop(relay);
        assert_eq!(modes(&terminal), before);
    }

    #[test]
    fn a_finished_relay_gives_the_terminal_back() {
        let (_master, terminal) = person();
        let before = modes(&terminal);
        let relay = dedicated_for(&terminal)
            .relay()
            .unwrap_or_else(|e| panic!("{e}"));
        relay.finish();
        assert_eq!(modes(&terminal), before);
    }

    /// Everything the person's terminal has been sent so far.
    fn sent(master: &OwnedFd) -> Vec<u8> {
        let flags = rustix::fs::fcntl_getfl(master).unwrap_or_else(|e| panic!("{e}"));
        rustix::fs::fcntl_setfl(master, flags | OFlags::NONBLOCK).unwrap_or_else(|e| panic!("{e}"));
        let mut all = Vec::new();
        let mut buffer = [0u8; 4096];
        while let Ok(n) = rustix::io::read(master, &mut buffer) {
            if n == 0 {
                break;
            }
            all.extend_from_slice(&buffer[..n]);
        }
        all
    }

    #[test]
    fn a_relay_dropped_on_an_error_path_still_restores_the_persons_screen() {
        let (master, terminal) = person();
        let relay = dedicated_for(&terminal)
            .relay()
            .unwrap_or_else(|e| panic!("{e}"));
        drop(relay);
        let shown = sent(&master);
        let restore = super::super::screen::restore(false);
        // Unconditional: even with nothing written, the cursor is shown and the modes reset.
        assert!(
            shown.ends_with(&restore) && restore.ends_with(b"\x1b[?25h\x1b[?1l\x1b>"),
            "{:?}",
            String::from_utf8_lossy(&shown)
        );
    }
}
