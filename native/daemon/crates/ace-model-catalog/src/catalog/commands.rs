// SPDX-License-Identifier: Apache-2.0
//! The catalog actor's mailbox: every public call is one command with a oneshot reply.
//!
//! Nothing outside the actor touches catalog state. A caller that goes away drops its
//! reply receiver; the actor still finishes the operation and settles everything it
//! admitted, which is how cancellation is handled here.

use std::sync::{Arc, Weak};

use ace_models::instance::ModelInstance;
use serde_json::Value;

use crate::catalog::mailbox::{Ingress, Inputs};
use crate::catalog::{
    Admit, CatalogError, DiscoveryDiagnostics, DiscoveryOutcome, InstanceStatus, ModelFilter,
    ModelListResult,
};
use crate::failures::DiscoveryFailure;
use crate::gate::RefreshCause;
use crate::resolve::{Resolution, RoleSpec};

/// One reply slot. Sending fails only when the caller dropped it, which never cancels work.
pub(crate) type Reply<T> = futures::channel::oneshot::Sender<T>;

/// One message and the caller's acknowledgement that the actor handled it.
pub(crate) struct Envelope {
    pub(crate) command: Command,
    pub(crate) ack: Option<Reply<()>>,
    pub(crate) inputs: Option<Inputs>,
    pub(crate) observed_at: Option<f64>,
}

impl Envelope {
    pub(crate) fn report(command: Command) -> Self {
        Self {
            command,
            ack: None,
            inputs: None,
            observed_at: None,
        }
    }
}

/// How work the actor owns reports back: never through the callers' bounded mailbox.
///
/// The completion queue is unbounded, so a spawned task, a timer or the storage lane can
/// always report without blocking; the wake message only interrupts the actor's wait on
/// the callers' queue and is dropped when that queue is full (the actor is then busy and
/// drains completions on its own).
#[derive(Clone)]
pub(crate) struct Reporter {
    pub(crate) completions: std::sync::mpsc::Sender<Envelope>,
    pub(crate) commands: Weak<Ingress>,
}

impl Reporter {
    pub(crate) fn report(&self, command: Command) {
        self.send(Envelope::report(command));
    }

    pub(crate) fn report_observed(&self, command: Command, clock: &dyn crate::catalog::Clock) {
        let mut envelope = Envelope::report(command);
        envelope.observed_at =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| clock.now())).ok();
        self.send(envelope);
    }

    fn send(&self, envelope: Envelope) {
        if self.completions.send(envelope).is_ok()
            && let Some(sender) = self.commands.upgrade()
        {
            sender.wake();
        }
    }
}

/// Every message the actor thread accepts, from a caller or from work it spawned.
pub(crate) enum Command {
    List {
        filter: ModelFilter,
        offset: usize,
        limit: usize,
        reply: Reply<Result<ModelListResult, CatalogError>>,
    },
    Resolve {
        spec: RoleSpec,
        cached: bool,
        reply: Reply<Result<Resolution, String>>,
    },
    HasProvider {
        provider: ace_protocol::generated::ProviderKind,
        reply: Reply<bool>,
    },
    HasInstance {
        id: String,
        reply: Reply<bool>,
    },
    Registered {
        id: String,
        reply: Reply<Option<ModelInstance>>,
    },
    Registration {
        id: String,
        reply: Reply<Option<(ModelInstance, crate::catalog::RegistrationToken)>>,
    },
    HasFlight {
        id: String,
        reply: Reply<bool>,
    },
    ResetPause {
        id: String,
        reply: Reply<()>,
    },
    Listen {
        listener: Arc<dyn Fn(ModelFilter) + Send + Sync>,
        reply: Reply<Result<u64, CatalogError>>,
    },
    Unlisten {
        token: u64,
    },
    MarkStale {
        filter: ModelFilter,
        reply: Reply<Result<(), CatalogError>>,
    },
    Register {
        input: ModelInstance,
        admit: Option<Admit>,
        reply: Reply<Result<(), CatalogError>>,
    },
    ConfigurationChanged {
        reply: Reply<()>,
    },
    InstallationChanged {
        provider: ace_protocol::generated::ProviderKind,
        version: String,
        runtime: String,
        reply: Reply<()>,
    },
    LoginChanged {
        instance: String,
        revision: String,
        sign_in_method: Option<Option<String>>,
        /// `Some` for an ACP row, which reports at once; `None` means the caller refreshes.
        reply: Reply<Result<Option<Vec<InstanceStatus>>, CatalogError>>,
    },
    Remove {
        instance: String,
        reply: Reply<Result<(), CatalogError>>,
    },
    Invalidate {
        filter: ModelFilter,
        reply: Reply<Result<(), CatalogError>>,
    },
    Refresh {
        filter: ModelFilter,
        mode: RefreshMode,
        reply: Reply<Result<Vec<InstanceStatus>, CatalogError>>,
    },
    RefreshState {
        id: String,
        cause: RefreshCause,
        reply: Reply<InstanceStatus>,
    },
    UpdateSession {
        input: ModelInstance,
        token: crate::catalog::RegistrationToken,
        metadata: Value,
        reply: Reply<Result<(), CatalogError>>,
    },
    UpdateModes {
        instance: String,
        token: crate::catalog::RegistrationToken,
        modes: Vec<Value>,
        reply: Reply<()>,
    },
    HoldTurn {
        id: String,
        reply: Reply<(u64, futures::channel::oneshot::Receiver<()>)>,
    },
    ReserveTurn {
        id: String,
        reply: Reply<u64>,
    },
    SettleTurn {
        id: String,
        token: u64,
        reply: Reply<()>,
    },
    Close {
        reply: Reply<Result<(), CatalogError>>,
    },
    ReconcileIds {
        reply: Reply<Option<Vec<String>>>,
    },
    Probe {
        id: String,
        reply: Reply<Result<(), CatalogError>>,
    },
    Observe {
        reply: Reply<Option<u64>>,
    },
    UnobserveWith {
        reply: Reply<()>,
    },
    /// Waits until the actor has no spawned work left. Tests use it to settle a drain.
    Quiesce {
        reply: Reply<()>,
    },
    /// Test inspection: how many accepted session writes have not settled.
    PendingWork {
        reply: Reply<usize>,
    },
    /// Test inspection: how many caller replies the actor retains for later work.
    RetainedReplies {
        reply: Reply<usize>,
    },
    /// Test inspection: the row's connection fingerprint and whether it reports an error.
    Inspect {
        id: String,
        reply: Reply<(Option<String>, bool)>,
    },

