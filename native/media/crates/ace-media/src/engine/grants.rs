// SPDX-License-Identifier: Apache-2.0
//! Media connections, the grants on them and revocations (docs/media/plan.md, "Media
//! connection authorization" and "Revocation deadline"). Pure: `now` is the daemon's wall
//! clock in milliseconds, the clock `media.ticket.expiresAt` is written in. Every grant first
//! passes the [`Ledger`], before any secret is stored or imported for it.
use super::ledger::{Full, Ledger};
use super::{Effect, log, normal};
use crate::secret::{SecretId, Vault};
use media_noise::RelayStream;
use media_wire::control::{Admission, ConnectionKind, FromMedia, Id, Level, Owner, Refusal};
use std::collections::HashMap;
use zeroize::Zeroizing;

/// Connections (with unused tickets), viewers and relay streams held at once. A grant past a
/// limit is refused and logged.
pub const MAX_CONNECTIONS: usize = 1024;
pub const MAX_VIEWERS: usize = 4096;
pub const MAX_STREAMS: usize = 1024;

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
    ledger: Ledger,
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

fn refuse(out: &mut Vec<Effect>, grant: &Grant<'_>, reason: Refusal) {
    normal(
        out,
        FromMedia::GrantRefused {
            kind: grant.kind.into(),
            id: grant.id.clone(),
            reason,
        },
    );
}

fn full(out: &mut Vec<Effect>, result: Result<(), Full>) {
    if result.is_err() {
        out.push(Effect::Fatal("closed-id bookkeeping is full"));
    }
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

    /// The ledger's verdict, sent as `grant.refused` when it refuses.
    fn admit(&mut self, grant: &Grant<'_>, stream: Option<&str>, out: &mut Vec<Effect>) -> bool {
        let verdict = self
            .ledger
            .admit(grant.owner, grant.issued, grant.connection.get(), stream);
        match verdict {
            Ok(()) => true,
            Err(reason) => {
                refuse(out, grant, reason);
                false
            }
        }
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
        if !self.admit(&grant, None, out) {
            return;
        }
        if expires_at <= now {
            return refuse(out, &grant, Refusal::Expired);
        }
        let key = grant.connection.get().to_owned();
        self.remove(&key, "replaced", vault, out);
        let stored = (self.connections.len() < MAX_CONNECTIONS)
            .then(|| vault.store(ticket))
            .flatten();
        let Some(secret) = stored else {
            log(
                out,
                Level::Warn,
                "media.ticket refused: connection limit",
                grant.connection,
            );
            // The daemon counts the connection from its ticket until `connection.closed`.
            return normal(
                out,
                FromMedia::ConnectionClosed {
                    connection: grant.connection.clone(),
                    reason: "limit".into(),
                },
            );
        };
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
        if !self.admit(&grant, None, out) {
            return false;
        }
        let Some(connection) = self.connections.get(grant.connection.get()) else {
            refuse(out, &grant, Refusal::UnknownConnection);
            return false;
        };
        if connection.owner != *grant.owner {
            refuse(out, &grant, Refusal::Owner);
            return false;
        }
        if self.viewers.len() >= MAX_VIEWERS && !self.viewers.contains_key(grant.id.get()) {
            log(
                out,
                Level::Warn,
                "viewer.open refused: viewer limit",
                grant.id,
            );
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
    /// wiped whatever happens, and nothing is imported for a refused grant.
    pub fn relay_keys(
        &mut self,
        grant: Grant<'_>,
        keys: Zeroizing<Vec<u8>>,
        out: &mut Vec<Effect>,
    ) {
        if !self.admit(&grant, Some(grant.id.get()), out) {
            return;
        }
        let key = grant.connection.get().to_owned();
        if let Some(existing) = self.connections.get(&key)
            && existing.owner != *grant.owner
        {
            return refuse(out, &grant, Refusal::Owner);
        }
        let new = !self.connections.contains_key(&key);
        let replacing = self.streams.contains_key(grant.id.get());
        if (new && self.connections.len() >= MAX_CONNECTIONS)
            || (!replacing && self.streams.len() >= MAX_STREAMS)
        {
            return normal(
                out,
                FromMedia::RelayFailed {
                    stream: grant.id.clone(),
                    reason: "limit".into(),
                },
            );
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
        self.end_stream(grant.id.get());
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
    /// given), wipe their keys, and refuse its grants still on the way.
    pub fn revoke(
        &mut self,
        issued: u64,
        device: &Id,
        admission: Option<&Admission>,
        vault: &mut Vault,
        out: &mut Vec<Effect>,
    ) {
        self.ledger.revoke(issued, device.get(), admission);
        let covered: Vec<String> = self
            .connections
            .iter()
            .filter(|(_, c)| self.ledger.latest_covers(&c.owner, c.issued))
            .map(|(key, _)| key.clone())
            .collect();
        for key in covered {
            self.close(&key, "revoked", vault, out);
        }
    }

    /// Closes a connection for good: a grant naming it later is refused. Tells the daemon with
    /// `connection.closed` when ace-media held it.
    pub fn close(&mut self, key: &str, reason: &str, vault: &mut Vault, out: &mut Vec<Effect>) {
        let remembered = self.ledger.close_connection(key);
        full(out, remembered);
        let streams: Vec<String> = self
            .streams
            .iter()
            .filter(|(_, s)| s.connection == key)
            .map(|(id, _)| id.clone())
            .collect();
        for stream in streams {
            self.close_stream(&stream, out);
        }
        self.remove(key, reason, vault, out);
    }

    /// Drops a connection with everything on it: its viewers, its relay streams and their keys,
    /// an unused ticket.
    fn remove(&mut self, key: &str, reason: &str, vault: &mut Vault, out: &mut Vec<Effect>) {
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
            self.end_stream(&stream);
        }
        normal(
            out,
            FromMedia::ConnectionClosed {
                connection: connection.id,
                reason: reason.into(),
            },
        );
    }

    /// `relay.close`: ends one relay stream for good and wipes its cipher states. Its
    /// connection stays open.
    pub fn close_stream(&mut self, stream: &str, out: &mut Vec<Effect>) {
        let remembered = self.ledger.close_stream(stream);
        full(out, remembered);
        self.end_stream(stream);
    }

    fn end_stream(&mut self, stream: &str) {
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

    /// Shutdown: the process is ending, so nothing needs remembering.
    pub fn close_all(&mut self, reason: &str, vault: &mut Vault, out: &mut Vec<Effect>) {
        let keys: Vec<String> = self.connections.keys().cloned().collect();
        for key in keys {
            self.remove(&key, reason, vault, out);
        }
    }
}
