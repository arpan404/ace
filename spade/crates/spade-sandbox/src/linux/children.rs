//! Owned children only. A pinned proc directory and pidfd prevent PID-reuse races.
use rustix::process::{Pid, Signal, WaitId, WaitIdOptions, WaitOptions};
use std::collections::HashSet;
use std::io::Read;
use std::os::fd::OwnedFd;

fn owned() -> std::io::Result<Vec<(Pid, OwnedFd)>> {
    let mut ids = HashSet::new();
    for task in std::fs::read_dir("/proc/self/task")? {
        let path = task?.path().join("children");
        let text = match std::fs::read_to_string(path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        };
        for id in text.split_whitespace() {
            let raw = id.parse::<i32>().map_err(std::io::Error::other)?;
            if let Some(pid) = Pid::from_raw(raw) {
                ids.insert(pid);
            }
        }
    }
    let mut out = Vec::new();
    for pid in ids {
        let Ok(dir) = rustix::fs::open(
            format!("/proc/{}", pid.as_raw_nonzero()),
            rustix::fs::OFlags::PATH | rustix::fs::OFlags::DIRECTORY | rustix::fs::OFlags::CLOEXEC,
            rustix::fs::Mode::empty(),
        ) else {
            continue;
        };
        let Ok(fd) = rustix::process::pidfd_open(pid, rustix::process::PidfdFlags::empty()) else {
            continue;
        };
        let Ok(status) = rustix::fs::openat(
            &dir,
            "status",
            rustix::fs::OFlags::RDONLY | rustix::fs::OFlags::CLOEXEC,
            rustix::fs::Mode::empty(),
        ) else {
            continue;
        };
        let mut text = String::new();
        std::fs::File::from(status).read_to_string(&mut text)?;
        let parent = text
            .lines()
            .find_map(|l| l.strip_prefix("PPid:"))
            .and_then(|v| v.trim().parse::<i32>().ok());
        if parent == Some(rustix::process::getpid().as_raw_nonzero().get()) {
            out.push((pid, fd));
        }
    }
    Ok(out)
}

pub fn kill() -> std::io::Result<()> {
    for (_, fd) in owned()? {
        match rustix::process::pidfd_send_signal(fd, Signal::KILL) {
            Ok(()) | Err(rustix::io::Errno::SRCH) => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

pub fn reap_orphans(root: Pid) {
    if let Ok(children) = owned() {
        for (pid, fd) in children {
            if pid != root {
                let _ = rustix::process::waitid(
                    WaitId::PidFd(fd.as_fd()),
                    WaitIdOptions::EXITED | WaitIdOptions::NOHANG,
                );
            }
        }
    }
}

pub fn finish() -> std::io::Result<()> {
    loop {
        // Killing a parent reparents its detached children to this subreaper. Repeat until
        // the kernel reports no children, including zombies, rather than trusting a snapshot.
        kill()?;
        match rustix::process::wait(WaitOptions::empty()) {
            Ok(_) | Err(rustix::io::Errno::INTR) => {}
            Err(rustix::io::Errno::CHILD) => return Ok(()),
            Err(e) => return Err(e.into()),
        }
    }
}
use std::os::fd::AsFd;
