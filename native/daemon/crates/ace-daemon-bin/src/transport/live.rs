// SPDX-License-Identifier: Apache-2.0
//! The socket cap, the pre-authentication budgets and the live sockets: what
//! every listener in this process shares (`server.ts:324`,
//! `socket-admission.ts:19`).

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use ace_transport::SocketHandle;
use tokio::sync::Notify;

/// `server.ts:324`: at most 256 sockets, in-flight upgrades included.
const MAX_SOCKETS: usize = 256;
/// `socket-admission.ts:19`–`:24`: unauthenticated budgets.
const LOCAL_PRE_AUTH: usize = 128;
const REMOTE_PRE_AUTH: usize = 64;
const PER_ADDRESS: usize = 16;

/// A listener's role, which decides the Origin rule and the pre-auth budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Kind {
    Local,
    Remote,
}

/// An accepted upgrade that has not opened its socket or been released.
#[derive(Debug, Clone, Copy)]
pub(super) struct Held {
    kind: Kind,
    address: IpAddr,
}

/// A socket whose `101` is on the wire, before its session ends.
struct Open {
    handle: SocketHandle,
    kind: Kind,
    address: IpAddr,
    /// Its pre-authentication slot was released when its hello authenticated.
    authenticated: bool,
}

/// What all this process's listeners share: the cap, the pre-authentication
/// budgets and the live sockets a shutdown closes.
pub(super) struct Live {
    next: AtomicU64,
    open: AtomicUsize,
    held: AtomicUsize,
    local_pending: AtomicUsize,
    remote_pending: AtomicUsize,
    addresses: Mutex<HashMap<IpAddr, usize>>,
    held_map: Mutex<HashMap<u64, Held>>,
    sockets: Mutex<HashMap<u64, Open>>,
    quiet: Notify,
}

impl Live {
    pub(super) fn new() -> Self {
        Self {
            next: AtomicU64::new(1),
            open: AtomicUsize::new(0),
            held: AtomicUsize::new(0),
            local_pending: AtomicUsize::new(0),
            remote_pending: AtomicUsize::new(0),
            addresses: Mutex::new(HashMap::new()),
            held_map: Mutex::new(HashMap::new()),
            sockets: Mutex::new(HashMap::new()),
            quiet: Notify::new(),
        }
    }

    pub(super) fn full(&self) -> bool {
        self.open.load(Ordering::Acquire) + self.held.load(Ordering::Acquire) >= MAX_SOCKETS
    }

    pub(super) fn budget(&self, kind: Kind, address: IpAddr) -> bool {
        match kind {
            Kind::Local => self.local_pending.load(Ordering::Acquire) < LOCAL_PRE_AUTH,
            Kind::Remote => {
                self.remote_pending.load(Ordering::Acquire) < REMOTE_PRE_AUTH
                    && *locked(&self.addresses).get(&address).unwrap_or(&0) < PER_ADDRESS
            }
        }
    }

