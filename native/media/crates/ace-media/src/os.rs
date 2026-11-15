// SPDX-License-Identifier: Apache-2.0
//! The process-level OS calls: no core dumps, die with the parent (Linux), and the CPU time
//! and resident memory `pong.stats` reports.
#![allow(unsafe_code)]

/// Turns core dumps off before any secret arrives. On Linux it also makes the process
/// undumpable, which stops same-user `ptrace`, and asks for SIGKILL when the daemon dies.
pub fn harden() {
    #[cfg(unix)]
    {
        let none = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        // SAFETY: setrlimit reads one valid struct.
        unsafe {
            libc::setrlimit(libc::RLIMIT_CORE, &none);
        }
    }
    #[cfg(target_os = "linux")]
    // SAFETY: plain prctl options with integer arguments.
    unsafe {
        libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0);
        libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0);
    }
}

/// Refuses a runtime directory another user could reach: it must be a real directory (not a
/// symlink), owned by this process's user, with mode 0700.
#[cfg(unix)]
pub fn private_dir(path: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::symlink_metadata(path).map_err(|e| format!("runtime dir: {e}"))?;
    if !meta.file_type().is_dir() {
        return Err("runtime dir is not a directory".into());
    }
    // SAFETY: geteuid has no preconditions.
    let user = unsafe { libc::geteuid() };
    if meta.uid() != user {
        return Err("runtime dir is owned by another user".into());
    }
    if meta.mode() & 0o777 != 0o700 {
        return Err(format!(
            "runtime dir mode is {:o}, not 700",
            meta.mode() & 0o777
        ));
    }
    Ok(())
}

/// While held, new files and sockets are created owner-read-write only, so a socket is never
/// reachable by anyone else between `bind` and a later `chmod`.
#[cfg(unix)]
pub struct PrivateUmask(libc::mode_t);

#[cfg(unix)]
impl PrivateUmask {
    pub fn set() -> Self {
        // SAFETY: umask has no preconditions; ace-media sets it only around its binds at start.
        Self(unsafe { libc::umask(0o177) })
    }
}

#[cfg(unix)]
impl Drop for PrivateUmask {
    fn drop(&mut self) {
        // SAFETY: as above.
        unsafe {
            libc::umask(self.0);
        }
    }
}

/// Whether core dumps are off for this process.
pub fn core_dumps_off() -> bool {
    #[cfg(unix)]
    {
        let mut limit = libc::rlimit {
            rlim_cur: 1,
            rlim_max: 1,
        };
        // SAFETY: getrlimit writes one valid struct.
        let ok = unsafe { libc::getrlimit(libc::RLIMIT_CORE, &mut limit) } == 0;
        ok && limit.rlim_cur == 0
    }
    #[cfg(not(unix))]
    {
        false
    }
}

/// User plus system CPU time of this process, in milliseconds.
pub fn cpu_ms() -> u64 {
    #[cfg(unix)]
    {
        // SAFETY: rusage is plain data; getrusage fills it.
        let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
        // SAFETY: a valid pointer to a live struct.
        if unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) } != 0 {
            return 0;
        }
        let ms = |t: libc::timeval| (t.tv_sec as u64) * 1000 + (t.tv_usec as u64) / 1000;
        ms(usage.ru_utime) + ms(usage.ru_stime)
    }
    #[cfg(not(unix))]
    {
        0
    }
}

/// Resident memory now, in bytes (0 where unknown).
pub fn rss_bytes() -> u64 {
    #[cfg(target_os = "macos")]
    {
        // SAFETY: proc_taskinfo is plain data; proc_pidinfo fills at most its size.
        let mut info: libc::proc_taskinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_taskinfo>() as libc::c_int;
        // SAFETY: the buffer is live and `size` bytes long.
        let got = unsafe {
            libc::proc_pidinfo(
                libc::getpid(),
                libc::PROC_PIDTASKINFO,
                0,
                (&mut info as *mut libc::proc_taskinfo).cast(),
                size,
            )
        };
        if got == size {
            info.pti_resident_size
        } else {
            0
        }
    }
    #[cfg(target_os = "linux")]
    {
        let pages = std::fs::read_to_string("/proc/self/statm")
            .ok()
            .and_then(|s| s.split_whitespace().nth(1)?.parse::<u64>().ok())
            .unwrap_or(0);
        // SAFETY: sysconf has no preconditions.
        let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
        pages * u64::try_from(page).unwrap_or(4096)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        0
    }
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    #[test]
    fn only_a_private_directory_of_this_user_is_accepted() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("am-private-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        if let Err(error) = std::fs::create_dir(&dir) {
            panic!("dir: {error}");
        }
        let mode = |m| std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(m));
        let _ = mode(0o755);
        assert!(super::private_dir(&dir).is_err(), "readable by others");
        let _ = mode(0o700);
        assert!(super::private_dir(&dir).is_ok());
        let link = dir.with_extension("link");
        let _ = std::fs::remove_file(&link);
        let _ = std::os::unix::fs::symlink(&dir, &link);
        assert!(super::private_dir(&link).is_err(), "a symlink");
        assert!(super::private_dir(&dir.join("missing")).is_err());
        let _ = std::fs::remove_file(&link);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hardening_turns_core_dumps_off() {
        super::harden();
        #[cfg(unix)]
        assert!(super::core_dumps_off());
    }
}
