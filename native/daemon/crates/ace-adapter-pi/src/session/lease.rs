// SPDX-License-Identifier: Apache-2.0
//! The daemon's MCP lease for one Pi session (`ctx.aceMcp`): capabilities and revocation it
//! already owns. `LeaseGuard` ends it on every exit path of an open, which the TypeScript does
//! with a `try`/`catch` and two `lease?.end()` calls (`session.ts:108`–`:122`).

use std::sync::Mutex;

/// One lease. Ending it twice is harmless: the revocation runs once.
pub struct PiLease {
    pub url: String,
    pub bearer: String,
    end: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
}

impl PiLease {
    pub fn new(url: String, bearer: String, end: impl Fn() + Send + Sync + 'static) -> Self {
        Self {
            url,
            bearer,
            end: Mutex::new(Some(Box::new(end))),
        }
    }

    /// Ends the lease, revoking its abilities; only the first call runs the revocation.
    pub fn end(&self) {
        let end = self
            .end
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        if let Some(end) = end {
            end();
        }
    }
}

/// Ends a lease unless it is handed over to a session. `open_pi_session` makes one before its
/// first fallible step, so a version refusal, a bad reference, a configuration error, an unknown
/// permission mode or a failed spawn all revoke the lease exactly as the TypeScript does.
#[derive(Default)]
pub struct LeaseGuard(Option<PiLease>);

impl LeaseGuard {
    pub fn new(lease: Option<PiLease>) -> Self {
        Self(lease)
    }

    /// The lease, for a session that now owns it. The guard stops ending it.
    pub fn take(&mut self) -> Option<PiLease> {
        self.0.take()
    }

    /// The lease, still the guard's: the constructor's inputs read it.
    pub fn peek(&self) -> Option<&PiLease> {
        self.0.as_ref()
    }
}

impl Drop for LeaseGuard {
    fn drop(&mut self) {
        if let Some(lease) = &self.0 {
            lease.end();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn a_dropped_guard_ends_its_lease_once() {
        let ends = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&ends);
        {
            let _guard = LeaseGuard::new(Some(PiLease::new(
                "http://127.0.0.1:1/mcp".to_owned(),
                "b".repeat(64),
                move || {
                    counter.fetch_add(1, Ordering::SeqCst);
                },
            )));
        }
        assert_eq!(ends.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_taken_lease_is_the_sessions_to_end() {
        let ends = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&ends);
        let lease = PiLease::new(
            "http://127.0.0.1:1/mcp".to_owned(),
            "b".repeat(64),
            move || {
                counter.fetch_add(1, Ordering::SeqCst);
            },
        );
        {
            let mut guard = LeaseGuard::new(Some(lease));
            let taken = guard.take().expect("lease");
            // The guard no longer ends it; the session does.
            drop(guard);
            assert_eq!(ends.load(Ordering::SeqCst), 0);
            taken.end();
            taken.end();
        }
        assert_eq!(ends.load(Ordering::SeqCst), 1);
    }
}
