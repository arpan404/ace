// SPDX-License-Identifier: Apache-2.0

//! What the machine is doing, and what a measured process cost, on Linux and macOS.
//!
//! Linux answers from `/proc` and `wait4`; macOS from `sysctl` and `vm_stat`. A reading the
//! platform cannot give is `None`, and the report says so instead of guessing.

use std::process::{Child, Command, ExitStatus};
use std::time::Duration;

/// CPU time and peak resident memory of one process.
#[derive(Clone, Copy, Debug)]
pub struct Usage {
    /// User plus system CPU.
    pub cpu: Duration,
    /// Peak resident bytes.
    pub peak_rss: u64,
}

/// The 1, 5 and 15 minute load averages, space separated.
pub fn load_average() -> String {
    if cfg!(target_os = "linux") {
        return match std::fs::read_to_string("/proc/loadavg") {
            Ok(text) => text
                .split_whitespace()
                .take(3)
                .collect::<Vec<_>>()
                .join(" "),
            Err(error) => format!("unknown: {error}"),
        };
    }
    match Command::new("sysctl").args(["-n", "vm.loadavg"]).output() {
        Ok(output) if output.status.success() => String::from_utf8_lossy(&output.stdout)
            .trim()
            .trim_start_matches('{')
            .trim_end_matches('}')
            .trim()
            .to_owned(),
        Ok(_) => "unknown".to_owned(),
        Err(error) => format!("unknown: {error}"),
    }
}

/// The CPU's name and how many cores the process may use.
pub fn machine() -> String {
    let cpu = if cfg!(target_os = "linux") {
        std::fs::read_to_string("/proc/cpuinfo")
            .ok()
            .and_then(|text| {
                text.lines()
                    .find_map(|line| line.strip_prefix("model name"))
                    .and_then(|rest| rest.split_once(':'))
                    .map(|(_, name)| name.trim().to_owned())
            })
            .unwrap_or_default()
    } else {
        Command::new("sysctl")
            .args(["-n", "machdep.cpu.brand_string"])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
            .unwrap_or_default()
    };
    let cores = std::thread::available_parallelism()
        .map(|cores| cores.get())
        .unwrap_or(0);
    if cpu.is_empty() {
        format!("{cores} cores")
    } else {
        format!("{cpu}, {cores} cores")
    }
}

/// Free and inactive memory, the two numbers that say whether the OS has cache to spare.
pub fn memory() -> String {
    match memory_mib() {
        Some((free, inactive)) => format!("{free} MiB free, {inactive} MiB inactive"),
        None => "unknown".to_owned(),
    }
}

/// Free and inactive memory in MiB: `/proc/meminfo` on Linux, `vm_stat`'s pages on macOS.
fn memory_mib() -> Option<(u64, u64)> {
    if cfg!(target_os = "linux") {
        let text = std::fs::read_to_string("/proc/meminfo").ok()?;
        let kib = |label: &str| {
            text.lines()
                .find_map(|line| line.strip_prefix(label))
                .and_then(|rest| {
                    rest.trim()
                        .trim_end_matches("kB")
                        .trim()
                        .parse::<u64>()
                        .ok()
                })
        };
        return Some((kib("MemFree:")? / 1024, kib("Inactive:")? / 1024));
    }
    let page = sysctl_number("hw.pagesize")?;
    let output = Command::new("vm_stat").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut free = None;
    let mut inactive = None;
    for line in text.lines() {
        let Some((label, value)) = line.split_once(':') else {
            continue;
        };
        let Ok(pages) = value.trim().trim_end_matches('.').parse::<u64>() else {
            continue;
        };
        match label.trim() {
            "Pages free" => free = Some(pages.saturating_mul(page) / (1024 * 1024)),
            "Pages inactive" => inactive = Some(pages.saturating_mul(page) / (1024 * 1024)),
            _ => {}
        }
    }
    Some((free?, inactive?))
}

/// One integer from `sysctl`.
fn sysctl_number(name: &str) -> Option<u64> {
    let output = Command::new("sysctl").args(["-n", name]).output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
}

/// A running process's resident bytes now, from `/proc/<pid>/status` (`VmRSS`). Linux only.
pub fn resident_bytes(pid: u32) -> Option<u64> {
    status_kib(pid, "VmRSS:").map(|kib| kib * 1024)
}

/// A running process's CPU so far and its peak resident bytes (`VmHWM`). Linux only.
pub fn process_usage(pid: u32) -> Option<Usage> {
    let peak_rss = status_kib(pid, "VmHWM:")? * 1024;
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // The command name is in parentheses and may hold spaces; the fields after it are fixed.
    let (_, fields) = stat.rsplit_once(')')?;
    let fields: Vec<&str> = fields.split_whitespace().collect();
    // utime and stime are fields 14 and 15 of the line, the 12th and 13th after the name.
    let ticks: u64 = fields.get(11)?.parse::<u64>().ok()? + fields.get(12)?.parse::<u64>().ok()?;
    let per_second = clock_ticks()?;
    Some(Usage {
        cpu: Duration::from_secs_f64(ticks as f64 / per_second as f64),
        peak_rss,
    })
}

fn status_kib(pid: u32, label: &str) -> Option<u64> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    let text = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    text.lines()
        .find_map(|line| line.strip_prefix(label))
        .and_then(|rest| rest.trim().trim_end_matches("kB").trim().parse().ok())
}

/// The kernel's clock ticks per second, the unit of `/proc/<pid>/stat`'s CPU times.
#[cfg(target_os = "linux")]
#[allow(unsafe_code)]
fn clock_ticks() -> Option<u64> {
    // SAFETY: `sysconf` reads a constant of the running system and touches no memory of ours.
    let ticks = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    u64::try_from(ticks).ok().filter(|ticks| *ticks > 0)
}

#[cfg(not(target_os = "linux"))]
fn clock_ticks() -> Option<u64> {
    None
}

/// Waits for `child` and returns its exit status with what it cost, which Linux's `wait4` reports
/// as it reaps the process. Elsewhere the usage is `None` and the caller measures another way.
#[cfg(target_os = "linux")]
#[allow(unsafe_code)]
pub fn wait_measured(child: &mut Child) -> std::io::Result<(ExitStatus, Option<Usage>)> {
    use std::os::unix::process::ExitStatusExt;

    let pid = libc::pid_t::try_from(child.id()).map_err(std::io::Error::other)?;
    let mut status: libc::c_int = 0;
    // SAFETY: `rusage` is plain old data, for which all zero bytes is a valid value.
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    loop {
        // SAFETY: both pointers name live locals of the right types for the whole call.
        let reaped = unsafe { libc::wait4(pid, &mut status, 0, &mut usage) };
        if reaped == pid {
            break;
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
    let time = |value: libc::timeval| {
        Duration::from_secs(u64::try_from(value.tv_sec).unwrap_or(0))
            + Duration::from_micros(u64::try_from(value.tv_usec).unwrap_or(0))
    };
    let used = Usage {
        cpu: time(usage.ru_utime) + time(usage.ru_stime),
        // Linux reports the peak in KiB.
        peak_rss: u64::try_from(usage.ru_maxrss).unwrap_or(0) * 1024,
    };
    Ok((ExitStatus::from_raw(status), Some(used)))
}

#[cfg(not(target_os = "linux"))]
pub fn wait_measured(child: &mut Child) -> std::io::Result<(ExitStatus, Option<Usage>)> {
    Ok((child.wait()?, None))
}
