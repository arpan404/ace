// SPDX-License-Identifier: Apache-2.0
//! Paired devices in the daemon's database, ported from `apps/daemon/src/devices.ts`: the same
//! `devices` table and rows, the same credential generation derived from the stored hash, the
//! same install folding (ADR 0115) and person standing (ADR 0190). Credentials never leave this
//! module except as the token its pairing returned.

use std::sync::{Arc, Mutex};

use ace_store::{Connection, OpenOptions, Statement, Value};
use hmac::Hmac;
use hmac::Mac;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::CredentialRuntime;
use crate::error::{AuthError, Result};

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

/// The generation a credential's stored hash names: the first 32 hex characters of
/// `sha256("generation:" + token_hash)` (`devices.ts:80`).
fn generation_of(token_hash: &str) -> String {
    let digest = hex::encode(Sha256::digest(
        format!("generation:{token_hash}").as_bytes(),
    ));
    digest[..32].to_owned()
}

const COLUMNS: &str = "id, name, token_hash, scopes, created_at, last_seen_at, revoked_at, \
                       expires_at, install_id, merged_into, person, standing_key, account_link";

/// One decoded row.
#[derive(Debug, Clone)]
struct Row {
    id: String,
    name: String,
    token_hash: String,
    scopes: Vec<Scope>,
    created_at: i64,
    last_seen_at: i64,
    revoked_at: Option<i64>,
    expires_at: Option<i64>,
    install_id: Option<String>,
    merged_into: Option<String>,
    person: bool,
    standing_key: Option<String>,
    account_link: Option<String>,
}

impl Row {
    fn device(&self) -> Device {
        Device {
            id: self.id.clone(),
            name: self.name.clone(),
            scopes: self.scopes.clone(),
            created_at: self.created_at,
            last_seen_at: self.last_seen_at,
            revoked_at: self.revoked_at,
            expires_at: self.expires_at,
        }
    }

    fn generation(&self) -> String {
        generation_of(&self.token_hash)
    }
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

    /// Create or rekey a device. An install that already holds a device here keeps that record
    /// and its id, and the new pairing's name, scopes, expiry and credential replace the old
    /// (`devices.ts:180`–`:246`).
    // The seven parameters are the TypeScript's, in its order (`devices.ts:186`-`:194`).
    #[allow(clippy::too_many_arguments)]
    pub fn create(
        &self,
        name: &str,
        granted: &[Scope],
        at: i64,
        expires_at: Option<i64>,
        install_id: Option<&str>,
        person: bool,
        standing_key: Option<&str>,
    ) -> Result<(Device, String)> {
        // A device that names no standing key can never prove the person's standing, so it never
        // carries the person's bit either (ADR 0190).
        let personal = person && standing_key.is_some();
        let key = if personal { standing_key } else { None };
        let token = self.runtime.secret();
        let token_hash = hash(&token);
        let scopes_json = scopes_json(granted);
        let held = match install_id {
            Some(install) => self.by_install(install, at)?,
            None => None,
        };
        if let Some(held) = held {
            let device = Device {
                id: held.id.clone(),
                name: name.to_owned(),
                scopes: granted.to_vec(),
                created_at: held.created_at,
                last_seen_at: at,
                revoked_at: held.revoked_at,
                expires_at,
            };
            // A new credential is a new proof: the account device it was linked to is unlinked.
            self.execute(
                "UPDATE devices SET name = ?, token_hash = ?, scopes = ?, last_seen_at = ?, \
                 expires_at = ?, person = ?, standing_key = ?, account_link = NULL WHERE id = ?",
                &[
                    text(&device.name),
                    text(&token_hash),
                    text(&scopes_json),
                    integer(at),
                    opt_integer(device.expires_at),
                    integer(i64::from(personal)),
                    opt_text(key),
                    text(&device.id),
                ],
            )?;
            return Ok((device, token));
        }
        // Always minted here: an install id is not a secret, so a record named by one would share
        // whatever that install's account device keeps under the same id (ADR 0115).
        let device = Device {
            id: self.runtime.id(),
            name: name.to_owned(),
            scopes: granted.to_vec(),
            created_at: at,
            last_seen_at: at,
            revoked_at: None,
            expires_at,
        };
        self.execute(
            "INSERT INTO devices (id, name, token_hash, scopes, created_at, last_seen_at, \
             revoked_at, expires_at, install_id, person, standing_key) \
             VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)",
            &[
                text(&device.id),
                text(&device.name),
                text(&token_hash),
                text(&scopes_json),
                integer(device.created_at),
                integer(device.last_seen_at),
                opt_integer(device.expires_at),
                opt_text(install_id),
                integer(i64::from(personal)),
                opt_text(key),
            ],
        )?;
        Ok((device, token))
    }

