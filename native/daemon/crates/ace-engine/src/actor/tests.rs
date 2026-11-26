// SPDX-License-Identifier: Apache-2.0
//! The actor's own cases: terminal cleanup at close, a pledged actor kept resolvable across a
//! rollback, the engine-wide workload figures, and frame-handle ownership across a retry.

use super::state::{ActorInstance, ActorRef, FrameRef, Pending, Seat};
use super::{finish_close, get_or_create, live_thread_ids, mailbox, state, workload_counts};
use crate::actor::deps::{ActorDeps, ActorRepo, FrameAcks, Unported};
use crate::actor::{flow, intake};
use crate::executor::{Notified, Notifier};
use crate::frames::envelope::{AccountField, Envelope, Field, PayloadField};
use crate::frames::live::UnportedLive;
use crate::limits::LimitOverrides;
use crate::ports::{PortError, Ports};
use crate::repository::testsupport::{Shell, header, home};
use crate::state::{EngineStack, Inputs};
use crate::{Core, Engine, EngineError, ThreadId};
use ace_json::Value;
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::Arc;

/// The engine's executor never posts a notification in a test: no pump runs.
struct NoNotify;

impl Notifier for NoNotify {
    fn notify(&self) -> Notified {
        Notified::Posted
    }
}

/// The frame acknowledgements, counted: a handle released twice is visible, which the shell's
/// idempotent table deletion would hide.
#[derive(Default)]
struct CountingAcks {
    next: Cell<u64>,
    released: RefCell<Vec<u32>>,
    settled: RefCell<Vec<(u64, Option<String>)>>,
}

impl FrameAcks for CountingAcks {
    fn alloc(&self) -> Option<u64> {
        let next = self.next.get() + 1;
        self.next.set(next);
        Some(next)
    }

    fn settle(&self, call: u64, reject: Option<String>) {
        self.settled.borrow_mut().push((call, reject));
    }

    fn release(&self, handles: &[u32]) {
        self.released.borrow_mut().extend_from_slice(handles);
    }
}

/// The creation path's reads only: every other repository call stays unported, as production's
/// `EngineRepo` leaves it until E5.4 and E5.6 land.
struct TestRepo;

impl ActorRepo for TestRepo {
    fn status(&self, core: &Core, thread: &ThreadId) -> Result<Value, EngineError> {
        Unported.status(core, thread)
    }
    fn route(&self, core: &Core, thread: &ThreadId) -> Result<super::deps::Route, EngineError> {
        Unported.route(core, thread)
    }
    fn quiescent(&self, core: &Core, thread: &ThreadId) -> Result<bool, EngineError> {
        Unported.quiescent(core, thread)
    }
    fn running_foreground_command(
        &self,
        core: &Core,
        thread: &ThreadId,
    ) -> Result<bool, EngineError> {
        Unported.running_foreground_command(core, thread)
    }
    fn stream(
        &self,
        core: &Core,
        thread: &ThreadId,
        facts: &[Value],
        now: f64,
    ) -> Result<bool, EngineError> {
        Unported.stream(core, thread, facts, now)
    }
    fn apply(
        &self,
        core: &Core,
        thread: &ThreadId,
        facts: &[Value],
        now: f64,
        generation: u64,
    ) -> Result<(), EngineError> {
        Unported.apply(core, thread, facts, now, generation)
    }
    fn deadline(
        &self,
        core: &Core,
        thread: &ThreadId,
        translator: Option<i64>,
    ) -> Result<Option<f64>, EngineError> {
        Unported.deadline(core, thread, translator)
    }
    fn schedule_view(
        &self,
        core: &Core,
        thread: &ThreadId,
    ) -> Result<Option<super::deps::ScheduleView>, EngineError> {
        Unported.schedule_view(core, thread)
    }
    fn evict(&self, _core: &Core, _thread: &ThreadId) {}
    fn clear_incomplete_blobs(&self, _core: &Core, _thread: &ThreadId) {}
    fn root_agent_id(&self, core: &Core, thread: &ThreadId) -> Result<Option<String>, EngineError> {
        Unported.root_agent_id(core, thread)
    }
    fn engine_queue_fact(
        &self,
        core: &Core,
        thread: &ThreadId,
    ) -> Result<Option<Value>, EngineError> {
        Unported.engine_queue_fact(core, thread)
    }
    fn queue_paused(&self, core: &Core, thread: &ThreadId) -> Result<bool, EngineError> {
        Unported.queue_paused(core, thread)
    }
    fn queued_count(&self, _core: &Core, _thread: &ThreadId) -> Result<u64, EngineError> {
        Ok(0)
    }
    fn latest_generation(&self, _core: &Core, _thread: &ThreadId) -> Result<u64, EngineError> {
        Ok(0)
    }
    fn mark_yielded_end(
        &self,
        core: &Core,
        thread: &ThreadId,
        facts: Vec<Value>,
    ) -> Result<Vec<Value>, EngineError> {
        Unported.mark_yielded_end(core, thread, facts)
    }
    fn session_instance(
        &self,
        core: &Core,
        thread: &ThreadId,
    ) -> Result<Option<String>, EngineError> {
        Unported.session_instance(core, thread)
    }
    fn reserved_slot(&self, _core: &Core, _thread: &ThreadId) -> Result<bool, EngineError> {
        Ok(false)
    }
    fn retiring_count(&self, _core: &Core) -> Result<usize, EngineError> {
        Ok(0)
    }
    fn released_thread(&self, _core: &Core, _thread: &ThreadId) -> Result<bool, EngineError> {
        Ok(false)
    }
    fn attachment(
        &self,
        core: &Core,
        thread: &ThreadId,
        hash: &str,
    ) -> Result<Option<Value>, EngineError> {
        Unported.attachment(core, thread, hash)
    }
    fn cursor_record(
        &self,
        core: &Core,
        thread: &ThreadId,
        entries: &[Value],
    ) -> Result<(), EngineError> {
        Unported.cursor_record(core, thread, entries)
    }
}

