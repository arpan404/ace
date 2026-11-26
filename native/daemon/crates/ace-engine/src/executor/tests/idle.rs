// SPDX-License-Identifier: Apache-2.0
//! Quiescence while ordinary tasks and barriers are queued or running.

use super::*;

/// A task that parks forever, so its runnable stays queued until it is polled once.
fn parked_barrier(exec: &Executor, lane: Lane) -> async_task::Task<(), TaskId> {
    exec.spawn_barrier(lane, async {
        futures::future::pending::<()>().await;
    })
}

#[test]
fn a_queued_barrier_is_not_work() {
    let (exec, _posts) = executor();
    let barrier = parked_barrier(&exec, Lane::Control);
    assert!(exec.idle(None), "only a waiting flush is queued");
    barrier.detach();
}

#[test]
fn a_barrier_beside_queued_work_is_not_idle_until_the_work_runs() {
    let (exec, _posts) = executor();
    let barrier = parked_barrier(&exec, Lane::Work);
    let work = exec.spawn(Lane::Work, async {
        futures::future::pending::<()>().await;
    });
    assert!(!exec.idle(None), "the queued work is not a barrier");
    let mut budget = Standard;
    while exec.pump(&mut budget, &open) == Pump::Rearm {}
    assert!(exec.idle(None), "both parked, neither queued");
    barrier.detach();
    work.detach();
}

#[test]
fn a_running_work_task_is_busy_but_a_running_barrier_is_not() {
    let (exec, _posts) = executor();
    let exec = Rc::new(exec);
    let seen = Rc::new(Cell::new(None));
    let (slot, inner) = (Rc::clone(&seen), Rc::clone(&exec));
    let task = exec.spawn(Lane::Work, async move {
        slot.set(Some(inner.idle(None)));
    });
    task.detach();
    let mut budget = Standard;
    assert_eq!(exec.pump(&mut budget, &open), Pump::Done);
    assert_eq!(seen.get(), Some(false), "the running task is work");

    let (slot, inner) = (Rc::clone(&seen), Rc::clone(&exec));
    seen.set(None);
    let task = exec.spawn_barrier(Lane::Work, async move {
        slot.set(Some(inner.idle(None)));
    });
    task.detach();
    let mut budget = Standard;
    assert_eq!(exec.pump(&mut budget, &open), Pump::Done);
    assert_eq!(
        seen.get(),
        Some(true),
        "the running barrier waits for others"
    );

    let (slot, inner) = (Rc::clone(&seen), Rc::clone(&exec));
    seen.set(None);
    let task = exec.spawn(Lane::Work, async move {
        // A flush reached from inside an ordinary task excludes its own poll.
        let me = inner.current();
        slot.set(Some(inner.idle(me)));
    });
    task.detach();
    let mut budget = Standard;
    assert_eq!(exec.pump(&mut budget, &open), Pump::Done);
    assert_eq!(seen.get(), Some(true), "its own poll is excluded");
}

#[test]
fn a_barrier_that_is_dropped_while_queued_leaves_the_queue() {
    let (exec, _posts) = executor();
    let barrier = parked_barrier(&exec, Lane::Work);
    let work = exec.spawn(Lane::Work, async {
        futures::future::pending::<()>().await;
    });
    work.detach();
    assert!(!exec.idle(None));
    barrier.detach();
    assert!(!exec.idle(None), "the ordinary work is still queued");
    exec.shut();
    assert!(exec.idle(None), "shutdown drops every queued runnable");
}

/// The window a concurrent wake can hit: a producer has counted its runnable and has not
/// pushed it yet. `idle` must read the ordinary count directly, never infer it from lengths.
#[test]
fn a_producer_counted_before_its_push_keeps_the_engine_busy() {
    let (exec, _posts) = executor();
    // The producer has counted the ordinary runnable and has not pushed it yet, so both lanes
    // still look empty; the old length-minus-barriers test said idle here.
    exec.shared.ordinary_queued.fetch_add(1, SeqCst);
    assert!(!exec.idle(None), "the counted runnable is work");
    exec.shared.ordinary_queued.fetch_sub(1, SeqCst);
    assert!(exec.idle(None), "counted and popped, nothing is left");
}
