// SPDX-License-Identifier: Apache-2.0
//! The executor's claim, pump and fairness tests (E5.1). New behaviour: nothing in the
//! TypeScript engine had a claim to test, so no case moved here. The interleavings are explicit
//! sequences on one thread, with a counting notifier and no sleeps.

use super::claim::{self, IDLE, RUNNING, RUNNING_DIRTY, SCHEDULED};
use super::*;
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::{Arc, Barrier};

struct Posts {
    posts: AtomicUsize,
    closing: AtomicBool,
}

impl Posts {
    fn new() -> Arc<Posts> {
        Arc::new(Posts {
            posts: AtomicUsize::new(0),
            closing: AtomicBool::new(false),
        })
    }
    fn count(&self) -> usize {
        self.posts.load(SeqCst)
    }
    fn reset(&self) {
        self.posts.store(0, SeqCst);
    }
}

impl Notifier for Arc<Posts> {
    fn notify(&self) -> Notified {
        self.posts.fetch_add(1, SeqCst);
        if self.closing.load(SeqCst) {
            Notified::Closing
        } else {
            Notified::Posted
        }
    }
}

fn executor() -> (Executor, Arc<Posts>) {
    let posts = Posts::new();
    (Executor::new(Box::new(Arc::clone(&posts))), posts)
}

/// The standard turn: 64 runnables or 4 ms.
struct Standard;

impl Budget for Standard {
    fn start(&mut self) {}
    fn spent(&self, started: usize) -> bool {
        started >= 64
    }
}

/// A turn that is spent after every single poll.
struct OnePoll;

impl Budget for OnePoll {
    fn start(&mut self) {}
    fn spent(&self, started: usize) -> bool {
        started >= 1
    }
}

fn open() -> bool {
    false
}

/// A task that stays pending and counts its polls, so a wake is observable. Its waker is
/// collected on the first poll.
fn parked(exec: &Executor, lane: Lane) -> (Rc<Cell<u32>>, std::task::Waker) {
    let polls = Rc::new(Cell::new(0));
    let slot: Rc<RefCell<Option<std::task::Waker>>> = Rc::new(RefCell::new(None));
    let p = Rc::clone(&polls);
    let s = Rc::clone(&slot);
    let task = exec.spawn(lane, async move {
        futures::future::poll_fn(move |cx| {
            s.replace(Some(cx.waker().clone()));
            p.set(p.get() + 1);
            std::task::Poll::Pending::<()>
        })
        .await
    });
    task.detach();
    let mut budget = Standard;
    let _ = exec.pump(&mut budget, &open);
    let waker = slot.borrow().clone().expect("the task stored its waker");
    (polls, waker)
}

/// Runs a task once, on `lane`, as soon as the pump reaches it.
fn run_once(exec: &Executor, lane: Lane, order: Rc<RefCell<Vec<Lane>>>) {
    let task = exec.spawn(lane, async move {
        order.borrow_mut().push(lane);
    });
    task.detach();
}

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

#[test]
fn controls_run_first_but_yield_one_work_runnable_after_eight() {
    let (exec, _posts) = executor();
    let order = Rc::new(RefCell::new(Vec::new()));
    for _ in 0..100 {
        run_once(&exec, Lane::Control, Rc::clone(&order));
    }
    run_once(&exec, Lane::Work, Rc::clone(&order));
    let mut budget = Standard;
    while exec.pump(&mut budget, &open) == Pump::Rearm {}
    let work_at = order
        .borrow()
        .iter()
        .position(|lane| *lane == Lane::Work)
        .expect("the work runnable ran");
    assert!(work_at <= 8, "work ran at poll {work_at}");
    assert!(exec.control_streak() <= 8, "the streak saturates");
}