/// A whole engine on a temp home, with the counted acknowledgements and the shell's transaction
/// lifecycle.
struct Harness {
    engine: Engine,
    shell: Rc<Shell>,
    acks: Rc<CountingAcks>,
    _conn: Arc<ace_store::Connection>,
}

impl Harness {
    fn with_limits(thread: &str, max_active_threads: f64) -> Harness {
        let conn = home(thread, &header(thread));
        let (_store, shell) = Shell::store_with_controls(&conn);
        let acks = Rc::new(CountingAcks::default());
        let deps = ActorDeps::new(
            Rc::new(TestRepo),
            Rc::new(Unported),
            Rc::new(UnportedLive),
            Rc::clone(&acks) as Rc<dyn FrameAcks>,
            0.0,
        );
        let inputs = Inputs {
            limits: LimitOverrides {
                max_active_threads: Some(max_active_threads),
                ..LimitOverrides::default()
            },
            ..Inputs::default()
        };
        let engine = Engine::new(
            Rc::clone(&shell) as Rc<dyn Ports>,
            Rc::clone(&shell) as Rc<dyn EngineStack>,
            inputs,
            "[]",
            Box::new(NoNotify),
            &conn,
            Rc::new(deps),
        )
        .expect("the engine builds");
        Harness {
            engine,
            shell,
            acks,
            _conn: conn,
        }
    }
}

fn bare_actor(thread: &str, instance: u64, generation: u64) -> ActorRef {
    let actor = Rc::new(RefCell::new(ActorInstance::new(
        thread.to_string(),
        generation,
    )));
    actor.borrow_mut().instance = instance;
    actor
}

fn install_actor(core: &Rc<Core>, thread: &str, instance: u64, generation: u64) -> ActorRef {
    let actor = bare_actor(thread, instance, generation);
    core.with_state(|state| {
        let seat = state.actors.next_seat;
        state.actors.next_seat += 1;
        state.actors.seats.insert(
            thread.to_string(),
            Seat {
                order: seat,
                provisional: false,
            },
        );
        state
            .actors
            .by_thread
            .insert(thread.to_string(), Rc::clone(&actor));
    })
    .expect("the state is free");
    actor
}

fn pending(handle: u32, generation: u64, bytes: usize) -> Pending {
    Pending {
        frame: FrameRef::Js { handle, sdk: false },
        generation,
        bytes,
    }
}

