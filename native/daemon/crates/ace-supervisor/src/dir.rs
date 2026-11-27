// SPDX-License-Identifier: Apache-2.0
//! Ending processes in an exclusive private directory: find them by current
//! directory, re-check the lease just before signalling, then wait until
//! `ps` reports each gone or a zombie. Ports `directory-processes.ts` step
//! for step: Linux reads `/proc/<pid>/cwd`, elsewhere one `lsof` listing;
//! a tool that cannot run fails the sweep. Only for exclusive operation
//! directories, never a user workspace.

use crate::errors::SupervisorError;

/// The most processes one pass inspects, and the most one pass ends.
pub const DIRECTORY_SCAN_LIMIT: usize = 16_384;
pub const DIRECTORY_KILL_LIMIT: usize = 64;

/// Which processes an `lsof` listing covers.
pub enum LsofSelection<'a> {
    /// Every process of this user.
    User(u32),
    /// Exactly these pids.
    Pids(&'a [u32]),
}

/// The kernel and tools the sweep reads, behind one seam.
pub trait DirectoryIo {
    /// Linux: the names in `/proc`, in directory order.
    fn proc_entries(&self) -> Result<Vec<String>, SupervisorError>;
    /// Linux: where `/proc/<pid>/cwd` points, if it can be read.
    fn proc_cwd(&self, pid: u32) -> Option<String>;
    /// `lsof -F0pn` output for `selection`; exit status 1 is empty.
    fn lsof(&self, selection: LsofSelection<'_>) -> Result<String, SupervisorError>;
    /// `ps -o stat=` output for `pids`; exit status 1 is empty.
    fn ps_states(&self, pids: &[u32]) -> Result<String, SupervisorError>;
    /// SIGKILL; a process already gone is not a failure.
    fn kill(&self, pid: u32) -> Result<(), SupervisorError>;
    /// This user's uid, for the lsof listing.
    fn uid(&self) -> u32;
    /// Lets other work run between polls, like `setImmediate`.
    fn yield_now(&self);
    /// Whether `/proc` is the source (Linux).
    fn linux(&self) -> bool;
    /// The directory relative roots resolve against.
    fn current_dir(&self) -> String;
}

/// A path's components after `path.resolve`: relative to `base`, with `.`,
/// `..` and repeated separators folded.
fn resolve(path: &str, base: &str) -> Vec<String> {
    let joined = if path.starts_with('/') {
        path.to_owned()
    } else {
        format!("{base}/{path}")
    };
    let mut parts: Vec<String> = Vec::new();
    for part in joined.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other.to_owned()),
        }
    }
    parts
}

/// Whether `cwd` is a root or inside one: `path.relative(root, cwd)` is
/// empty or descends, which on resolved paths is a component prefix.
fn within_lease(cwd: &str, roots: &[Vec<String>], base: &str) -> bool {
    let cwd = resolve(cwd, base);
    roots.iter().any(|root| cwd.starts_with(root))
}

fn inspection_limit() -> SupervisorError {
    SupervisorError::Limit("Process inspection exceeds limit".to_owned())
}

fn parse_pid(text: &str) -> Result<u32, SupervisorError> {
    text.parse::<u32>()
        .ok()
        .filter(|pid| *pid > 0)
        .ok_or_else(|| SupervisorError::InvalidInput(format!("bad pid {text}")))
}

