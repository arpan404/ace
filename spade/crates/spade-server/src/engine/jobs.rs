//! Background jobs: a call to a `background` tool answers at once and runs here. Its result is
//! delivered like a message, so it steers the open turn or starts a new one.
//!
//! A job stays in the live map until its end is stored. Running, Stop owns its end: it cancels the
//! job and records it stopped before returning. Once the job has its result it is finishing: it
//! stores the result itself, and the `stop_requested` event Stop stores first keeps that result
//! (or a restart's "lost" report) from opening a reply.
//! Starting a job and Stop take the same lock, and a start checks the turn's stop signal under it,
//! so Stop never misses a job that is just starting.

use std::collections::HashMap;
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

/// A job in the live map, with the reply that started it.
pub(super) enum Job {
    Running {
        reply: String,
        handle: tokio::task::AbortHandle,
    },
    /// Has its result and is storing it. A Stop meanwhile is stored as `stop_requested`, which
    /// keeps that result from opening a reply.
    Finishing { reply: String },
}

impl Job {
    fn reply(&self) -> &str {
        match self {
            Self::Running { reply, .. } | Self::Finishing { reply } => reply,
        }
    }
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
    let work = {
        let (engine, key, name) = (engine.clone(), format!("{id}.{job}"), name.to_owned());
        async move { run(&engine, &key, &name, arguments).await }
    };
    begin(engine, id, reply, job, name, Box::pin(work), stop)
}

/// Moves a call still running after the foreground window to the background (ADR 0158): the same
/// run carries on as job `job`, unless the turn was stopped, and then `work` is dropped, which
/// cuts it off like any call in flight. The caller then answers the call with
/// `context::moved_to_background`.
pub(super) fn adopt(
    engine: &Arc<Engine>,
    id: &str,
    reply: &str,
    job: &str,
    name: &str,
    work: crate::tools::ToolFuture,
    stop: &watch::Receiver<bool>,
) -> Result<Started, StoreError> {
    begin(engine, id, reply, job, name, work, stop)
}

fn begin(
    engine: &Arc<Engine>,
    id: &str,
    reply: &str,
    job: &str,
    name: &str,
    work: crate::tools::ToolFuture,
    stop: &watch::Receiver<bool>,
) -> Result<Started, StoreError> {
    let live = engine.live(id);
    let mut jobs = live.jobs.lock().unwrap_or_else(|p| p.into_inner());
    if *stop.borrow() || engine.deleting(id) {
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
    let handle = spawn(engine, id, reply, job, name, work);
    jobs.insert(
        job.to_owned(),
        Job::Running {
            reply: reply.to_owned(),
            handle,
        },
    );
    Ok(Started::Running)
}

/// Runs the job's work and stores its end, as a task; the caller puts it in the live map.
fn spawn(
    engine: &Arc<Engine>,
    id: &str,
    reply: &str,
    job: &str,
    name: &str,
    work: crate::tools::ToolFuture,
) -> tokio::task::AbortHandle {
    let task = {
        let (engine, id, job, name, reply) = (
            engine.clone(),
            id.to_owned(),
            job.to_owned(),
            name.to_owned(),
            reply.to_owned(),
        );
        tokio::spawn(async move {
            let output = work.await;
            // A failure that may pass parks the job: it stays running in the record and runs
            // again when its retry wake fires (ADR 0160).
            if output.transient && output.is_error && !output.uncertain {
                let parked = {
                    let live = engine.live(&id);
                    let mut jobs = live.jobs.lock().unwrap_or_else(|p| p.into_inner());
                    // Gone means Stop already took this job's end.
                    matches!(jobs.get(&job), Some(Job::Running { .. }))
                        && engine.park_job(&id, &job, &output.content)
                        && jobs.remove(&job).is_some()
                };
                if parked {
                    engine.announce(&id);
                    return;
                }
            }
            {
                let live = engine.live(&id);
                let mut jobs = live.jobs.lock().unwrap_or_else(|p| p.into_inner());
                // Gone means Stop already took this job's end.
                if !matches!(jobs.get(&job), Some(Job::Running { .. })) {
                    return;
                }
                jobs.insert(
                    job.clone(),
                    Job::Finishing {
                        reply: reply.clone(),
                    },
                );
            }
            // What the job showed the person goes in the bubble of the reply that started it.
            if !output.shared.is_empty() {
                let shared = Event::Known(Known::Shared {
                    reply: reply.clone(),
                    call_id: job.clone(),
                    images: output.shared.images.clone(),
                    documents: output.shared.documents.clone(),
                });
                keep_trying(|| engine.record(&id, &shared).map(|_| ())).await;
            }
            let content = super::trim::trim(&output.content, engine.limits.result_chars);
            // A helper's spend shows with the turn that reads its result (ADR 0152).
            let cost_micros = if name == spade_core::helper::TOOL {
                engine.helper_cost(&id, &job)
            } else {
                None
            };
            let finished = Event::Known(Known::JobFinished {
                job: job.clone(),
                name,
                content,
                is_error: output.is_error,
                uncertain: output.uncertain,
                files: output.files.to_vec(),
                untrusted: output.untrusted,
                cost_micros,
            });
            keep_trying(|| engine.deliver(&id, &finished)).await;
            engine
                .live(&id)
                .jobs
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&job);
            engine.announce(&id);
        })
    };
    task.abort_handle()
}

