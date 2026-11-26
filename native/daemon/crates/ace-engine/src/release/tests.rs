// SPDX-License-Identifier: Apache-2.0
//! The moved cases: `provider-release.process.test.ts` (7) and `resource-limits.process.test.ts`'s
//! "a new thread reclaims an idle thread's slot instead of being refused".

use super::{
    ProviderProcessState, Release, list_provider_processes, provider_process_state,
    reclaim_idle_slot, release_request, released_thread,
};
use crate::State;
use crate::actor::state::{Actor, Actors};
use crate::repository::testsupport::{Shell, header, home};
use crate::repository::{ReclaimView, Repo};
use crate::sessions::Sessions;
use std::collections::HashSet;

#[test]
fn a_done_thread_keeps_its_provider_warm_for_the_idle_window_then_releases_it() {
    // provider-release.process.test.ts: "a done thread keeps its provider warm for the idle
    // window, then releases it".
    let mut state = State::default();
    let mut actor = Actor::new("t".to_owned(), 0, 0);
    actor.instance = 1;
    actor.session_attached = true;
    actor.idle_since = Some(1_000.0);
    state.actors.by_thread.insert("t".to_owned(), actor);
    let listed = list_provider_processes(
        &state,
        super::DEFAULT_PROVIDER_IDLE_MS,
        |_| false,
        |_| Some("claude".to_owned()),
    );
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].state, ProviderProcessState::IdleWarm);
    assert_eq!(
        listed[0].release_at,
        Some(1_000.0 + super::DEFAULT_PROVIDER_IDLE_MS)
    );

    // Settling asks for the release now: the same process releases at its idle instant.
    state
        .actors
        .by_thread
        .get_mut("t")
        .expect("actor")
        .release_requested = true;
    let listed = list_provider_processes(
        &state,
        super::DEFAULT_PROVIDER_IDLE_MS,
        |_| false,
        |_| Some("claude".to_owned()),
    );
    assert_eq!(listed[0].release_at, Some(1_000.0));
}

#[test]
fn settling_a_done_thread_releases_its_provider_at_once() {
    // provider-release.process.test.ts: "settling a done thread releases its provider at once
    // and the next message resumes it".
    let event = ace_json::json!({"type": "thread.client.updated", "changes": {"settledAt": 5}});
    assert_eq!(release_request(&event), Some(Release::Release));
    assert!(released_thread(false, true));
    let withdrawn =
        ace_json::json!({"type": "thread.client.updated", "changes": {"settledAt": null}});
    assert_eq!(release_request(&withdrawn), Some(Release::Withdraw));
    assert!(!released_thread(false, false));
    // A message resumes it: no event says anything about release.
    let message = ace_json::json!({"type": "input.admitted"});
    assert_eq!(release_request(&message), None);
}

#[test]
fn archiving_a_done_thread_releases_its_provider_at_once() {
    // provider-release.process.test.ts: "archiving a done thread releases its provider at once".
    let archived = ace_json::json!({"type": "thread.updated", "archivedAt": 7});
    assert_eq!(release_request(&archived), Some(Release::Release));
    assert!(released_thread(true, false));
    let restored = ace_json::json!({"type": "thread.updated", "archivedAt": null});
    assert_eq!(release_request(&restored), Some(Release::Withdraw));
    // A thread that is not archived or settled keeps its provider.
    let other = ace_json::json!({"type": "thread.updated", "status": "done"});
    assert_eq!(release_request(&other), None);
}

#[test]
fn a_live_subagent_keeps_the_provider_alive_however_long_the_root_has_been_idle() {
    // provider-release.process.test.ts: "a live subagent keeps the provider alive however long
    // the root has been idle". Live work holds the process busy: no idle instant to release at.
    assert_eq!(
        provider_process_state(true, false, None, false),
        Some(ProviderProcessState::Busy)
    );
    assert_eq!(
        provider_process_state(true, true, Some(1.0), false),
        Some(ProviderProcessState::Releasing)
    );
    assert_eq!(provider_process_state(false, false, Some(1.0), false), None);
    // An archived or settled thread's process is releasing even before its task exits.
    assert_eq!(
        provider_process_state(true, false, Some(1.0), true),
        Some(ProviderProcessState::Releasing)
    );
}