    // Work the actor spawned, reporting back.
    /// Interrupts the actor's wait on the callers' queue; it carries no work of its own.
    Wake,
    TaskSettled {
        task: u64,
    },
    TimerRetired {
        key: u64,
    },
    Deadline {
        id: String,
        token: u64,
    },
    ProbeDeadline {
        id: String,
        token: u64,
    },
    /// A flight asks to proceed once admission and the CLI check passed; the actor arms
    /// the deadline and answers whether the discovery may launch.
    FlightAdmit {
        id: String,
        token: u64,
        reply: Reply<bool>,
    },
    FlightOutcome {
        id: String,
        token: u64,
        started_at: f64,
        diagnostics: DiscoveryDiagnostics,
        outcome: FlightOutcome,
    },
    ProbeOutcome {
        id: String,
        token: u64,
        generation: u64,
        revision: String,
        started_at: f64,
        result: Option<Result<String, DiscoveryFailure>>,
    },
    /// A removal has drained its flights and waits for its durable delete.
    RemovalReady {
        id: String,
        token: u64,
    },
    /// The storage lane finished one job.
    StorageDone {
        key: u64,
        outcome: crate::catalog::storage_lane::Outcome,
    },
    InvalidationDone {
        id: String,
        token: u64,
    },
    /// A queued permission-mode write's place may run.
    PermissionReady {
        id: String,
        place: u64,
    },
}

impl Command {
    pub(crate) fn allowed_during_close(&self) -> bool {
        self.is_release() || matches!(self, Self::Close { .. } | Self::Quiesce { .. })
    }

    pub(crate) fn is_release(&self) -> bool {
        matches!(
            self,
            Self::SettleTurn { .. } | Self::UnobserveWith { .. } | Self::Unlisten { .. }
        )
    }

    pub(crate) fn needs_inputs(&self) -> bool {
        matches!(
            self,
            Self::List { .. }
                | Self::Resolve { .. }
                | Self::Register { .. }
                | Self::ConfigurationChanged { .. }
                | Self::InstallationChanged { .. }
                | Self::LoginChanged { .. }
                | Self::Refresh { .. }
                | Self::RefreshState { .. }
                | Self::SettleTurn { .. }
                | Self::UpdateSession { .. }
                | Self::UpdateModes { .. }
                | Self::Probe { .. }
                | Self::ReconcileIds { .. }
                | Self::Invalidate { .. }
        )
    }
}

/// Which refresh a caller asked for.
#[derive(Debug, Clone)]
pub(crate) enum RefreshMode {
    /// Every selected row, resetting each retry pause.
    All,
    /// One instance, with the person's own probe deferral.
    Load(String),
    /// Rows that never loaded, or loaded empty and are due.
    Missing,
}

/// What a flight's discovery reported.
pub(crate) enum FlightOutcome {
    Discovered(DiscoveryOutcome),
    Failed(Box<DiscoveryFailure>),
    Admission(String),
    /// The task ended without an answer: aborted, dropped, or panicked.
    None,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn completion_reports_return_even_when_command_ingress_is_full() {
        let (commands, _receiver) = mpsc::sync_channel(1);
        let commands = Arc::new(Ingress::new(commands));
        commands.wake();
        let (completions, reported) = mpsc::channel();
        let reporter = Reporter {
            commands: Arc::downgrade(&commands),
            completions,
        };
        let (done, finished) = mpsc::channel();
        std::thread::spawn(move || {
            reporter.report(Command::TaskSettled { task: 42 });
            let _ = done.send(());
        });
        finished.recv_timeout(Duration::from_secs(3)).unwrap();
        assert!(matches!(
            reported
                .recv_timeout(Duration::from_secs(3))
                .unwrap()
                .command,
            Command::TaskSettled { task: 42 }
        ));
    }
}
