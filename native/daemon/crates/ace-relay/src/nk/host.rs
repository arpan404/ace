// SPDX-License-Identifier: Apache-2.0
//! The daemon's half of a relay stream opened with Noise NK (ADR 0155, step 2,
//! `apps/daemon/src/relay-nk/host.ts`). A first message is admitted only through
//! [`NkAdmission`]'s steps, and the credential check records nothing: a ticket is consumed in one
//! synchronous step (so one of two racing copies gets it), a grant is checked against cached keys
//! only. The session is unconfirmed until the client's `hello.confirm`; only then does the device
//! count as seen, its install fold and its link hold.

use std::sync::Arc;

use ace_auth::RemoteAuth;
use ace_auth::devices::{Device, Member, PairedDevice, Scope, SessionActor};
use ace_json::Value;
use zeroize::Zeroize;

use super::admission::{NkAdmission, NkSession};
use super::hello::{HelloConfirm, HelloEarly};

/// The account backend's cached verdict for a grant (`MachineAccount.admitDeviceCached`): an NK
/// first message never waits on the network, and a machine that asks for a code is answered by
/// refusing NK (the client's XX attempt carries the code as today).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountAdmission {
    pub admitted: bool,
    pub account: Option<String>,
    pub expires_at: Option<i64>,
}

/// What the host asks the account backend, never the network.
pub trait NkAccount: Send + Sync {
    fn admit_device_cached(&self, grant: &str, device_id: &str) -> AccountAdmission;
    fn still_admitted(&self, device_id: &str, account: &str) -> bool;
}

/// An admitted NK main channel, handed to the main-socket handler before it confirms.
pub struct NkAccepted {
    pub early: HelloEarly,
    pub actor: SessionActor,
    pub session: NkSession,
    pub paired: Option<PairedDevice>,
    pub still_admitted: Option<Box<dyn Fn() -> bool + Send + Sync>>,
    pub account: Option<String>,
    pub grant_expires_at: Option<i64>,
}

impl Drop for NkAccepted {
    fn drop(&mut self) {
        if !self.session.confirmed() {
            self.session.close();
        }
    }
}

impl NkAccepted {
    /// The session is given back at once when the relay abandons the admission.
    pub fn abandon(&self) {
        self.session.close();
    }

    /// Whether the account device still holds access (nothing to check for a paired ticket).
    pub fn is_still_admitted(&self) -> bool {
        self.still_admitted
            .as_ref()
            .is_none_or(|still_admitted| still_admitted())
    }

    /// Full admission recheck against live auth state and clock: a revoked, expired or
    /// generation-replaced paired device and a revoked or grant-expired account device all return
    /// false so they cannot keep or confirm a session.
    pub fn is_still_admitted_at(&self, auth: &RemoteAuth) -> bool {
        if let Some(paired) = &self.paired {
            return main_actor(auth, &paired.device.id, Some(&paired.generation)).is_some();
        }
        if !self.is_still_admitted() {
            return false;
        }
        self.grant_expires_at
            .is_none_or(|expires_at| expires_at > auth.now())
    }

    /// The confirmation, as the channel's first message; the device's effects run only now.
    /// `None` refuses the confirmation, and the caller closes the channel.
    pub fn confirm(&mut self, auth: &mut RemoteAuth, raw: &str) -> Option<HelloConfirm> {
        // The deadline may already have closed the session and its channel: no device effect may
        // run then (`host.ts:95`, `:107`-`:111`).
        if self.session.closed() {
            return None;
        }
        let Some(parsed) = ace_json::parse(raw).ok() else {
            self.session.close();
            return None;
        };
        let confirm = HelloConfirm::parse(&parsed).or_else(|| {
            self.session.close();
            None
        })?;
        // A link proof and a machine code go with a grant only, as in a hello.
        if self.paired.is_some() && (confirm.link.is_some() || confirm.machine_code.is_some()) {
            self.session.close();
            return None;
        }
        // Recheck revocation, credential replacement and grant expiry before confirming: a device
        // revoked or expired between the first message and `hello.confirm` must never confirm.
        if !self.is_still_admitted_at(auth) {
            self.session.close();
            return None;
        }
        // The deadline may also have run while the confirmation was parsed: the transition itself
        // decides, so a closed session never reaches the device effects below.
        if !self.session.confirm() {
            return None;
        }
        match &self.paired {
            Some(paired) => {
                let _ = auth.touch(&paired.device);
                let _ = auth.recognize(&paired.device, confirm.install_id.as_deref());
            }
            None => {
                let link = confirm
                    .link
                    .as_ref()
                    .map(|link| ace_auth::devices::PairingLinkProof {
                        device_id: link.device_id.clone(),
                        proof: link.proof.clone(),
                    });
                let _ = auth.account_device_seen(&self.actor.device.id, link.as_ref());
            }
        }
        Some(confirm)
    }
}

/// The daemon's NK host (`nkHost`).
pub struct NkHost<'a> {
    pub admission: &'a NkAdmission,
    /// The host key epoch tickets are bound to: the daemon's relay host id.
    pub epoch: String,
    pub auth: &'a mut RemoteAuth,
    pub account: Option<Arc<dyn NkAccount>>,
}

