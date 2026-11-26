// SPDX-License-Identifier: Apache-2.0
//! Pump budgets, turn limits and panic recovery.

use super::*;

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

/// A budget that only stops at the 64-poll ceiling, so a turn has time left at its end.
struct Generous;

impl Budget for Generous {
    fn start(&mut self) {}
    fn spent(&self, started: usize) -> bool {
        started >= 64
    }
}

/// A budget already spent when the turn starts.
struct Spent;

impl Budget for Spent {
    fn start(&mut self) {}
    fn spent(&self, _started: usize) -> bool {
        true
    }
}

#[test]
fn a_turn_moves_at_most_32_inbox_items_across_its_retries() {
    let (exec, _posts) = executor();
    let (_polls, waker) = parked(&exec, Lane::Work);
    let wake = exec.waker();
    for _ in 0..100 {
        assert_eq!(wake.push(Item::Wake(waker.clone())), Push::Accepted);
    }
    let mut budget = Generous;
    assert_eq!(exec.pump(&mut budget, &open), Pump::Rearm);
    // The other 68 wait for the re-armed turn, which the shell schedules.
    assert_eq!(
        exec.inbox_len(),
        68,
        "one turn moves 32 items, retries included"
    );
}

#[test]
fn a_spent_budget_still_polls_the_first_runnable() {
    let (exec, _posts) = executor();
    let order = Rc::new(RefCell::new(Vec::new()));
    run_once(&exec, Lane::Control, Rc::clone(&order));
    let mut budget = Spent;
    assert_eq!(exec.pump(&mut budget, &open), Pump::Rearm);
    assert_eq!(order.borrow().len(), 1, "the first poll is never skipped");
}

#[test]
fn a_task_that_ends_the_turn_stops_the_turn_after_its_poll_and_the_rest_runs_in_the_next() {
    let (exec, _posts) = executor();
    let exec = Rc::new(exec);
    let ran = Rc::new(RefCell::new(Vec::<&'static str>::new()));
    // The first task asks the turn to end; the second must wait for the next turn.
    let first = Rc::clone(&ran);
    let asking = Rc::clone(&exec);
    let task = exec.spawn(Lane::Work, async move {
        first.borrow_mut().push("first");
        asking.end_turn();
    });
    task.detach();
    let second = Rc::clone(&ran);
    let task = exec.spawn(Lane::Work, async move {
        second.borrow_mut().push("second");
    });
    task.detach();
    let mut budget = Standard;
    let outcome = exec.pump(&mut budget, &open);
    assert_eq!(outcome, Pump::Rearm, "the turn ends after the asking poll");
    assert_eq!(*ran.borrow(), vec!["first"]);
    let outcome = exec.pump(&mut budget, &open);
    assert_eq!(outcome, Pump::Done);
    assert_eq!(*ran.borrow(), vec!["first", "second"]);
}