#[test]
fn work_runs_even_when_every_turn_ends_after_one_slow_control() {
    let (exec, _posts) = executor();
    let order = Rc::new(RefCell::new(Vec::new()));
    for _ in 0..20 {
        run_once(&exec, Lane::Control, Rc::clone(&order));
    }
    run_once(&exec, Lane::Work, Rc::clone(&order));
    let mut pumps = 0;
    while !order.borrow().contains(&Lane::Work) {
        let mut budget = OnePoll;
        assert_eq!(exec.pump(&mut budget, &open), Pump::Rearm);
        pumps += 1;
        assert!(pumps <= 20, "work never starved");
    }
    assert_eq!(pumps, 9, "the work runnable ran in the ninth turn");
    assert_eq!(exec.turns().len(), 9);
}

#[test]
fn a_producer_racing_shutdown_is_refused_once_admission_closes() {
    let (exec, _posts) = executor();
    let exec = Rc::new(exec);
    let mut polls = Vec::new();
    let mut wakers = Vec::new();
    for _ in 0..50 {
        let (count, waker) = parked(&exec, Lane::Work);
        polls.push(count);
        wakers.push(waker);
    }
    let wake = exec.waker();
    let stop = Arc::new(AtomicBool::new(false));
    let accepted = Arc::new(AtomicUsize::new(0));
    let refused = Arc::new(AtomicUsize::new(0));
    let moved = Arc::new(AtomicUsize::new(0));
    let each: Vec<Arc<AtomicUsize>> = (0..50).map(|_| Arc::new(AtomicUsize::new(0))).collect();
    let producer = {
        let wake = wake.clone();
        let stop = Arc::clone(&stop);
        let accepted = Arc::clone(&accepted);
        let refused = Arc::clone(&refused);
        let moved = Arc::clone(&moved);
        let each = each.clone();
        let wakers = wakers.clone();
        std::thread::spawn(move || {
            let mut index = 0;
            while !stop.load(SeqCst) {
                let slot = index % wakers.len();
                match wake.push(Item::Wake(wakers[slot].clone())) {
                    Push::Accepted => {
                        accepted.fetch_add(1, SeqCst);
                        moved.fetch_add(1, SeqCst);
                        each[slot].fetch_add(1, SeqCst);
                    }
                    Push::Refused => {
                        refused.fetch_add(1, SeqCst);
                    }
                }
                index += 1;
            }
        })
    };
    while moved.load(SeqCst) < 25 {
        std::thread::yield_now();
    }
    let mut drain = exec.close_admission();
    // The producer is still looping: wait for the refusal the closed inbox gives it.
    let mut waited = 0;
    while refused.load(SeqCst) == 0 && waited < 1_000_000 {
        waited += 1;
        std::thread::yield_now();
    }
    stop.store(true, SeqCst);
    producer.join().expect("producer thread");
    let mut budget = Standard;
    let mut done = false;
    for _ in 0..1_000 {
        let _ = exec.pump(&mut budget, &open);
        if matches!(drain.try_recv(), Ok(Some(()))) {
            done = true;
            break;
        }
    }
    assert!(done, "the drain completed");
    assert!(accepted.load(SeqCst) > 0);
    assert!(
        refused.load(SeqCst) > 0,
        "pushes after admission closed are refused"
    );
    let woken = each.iter().filter(|slot| slot.load(SeqCst) > 0).count();
    assert!(woken > 0, "the producer pushed before admission closed");
    for (index, count) in polls.iter().enumerate() {
        if each[index].load(SeqCst) > 0 {
            assert!(
                count.get() > 1,
                "accepted item {index} ran: accepted {} polls {}",
                each[index].load(SeqCst),
                count.get()
            );
        }
    }
    let before: Vec<u32> = polls.iter().map(|count| count.get()).collect();
    exec.shut();
    assert_eq!(wake.push(Item::Wake(wakers[0].clone())), Push::Refused);
    let _ = exec.pump(&mut budget, &open);
    let after: Vec<u32> = polls.iter().map(|count| count.get()).collect();
    assert_eq!(before, after, "nothing runs after shut");
}

