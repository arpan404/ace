// SPDX-License-Identifier: Apache-2.0
//! One discovery flight's task: admission, then the provider's discovery, reporting its
//! outcome to the actor. The task never writes catalog state; the actor decides whether
//! the result commits, in what order, and whether a deadline already won.

use std::sync::{Arc, Mutex};

use ace_models::instance::ModelInstance;

use crate::catalog::commands::{Command, FlightOutcome, Reporter};
use crate::catalog::{Admit, DiagnosticSink};
use crate::catalog::{CatalogOptions, DiscoveryDiagnostics, DiscoveryOutcome, DiscoveryRequest};
use crate::signals::{Gate, Limiter, Signal};

/// The discovery result waiting for its place in the instance's queue.
pub(crate) struct Commit {
    pub(crate) id: String,
    pub(crate) token: u64,
    pub(crate) generation: u64,
    pub(crate) revision: String,
    pub(crate) started_at: f64,
    pub(crate) diagnostics: DiscoveryDiagnostics,
    pub(crate) outcome: DiscoveryOutcome,
}

/// Everything one flight task needs, copied out of the actor before it is spawned.
pub(crate) struct Job {
    pub(crate) id: String,
    pub(crate) token: u64,
    pub(crate) request: ModelInstance,
    pub(crate) signal: Signal,
    pub(crate) admit: Option<Admit>,
    /// A pending revocation's deletion this replacement refresh waits for.
    pub(crate) pending: Option<Gate>,
}

/// Runs one flight and reports it. Deadlines and fences are the actor's; this task only
/// stops when its signal says so.
pub(crate) async fn run(
    reporter: Reporter,
    options: Arc<CatalogOptions>,
    limiter: Limiter,
    job: Job,
) {
    let Job {
        id,
        token,
        request,
        signal,
        admit,
        pending,
    } = job;
    let empty = |outcome: FlightOutcome, started_at: f64| Command::FlightOutcome {
        id: id.clone(),
        token,
        started_at,
        diagnostics: DiscoveryDiagnostics::default(),
        outcome,
    };
    // A failed home/identity guard revokes cached choices and never launches the provider.
    if let Some(admit) = admit {
        match futures::future::select(Box::pin(admit()), Box::pin(signal.wait())).await {
            futures::future::Either::Left((Ok(()), _)) => {}
            futures::future::Either::Left((Err(error), _)) => {
                send_with(
                    &reporter,
                    &options,
                    empty(FlightOutcome::Admission(error), options.clock.now()),
                );
                return;
            }
            futures::future::Either::Right(((), _)) => {
                send_with(
                    &reporter,
                    &options,
                    empty(FlightOutcome::None, options.clock.now()),
                );
                return;
            }
        }
        if signal.is_aborted() {
            send_with(
                &reporter,
                &options,
                empty(FlightOutcome::None, options.clock.now()),
            );
            return;
        }
    }
    if let Some(pending) = pending {
        match futures::future::select(Box::pin(pending.wait()), Box::pin(signal.wait())).await {
            futures::future::Either::Left(((), _)) => {}
            futures::future::Either::Right(((), _)) => {
                send_with(
                    &reporter,
                    &options,
                    empty(FlightOutcome::None, options.clock.now()),
                );
                return;
            }
        }
    }
    // A slot in the discovery concurrency bound, abandoned the moment the row is revoked.
    let permit =
        match futures::future::select(Box::pin(limiter.acquire()), Box::pin(signal.wait())).await {
            futures::future::Either::Left((permit, _)) => permit,
            futures::future::Either::Right(((), _)) => {
                send_with(
                    &reporter,
                    &options,
                    empty(FlightOutcome::None, options.clock.now()),
                );
                return;
            }
        };
    if signal.is_aborted() {
        drop(permit);
        send_with(
            &reporter,
            &options,
            empty(FlightOutcome::None, options.clock.now()),
        );
        return;
    }
    // The actor arms the deadline and re-checks ownership and revision before launching.
    let (reply, decision) = futures::channel::oneshot::channel();
    reporter.report(Command::FlightAdmit {
        id: id.clone(),
        token,
        reply,
    });
    if !decision.await.unwrap_or(false) {
        // The actor already settled this flight (aborted, replaced or too old).
        return;
    }
    let started_at = options.clock.now();
    let diagnostics = Arc::new(Mutex::new(DiscoveryDiagnostics::default()));
    let sink: DiagnosticSink = {
        let diagnostics = diagnostics.clone();
        Arc::new(move |metadata| {
            merge(
                &mut diagnostics
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()),
                metadata,
            );
        })
    };
    let inflight =
        options
            .discover
            .discover(DiscoveryRequest { instance: request }, signal.clone(), sink);
    let outcome = futures::future::select(inflight, Box::pin(signal.wait())).await;
    let result = match outcome {
        futures::future::Either::Left((result, _)) => result,
        futures::future::Either::Right(((), _)) => {
            drop(permit);
            let diagnostics = diagnostics
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            send_with(
                &reporter,
                &options,
                Command::FlightOutcome {
                    id,
                    token,
                    started_at,
                    diagnostics,
                    outcome: FlightOutcome::None,
                },
            );
            return;
        }
    };
    drop(permit);
    if signal.is_aborted() {
        send_with(&reporter, &options, empty(FlightOutcome::None, started_at));
        return;
    }
    let diagnostics = diagnostics
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    let outcome = match result {
        Ok(outcome) => FlightOutcome::Discovered(outcome),
        Err(failure) => FlightOutcome::Failed(Box::new(failure)),
    };
    send_with(
        &reporter,
        &options,
        Command::FlightOutcome {
            id,
            token,
            started_at,
            diagnostics,
            outcome,
        },
    );
}

fn send_with(reporter: &Reporter, options: &CatalogOptions, command: Command) {
    reporter.report_observed(command, options.clock.as_ref());
}

fn merge(current: &mut DiscoveryDiagnostics, metadata: DiscoveryDiagnostics) {
    if metadata.cli_version.is_some() {
        current.cli_version = metadata.cli_version;
    }
    if metadata.stage.is_some() {
        current.stage = metadata.stage;
    }
    if metadata.sources.is_some() {
        current.sources = metadata.sources;
    }
    current.rejected_models.extend(metadata.rejected_models);
    current.source_failures.extend(metadata.source_failures);
}
