// SPDX-License-Identifier: Apache-2.0
//! What one accepted connection knows about itself (T1b.2), shared by every
//! request it carries: the name the client asked for in its TLS handshake, and
//! whether a request on it has authenticated. Both cross the proxy hop as
//! reserved headers; neither is ever read from a client.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// One connection's state. The servername is fixed when the handshake ends;
/// `trusted` starts false and only ever goes true.
#[derive(Debug, Default)]
pub struct ConnState {
    servername: Option<String>,
    trusted: AtomicBool,
}

impl ConnState {
    /// A connection whose handshake asked for `servername` (lower case, no
    /// trailing dot: rustls normalises it). Loopback has none.
    pub fn new(servername: Option<String>) -> Self {
        Self {
            servername,
            trusted: AtomicBool::new(false),
        }
    }

    /// The name the client asked for, if any.
    pub fn servername(&self) -> Option<&str> {
        self.servername.as_deref()
    }

    /// Whether a request on this connection authenticated.
    pub fn trusted(&self) -> bool {
        self.trusted.load(Ordering::Acquire)
    }

    /// A request on this connection authenticated. It never goes back.
    pub fn mark_trusted(&self) {
        self.trusted.store(true, Ordering::Release);
    }
}

/// A connection's state, shared by its driver and the requests it runs.
pub type SharedConnState = Arc<ConnState>;

/// What a listener hands the driver: the stream and what the handshake learned
/// about the connection.
pub struct Accepted {
    pub io: Box<dyn crate::conn_io::ConnIo>,
    pub state: SharedConnState,
}

impl Accepted {
    /// A stream whose connection knows only `servername`.
    pub fn new(io: Box<dyn crate::conn_io::ConnIo>, servername: Option<String>) -> Self {
        Self {
            io,
            state: Arc::new(ConnState::new(servername)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trust_starts_false_and_only_ever_goes_true() {
        let state = ConnState::new(None);
        assert!(!state.trusted());
        state.mark_trusted();
        assert!(state.trusted());
        state.mark_trusted();
        assert!(state.trusted());
    }

    #[test]
    fn the_servername_is_what_the_handshake_learned() {
        assert_eq!(ConnState::new(None).servername(), None);
        assert_eq!(
            ConnState::new(Some("studio.tail1234.ts.net".to_owned())).servername(),
            Some("studio.tail1234.ts.net")
        );
    }
}