    /// `id` connected from app install `install_id`: its record learns the install, and records
    /// the install left behind before installs had ids fold into it (`devices.ts:258`–`:274`).
    pub fn recognize(&self, id: &str, install_id: &str, at: i64) -> Result<()> {
        let Some(row) = self.by_id(id)? else {
            return Ok(());
        };
        if row.revoked_at.is_some() {
            return Ok(());
        }
        if row.merged_into.is_some() {
            self.execute(
                "UPDATE devices SET merged_into = NULL WHERE id = ?",
                &[text(id)],
            )?;
        }
        if let Some(held) = row.install_id.as_deref()
            && held != install_id
        {
            return Ok(());
        }
        if row.install_id.is_none() {
            if let Some(other) = self.by_install(install_id, at)?
                && other.id != id
            {
                return Ok(());
            }
            self.execute(
                "UPDATE devices SET install_id = ? WHERE id = ?",
                &[text(install_id), text(id)],
            )?;
        }
        let survivor = row.device();
        for orphan in self.orphans(id, &row.name, row.created_at, at)? {
            let scopes = orphan.scopes.clone();
            if scopes
                .iter()
                .all(|scope| allows_scopes(&survivor.scopes, *scope))
            {
                self.execute(
                    "UPDATE devices SET merged_into = ? WHERE (id = ? OR merged_into = ?) \
                     AND revoked_at IS NULL",
                    &[text(id), text(&orphan.id), text(&orphan.id)],
                )?;
            }
        }
        Ok(())
    }

    /// The ace account device `account_id` proved it holds the credential of paired record
    /// `link.device_id` (ADR 0115). False when the proof doesn't match an active paired
    /// credential; local-only credentials never link (`devices.ts:282`–`:296`).
    pub fn link(&self, account_id: &str, link: &PairingLinkProof, at: i64) -> Result<bool> {
        let Some(row) = self.by_id(&link.device_id)? else {
            return Ok(false);
        };
        if link.device_id == account_id || !active_device(Some(&row.device()), at) {
            return Ok(false);
        }
        if row
            .scopes
            .iter()
            .any(|scope| matches!(scope, Scope::Desktop | Scope::UserBrowser))
        {
            return Ok(false);
        }
        let mut mac =
            <Hmac<Sha256> as hmac::digest::KeyInit>::new_from_slice(row.token_hash.as_bytes())
                .map_err(|error| AuthError::Token(error.to_string()))?;
        mac.update(format!("ace-link/v1\n{}\n{}", link.device_id, account_id).as_bytes());
        let expected = mac.finalize().into_bytes();
        let Ok(given) = base64::Engine::decode(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD,
            link.proof.as_bytes(),
        ) else {
            return Ok(false);
        };
        if given.len() != expected.len() || !bool::from(given.ct_eq(expected.as_slice())) {
            return Ok(false);
        }
        self.execute(
            "UPDATE devices SET account_link = ? WHERE id = ?",
            &[text(account_id), text(&link.device_id)],
        )?;
        // The hello that proved it is the pairing's use, so the linked-id cap drops it last.
        self.touch(&link.device_id, at)?;
        Ok(true)
    }

