// SPDX-License-Identifier: Apache-2.0
//! `RemoteAuth`, ported from `apps/daemon/src/remote-auth.ts`: the host token, paired devices'
//! bearers and tickets, single-use pairing links with their refusals, and the listeners that
//! close what a revoked or re-paired device opened. The clock, secrets and ids are injected;
//! tickets live in memory, so a restart voids them, while pairing links persist if their store
//! does.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use crate::devices::{
    Device, Devices, PairedDevice, PairingLinkProof, Scope, SessionActor, active_device, allows,
    hash,
};
use crate::error::{AuthError, Result};
use crate::pairing::{
    MemoryPairingCodes, PairingCodeStore, PairingTerms, PendingCode, PendingPairing, scope_label,
};
use crate::tickets::{IssueError, TicketBinding, TicketLimits, TicketPool, default_ticket_limits};
use crate::token::valid_token;
use crate::{Runtime, pairing::IssuedPairing};

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

    /// A single-use pairing code. Callers check the creator may grant `granted` first.
    pub fn pairing(&mut self, granted: &[Scope], terms: &PairingTerms) -> Result<PairingTicket> {
        if granted.iter().any(|scope| !scope.pairable()) {
            return Err(AuthError::access(403, "Desktop credentials are local only"));
        }
        if self.codes.pending(self.now())?.len() >= 100 {
            return Err(AuthError::access(429, "Too many pending pairings"));
        }
        let code = self.runtime.secret();
        let id = self.runtime.id();
        let time = self.now();
        let expires_at = time + terms.ttl_ms.unwrap_or(300_000);
        self.codes.put(
            &hash(&code),
            &PendingCode {
                id: id.clone(),
                expires_at,
                scopes: granted.to_vec(),
                label: terms.label.clone().filter(|label| !label.is_empty()),
                device_ttl_ms: terms.device_ttl_ms.filter(|ttl| *ttl != 0),
                person: terms.person,
            },
        )?;
        Ok(PairingTicket {
            id,
            code,
            expires_at,
        })
    }

    /// Links not yet redeemed or expired, oldest first. Never their codes.
    pub fn pending_pairings(&mut self) -> Result<Vec<PendingPairing>> {
        Ok(self
            .codes
            .pending(self.now())?
            .iter()
            .map(PendingPairing::from)
            .collect())
    }

    /// The machine's owner changed (ADR 0190): no paired device is the person's, and no link a
    /// person made can still be redeemed. The devices stay paired, with their other access.
    pub fn drop_person_standing(&mut self) -> Result<()> {
        self.devices.clear_person()?;
        for pending in self.codes.pending(self.now())? {
            if pending.person {
                self.codes.remove(&pending.id)?;
            }
        }
        Ok(())
    }

    /// False when no pending link has that id.
    pub fn cancel_pairing(&mut self, id: &str) -> Result<bool> {
        self.codes.remove(id)
    }

    pub fn pairing_attempt(&mut self, address: &str) -> Result<()> {
        self.limit(address)?;
        self.limit("*")
    }

    /// Redeem a pairing; the same app install keeps its one record (ADR 0115).
    pub fn redeem(
        &mut self,
        code: &str,
        name: &str,
        install_id: Option<&str>,
        standing_key: Option<&str>,
    ) -> Result<RedeemedDevice> {
        let pairing = self.codes.take(&hash(code))?;
        let Some(pairing) = pairing else {
            return Err(AuthError::access(401, "Invalid or expired pairing code"));
        };
        let at = self.now();
        if pairing.expires_at <= at {
            return Err(AuthError::access(401, "Invalid or expired pairing code"));
        }
        let held = match install_id {
            Some(install) => self.devices.held_by(install, at)?,
            None => None,
        };
        let (device, token) = self.devices.create(
            pairing.label.as_deref().unwrap_or(name),
            &pairing.scopes,
            at,
            pairing.device_ttl_ms.map(|ttl| at + ttl),
            install_id,
            pairing.person,
            standing_key,
        )?;
        // The install's record got a new credential and scopes: what the old one opened ends.
        if let Some(held) = held {
            self.tickets.revoke(&held);
            for listener in self.listeners(&self.replaced) {
                listener(&held);
            }
        }
        Ok(RedeemedDevice { device, token })
    }

    /// An ace account device was admitted: its account device id is its install id (ADR 0115).
    pub fn account_device_seen(
        &mut self,
        device_id: &str,
        link: Option<&PairingLinkProof>,
    ) -> Result<()> {
        self.devices.seen(device_id, self.now())?;
        if let Some(link) = link {
            self.devices.link(device_id, link, self.now())?;
        }
        Ok(())
    }

    /// A paired device's hello named its app install: its records fold into one (ADR 0115).
    pub fn recognize(&mut self, device: &Device, install_id: Option<&str>) -> Result<()> {
        if let Some(install) = install_id {
            self.devices.recognize(&device.id, install, self.now())?;
        }
        Ok(())
    }

    pub fn ticket(&mut self, device: &PairedDevice, epoch: &str) -> Result<HandedTicket> {
        if device.device.scopes.iter().any(|scope| !scope.pairable()) {
            return Err(AuthError::access(403, "Desktop credentials are local only"));
        }
        let ticket = self.runtime.secret();
        let now = self.now();
        let allocation = self
            .tickets
            .issue(
                &hash(&ticket),
                &device.device.id,
                &device.generation,
                now,
                epoch,
            )
            .map_err(|error: IssueError| AuthError::access(429, error.message()))?;
        Ok(HandedTicket {
            ticket,
            expires_at: allocation.expires_at,
        })
    }

    /// The next ticket for a paired device whose socket just opened with one (`remote-auth.ts:197`).
    pub fn hand_over(&mut self, actor: &SessionActor, epoch: &str) -> Option<HandedOver> {
        if !actor.revocable {
            return None;
        }
        let generation = actor.generation.clone()?;
        let device = PairedDevice {
            device: actor.device.clone(),
            generation,
            person: actor.person == Some(true),
        };
        let issued = self.ticket(&device, epoch).ok()?;
        Some(HandedOver {
            ticket: issued.ticket,
            ttl_ms: issued.expires_at - self.now(),
        })
    }

    /// The ticket is consumed first, then its device is checked (`remote-auth.ts:209`).
    pub fn consume(&mut self, ticket: &str) -> Option<PairedDevice> {
        let now = self.now();
        let issued = self.tickets.consume(&hash(ticket), now, None)?;
        let device = self
            .devices
            .current(&issued.device_id, Some(&issued.generation), now)
            .ok()
            .flatten()?;
        if local_only(&device.device) {
            return None;
        }
        self.devices.touch(&device.device.id, now).ok()?;
        Some(device)
    }

    /// A ticket in an NK first message (`remote-auth.ts:224`): the epoch and claimed device are
    /// checked before it is taken, so a message that would be refused spends nothing, and
    /// nothing about the device is recorded until the client's confirmation (`touch`).
    pub fn consume_early(
        &mut self,
        ticket: &str,
        epoch: &str,
        device_id: &str,
    ) -> Option<PairedDevice> {
        let now = self.now();
        let issued =
            self.tickets
                .consume(&hash(ticket), now, Some(TicketBinding { epoch, device_id }))?;
        let device = self
            .devices
            .current(&issued.device_id, Some(&issued.generation), now)
            .ok()
            .flatten()?;
        if local_only(&device.device) {
            return None;
        }
        Some(device)
    }

    /// A paired device whose NK session confirmed was seen now.
    pub fn touch(&mut self, device: &Device) -> Result<()> {
        self.devices.touch(&device.id, self.now())
    }

    /// A paired device's credential was replaced by pairing the same install again.
    pub fn clear_pending(&mut self) -> Result<()> {
        self.codes.clear()?;
        self.tickets = TicketPool::new(self.ticket_limits);
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<Device>> {
        self.devices.list()
    }

    /// Allow or stop allowing `scope` for paired device `id`, keeping its credential.
    pub fn set_scope(&mut self, id: &str, scope: Scope, allowed: bool) -> Result<Device> {
        let at = self.now();
        let device = self.devices.get(id)?;
        let Some(device) = device else {
            return Err(not_paired());
        };
        if device.revoked_at.is_some() || !active_device(Some(&device), at) {
            return Err(not_paired());
        }
        if local_only(&device) || !scope.pairable() {
            return Err(AuthError::access(
                403,
                "This machine's own credentials can't change here.",
            ));
        }
        let mut scopes = device.scopes.clone();
        if allowed {
            if !scopes.contains(&scope) {
                scopes.push(scope);
            }
        } else {
            scopes.retain(|each| *each != scope);
        }
        if scopes.is_empty() {
            return Err(AuthError::access(
                400,
                "A device keeps at least one kind of access. Remove it instead.",
            ));
        }
        self.devices
            .set_scopes(id, &scopes, at)?
            .ok_or_else(not_paired)
    }

    /// Revoke `id` and every record folded into it (ADR 0115).
    pub fn revoke(&mut self, id: &str) -> Result<bool> {
        let revoked = self.devices.revoke_install(id, self.now())?;
        for each in &revoked {
            self.tickets.revoke(each);
            for listener in self.listeners(&self.revoked) {
                listener(each);
            }
        }
        Ok(!revoked.is_empty())
    }

    /// Revoke every paired device but `keep` and the daemon's local credentials.
    pub fn revoke_others(&mut self, keep: Option<&str>) -> Result<usize> {
        let mut count = 0;
        for device in self.devices.list()? {
            if Some(device.id.as_str()) != keep
                && device.revoked_at.is_none()
                && !local_only(&device)
                && self.revoke(&device.id)?
            {
                count += 1;
            }
        }
        Ok(count)
    }

    pub fn on_revoke(&self, listener: Listener) -> std::result::Result<u64, String> {
        self.subscribe(&self.revoked, listener, "Device revocation")
    }

    pub fn on_credential_replaced(&self, listener: Listener) -> std::result::Result<u64, String> {
        self.subscribe(&self.replaced, listener, "Device replacement")
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

    fn limit(&mut self, address: &str) -> Result<()> {
        let now = self.now();
        self.attempts.retain(|_, entry| entry.resets_at > now);
        let cap = if address == "*" { 100 } else { 5 };
        let over_global = self.attempts.len() >= 10_000;
        match self.attempts.get_mut(address) {
            Some(entry) => {
                entry.count += 1;
                if over_global || entry.count > cap {
                    return Err(AuthError::access(429, "Pairing rate limit exceeded"));
                }
            }
            None => {
                if over_global || 1 > cap {
                    return Err(AuthError::access(429, "Pairing rate limit exceeded"));
                }
                self.attempts.insert(
                    address.to_owned(),
                    Attempt {
                        count: 1,
                        resets_at: now + 60_000,
                    },
                );
            }
        }
        Ok(())
    }

    /// The scopes a pairing link may grant, for a refusal that names the first missing one.
    pub fn missing_scope(granted: &[Scope], holds: impl Fn(Scope) -> bool) -> Option<Scope> {
        granted.iter().copied().find(|scope| !holds(*scope))
    }

    /// The scope names a refusal quotes (`pairing-issue.ts:26`).
    pub fn scope_label(scope: Scope) -> &'static str {
        scope_label(scope)
    }
}

