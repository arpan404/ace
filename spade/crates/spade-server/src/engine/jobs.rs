//! Background jobs: a call to a `background` tool answers at once and runs here. Its result is
//! delivered like a message, so it steers the open turn or starts a new one. Whoever removes a job
//! from the live map (the job finishing, or Stop) is the one that records its end, so a job never
//! ends twice.

use std::sync::Arc;

use serde_json::Value;
use spade_core::Transcript;
use spade_core::context::{JOB_LOST, JOB_STOPPED};
use spade_core::event::{Event, Known};
use spade_store::StoreError;

use super::Engine;

/// Records the job and starts it. The caller then answers the call with `context::job_started`.
pub(super) fn start(
    engine: &Arc<Engine>,
    id: &str,
    reply: &str,
    job: &str,
    name: &str,
    arguments: Value,
) {
    let started = Event::Known(Known::JobStarted {
        reply: reply.to_owned(),
        job: job.to_owned(),
        name: name.to_owned(),
    });
    if let Err(error) = engine.record(id, &started) {
        tracing::error!(%error, "could not store a job start");
        return;
    }
    let live = engine.live(id);
    let mut jobs = live.jobs.lock().unwrap_or_else(|p| p.into_inner());
    let task = {
        let (engine, id, job, name) = (
            engine.clone(),
            id.to_owned(),
            job.to_owned(),
            name.to_owned(),
        );
        tokio::spawn(async move {
            let output = match engine.tools.get(&name) {
                Some(tool) => {
                    match tokio::time::timeout(engine.limits.job_timeout, tool.run(&job, arguments))
                        .await
                    {
                        Ok(output) => output,
                        Err(_) => crate::tools::ToolOutput::error(format!(
                            "{name} did not finish within {} minutes.",
                            engine.limits.job_timeout.as_secs() / 60
                        )),
                    }
                }
                None => crate::tools::ToolOutput::error(format!("There is no tool named {name}.")),
            };
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
                if let Err(error) = engine.deliver(&id, &finished) {
                    tracing::error!(%error, "could not store a job result");
                }
            }
        })
    };
    jobs.insert(job.to_owned(), task.abort_handle());
}

/// Cancels the conversation's running jobs and records each as stopped. Returns how many.
pub(super) fn stop_all(engine: &Engine, id: &str) -> usize {
    let stopped: Vec<(String, tokio::task::AbortHandle)> = engine
        .live(id)
        .jobs
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .drain()
        .collect();
    let Ok(events) = engine.load(id) else {
        return stopped.len();
    };
    for (job, handle) in &stopped {
        handle.abort();
        let finished = Event::Known(Known::JobFinished {
            job: job.clone(),
            name: job_name(&events, job),
            content: JOB_STOPPED.to_owned(),
            is_error: true,
        });
        if let Err(error) = engine.record(id, &finished) {
            tracing::error!(%error, "could not store a stopped job");
        }
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
