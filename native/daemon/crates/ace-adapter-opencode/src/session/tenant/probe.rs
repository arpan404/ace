// SPDX-License-Identifier: Apache-2.0
//! The tenant as an ancestry probe's host (`session.ts:129`-`:162`): what a held
//! receipt reads, and the effects it produces in this session's frame stream.

use ace_adapter_api::FrameDirection;
use ace_json::{Value, json};
use std::sync::atomic::Ordering;

use super::super::ancestry::{ProbeError, ProbeHost};
use super::OpenCodeTenant;
use super::{PORT_ANCESTRY, port};

impl ProbeHost for OpenCodeTenant {
    fn owns_session(&self, id: &str) -> bool {
        self.has_session(id)
    }

    fn directory(&self) -> String {
        OpenCodeTenant::directory(self)
    }

    fn recovering(&self) -> bool {
        self.recovering()
    }

    fn info(&self, info: &Value) {
        let _ = self.emit(
            FrameDirection::Recv,
            "snapshot.info",
            &json!({ "info": info }),
        );
    }

    fn receive(&self, data: &Value, watermark: u64) -> Result<(), ProbeError> {
        // `session.ts:134`: while not recovering the receipt is delivered
        // outright; while recovering only evidence no snapshot covers is.
        if !self.recovering() || !self.covered(data, watermark).map_err(|error| error.0)? {
            return self.receive_value(data, watermark).map_err(|error| error.0);
        }
        Ok(())
    }

    fn buffered(&self, data: &Value, watermark: u64) {
        // `session.ts:137`: the receipt is recorded even while no pass runs;
        // only its evidence is skipped then.
        let _ = self.emit(FrameDirection::Note, "ancestry.buffered", data);
        if self.recovering() {
            let _ = self.observe_buffered(data, watermark);
        }
    }

    fn pending(&self, guard: &str) {
        let _ = self.emit(
            FrameDirection::Note,
            "lifecycle",
            &json!({ "type": "ancestry.pending", "id": guard }),
        );
    }

    fn settled(&self, guard: &str) {
        let _ = self.emit(
            FrameDirection::Note,
            "lifecycle",
            &json!({ "type": "ancestry.settled", "id": guard }),
        );
    }

    fn failed(&self, data: &Value) {
        if self.closed() {
            return;
        }
        self.recovering.store(true, Ordering::SeqCst);
        let _ = self.emit(FrameDirection::Note, "ancestry.unverified", data);
        let _ = self.emit(
            FrameDirection::Note,
            "lifecycle",
            &json!({ "type": "disconnected", "reason": "ancestry verification incomplete" }),
        );
        self.reconcile_now();
    }

    fn lookup(&self, id: &str, guard: &str) {
        port(
            &self.queue,
            PORT_ANCESTRY,
            json!({ "id": id, "guard": guard }),
        );
    }
}