/// Pids whose cwd is in `roots`, at most 64; with `selected`, only those.
fn directory_pids<I: DirectoryIo>(
    io: &I,
    roots: &[Vec<String>],
    selected: Option<&[u32]>,
) -> Result<Vec<u32>, SupervisorError> {
    let base = io.current_dir();
    if io.linux() {
        if let Some(selected) = selected {
            return Ok(selected
                .iter()
                .copied()
                .filter(|pid| {
                    io.proc_cwd(*pid)
                        .is_some_and(|cwd| within_lease(&cwd, roots, &base))
                })
                .collect());
        }
        let mut found = Vec::new();
        let mut count = 0usize;
        for name in io.proc_entries()? {
            if name.is_empty() || !name.bytes().all(|byte| byte.is_ascii_digit()) {
                continue;
            }
            count += 1;
            if count > DIRECTORY_SCAN_LIMIT {
                return Err(inspection_limit());
            }
            let Ok(pid) = name.parse::<u32>() else {
                continue;
            };
            if io
                .proc_cwd(pid)
                .is_some_and(|cwd| within_lease(&cwd, roots, &base))
            {
                found.push(parse_pid(&name)?);
            }
            if found.len() == DIRECTORY_KILL_LIMIT {
                break;
            }
        }
        return Ok(found);
    }
    let listing = match selected {
        Some(pids) => io.lsof(LsofSelection::Pids(pids))?,
        None => io.lsof(LsofSelection::User(io.uid()))?,
    };
    let mut found = Vec::new();
    let mut pid: Option<u32> = None;
    let mut count = 0usize;
    for record in listing.split('\0') {
        let field = record.strip_prefix('\n').unwrap_or(record);
        if let Some(number) = field.strip_prefix('p') {
            count += 1;
            if count > DIRECTORY_SCAN_LIMIT {
                return Err(inspection_limit());
            }
            pid = Some(parse_pid(number)?);
        } else if let (Some(cwd), Some(current)) = (field.strip_prefix('n'), pid)
            && within_lease(cwd, roots, &base)
        {
            found.push(current);
            if found.len() == DIRECTORY_KILL_LIMIT {
                break;
            }
        }
    }
    Ok(found)
}

/// Ends everything in `directories`: re-checks the lease before
/// signalling, then waits until `ps` reports each gone or a zombie. Never
/// ends `self_pid`.
pub fn terminate_directory_processes<I: DirectoryIo>(
    io: &I,
    directories: &[String],
    self_pid: u32,
) -> Result<(), SupervisorError> {
    let base = io.current_dir();
    let roots: Vec<Vec<String>> = directories
        .iter()
        .map(|directory| resolve(directory, &base))
        .collect();
    for _ in 0..64 {
        let selected: Vec<u32> = directory_pids(io, &roots, None)?
            .into_iter()
            .filter(|pid| *pid != self_pid)
            .collect();
        if selected.is_empty() {
            return Ok(());
        }
        let confirmed = directory_pids(io, &roots, Some(&selected))?;
        let pids: Vec<u32> = selected
            .iter()
            .copied()
            .filter(|pid| confirmed.contains(pid))
            .collect();
        for pid in &pids {
            io.kill(*pid)?;
        }
        if pids.is_empty() {
            return Ok(());
        }
        // ps reports zombie state without waiting on the OS orphan reaper.
        for attempt in 0..64 {
            let states = io.ps_states(&pids)?;
            if states.split('\n').all(|state| {
                let state = state.trim();
                state.is_empty() || state.starts_with('Z')
            }) {
                break;
            }
            if attempt == 63 {
                return Err(SupervisorError::Operation(
                    "Owned processes did not terminate".to_owned(),
                ));
            }
            io.yield_now();
        }
    }
    Err(SupervisorError::Limit("Owned process limit".to_owned()))
}

/// The real kernel and tools.
pub struct SystemDirectoryIo;

/// How long a tool may run and how much it may print, as `execFile` bounds it.
struct Bounds {
    max_bytes: usize,
    timeout: std::time::Duration,
}

