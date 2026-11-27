// SPDX-License-Identifier: Apache-2.0
//! The core Git CLI service (`GitCli` in `packages/git/src/cli.ts`, G2a): one
//! instance per service, its binary, timeout, admission and shutdown. The
//! command itself runs in `core::execute`; capture decoding, Windows
//! rewriting and cancellation live beside it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use ace_json::Value;
use tokio::sync::Notify;

use crate::core::cancel::CallCancel;
use crate::core::deadline::validate_timeout_ms;
use crate::core::error::{GitError, GitErrorCode};
use crate::core::execute_types::CleanupRegistry;
use crate::core::job::StoppedJobs;
use crate::core::ports::ProcessPorts;

/// Maximum concurrent calls admitted by one `GitCliCore` instance.
pub const CALL_LIMIT: usize = 64;
/// Default stdout capture limit (64 MiB).
pub const DEFAULT_CAPTURE_BYTES: usize = 64 * 1024 * 1024;

/// Everything that moved keeps its old path for its callers.
pub use crate::core::capture::{patch_output, text_output};
pub use crate::core::execute_types::{
    CleanupEntry, ExecuteRawOptions, ExecuteRawOutput, StdinCommand, StopReason, StreamCallbacks,
};
pub use crate::core::hookless::{
    default_hooks_dir, windows_hookless_args, windows_hookless_env, windows_long_paths_env,
};

/// Configuration for [`GitCliCore`].
pub struct GitCliConfig {
    pub configured_binary: Option<String>,
    pub timeout_ms: Option<f64>,
}

/// Native core process runner backing `GitCli` (`cli.ts`).
pub struct GitCliCore {
    pub ports: Arc<ProcessPorts>,
    pub configured_binary: Option<String>,
    pub timeout_ms: u64,
    pub(crate) closed: AtomicBool,
    pub(crate) active_calls: AtomicUsize,
    pub(crate) active_zero: Notify,
    pub(crate) cancellations: Mutex<HashMap<u64, Arc<CallCancel>>>,
    pub(crate) next_call_id: AtomicU64,
    pub(crate) drains: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    pub cleanups: Arc<CleanupRegistry>,
    pub(crate) stopped_jobs: Arc<StoppedJobs>,
}

impl GitCliCore {
    pub fn new(config: GitCliConfig, ports: Arc<ProcessPorts>) -> Result<Self, GitError> {
        if let Some(ref bin) = config.configured_binary
            && (bin.is_empty() || bin.contains('\0'))
        {
            return Err(GitError::new(
                GitErrorCode::InvalidArgument,
                "gitBinary must name an executable",
            ));
        }
        let timeout_ms = validate_timeout_ms(config.timeout_ms)?;
        Ok(Self {
            ports,
            configured_binary: config.configured_binary,
            timeout_ms,
            closed: AtomicBool::new(false),
            active_calls: AtomicUsize::new(0),
            active_zero: Notify::new(),
            cancellations: Mutex::new(HashMap::new()),
            next_call_id: AtomicU64::new(1),
            drains: Mutex::new(Vec::new()),
            cleanups: Arc::new(CleanupRegistry::default()),
            stopped_jobs: Arc::new(StoppedJobs::new()),
        })
    }

    pub fn platform(&self) -> &str {
        &self.ports.platform
    }

    pub fn binary(&self) -> String {
        if let Some(ref bin) = self.configured_binary {
            return bin.clone();
        }
        "git".to_owned()
    }

