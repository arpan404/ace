//! One owner for reaping. Shutdown never holds a descriptor per child or blocks on a live one.
use rustix::fs::{Mode, OFlags};
use rustix::io::Errno;
use rustix::process::{Pid, Signal, WaitOptions, WaitStatus};
use std::io::Read;
use std::os::fd::OwnedFd;
use std::sync::Mutex;
const BATCH: usize = 32;

pub struct Reaper {
    root: Pid,
    state: Mutex<State>,
}
struct State {
    reserve: Vec<OwnedFd>,
    cursor: usize,
}
impl Reaper {
    pub fn new(root: Pid) -> std::io::Result<Self> {
        let mut reserve = Vec::new();
        for _ in 0..4 {
            reserve.push(rustix::fs::open(
                "/dev/null",
                OFlags::RDONLY | OFlags::CLOEXEC,
                Mode::empty(),
            )?);
        }
        Ok(Self {
            root,
            state: Mutex::new(State { reserve, cursor: 0 }),
        })
    }
    pub fn root_status(&self) -> std::io::Result<WaitStatus> {
        let _guard = self
            .state
            .lock()
            .map_err(|_| std::io::Error::other("reaper lock failed"))?;
        rustix::process::waitpid(Some(self.root), WaitOptions::NOHANG)?
            .map(|(_, s)| s)
            .ok_or_else(|| std::io::Error::other("root status is not ready"))
    }
    pub fn reap_orphans(&self) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if let Ok(ids) = state.ids() {
            let start = state.cursor.min(ids.len());
            for pid in ids.iter().skip(start).take(BATCH) {
                if *pid != self.root {
                    let _ = rustix::process::waitpid(Some(*pid), WaitOptions::NOHANG);
                }
            }
            state.cursor = if start + BATCH >= ids.len() {
                0
            } else {
                start + BATCH
            };
        }
    }
    pub fn kill(&self) -> std::io::Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| std::io::Error::other("reaper lock failed"))?;
        let ids = state.ids()?;
        for pid in ids.into_iter().take(BATCH) {
            state.signal(pid)?;
        }
        Ok(())
    }
    pub fn finish(&self) -> std::io::Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| std::io::Error::other("reaper lock failed"))?;
        loop {
            let ids = state.ids()?;
            let mut incomplete = false;
            for pid in ids.iter().take(BATCH) {
                match state.signal(*pid) {
                    Ok(()) => {}
                    Err(e) if e.raw_os_error() == Some(Errno::MFILE.raw_os_error()) => {
                        incomplete = true;
                    }
                    Err(e) => return Err(e),
                }
            }
            for pid in ids.iter().take(BATCH) {
                let _ = rustix::process::waitpid(Some(*pid), WaitOptions::NOHANG);
            }
            // ECHILD is authoritative; an empty or incomplete proc snapshot is not.
            if ids.is_empty() && !incomplete {
                match rustix::process::wait(WaitOptions::NOHANG) {
                    Err(Errno::CHILD) => return Ok(()),
                    Ok(_) | Err(Errno::INTR) => {}
                    Err(e) => return Err(e.into()),
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }
}
impl State {
    fn ids(&mut self) -> std::io::Result<Vec<Pid>> {
        match ids() {
            Err(e) if e.raw_os_error() == Some(Errno::MFILE.raw_os_error()) => {
                self.reserve.clear();
                ids()
            }
            result => result,
        }
    }
    fn signal(&mut self, pid: Pid) -> std::io::Result<()> {
        let path = format!("/proc/{}", pid.as_raw_nonzero());
        let dir = match rustix::fs::open(
            &path,
            OFlags::PATH | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
        ) {
            Ok(d) => d,
            Err(Errno::NOENT | Errno::SRCH) => return Ok(()),
            Err(Errno::MFILE) => {
                self.reserve.clear();
                rustix::fs::open(
                    path,
                    OFlags::PATH | OFlags::DIRECTORY | OFlags::CLOEXEC,
                    Mode::empty(),
                )?
            }
            Err(e) => return Err(e.into()),
        };
        let before = match identity(&dir) {
            Ok(i) => i,
            Err(e) if e.raw_os_error() == Some(Errno::MFILE.raw_os_error()) => {
                self.reserve.clear();
                identity(&dir)?
            }
            Err(e) if matches!(e.raw_os_error(), Some(2 | 3)) => return Ok(()),
            Err(e) => return Err(e),
        };
        if before.0 != rustix::process::getpid().as_raw_nonzero().get() {
            return Ok(());
        }
        let fd = match rustix::process::pidfd_open(pid, rustix::process::PidfdFlags::empty()) {
            Ok(fd) => Some(fd),
            Err(Errno::SRCH) => return Ok(()),
            Err(Errno::MFILE) => {
                self.reserve.clear();
                None
            }
            Err(e) => return Err(e.into()),
        };
        let after = identity(&dir);
        let after = match after {
            Ok(i) => i,
            Err(e) if e.raw_os_error() == Some(Errno::MFILE.raw_os_error()) => {
                // Release the pidfd before the identity re-check if only two slots remain.
                drop(fd);
                self.reserve.clear();
                return self.pid_fallback(pid, &dir, before);
            }
            Err(e) if matches!(e.raw_os_error(), Some(2 | 3)) => return Ok(()),
            Err(e) => return Err(e),
        };
        if before != after {
            return Ok(());
        }
        let result = if let Some(fd) = fd {
            rustix::process::pidfd_send_signal(fd, Signal::KILL)
        } else {
            rustix::process::kill_process(pid, Signal::KILL)
        };
        match result {
            Ok(()) | Err(Errno::SRCH) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
    fn pid_fallback(&mut self, pid: Pid, dir: &OwnedFd, before: (i32, u64)) -> std::io::Result<()> {
        if identity(dir)? != before {
            return Ok(());
        }
        // The pinned proc object has the same parent and start time. Holding the reaper
        // lock prevents this child from being reaped and its numeric PID being reused.
        match rustix::process::kill_process(pid, Signal::KILL) {
            Ok(()) | Err(Errno::SRCH) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}
fn identity(dir: &OwnedFd) -> std::io::Result<(i32, u64)> {
    let fd = rustix::fs::openat(dir, "stat", OFlags::RDONLY | OFlags::CLOEXEC, Mode::empty())?;
    let mut text = String::new();
    std::fs::File::from(fd).read_to_string(&mut text)?;
    let fields: Vec<&str> = text
        .rsplit_once(") ")
        .ok_or_else(|| std::io::Error::other("invalid proc stat"))?
        .1
        .split_whitespace()
        .collect();
    let parent = fields
        .get(1)
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| std::io::Error::other("invalid parent"))?;
    let start = fields
        .get(19)
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| std::io::Error::other("invalid start time"))?;
    Ok((parent, start))
}
fn ids() -> std::io::Result<Vec<Pid>> {
    let mut out = Vec::new();
    for task in std::fs::read_dir("/proc/self/task")? {
        let text = match std::fs::read_to_string(task?.path().join("children")) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        };
        for raw in text.split_whitespace() {
            if let Some(pid) = Pid::from_raw(raw.parse().map_err(std::io::Error::other)?) {
                out.push(pid);
            }
        }
    }
    Ok(out)
}