/// Runs `program`; `Ok(None)` on exit status 1, an error for any other
/// failure (it cannot start, prints too much, runs too long, or fails).
fn run_bounded(
    program: &str,
    args: &[String],
    bounds: &Bounds,
) -> Result<Option<String>, SupervisorError> {
    use std::io::Read as _;
    let failed = |what: String| SupervisorError::Operation(format!("{program} {what}"));
    let mut child = std::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|error| failed(format!("failed: {error}")))?;
    let Some(mut stdout) = child.stdout.take() else {
        return Err(failed("has no output".to_owned()));
    };
    let limit = bounds.max_bytes;
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        let read = (&mut stdout)
            .take(u64::try_from(limit).unwrap_or(u64::MAX).saturating_add(1))
            .read_to_end(&mut out);
        (read.is_ok(), out)
    });
    let deadline = std::time::Instant::now() + bounds.timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(failed("timed out".to_owned()));
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(5)),
            Err(error) => return Err(failed(format!("failed: {error}"))),
        }
    };
    let (read, out) = reader
        .join()
        .map_err(|_| failed("output reader failed".to_owned()))?;
    if !read {
        return Err(failed("output unreadable".to_owned()));
    }
    if out.len() > bounds.max_bytes {
        return Err(failed("output exceeds its limit".to_owned()));
    }
    if status.success() {
        return Ok(Some(String::from_utf8_lossy(&out).into_owned()));
    }
    if status.code() == Some(1) {
        return Ok(None);
    }
    Err(failed(format!("exited with {status}")))
}

fn joined(pids: &[u32]) -> String {
    pids.iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",")
}

impl DirectoryIo for SystemDirectoryIo {
    fn proc_entries(&self) -> Result<Vec<String>, SupervisorError> {
        let entries = std::fs::read_dir("/proc")
            .map_err(|error| SupervisorError::Operation(format!("/proc: {error}")))?;
        Ok(entries
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect())
    }

    fn proc_cwd(&self, pid: u32) -> Option<String> {
        std::fs::read_link(format!("/proc/{pid}/cwd"))
            .ok()
            .map(|path| path.to_string_lossy().into_owned())
    }

    fn lsof(&self, selection: LsofSelection<'_>) -> Result<String, SupervisorError> {
        let mut args: Vec<String> = ["-n", "-P", "-a"].map(str::to_owned).to_vec();
        match selection {
            LsofSelection::Pids(pids) => args.extend(["-p".to_owned(), joined(pids)]),
            LsofSelection::User(uid) => args.extend(["-u".to_owned(), uid.to_string()]),
        }
        args.extend(["-d", "cwd", "-F0pn"].map(str::to_owned));
        let bounds = Bounds {
            max_bytes: 2 * 1024 * 1024,
            timeout: std::time::Duration::from_secs(30),
        };
        Ok(run_bounded("/usr/sbin/lsof", &args, &bounds)?.unwrap_or_default())
    }

    fn ps_states(&self, pids: &[u32]) -> Result<String, SupervisorError> {
        let args = [
            "-p".to_owned(),
            joined(pids),
            "-o".to_owned(),
            "stat=".to_owned(),
        ];
        let bounds = Bounds {
            max_bytes: 8192,
            timeout: std::time::Duration::from_secs(5),
        };
        Ok(run_bounded("ps", &args, &bounds)?.unwrap_or_default())
    }

    #[cfg(unix)]
    fn kill(&self, pid: u32) -> Result<(), SupervisorError> {
        let Some(target) = i32::try_from(pid)
            .ok()
            .and_then(rustix::process::Pid::from_raw)
        else {
            return Err(SupervisorError::InvalidInput(format!("bad pid {pid}")));
        };
        match rustix::process::kill_process(target, rustix::process::Signal::KILL) {
            Ok(()) => Ok(()),
            Err(rustix::io::Errno::SRCH) => Ok(()),
            Err(error) => Err(SupervisorError::Operation(format!(
                "signal of {pid} failed: {error}"
            ))),
        }
    }

    #[cfg(not(unix))]
    fn kill(&self, pid: u32) -> Result<(), SupervisorError> {
        Err(SupervisorError::Unavailable(format!(
            "directory sweeps need POSIX signals ({pid})"
        )))
    }

    fn uid(&self) -> u32 {
        #[cfg(unix)]
        {
            rustix::process::getuid().as_raw()
        }
        #[cfg(not(unix))]
        {
            0
        }
    }

    fn yield_now(&self) {
        std::thread::yield_now();
    }

    fn linux(&self) -> bool {
        cfg!(target_os = "linux")
    }

    fn current_dir(&self) -> String {
        std::env::current_dir()
            .map(|dir| dir.to_string_lossy().into_owned())
            .unwrap_or_else(|_| "/".to_owned())
    }
}
