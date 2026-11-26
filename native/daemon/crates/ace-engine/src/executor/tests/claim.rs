// SPDX-License-Identifier: Apache-2.0
//! Notification claim transitions and producer races.

use super::super::claim::{self, IDLE, RUNNING, RUNNING_DIRTY, SCHEDULED};
use super::*;
use std::sync::Barrier;

/// The producer loop as a scripted sequence: the hook runs between the load and the first CAS.
fn scripted_producer(state: &AtomicU8, hook: impl FnOnce()) -> (u8, usize) {
    let mut seen = state.load(SeqCst);
    let mut posts = 0;
    let mut hook = Some(hook);
    loop {
        let Some(next) = claim::producer_next(seen) else {
            return (seen, posts);
        };
        if let Some(hook) = hook.take() {
            hook();
        }
        match state.compare_exchange(seen, next, SeqCst, SeqCst) {
            Ok(_) => {
                if next == SCHEDULED {
                    posts += 1;
                }
                return (state.load(SeqCst), posts);
            }
            Err(now) => seen = now,
        }
    }
}

#[test]
fn a_wake_that_sees_running_while_the_pump_goes_idle_still_posts() {
    let state = AtomicU8::new(RUNNING);
    // The producer loaded Running; before its CAS the pump moves Running -> Idle.
    let (next, posts) = scripted_producer(&state, || {
        state.store(IDLE, SeqCst);
    });
    assert_eq!(next, SCHEDULED, "the retry saw Idle and scheduled");
    assert_eq!(posts, 1, "the item's notification was not lost");
}

#[test]
fn a_wake_during_the_last_runnable_of_a_spent_budget_runs_next_turn() {
    let (exec, posts) = executor();
    let (parked_polls, waker) = parked(&exec, Lane::Work);
    let wake = exec.waker();
    // The 64th task dirties the claim just as the budget runs out.
    let has_item = Rc::new(Cell::new(false));
    for index in 0..64 {
        let late = Rc::clone(&has_item);
        let woken = waker.clone();
        let handle = wake.clone();
        let task = exec.spawn(Lane::Work, async move {
            if index == 63 && !late.replace(true) {
                let _ = handle.push(Item::Wake(woken));
            }
        });
        task.detach();
    }
    posts.reset();
    let before = parked_polls.get();
    let mut budget = Standard;
    assert_eq!(exec.pump(&mut budget, &open), Pump::Rearm);
    assert_eq!(posts.count(), 0, "a dirtying producer posts nothing");
    assert_eq!(exec.claim(), SCHEDULED);
    let mut budget = Standard;
    while exec.pump(&mut budget, &open) == Pump::Rearm {}
    assert_eq!(parked_polls.get(), before + 1, "the re-armed turn ran it");
}

#[test]
fn an_empty_end_that_finds_the_claim_dirtied_drains_again() {
    // No work left, so the pump CASes Running -> Idle; a producer got there first.
    let state = AtomicU8::new(RUNNING_DIRTY);
    let observed = state
        .compare_exchange(RUNNING, IDLE, SeqCst, SeqCst)
        .expect_err("the producer's dirty claim wins");
    assert_eq!(observed, RUNNING_DIRTY);
    state.store(RUNNING, SeqCst);
    assert_eq!(state.load(SeqCst), RUNNING, "it drains again");
}

#[test]
fn a_stale_entry_changes_nothing() {
    let (exec, posts) = executor();
    posts.reset();
    // No task is queued: the claim is Idle, so the entry is stale.
    let mut budget = Standard;
    assert_eq!(exec.pump(&mut budget, &open), Pump::Stale);
    assert_eq!(exec.claim(), IDLE);
    assert_eq!(posts.count(), 0);
}

#[test]
fn a_nested_pump_is_stale() {
    let (exec, _posts) = executor();
    let exec = Rc::new(exec);
    let seen = Rc::new(Cell::new(Pump::Done));
    let inner = Rc::clone(&exec);
    let slot = Rc::clone(&seen);
    let task = exec.spawn(Lane::Work, async move {
        let mut budget = Standard;
        slot.set(inner.pump(&mut budget, &open));
    });
    task.detach();
    let mut budget = Standard;
    assert_eq!(exec.pump(&mut budget, &open), Pump::Done);
    assert_eq!(seen.get(), Pump::Stale, "a nested entry is stale");
}

#[test]
fn the_claim_table() {
    // Producer: (state, next, posted)
    let producer: [(u8, Option<u8>); 4] = [
        (IDLE, Some(SCHEDULED)),
        (SCHEDULED, None),
        (RUNNING, Some(RUNNING_DIRTY)),
        (RUNNING_DIRTY, None),
    ];
    for (state, next) in producer {
        assert_eq!(claim::producer_next(state), next, "producer from {state}");
    }
    // Entry: only Scheduled starts a turn.
    for state in [IDLE, RUNNING, RUNNING_DIRTY] {
        assert_eq!(claim::entry_next(state), None, "entry from {state}");
    }
    assert_eq!(claim::entry_next(SCHEDULED), Some(RUNNING));
}

#[test]
fn ten_thousand_wakes_from_four_threads_post_at_most_one_notification() {
    let (exec, posts) = executor();
    let exec = Rc::new(exec);
    let (parked_polls, waker) = parked(&exec, Lane::Work);
    let before = parked_polls.get();
    let start = Arc::new(Barrier::new(5));
    let end = Arc::new(Barrier::new(5));
    let mut threads = Vec::new();
    for _ in 0..4 {
        let wake = waker.clone();
        let start = Arc::clone(&start);
        let end = Arc::clone(&end);
        threads.push(std::thread::spawn(move || {
            start.wait();
            for _ in 0..2_500 {
                wake.wake_by_ref();
            }
            end.wait();
        }));
    }
    // The pump's one runnable waits for every producer, so all 10,000 wakes land in one turn.
    let first = Arc::clone(&start);
    let last = Arc::clone(&end);
    let task = exec.spawn(Lane::Work, async move {
        first.wait();
        last.wait();
    });
    task.detach();
    posts.reset();
    let mut budget = Standard;
    while exec.pump(&mut budget, &open) == Pump::Rearm {}
    for thread in threads {
        thread.join().expect("producer thread");
    }
    assert!(posts.count() <= 1, "at most one post: {}", posts.count());
    assert!(
        parked_polls.get() > before,
        "the parked task ran after the wakes"
    );
}
