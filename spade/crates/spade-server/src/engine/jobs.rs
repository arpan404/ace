//! Background jobs: a call to a `background` tool answers at once and runs here. Its result is
//! delivered like a message, so it steers the open turn or starts a new one.
//!
//! Each job has one owner of its end: whoever removes it from the live map (the job finishing, or
//! Stop) records how it ended, so a job never ends twice. Starting a job and Stop take the same
//! lock, and a start checks the turn's stop signal under it, so Stop never misses a job that is
//! just starting.

use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use spade_core::Transcript;
use spade_core::context::{JOB_LOST, JOB_STOPPED};
use spade_core::event::{Event, Known};
use spade_store::StoreError;
use tokio::sync::watch;

use super::Engine;
use crate::tools::ToolOutput;

/// How many times a job's end is retried when storing it fails, with doubling waits up to 30
/// seconds between tries (about ten minutes in all).
const STORE_TRIES: u32 = 24;

/// What starting a job came to.
pub(super) enum Started {
    Running,
    /// The turn was stopped first; nothing was started.
    Stopped,
}

/// Records the job and starts it, unless the turn was stopped. The caller then answers the call
/// with `context::job_started`.
pub(super) fn start(
    engine: &Arc<Engine>,
    id: &str,
    reply: &str,
    job: &str,
    name: &str,
    arguments: Value,
    stop: &watch::Receiver<bool>,
) -> Result<Started, StoreError> {
    let live = engine.live(id);
    let mut jobs = live.jobs.lock().unwrap_or_else(|p| p.into_inner());
    if *stop.borrow() {
        return Ok(Started::Stopped);
    }
    let started = Event::Known(Known::JobStarted {
        reply: reply.to_owned(),
        job: job.to_owned(),
        name: name.to_owned(),
    });
    engine.record(id, &started)?;
    let task = {
        let (engine, id, job, name) = (
            engine.clone(),
            id.to_owned(),
            job.to_owned(),
            name.to_owned(),
        );
        tokio::spawn(async move {
            let output = run(&engine, &job, &name, arguments).await;
            let claimed = engine
                .live(&id)
                .jobs
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&job)
                .is_some();
            if claimed {
                let content = super::turn::trim(&output.content, engine.limits.result_chars);
                let finished = Event::Known(Known::JobFinished {
                    job,
                    name,
                    content,
                    is_error: output.is_error,
                });
                keep_trying(|| engine.deliver(&id, &finished)).await;
            }
        })
    };
    jobs.insert(job.to_owned(), task.abort_handle());
    Ok(Started::Running)
}

async fn run(engine: &Engine, job: &str, name: &str, arguments: Value) -> ToolOutput {
    let Some(tool) = engine.tools.get(name) else {
        return ToolOutput::error(format!("There is no tool named {name}."));
    };
    match tokio::time::timeout(engine.limits.job_timeout, tool.run(job, arguments)).await {
        Ok(output) => output,
        Err(_) => ToolOutput::error(format!(
            "{name} did not finish within {} minutes.",
            engine.limits.job_timeout.as_secs() / 60
        )),
    }
}

/// Stores a job's end, retrying while storage fails: the end is known only here, and losing it
/// would leave the job running forever in the record.
async fn keep_trying(mut store: impl FnMut() -> Result<(), StoreError>) {
    let mut wait = Duration::from_millis(250);
    for _ in 0..STORE_TRIES {
        match store() {
            Ok(()) => return,
            Err(error) => {
                tracing::error!(%error, "could not store a job's end; trying again");
                tokio::time::sleep(wait).await;
                wait = (wait * 2).min(Duration::from_secs(30));
            }
        }
    }
    tracing::error!("gave up storing a job's end; a restart will report it lost");
}

/// Cancels the conversation's running jobs and records each as stopped. Returns how many. Every
/// job is cancelled first, whatever happens to storage after.
pub(super) fn stop_all(engine: &Arc<Engine>, id: &str) -> usize {
    let stopped: Vec<(String, tokio::task::AbortHandle)> = engine
        .live(id)
        .jobs
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .drain()
        .collect();
    for (_, handle) in &stopped {
        handle.abort();
    }
    if stopped.is_empty() {
        return 0;
    }
    let names = engine.load(id).unwrap_or_default();
    for (job, _) in &stopped {
        let finished = Event::Known(Known::JobFinished {
            job: job.clone(),
            name: job_name(&names, job),
            content: JOB_STOPPED.to_owned(),
            is_error: true,
        });
        let (engine, id) = (engine.clone(), id.to_owned());
        tokio::spawn(async move {
            keep_trying(|| engine.record(&id, &finished).map(|_| ())).await;
        });
    }
    stopped.len()
}

/// After a restart: every job the stored events show as running was lost with the old process.
/// Each is delivered as "unknown outcome", so the model can tell the person or check.
pub(super) fn report_lost(engine: &Arc<Engine>, id: &str) -> Result<(), StoreError> {
    let events = engine.load(id)?;
    for job in Transcript::fold(&events).jobs {
        let finished = Event::Known(Known::JobFinished {
            name: job_name(&events, &job),
            job,
            content: JOB_LOST.to_owned(),
            is_error: true,
        });
        engine.deliver(id, &finished)?;
    }
    Ok(())
}

fn job_name(events: &[Event], job: &str) -> String {
    events
        .iter()
        .find_map(|event| match event {
            Event::Known(Known::JobStarted { job: j, name, .. }) if j == job => Some(name.clone()),
            _ => None,
        })
        .unwrap_or_default()
}
