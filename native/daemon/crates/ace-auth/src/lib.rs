// SPDX-License-Identifier: Apache-2.0
//! Hello, authentication and device identity (ADR 0226 §6, T2): the hello's credentials and
//! refusals, ticket allocation and handover, pairing codes and links, devices with their
//! credential generations and scopes, the account grant lease, and an organization host's
//! standing checks. Behaviour lives here in sans-I/O form where it can; devices and pairing links
//! persist through `ace-store` on the same tables and rows the TypeScript writes, so a home
//! boots under either daemon.
//!
//! Clocks, secrets and ids are injected ([`Runtime`]); nothing in this crate reads a global clock
//! or RNG. Tickets and pairing attempts live in memory only, so a restart voids every outstanding
//! ticket while a persisted pairing link still redeems (`pairing-codes.ts:80`).

pub mod devices;
pub mod devices_channel;
pub mod error;
pub mod grant;
pub mod hello;
pub mod http_body;
pub mod identity;
pub mod org;
pub mod pairing;
pub mod remote_auth;
pub mod tickets;
pub mod token;

pub use devices::{Device, PairedDevice, Scope, SessionActor, active_device, allows};
pub use devices_channel::{
    ChannelFrame, ChannelOpening, DEVICE_ACCESS_REFUSED, DEVICES_UNAVAILABLE, DeviceFailure,
    DevicesChannel, Request,
};
pub use error::{AccessError, AuthError, Result};
pub use grant::{
    ACCESS_CHANGED_CLOSE, ACCESS_CHANGED_REASON, AccountGrantSocket, GRANT_EXPIRED_CLOSE,
    GRANT_EXPIRED_REASON, GRANT_GRACE_MS, GrantRefreshOutcome, grant_lease_state,
    grant_refresh_outcome,
};
pub use hello::{Hello, HelloRefusal, hello_actor};
pub use identity::{
    HostIdentity, IconColor, IdentityFacts, IdentityRefusal, IdentitySession, MachineIcon,
    MachineIconKind, NameHost, SettingValue, computer_name, host_identity, known_platform,
    pretty_hostname,
};
pub use pairing::{
    IssuedPairing, PairingCodeStore, PairingConnection, PairingTerms, PendingCode, pairing_link_url,
};
pub use remote_auth::RemoteAuth;
pub use tickets::{TicketLimits, TicketPool, default_ticket_limits};
pub use token::{is_token, read_local_token, valid_token};

use std::sync::Arc;

/// The clock, the secret source and the id source the daemon injects. Every call reads the
/// current value, as `RemoteAuth`'s runtime does (`remote-auth.ts:51`–`:67`).
#[derive(Clone)]
pub struct Runtime {
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    secret: Arc<dyn Fn() -> String + Send + Sync>,
    id: Arc<dyn Fn() -> String + Send + Sync>,
}

impl Runtime {
    pub fn new(
        now: impl Fn() -> i64 + Send + Sync + 'static,
        secret: impl Fn() -> String + Send + Sync + 'static,
        id: impl Fn() -> String + Send + Sync + 'static,
    ) -> Self {
        Self {
            now: Arc::new(now),
            secret: Arc::new(secret),
            id: Arc::new(id),
        }
    }

    /// Milliseconds since the Unix epoch.
    pub fn now(&self) -> i64 {
        (self.now)()
    }

    /// A fresh secret (a ticket or a pairing code).
    pub fn secret(&self) -> String {
        (self.secret)()
    }

    pub fn id(&self) -> String {
        (self.id)()
    }
}

/// The credential material devices are minted with (`credential-runtime.ts:4`–`:13`).
#[derive(Clone)]
pub struct CredentialRuntime {
    id: Arc<dyn Fn() -> String + Send + Sync>,
    random_bytes: Arc<dyn Fn(usize) -> Vec<u8> + Send + Sync>,
}

impl CredentialRuntime {
    pub fn new(
        id: impl Fn() -> String + Send + Sync + 'static,
        random_bytes: impl Fn(usize) -> Vec<u8> + Send + Sync + 'static,
    ) -> Self {
        Self {
            id: Arc::new(id),
            random_bytes: Arc::new(random_bytes),
        }
    }

    pub fn id(&self) -> String {
        (self.id)()
    }

    /// A 64-hex device token, from exactly 32 bytes (`generateSecret`).
    pub fn secret(&self) -> String {
        let bytes = (self.random_bytes)(32);
        hex::encode(bytes)
    }
}
