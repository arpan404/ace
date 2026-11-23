// SPDX-License-Identifier: Apache-2.0
//! The scrcpy sources ace-media reads itself (D1): their readers and reader generations.
//!
//! Every dial carries a reader generation from the daemon. The engine keeps the latest on
//! the source and stamps it on everything from that source's reader (the greeting, ready,
//! its end, every unit), and drops a control ack for any other generation, so nothing of
//! one reader is ever taken for a newer one's.
use super::super::{Effect, EncodeEffect, log, normal};
use super::{MAX_ENCODERS, ScrcpyTarget, Sources, status};
use media_wire::control::{FromMedia, Id, Level, Status};

/// A scrcpy reader's end, under its generation.
pub(super) fn reader_ended(out: &mut Vec<Effect>, source: &Id, reason: &str, dial: u32) {
    normal(
        out,
        FromMedia::SourceStatus {
            source: source.clone(),
            status: Status::Ended,
            reason: Some(reason.into()),
            attempts: None,
            acceleration: None,
            dial: Some(dial),
        },
    );
}

impl Sources {
    /// Starts the reader of a scrcpy source (D1), under an encoder token like a
    /// Simulator's reader.
    pub(super) fn read_scrcpy(&mut self, id: &Id, target: &ScrcpyTarget, out: &mut Vec<Effect>) {
        if self.encoders() >= MAX_ENCODERS {
            if let Some(source) = self.by_id.get_mut(id.get()) {
                source.status = Status::Ended;
            }
            log(out, Level::Warn, "source.open refused: encoder limit", id);
            return status(out, id, Status::Ended, Some("encoder-limit"), None);
        }
        self.last_token += 1;
        let token = self.last_token;
        if let Some(source) = self.by_id.get_mut(id.get()) {
            source.encoder = Some(token);
        }
        out.push(Effect::Encode(EncodeEffect::Scrcpy {
            source: id.get().to_owned(),
            token,
            host: target.host.clone(),
            port: target.port,
            deadline_ms: target.deadline_ms,
        }));
    }

    /// `source.dial`: (re)dial a scrcpy source's video handshake as reader generation
    /// `dial`, after a restart under the same source or a reopen. Unknown sources stay as
    /// they are. Every dial starts a fresh reader under a fresh token and closes the one
    /// before: that reader's end, possibly on its way already (the restart closed its
    /// socket), names a token the source no longer has, so it can neither end the
    /// redialled source nor swallow the dial.
    pub fn dial(&mut self, id: &Id, host: &str, port: u32, dial: u32, out: &mut Vec<Effect>) {
        let Some(previous) = self
            .by_id
            .get(id.get())
            .filter(|source| source.scrcpy.is_some())
            .map(|source| source.encoder)
        else {
            return;
        };
        if previous.is_none() && self.encoders() >= MAX_ENCODERS {
            if let Some(source) = self.by_id.get_mut(id.get()) {
                source.status = Status::Ended;
                if let Some(target) = source.scrcpy.as_mut() {
                    target.dial = dial;
                }
            }
            log(out, Level::Warn, "source.dial refused: encoder limit", id);
            return reader_ended(out, id, "encoder-limit", dial);
        }
        self.last_token += 1;
        let token = self.last_token;
        let Some(source) = self.by_id.get_mut(id.get()) else {
            return;
        };
        let Some(target) = source.scrcpy.as_mut() else {
            return;
        };
        target.host = host.to_owned();
        target.port = port;
        target.dial = dial;
        let deadline_ms = target.deadline_ms;
        source.encoder = Some(token);
        match previous {
            Some(previous) => out.push(Effect::Encode(EncodeEffect::Close {
                source: id.get().to_owned(),
                token: previous,
            })),
            // A reader that ended took the source with it: the redial starts it again.
            None => {
                source.status = Status::Starting;
                status(out, id, Status::Starting, None, None);
            }
        }
        out.push(Effect::Encode(EncodeEffect::Scrcpy {
            source: id.get().to_owned(),
            token,
            host: host.to_owned(),
            port,
            deadline_ms,
        }));
    }

    /// `source.controlConnected`: the daemon connected a scrcpy source's control socket for
    /// reader generation `dial`, so that reader may read the device name and codec id now.
    /// An ack for any other generation belongs to a reader that is gone, and is dropped.
    pub fn control_connected(&mut self, id: &Id, dial: u32, out: &mut Vec<Effect>) {
        let token = self.by_id.get(id.get()).and_then(|source| {
            source
                .scrcpy
                .as_ref()
                .filter(|target| target.dial == dial)?;
            source.encoder
        });
        if let Some(token) = token {
            out.push(Effect::Encode(EncodeEffect::ScrcpyControl {
                source: id.get().to_owned(),
                token,
            }));
        }
    }

    /// The reader generation of `id`'s live scrcpy reader `token`; none for a reader the
    /// source moved on from.
    pub fn scrcpy_dial(&self, id: &str, token: u64) -> Option<u32> {
        let source = self.by_id.get(id).filter(|s| s.encoder == Some(token))?;
        source.scrcpy.as_ref().map(|target| target.dial)
    }
}
