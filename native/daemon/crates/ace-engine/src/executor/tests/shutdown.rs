// SPDX-License-Identifier: Apache-2.0
//! Producer admission and shutdown while work is in flight.

use super::*;

/// The window shutdown can hit: a producer has counted its runnable, shutdown drains (and once
/// zeroed the count), then the refused push releases the count again.
#[test]
fn a_producer_paused_across_shutdown_does_not_wrap_the_ordinary_count() {
    let (exec, _posts) = executor();
    // The producer's count, then shutdown before its push.
    exec.shared.ordinary_queued.fetch_add(1, SeqCst);
    exec.shut();
    // Its queue is closed, so the push is refused and the count is released through the one
    // saturating path.
    exec.shared.release_ordinary();
    assert_eq!(
        exec.shared.ordinary_queued.load(SeqCst),
        0,
        "the count never wraps"
    );
    assert!(exec.idle(None), "an idle engine stays idle");
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
                // Yield each push so the backlog the pump must drain stays bounded: the test is
                // about the close/push race, not about how fast one thread can flood the inbox.
                std::thread::yield_now();
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
    for _ in 0..10_000 {
        let _ = exec.pump(&mut budget, &open);
        if matches!(drain.try_recv(), Ok(Some(()))) {
            done = true;
            break;
        }
    }
    assert!(
        done,
        "the drain completed (claim={}, draining={}, accepted={}, refused={})",
        exec.claim(),
        exec.draining_pending(),
        accepted.load(SeqCst),
        refused.load(SeqCst)
    );
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
fn after_shut_a_wake_posts_nothing() {
    let (exec, posts) = executor();
    let (_polls, waker) = parked(&exec, Lane::Work);
    exec.shut();
    posts.reset();
    let wake = exec.waker();
    assert_eq!(wake.push(Item::Wake(waker)), Push::Refused);
    assert_eq!(posts.count(), 0, "no notification after shut");
}

#[test]
fn a_producer_paused_between_its_check_and_its_push_never_blocks_close() {
    let (exec, _posts) = executor();
    let exec = Rc::new(exec);
    let (count, waker) = parked(&exec, Lane::Work);
    let wake = exec.waker();
    // The producer's next push stops after its admission check, before its inbox push.
    exec.shared.pause_producer.store(true, SeqCst);
    let finished = Arc::new(AtomicBool::new(false));
    let producer = {
        let finished = Arc::clone(&finished);
        let waker = waker.clone();
        std::thread::spawn(move || {
            let _ = wake.push(Item::Wake(waker));
            finished.store(true, SeqCst);
        })
    };
    // Wait until the producer is paused inside its counted span, then close admission.
    while exec.shared.inflight.load(SeqCst) == 0 {
        std::thread::yield_now();
    }
    let started = std::time::Instant::now();
    let mut drain = exec.close_admission();
    // The close returned at once, on the JS thread, with the producer still paused.
    assert!(started.elapsed() < std::time::Duration::from_millis(300));
    assert!(!finished.load(SeqCst));
    // Its push is refused once the pause ends, and the drain still completes.
    exec.shared.pause_producer.store(false, SeqCst);
    producer.join().expect("producer thread");
    let mut budget = Standard;
    let mut done = false;
    for _ in 0..10_000 {
        let _ = exec.pump(&mut budget, &open);
        if matches!(drain.try_recv(), Ok(Some(()))) {
            done = true;
            break;
        }
    }
    assert!(done, "the drain completed");
    assert_eq!(count.get(), 1, "the refused push never ran");
}