/// Cancels every job of a conversation whose agent is being deleted. Nothing is stored: the
/// conversation goes with it.
pub(super) fn cancel_all(live: &super::Live) {
    let mut jobs = live.jobs.lock().unwrap_or_else(|p| p.into_inner());
    for (_, job) in jobs.drain() {
        if let Job::Running { handle, .. } = job {
            handle.abort();
        }
    }
}

/// Runs the job's tool for as long as it takes (ADR 0158): Stop ends it, nothing else does.
/// `key` is unique across conversations and stable for this job.
async fn run(engine: &Engine, key: &str, name: &str, arguments: Value) -> ToolOutput {
    let Some(tool) = engine.tools.get(name) else {
        return ToolOutput::error(format!("There is no tool named {name}."));
    };
    tool.run(key, arguments).await
}

/// Stores something known only here (a job's end, a tool's result, a reply's close), retrying
/// with waits up to 30 seconds for as long as Spade runs: losing it would leave the work running
/// forever in the record.
pub(super) async fn keep_trying(mut store: impl FnMut() -> Result<(), StoreError>) {
    let mut wait = Duration::from_millis(250);
    while let Err(error) = store() {
        // The conversation was deleted with its agent: there is nothing left to keep.
        if matches!(error, StoreError::NoConversation(_)) {
            return;
        }
        tracing::error!(%error, "could not store an event; trying again");
        tokio::time::sleep(wait).await;
        wait = (wait * 2).min(Duration::from_secs(30));
    }
}

