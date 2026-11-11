//! Background jobs: a call to a `background` tool answers at once and runs here. Its result is
//! delivered like a message, so it steers the open turn or starts a new one.
//!
//! A job stays in the live map until its end is stored. Running, Stop owns its end: it cancels the
//! job and records it stopped before returning. Once the job has its result it is finishing: it
//! stores the result itself, and the `stop_requested` event Stop stores first keeps that result
//! (or a restart's "lost" report) from opening a reply.
//! Starting a job and Stop take the same lock, and a start checks the turn's stop signal under it,
//! so Stop never misses a job that is just starting.

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

/// A job in the live map.
pub(super) enum Job {
    Running(tokio::task::AbortHandle),
    /// Has its result and is storing it. A Stop meanwhile is stored as `stop_requested`, which
    /// keeps that result from opening a reply.
    Finishing,
}

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
    if !engine.record_unless_stopped(id, reply, &started)? {
        return Ok(Started::Stopped);
    }
    let task = {
        let (engine, id, job, name) = (
            engine.clone(),
            id.to_owned(),
            job.to_owned(),
            name.to_owned(),
        );
        tokio::spawn(async move {
            let output = run(&engine, &format!("{id}.{job}"), &name, arguments).await;
            {
                let live = engine.live(&id);
                let mut jobs = live.jobs.lock().unwrap_or_else(|p| p.into_inner());
                // Gone means Stop already took this job's end.
                if !matches!(jobs.get(&job), Some(Job::Running(_))) {
                    return;
                }
                jobs.insert(job.clone(), Job::Finishing);
            }
            let content = super::turn::trim(&output.content, engine.limits.result_chars);
            let finished = Event::Known(Known::JobFinished {
                job: job.clone(),
                name,
                content,
                is_error: output.is_error,
            });
            keep_trying(|| engine.deliver(&id, &finished)).await;
            engine
                .live(&id)
                .jobs
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&job);
        })
    };
    jobs.insert(job.to_owned(), Job::Running(task.abort_handle()));
    Ok(Started::Running)
}

/// Runs the job's tool. `key` is unique across conversations and stable for this job.
async fn run(engine: &Engine, key: &str, name: &str, arguments: Value) -> ToolOutput {
    let Some(tool) = engine.tools.get(name) else {
        return ToolOutput::error(format!("There is no tool named {name}."));
    };
    match tokio::time::timeout(engine.limits.job_timeout, tool.run(key, arguments)).await {
        Ok(output) => output,
        Err(_) => ToolOutput::error(format!(
            "{name} did not finish within {} minutes.",
            engine.limits.job_timeout.as_secs() / 60
        )),
    }
}

/// Stores a job's end, retrying with waits up to 30 seconds for as long as Spade runs: the end is
/// known only here, and losing it would leave the job running forever in the record.
pub(super) async fn keep_trying(mut store: impl FnMut() -> Result<(), StoreError>) {
    let mut wait = Duration::from_millis(250);
    while let Err(error) = store() {
        tracing::error!(%error, "could not store a job's end; trying again");
        tokio::time::sleep(wait).await;
        wait = (wait * 2).min(Duration::from_secs(30));
    }
}

/// Stops the conversation's jobs. A running job is cancelled and stored as stopped before this
/// returns, so a restart can never bring it back; a finishing one keeps its result, which opens
/// no reply because the caller stored `stop_requested` first. Returns how many were stopped.
pub(super) fn stop_all(engine: &Arc<Engine>, id: &str) -> usize {
    let mut cancelled: Vec<String> = Vec::new();
    let mut quietened = 0;
    {
        let live = engine.live(id);
        let mut jobs = live.jobs.lock().unwrap_or_else(|p| p.into_inner());
        jobs.retain(|job, state| match state {
            Job::Running(handle) => {
                handle.abort();
                cancelled.push(job.clone());
                false
            }
            Job::Finishing => {
                quietened += 1;
                true
            }
        });
    }
    if !cancelled.is_empty() {
        let names = engine.load(id).unwrap_or_default();
        let ends: Vec<Event> = cancelled
            .iter()
            .map(|job| {
                Event::Known(Known::JobFinished {
                    job: job.clone(),
                    name: job_name(&names, job),
                    content: JOB_STOPPED.to_owned(),
                    is_error: true,
                })
            })
            .collect();
        for end in ends {
            if let Err(error) = engine.record(id, &end) {
                tracing::error!(%error, "could not store a stopped job; trying again");
                let (engine, id) = (engine.clone(), id.to_owned());
                tokio::spawn(async move {
                    keep_trying(|| engine.record(&id, &end).map(|_| ())).await;
                });
            }
        }
    }
    cancelled.len() + quietened
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
