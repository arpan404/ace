// SPDX-License-Identifier: Apache-2.0
//! `RemoteAuth`, ported from `apps/daemon/src/remote-auth.ts`: the host token, paired devices'
//! bearers and tickets, single-use pairing links with their refusals, and the listeners that
//! close what a revoked or re-paired device opened. The clock, secrets and ids are injected;
//! tickets live in memory, so a restart voids them, while pairing links persist if their store
//! does.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::Runtime;
use crate::devices::{Device, Devices, PairedDevice, Scope, SessionActor, allows};
use crate::error::{AuthError, Result};
use crate::pairing::{MemoryPairingCodes, PairingCodeStore};
use crate::tickets::{TicketLimits, TicketPool, default_ticket_limits};
use crate::token::valid_token;

/// A pairing link as `pairing` issues it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingTicket {
    pub id: String,
    pub code: String,
    pub expires_at: i64,
}

/// A redeemed link's answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RedeemedDevice {
    pub device: Device,
    pub token: String,
}

/// A ticket as `ticket` issues it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandedTicket {
    pub ticket: String,
    pub expires_at: i64,
}

/// The ticket a welcome hands over, with its lifetime (`welcome.ticket`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandedOver {
    pub ticket: String,
    pub ttl_ms: i64,
}

type Listener = Arc<dyn Fn(&str) + Send + Sync>;

/// An address's redemption attempts in the current minute.
#[derive(Debug, Clone, Copy)]
struct Attempt {
    count: u32,
    resets_at: i64,
}

pub mod admin;
pub mod pairing;
pub mod tickets;

#[cfg(test)]
pub(crate) mod support;

/// The daemon's authentication state (`remote-auth.ts:39`).
pub struct RemoteAuth {
    codes: Box<dyn PairingCodeStore>,
    tickets: TicketPool,
    ticket_limits: TicketLimits,
    attempts: HashMap<String, Attempt>,
    devices: Devices,
    local_token: String,
    runtime: Runtime,
    revoked: Mutex<Vec<(u64, Listener)>>,
    replaced: Mutex<Vec<(u64, Listener)>>,
    next_listener: Mutex<u64>,
}

impl RemoteAuth {
    pub fn new(
        devices: Devices,
        local_token: impl Into<String>,
        runtime: Runtime,
        limits: TicketLimits,
        codes: Box<dyn PairingCodeStore>,
    ) -> Self {
        Self {
            codes,
            tickets: TicketPool::new(limits),
            ticket_limits: limits,
            attempts: HashMap::new(),
            devices,
            local_token: local_token.into(),
            runtime,
            revoked: Mutex::new(Vec::new()),
            replaced: Mutex::new(Vec::new()),
            next_listener: Mutex::new(0),
        }
    }

    /// A daemon or a test with in-memory pairing codes and the default ticket limits.
    pub fn with_memory(devices: Devices, local_token: impl Into<String>, runtime: Runtime) -> Self {
        Self::new(
            devices,
            local_token,
            runtime,
            default_ticket_limits(),
            Box::new(MemoryPairingCodes::new()),
        )
    }

    pub fn now(&self) -> i64 {
        self.runtime.now()
    }

    pub fn devices(&self) -> &Devices {
        &self.devices
    }

    /// The host token, compared in constant time (`remote-auth.ts:68`).
    pub fn local(&self, token: &str) -> bool {
        valid_token(token, &self.local_token)
    }

    /// The host's credential as a device, or a paired device's bearer (`remote-auth.ts:71`).
    pub fn local_bearer(&self, token: &str) -> Option<Device> {
        if self.local(token) {
            return Some(Device {
                id: "local".to_owned(),
                name: "Host".to_owned(),
                scopes: vec![Scope::Admin, Scope::Projects],
                created_at: 0,
                last_seen_at: self.now(),
                revoked_at: None,
                expires_at: None,
            });
        }
        self.device_bearer(token).map(|device| device.device)
    }

    pub fn device_bearer(&self, token: &str) -> Option<PairedDevice> {
        self.devices.authenticate(token, self.now()).ok().flatten()
    }

    /// Hear a device's revocation; at most 32 subscribers (`remote-auth.ts:293`). Its id is what
    /// [`RemoteAuth::off_revoke`] takes.
    pub fn on_revoke(&self, listener: Listener) -> std::result::Result<u64, String> {
        self.subscribe(&self.revoked, listener, "Device revocation")
    }

    /// Stop hearing revocations. The TypeScript returns this unsubscribe from `onRevoke`; a caller
    /// that subscribes per socket must keep it, or the 32-listener cap eventually refuses every
    /// new socket and a revoked device's sockets stop being closed.
    pub fn off_revoke(&self, id: u64) {
        self.unsubscribe(&self.revoked, id);
    }