/// Stops the jobs a stored `stop_requested` named: those listed in `named`, and any started by
/// `reply`. A running one is cancelled and stored as stopped before this returns, so a restart
/// can never bring it back; a finishing one keeps its result, which opens no reply because the
/// caller stored `stop_requested` first. Jobs of later replies keep running. Returns how many
/// were stopped.
pub(super) fn stop_named(
    engine: &Arc<Engine>,
    id: &str,
    reply: Option<&str>,
    named: &[String],
) -> usize {
    let (cancelled, quietened) = {
        let live = engine.live(id);
        // The lock a job start takes, so the choice cannot miss or mistake one starting now.
        let mut jobs = live.jobs.lock().unwrap_or_else(|p| p.into_inner());
        take_named(&mut jobs, reply, named)
    };
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
                    uncertain: true,
                    files: Vec::new(),
                    untrusted: false,
                    cost_micros: None,
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

/// Cancels and removes the running jobs a stop names (listed, or started by `reply`) and counts
/// the finishing ones it names. Returns the cancelled job ids and that count.
fn take_named(
    jobs: &mut HashMap<String, Job>,
    reply: Option<&str>,
    named: &[String],
) -> (Vec<String>, usize) {
    let mut cancelled = Vec::new();
    let mut quietened = 0;
    jobs.retain(|job, state| {
        if !named.contains(job) && reply != Some(state.reply()) {
            return true;
        }
        match state {
            Job::Running { handle, .. } => {
                handle.abort();
                cancelled.push(job.clone());
                false
            }
            Job::Finishing { .. } => {
                quietened += 1;
                true
            }
        }
    });
    (cancelled, quietened)
}

/// After a restart: every job the stored events show as running was lost with the old process.
/// Each is delivered as "unknown outcome", so the model can tell the person or check.
pub(super) fn report_lost(engine: &Arc<Engine>, id: &str) -> Result<(), StoreError> {
    let events = engine.load(id)?;
    for job in Transcript::fold(events.iter()).jobs {
        // A job parked for a retry is not running: its wake runs it again (ADR 0160).
        if spade_core::wake::parked(&events, &job) {
            continue;
        }
        // A helper's work is all in its events: its job runs again and waits for it (ADR 0152).
        if let Some(helper) = engine.store.helper_for_job(id, &job)? {
            // Unless Stop was stored for it before the restart and its end was not: the stop
            // holds, so the helper is closed as stopped and never resumed.
            if spade_core::turn::job_stopped(&events, &job) {
                engine.stop_helper_after_restart(&helper)?;
                let stopped = Event::Known(Known::JobFinished {
                    name: job_name(&events, &job),
                    job,
                    content: JOB_STOPPED.to_owned(),
                    is_error: true,
                    uncertain: true,
                    files: Vec::new(),
                    untrusted: false,
                    cost_micros: None,
                });
                engine.record(id, &stopped)?;
            } else {
                reattach(engine, id, &events, &job, spade_core::helper::TOOL);
            }
            continue;
        }
        // A job waiting on ace's children runs again and reattaches to them, so the bot never
        // reads as idle while they work (AGENTS.md priority 1).
        let name = job_name(&events, &job);
        if crate::tools::reattaches(&name) && !spade_core::turn::job_stopped(&events, &job) {
            reattach_ace(engine, id, &events, &job, &name);
            continue;
        }
        let finished = Event::Known(Known::JobFinished {
            name,
            job,
            content: JOB_LOST.to_owned(),
            is_error: true,
            uncertain: true,
            files: Vec::new(),
            untrusted: false,
            cost_micros: None,
        });
        engine.deliver(id, &finished)?;
    }
    Ok(())
}

/// A parked job's retry wake fired (ADR 0160): the same call runs again as the same job. A
/// `delegate` or `wait` waits for ace's tools first, like after a restart.
pub(super) fn rerun(engine: &Arc<Engine>, id: &str, job: &str) {
    let Ok(events) = engine.load(id) else { return };
    if spade_core::turn::job_stopped(&events, job) || engine.deleting(id) {
        return;
    }
    let name = job_name(&events, job);
    if crate::tools::reattaches(&name) {
        reattach_ace(engine, id, &events, job, &name);
    } else {
        reattach(engine, id, &events, job, &name);
    }
    engine.announce(id);
}

/// How long a reattached ace job waits for ace's tools to come back before it says its outcome is
/// unknown.
const ACE_BACK_WITHIN: Duration = Duration::from_secs(10 * 60);

/// Runs a lost `delegate` or `wait` job again after a restart, once ace's tools are back: it
/// reattaches to the same children and waits for them.
fn reattach_ace(engine: &Arc<Engine>, id: &str, events: &[Event], job: &str, name: &str) {
    let (reply, arguments) = call_of(events, job, name);
    let live = engine.live(id);
    let mut jobs = live.jobs.lock().unwrap_or_else(|p| p.into_inner());
    let work = {
        let (engine, key, name) = (engine.clone(), format!("{id}.{job}"), name.to_owned());
        async move {
            let started = std::time::Instant::now();
            while engine.tools.get(&name).is_none() {
                if started.elapsed() > ACE_BACK_WITHIN {
                    return ToolOutput::maybe_ran(JOB_LOST.to_owned());
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            run(&engine, &key, &name, arguments).await
        }
    };
    let handle = spawn(engine, id, &reply, job, name, Box::pin(work));
    jobs.insert(job.to_owned(), Job::Running { reply, handle });
}

/// The reply that started job `job` of tool `tool` and its call's arguments, as stored: the inner
/// tool's own when the call went through `call_tool`.
fn call_of(events: &[Event], job: &str, tool: &str) -> (String, Value) {
    let reply = events.iter().find_map(|event| match event {
        Event::Known(Known::JobStarted { job: j, reply, .. }) if j == job => Some(reply.clone()),
        _ => None,
    });
    let arguments = events
        .iter()
        .filter_map(|event| match event {
            Event::Known(Known::StepFinished { calls, .. }) => Some(calls),
            _ => None,
        })
        .flatten()
        .find(|call| call.id == job)
        .map(|call| call.arguments.clone())
        .unwrap_or(Value::Null);
    let arguments = match spade_core::tools::unwrap_call_tool(&arguments) {
        Some((inner, arguments)) if inner == tool => arguments,
        _ => arguments,
    };
    (reply.unwrap_or_default(), arguments)
}

/// Runs job `job` (of tool `tool`) again with its call's arguments: a helper's after a restart,
/// which finds its helper and waits for its end; a parked job's at its retry.
fn reattach(engine: &Arc<Engine>, id: &str, events: &[Event], job: &str, tool: &str) {
    let (reply, arguments) = call_of(events, job, tool);
    let live = engine.live(id);
    let mut jobs = live.jobs.lock().unwrap_or_else(|p| p.into_inner());
    let work = {
        let (engine, key, tool) = (engine.clone(), format!("{id}.{job}"), tool.to_owned());
        async move { run(&engine, &key, &tool, arguments).await }
    };
    let handle = spawn(engine, id, &reply, job, tool, Box::pin(work));
    jobs.insert(job.to_owned(), Job::Running { reply, handle });
}

impl Engine {
    /// Ends every running job without storing anything, as the process exiting does, so a test
    /// that restarts in one process sees what a real restart finds. Only with `test-hooks`.
    #[cfg(feature = "test-hooks")]
    pub fn drop_jobs_as_on_exit(&self) {
        let live: Vec<Arc<super::Live>> = self
            .live
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values()
            .cloned()
            .collect();
        for one in live {
            let mut jobs = one.jobs.lock().unwrap_or_else(|p| p.into_inner());
            for (_, job) in jobs.drain() {
                if let Job::Running { handle, .. } = job {
                    handle.abort();
                }
            }
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn running(reply: &str, task: &tokio::task::JoinHandle<()>) -> Job {
        Job::Running {
            reply: reply.to_owned(),
            handle: task.abort_handle(),
        }
    }

    #[tokio::test]
    async fn a_stop_for_one_reply_leaves_a_later_replys_job_running() {
        let forever = || tokio::spawn(std::future::pending::<()>());
        let (first, older, later) = (forever(), forever(), forever());
        let mut jobs = HashMap::from([
            ("j1".to_owned(), running("r1", &first)),
            ("j0".to_owned(), running("r0", &older)),
            // Started by r2 after the stop for r1 was stored.
            ("j2".to_owned(), running("r2", &later)),
        ]);
        let (mut cancelled, _) = take_named(&mut jobs, Some("r1"), &["j0".to_owned()]);
        cancelled.sort();
        assert_eq!(cancelled, vec!["j0".to_owned(), "j1".to_owned()]);
        tokio::task::yield_now().await;
        assert!(first.await.is_err_and(|e| e.is_cancelled()));
        assert!(older.await.is_err_and(|e| e.is_cancelled()));
        assert!(!later.is_finished(), "r2's job keeps running");
        assert!(jobs.contains_key("j2"));
    }
}