    /// Whether `a` and `b` are one device for command receipts (`devices.ts:303`–`:311`).
    pub fn same_install(&self, a: &str, b: &str) -> Result<bool> {
        if a == b {
            return Ok(true);
        }
        let proven = |id: &str| -> Result<Option<String>> {
            Ok(match self.by_id(id)? {
                Some(row) => row.account_link,
                None => Some(id.to_owned()),
            })
        };
        let left = proven(a)?;
        Ok(left.is_some() && left == proven(b)?)
    }

    /// The other ids `id` is one device with, most recently seen first (`devices.ts:316`).
    pub fn linked(&self, id: &str, at: i64) -> Result<Vec<String>> {
        let row = self.by_id(id)?;
        if let Some(row) = &row
            && !active_device(Some(&row.device()), at)
        {
            return Ok(Vec::new());
        }
        let account = match row {
            Some(row) => row.account_link,
            None => Some(id.to_owned()),
        };
        let Some(account) = account else {
            return Ok(Vec::new());
        };
        let linked = self.ids(
            "SELECT id FROM devices WHERE account_link = ? AND revoked_at IS NULL \
             AND (expires_at IS NULL OR expires_at > ?) ORDER BY last_seen_at DESC, id",
            &[text(&account), integer(at)],
        )?;
        if linked.is_empty() {
            return Ok(Vec::new());
        }
        let mut ids = vec![account];
        ids.extend(linked);
        Ok(ids.into_iter().filter(|other| other != id).collect())
    }

    pub fn get(&self, id: &str) -> Result<Option<Device>> {
        Ok(self.by_id(id)?.map(|row| row.device()))
    }

    /// The device whose record a pairing from `install_id` would take over, if any.
    pub fn held_by(&self, install_id: &str, at: i64) -> Result<Option<String>> {
        Ok(self.by_install(install_id, at)?.map(|row| row.id))
    }

    /// `id` while it is active and still holds the credential of `generation`.
    pub fn current(
        &self,
        id: &str,
        generation: Option<&str>,
        at: i64,
    ) -> Result<Option<PairedDevice>> {
        let Some(row) = self.by_id(id)? else {
            return Ok(None);
        };
        let Some(generation) = generation else {
            return Ok(None);
        };
        if row.generation() != generation || !active_device(Some(&row.device()), at) {
            return Ok(None);
        }
        Ok(Some(PairedDevice {
            device: row.device(),
            generation: generation.to_owned(),
            person: row.person,
        }))
    }

    /// The key `id` proves the person's standing with, while active, current and the person's.
    pub fn standing_key_of(
        &self,
        id: &str,
        generation: Option<&str>,
        at: i64,
    ) -> Result<Option<String>> {
        let Some(row) = self.by_id(id)? else {
            return Ok(None);
        };
        if self.current(id, generation, at)?.is_none() || !row.person {
            return Ok(None);
        }
        Ok(row.standing_key)
    }

    /// No paired device is the person's any more: the machine's owner changed (ADR 0190).
    pub fn clear_person(&self) -> Result<()> {
        self.execute(
            "UPDATE devices SET person = 0, standing_key = NULL WHERE person = 1 \
             OR standing_key IS NOT NULL",
            &[],
        )?;
        Ok(())
    }

    /// The device a token authenticates, touching it (`devices.ts:357`).
    pub fn authenticate(&self, token: &str, at: i64) -> Result<Option<PairedDevice>> {
        let rows = self.all(
            &format!(
                "SELECT {COLUMNS} FROM devices WHERE token_hash = ? AND revoked_at IS NULL \
                 AND (expires_at IS NULL OR expires_at > ?)"
            ),
            &[text(&hash(token)), integer(at)],
        )?;
        let Some(mut row) = rows.into_iter().next() else {
            return Ok(None);
        };
        // Its own credential in use: it is a device of its own after all.
        if row.merged_into.is_some() {
            self.execute(
                "UPDATE devices SET merged_into = NULL WHERE id = ?",
                &[text(&row.id)],
            )?;
        }
        self.touch(&row.id, at)?;
        row.last_seen_at = at;
        Ok(Some(PairedDevice {
            generation: row.generation(),
            person: row.person,
            device: row.device(),
        }))
    }

