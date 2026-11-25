// SPDX-License-Identifier: Apache-2.0
//! The executor's claim, pump and fairness tests (E5.1). New behaviour: nothing in the
//! TypeScript engine had a claim to test, so no case moved here. The interleavings are explicit
//! sequences on one thread, with a counting notifier and no sleeps.

use super::*;
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize};

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

mod claim;
mod fairness;
mod idle;
mod pump;
mod shutdown;
