// SPDX-License-Identifier: Apache-2.0
//! What the server core asks of one tenant (`server.ts`'s `ServerConsumer`):
//! the accept, the delivery, the buffered observation and the recovery
//! handlers. Each statement keeps the TypeScript handler's order.

use ace_adapter_api::FrameDirection;
use ace_adapter_api::bridge::EventQueue;
use ace_json::{Value, json};
use std::sync::atomic::Ordering;

use crate::translate::boundaries::NativeEvent;
use crate::translate::data::{fields, get, s_in};

use super::super::server::{Tenant, TenantError};
use super::OpenCodeTenant;

impl Tenant for OpenCodeTenant {
    fn queue(&self) -> &EventQueue {
        &self.queue
    }

    fn accepts(
        &self,
        event: &NativeEvent<'_>,
        data: &Value,
        watermark: u64,
    ) -> Result<bool, TenantError> {
        self.owns(event, data, watermark)
    }

    fn receive(
        &self,
        event: &NativeEvent<'_>,
        data: &Value,
        watermark: u64,
    ) -> Result<(), TenantError> {
        self.receive_at(event, data, watermark)
    }

    fn buffered(&self, data: &Value, watermark: u64) -> Result<(), TenantError> {
        self.observe_buffered(data, watermark)
    }

    fn disconnected(&self, started: u64) {
        self.recovering.store(true, Ordering::SeqCst);
        // A recovery is beginning now, so a request that asked for this one is
        // spent. Clearing it here means a pass the facade started itself never
        // leaves a stale request behind for a later chunk.
        self.reconcile.store(false, Ordering::SeqCst);
        self.lock_evidence().reset();
        {
            let mut probe = self.lock_ancestry();
            probe.observe_pending(&mut |data, watermark| {
                let envelope = fields(data);
                let _ = self.lock_evidence().observe(
                    s_in(envelope, "type"),
                    fields(get(envelope, "data")),
                    watermark,
                );
            });
        }
        self.recovery_started.store(started, Ordering::SeqCst);
        let _ = self.emit(
            FrameDirection::Note,
            "lifecycle",
            &json!({ "type": "disconnected" }),
        );
    }

    fn reconcile(&self, data: &Value, watermark: u64) -> Result<(), TenantError> {
        if self.covered(data, watermark)? {
            return Ok(());
        }
        self.receive_value(data, watermark)
    }

    fn finalize_snapshots(&self) -> Result<(), TenantError> {
        let (positive, finished) = {
            let mut evidence = self.lock_evidence();
            (evidence.positive(), evidence.finish())
        };
        for snapshot in positive.into_iter().chain(finished) {
            self.emit(FrameDirection::Recv, snapshot.channel, &snapshot.data)?;
            if snapshot.channel == "snapshot.interactions" {
                let keys = self
                    .lock_evidence()
                    .interaction_keys(&snapshot.data)
                    .map_err(|error| TenantError(error.to_string()))?;
                self.lock_pending()
                    .retain(|key, entry| entry.session != snapshot.session || keys.contains(key));
            }
        }
        Ok(())
    }

    fn recovered(&self) {
        self.recovering.store(false, Ordering::SeqCst);
        self.lock_evidence().reset();
        let _ = self.emit(
            FrameDirection::Note,
            "lifecycle",
            &json!({ "type": "resynced" }),
        );
        let waiters = std::mem::take(&mut *self.lock_waiters());
        for id in waiters {
            self.settle(id, Ok("null"));
        }
    }

    fn take_reconcile(&self) -> bool {
        self.reconcile.swap(false, Ordering::SeqCst)
    }
}
