// SPDX-License-Identifier: Apache-2.0
//! The moved cases for `provider-sessions.ts`: the bindings a thread keeps when a provider leaves,
//! so a return hands over only what happened since (`provider-return.process`).

use super::{LeftSession, MAX_PER_THREAD, ProviderSessions};
use crate::repository::testsupport::{Shell, header, home};
use ace_store::Value as Cell;

fn left(provider: &str, instance: Option<&str>, native: &str, through: u64) -> LeftSession {
    LeftSession {
        provider: provider.to_owned(),
        instance_id: instance.map(str::to_owned),
        backend: None,
        native_session_id: native.to_owned(),
        through_seq: through,
    }
}

fn rows(store: &crate::EngineStore, thread: &str) -> usize {
    let all = ace_store::stmt_cache::all_rows(
        store.conn(),
        "SELECT through_seq FROM engine_provider_sessions WHERE thread_id=? ORDER BY through_seq",
        vec![Cell::Text(thread.to_owned())],
    )
    .expect("rows");
    all.len()
}

#[test]
fn a_left_session_is_recalled_most_recent_first_and_by_its_own_account() {
    let conn = home("recall", &header("recall"));
    let store = Shell::store(&conn);
    let sessions = ProviderSessions::default();
    sessions
        .leave(
            &store,
            "recall",
            &left("claude", Some("work"), "native-1", 5),
        )
        .expect("leave");
    sessions
        .leave(
            &store,
            "recall",
            &left("claude", Some("personal"), "native-2", 9),
        )
        .expect("leave");

    // With no account named, the most recent binding wins.
    let latest = sessions
        .recall(&store, "recall", "claude", None)
        .expect("recall")
        .expect("a session");
    assert_eq!(latest.native_session_id, "native-2");
    assert_eq!(latest.through_seq, 9);
    // The account asked for resumes its own session, however old.
    let own = sessions
        .recall(&store, "recall", "claude", Some("work"))
        .expect("recall")
        .expect("a session");
    assert_eq!(own.native_session_id, "native-1");
    assert_eq!(own.instance_id.as_deref(), Some("work"));
    // Another provider, or another thread, has nothing.
    assert!(
        sessions
            .recall(&store, "recall", "codex", None)
            .expect("recall")
            .is_none()
    );
}

#[test]
fn only_sixteen_sessions_are_kept_per_thread() {
    let conn = home("prune", &header("prune"));
    let store = Shell::store(&conn);
    let sessions = ProviderSessions::default();
    for through in 0..18 {
        sessions
            .leave(
                &store,
                "prune",
                &left(
                    "pi",
                    Some(&format!("account-{through}")),
                    &format!("native-{through}"),
                    through,
                ),
            )
            .expect("leave");
    }
    assert_eq!(rows(&store, "prune"), MAX_PER_THREAD);
    assert!(
        sessions
            .recall(&store, "prune", "pi", None)
            .expect("recall")
            .is_some_and(|session| session.through_seq == 17),
        "the newest stays"
    );
    // The two oldest through_seq values were pruned.
    let oldest = ace_store::stmt_cache::get_row(
        store.conn(),
        "SELECT MIN(through_seq) AS n FROM engine_provider_sessions WHERE thread_id='prune'",
        vec![],
    )
    .expect("min");
    assert!(matches!(
        oldest.and_then(|row| row.get("n").cloned()),
        Some(Cell::Integer(2))
    ));
}

#[test]
fn forgetting_a_lost_native_session_stops_offering_it() {
    let conn = home("forget", &header("forget"));
    let store = Shell::store(&conn);
    let sessions = ProviderSessions::default();
    sessions
        .leave(&store, "forget", &left("codex", Some("a"), "native-a", 3))
        .expect("leave");
    sessions
        .leave(&store, "forget", &left("codex", Some("b"), "native-b", 4))
        .expect("leave");
    sessions
        .forget(&store, "forget", "codex", "native-b")
        .expect("forget");
    let recalled = sessions
        .recall(&store, "forget", "codex", None)
        .expect("recall")
        .expect("a session");
    assert_eq!(recalled.native_session_id, "native-a");
}

#[test]
fn a_malformed_binding_is_refused_at_the_call_and_never_written() {
    let conn = home("bounds", &header("bounds"));
    let store = Shell::store(&conn);
    let sessions = ProviderSessions::default();

    assert!(
        sessions
            .leave(&store, "bounds", &left("nope", None, "native", 1))
            .is_err()
    );
    assert!(
        sessions
            .leave(&store, "bounds", &left("pi", Some(""), "native", 1))
            .is_err(),
        "an empty account id is refused"
    );
    let long_instance = "\u{1f600}".repeat(257);
    assert!(
        sessions
            .leave(
                &store,
                "bounds",
                &left("pi", Some(&long_instance), "native", 1)
            )
            .is_err(),
        "257 code points exceed the 256 bound"
    );
    assert!(
        sessions
            .leave(&store, "bounds", &left("pi", None, "", 1))
            .is_err()
    );
    let long_native = "\u{1f600}".repeat(513);
    assert!(
        sessions
            .leave(&store, "bounds", &left("pi", None, &long_native, 1))
            .is_err()
    );

    // Rule 17: 512 emoji are 1,024 UTF-16 units and still fit `z.string().max(512)`.
    let at_bound = "\u{1f600}".repeat(512);
    sessions
        .leave(&store, "bounds", &left("pi", None, &at_bound, 1))
        .expect("the bound counts code points");
    let long_backend = "\u{1f600}".repeat(257);
    let mut with_backend = left("pi", None, "native", 1);
    with_backend.backend = Some(long_backend);
    assert!(
        sessions.leave(&store, "bounds", &with_backend).is_err(),
        "the backend names a 256 code-point bound"
    );
}

#[test]
fn a_malformed_stored_row_is_not_recalled() {
    let conn = home("stored", &header("stored"));
    let store = Shell::store(&conn);
    store
        .conn()
        .exec("INSERT INTO engine_provider_sessions VALUES ('stored','nope','',NULL,'native',1)")
        .expect("insert");
    let sessions = ProviderSessions::default();
    assert!(
        sessions
            .recall(&store, "stored", "nope", None)
            .expect("recall")
            .is_none(),
        "an unknown provider kind is not a resumable session"
    );
}
