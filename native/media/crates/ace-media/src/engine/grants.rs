// SPDX-License-Identifier: Apache-2.0
//! Media connections, the grants on them and revocations (docs/media/plan.md, "Media
//! connection authorization" and "Revocation deadline"). Pure: `now` is the daemon's wall
//! clock in milliseconds, the clock `media.ticket.expiresAt` is written in.
use super::{Effect, normal};
use crate::secret::{SecretId, Vault};
use media_noise::RelayStream;
use media_wire::control::{Admission, ConnectionKind, FromMedia, Id, Owner, Refusal};
use std::collections::{HashMap, VecDeque};
use zeroize::Zeroizing;

/// Revocations kept to refuse late grants. A grant can only trail its revocation by what the
/// normal lane held when the revocation overtook it, so the oldest are safe to forget.
pub const MAX_REVOCATIONS: usize = 4096;

enum State {
    /// A `media.ticket` not yet presented by a client.
    Ticket {
        secret: SecretId,
        expires_at: u64,
    },
    Open,
}

struct Connection {
    id: Id,
    owner: Owner,
    issued: u64,
    state: State,
}

struct Revocation {
    issued: u64,
    device: String,
    admission: Option<Admission>,
}

impl Revocation {
    /// The same rule the daemon applies to the grants it still holds (`grants.ts`).
    fn covers(&self, owner: &Owner, issued: u64) -> bool {
        owner.device.get() == self.device
            && issued <= self.issued
            && self
                .admission
                .as_ref()
                .is_none_or(|a| *a == owner.admission)
    }
}

/// A granted viewer: delivery to it (D1) runs on its connection.
struct Viewer {
    connection: String,
}

struct Stream {
    connection: String,
    transport: RelayStream,
}

#[derive(Default)]
pub struct Grants {
    connections: HashMap<String, Connection>,
    revocations: VecDeque<Revocation>,
    viewers: HashMap<String, Viewer>,
    streams: HashMap<String, Stream>,
}

pub struct Grant<'a> {
    pub kind: &'static str,
    pub id: &'a Id,
    pub connection: &'a Id,
    pub owner: &'a Owner,
    pub issued: u64,
}

impl Grants {
    pub fn connections(&self) -> usize {
        self.connections.len()
    }

    pub fn viewers(&self) -> usize {
        self.viewers.len()
    }

    pub fn streams(&self) -> usize {
        self.streams.len()
    }

    fn revoked(&self, owner: &Owner, issued: u64) -> bool {
        self.revocations.iter().any(|r| r.covers(owner, issued))
    }

    fn refuse(out: &mut Vec<Effect>, kind: &str, id: &Id, reason: Refusal) {
        normal(
            out,
            FromMedia::GrantRefused {
                kind: kind.into(),
                id: id.clone(),
                reason,
            },
        );
    }

    /// `media.ticket`: a connection a client may open once, before `expires_at`.
    pub fn ticket(
        &mut self,
        grant: Grant<'_>,
        expires_at: u64,
        ticket: &[u8],
        vault: &mut Vault,
        now: u64,
        out: &mut Vec<Effect>,
    ) {
        if self.revoked(grant.owner, grant.issued) {
            return Self::refuse(out, grant.kind, grant.id, Refusal::Revoked);
        }
        if expires_at <= now {
            return Self::refuse(out, grant.kind, grant.id, Refusal::Expired);
        }
        let Some(secret) = vault.store(ticket) else {
            return Self::refuse(out, grant.kind, grant.id, Refusal::Expired);
        };
        let key = grant.connection.get().to_owned();
        self.close(&key, "replaced", vault, out);
        self.connections.insert(
            key,
            Connection {
                id: grant.connection.clone(),
                owner: grant.owner.clone(),
                issued: grant.issued,
                state: State::Ticket { secret, expires_at },
            },
        );
    }

    /// A client presented a ticket on the direct listener. Each ticket opens its connection
    /// once, before it expires; the answer is the connection it opened.
    pub fn claim(
        &mut self,
        presented: &[u8],
        vault: &mut Vault,
        now: u64,
        out: &mut Vec<Effect>,
    ) -> Option<Id> {
        let pending = self
            .connections
            .iter()
            .filter_map(|(key, c)| match c.state {
                State::Ticket { secret, .. } => Some((key.as_str(), secret)),
                State::Open => None,
            });
        let key = vault.find(pending, presented)?.to_owned();
        let connection = self.connections.get_mut(&key)?;
        let State::Ticket { secret, expires_at } = connection.state else {
            return None;
        };
        vault.erase(secret);
        connection.state = State::Open;
        let (id, owner) = (connection.id.clone(), connection.owner.clone());
        if expires_at <= now {
            self.close(&key, "expired", vault, out);
            return None;
        }
        normal(
            out,
            FromMedia::ConnectionOpen {
                connection: id.clone(),
                kind: ConnectionKind::Direct,
                owner,
            },
        );
        Some(id)
    }

