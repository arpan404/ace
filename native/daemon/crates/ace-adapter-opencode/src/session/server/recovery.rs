// SPDX-License-Identifier: Apache-2.0
//! The server's recovery state (`server.ts:385`-`:390`, `:537`-`:560`): who began
//! the pass, what a retry resets, and the tail of `recoverOnce`.
//!
//! The awaited part of a pass (`resync`, `prepareReplay`) is the facade's; this
//! module owns only what one synchronous statement of the TypeScript did.

use super::{ServerCore, TenantError};

impl ServerCore {
    /// `beginRecovery(started = this.sequence)` (`server.ts:385`-`:390`): once
    /// per pass, every tenant is told it is disconnected from `started`.
    pub fn begin_recovery(&mut self, started: u64) {
        if self.recovering {
            return;
        }
        self.recovering = true;
        self.recovery_started = started;
        for tenant in self.tenants.values() {
            tenant.disconnected(started);
        }
    }

    /// `restartRecovery` (`server.ts:537`-`:543`): a retry is a new disconnect
    /// at the current watermark, and the buffer starts empty.
    pub fn restart_recovery(&mut self) {
        self.recovery_stale = false;
        self.buffered.clear();
        self.buffered_bytes = 0;
        self.recovery_started = self.sequence;
        for tenant in self.tenants.values() {
            tenant.disconnected(self.sequence);
        }
    }

    /// `recoverOnce`'s tail, after the shell's awaited `resync` and
    /// `prepareReplay` (`server.ts:552`-`:560`). False when buffered events were
    /// dropped and the pass must start again.
    ///
    /// A tenant's refusal rejects the pass, as the TypeScript's throw does: the
    /// buffer, the recovery state and every waiting barrier stay exactly as they
    /// were, so no `resynced` is emitted and no barrier is released. The facade's
    /// retry loop (`recoverUntilSettled`) restarts the pass.
    pub fn replay(&mut self) -> Result<bool, TenantError> {
        if self.recovery_stale {
            return Ok(false);
        }
        for entry in &self.buffered {
            for tenant in self.tenants.values() {
                tenant.reconcile(&entry.data, entry.watermark)?;
            }
        }
        for tenant in self.tenants.values() {
            tenant.finalize_snapshots()?;
        }
        self.buffered.clear();
        self.buffered_bytes = 0;
        self.recovering = false;
        for tenant in self.tenants.values() {
            tenant.recovered();
        }
        Ok(true)
    }
}