#[test]
fn one_stdout_reads_worth_of_deltas_is_not_a_resource_limit() {
    // resource-limits.process.test.ts: "one stdout read worth of streamed deltas is folded
    // without failing the thread". A provider process stays warm while its tree works, so the
    // engine never reports it as resource-limited.
    assert_eq!(
        provider_process_state(true, false, None, false),
        Some(ProviderProcessState::Busy)
    );
    assert_eq!(
        provider_process_state(true, false, Some(2_000.0), false),
        Some(ProviderProcessState::IdleWarm)
    );
}

#[test]
fn a_new_thread_reclaims_an_idle_threads_slot_instead_of_being_refused() {
    // resource-limits.process.test.ts: "a new thread reclaims an idle thread's slot instead of
    // being refused".
    let conn = home("reclaim", &header("reclaim"));
    let store = Shell::store(&conn);
    conn.exec("INSERT INTO engine_slots VALUES ('reclaim')")
        .expect("slot");
    let mut actors = Actors::default();
    let mut actor = Actor::new("reclaim".to_owned(), 0, 0);
    actor.instance = 1;
    actor.session_attached = true;
    actor.idle_since = Some(1_000.0);
    actors.by_thread.insert("reclaim".to_owned(), actor);
    let mut sessions = Sessions::default();
    let repo = Repo::default();
    let retiring = HashSet::new();

    let picked = reclaim_idle_slot(
        ReclaimView {
            actors: &mut actors,
            sessions: &sessions,
            store: &store,
            repo: &repo,
        },
        &retiring,
    )
    .expect("reclaim");
    assert_eq!(picked.as_deref(), Some("reclaim"));
    assert!(
        actors.by_thread.get("reclaim").expect("actor").idle_due,
        "the slot no longer counts as taken"
    );

    // A closing session is never asked to close again, and neither is a retiring thread.
    if let Some(actor) = actors.by_thread.get_mut("reclaim") {
        actor.idle_due = false;
    }
    sessions.closing.insert("reclaim".to_owned());
    let none = reclaim_idle_slot(
        ReclaimView {
            actors: &mut actors,
            sessions: &sessions,
            store: &store,
            repo: &repo,
        },
        &retiring,
    )
    .expect("reclaim");
    assert_eq!(none, None);
}

#[test]
fn a_reserve_reclaims_through_the_installed_hooks_own_view() {
    // slot-reclaim.ts: `reserve` asks the hook only when the slots are full; the hook reads the
    // actors and sessions through the view, never through the state the repository already
    // borrows.
    let conn = home("reserve", &header("reserve"));
    let store = Shell::store(&conn);
    conn.exec("INSERT INTO engine_slots VALUES ('old')")
        .expect("slot");
    let mut repo = Repo::new(1);
    repo.reclaim = Some(Box::new(|retiring, view| {
        reclaim_idle_slot(view, retiring).ok().flatten()
    }));
    let mut state = State {
        repo,
        ..State::default()
    };
    let mut actor = Actor::new("old".to_owned(), 0, 0);
    actor.instance = 1;
    actor.session_attached = true;
    actor.idle_since = Some(1_000.0);
    state.actors.by_thread.insert("old".to_owned(), actor);

    assert!(
        state.reserve_slot(&store, "new").expect("reserve"),
        "the full table reclaimed the warm slot instead of refusing"
    );
    assert!(
        state.actors.by_thread.get("old").expect("actor").idle_due,
        "the reclaimed thread is asked to close"
    );

    // A closing session is never reclaimed: the reserve refuses instead.
    let conn = home("reserve-closing", &header("reserve-closing"));
    let store = Shell::store(&conn);
    conn.exec("INSERT INTO engine_slots VALUES ('old')")
        .expect("slot");
    let mut repo = Repo::new(1);
    repo.reclaim = Some(Box::new(|retiring, view| {
        reclaim_idle_slot(view, retiring).ok().flatten()
    }));
    let mut state = State {
        repo,
        ..State::default()
    };
    let mut actor = Actor::new("old".to_owned(), 0, 0);
    actor.session_attached = true;
    actor.idle_since = Some(1_000.0);
    state.actors.by_thread.insert("old".to_owned(), actor);
    state.sessions.closing.insert("old".to_owned());
    assert!(!state.reserve_slot(&store, "new").expect("reserve"));
}

#[test]
fn an_archived_or_settled_thread_keeps_no_provider_warm() {
    // provider-release.process.test.ts: "archiving a replied thread ends the background command
    // it left running" and "settling a done thread releases the commands it left running with
    // its provider": both start from `releasedThread`.
    assert!(released_thread(true, false));
    assert!(released_thread(false, true));
    assert!(released_thread(true, true));
    assert!(!released_thread(false, false));
}