    /// An ace account device connected: the paired record of the same install is seen too.
    pub fn seen(&self, install_id: &str, at: i64) -> Result<()> {
        if let Some(row) = self.by_install(install_id, at)? {
            self.touch(&row.id, at)?;
        }
        Ok(())
    }

    pub fn touch(&self, id: &str, at: i64) -> Result<()> {
        self.execute(
            "UPDATE devices SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL",
            &[integer(at), text(id)],
        )?;
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<Device>> {
        Ok(self
            .all(
                &format!(
                    "SELECT {COLUMNS} FROM devices WHERE merged_into IS NULL ORDER BY created_at, id"
                ),
                &[],
            )?
            .into_iter()
            .map(|row| row.device())
            .collect())
    }

    /// Give active device `id` exactly `scopes`, keeping its credential, id and expiry.
    pub fn set_scopes(&self, id: &str, scopes: &[Scope], at: i64) -> Result<Option<Device>> {
        let Some(row) = self.by_id(id)? else {
            return Ok(None);
        };
        let held = row.device();
        if !active_device(Some(&held), at) {
            return Ok(None);
        }
        let mut seen = Vec::new();
        for scope in scopes {
            if !seen.contains(scope) {
                seen.push(*scope);
            }
        }
        let device = Device {
            scopes: seen,
            ..held
        };
        self.execute(
            "UPDATE devices SET scopes = ? WHERE id = ? AND revoked_at IS NULL",
            &[text(&scopes_json(&device.scopes)), text(&device.id)],
        )?;
        let listeners = self
            .rescoped
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .map(|(_, listener)| Arc::clone(listener))
            .collect::<Vec<_>>();
        for listener in listeners {
            listener(&device.id);
        }
        Ok(Some(device))
    }

    pub fn revoke(&self, id: &str, at: i64) -> Result<bool> {
        Ok(!self.revoke_install(id, at)?.is_empty())
    }

    /// Revoke `id` and the records folded into it, `id` first; empty when it was not active
    /// (`devices.ts:401`–`:409`).
    pub fn revoke_install(&self, id: &str, at: i64) -> Result<Vec<String>> {
        let folded = self.ids(
            "SELECT id FROM devices WHERE merged_into = ? AND revoked_at IS NULL ORDER BY id",
            &[text(id)],
        )?;
        if self.changed(
            "UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
            &[integer(at), text(id)],
        )? == 0
        {
            return Ok(Vec::new());
        }
        let mut revoked = vec![id.to_owned()];
        for other in folded {
            if self.changed(
                "UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
                &[integer(at), text(&other)],
            )? > 0
            {
                revoked.push(other);
            }
        }
        let listeners = self
            .revoked
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .map(|(_, listener)| Arc::clone(listener))
            .collect::<Vec<_>>();
        for each in &revoked {
            for listener in &listeners {
                listener(each);
            }
        }
        Ok(revoked)
    }

    fn by_id(&self, id: &str) -> Result<Option<Row>> {
        Ok(self
            .all(
                &format!("SELECT {COLUMNS} FROM devices WHERE id = ?"),
                &[text(id)],
            )?
            .into_iter()
            .next())
    }

    fn by_install(&self, install_id: &str, at: i64) -> Result<Option<Row>> {
        Ok(self
            .all(
                &format!(
                    "SELECT {COLUMNS} FROM devices WHERE install_id = ? AND merged_into IS NULL \
                     AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) \
                     ORDER BY last_seen_at DESC, id LIMIT 1"
                ),
                &[text(install_id), integer(at)],
            )?
            .into_iter()
            .next())
    }

    fn orphans(&self, id: &str, name: &str, created_at: i64, at: i64) -> Result<Vec<Row>> {
        self.all(
            &format!(
                "SELECT {COLUMNS} FROM devices WHERE id != ? AND install_id IS NULL \
                 AND merged_into IS NULL AND name = ? AND last_seen_at < ? \
                 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) \
                 AND scopes NOT LIKE '%\"desktop\"%' AND scopes NOT LIKE '%\"user-browser\"%'"
            ),
            &[text(id), text(name), integer(created_at), integer(at)],
        )
    }

    fn prepare(&self, sql: &str) -> Result<Statement> {
        Ok(self.conn.prepare(sql)?)
    }

    fn all(&self, sql: &str, params: &[Option<Value>]) -> Result<Vec<Row>> {
        let statement = self.prepare(sql)?;
        statement.bind(params)?;
        let mut rows = Vec::new();
        while let Some(values) = statement.step()? {
            rows.push(decode(&values)?);
        }
        Ok(rows)
    }

    /// A query of one TEXT column.
    fn ids(&self, sql: &str, params: &[Option<Value>]) -> Result<Vec<String>> {
        let statement = self.prepare(sql)?;
        statement.bind(params)?;
        let mut ids = Vec::new();
        while let Some(values) = statement.step()? {
            if let Some(Value::Text(text)) = values.first() {
                ids.push(text.clone());
            }
        }
        Ok(ids)
    }

    fn execute(&self, sql: &str, params: &[Option<Value>]) -> Result<()> {
        let statement = self.prepare(sql)?;
        statement.bind(params)?;
        statement.step()?;
        Ok(())
    }

    fn changed(&self, sql: &str, params: &[Option<Value>]) -> Result<i64> {
        let statement = self.prepare(sql)?;
        statement.bind(params)?;
        statement.step()?;
        Ok(statement.changes()?.0)
    }
}

fn decode(values: &[Value]) -> Result<Row> {
    let field = |index: usize| -> Value { values.get(index).cloned().unwrap_or(Value::Null) };
    let string = |index: usize| -> String {
        match field(index) {
            Value::Text(text) => text,
            Value::Integer(number) => number.to_string(),
            Value::Null | Value::Real(_) | Value::Blob(_) => String::new(),
        }
    };
    let optional = |index: usize| -> Option<String> {
        match field(index) {
            Value::Text(text) => Some(text),
            Value::Null => None,
            other => Some(match other {
                Value::Integer(number) => number.to_string(),
                Value::Real(number) => number.to_string(),
                Value::Blob(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
                Value::Null | Value::Text(_) => String::new(),
            }),
        }
    };
    let integer_of = |index: usize| -> Option<i64> {
        match field(index) {
            Value::Integer(number) => Some(number),
            Value::Real(number) => Some(number as i64),
            Value::Null | Value::Text(_) | Value::Blob(_) => None,
        }
    };
    if values.len() < 13 {
        return Err(AuthError::Token(
            "a devices row is missing columns".to_owned(),
        ));
    }
    Ok(Row {
        id: string(0),
        name: string(1),
        token_hash: string(2),
        scopes: decode_scopes(&string(3)),
        created_at: integer_of(4).unwrap_or(0),
        last_seen_at: integer_of(5).unwrap_or(0),
        revoked_at: integer_of(6),
        expires_at: integer_of(7),
        install_id: optional(8),
        merged_into: optional(9),
        person: integer_of(10) == Some(1),
        standing_key: optional(11),
        account_link: optional(12),
    })
}

fn decode_scopes(text: &str) -> Vec<Scope> {
    let Ok(value) = ace_json::parse(text) else {
        return Vec::new();
    };
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().and_then(Scope::parse))
                .collect()
        })
        .unwrap_or_default()
}

