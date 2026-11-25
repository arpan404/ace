// SPDX-License-Identifier: Apache-2.0
//! Leader death, the pipe barrier, and every channel's exit.

use super::*;

impl Inner {
    /// `onRetired` when the leader ends (`#exited`'s first line): the pool
    /// forgets the host while its pipes finish.
    pub(super) fn lead_retired(&mut self) {
        if self.retired {
            return;
        }
        self.retired = true;
        self.out.push(HostEffect::Retired);
    }

    /// The `initialize` handshake's answer.
    pub(super) fn initialized(&mut self, result: &Result<Value, PeerError>) {
        match result {
            Ok(_) => {
                match self.peer.notify("initialized", None) {
                    Ok(peer) => self.apply(peer),
                    Err(error) => self.report_all(error.message()),
                }
                self.ready = Handshake::Open;
                for tenant in self.tenant_ids() {
                    self.out.push(HostEffect::Opened { tenant });
                }
            }
            Err(error) => {
                let message = error.message().to_owned();
                self.ready = Handshake::Failed(message.clone());
                let tenants = self.tenant_ids();
                for tenant in tenants {
                    self.fail_tenant(tenant, &message);
                }
                self.vacated(false);
            }
        }
    }

    /// A tenant that cannot open: forget it and let the host idle (`attach`'s
    /// catch).
    pub(super) fn fail_tenant(&mut self, tenant: u64, message: &str) {
        if let Some(entry) = self.tenants.get_mut(&tenant) {
            entry.closed = Some(message.to_owned());
            entry.exited = true;
        }
        self.tenants.shift_remove(&tenant);
        self.gate.release(tenant);
        self.router.release(&tenant);
        self.out.push(HostEffect::OpenFailed {
            tenant,
            message: message.to_owned(),
        });
        self.vacated(false);
    }

    /// A host with no channels stays up for the next session, or stops now
    /// (`#vacated`, `:398`).
    pub(super) fn vacated(&mut self, now: bool) {
        if !self.tenants.is_empty() || self.exit.is_some() || self.retiring || self.exiting {
            return;
        }
        if self.config.dedicated || now {
            self.retire(Retirement::Idle, true);
            return;
        }
        self.cancel_idle();
        if self.config.idle_ms.is_finite() && self.config.idle_ms >= 0.0 {
            self.idle_armed = true;
            self.out.push(HostEffect::ArmTimer {
                key: IDLE_TIMER.to_owned(),
                ms: self.config.idle_ms,
            });
        }
    }

    /// The idle deadline is cancelled by an attach, an exit or a retire.
    pub(super) fn cancel_idle(&mut self) {
        if !self.idle_armed {
            return;
        }
        self.idle_armed = false;
        self.out.push(HostEffect::CancelTimer {
            key: IDLE_TIMER.to_owned(),
        });
    }

    /// A detached channel's exit, once its unsubscribes landed (`detach`,
    /// `:360`).
    pub(super) fn channel_detached(&mut self, tenant: u64, retirement: Retirement) {
        self.detaching.shift_remove(&tenant);
        let Some(mut entry) = self.tenants.shift_remove(&tenant) else {
            return;
        };
        self.gate.release(tenant);
        self.router.release(&tenant);
        self.active
            .retain(|thread, _| self.router.owner(thread).is_some());
        if entry.exited {
            return;
        }
        entry.exited = true;
        let exit = HostExit {
            reason: ExitReason::Detached,
            code: None,
            signal: None,
            pid: self.pid,
            output_drained: true,
        };
        if self.exiting {
            // No exit is published before the pipe barrier: the channel's exit
            // goes out with every other one, once the pipes are done.
            self.departed.push(tenant);
            return;
        }
        self.out.push(HostEffect::Exited { tenant, exit });
        self.vacated(retirement == Retirement::Shutdown);
    }

    /// The pipes are done (`#exited`, `:416`): settlements were published
    /// first (`closed`), then the held requests are answered and every channel
    /// hears its exit once.
    pub(super) fn exited(&mut self, exit: HostExit) {
        if self.exit.is_some() {
            return;
        }
        self.exit = Some(exit.clone());
        self.cancel_idle();
        self.lead_retired();
        self.detaching.clear();
        self.calls.clear();
        self.active.clear();
        let holds: Vec<Hold> = self.holds.drain(..).map(|(_, hold)| hold).collect();
        for hold in holds {
            for item in &hold.items {
                self.dispatch_none(item);
            }
        }
        for tenant in std::mem::take(&mut self.departed) {
            self.out.push(HostEffect::Exited {
                tenant,
                exit: exit.clone(),
            });
        }
        let tenants: Vec<(u64, Tenant)> = self.tenants.drain(..).collect();
        for (tenant, mut entry) in tenants {
            self.gate.release(tenant);
            entry
                .closed
                .get_or_insert_with(|| "process exited".to_owned());
            if !entry.exited {
                entry.exited = true;
                self.out.push(HostEffect::Exited {
                    tenant,
                    exit: exit.clone(),
                });
            }
        }
    }
}
