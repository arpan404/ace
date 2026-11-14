// SPDX-License-Identifier: Apache-2.0
//! ace-media's decisions, with no I/O: every control message and ingest frame goes in, and
//! what to send and which connections to close comes out as [`Effect`]s, in order. The shell
//! executes them; a revocation's answer always follows the closes it caused.
pub mod grants;
pub mod recorder;
pub mod sources;
#[cfg(test)]
mod tests;

use crate::secret::Vault;
use grants::{Grant, Grants};
use media_core::privacy::Decision;
use media_wire::control::{EpochRange, FromMedia, Id, Level, ToMedia};
use media_wire::frame::MediaFrame;
use recorder::{RecordSpec, Recorders};
use sources::{IngestId, Sources};
use zeroize::Zeroizing;

#[derive(Debug)]
pub enum Effect {
    /// Send on stdout.
    Normal(FromMedia),
    /// Send on the priority lane.
    Priority(FromMedia),
    /// Answer a `ping`: the shell adds what only the OS knows.
    Pong(Id),
    CloseIngest(IngestId),
    /// `shutdown`: finish within `grace_ms` and exit.
    Shutdown {
        grace_ms: u32,
    },
}

pub(crate) fn normal(out: &mut Vec<Effect>, message: FromMedia) {
    out.push(Effect::Normal(message));
}

pub(crate) fn priority(out: &mut Vec<Effect>, message: FromMedia) {
    out.push(Effect::Priority(message));
}

/// A log line for the daemon. Only ids and states, never payloads.
pub(crate) fn log(out: &mut Vec<Effect>, level: Level, message: &str, id: &Id) {
    normal(
        out,
        FromMedia::Log {
            level,
            message: message.into(),
            fields: serde_json::json!({ "id": id.get() }),
        },
    );
}

/// The two clocks the core is given: ace-media's own monotonic milliseconds, for holding
/// bounds, and the daemon's wall clock in milliseconds, for ticket expiry.
#[derive(Clone, Copy, Debug)]
pub struct Now {
    pub mono_ms: u64,
    pub wall_ms: u64,
}

/// Counts for `pong.stats`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Counts {
    pub sources: u64,
    pub viewers: u64,
    pub connections: u64,
    pub bytes_out: u64,
}

pub struct Engine {
    vault: Vault,
    sources: Sources,
    grants: Grants,
    recorders: Box<dyn Recorders>,
    bytes_out: u64,
    out: Vec<Effect>,
}

impl Engine {
    pub fn new(recorders: Box<dyn Recorders>) -> Self {
        Self {
            vault: Vault::new(),
            sources: Sources::default(),
            grants: Grants::default(),
            recorders,
            bytes_out: 0,
            out: Vec::new(),
        }
    }