fn scopes_json(scopes: &[Scope]) -> String {
    let names: Vec<String> = scopes
        .iter()
        .map(|scope| format!("\"{}\"", scope.as_str()))
        .collect();
    format!("[{}]", names.join(","))
}

fn text(value: &str) -> Option<Value> {
    Some(Value::Text(value.to_owned()))
}

fn integer(value: i64) -> Option<Value> {
    Some(Value::Integer(value))
}

fn opt_integer(value: Option<i64>) -> Option<Value> {
    value.map(Value::Integer)
}

fn opt_text(value: Option<&str>) -> Option<Value> {
    value.map(|text| Value::Text(text.to_owned()))
}
#[cfg(test)]
mod tests {
    //! Ports `apps/daemon/src/device-links.test.ts` (ADR 0115's one device for receipts), plus
    //! `devices.ts`' own install folding and revocation, which `remote-auth`'s re-pairing case
    //! and `owners`' remove-device cases drive in TypeScript.

    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use std::sync::{Arc, Mutex};

    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    use super::{
        Devices, PairingLinkProof, Scope, active_device, allows_scopes, generation_of, hash,
    };
    use crate::CredentialRuntime;

    const ACCOUNT: &str = "account-phone";
    /// `linkedLimit` (`@ace/notify`'s `worker-wire.ts:17`).
    const LINKED_LIMIT: usize = 16;

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

