// SPDX-License-Identifier: Apache-2.0
//! ace-media's decisions, with no I/O: every control message and ingest frame goes in, and
//! what to send and which connections to close comes out as [`Effect`]s, in order. The shell
//! executes them; a revocation's answer always follows the closes it caused.
pub mod base64;
pub mod egress;
pub mod grants;
pub mod ledger;
pub mod recorder;
pub mod sources;
pub mod stills;
#[cfg(test)]
mod tests;

use crate::secret::Vault;
use egress::EgressSink;
use grants::{Grant, Grants};
use media_core::privacy::Decision;
use media_wire::capability::Acceleration;
use media_wire::control::{EncodeSpec, EpochRange, FromMedia, Id, Level, ToMedia};
use media_wire::frame::MediaFrame;
use recorder::{RecordSpec, Recorders};
use sources::{IngestId, Sources};
use stills::{NoStills, StillMaker, StillOutcome, Stills};
use zeroize::Zeroizing;

#[derive(Debug)]
pub enum Effect {
    /// Send on stdout.
    Normal(FromMedia),
    /// Send on stdout with this payload (a still's JPEG).
    NormalWith(FromMedia, Vec<u8>),
    /// Send on the priority lane.
    Priority(FromMedia),
    /// Answer a `ping`: the shell adds what only the OS knows.
    Pong(Id),
    CloseIngest(IngestId),
    /// `shutdown`: finish within `grace_ms` and exit.
    Shutdown {
        grace_ms: u32,
    },
    /// A JPEG source's encoder thread (E4).
    Encode(EncodeEffect),
    /// Bookkeeping that must never forget is full: exit, so the supervisor restarts the
    /// process and every connection ends with it.
    Fatal(&'static str),
}

/// What a JPEG source's encoder thread is told.
pub enum EncodeEffect {
    Configure {
        source: String,
        encodes: Vec<EncodeSpec>,
    },
    Picture {
        source: String,
        text: Vec<u8>,
        epoch: u32,
        age_us: u32,
    },
    Key {
        source: String,
        encode: u32,
    },
    Close {
        source: String,
    },
}

/// Names only: a picture's bytes are never printed.
impl std::fmt::Debug for EncodeEffect {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Configure { source, encodes } => {
                write!(f, "Configure({source}, {} encodes)", encodes.len())
            }
            Self::Picture { source, epoch, .. } => write!(f, "Picture({source}, epoch {epoch})"),
            Self::Key { source, encode } => write!(f, "Key({source}, {encode})"),
            Self::Close { source } => write!(f, "Close({source})"),
        }
    }
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

/// The two clocks the core is given: ace-media's own monotonic clock (milliseconds for holding
/// bounds, microseconds for timing recorded samples) and the daemon's wall clock in
/// milliseconds, for ticket expiry.
#[derive(Clone, Copy, Debug)]
pub struct Now {
    pub mono_ms: u64,
    pub mono_us: u64,
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
    egress: Box<dyn EgressSink>,
    stills: Stills,
    bytes_out: u64,
    out: Vec<Effect>,
}

impl Engine {
    pub fn new(recorders: Box<dyn Recorders>, egress: Box<dyn EgressSink>) -> Self {
        Self {
            vault: Vault::new(),
            sources: Sources::default(),
            grants: Grants::default(),
            recorders,
            egress,
            stills: Stills::new(Box::new(NoStills)),
            bytes_out: 0,
            out: Vec::new(),
        }
    }

    /// Stills are made by `maker`; without one every `still.take` fails at once.
    pub fn with_stills(mut self, maker: Box<dyn StillMaker>) -> Self {
        self.stills = Stills::new(maker);
        self
    }

    /// `capabilities.changed`: what the probe found now.
    pub fn capabilities_changed(&mut self, capabilities: &[media_wire::control::Capability]) {
        self.stills.capabilities(capabilities);
    }

