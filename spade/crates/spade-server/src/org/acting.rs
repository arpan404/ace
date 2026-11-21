//! Who a step on an org host is taken for (ADR 0206 §4.1): the member whose stamp asked for it,
//! or the organization's policy. A route sets it around the work it does on its blocking thread;
//! what the store records with that work (a package link's entries) reads it there. A step run
//! later on another thread (an update held for the bot's still moment) has none, and is recorded
//! as the host's.

use std::cell::RefCell;

use spade_core::org::Member;
use spade_core::org::steps::Actor;

thread_local! {
    static ACTING: RefCell<Option<Actor>> = const { RefCell::new(None) };
}

tokio::task_local! {
    /// The same, for a step a route awaits (deleting a bot), across its awaits.
    static ACTING_TASK: Option<Actor>;
}

/// Runs `work` as `actor`, then puts back whoever was acting before.
pub fn acting<T>(actor: Option<Actor>, work: impl FnOnce() -> T) -> T {
    let before = ACTING.with(|acting| acting.replace(actor));
    let done = work();
    ACTING.with(|acting| acting.replace(before));
    done
}

/// [`acting`] for the member a stamp proved, if one did.
pub fn as_member<T>(member: Option<&Member>, work: impl FnOnce() -> T) -> T {
    acting(member.cloned().map(Actor::Member), work)
}

/// Awaits `work` as the member a stamp proved, if one did.
pub async fn scoped<F: std::future::Future>(member: Option<&Member>, work: F) -> F::Output {
    ACTING_TASK
        .scope(member.cloned().map(Actor::Member), work)
        .await
}

/// Who is acting here now: on this thread, else in the task being polled.
pub fn current() -> Option<Actor> {
    ACTING
        .with(|acting| acting.borrow().clone())
        .or_else(|| ACTING_TASK.try_with(Clone::clone).ok().flatten())
}