    /// `pairingLinkProof`: base64url HMAC-SHA256 keyed by the token's SHA-256.
    fn proof(token: &str, device_id: &str, account: &str) -> PairingLinkProof {
        let mut mac =
            <Hmac<Sha256> as hmac::digest::KeyInit>::new_from_slice(hash(token).as_bytes())
                .unwrap();
        mac.update(format!("ace-link/v1\n{device_id}\n{account}").as_bytes());
        PairingLinkProof {
            device_id: device_id.to_owned(),
            proof: base64::Engine::encode(
                &base64::engine::general_purpose::URL_SAFE_NO_PAD,
                mac.finalize().into_bytes(),
            ),
        }
    }

    fn cap_linked(linked: Vec<String>, limit: usize) -> (Vec<String>, usize) {
        let cut = linked.len().saturating_sub(limit);
        (linked.into_iter().take(limit).collect(), cut)
    }

    #[test]
    fn a_pairing_and_the_account_device_that_proved_it_list_each_other_as_the_same_device() {
        let (devices, _home) = devices();
        let paired = devices
            .create(
                "Phone",
                &[Scope::Read, Scope::Operate],
                1_000,
                None,
                None,
                false,
                None,
            )
            .unwrap();
        let other = devices
            .create("Laptop", &[Scope::Read], 1_000, None, None, false, None)
            .unwrap();
        let proof = proof(&paired.1, &paired.0.id, ACCOUNT);
        assert!(devices.linked(ACCOUNT, 1_000).unwrap().is_empty());
        assert!(devices.link(ACCOUNT, &proof, 1_000).unwrap());
        assert_eq!(
            devices.linked(ACCOUNT, 1_000).unwrap(),
            vec![paired.0.id.clone()]
        );
        assert_eq!(
            devices.linked(&paired.0.id, 1_000).unwrap(),
            vec![ACCOUNT.to_owned()]
        );
        assert!(devices.linked(&other.0.id, 1_000).unwrap().is_empty());
        assert!(devices.same_install(ACCOUNT, &paired.0.id).unwrap());
        assert!(!devices.same_install(&other.0.id, &paired.0.id).unwrap());
    }

    #[test]
    fn a_revoked_pairing_is_nobodys_other_id() {
        let (devices, _home) = devices();
        let paired = devices
            .create(
                "Phone",
                &[Scope::Read, Scope::Operate],
                1_000,
                None,
                None,
                false,
                None,
            )
            .unwrap();
        let proof = proof(&paired.1, &paired.0.id, ACCOUNT);
        assert!(devices.link(ACCOUNT, &proof, 1_000).unwrap());
        assert!(devices.revoke(&paired.0.id, 2_000).unwrap());
        assert!(devices.linked(ACCOUNT, 3_000).unwrap().is_empty());
        assert!(devices.linked(&paired.0.id, 3_000).unwrap().is_empty());
    }