    /// Reserve a socket's place before its handshake finishes.
    pub(super) fn reserve(&self, kind: Kind, address: IpAddr) -> Option<u64> {
        if self.full() || !self.budget(kind, address) {
            return None;
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        match kind {
            Kind::Local => {
                self.local_pending.fetch_add(1, Ordering::Relaxed);
            }
            Kind::Remote => {
                self.remote_pending.fetch_add(1, Ordering::Relaxed);
                *locked(&self.addresses).entry(address).or_insert(0) += 1;
            }
        }
        self.held.fetch_add(1, Ordering::Relaxed);
        locked(&self.held_map).insert(id, Held { kind, address });
        Some(id)
    }

    pub(super) fn is_held(&self, id: u64) -> bool {
        locked(&self.held_map).contains_key(&id)
    }

    /// Release one reservation: a refused, abandoned or failed upgrade.
    pub(super) fn release(&self, id: u64) {
        if let Some(held) = locked(&self.held_map).remove(&id) {
            self.debit_pending(held.kind, held.address);
            self.held.fetch_sub(1, Ordering::Relaxed);
            self.quiet.notify_one();
        }
    }

    /// An upgrade's `101` is on the wire: its socket is live and holds its
    /// pre-authentication slot until it closes.
    pub(super) fn opened(&self, id: u64, handle: SocketHandle) {
        if let Some(held) = locked(&self.held_map).remove(&id) {
            self.held.fetch_sub(1, Ordering::Relaxed);
            self.open.fetch_add(1, Ordering::Relaxed);
            locked(&self.sockets).insert(
                id,
                Open {
                    handle,
                    kind: held.kind,
                    address: held.address,
                    authenticated: false,
                },
            );
        }
    }

    pub(super) fn closed(&self, id: u64) {
        if let Some(open) = locked(&self.sockets).remove(&id) {
            self.open.fetch_sub(1, Ordering::Relaxed);
            // An authenticated socket left the pre-authentication budget then.
            if !open.authenticated {
                self.debit_pending(open.kind, open.address);
            }
            self.quiet.notify_one();
        }
    }

    /// The socket's hello authenticated: release its pre-authentication slot and
    /// keep it live (`PreAuthAdmission.track`). Idempotent, so a retried hello
    /// cannot debit the budget twice.
    pub(super) fn authenticated(&self, id: u64) {
        let mut sockets = locked(&self.sockets);
        if let Some(open) = sockets.get_mut(&id)
            && !open.authenticated
        {
            open.authenticated = true;
            let (kind, address) = (open.kind, open.address);
            drop(sockets);
            self.debit_pending(kind, address);
        }
    }

    pub(super) fn debit_pending(&self, kind: Kind, address: IpAddr) {
        match kind {
            Kind::Local => {
                self.local_pending.fetch_sub(1, Ordering::Relaxed);
            }
            Kind::Remote => {
                self.remote_pending.fetch_sub(1, Ordering::Relaxed);
                let mut addresses = locked(&self.addresses);
                if let Some(count) = addresses.get_mut(&address) {
                    *count = count.saturating_sub(1);
                    if *count == 0 {
                        addresses.remove(&address);
                    }
                }
            }
        }
    }

    /// Close every live socket with `1001 Daemon shutdown`, as the TypeScript
    /// server does, then wait until they report closed or the deadline passes.
    pub(super) async fn shutdown(&self, deadline: Duration) {
        let handles: Vec<SocketHandle> = locked(&self.sockets)
            .values()
            .map(|open| open.handle.clone())
            .collect();
        for handle in handles {
            let _ = handle.close(Some(1001), "Daemon shutdown".to_owned());
        }
        let until = Instant::now() + deadline;
        loop {
            let waiting = self.quiet.notified();
            if locked(&self.sockets).is_empty() {
                return;
            }
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() || tokio::time::timeout(left, waiting).await.is_err() {
                return;
            }
        }
    }
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};

    fn address() -> IpAddr {
        IpAddr::V4(Ipv4Addr::LOCALHOST)
    }

    /// `socket-admission.ts`: an unauthenticated socket holds a slot until it
    /// authenticates, then the slot is free while the socket stays live; closing
    /// an authenticated socket does not debit the budget a second time.
    #[tokio::test]
    async fn authenticating_releases_the_slots_and_closing_an_authenticated_one_does_not() {
        let live = Live::new();
        let mut held = Vec::new();
        for _ in 0..LOCAL_PRE_AUTH {
            match live.reserve(Kind::Local, address()) {
                Some(id) => held.push(id),
                None => panic!("the budget admits {LOCAL_PRE_AUTH} unauthenticated sockets"),
            }
        }
        assert!(
            live.reserve(Kind::Local, address()).is_none(),
            "the budget is full"
        );
        // Opening keeps the slot; authenticating releases it.
        let first = held[0];
        let (handle, _events) = ace_transport::socket::open(Box::new(NoopIo), None, None);
        live.opened(first, handle);
        live.authenticated(first);
        let freed = live.reserve(Kind::Local, address());
        assert!(
            freed.is_some(),
            "an authenticated socket leaves the pre-auth budget"
        );
        // Closing it must not debit again: the pending count is the 128 held minus
        // the one that authenticated, plus the one just reserved.
        live.closed(first);
        // 128 held - 1 authenticated + the one just reserved.
        assert_eq!(live.local_pending.load(Ordering::Acquire), LOCAL_PRE_AUTH);
        if let Some(freed) = freed {
            live.release(freed);
        }
        for id in held.iter().skip(1) {
            live.release(*id);
        }
        assert_eq!(live.local_pending.load(Ordering::Acquire), 0);
    }

    /// The socket's I/O, which these cases never touch.
    struct NoopIo;

    impl tokio::io::AsyncRead for NoopIo {
        fn poll_read(
            self: std::pin::Pin<&mut Self>,
            _context: &mut std::task::Context<'_>,
            _buffer: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            std::task::Poll::Pending
        }
    }

    impl tokio::io::AsyncWrite for NoopIo {
        fn poll_write(
            self: std::pin::Pin<&mut Self>,
            _context: &mut std::task::Context<'_>,
            _buffer: &[u8],
        ) -> std::task::Poll<std::io::Result<usize>> {
            std::task::Poll::Pending
        }

        fn poll_flush(
            self: std::pin::Pin<&mut Self>,
            _context: &mut std::task::Context<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            std::task::Poll::Pending
        }

        fn poll_shutdown(
            self: std::pin::Pin<&mut Self>,
            _context: &mut std::task::Context<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            std::task::Poll::Pending
        }
    }
}