    /// `viewer.open`: only on a known connection, for its own owner, and not revoked.
    pub fn viewer(&mut self, grant: Grant<'_>, out: &mut Vec<Effect>) -> bool {
        if self.revoked(grant.owner, grant.issued) {
            Self::refuse(out, grant.kind, grant.id, Refusal::Revoked);
            return false;
        }
        let Some(connection) = self.connections.get(grant.connection.get()) else {
            Self::refuse(out, grant.kind, grant.id, Refusal::UnknownConnection);
            return false;
        };
        if connection.owner != *grant.owner {
            Self::refuse(out, grant.kind, grant.id, Refusal::Owner);
            return false;
        }
        self.viewers.insert(
            grant.id.get().to_owned(),
            Viewer {
                connection: grant.connection.get().to_owned(),
            },
        );
        true
    }

    /// `relay.keys`: the stream's cipher states, installed for its connection. The payload is
    /// wiped whatever happens.
    pub fn relay_keys(
        &mut self,
        grant: Grant<'_>,
        keys: Zeroizing<Vec<u8>>,
        out: &mut Vec<Effect>,
    ) {
        if self.revoked(grant.owner, grant.issued) {
            return Self::refuse(out, grant.kind, grant.id, Refusal::Revoked);
        }
        let key = grant.connection.get().to_owned();
        if let Some(existing) = self.connections.get(&key)
            && existing.owner != *grant.owner
        {
            return Self::refuse(out, grant.kind, grant.id, Refusal::Owner);
        }
        let Ok(transport) = RelayStream::import(keys) else {
            return normal(
                out,
                FromMedia::RelayFailed {
                    stream: grant.id.clone(),
                    reason: "invalid-keys".into(),
                },
            );
        };
        self.close_stream(grant.id.get());
        let new = !self.connections.contains_key(&key);
        if new {
            self.connections.insert(
                key.clone(),
                Connection {
                    id: grant.connection.clone(),
                    owner: grant.owner.clone(),
                    issued: grant.issued,
                    state: State::Open,
                },
            );
            normal(
                out,
                FromMedia::ConnectionOpen {
                    connection: grant.connection.clone(),
                    kind: ConnectionKind::Relay,
                    owner: grant.owner.clone(),
                },
            );
        }
        self.streams.insert(
            grant.id.get().to_owned(),
            Stream {
                connection: key,
                transport,
            },
        );
    }

    pub fn viewer_close(&mut self, viewer: &str) {
        self.viewers.remove(viewer);
    }

    /// `revoke`: shut every connection of the owner it names (all its admissions when none is
    /// given), wipe their keys, and refuse its grants issued before it from now on.
    pub fn revoke(
        &mut self,
        issued: u64,
        device: &Id,
        admission: Option<&Admission>,
        vault: &mut Vault,
        out: &mut Vec<Effect>,
    ) {
        let revocation = Revocation {
            issued,
            device: device.get().to_owned(),
            admission: admission.cloned(),
        };
        let covered: Vec<String> = self
            .connections
            .iter()
            .filter(|(_, c)| revocation.covers(&c.owner, c.issued))
            .map(|(key, _)| key.clone())
            .collect();
        for key in covered {
            self.close(&key, "revoked", vault, out);
        }
        if self.revocations.len() == MAX_REVOCATIONS {
            self.revocations.pop_front();
        }
        self.revocations.push_back(revocation);
    }

    /// Closes a connection with everything on it: its viewers, its relay streams and their keys,
    /// an unused ticket. Tells the daemon with `connection.closed`.
    pub fn close(&mut self, key: &str, reason: &str, vault: &mut Vault, out: &mut Vec<Effect>) {
        let Some(connection) = self.connections.remove(key) else {
            return;
        };
        if let State::Ticket { secret, .. } = connection.state {
            vault.erase(secret);
        }
        self.viewers.retain(|_, v| v.connection != key);
        let streams: Vec<String> = self
            .streams
            .iter()
            .filter(|(_, s)| s.connection == key)
            .map(|(id, _)| id.clone())
            .collect();
        for stream in streams {
            self.close_stream(&stream);
        }
        normal(
            out,
            FromMedia::ConnectionClosed {
                connection: connection.id,
                reason: reason.into(),
            },
        );
    }

    /// Ends one relay stream and wipes its cipher states. Its connection stays open.
    pub fn close_stream(&mut self, stream: &str) {
        if let Some(mut stream) = self.streams.remove(stream) {
            stream.transport.close();
        }
    }

    /// Tickets nobody presented in time close their connection.
    pub fn tick(&mut self, vault: &mut Vault, now: u64, out: &mut Vec<Effect>) {
        let expired: Vec<String> = self
            .connections
            .iter()
            .filter(
                |(_, c)| matches!(c.state, State::Ticket { expires_at, .. } if expires_at <= now),
            )
            .map(|(key, _)| key.clone())
            .collect();
        for key in expired {
            self.close(&key, "expired", vault, out);
        }
    }

    pub fn close_all(&mut self, reason: &str, vault: &mut Vault, out: &mut Vec<Effect>) {
        let keys: Vec<String> = self.connections.keys().cloned().collect();
        for key in keys {
            self.close(&key, reason, vault, out);
        }
    }
}