#[test]
fn a_flood_of_controls_and_a_full_inbox_still_let_work_progress_every_turn() {
    let (exec, _posts) = executor();
    let exec = Rc::new(exec);
    let (_parked, waker) = parked(&exec, Lane::Work);
    let order: Rc<RefCell<Vec<(u32, Lane)>>> = Rc::new(RefCell::new(Vec::new()));
    let turn = Rc::new(Cell::new(0u32));
    /// A runnable that records its poll and requeues another one on its own lane, so neither
    /// queue ever empties.
    fn requeue(
        exec: &Rc<Executor>,
        lane: Lane,
        order: Rc<RefCell<Vec<(u32, Lane)>>>,
        turn: Rc<Cell<u32>>,
    ) {
        let inner = Rc::clone(exec);
        let o = Rc::clone(&order);
        let t = Rc::clone(&turn);
        let task = exec.spawn(lane, async move {
            o.borrow_mut().push((t.get(), lane));
            requeue(&inner, lane, o, t);
        });
        task.detach();
    }
    requeue(&exec, Lane::Control, Rc::clone(&order), Rc::clone(&turn));
    for _ in 0..100 {
        requeue(&exec, Lane::Work, Rc::clone(&order), Rc::clone(&turn));
    }
    let wake = exec.waker();
    for _ in 0..6 {
        for _ in 0..1_000 {
            assert_eq!(wake.push(Item::Wake(waker.clone())), Push::Accepted);
        }
        assert_eq!(exec.claim(), SCHEDULED);
        let before = exec.inbox_len();
        let mut budget = Standard;
        assert_eq!(exec.pump(&mut budget, &open), Pump::Rearm);
        assert!(
            exec.stats().last_turn_polls >= 9,
            "a turn polls a work runnable: {}",
            exec.stats().last_turn_polls
        );
        assert_eq!(before - exec.inbox_len(), 32, "intake moved 32 items");
        assert!(exec.control_streak() <= 8);
        turn.set(turn.get() + 1);
    }
    let order = order.borrow();
    let mut per_turn: std::collections::BTreeMap<u32, usize> = std::collections::BTreeMap::new();
    for (index, lane) in order.iter() {
        if *lane == Lane::Work {
            *per_turn.entry(*index).or_default() += 1;
        }
    }
    assert_eq!(
        per_turn.len(),
        6,
        "every turn ran at least one work runnable"
    );
}

#[test]
fn a_panicking_task_leaves_the_pump_usable_and_reports_its_panic() {
    let (exec, _posts) = executor();
    let task = exec.spawn(Lane::Work, async {
        panic!("boom");
    });
    let mut budget = Standard;
    assert_eq!(exec.pump(&mut budget, &open), Pump::Done);
    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        futures::executor::block_on(task)
    }));
    assert!(panicked.is_err(), "the Task reports the panic");
    let order = Rc::new(RefCell::new(Vec::new()));
    run_once(&exec, Lane::Work, Rc::clone(&order));
    assert_eq!(exec.pump(&mut budget, &open), Pump::Done);
    assert_eq!(order.borrow().len(), 1, "the pump still runs runnables");
}

#[test]
fn after_shut_a_wake_posts_nothing() {
    let (exec, posts) = executor();
    let (_polls, waker) = parked(&exec, Lane::Work);
    exec.shut();
    posts.reset();
    let wake = exec.waker();
    assert_eq!(wake.push(Item::Wake(waker)), Push::Refused);
    assert_eq!(posts.count(), 0, "no notification after shut");
}

/// The pump's own cost, for the bench record: no-op runnables through one budget after another.
/// It prints the rate instead of asserting a wall-clock bound, so a slow machine cannot fail it.
#[test]
fn the_pumps_rate_over_noop_runnables() {
    let (exec, _posts) = executor();
    let wanted = 100_000;
    for _ in 0..wanted {
        let task = exec.spawn(Lane::Work, async {});
        task.detach();
    }
    let began = std::time::Instant::now();
    let mut budget = Standard;
    while exec.pump(&mut budget, &open) == Pump::Rearm {}
    let elapsed = began.elapsed();
    let polls = exec.stats().polls as f64;
    eprintln!(
        "pump: {:.0} runnables/ms ({polls} polls in {elapsed:?})",
        polls / elapsed.as_secs_f64() / 1000.0
    );
    assert!(polls >= wanted as f64);
}
