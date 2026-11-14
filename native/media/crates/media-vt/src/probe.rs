// SPDX-License-Identifier: Apache-2.0
//! The backend's availability trial (ADR 0148). Trials run on one worker
//! thread under a gate: the caller's cancellation and deadline, checked before
//! every operation. At most one worker is in flight per process: a probe that
//! finds one running with the same input joins it (and extends its deadline),
//! and a probe with another input waits for it. A trial still running past an
//! earlier probe's deadline is therefore reused, never duplicated. Unfinished
//! steps are `timed-out`; their results arrive later on [`ProbeReport::late`].
use crate::trials::run_trials;
use media_wire::capability::{Backend, Capability, Step, TrialState};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

/// How the trial feeds its encode sessions. `Cpu` forces one upload per frame,
/// which the report must show as `zeroCopy: false`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrialInput {
    Surface,
    Cpu,
}

#[derive(Clone, Debug, Default)]
pub struct ProbeCancel(Arc<AtomicBool>);
impl ProbeCancel {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

#[derive(Clone, Debug)]
pub struct ProbeOptions {
    pub deadline: Duration,
    pub input: TrialInput,
    pub cancel: ProbeCancel,
}
impl Default for ProbeOptions {
    fn default() -> Self {
        Self {
            deadline: Duration::from_secs(2),
            input: TrialInput::Surface,
            cancel: ProbeCancel::default(),
        }
    }
}

pub struct ProbeReport {
    /// One entry per step and codec, in a fixed order.
    pub capabilities: Vec<Capability>,
    /// Results of trials that finished after the deadline. Closed once the
    /// worker stops.
    pub late: Receiver<Capability>,
}

const STEPS: [(Step, &str); 7] = [
    (Step::Encode, "avc1"),
    (Step::Encode, "hvc1"),
    (Step::Decode, "avc1"),
    (Step::Decode, "hvc1"),
    (Step::JpegEncode, "jpeg"),
    (Step::JpegDecode, "jpeg"),
    (Step::Scale, ""),
];

fn family(capability: &Capability) -> (Step, &str) {
    let codec = capability.codec.as_deref().unwrap_or("");
    (capability.step, codec.get(..4).unwrap_or(codec))
}

pub(crate) fn unfinished(step: Step, codec: &str, state: TrialState) -> Capability {
    Capability {
        step,
        codec: (!codec.is_empty()).then(|| codec.to_owned()),
        backend: Backend::Vt,
        hardware: false,
        zero_copy: false,
        state,
        max_width: 0,
        max_height: 0,
    }
}

/// What the worker checks before each operation.
pub(crate) struct Gate {
    cancel: ProbeCancel,
    deadline: Mutex<Instant>,
}
impl Gate {
    pub(crate) fn open(&self) -> bool {
        !self.cancel.is_cancelled() && Instant::now() < *lock(&self.deadline)
    }
    fn extend(&self, until: Instant) {
        let mut deadline = lock(&self.deadline);
        *deadline = (*deadline).max(until);
    }
}

#[derive(Default)]
struct RunState {
    results: Vec<Capability>,
    late: Vec<Sender<Capability>>,
    done: bool,
}

struct Run {
    input: TrialInput,
    gate: Gate,
    state: Mutex<RunState>,
    changed: Condvar,
}
impl Run {
    fn publish(&self, capability: Capability) {
        let mut state = lock(&self.state);
        state
            .late
            .retain(|late| late.send(capability.clone()).is_ok());
        state.results.push(capability);
        self.changed.notify_all();
    }
    fn finish(&self) {
        let mut state = lock(&self.state);
        state.done = true;
        state.late.clear();
        self.changed.notify_all();
    }
}

static ACTIVE: Mutex<Option<Arc<Run>>> = Mutex::new(None);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Joins the worker in flight with the same input, or starts one.
/// `Ok(None)` when the caller's own deadline or cancellation came first while
/// waiting for another input's worker; `Err` when no thread could start.
fn acquire(options: &ProbeOptions, deadline: Instant) -> Result<Option<Arc<Run>>, ()> {
    loop {
        let mut active = lock(&ACTIVE);
        if let Some(run) = active.as_ref().filter(|run| run.input == options.input) {
            if !lock(&run.state).done {
                run.gate.extend(deadline);
                return Ok(Some(Arc::clone(run)));
            }
        }
        if let Some(run) = active.as_ref().filter(|run| !lock(&run.state).done) {
            // Another input's worker is in flight: wait for it, within our deadline.
            let run = Arc::clone(run);
            drop(active);
            let mut state = lock(&run.state);
            while !state.done {
                let now = Instant::now();
                if now >= deadline || options.cancel.is_cancelled() {
                    return Ok(None);
                }
                let wait = (deadline - now).min(Duration::from_millis(20));
                state = run
                    .changed
                    .wait_timeout(state, wait)
                    .unwrap_or_else(PoisonError::into_inner)
                    .0;
            }
            continue;
        }
        let run = Arc::new(Run {
            input: options.input,
            gate: Gate {
                cancel: options.cancel.clone(),
                deadline: Mutex::new(deadline),
            },
            state: Mutex::new(RunState::default()),
            changed: Condvar::new(),
        });
        let worker = Arc::clone(&run);
        std::thread::Builder::new()
            .name("media-vt-probe".into())
            .spawn(move || {
                run_trials(worker.input, &worker.gate, &|c| worker.publish(c));
                worker.finish();
            })
            .map_err(|_| ())?;
        *active = Some(Arc::clone(&run));
        return Ok(Some(run));
    }
}

fn report(found: &[Capability], missing: TrialState) -> Vec<Capability> {
    STEPS
        .iter()
        .map(|&(step, codec)| {
            found
                .iter()
                .find(|c| family(c) == (step, codec))
                .cloned()
                .unwrap_or_else(|| unfinished(step, codec, missing))
        })
        .collect()
}

/// Runs (or joins) the trials and waits at most `options.deadline`. A probe
/// cancelled before it starts returns at once and starts nothing.
pub fn probe(options: &ProbeOptions) -> ProbeReport {
    let deadline = Instant::now() + options.deadline;
    let (sender, late) = mpsc::channel();
    let empty = |state| ProbeReport {
        capabilities: report(&[], state),
        late: mpsc::channel().1,
    };
    if options.cancel.is_cancelled() {
        return empty(TrialState::TimedOut);
    }
    loop {
        let run = match acquire(options, deadline) {
            Ok(Some(run)) => run,
            Ok(None) => return empty(TrialState::TimedOut),
            Err(()) => return empty(TrialState::Failed),
        };
        let mut state = lock(&run.state);
        while state.results.len() < STEPS.len() && !state.done && !options.cancel.is_cancelled() {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            let wait = (deadline - now).min(Duration::from_millis(20));
            state = run
                .changed
                .wait_timeout(state, wait)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        // A joined worker may have stopped at its old deadline before ours
        // extended it: start a fresh one while our own time remains.
        let stopped_short = state.done && state.results.len() < STEPS.len();
        if stopped_short && Instant::now() < deadline && !options.cancel.is_cancelled() {
            continue;
        }
        let found = state.results.clone();
        if !state.done {
            state.late.push(sender);
        }
        return ProbeReport {
            capabilities: report(&found, TrialState::TimedOut),
            late,
        };
    }
}