fn not_paired() -> AuthError {
    AuthError::access(404, "That device isn't paired anymore.")
}

/// A device the daemon only mints itself: the desktop app's, and "Use my Chrome" (`remote-auth.ts:36`).
fn local_only(device: &Device) -> bool {
    device
        .scopes
        .iter()
        .any(|scope| matches!(scope, Scope::Desktop | Scope::UserBrowser))
}

/// Dedupe scopes in request order, as `[...new Set(requested)]` does.
pub fn unique_scopes(scopes: &[Scope]) -> Vec<Scope> {
    let mut seen = HashSet::new();
    scopes
        .iter()
        .copied()
        .filter(|scope| seen.insert(*scope))
        .collect()
}

/// Issue a pairing link (`pairing-issue.ts:43`): the connection, the request, the creator's
/// authority, and the URL the person opens.
pub fn issue_pairing(
    auth: &mut RemoteAuth,
    connection: Option<&crate::pairing::PairingConnection>,
    input: Option<&ace_json::Value>,
    holds: impl Fn(Scope) -> bool,
    person: bool,
    app: Option<&str>,
) -> Result<IssuedPairing> {
    let Some(connection) = connection else {
        return Err(AuthError::access(
            409,
            "Turn on remote access in Settings, then choose LAN or Tailscale to pair.",
        ));
    };
    let request = input
        .and_then(crate::pairing::PairingRequest::parse)
        .ok_or_else(|| AuthError::access(400, "Invalid scopes"))?;
    let scopes = unique_scopes(&request.scopes);
    if let Some(missing) = RemoteAuth::missing_scope(&scopes, holds) {
        return Err(AuthError::access(
            403,
            format!(
                "You can't grant {}: this device doesn't have it.",
                scope_label(missing)
            ),
        ));
    }
    let terms = PairingTerms {
        label: request.label.clone(),
        ttl_ms: request.ttl_ms,
        device_ttl_ms: request.device_ttl_ms,
        person,
    };
    let issued = auth.pairing(&scopes, &terms)?;
    let url = crate::pairing::pairing_link_url(connection, &issued.code, &scopes, app);
    Ok(IssuedPairing {
        id: issued.id,
        url,
        code: issued.code,
        expires_at: issued.expires_at,
    })
}
#[cfg(test)]
mod tests {
    //! Ports, at `RemoteAuth`'s own surface:
    //! - `apps/daemon/src/pairing-codes.process.test.ts` (a home restarted between starts);
    //! - `apps/daemon/src/remote-boundaries.server.process.test.ts`'s redemption rate limits,
    //!   fabricated tokens and scope injection;
    //! - `apps/daemon/src/relay-nk/tickets.test.ts` (epoch-bound, one-use, revocation, touch);
    //! - `apps/daemon/src/handed-ticket.server.process.test.ts` (handover, one use, revocation);
    //! - `apps/daemon/src/ticket-allocation.server.process.test.ts`'s route refusals (429);
    //! - `apps/daemon/src/fleet-access.server.process.test.ts`'s pairing ceilings, listing,
    //!   cancellation, `revokeOthers` and scope changes.

    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    use super::{RedeemedDevice, RemoteAuth, issue_pairing, unique_scopes};
    use crate::devices::{Devices, Scope, SessionActor};
    use crate::pairing::{MemoryPairingCodes, PairingConnection, PairingTerms, SqlitePairingCodes};
    use crate::tickets::{TicketLimits, default_ticket_limits};
    use crate::{CredentialRuntime, Runtime};