impl NkHost<'_> {
    /// Step 1: may this first message be decrypted at all (`arrive`)?
    pub fn arrive(&self) -> bool {
        self.admission.arrive()
    }

    /// Admit the plaintext an NK handshake returned, parsing it here and wiping the buffer before
    /// this returns (the TypeScript wipes the first message's payload the same way,
    /// `apps/relay/src/nk-stream.ts:98`).
    pub fn admit_bytes(
        &mut self,
        payload: &mut zeroize::Zeroizing<Vec<u8>>,
        ephemeral: &[u8],
        expire: impl FnOnce() + Send + 'static,
    ) -> Option<NkAccepted> {
        // Invalid UTF-8 is a refusal like any other, and the plaintext is wiped on that path too:
        // the buffer may hold a credential, so no early return may skip the wipe.
        let early = std::str::from_utf8(payload)
            .ok()
            .and_then(|text| ace_json::parse(text).ok())
            .and_then(|value| HelloEarly::parse(&value));
        payload.zeroize();
        self.admit_early(early?, ephemeral, expire)
    }

    /// Parse and admit a first message, or `None`. `expire` runs if the client doesn't confirm in
    /// time (the caller closes the channel it is about to open).
    pub fn admit(
        &mut self,
        payload: &Value,
        ephemeral: &[u8],
        expire: impl FnOnce() + Send + 'static,
    ) -> Option<NkAccepted> {
        let early = HelloEarly::parse(payload)?;
        self.admit_early(early, ephemeral, expire)
    }

    fn admit_early(
        &mut self,
        mut early: HelloEarly,
        ephemeral: &[u8],
        expire: impl FnOnce() + Send + 'static,
    ) -> Option<NkAccepted> {
        if !self.admission.claim(&early.device_id) {
            return None;
        }
        let mut claim = match self.admission.suppress(ephemeral) {
            crate::nk::admission::Suppressive::Claimed(claim) => claim,
            _ => return None,
        };
        let held = match self.credential(&early) {
            Some(held) => held,
            None => {
                claim.release();
                return None;
            }
        };
        let Some(session) = self.admission.admit(&early.device_id, expire) else {
            claim.release();
            return None;
        };
        // The ticket is spent and the grant checked: nothing downstream reads either, so neither
        // outlives the admission (porting guide rule 8). The account id, not the grant, is what
        // the channel's later check uses.
        if let Some(mut ticket) = early.ticket.take() {
            ticket.zeroize();
        }
        if let Some(mut grant) = early.grant.take() {
            grant.zeroize();
        }
        Some(NkAccepted {
            early,
            actor: held.actor,
            session,
            paired: held.paired,
            still_admitted: held.still_admitted,
            account: held.account,
            grant_expires_at: held.grant_expires_at,
        })
    }

    fn credential(&mut self, early: &HelloEarly) -> Option<Credential> {
        if let Some(ticket) = &early.ticket {
            let device = self
                .auth
                .consume_early(ticket, &self.epoch, &early.device_id)?;
            let actor = main_actor(self.auth, &device.device.id, Some(&device.generation))?;
            return Some(Credential {
                actor,
                paired: Some(device),
                still_admitted: None,
                account: None,
                grant_expires_at: None,
            });
        }
        let machine = Arc::clone(self.account.as_ref()?);
        let grant = early.grant.as_deref()?;
        let verdict = machine.admit_device_cached(grant, &early.device_id);
        if !verdict.admitted {
            return None;
        }
        let now = self.auth.now();
        if verdict
            .expires_at
            .is_some_and(|expires_at| expires_at <= now)
        {
            return None;
        }
        let account = verdict.account?;
        // The channel's access is exactly the account's own check (`host.ts:81`, consumed by
        // `files-relay.ts:370`): a revoked device, a lapsed grant or a left organization answers
        // false and its channel is closed.
        let still_admitted: Box<dyn Fn() -> bool + Send + Sync> = {
            let device_id = early.device_id.clone();
            let account = account.clone();
            Box::new(move || machine.still_admitted(&device_id, &account))
        };
        let actor = account_device_actor(&early.device_id, now, None);
        Some(Credential {
            actor,
            paired: None,
            still_admitted: Some(still_admitted),
            account: Some(account),
            grant_expires_at: verdict.expires_at,
        })
    }
}

struct Credential {
    actor: SessionActor,
    paired: Option<PairedDevice>,
    still_admitted: Option<Box<dyn Fn() -> bool + Send + Sync>>,
    account: Option<String>,
    grant_expires_at: Option<i64>,
}

/// Who a relayed main channel speaks for (`relay-hello.ts:132`): a paired device with its stored
/// scopes (never the desktop app's local-only credential), or an account device holding admin
/// while it stays admitted (ADR 0111).
pub fn main_actor(auth: &RemoteAuth, id: &str, generation: Option<&str>) -> Option<SessionActor> {
    let device = auth.devices().current(id, generation, auth.now()).ok()??;
    if device
        .device
        .scopes
        .iter()
        .any(|scope| matches!(scope, Scope::Desktop | Scope::UserBrowser))
    {
        return None;
    }
    Some(SessionActor::paired(device))
}

/// An admitted account device (`accountDeviceActor`, `relay-hello.ts:100`): admin while it stays
/// admitted, never revoked by device id, and never the person by its admission.
pub fn account_device_actor(id: &str, now: i64, member: Option<Member>) -> SessionActor {
    let device = Device {
        id: id.to_owned(),
        name: "ace account device".to_owned(),
        scopes: vec![Scope::Admin],
        created_at: now,
        last_seen_at: now,
        revoked_at: None,
        expires_at: None,
    };
    let Some(member) = member else {
        return SessionActor::host(device);
    };
    let owner = ace_auth::org::org_role(&member.role) == "owner";
    SessionActor {
        device: Device {
            name: "ace organization member".to_owned(),
            scopes: if owner {
                vec![Scope::Admin]
            } else {
                vec![Scope::Read, Scope::Operate]
            },
            ..device
        },
        revocable: false,
        generation: None,
        person: None,
        member: Some(member),
        spade_only: !owner,
    }
}

#[cfg(test)]
mod tests;
