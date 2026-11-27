// SPDX-License-Identifier: Apache-2.0
//! The relay's address, as an administrator is shown it and as a pairing link names it
//! (`apps/daemon/src/relay-route.ts`). None of it is secret: the key is public.

use crate::noise::{KeyPair, fingerprint};

/// How a paired client reaches this daemon's channels through its relay (`RemoteAccessStatus`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayRoute {
    pub url: String,
    /// The host key a client pins (the host id).
    pub fingerprint: String,
    /// The daemon identity its welcome names.
    pub host_id: String,
}

/// A pairing link's route through a self-hosted relay.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayPairingRoute {
    pub url: String,
    /// The host key to pin.
    pub host_id: String,
}

/// The route to a relay, when this daemon runs on one.
pub fn relay_route(relay: Option<(&str, &KeyPair)>, host_id: &str) -> Option<RelayRoute> {
    relay.map(|(url, keys)| RelayRoute {
        url: url.to_owned(),
        fingerprint: fingerprint(&keys.public),
        host_id: host_id.to_owned(),
    })
}

pub fn relay_pairing(url: &str, keys: &KeyPair) -> RelayPairingRoute {
    RelayPairingRoute {
        url: url.to_owned(),
        host_id: fingerprint(&keys.public),
    }
}

#[cfg(test)]
mod tests {
    //! `relay-route.ts` has no test file of its own; these pin what it returns.

    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::{relay_pairing, relay_route};
    use crate::noise::KeyPair;

    #[test]
    fn a_daemon_without_a_relay_names_no_route_and_one_with_it_names_the_pinned_key() {
        let keys = KeyPair::from_private([7u8; 32]);
        assert_eq!(relay_route(None, "host-1"), None);
        let route = relay_route(Some(("wss://relay.example.com/", &keys)), "host-1").unwrap();
        assert_eq!(route.url, "wss://relay.example.com/");
        assert_eq!(route.host_id, "host-1");
        assert_eq!(route.fingerprint, keys.host_id());
        let pairing = relay_pairing("wss://relay.example.com/", &keys);
        assert_eq!(pairing.host_id, keys.host_id());
    }
}