    /// A still a maker finished.
    pub fn still_finished(&mut self, outcome: StillOutcome) {
        self.stills.finished(outcome, &mut self.out);
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
            } => {
                self.sources.open(
                    &source,
                    handle,
                    epoch,
                    &origin,
                    &payload,
                    vault,
                    now.mono_ms,
                    self.egress.as_mut(),
                    out,
                );
                match self.sources.handle(source.get()) {
                    Some(handle) => self.stills.open(source.get(), handle),
                    None => self.stills.close(source.get(), out),
                }
            }
            ToMedia::SourcePage { .. } | ToMedia::SourceCodecs { .. } => {}
            ToMedia::SourcePicture {
                source,
                epoch,
                age_ms,
            } => {
                let mut payload = payload;
                let bytes = std::mem::take(&mut *payload);
                self.stills.picture(source.get(), &bytes);
                self.sources.picture(
                    source.get(),
                    epoch,
                    age_ms,
                    bytes,
                    now,
                    self.egress.as_mut(),
                    out,
                );
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
                recording,
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
                self.sources
                    .decide(&source, &recording, decision, now.mono_ms, out);
            }
            ToMedia::SourceClose { source } => {
                self.sources
                    .close_source(source.get(), vault, self.egress.as_mut(), out);
                self.stills.close(source.get(), out);
            }
            ToMedia::SourceEgress { source, on } => self.sources.egress(&source, on, out),
            ToMedia::SourceEncodes { source, encodes } => {
                self.sources.encodes(&source, encodes, out)
            }
            ToMedia::SourceKey { source, encode } => self.sources.key(&source, encode, out),
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
            // Delivery to viewers lands with D1; until then these change nothing here.
            ToMedia::ViewerConfigure { .. }
            | ToMedia::ViewerPause { .. }
            | ToMedia::ViewerResume { .. }
            | ToMedia::SessionLink { .. } => {}
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
                self.grants.close_stream(stream.get(), out);
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
                self.sources.record_start(
                    &spec,
                    &recording,
                    self.recorders.as_mut(),
                    now.mono_ms,
                    out,
                );
            }
            ToMedia::RecordCut { recording, .. } => self.sources.record_cut(recording.get()),
            ToMedia::RecordMeta {
                recording,
                epoch,
                data,
            } => self
                .sources
                .record_meta(recording.get(), epoch, data, now, out),
            ToMedia::RecordStop { recording } => self.sources.record_stop(&recording, out),
            ToMedia::StillTake {
                request,
                source,
                max_width,
                max_height,
                max_pixels,
                quality,
                deadline_ms,
            } => self.stills.take(
                request,
                &source,
                media_codec::Size {
                    width: max_width,
                    height: max_height,
                },
                max_pixels,
                quality,
                deadline_ms,
                now.mono_ms,
                out,
            ),
        }
    }

    /// An ingest connection's hello token. True when it named an open source, which the
    /// connection now feeds; otherwise the connection is to be closed.
    pub fn ingest_hello(&mut self, conn: IngestId, token: &[u8]) -> bool {
        self.sources
            .hello(conn, token, &mut self.vault, &mut self.out)
    }

    /// A frame from an ingest connection the engine admitted.
    pub fn ingest(&mut self, conn: IngestId, frame: MediaFrame, now: Now) {
        if let Some(source) = self.sources.bound(conn) {
            self.stills.frame(source, &frame, &mut self.out);
        }
        self.sources
            .ingest(conn, frame, now, self.egress.as_mut(), &mut self.out);
    }

    /// A unit a JPEG source's encoder thread finished.
    pub fn encoded(&mut self, source: &str, frame: MediaFrame, now: Now) {
        self.sources
            .encoded(source, frame, now, self.egress.as_mut(), &mut self.out);
    }

    /// A JPEG source's steps, as its encoder thread chose them.
    pub fn encoder_steps(&mut self, source: &str, acceleration: Acceleration) {
        self.sources
            .encoder_steps(source, acceleration, &mut self.out);
    }

    /// A JPEG source's encoder could not run: the source ends, so the daemon takes it back.
    pub fn encoder_failed(&mut self, source: &str, reason: &str) {
        self.sources
            .encoder_failed(source, reason, self.egress.as_mut(), &mut self.out);
    }

    pub fn ingest_closed(&mut self, conn: IngestId, now: Now) {
        self.sources
            .ingest_closed(conn, now.mono_ms, self.egress.as_mut(), &mut self.out);
    }

    /// A client presented a ticket on the direct listener (D1).
    pub fn claim_ticket(&mut self, presented: &[u8], now: Now) -> Option<Id> {
        self.grants
            .claim(presented, &mut self.vault, now.wall_ms, &mut self.out)
    }

    /// Periodic: barrier hold bounds and ticket expiry.
    pub fn tick(&mut self, now: Now) {
        self.sources.tick(now.mono_ms, &mut self.out);
        self.stills.tick(now.mono_ms, &mut self.out);
        self.grants
            .tick(&mut self.vault, now.wall_ms, &mut self.out);
    }

    /// Shutdown or stdin closing: close every recording and connection.
    pub fn finish(&mut self) {
        self.sources.finish_all(&mut self.out);
        self.stills.finish(&mut self.out);
        self.grants
            .close_all("shutdown", &mut self.vault, &mut self.out);
    }
}

fn id(value: &str) -> Id {
    Id::new(value.to_owned()).unwrap_or_else(|_| unreachable!())
}
