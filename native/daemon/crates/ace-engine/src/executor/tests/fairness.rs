// SPDX-License-Identifier: Apache-2.0
//! Lane scheduling under control and inbox pressure.

use super::*;
use crate::executor::claim::SCHEDULED;

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