fn envelope(seq: f64) -> Envelope {
    Envelope {
        is_object: true,
        seq: Field::Number(seq),
        t: Field::Number(seq),
        dir: Field::String("recv".into()),
        channel: Field::String("stdio".into()),
        payload: PayloadField::Absent,
        usage_account: AccountField::Absent,
    }
}

fn input(seq: f64, handle: u32) -> intake::FrameInput {
    intake::FrameInput {
        frame: FrameRef::Js { handle, sdk: false },
        envelope: envelope(seq),
        channel_sdk: false,
        measure: intake::Measure::Certified { bytes: 4 },
        native_ack: None,
    }
}

#[test]
fn close_retires_both_actor_sets_and_admits_no_late_frame() {
    let harness = Harness::with_limits("close", 4.0);
    let core = harness.engine.core();
    let current = install_actor(core, "a", 1, 0);
    current.borrow_mut().session_attached = true;
    current.borrow_mut().pending.push(pending(11, 0, 5));
    let (open_tx, mut open_rx) = crate::futures::channel::oneshot::channel();
    current.borrow_mut().pending_ack = Some(crate::actor::BatchAck {
        js: None,
        native: vec![open_tx],
    });

    // An evicted actor whose accepted batch is still in its mailbox when close cuts in.
    let evicted = bare_actor("b", 2, 0);
    let frames = vec![pending(12, 0, 2)];
    let handles = Rc::new(RefCell::new(mailbox::Handles::from_frames(&frames)));
    let (sealed_tx, mut sealed_rx) = crate::futures::channel::oneshot::channel();
    evicted
        .borrow_mut()
        .mailbox
        .push_back(mailbox::Op::Batch(Box::new(mailbox::BatchOp {
            frames,
            bytes: 2,
            ack: crate::actor::BatchAck {
                js: None,
                native: vec![sealed_tx],
            },
            admitted: true,
            memory: mailbox::BatchMemory::default(),
            handles,
        })));
    core.with_state(|state| state.actors.stopping.insert(2, Rc::clone(&evicted)))
        .expect("the state is free");

    // A pledged victim kept aside for a transaction that can no longer commit.
    let pledged = bare_actor("c", 3, 0);
    pledged.borrow_mut().pending.push(pending(14, 0, 1));
    let (pledged_tx, mut pledged_rx) = crate::futures::channel::oneshot::channel();
    pledged.borrow_mut().pending_ack = Some(crate::actor::BatchAck {
        js: None,
        native: vec![pledged_tx],
    });
    core.with_state(|state| state.actors.aside.insert(3, Rc::clone(&pledged)))
        .expect("the state is free");

    finish_close(core);

    assert_eq!(
        harness.acks.released.borrow().as_slice(),
        [11, 12, 14],
        "each held payload is released once"
    );
    assert_eq!(
        open_rx.try_recv(),
        Ok(Some(Err("Engine closed".to_string()))),
        "no native acknowledgement sender is retained"
    );
    assert_eq!(
        sealed_rx.try_recv(),
        Ok(Some(Err("Engine closed".to_string())))
    );
    assert_eq!(
        pledged_rx.try_recv(),
        Ok(Some(Err("Engine closed".to_string())))
    );
    assert!(current.borrow().pending.is_empty() && current.borrow().mailbox.is_empty());
    assert!(evicted.borrow().mailbox.is_empty());
    assert!(pledged.borrow().pending.is_empty());
    assert!(state::session_instance(core, "a", 1).is_none());
    assert!(state::session_instance(core, "b", 2).is_none());
    assert!(state::session_instance(core, "c", 3).is_none());
    assert!(
        core.with_state(|state| live_thread_ids(state))
            .expect("the state is free")
            .is_empty()
    );

    // A late frame reaches the retired instance directly, as a stuck session's callback could.
    let late = intake::frame(core, &current, 0, input(3.0, 13));
    assert!(matches!(late, intake::Ack::Done), "never admitted");
    assert!(current.borrow().pending.is_empty());
    assert_eq!(
        harness.acks.released.borrow().as_slice(),
        [11, 12, 14],
        "the shell keeps the refused frame's object"
    );
}

