// SPDX-License-Identifier: Apache-2.0
//! The egress lane's sending side. It exists from the start, refuses every frame until the
//! lane is authenticated, and then queues frames on the lane's writer, which holds at most
//! [`EGRESS_LIMIT`](super::writer::EGRESS_LIMIT) bytes in flight. A refused frame is the
//! engine's to drop; a full egress never ends the process.
use super::writer::Writer;
use crate::engine::egress::EgressSink;
use std::sync::{Arc, OnceLock};

#[derive(Clone, Default)]
pub struct EgressLane(Arc<OnceLock<Writer>>);

impl EgressLane {
    /// The authenticated lane's writer. Set once: lanes are never reopened.
    pub fn connect(&self, writer: Writer) {
        let _ = self.0.set(writer);
    }
}

impl EgressSink for EgressLane {
    fn offer(&mut self, frame: Vec<u8>) -> bool {
        self.0
            .get()
            .is_some_and(|writer| writer.send(frame).is_ok())
    }
}