    /// The effects produced so far, in the order they must happen.
    pub fn effects(&mut self) -> std::vec::Drain<'_, Effect> {
        self.out.drain(..)
    }

    pub fn counts(&self) -> Counts {
        Counts {
            sources: self.sources.len() as u64,
            viewers: self.grants.viewers() as u64,
            connections: self.grants.connections() as u64,
            bytes_out: self.bytes_out,
        }
    }

    /// One control message from either lane. Its payload is wiped when this returns, unless it
    /// was handed on (pictures).
    pub fn control(&mut self, message: ToMedia, payload: Zeroizing<Vec<u8>>, now: Now) {
        let out = &mut self.out;
        let vault = &mut self.vault;
        match message {
            ToMedia::Init { .. } => log(out, Level::Warn, "init repeated", &id("init")),
            ToMedia::Ping { id } => out.push(Effect::Pong(id)),
            ToMedia::Shutdown { grace_ms } => out.push(Effect::Shutdown { grace_ms }),
            // The listener for clients is D1's; ace-media takes the certificate and drops it.
            ToMedia::Listen { .. } => {}
            ToMedia::SourceOpen {
                source,
                handle,
                epoch,
                origin,
                ..
            } => self.sources.open(
                &source,
                handle,
                epoch,
                &origin,
                &payload,
                vault,
                now.mono_ms,
                out,
            ),
            ToMedia::SourcePage { .. } | ToMedia::SourceCodecs { .. } => {}
            ToMedia::SourcePicture { source, epoch, .. } => {
                let mut payload = payload;
                let bytes = std::mem::take(&mut *payload);
                self.sources
                    .picture(source.get(), epoch, bytes, now.mono_ms, out);
            }
            ToMedia::SourceEpoch {
                source,
                seq,
                epoch,
                follows_private,
            } => self
                .sources
                .epoch(&source, &seq, epoch, follows_private, now.mono_ms, out),
            ToMedia::RecordEpochs {
                source,
                seq,
                decided,
                clear,
                discard,
            } => {
                let ranges =
                    |r: Vec<EpochRange>| r.iter().map(|r| (r.get()[0], r.get()[1])).collect();
                let decision = Decision {
                    seq: seq.get(),
                    decided,
                    clear: ranges(clear),
                    discard: ranges(discard),
                };
                self.sources.decide(&source, decision, now.mono_ms, out);
            }
            ToMedia::SourceClose { source } => self.sources.close(source.get(), vault, out),
            ToMedia::MediaTicket {
                connection,
                owner,
                issued,
                expires_at,
            } => self.grants.ticket(
                Grant {
                    kind: "media.ticket",
                    id: &connection,
                    connection: &connection,
                    owner: &owner,
                    issued: issued.get(),
                },
                expires_at.get(),
                &payload,
                vault,
                now.wall_ms,
                out,
            ),
            ToMedia::ViewerOpen {
                viewer,
                connection,
                owner,
                issued,
                ..
            } => {
                self.grants.viewer(
                    Grant {
                        kind: "viewer.open",
                        id: &viewer,
                        connection: &connection,
                        owner: &owner,
                        issued: issued.get(),
                    },
                    out,
                );
            }
            ToMedia::ViewerConfigure { .. } => {}
            ToMedia::ViewerClose { viewer } => self.grants.viewer_close(viewer.get()),
            ToMedia::RelayDial { stream, .. } => normal(
                out,
                FromMedia::RelayFailed {
                    stream,
                    reason: "relay-unavailable".into(),
                },
            ),
            ToMedia::RelayOut { .. } | ToMedia::RelayPull { .. } => {}
            ToMedia::RelayKeys {
                stream,
                connection,
                owner,
                issued,
            } => self.grants.relay_keys(
                Grant {
                    kind: "relay.keys",
                    id: &stream,
                    connection: &connection,
                    owner: &owner,
                    issued: issued.get(),
                },
                payload,
                out,
            ),
            ToMedia::RelayClose { id, stream, .. } => {
                self.grants.close_stream(stream.get());
                priority(out, FromMedia::Closed { id });
            }
            ToMedia::ConnectionClose {
                id,
                connection,
                reason,
            } => {
                self.grants.close(connection.get(), &reason, vault, out);
                priority(out, FromMedia::Closed { id });
            }
            ToMedia::Revoke {
                id,
                issued,
                device,
                admission,
            } => {
                self.grants
                    .revoke(issued.get(), &device, admission.as_ref(), vault, out);
                priority(out, FromMedia::Revoked { id });
            }
            ToMedia::RecordStart {
                recording,
                source,
                directory,
                max_bytes,
                pointer_track,
            } => {
                let spec = RecordSpec {
                    recording: recording.get(),
                    source: source.get(),
                    directory: &directory,
                    max_bytes: max_bytes.get(),
                    pointer_track,
                };
                self.sources
                    .record_start(&spec, &recording, self.recorders.as_mut(), out);
            }
            ToMedia::RecordCut { recording, .. } => self.sources.record_cut(recording.get()),
            ToMedia::RecordMeta {
                recording,
                epoch,
                data,
            } => self.sources.record_meta(recording.get(), epoch, &data),
            ToMedia::RecordStop { recording } => self.sources.record_stop(&recording, out),
            // Stills are F2's; the daemon falls back to its legacy still maker.
            ToMedia::StillTake { request, .. } => normal(
                out,
                FromMedia::StillFailed {
                    request,
                    reason: "stills-unavailable".into(),
                },
            ),
        }
    }

    pub fn ingest(&mut self, conn: IngestId, frame: MediaFrame, now: Now) {
        self.sources
            .ingest(conn, frame, &mut self.vault, now.mono_ms, &mut self.out);
    }

    pub fn ingest_closed(&mut self, conn: IngestId, now: Now) {
        self.sources.ingest_closed(conn, now.mono_ms, &mut self.out);
    }

    /// A client presented a ticket on the direct listener (D1).
    pub fn claim_ticket(&mut self, presented: &[u8], now: Now) -> Option<Id> {
        self.grants
            .claim(presented, &mut self.vault, now.wall_ms, &mut self.out)
    }

    /// Periodic: barrier hold bounds and ticket expiry.
    pub fn tick(&mut self, now: Now) {
        self.sources.tick(now.mono_ms, &mut self.out);
        self.grants
            .tick(&mut self.vault, now.wall_ms, &mut self.out);
    }

    /// Shutdown or stdin closing: close every recording and connection.
    pub fn finish(&mut self) {
        self.sources.finish_all(&mut self.out);
        self.grants
            .close_all("shutdown", &mut self.vault, &mut self.out);
    }
}

fn id(value: &str) -> Id {
    Id::new(value.to_owned()).unwrap_or_else(|_| unreachable!())
}