    fn pair_with(
        auth: &mut RemoteAuth,
        scopes: &[Scope],
        name: &str,
        install: Option<&str>,
        standing: Option<&str>,
    ) -> RedeemedDevice {
        let code = auth.pairing(scopes, &PairingTerms::default()).unwrap().code;
        auth.redeem(&code, name, install, standing).unwrap()
    }

    struct Home {
        _directory: tempfile::TempDir,
        path: PathBuf,
        clock: Arc<Mutex<i64>>,
        secrets: Arc<Mutex<u64>>,
    }

    impl Home {
        fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("events.sqlite");
            Self {
                _directory: directory,
                path,
                clock: Arc::new(Mutex::new(1_000_000)),
                secrets: Arc::new(Mutex::new(0)),
            }
        }

        fn advance(&self, milliseconds: i64) {
            *self.clock.lock().unwrap() += milliseconds;
        }

        fn runtime(&self) -> Runtime {
            let clock = Arc::clone(&self.clock);
            let secrets = Arc::clone(&self.secrets);
            let ids = Arc::new(Mutex::new(0_u64));
            Runtime::new(
                move || *clock.lock().unwrap(),
                move || {
                    let mut secret = secrets.lock().unwrap();
                    *secret += 1;
                    format!("{secret:064}")
                },
                move || {
                    let mut id = ids.lock().unwrap();
                    *id += 1;
                    format!("pairing-{id}")
                },
            )
        }

