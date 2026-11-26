// SPDX-License-Identifier: Apache-2.0
//! Paired devices in the daemon's database, ported from `apps/daemon/src/devices.ts`: the same
//! `devices` table and rows, the same credential generation derived from the stored hash, the
//! same install folding (ADR 0115) and person standing (ADR 0190). Credentials never leave this
//! module except as the token its pairing returned.

use std::sync::{Arc, Mutex};

use ace_store::{Connection, OpenOptions};
use sha2::{Digest, Sha256};

use crate::CredentialRuntime;
use crate::error::Result;

pub mod create;
pub mod links;
pub mod registry;
pub mod revoke;
pub mod row;
pub mod store;

pub(crate) use row::{COLUMNS, Row, decode, integer, opt_integer, opt_text, scopes_json, text};

/// A device scope (`remote.ts:9`–`:17`). `desktop` and `user-browser` are local-only credentials
/// the daemon mints for its own desktop app and for "Use my Chrome" (ADR 0084).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Scope {
    Read,
    Operate,
    Admin,
    Desktop,
    Projects,
    Accounts,
    UserBrowser,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Operate => "operate",
            Self::Admin => "admin",
            Self::Desktop => "desktop",
            Self::Projects => "projects",
            Self::Accounts => "accounts",
            Self::UserBrowser => "user-browser",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "read" => Self::Read,
            "operate" => Self::Operate,
            "admin" => Self::Admin,
            "desktop" => Self::Desktop,
            "projects" => Self::Projects,
            "accounts" => Self::Accounts,
            "user-browser" => Self::UserBrowser,
            _ => return None,
        })
    }

    /// The scopes a pairing link may grant: never the local-only two (`remote.ts:44`).
    pub fn pairable(self) -> bool {
        !matches!(self, Self::Desktop | Self::UserBrowser)
    }
}

/// A device row, in `Device`'s shape (`remote.ts:20`–`:30`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub scopes: Vec<Scope>,
    pub created_at: i64,
    pub last_seen_at: i64,
    pub revoked_at: Option<i64>,
    /// `None`: access lasts until revoked.
    pub expires_at: Option<i64>,
}

/// A device as one of its credentials authenticated it: the generation names that credential, so
/// everything an old credential opened stops carrying authority when the install pairs again
/// (ADR 0115). Derived from the stored hash, never the token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairedDevice {
    pub device: Device,
    pub generation: String,
    /// Its pairing link was made by someone with the person's standing (ADR 0190).
    pub person: bool,
}

impl PairedDevice {
    pub fn id(&self) -> &str {
        &self.device.id
    }
}

/// A member admitted to an organization's host (ADR 0206 §2.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    pub org: String,
    pub role: String,
    pub account: String,
}

/// Who a socket or channel speaks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionActor {
    pub device: Device,
    pub revocable: bool,
    pub generation: Option<String>,
    pub person: Option<bool>,
    pub member: Option<Member>,
    /// A member whose role holds no admin on the host: their socket reaches Spade and nothing
    /// else (`allows` refuses them every scope).
    pub spade_only: bool,
}

impl SessionActor {
    /// A paired device's session, as its ticket authenticated it.
    pub fn paired(device: PairedDevice) -> Self {
        Self {
            device: device.device,
            revocable: true,
            generation: Some(device.generation),
            person: Some(device.person),
            member: None,
            spade_only: false,
        }
    }

    /// The host's own credential: never revocable, never the person (`behaviour.md` §6).
    pub fn host(device: Device) -> Self {
        Self {
            device,
            revocable: false,
            generation: None,
            person: None,
            member: None,
            spade_only: false,
        }
    }
}

/// The pairing-link proof a hello carries with an account grant (ADR 0115).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingLinkProof {
    pub device_id: String,
    /// Base64url HMAC-SHA256 of `ace-link/v1\n<deviceId>\n<hello deviceId>`.
    pub proof: String,
}

/// Whether a device may act with `scope` (`devices.ts:19`–`:28`). A member's socket that only
/// talks to Spade is refused everywhere else, whatever its scopes.
pub fn allows(device: &SessionActor, scope: Scope) -> bool {
    if device.spade_only {
        return false;
    }
    allows_scopes(&device.device.scopes, scope)
}

/// The scope rule without the actor: a device's stored scopes.
pub fn allows_scopes(scopes: &[Scope], scope: Scope) -> bool {
    scopes.contains(&scope)
        || match scope {
            Scope::Projects | Scope::Accounts => scopes.contains(&Scope::Desktop),
            _ => scopes.contains(&Scope::Admin),
        }
}

/// Not revoked, and its access hasn't run out (`devices.ts:31`).
pub fn active_device(device: Option<&Device>, at: i64) -> bool {
    device.is_some_and(|device| {
        device.revoked_at.is_none() && device.expires_at.is_none_or(|expires| expires > at)
    })
}

