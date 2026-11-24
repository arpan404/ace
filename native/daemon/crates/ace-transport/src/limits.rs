// SPDX-License-Identifier: Apache-2.0
//! A listener's connection timers, as data (T1b.1a). T1a's driver constants
//! become a [`ConnectionLimits`] the caller chooses, so the loopback listener
//! keeps its numbers unchanged while the two remote listeners read theirs from
//! `apps/daemon/src/sni-listener.ts` and `node:https`'s defaults.

use std::time::Duration;

use crate::prefixed::WRITE_TIMEOUT;

/// The timers of one listener's connections.
#[derive(Debug, Clone)]
pub struct ConnectionLimits {
    /// TLS only, from accept to the handshake's end; None on loopback.
    pub handshake: Option<Duration>,
    /// From accept (or the handshake's end) to the first request head.
    pub first_head: Duration,
    /// A later head, from its first byte; None: only the idle timer bounds it.
    pub head: Option<Duration>,
    /// Idle, with no request in flight, not trusted.
    pub keep_alive: Duration,
    /// Idle, with no request in flight, after a request on the connection
    /// authenticated. None: the trust marker is ignored (the static listener).
    pub trusted_keep_alive: Option<Duration>,
    /// The whole exchange, from its first byte to the answer's last; None is
    /// Node's `requestTimeout: 0`, no limit.
    pub exchange: Option<Duration>,
    /// The bound on a `101` or a refusal, written straight to the socket.
    pub upgrade_write: Duration,
}

impl ConnectionLimits {
    /// T1a's loopback numbers, unchanged: the 60 s head deadline, the 5 s
    /// keep-alive, the 300 s request timeout and the 5 s write timeout.
    pub fn loopback() -> Self {
        Self {
            handshake: None,
            first_head: Duration::from_secs(60),
            head: Some(Duration::from_secs(60)),
            keep_alive: Duration::from_secs(5),
            trusted_keep_alive: None,
            exchange: Some(Duration::from_secs(300)),
            upgrade_write: WRITE_TIMEOUT,
        }
    }

    /// The static listener: a `node:https` server with `minVersion: "TLSv1.2"`
    /// (`server.ts:272`–`:279`), Node's TLS and keep-alive defaults, and
    /// `headersTimeout = 10_000` on every head.
    pub fn remote_static() -> Self {
        Self {
            handshake: Some(Duration::from_secs(120)),
            first_head: Duration::from_millis(10_000),
            head: Some(Duration::from_millis(10_000)),
            keep_alive: Duration::from_secs(5),
            trusted_keep_alive: None,
            exchange: None,
            upgrade_write: WRITE_TIMEOUT,
        }
    }

    /// The run-time listener, `sniListener`'s own limits
    /// (`sni-listener.ts:12`–`:33`): no later-head deadline (its inner HTTP
    /// server never listens, so Node never runs one), no request timeout, and a
    /// longer idle window once a request on the connection authenticated.
    pub fn remote_sni(limits: SniLimits) -> Self {
        Self {
            handshake: Some(limits.handshake),
            first_head: limits.headers,
            head: None,
            keep_alive: limits.keep_alive,
            trusted_keep_alive: Some(limits.trusted_keep_alive),
            exchange: None,
            upgrade_write: WRITE_TIMEOUT,
        }
    }
}

/// `SniLimits` (`sni-listener.ts:12`–`:26`) and its defaults (`:28`–`:33`).
#[derive(Debug, Clone, Copy)]
pub struct SniLimits {
    /// A client must finish the TLS handshake within this.
    pub handshake: Duration,
    /// ...then send its first request's headers within this.
    pub headers: Duration,
    /// A connection with no request in flight closes after this.
    pub keep_alive: Duration,
    /// ...or after this, once a request on it authenticated.
    pub trusted_keep_alive: Duration,
}

impl Default for SniLimits {
    fn default() -> Self {
        Self {
            handshake: Duration::from_millis(10_000),
            headers: Duration::from_millis(10_000),
            keep_alive: Duration::from_secs(5),
            trusted_keep_alive: Duration::from_secs(60),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The table in the T1b brief, row by row: each remote listener's number is
    /// the one its TypeScript source uses today.
    #[test]
    fn the_remote_limits_match_the_listeners_they_replace() {
        let static_limits = ConnectionLimits::remote_static();
        assert_eq!(static_limits.handshake, Some(Duration::from_secs(120)));
        assert_eq!(static_limits.first_head, Duration::from_millis(10_000));
        assert_eq!(static_limits.head, Some(Duration::from_millis(10_000)));
        assert_eq!(static_limits.keep_alive, Duration::from_secs(5));
        assert_eq!(static_limits.trusted_keep_alive, None);
        assert_eq!(static_limits.exchange, None);

        let defaults = SniLimits::default();
        assert_eq!(defaults.handshake, Duration::from_millis(10_000));
        assert_eq!(defaults.headers, Duration::from_millis(10_000));
        assert_eq!(defaults.keep_alive, Duration::from_secs(5));
        assert_eq!(defaults.trusted_keep_alive, Duration::from_secs(60));

        let sni = ConnectionLimits::remote_sni(defaults);
        assert_eq!(sni.handshake, Some(defaults.handshake));
        assert_eq!(sni.first_head, defaults.headers);
        assert_eq!(sni.head, None);
        assert_eq!(sni.keep_alive, defaults.keep_alive);
        assert_eq!(sni.trusted_keep_alive, Some(defaults.trusted_keep_alive));
        assert_eq!(sni.exchange, None);
    }

    /// Loopback keeps T1a's numbers; a remote connection differs in exactly the
    /// places the brief says it does.
    #[test]
    fn loopback_keeps_t1as_numbers() {
        let loopback = ConnectionLimits::loopback();
        assert_eq!(loopback.handshake, None);
        assert_eq!(loopback.first_head, Duration::from_secs(60));
        assert_eq!(loopback.head, Some(Duration::from_secs(60)));
        assert_eq!(loopback.keep_alive, Duration::from_secs(5));
        assert_eq!(loopback.trusted_keep_alive, None);
        assert_eq!(loopback.exchange, Some(Duration::from_secs(300)));
        assert_eq!(loopback.upgrade_write, Duration::from_secs(5));
    }
}
