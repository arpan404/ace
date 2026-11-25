// SPDX-License-Identifier: Apache-2.0
//! `thread-lease.process.test.ts` moved here: a thread ace closed can be held
//! by another Codex process, which excludes every other writer until released;
//! a thread a live ace session still has open is reported busy after every
//! attempt. The writers store is the fake's own cross-process lock
//! (`testing/writer-store.ts`), so both cases are real processes.

use super::*;
use crate::session::harness::{Event, HostRun, LeaseRun, Scratch, WAIT_MS};
use crate::session::host::Retirement;
use crate::session::pool::{CODEX_ELISION, initialize};

/// The thread the fake resumes, as the adapter's own test names it.
const NATIVE: &str = "11111111-1111-4111-8111-111111111111";

fn host(name: &str, writers: &str) -> HostRun {
    HostRun::start(
        Scratch::new(name),
        crate::session::host::HostConfig::shared(initialize(), 60_000.0),
        CODEX_ELISION,
        Some(writers),
    )
}

fn resume(host: &HostRun, tenant: u64, thread: &str) {
    let _ = host.request(
        tenant,
        "thread/resume",
        &ace_json::json!({"threadId": thread, "excludeTurns": true}),
    );
    assert!(
        host.events.until(WAIT_MS, |event| matches!(
            event,
            Event::Frame { tenant: who, data, .. }
                if *who == tenant
                    && data.get("result").and_then(|result| result.get("thread")).is_some()
        )),
        "the thread resumes"
    );
}

fn lease(name: &str, writers: &str, attempts: usize) -> LeaseRun {
    LeaseRun::start(
        Scratch::new(name),
        crate::session::harness::lease_config(),
        ace_json::JsString::from(NATIVE),
        attempts,
        Some(writers),
    )
}

/// `thread-lease.process.test.ts`: "a thread ace closed can be held by another
/// Codex process, which excludes every other writer until released".
#[test]
fn a_thread_ace_closed_can_be_held_which_excludes_every_writer_until_released() {
    let root = Scratch::new("lease-writers");
    let writers = root.writers();

    let session = host("lease-session", &writers);
    let _ = session.attach(1);
    assert!(session.wait_ready(1));
    resume(&session, 1, NATIVE);
    // Closing the session unsubscribes the thread, and the fake unloads it at
    // once because every ace app-server is told to.
    session.apply(session.host.detach(1, Retirement::Idle, "idle"));
    assert!(session.events.until(WAIT_MS, |event| matches!(
        event,
        Event::Exited { tenant: 1, .. }
    )));

    let holding = lease("lease-first", &writers, 1);
    assert!(holding.wait_outcome());
    assert_eq!(holding.outcome(), Some(Event::Held), "the thread is free");

    // While the lease holds it, another codex process is refused.
    let second = lease("lease-second", &writers, 1);
    assert!(second.wait_outcome());
    assert_eq!(
        second.outcome(),
        Some(Event::NotHeld(BUSY_REASON.to_owned()))
    );

    // Neither can ace open it: the provider says the thread has a writer.
    let opening = session.request(
        1,
        "thread/resume",
        &ace_json::json!({"threadId": NATIVE, "excludeTurns": true}),
    );
    assert!(
        session.events.until(WAIT_MS, |event| matches!(
            event,
            Event::Settle { id, failed: true } if *id == opening
        )),
        "the open is refused by the writer lock"
    );

    // Releasing unsubscribes, which unloads the thread, then stops the
    // process; the lock is free again.
    holding.release();
    assert!(
        holding
            .events
            .until(WAIT_MS, |event| matches!(event, Event::Released))
    );
    let third = lease("lease-third", &writers, 1);
    assert!(third.wait_outcome());
    assert_eq!(third.outcome(), Some(Event::Held));

    for run in [&second, &third, &holding] {
        run.stop();
    }
    session.stop();
}

/// `thread-lease.process.test.ts`: "a thread a live ace session still has open
/// is reported busy after every attempt".
#[test]
fn a_thread_a_live_ace_session_still_has_open_is_reported_busy_after_every_attempt() {
    let root = Scratch::new("lease-busy");
    let writers = root.writers();

    let session = host("lease-open", &writers);
    let _ = session.attach(1);
    assert!(session.wait_ready(1));
    resume(&session, 1, NATIVE);

    let busy = lease("lease-busy-open", &writers, 3);
    assert!(busy.wait_outcome());
    assert_eq!(busy.outcome(), Some(Event::NotHeld(BUSY_REASON.to_owned())));
    // Every attempt was made, and each waited for its own retry.
    let attempts = busy
        .events
        .snapshot()
        .into_iter()
        .filter(|event| matches!(event, Event::Wrote { .. }))
        .count();
    assert!(attempts >= 4, "initialize, initialized and three resumes");

    busy.stop();
    session.stop();
}