/// `hash(value)`: lowercase hex SHA-256 (`devices.ts:14`).
pub fn hash(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

/// A listener told a device was revoked or its scopes changed.
type Listener = Arc<dyn Fn(&str) + Send + Sync>;

/// Paired devices, sharing the store's connection (`devices.ts:96`).
pub struct Devices {
    conn: Arc<Connection>,
    runtime: CredentialRuntime,
    revoked: Mutex<Vec<(u64, Listener)>>,
    rescoped: Mutex<Vec<(u64, Listener)>>,
    next_listener: Mutex<u64>,
}

impl Devices {
    pub fn new(conn: Arc<Connection>, runtime: CredentialRuntime) -> Self {
        Self {
            conn,
            runtime,
            revoked: Mutex::new(Vec::new()),
            rescoped: Mutex::new(Vec::new()),
            next_listener: Mutex::new(0),
        }
    }

    /// Open a home's database and its devices table (a shell's or a test's entry point).
    pub fn open(path: &str, runtime: CredentialRuntime) -> Result<Devices> {
        let conn = Connection::open(path, OpenOptions::default())?;
        let devices = Devices::new(conn, runtime);
        devices.migrate()?;
        Ok(devices)
    }

    /// The table's shape, as `migrations.ts` leaves it (`devices.ts` reads every column).
    pub fn migrate(&self) -> Result<()> {
        self.conn.exec(
            "CREATE TABLE IF NOT EXISTS devices (\n\
             id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, \
             scopes JSON NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, \
             revoked_at INTEGER)",
        )?;
        for step in [
            "ALTER TABLE devices ADD COLUMN expires_at INTEGER",
            "ALTER TABLE devices ADD COLUMN install_id TEXT",
            "ALTER TABLE devices ADD COLUMN merged_into TEXT",
            "ALTER TABLE devices ADD COLUMN account_link TEXT",
            "ALTER TABLE devices ADD COLUMN person INTEGER",
            "ALTER TABLE devices ADD COLUMN standing_key TEXT",
        ] {
            if let Err(error) = self.conn.exec(step) {
                // Every ALTER fails once its column exists; that is the migration state we want.
                if !error.message.contains("duplicate column name") {
                    return Err(error.into());
                }
            }
        }
        Ok(())
    }

    /// Hear a device's revocation; at most 32 subscribers (`devices.ts:98`–`:104`).
    pub fn on_revoke(&self, listener: Listener) -> std::result::Result<u64, String> {
        let mut listeners = self
            .revoked
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if listeners.len() >= 32 {
            return Err("Device revocation subscriber limit".to_owned());
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

    pub fn off_revoke(&self, id: u64) {
        let mut listeners = self
            .revoked
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        listeners.retain(|(each, _)| *each != id);
    }

    /// Hear a device's scopes change; at most 32 subscribers (`devices.ts:106`–`:112`).
    pub fn on_rescope(&self, listener: Listener) -> std::result::Result<u64, String> {
        let mut listeners = self
            .rescoped
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if listeners.len() >= 32 {
            return Err("Device rescope subscriber limit".to_owned());
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

    pub fn off_rescope(&self, id: u64) {
        let mut listeners = self
            .rescoped
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        listeners.retain(|(each, _)| *each != id);
    }

    pub fn connection(&self) -> &Arc<Connection> {
        &self.conn
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use std::sync::{Arc, Mutex};

    use crate::CredentialRuntime;
    use crate::devices::{Devices, Scope, allows_scopes};

    fn devices() -> (Devices, tempfile::TempDir) {
        let directory = tempfile::tempdir().unwrap();
        let counter = Arc::new(Mutex::new(0_u64));
        let entropy = Arc::new(Mutex::new(0_u64));
        let runtime = CredentialRuntime::new(
            move || {
                let mut id = counter.lock().unwrap();
                *id += 1;
                format!("device-{id}")
            },
            move |size| {
                let mut seed = entropy.lock().unwrap();
                *seed += 1;
                let mut bytes = vec![7_u8; size];
                let width = size.min(8);
                bytes[..width].copy_from_slice(&seed.to_be_bytes()[8 - width..]);
                bytes
            },
        );
        let path = directory.path().join("events.sqlite");
        let devices = Devices::open(path.to_str().unwrap(), runtime).unwrap();
        (devices, directory)
    }

    #[test]
    fn allows_follows_the_scope_rules_and_refuses_a_spade_only_socket() {
        assert!(allows_scopes(&[Scope::Admin], Scope::Read));
        assert!(allows_scopes(&[Scope::Admin], Scope::Operate));
        // `admin` grants everything but Projects and Accounts, which need `desktop`.
        assert!(!allows_scopes(&[Scope::Admin], Scope::Projects));
        assert!(!allows_scopes(&[Scope::Admin], Scope::Accounts));
        assert!(allows_scopes(&[Scope::Desktop], Scope::Projects));
        assert!(allows_scopes(&[Scope::Desktop], Scope::Accounts));
        assert!(!allows_scopes(&[Scope::Desktop], Scope::Read));
        assert!(!allows_scopes(&[Scope::Read], Scope::Operate));
        let (devices, _home) = devices();
        let device = devices
            .create("Phone", &[Scope::Read], 1_000, None, None, false, None)
            .unwrap();
        let actor = super::SessionActor::host(device.0);
        assert!(super::allows(&actor, Scope::Read));
        let spade_only = super::SessionActor {
            spade_only: true,
            ..actor
        };
        assert!(!super::allows(&spade_only, Scope::Read));
    }
}