    #[test]
    fn the_pairing_a_phone_used_most_recently_survives_the_cap_on_linked_ids() {
        let (devices, _home) = devices();
        let mut pairings = Vec::new();
        for index in 0..LINKED_LIMIT + 4 {
            let paired = devices
                .create(
                    &format!("Phone {index}"),
                    &[Scope::Read],
                    1_000 + index as i64,
                    None,
                    None,
                    false,
                    None,
                )
                .unwrap();
            let proof = proof(&paired.1, &paired.0.id, ACCOUNT);
            assert!(devices.link(ACCOUNT, &proof, 1_000 + index as i64).unwrap());
            pairings.push(paired.0.id);
        }
        // Sorted by id this one would be cut; it was seen last, so it stays.
        let mut sorted = pairings.clone();
        sorted.sort();
        let last_used = sorted.last().unwrap().clone();
        devices.touch(&last_used, 5_000).unwrap();
        let linked = devices.linked(&pairings[0], 6_000).unwrap();
        assert_eq!(linked[0], ACCOUNT);
        let (kept, cut) = cap_linked(devices.linked(ACCOUNT, 6_000).unwrap(), LINKED_LIMIT);
        assert_eq!(kept.len(), LINKED_LIMIT);
        assert_eq!(kept[0], last_used);
        assert_eq!(cut, 4);
    }

    #[test]
    fn an_account_hello_that_proves_a_pairing_counts_as_that_pairings_use() {
        let (devices, _home) = devices();
        let registering = devices
            .create("Phone", &[Scope::Read], 1_000, None, None, false, None)
            .unwrap();
        let registering_proof = proof(&registering.1, &registering.0.id, ACCOUNT);
        assert!(devices.link(ACCOUNT, &registering_proof, 1_000).unwrap());
        for index in 0..LINKED_LIMIT + 2 {
            let other = devices
                .create(
                    &format!("Other {index}"),
                    &[Scope::Read],
                    2_000 + index as i64,
                    None,
                    None,
                    false,
                    None,
                )
                .unwrap();
            let other_proof = proof(&other.1, &other.0.id, ACCOUNT);
            assert!(
                devices
                    .link(ACCOUNT, &other_proof, 2_000 + index as i64)
                    .unwrap()
            );
        }
        // Its hello again, after all of them.
        assert!(devices.link(ACCOUNT, &registering_proof, 9_000).unwrap());
        let (kept, _) = cap_linked(devices.linked(ACCOUNT, 9_500).unwrap(), LINKED_LIMIT);
        assert_eq!(kept[0], registering.0.id);
    }

    #[test]
    fn a_link_proof_that_does_not_match_links_nothing() {
        let (devices, _home) = devices();
        let paired = devices
            .create("Phone", &[Scope::Read], 1_000, None, None, false, None)
            .unwrap();
        let mut wrong = proof(&paired.1, &paired.0.id, ACCOUNT);
        wrong.proof = "A".repeat(43);
        assert!(!devices.link(ACCOUNT, &wrong, 1_000).unwrap());
        // The same device can't prove itself an account device.
        let own = proof(&paired.1, &paired.0.id, &paired.0.id);
        assert!(!devices.link(&paired.0.id, &own, 1_000).unwrap());
    }

    #[test]
    fn a_credential_generation_names_the_token_and_a_rekey_ends_the_old_one() {
        let (devices, _home) = devices();
        let first = devices
            .create(
                "Phone",
                &[Scope::Read],
                1_000,
                None,
                Some("install-0001"),
                false,
                None,
            )
            .unwrap();
        let generation = devices
            .authenticate(&first.1, 1_000)
            .unwrap()
            .unwrap()
            .generation;
        assert_eq!(generation, generation_of(&hash(&first.1)));
        assert!(
            devices
                .current(&first.0.id, Some(&generation), 1_000)
                .unwrap()
                .is_some()
        );
        assert!(
            devices
                .current(&first.0.id, Some("someone-else"), 1_000)
                .unwrap()
                .is_none()
        );
        let again = devices
            .create(
                "Phone",
                &[Scope::Read, Scope::Operate],
                2_000,
                None,
                Some("install-0001"),
                false,
                None,
            )
            .unwrap();
        assert_eq!(again.0.id, first.0.id);
        assert!(devices.authenticate(&first.1, 2_000).unwrap().is_none());
        assert!(
            devices
                .current(&first.0.id, Some(&generation), 2_000)
                .unwrap()
                .is_none()
        );
        assert!(devices.authenticate(&again.1, 2_000).unwrap().is_some());
    }