    /// Hear a credential replacement; at most 32 subscribers (`remote-auth.ts:304`).
    pub fn on_credential_replaced(&self, listener: Listener) -> std::result::Result<u64, String> {
        self.subscribe(&self.replaced, listener, "Device replacement")
    }

    pub fn off_credential_replaced(&self, id: u64) {
        self.unsubscribe(&self.replaced, id);
    }

    fn unsubscribe(&self, list: &Mutex<Vec<(u64, Listener)>>, id: u64) {
        list.lock()
            .unwrap_or_else(|error| error.into_inner())
            .retain(|(each, _)| *each != id);
    }

    fn subscribe(
        &self,
        list: &Mutex<Vec<(u64, Listener)>>,
        listener: Listener,
        limit: &str,
    ) -> std::result::Result<u64, String> {
        let mut listeners = list.lock().unwrap_or_else(|error| error.into_inner());
        if listeners.len() >= 32 {
            return Err(format!("{limit} subscriber limit"));
        }
        let mut next = self
            .next_listener
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        *next += 1;
        let id = *next;
        listeners.push((id, listener));
        Ok(id)
    }

    fn listeners(&self, list: &Mutex<Vec<(u64, Listener)>>) -> Vec<Listener> {
        list.lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .map(|(_, listener)| Arc::clone(listener))
            .collect()
    }

    pub fn require_admin(&self, device: Option<&SessionActor>) -> Result<()> {
        match device {
            Some(device) if allows(device, Scope::Admin) => Ok(()),
            _ => Err(AuthError::access(403, "Admin scope required")),
        }
    }
}

/// Every device the daemon minted itself is local-only (`remote-auth.ts:36`).
pub(crate) fn local_only(device: &Device) -> bool {
    device
        .scopes
        .iter()
        .any(|scope| matches!(scope, Scope::Desktop | Scope::UserBrowser))
}

fn not_paired() -> AuthError {
    AuthError::access(404, "That device isn't paired anymore.")
}

#[cfg(test)]
mod tests {
    //! Ported cases live beside the methods they prove; see each file's header for its
    //! TypeScript source.

    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use std::sync::{Arc, Mutex};

    use crate::devices::Scope;
    use crate::pairing::PairingTerms;
    use crate::remote_auth::support::Home;

    #[test]
    fn a_listener_that_unsubscribes_hears_no_revocation_and_frees_its_slot() {
        let home = Home::new();
        let mut auth = home.memory();
        let paired =
            crate::remote_auth::support::pair_with(&mut auth, &[Scope::Read], "Phone", None, None);
        let heard = Arc::new(Mutex::new(Vec::new()));
        let recorder = Arc::clone(&heard);
        let id = auth
            .on_revoke(Arc::new(move |device: &str| {
                recorder.lock().unwrap().push(device.to_owned())
            }))
            .unwrap();
        auth.off_revoke(id);
        auth.revoke(&paired.device.id).unwrap();
        assert!(heard.lock().unwrap().is_empty());
        // The cap is 32 listeners; removing one makes room again.
        let noop: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(|_: &str| {});
        let mut ids = Vec::new();
        for _ in 0..32 {
            ids.push(auth.on_revoke(Arc::clone(&noop)).unwrap());
        }
        assert!(auth.on_revoke(Arc::clone(&noop)).is_err());
        auth.off_revoke(ids[0]);
        assert!(auth.on_revoke(Arc::clone(&noop)).is_ok());
        // A credential replacement unsubscribes the same way.
        let replaced = auth.on_credential_replaced(Arc::new(|_: &str| {})).unwrap();
        auth.off_credential_replaced(replaced);
    }

    #[test]
    fn a_fabricated_token_authenticates_nothing_and_redemption_ignores_scope_injection() {
        let home = Home::new();
        let mut auth = home.memory();
        assert!(auth.device_bearer(&"b".repeat(64)).is_none());
        let issued = auth
            .pairing(&[Scope::Read], &PairingTerms::default())
            .unwrap();
        // The redemption body names only code, name, install id and standing key: a `scopes`
        // field is not part of it, so the link's own scopes stand.
        let redeemed = auth.redeem(&issued.code, "Phone", None, None).unwrap();
        assert_eq!(redeemed.device.scopes, vec![Scope::Read]);
        // An unknown scope is not a PairingRequest.
        let request = ace_json::parse("{\"scopes\":[\"root\"]}").unwrap();
        assert!(crate::pairing::PairingRequest::parse(&request).is_none());
    }
}