    pub fn active_calls(&self) -> usize {
        self.active_calls.load(Ordering::Acquire)
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    pub fn register_cancel(&self) -> (u64, Arc<CallCancel>) {
        let id = self.next_call_id.fetch_add(1, Ordering::Relaxed);
        let cancel = CallCancel::new();
        if self.is_closed() {
            cancel.close();
        }
        if let Ok(mut map) = self.cancellations.lock() {
            map.insert(id, Arc::clone(&cancel));
        }
        (id, cancel)
    }

    pub fn abort_call(&self, call_id: u64) {
        if let Ok(map) = self.cancellations.lock()
            && let Some(cancel) = map.get(&call_id)
        {
            cancel.abort();
        }
    }

    pub(crate) fn unregister_cancel(&self, call_id: u64) {
        if let Ok(mut map) = self.cancellations.lock() {
            map.remove(&call_id);
        }
    }

    /// Cancellable pause using the injected timeout scheduler (`GitCli.pause`).
    pub async fn pause(&self, milliseconds: u64) -> Result<(), GitError> {
        if self.is_closed() {
            return Err(GitError::new(GitErrorCode::GitClosed, "Git service closed"));
        }
        let (call_id, cancel) = self.register_cancel();
        let done = Arc::new(AtomicBool::new(false));
        let timer_notify = Arc::new(Notify::new());
        let d = Arc::clone(&done);
        let n = Arc::clone(&timer_notify);
        let handle = self.ports.scheduler.schedule(
            milliseconds,
            Box::new(move || {
                d.store(true, Ordering::Release);
                n.notify_waiters();
            }),
        );
        let result = loop {
            // The timer registers before its flag is read, and `closed()`
            // registers before it reads the close flag, so neither wakeup is lost.
            let timer = timer_notify.notified();
            tokio::pin!(timer);
            timer.as_mut().enable();
            if cancel.is_closed() {
                break Err(GitError::new(GitErrorCode::GitClosed, "Git service closed"));
            }
            if done.load(Ordering::Acquire) {
                break Ok(());
            }
            tokio::select! {
                biased;
                _ = cancel.closed() => {}
                _ = &mut timer => {}
            }
        };
        handle.cancel();
        self.unregister_cancel(call_id);
        result
    }

    /// Bounded shutdown (`GitCli.close`): cancels every active call/pause and drains exits.
    pub async fn close(&self) {
        self.closed.store(true, Ordering::Release);
        let cancels: Vec<Arc<CallCancel>> = self
            .cancellations
            .lock()
            .map(|map| map.values().cloned().collect())
            .unwrap_or_default();
        for cancel in cancels {
            cancel.close();
        }
        while self.active_calls.load(Ordering::Acquire) > 0 {
            crate::core::wake::wait_until(
                || self.active_calls.load(Ordering::Acquire) == 0,
                &self.active_zero,
            )
            .await;
        }
        let drains: Vec<tokio::task::JoinHandle<()>> = self
            .drains
            .lock()
            .map(|mut vec| std::mem::take(&mut *vec))
            .unwrap_or_default();
        for handle in drains {
            let _ = handle.await;
        }
    }

    /// Execute one Git command directly (`GitCli.executeRaw`).
    pub fn job_alive(&self, pid: u32) -> bool {
        self.stopped_jobs.job_alive(pid)
    }
}

/// Resolves once the deadline or the work budget fired, registering before it
/// reads either flag so the wakeup is never lost.
pub fn verify_git_version(stdout: &[u8], binary: &str) -> Result<(), GitError> {
    let text = text_output(stdout)?;
    let rest = text.strip_prefix("git version ");
    let parsed = rest.and_then(|s| {
        let mut nums = s
            .split(|c: char| !c.is_ascii_digit())
            .filter(|part| !part.is_empty());
        let major: u32 = nums.next()?.parse().ok()?;
        let minor: u32 = nums.next()?.parse().ok()?;
        let _patch: u32 = nums.next()?.parse().ok()?;
        Some((major, minor))
    });
    match parsed {
        Some((major, minor)) if major > 2 || (major == 2 && minor >= 40) => Ok(()),
        _ => {
            let version = String::from_utf8_lossy(stdout).trim().to_owned();
            Err(
                GitError::new(GitErrorCode::GitTooOld, "ace requires Git 2.40 or newer")
                    .with_detail("binary", Value::from(binary))
                    .with_detail("version", Value::from(version.as_str())),
            )
        }
    }
}

/// Probe stub kept for compatibility with G0 callers.
pub fn probe(op: &str) -> Result<(), crate::error::Error> {
    Err(crate::error::Error::unimplemented("core::cli", op))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_output_rejects_invalid_utf8_and_strips_single_newline() {
        assert_eq!(text_output(b"abc\n").ok().as_deref(), Some("abc"));
        assert_eq!(text_output(b"abc\n\n").ok().as_deref(), Some("abc\n"));
        assert!(matches!(
            text_output(&[0xff, 0xfe]),
            Err(GitError {
                code: GitErrorCode::MalformedOutput,
                ..
            })
        ));
    }

    #[test]
    fn patch_output_drops_incomplete_utf8_only_when_truncated() {
        let bytes = [b'a', 0xe2, 0x82];
        assert_eq!(patch_output(&bytes, true), "a");
        assert_eq!(patch_output(&bytes, false), "a\u{FFFD}");
    }

    #[test]
    fn verify_git_version_checks_minimum_2_40() {
        assert!(verify_git_version(b"git version 2.40.0\n", "git").is_ok());
        assert!(verify_git_version(b"git version 2.48.1 (Apple Git-155)\n", "git").is_ok());
        assert!(matches!(
            verify_git_version(b"git version 2.39.5\n", "git"),
            Err(GitError {
                code: GitErrorCode::GitTooOld,
                ..
            })
        ));
    }
}