    #[test]
    fn an_install_folds_the_records_it_left_behind_only_when_the_survivor_holds_their_scopes() {
        let (devices, _home) = devices();
        // Two records from before installs had ids: same name, older, not local-only.
        let orphan = devices
            .create("Phone", &[Scope::Read], 1_000, None, None, false, None)
            .unwrap();
        let survivor = devices
            .create("Phone", &[Scope::Read], 2_000, None, None, false, None)
            .unwrap();
        // A record with a scope the survivor lacks is never folded: folding takes no access away.
        let wider = devices
            .create(
                "Phone",
                &[Scope::Read, Scope::Operate],
                1_000,
                None,
                None,
                false,
                None,
            )
            .unwrap();
        devices
            .recognize(&survivor.0.id, "install-0001", 3_000)
            .unwrap();
        let listed: Vec<String> = devices
            .list()
            .unwrap()
            .into_iter()
            .map(|device| device.id)
            .collect();
        assert_eq!(listed, vec![wider.0.id.clone(), survivor.0.id.clone()]);
        // A folded record used again comes back on its own.
        assert!(devices.authenticate(&orphan.1, 4_000).unwrap().is_some());
        let listed: Vec<String> = devices
            .list()
            .unwrap()
            .into_iter()
            .map(|device| device.id)
            .collect();
        assert!(listed.contains(&orphan.0.id));
    }

    #[test]
    fn revoking_a_device_revokes_the_records_folded_into_it_and_tells_each_listener() {
        let (devices, _home) = devices();
        let survivor = devices
            .create("Phone", &[Scope::Read], 1_000, None, None, false, None)
            .unwrap();
        devices
            .recognize(&survivor.0.id, "install-0001", 2_000)
            .unwrap();
        let heard = Arc::new(Mutex::new(Vec::new()));
        let recorder = Arc::clone(&heard);
        devices
            .on_revoke(Arc::new(move |id: &str| {
                recorder.lock().unwrap().push(id.to_owned())
            }))
            .unwrap();
        assert_eq!(
            devices.revoke_install(&survivor.0.id, 3_000).unwrap(),
            vec![survivor.0.id.clone()]
        );
        assert_eq!(*heard.lock().unwrap(), vec![survivor.0.id.clone()]);
        assert!(
            devices
                .revoke_install(&survivor.0.id, 4_000)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn expiry_is_not_revocation_and_scope_changes_keep_the_credential() {
        let (devices, _home) = devices();
        let device = devices
            .create(
                "Phone",
                &[Scope::Read],
                1_000,
                Some(2_000),
                None,
                false,
                None,
            )
            .unwrap();
        assert!(active_device(Some(&device.0), 1_999));
        assert!(!active_device(Some(&device.0), 2_000));
        let listed = devices.list().unwrap();
        assert_eq!(listed[0].revoked_at, None);
        let changed = devices
            .set_scopes(
                &device.0.id,
                &[Scope::Read, Scope::Read, Scope::Operate],
                1_500,
            )
            .unwrap()
            .unwrap();
        assert_eq!(changed.scopes, vec![Scope::Read, Scope::Operate]);
        assert!(devices.authenticate(&device.1, 1_500).unwrap().is_some());
        // After expiry the credential authenticates nothing, but the row is not revoked.
        assert!(devices.authenticate(&device.1, 2_000).unwrap().is_none());
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