#[test]
fn a_pledged_actor_stays_resolvable_and_a_rollback_keeps_its_frame() {
    let harness = Harness::with_limits("pledge", 1.0);
    let core = harness.engine.core();
    let original = install_actor(core, "a", 1, 0);
    original.borrow_mut().pressure = true;

    let outcome = core.store.atomic(|_| {
        get_or_create(core, &"b".to_string())?;
        let resolved =
            state::session_instance(core, "a", 1).expect("a pledged actor stays resolvable");
        assert_eq!(resolved.borrow().instance, 1);
        assert!(
            flow::paused(core, Some(&resolved)),
            "its session sees its own pressure, not the provisional actor's"
        );
        let ack = intake::frame(core, &resolved, 0, input(1.0, 21));
        assert!(
            matches!(ack, intake::Ack::Batch(Some(_))),
            "the frame joins the pledged actor's batch"
        );
        Err::<(), _>(EngineError::Port(PortError::Threw("rollback".into())))
    });
    assert!(outcome.is_err(), "the transaction rolled back");
    let dropped = harness.shell.take_dropped();
    assert!(
        !dropped.is_empty(),
        "the promotion was deferred to the commit"
    );
    core.after.drop_tokens(&dropped);

    let restored = state::session_instance(core, "a", 1).expect("the original actor is restored");
    assert_eq!(
        restored.borrow().pending.len(),
        1,
        "the frame delivered during the transaction is still waiting for its batch"
    );
    assert!(
        harness.acks.released.borrow().is_empty(),
        "it was never released as done"
    );
    assert_eq!(
        core.with_state(|state| live_thread_ids(state))
            .expect("the state is free"),
        ["a"],
        "the provisional actor is discarded"
    );
}

#[test]
fn workload_counts_an_evicted_actors_accepted_tail() {
    let harness = Harness::with_limits("workload", 4.0);
    let core = harness.engine.core();
    let current = install_actor(core, "a", 1, 0);
    current.borrow_mut().session_attached = true;
    current.borrow_mut().pending.push(pending(31, 0, 10));
    current.borrow_mut().pending_bytes = 10;
    let stopping = bare_actor("b", 2, 0);
    {
        let mut state = stopping.borrow_mut();
        state.queued = 3;
        state.queued_bytes = 7;
    }
    core.with_state(|state| state.actors.stopping.insert(2, Rc::clone(&stopping)))
        .expect("the state is free");

    assert_eq!(
        core.with_state(|state| workload_counts(state))
            .expect("the state is free"),
        (1, 4, 17),
        "an old instance's accepted batch is still engine work"
    );
}

#[test]
fn a_retry_and_a_failure_release_each_frame_handle_once() {
    let frames = vec![pending(41, 0, 1), pending(42, 0, 1), pending(43, 1, 1)];
    let mut owned = mailbox::Handles::from_frames(&frames);
    let acks = CountingAcks::default();

    // Generation 0 is current here, so handle 43 is stale: released once, however often the
    // batch retries.
    acks.release(&owned.take_stale(&frames, 0));
    acks.release(&owned.take_stale(&frames, 0));
    assert_eq!(acks.released.borrow().as_slice(), [43]);

    // Translation consumes the live handles: a fatal failure afterwards has nothing to release.
    assert_eq!(owned.take_live(&frames, 0), [41, 42]);
    acks.release(&owned.take_all());
    assert_eq!(
        acks.released.borrow().as_slice(),
        [43],
        "no handle is released twice"
    );
}

#[test]
fn a_discarded_batch_releases_only_the_handles_it_still_owns() {
    let harness = Harness::with_limits("discard", 4.0);
    let core = harness.engine.core();
    let actor = install_actor(core, "a", 1, 0);
    let frames = vec![pending(51, 0, 1), pending(52, 0, 1)];
    let handles = Rc::new(RefCell::new(mailbox::Handles::from_frames(&frames)));
    // A fold already translated and consumed both.
    assert_eq!(handles.borrow_mut().take_live(&frames, 0), [51, 52]);
    actor
        .borrow_mut()
        .mailbox
        .push_back(mailbox::Op::Batch(Box::new(mailbox::BatchOp {
            frames,
            bytes: 2,
            ack: crate::actor::BatchAck::default(),
            admitted: true,
            memory: mailbox::BatchMemory::default(),
            handles: Rc::clone(&handles),
        })));

    state::discard_acks(core, &actor);

    assert!(
        harness.acks.released.borrow().is_empty(),
        "translated handles are not released again"
    );
    assert!(actor.borrow().mailbox.is_empty());
}
