//! A dedicated pseudo-terminal per command (ADR 0167 amendment 1, decision 4). When the
//! launcher's stdin, stdout or stderr is a terminal, the command gets a fresh pty in its place and
//! the launcher relays between the two, so the command never holds the person's own terminal:
//! its terminal modes, window size and foreground group are the dedicated pty's alone. When no
//! stdio is a terminal nothing changes.
//!
//! What goes where is [`layout`] (pure); [`Dedicated`] opens the pty and [`Relay`] copies bytes,
//! window sizes and, while it relays input, holds the caller's terminal in raw mode so the line
//! discipline runs once, in the dedicated pty.

use std::io::Write;
use std::os::fd::{BorrowedFd, OwnedFd};
use std::process::Stdio;
use std::sync::mpsc;
use std::time::Duration;

use rustix::fs::{Mode, OFlags};
use rustix::pty::OpenptFlags;
use rustix::termios::{OptionalActions, Termios};

/// How long the relay drains the command's last output once every process has ended.
const DRAIN: Duration = Duration::from_secs(2);

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

/// A pty opened for one command.
pub struct Dedicated {
    master: OwnedFd,
    slave: OwnedFd,
    layout: Layout,
}

fn stdio(index: usize) -> BorrowedFd<'static> {
    match index {
        0 => rustix::stdio::stdin(),
        1 => rustix::stdio::stdout(),
        _ => rustix::stdio::stderr(),
    }
}

/// The caller's terminal the pty copies its modes and size from.
fn model(layout: &Layout) -> BorrowedFd<'static> {
    match layout.sink {
        Sink::Inherited(index) if !layout.replaced[0] => stdio(index),
        _ => stdio(0),
    }
}

impl Dedicated {
    /// A pty for this launcher's stdio, or `None` when no stdio is a terminal.
    pub fn open() -> Result<Option<Self>, String> {
        let terminals = [0, 1, 2].map(|i| rustix::termios::isatty(stdio(i)));
        // Only a controlling terminal stops a background reader. One that isn't the launcher's
        // (`tcgetpgrp` refuses it) is read freely.
        let foreground = terminals[0]
            && rustix::termios::tcgetpgrp(stdio(0))
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
        let caller = model(&layout);
        if let Ok(modes) = rustix::termios::tcgetattr(caller) {
            rustix::termios::tcsetattr(&slave, OptionalActions::Now, &modes).map_err(failed)?;
        }
        if let Ok(size) = rustix::termios::tcgetwinsize(caller) {
            rustix::termios::tcsetwinsize(&master, size).map_err(failed)?;
        }
        Ok(Some(Self {
            master,
            slave,
            layout,
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

    /// The command's stdin, stdout and stderr: the pty where the caller's was a terminal.
    pub fn stdio(&self) -> Result<[Stdio; 3], String> {
        let one = |index: usize| -> Result<Stdio, String> {
            if self.layout.replaced[index] {
                let copy =
                    rustix::io::fcntl_dupfd_cloexec(&self.slave, 3).map_err(|e| e.to_string())?;
                Ok(Stdio::from(copy))
            } else {
                Ok(Stdio::inherit())
            }
        };
        Ok([one(0)?, one(1)?, one(2)?])
    }

    /// Starts relaying. The launcher's own handle on the pty's command side is closed here, so
    /// the relay ends once the command and everything it started have let go of it.
    pub fn relay(self) -> Relay {
        let Self {
            master,
            slave,
            layout,
        } = self;
        drop(slave);
        let saved = if layout.raw { raw(stdio(0)) } else { None };
        let resize = master.try_clone().ok();
        if let Some(resize) = resize {
            std::thread::spawn(move || follow_size(&resize, model(&layout)));
        }
        if layout.input
            && let Ok(input) = master.try_clone()
        {
            std::thread::spawn(move || forward(stdio(0), std::fs::File::from(input)));
        }
        let (done, drained) = mpsc::channel();
        let sink = match layout.sink {
            Sink::Inherited(index) => rustix::io::dup(stdio(index)).ok(),
            Sink::Stdin => rustix::fs::open(
                "/proc/self/fd/0",
                OFlags::WRONLY | OFlags::NOCTTY | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .ok(),
        };
        std::thread::spawn(move || {
            drain(&master, sink.map(std::fs::File::from));
            let _ = done.send(());
        });
        Relay { drained, saved }
    }
}

/// A running relay.
pub struct Relay {
    drained: mpsc::Receiver<()>,
    saved: Option<Termios>,
}

impl Relay {
    /// After the command's whole tree has ended: shows what it last wrote and gives the caller
    /// its terminal back as it was.
    pub fn finish(self) {
        let _ = self.drained.recv_timeout(DRAIN);
        if let Some(saved) = &self.saved {
            let _ = rustix::termios::tcsetattr(stdio(0), OptionalActions::Drain, saved);
        }
    }
}

/// Puts `terminal` in raw mode and answers how it was.
fn raw(terminal: BorrowedFd<'_>) -> Option<Termios> {
    let saved = rustix::termios::tcgetattr(terminal).ok()?;
    let mut modes = saved.clone();
    modes.make_raw();
    rustix::termios::tcsetattr(terminal, OptionalActions::Now, &modes).ok()?;
    Some(saved)
}

/// Copies the caller's keystrokes into the pty until either side ends.
fn forward(from: BorrowedFd<'_>, mut to: std::fs::File) {
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

/// Copies what the command writes to `sink` until the pty ends (its master reads `EIO` once the
/// last command-side descriptor closes). Without a sink, or once it fails, the output is still
/// read, so the command never blocks on a full pty.
fn drain(master: &OwnedFd, mut sink: Option<std::fs::File>) {
    let mut buffer = [0u8; 16 * 1024];
    loop {
        match rustix::io::read(master, &mut buffer) {
            Ok(0) => return,
            Ok(n) => {
                if let Some(out) = sink.as_mut()
                    && out.write_all(&buffer[..n]).is_err()
                {
                    sink = None;
                }
            }
            Err(rustix::io::Errno::INTR) => {}
            Err(_) => return,
        }
    }
}

/// Gives the pty the caller's window size each time the caller's terminal is resized.
fn follow_size(master: &OwnedFd, caller: BorrowedFd<'static>) {
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
}
