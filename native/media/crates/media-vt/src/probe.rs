// SPDX-License-Identifier: Apache-2.0
//! The backend's availability trial (ADR 0148). Trials run on one worker
//! thread under a gate checked before every operation: the caller's
//! cancellation, and [`LATE_LIMIT`] past the latest caller's deadline. The
//! deadline bounds only how long `probe` waits; the worker keeps going after
//! it, so a step a busy machine finishes late still arrives on `late`. At most one worker is in flight per process: a probe that
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

/// How long the worker keeps trying after the latest caller's deadline, for its results to
/// arrive late. Only a driver that hangs reaches it; cancellation stops the worker sooner.
pub const LATE_LIMIT: Duration = Duration::from_secs(30);

/// What the worker checks before each operation. Every caller sharing the worker subscribes
/// with its own cancellation; one caller cancelling never stops the others' trial.
pub(crate) struct Gate {
    subscribers: Mutex<Vec<ProbeCancel>>,
    deadline: Mutex<Instant>,
}
impl Gate {
    fn new(cancel: ProbeCancel, deadline: Instant) -> Self {
        Self {
            subscribers: Mutex::new(vec![cancel]),
            deadline: Mutex::new(deadline),
        }
    }
    /// Open while any subscriber is still active, until [`LATE_LIMIT`] past the latest caller's
    /// deadline: a step past the deadline still runs, and its result arrives late.
    /// Cancelled subscribers are let go of here, so a long run holds only the waiting ones.
    pub(crate) fn open(&self) -> bool {
        let mut subscribers = lock(&self.subscribers);
        subscribers.retain(|c| !c.is_cancelled());
        !subscribers.is_empty() && Instant::now() < *lock(&self.deadline) + LATE_LIMIT
    }
    #[cfg(test)]
    fn subscribers(&self) -> usize {
        lock(&self.subscribers).len()
    }
    /// Another caller joins: its cancellation counts, and its deadline extends the worker's.
    fn join(&self, cancel: ProbeCancel, until: Instant) {
        let mut subscribers = lock(&self.subscribers);
        subscribers.retain(|c| !c.is_cancelled());
        subscribers.push(cancel);
        drop(subscribers);
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
fn acquire(
    options: &ProbeOptions,
    deadline: Instant,
    trials: Trials,
) -> Result<Option<Arc<Run>>, ()> {
    loop {
        let mut active = lock(&ACTIVE);
        if let Some(run) = active.as_ref().filter(|run| run.input == options.input) {
            if !lock(&run.state).done {
                run.gate.join(options.cancel.clone(), deadline);
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
            gate: Gate::new(options.cancel.clone(), deadline),
            state: Mutex::new(RunState::default()),
            changed: Condvar::new(),
        });
        let worker = Arc::clone(&run);
        std::thread::Builder::new()
            .name("media-vt-probe".into())
            .spawn(move || {
                trials(worker.input, &worker.gate, &|c| worker.publish(c));
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
    probe_with(options, run_trials)
}

/// What the worker runs: every trial, publishing each step as it finishes.
type Trials = fn(TrialInput, &Gate, &dyn Fn(Capability));

fn probe_with(options: &ProbeOptions, trials: Trials) -> ProbeReport {
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
        let run = match acquire(options, deadline, trials) {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(step: Step, codec: &str) -> Capability {
        Capability {
            state: TrialState::Ok,
            hardware: true,
            ..unfinished(step, codec, TrialState::Ok)
        }
    }

    /// Encodes at once, then takes 150 ms (three times the deadline) before its decode step.
    fn slow_decode(_: TrialInput, gate: &Gate, publish: &dyn Fn(Capability)) {
        publish(ok(Step::Encode, "avc1"));
        std::thread::sleep(Duration::from_millis(150));
        if !gate.open() {
            return;
        }
        publish(ok(Step::Decode, "avc1"));
    }

    fn state_of(found: &[Capability], step: Step) -> Option<TrialState> {
        found
            .iter()
            .find(|c| family(c) == (step, "avc1"))
            .map(|c| c.state)
    }

    /// The worker is one per process: these tests take turns on it.
    static TURN: Mutex<()> = Mutex::new(());

    #[test]
    fn a_step_finishing_after_the_deadline_arrives_late_unless_the_probe_is_cancelled() {
        let _turn = lock(&TURN);
        let options = ProbeOptions {
            deadline: Duration::from_millis(50),
            ..Default::default()
        };
        let report = probe_with(&options, slow_decode);
        assert_eq!(
            state_of(&report.capabilities, Step::Encode),
            Some(TrialState::Ok)
        );
        assert_eq!(
            state_of(&report.capabilities, Step::Decode),
            Some(TrialState::TimedOut)
        );
        // The worker keeps going past the deadline: its decode upgrades the report.
        let late = report.late.recv_timeout(Duration::from_secs(2));
        assert_eq!(
            late.map(|c| (c.step, c.state)),
            Ok((Step::Decode, TrialState::Ok))
        );
        assert!(report.late.recv_timeout(Duration::from_secs(2)).is_err());

        // Cancelled past its deadline, it stops at its next step and the late channel closes.
        let cancelled = ProbeOptions {
            deadline: Duration::from_millis(50),
            ..Default::default()
        };
        let report = probe_with(&cancelled, slow_decode);
        cancelled.cancel.cancel();
        assert_eq!(
            report.late.recv_timeout(Duration::from_secs(2)),
            Err(mpsc::RecvTimeoutError::Disconnected)
        );
    }

    #[test]
    fn a_caller_cancelling_leaves_the_shared_worker_running_for_the_others() {
        let _turn = lock(&TURN);
        let first = ProbeOptions {
            deadline: Duration::from_millis(40),
            ..Default::default()
        };
        let second = ProbeOptions {
            deadline: Duration::from_millis(40),
            ..Default::default()
        };
        // Both time out on one worker: the second joins while the first's decode is pending.
        let a = probe_with(&first, slow_decode);
        let b = probe_with(&second, slow_decode);
        assert_eq!(
            state_of(&b.capabilities, Step::Decode),
            Some(TrialState::TimedOut)
        );
        // The first caller goes away (a restart); the second is still waiting for its decode.
        first.cancel.cancel();
        drop(a);
        let late = b.late.recv_timeout(Duration::from_secs(2));
        assert_eq!(
            late.map(|c| (c.step, c.state)),
            Ok((Step::Decode, TrialState::Ok))
        );

        // Once every caller has cancelled, the worker stops at its next step.
        let first = ProbeOptions {
            deadline: Duration::from_millis(40),
            ..Default::default()
        };
        let second = ProbeOptions {
            deadline: Duration::from_millis(40),
            ..Default::default()
        };
        let _a = probe_with(&first, slow_decode);
        let b = probe_with(&second, slow_decode);
        first.cancel.cancel();
        second.cancel.cancel();
        assert_eq!(
            b.late.recv_timeout(Duration::from_secs(2)),
            Err(mpsc::RecvTimeoutError::Disconnected)
        );
    }

    #[test]
    fn a_cancelled_caller_is_let_go_of_while_the_others_keep_the_worker() {
        let now = Instant::now();
        let gate = Gate::new(ProbeCancel::default(), now);
        let callers: Vec<ProbeCancel> = (0..100).map(|_| ProbeCancel::default()).collect();
        for caller in &callers {
            gate.join(caller.clone(), now);
        }
        for caller in &callers {
            caller.cancel();
        }
        assert!(gate.open(), "the first caller still waits");
        assert_eq!(gate.subscribers(), 1, "the cancelled ones are let go of");
    }
}