        fn devices(&self) -> Devices {
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
            Devices::open(self.path.to_str().unwrap(), runtime).unwrap()
        }

        /// Each start is a new daemon process over the same database file.
        fn start(&self) -> RemoteAuth {
            self.start_with(default_ticket_limits())
        }

        fn start_with(&self, limits: TicketLimits) -> RemoteAuth {
            let devices = self.devices();
            let codes = SqlitePairingCodes::new(devices.connection().clone()).unwrap();
            RemoteAuth::new(
                devices,
                "aa".repeat(32),
                self.runtime(),
                limits,
                Box::new(codes),
            )
        }

        fn memory(&self) -> RemoteAuth {
            RemoteAuth::new(
                self.devices(),
                "aa".repeat(32),
                self.runtime(),
                default_ticket_limits(),
                Box::new(MemoryPairingCodes::new()),
            )
        }
    }

    #[test]
    fn a_pairing_link_issued_before_a_restart_still_pairs_once_afterwards() {
        let home = Home::new();
        let issued = home
            .start()
            .pairing(
                &[Scope::Read, Scope::Operate],
                &PairingTerms {
                    label: Some("Phone".to_owned()),
                    ..Default::default()
                },
            )
            .unwrap();
        let mut restarted = home.start();
        assert_eq!(
            restarted
                .pending_pairings()
                .unwrap()
                .iter()
                .map(|code| code.id.clone())
                .collect::<Vec<_>>(),
            vec![issued.id.clone()]
        );
        let paired = restarted
            .redeem(&issued.code, "ignored", None, None)
            .unwrap();
        assert_eq!(paired.device.name, "Phone");
        assert_eq!(paired.device.scopes, vec![Scope::Read, Scope::Operate]);
        // Single use, across restarts too.
        let error = home
            .start()
            .redeem(&issued.code, "Second", None, None)
            .unwrap_err();
        assert_eq!(error.message(), "Invalid or expired pairing code");
    }

    #[test]
    fn a_link_still_ends_at_its_own_expiry_across_a_restart() {
        let home = Home::new();
        let issued = home
            .start()
            .pairing(
                &[Scope::Read],
                &PairingTerms {
                    ttl_ms: Some(60_000),
                    ..Default::default()
                },
            )
            .unwrap();
        home.advance(60_000);
        let mut restarted = home.start();
        assert!(restarted.pending_pairings().unwrap().is_empty());
        assert_eq!(
            restarted
                .redeem(&issued.code, "Phone", None, None)
                .unwrap_err()
                .message(),
            "Invalid or expired pairing code"
        );
    }

    #[test]
    fn the_database_holds_only_the_codes_hash_and_a_cancelled_link_pairs_nothing() {
        let home = Home::new();
        let mut auth = home.start();
        let kept = auth
            .pairing(&[Scope::Read], &PairingTerms::default())
            .unwrap();
        let cancelled = auth
            .pairing(&[Scope::Read], &PairingTerms::default())
            .unwrap();
        let conn = auth.devices().connection().clone();
        let statement = conn
            .prepare("SELECT code_hash, id, label FROM pairing_codes")
            .unwrap();
        let mut stored = String::new();
        while let Some(values) = statement.step().unwrap() {
            stored.push_str(&format!("{values:?}"));
        }
        assert!(!stored.contains(&kept.code), "{stored}");
        assert!(auth.cancel_pairing(&cancelled.id).unwrap());
        let mut restarted = home.start();
        assert_eq!(
            restarted
                .redeem(&cancelled.code, "Phone", None, None)
                .unwrap_err()
                .message(),
            "Invalid or expired pairing code"
        );
        assert_eq!(
            restarted
                .redeem(&kept.code, "Phone", None, None)
                .unwrap()
                .device
                .scopes,
            vec![Scope::Read]
        );
    }

    #[test]
    fn redemption_attempts_are_limited_per_address_and_globally_and_reset_after_a_minute() {
        let home = Home::new();
        let mut auth = home.memory();
        // Five attempts per source address, 100 overall: 100 attempts from 20 addresses pass.
        for attempt in 0..100 {
            auth.pairing_attempt(&format!("source-{}", attempt / 5))
                .expect("inside both windows");
        }
        let error = auth
            .pairing_attempt("source-20")
            .expect_err("the global budget is spent");
        assert_eq!(error.status(), 429);
        assert_eq!(error.message(), "Pairing rate limit exceeded");
        home.advance(60_000);
        auth.pairing_attempt("source-20")
            .expect("the window resets after a minute");
    }

    #[test]
    fn a_ticket_opens_one_nk_session_only_under_its_relay_key_and_for_its_own_device() {
        let home = Home::new();
        let mut auth = home.memory();
        let paired = pair_with(&mut auth, &[Scope::Read], "Phone", None, None);
        let device = auth.device_bearer(&paired.token).unwrap();
        let actor = SessionActor::paired(device.clone());
        let first = auth.hand_over(&actor, "relay-key-a").unwrap().ticket;
        // Refused without being spent: under another key, or claimed by another device.
        assert!(
            auth.consume_early(&first, "relay-key-b", &device.device.id)
                .is_none()
        );
        assert!(
            auth.consume_early(&first, "relay-key-a", "another-device")
                .is_none()
        );
        assert_eq!(
            auth.consume_early(&first, "relay-key-a", &device.device.id)
                .expect("the matching binding")
                .device
                .id,
            device.device.id
        );
        assert!(
            auth.consume_early(&first, "relay-key-a", &device.device.id)
                .is_none()
        );
        // One handed on the direct path is bound to no relay key.
        let direct = auth.hand_over(&actor, "").unwrap().ticket;
        assert!(
            auth.consume_early(&direct, "relay-key-a", &device.device.id)
                .is_none()
        );
    }

    #[test]
    fn revoking_the_device_voids_its_outstanding_tickets_and_a_ticket_lives_sixty_seconds() {
        let home = Home::new();
        let mut auth = home.memory();
        let paired = pair_with(&mut auth, &[Scope::Read], "Phone", None, None);
        let device = auth.device_bearer(&paired.token).unwrap();
        let actor = SessionActor::paired(device.clone());
        let kept = auth.hand_over(&actor, "key").unwrap().ticket;
        let late = auth.hand_over(&actor, "key").unwrap().ticket;
        home.advance(60_001);
        assert!(
            auth.consume_early(&late, "key", &device.device.id)
                .is_none()
        );
        let fresh = auth.hand_over(&actor, "key").unwrap().ticket;
        assert!(auth.revoke(&device.device.id).unwrap());
        assert!(
            auth.consume_early(&fresh, "key", &device.device.id)
                .is_none()
        );
        assert!(
            auth.consume_early(&kept, "key", &device.device.id)
                .is_none()
        );
    }

    #[test]
    fn an_early_ticket_records_nothing_about_the_device_until_it_is_touched() {
        let home = Home::new();
        let mut auth = home.memory();
        let paired = pair_with(&mut auth, &[Scope::Read], "Phone", None, None);
        let device = auth.device_bearer(&paired.token).unwrap();
        let actor = SessionActor::paired(device.clone());
        let seen = |auth: &RemoteAuth| {
            auth.list()
                .unwrap()
                .into_iter()
                .find(|each| each.id == device.device.id)
                .unwrap()
                .last_seen_at
        };
        let before = seen(&auth);
        home.advance(5_000);
        let ticket = auth.hand_over(&actor, "key").unwrap().ticket;
        let consumed = auth
            .consume_early(&ticket, "key", &device.device.id)
            .expect("a valid early ticket");
        assert_eq!(seen(&auth), before);
        auth.touch(&consumed.device).unwrap();
        assert_ne!(seen(&auth), before);
    }

    #[test]
    fn a_handed_ticket_opens_the_next_socket_once_and_a_revocation_voids_it() {
        let home = Home::new();
        let mut auth = home.memory();
        let paired = pair_with(&mut auth, &[Scope::Projects], "Phone", None, None);
        let device = auth.device_bearer(&paired.token).unwrap();
        let actor = SessionActor::paired(device.clone());
        let first = auth
            .hand_over(&actor, "")
            .expect("a paired device gets one");
        assert!(first.ttl_ms > 0 && first.ttl_ms <= 60_000);
        // The next connect skips the exchange, and hands over another.
        let next = auth
            .consume(&first.ticket)
            .expect("the handed ticket opens the next socket");
        let second = auth
            .hand_over(&SessionActor::paired(next), "")
            .expect("the next connection gets one too");
        assert_ne!(second.ticket, first.ticket);
        assert!(auth.consume(&first.ticket).is_none());
        // Revoking voids the ticket its last welcome handed over.
        auth.revoke(&device.device.id).unwrap();
        assert!(auth.consume(&second.ticket).is_none());
    }

    #[test]
    fn a_client_that_does_not_ask_or_is_not_paired_gets_no_ticket() {
        let home = Home::new();
        let mut auth = home.memory();
        let host = SessionActor::host(crate::devices::Device {
            id: "device".to_owned(),
            name: "Host".to_owned(),
            scopes: vec![Scope::Admin, Scope::Projects, Scope::Accounts],
            created_at: 0,
            last_seen_at: 1_000_000,
            revoked_at: None,
            expires_at: None,
        });
        assert!(auth.hand_over(&host, "").is_none());
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

    #[test]
    fn a_device_that_pairs_its_install_again_keeps_its_record_and_replaces_its_credential() {
        let home = Home::new();
        let mut auth = home.memory();
        let first = pair_with(
            &mut auth,
            &[Scope::Read],
            "Phone",
            Some("install-0001"),
            None,
        );
        let replaced = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&replaced);
        auth.on_credential_replaced(Arc::new(move |id: &str| {
            recorded.lock().unwrap().push(id.to_owned())
        }))
        .unwrap();
        let old_ticket = auth
            .ticket(&auth.device_bearer(&first.token).unwrap(), "")
            .unwrap();
        let again = pair_with(
            &mut auth,
            &[Scope::Read, Scope::Operate],
            "Phone",
            Some("install-0001"),
            None,
        );
        assert_eq!(again.device.id, first.device.id);
        assert_eq!(again.device.scopes, vec![Scope::Read, Scope::Operate]);
        assert_eq!(*replaced.lock().unwrap(), vec![first.device.id.clone()]);
        // The old credential stops working, and its ticket with it.
        assert!(auth.device_bearer(&first.token).is_none());
        assert!(auth.consume(&old_ticket.ticket).is_none());
    }

    #[test]
    fn a_device_paired_for_a_day_loses_access_after_it_and_is_listed_as_expired_not_revoked() {
        let home = Home::new();
        let mut auth = home.memory();
        let day = 86_400_000;
        let issued = auth
            .pairing(
                &[Scope::Read],
                &PairingTerms {
                    device_ttl_ms: Some(day),
                    ..Default::default()
                },
            )
            .unwrap();
        let paired = auth.redeem(&issued.code, "Laptop", None, None).unwrap();
        assert_eq!(paired.device.expires_at, Some(1_000_000 + day));
        assert!(auth.device_bearer(&paired.token).is_some());
        home.advance(day + 1);
        assert!(auth.device_bearer(&paired.token).is_none());
        let listed = auth.list().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].revoked_at, None);
        assert_eq!(listed[0].expires_at, Some(1_000_000 + day));
    }

    #[test]
    fn a_device_cannot_grant_projects_or_accounts_it_does_not_hold() {
        let home = Home::new();
        let mut auth = home.memory();
        let request = ace_json::parse("{\"scopes\":[\"read\",\"accounts\"]}").unwrap();
        let error = issue_pairing(
            &mut auth,
            Some(&PairingConnection::Direct {
                origin: "https://host:4243".to_owned(),
                fingerprint: "a".repeat(64),
                also_relay: None,
            }),
            Some(&request),
            |scope| scope == Scope::Read,
            false,
            None,
        )
        .unwrap_err();
        assert_eq!(error.status(), 403);
        assert_eq!(
            error.message(),
            "You can't grant Accounts: this device doesn't have it."
        );
        // The host token holds every scope.
        let issued = issue_pairing(
            &mut auth,
            Some(&PairingConnection::Direct {
                origin: "https://host:4243".to_owned(),
                fingerprint: "a".repeat(64),
                also_relay: None,
            }),
            Some(&ace_json::parse("{\"scopes\":[\"projects\",\"accounts\"]}").unwrap()),
            |_| true,
            false,
            None,
        )
        .unwrap();
        let redeemed = auth.redeem(&issued.code, "Desk", None, None).unwrap();
        assert_eq!(
            redeemed.device.scopes,
            vec![Scope::Projects, Scope::Accounts]
        );
    }

    #[test]
    fn no_connection_or_an_invalid_request_is_refused_with_its_own_words() {
        let home = Home::new();
        let mut auth = home.memory();
        let error = issue_pairing(&mut auth, None, None, |_| true, false, None).unwrap_err();
        assert_eq!(error.status(), 409);
        assert_eq!(
            error.message(),
            "Turn on remote access in Settings, then choose LAN or Tailscale to pair."
        );
        let connection = PairingConnection::Direct {
            origin: "https://host:4243".to_owned(),
            fingerprint: "a".repeat(64),
            also_relay: None,
        };
        // Only the offered lifetimes are accepted.
        let request = ace_json::parse("{\"scopes\":[\"read\"],\"ttlMs\":123}").unwrap();
        let error = issue_pairing(
            &mut auth,
            Some(&connection),
            Some(&request),
            |_| true,
            false,
            None,
        )
        .unwrap_err();
        assert_eq!(error.status(), 400);
        assert_eq!(error.message(), "Invalid scopes");
        // Desktop and user-browser can't be granted by a link.
        let error = auth
            .pairing(&[Scope::Desktop], &PairingTerms::default())
            .unwrap_err();
        assert_eq!(error.status(), 403);
        assert_eq!(error.message(), "Desktop credentials are local only");
    }

    #[test]
    fn open_links_are_listed_without_codes_and_a_cancelled_one_no_longer_pairs() {
        let home = Home::new();
        let mut auth = home.memory();
        let kept = auth
            .pairing(
                &[Scope::Read],
                &PairingTerms {
                    label: Some("Phone".to_owned()),
                    ..Default::default()
                },
            )
            .unwrap();
        let cancelled = auth
            .pairing(
                &[Scope::Read, Scope::Operate],
                &PairingTerms {
                    device_ttl_ms: Some(604_800_000),
                    ..Default::default()
                },
            )
            .unwrap();
        let listed = auth.pending_pairings().unwrap();
        assert_eq!(listed.len(), 2);
        let text = format!("{listed:?}");
        assert!(!text.contains(&kept.code));
        assert!(!text.contains(&cancelled.code));
        assert_eq!(
            listed
                .iter()
                .find(|each| each.id == kept.id)
                .unwrap()
                .label
                .as_deref(),
            Some("Phone")
        );
        assert!(auth.cancel_pairing(&cancelled.id).unwrap());
        assert_eq!(
            auth.redeem(&cancelled.code, "Phone", None, None)
                .unwrap_err()
                .message(),
            "Invalid or expired pairing code"
        );
        assert!(!auth.cancel_pairing(&cancelled.id).unwrap());
        assert_eq!(auth.pending_pairings().unwrap().len(), 1);
    }

    #[test]
    fn revoking_every_other_device_spares_the_callers_own_and_ends_the_tickets() {
        let home = Home::new();
        let mut auth = home.memory();
        let phone = pair_with(&mut auth, &[Scope::Read], "Phone", None, None);
        let tablet = pair_with(&mut auth, &[Scope::Read], "Tablet", None, None);
        let mine = pair_with(&mut auth, &[Scope::Admin], "This", None, None);
        assert_eq!(auth.revoke_others(Some(&mine.device.id)).unwrap(), 2);
        assert!(auth.device_bearer(&phone.token).is_none());
        assert!(auth.device_bearer(&tablet.token).is_none());
        assert!(auth.device_bearer(&mine.token).is_some());
    }

    #[test]
    fn an_administrator_allows_a_scope_a_paired_device_holds_and_it_keeps_its_credential() {
        let home = Home::new();
        let mut auth = home.memory();
        let paired = pair_with(
            &mut auth,
            &[Scope::Read, Scope::Operate],
            "Phone",
            None,
            None,
        );
        let changed = auth
            .set_scope(&paired.device.id, Scope::Projects, true)
            .unwrap();
        assert_eq!(
            changed.scopes,
            vec![Scope::Read, Scope::Operate, Scope::Projects]
        );
        assert!(auth.device_bearer(&paired.token).is_some());
        // Removing its last scope is Remove, not a change.
        let changed = auth
            .set_scope(&paired.device.id, Scope::Projects, false)
            .unwrap();
        assert_eq!(changed.scopes, vec![Scope::Read, Scope::Operate]);
        auth.set_scope(&paired.device.id, Scope::Operate, false)
            .unwrap();
        let error = auth
            .set_scope(&paired.device.id, Scope::Read, false)
            .unwrap_err();
        assert_eq!(
            error.message(),
            "A device keeps at least one kind of access. Remove it instead."
        );
        let error = auth.set_scope("missing", Scope::Read, true).unwrap_err();
        assert_eq!(error.message(), "That device isn't paired anymore.");
    }

    #[test]
    fn a_ticket_route_refusal_names_the_quota_and_a_guest_gets_no_admin() {
        let home = Home::new();
        let mut auth = home.start_with(TicketLimits {
            global: 10_000,
            per_device: 1,
            per_minute: 120,
        });
        let paired = pair_with(&mut auth, &[Scope::Read], "Phone", None, None);
        let device = auth.device_bearer(&paired.token).unwrap();
        assert!(auth.ticket(&device, "").is_ok());
        let error = auth.ticket(&device, "").unwrap_err();
        assert_eq!(error.status(), 429);
        assert_eq!(error.message(), "Device ticket quota exceeded");
        // `requireAdmin` is the route's and the command lane's check.
        let actor = SessionActor::paired(auth.device_bearer(&paired.token).unwrap());
        assert_eq!(
            auth.require_admin(Some(&actor)).unwrap_err().message(),
            "Admin scope required"
        );
        assert!(
            unique_scopes(&[Scope::Read, Scope::Read, Scope::Operate])
                == vec![Scope::Read, Scope::Operate]
        );
    }

    #[test]
    fn clearing_pending_voids_tickets_and_links_but_not_devices() {
        let home = Home::new();
        let mut auth = home.memory();
        let paired = pair_with(&mut auth, &[Scope::Read], "Phone", None, None);
        let device = auth.device_bearer(&paired.token).unwrap();
        let ticket = auth.ticket(&device, "").unwrap();
        let link = auth
            .pairing(&[Scope::Read], &PairingTerms::default())
            .unwrap();
        auth.clear_pending().unwrap();
        assert!(auth.consume(&ticket.ticket).is_none());
        assert_eq!(
            auth.redeem(&link.code, "Phone", None, None)
                .unwrap_err()
                .message(),
            "Invalid or expired pairing code"
        );
        assert!(auth.device_bearer(&paired.token).is_some());
    }

    #[test]
    fn dropping_person_standing_unpersons_devices_and_ends_person_links() {
        let home = Home::new();
        let mut auth = home.memory();
        let personal = auth
            .pairing(
                &[Scope::Read],
                &PairingTerms {
                    person: true,
                    ..Default::default()
                },
            )
            .unwrap();
        let ordinary = auth
            .pairing(&[Scope::Read], &PairingTerms::default())
            .unwrap();
        let device = auth
            .redeem(&personal.code, "Phone", None, Some(&"A".repeat(43)))
            .unwrap();
        assert!(auth.device_bearer(&device.token).is_some());
        let personal_pending = auth
            .pairing(
                &[Scope::Read],
                &PairingTerms {
                    person: true,
                    ..Default::default()
                },
            )
            .unwrap();
        auth.drop_person_standing().unwrap();
        let pending = auth.pending_pairings().unwrap();
        assert!(pending.iter().all(|each| each.id != personal_pending.id));
        assert!(pending.iter().any(|each| each.id == ordinary.id));
    }

    #[test]
    fn a_hello_credential_in_a_dedicated_channel_still_needs_the_device_it_names() {
        // The channel is the transport's; what T2 guarantees is that a ticket names its device.
        let home = Home::new();
        let mut auth = home.memory();
        let paired = pair_with(&mut auth, &[Scope::Admin], "Viewer", None, None);
        let device = auth.device_bearer(&paired.token).unwrap();
        let ticket = auth.ticket(&device, "").unwrap().ticket;
        let hello = crate::hello::Hello {
            device_id: "another".to_owned(),
            token: None,
            ticket: Some(ticket),
            grant: None,
            install_id: None,
            channel: Some("devices".to_owned()),
            next_ticket: false,
        };
        assert!(
            crate::hello::hello_actor(&hello, &mut auth, false)
                .unwrap()
                .is_none()
        );
    }
}
