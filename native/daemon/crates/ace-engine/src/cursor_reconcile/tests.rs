// SPDX-License-Identifier: Apache-2.0
//! The reconcile queue: a marked thread holds its lanes until its reconcile ends.

use super::*;

#[test]
fn a_marked_thread_is_held_and_released_exactly_once() {
    let mut state = crate::State::default();
    assert!(!holds(&state, "t"));
    mark(&mut state, "t");
    assert!(holds(&state, "t"));
    assert_eq!(take_marked(&mut state), vec!["t".to_owned()]);
    // Taking the marks starts them; the hold stays until the reconcile ends.
    assert!(holds(&state, "t"));
    release(&mut state, "t");
    assert!(!holds(&state, "t"));
}

#[test]
fn closing_stops_new_marks_from_mattering() {
    let mut state = crate::State::default();
    close(&mut state);
    assert!(state.cursor.closed);
}

// ---------------------------------------------------------------------------------------------
// The failure facts and the release (`cursor-reconcile.ts`)
// ---------------------------------------------------------------------------------------------

mod store {
    use super::super::*;
    use crate::repository::testsupport::{Shell, home, sql_text};
    use ace_core::state::CoreConfig;
    use std::rc::Rc;
    use std::sync::Arc;

    fn engine_on(conn: &Arc<ace_store::Connection>) -> crate::Engine {
        struct ManualPump;
        impl crate::executor::Notifier for ManualPump {
            fn notify(&self) -> crate::executor::Notified {
                crate::executor::Notified::Posted
            }
        }
        let (_, shell) = Shell::store_with_controls(conn);
        let engine = crate::Engine::new(
            shell.clone(),
            shell,
            crate::Inputs::default(),
            "[]",
            Box::new(ManualPump),
            conn,
            Rc::new(crate::actor::ActorDeps::production(
                Rc::new(crate::frames::live::UnportedLive),
                0.0,
            )),
        )
        .unwrap();
        engine
            .core()
            .with_state(|state| state.repo.probe_passthrough = true)
            .unwrap();
        engine
    }

    fn live_thread(conn: &Arc<ace_store::Connection>, last: &str) {
        let mut state = ace_core::state::create_thread_state(
            "t".to_owned(),
            None,
            CoreConfig {
                provider: "cursor".to_owned(),
                silence_ms: 100.0,
                liveness: None,
            },
        )
        .unwrap();
        state.root_key = Some("root".to_owned());
        let run = "run-1";
        let record: ace_core::state::AgentRecord = ace_json::from_value(
            &ace_json::parse(&format!(
                r#"{{"agent":{{"id":"agent-root","threadId":"t","parentId":null,"origin":"person","native":{{"provider":"cursor","nativeId":"native-root"}},"fidelity":"full","cwd":"/tmp","status":{{"state":"working","activity":"thinking"}},"createdAt":0}},"activity":"thinking","lastSignalAt":0{}}}"#,
                if last == "active" {
                    format!(r#","activeRun":"{run}""#)
                } else {
                    format!(r#","lastRun":"{run}""#)
                }
            ))
            .unwrap(),
        )
        .unwrap();
        state.agents.insert("root".to_owned(), record);
        state.runs.insert(
            run.to_owned(),
            ace_json::from_value(
                &ace_json::parse(&format!(
                    r#"{{"id":"{run}","threadId":"t","agentId":"root","trigger":"user","seq":1,"state":"{}","startedAt":1}}"#,
                    if last == "active" { "active" } else { "completed" }
                ))
                .unwrap(),
            )
            .unwrap(),
        );
        let text = ace_json::ser::to_string(&state).unwrap();
        conn.exec(&format!(
            "UPDATE thread_state SET state={} WHERE thread_id='t'",
            sql_text(&format!(r#"{{"engineSnapshot":9,{}"#, &text[1..]))
        ))
        .unwrap();
        conn.exec("UPDATE threads SET provider='cursor' WHERE id='t'")
            .unwrap();
        conn.exec(
            "INSERT OR REPLACE INTO engine_sessions (thread_id, cwd, backend) VALUES ('t', '/tmp', 'cursor-sdk')",
        )
        .unwrap();
    }

    #[test]
    fn startup_reconciles_a_cut_off_cursor_turn_once_the_engine_is_ready() {
        let conn = home("t", &crate::repository::testsupport::header("t"));
        live_thread(&conn, "active");
        conn.exec(r#"UPDATE threads SET status='{"state":"working","agents":1}' WHERE id='t'"#)
            .unwrap();
        crate::restart::ensure_ledgers(&conn).unwrap();
        let engine = engine_on(&conn);
        struct Budget;
        impl crate::executor::Budget for Budget {
            fn start(&mut self) {}
            fn spent(&self, started: usize) -> bool {
                started >= 1
            }
        }
        let exited = || {
            ace_store::stmt_cache::get_row(&conn,
            "SELECT 1 FROM thread_state WHERE thread_id='t' AND json_type(state, '$.processExit')='object'",
            Vec::new()).unwrap().is_some()
        };
        for _ in 0..256 {
            engine.pump(&mut Budget);
            if engine.is_ready() {
                break;
            }
        }
        assert!(engine.is_ready());
        assert!(!exited(), "Cursor remains working through readiness");
        for _ in 0..64 {
            engine.pump(&mut Budget);
            if exited() {
                break;
            }
        }
        assert!(
            exited(),
            "the reconcile settles the cut-off run when the session cannot be opened"
        );
    }

    #[test]
    fn a_cut_off_cursor_turn_that_cannot_reconcile_fails_with_the_uncertainty_notice() {
        let conn = home("t", &crate::repository::testsupport::header("t"));
        live_thread(&conn, "active");
        let engine = engine_on(&conn);
        let core = engine.core();
        let facts = core
            .with_state(|state| restart_failure(core, state, "t", 9.0))
            .unwrap()
            .unwrap();
        assert_eq!(facts.len(), 4);
        assert_eq!(
            facts[0].get("item").and_then(Value::as_str),
            Some("recovery:uncertain")
        );
        assert!(
            facts[0]
                .get("draft")
                .and_then(|draft| draft.get("detail"))
                .and_then(Value::as_str)
                .is_some()
        );
        assert_eq!(
            facts[1].get("type").and_then(Value::as_str),
            Some("process.exited")
        );
        assert_eq!(
            facts[1].get("message").and_then(Value::as_str),
            Some("Daemon restarted; previous provider work stopped")
        );
        assert_eq!(
            facts[3].get("item").and_then(Value::as_str),
            Some("liveness:stopped:9")
        );
        assert_eq!(
            facts[3]
                .get("draft")
                .and_then(|draft| draft.get("code"))
                .and_then(Value::as_str),
            Some("restart_interrupted")
        );
    }

    #[test]
    fn a_finished_cursor_turn_releases_the_restart_hold_it_was_cut_off_by() {
        let conn = home("t", &crate::repository::testsupport::header("t"));
        live_thread(&conn, "done");
        conn.exec(
            "INSERT INTO engine_queue (thread_id, paused, reason, continuation, trigger, hold_token)
             VALUES ('t', 1, 'restart', 'Continue where you left off.', 'restart', 2)",
        )
        .unwrap();
        let engine = engine_on(&conn);
        let core = engine.core();
        assert!(
            core.with_state(|state| finished(core, state, "t"))
                .unwrap()
                .unwrap()
        );
        core.with_state(|state| release_hold(core, state, "t", 9.0))
            .unwrap()
            .unwrap();
        let row = ace_store::stmt_cache::get_row(
            &conn,
            "SELECT paused, reason, continuation, trigger, hold_token FROM engine_queue WHERE thread_id='t'",
            Vec::new(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            row.get("paused")
                .and_then(crate::repository::residency::cell_int),
            Some(0)
        );
        assert!(
            row.get("continuation")
                .is_none_or(|value| matches!(value, ace_store::Value::Null))
        );
        assert!(
            row.get("trigger")
                .is_none_or(|value| matches!(value, ace_store::Value::Null))
        );
        assert_eq!(
            row.get("hold_token")
                .and_then(crate::repository::residency::cell_int),
            Some(3)
        );
    }

    #[test]
    fn failure_waits_double_from_the_busy_list_to_a_minute() {
        let waits: Vec<f64> = FailureWaits::new(&BUSY_RETRY_MS).take(12).collect();
        assert_eq!(&waits[..7], &BUSY_RETRY_MS);
        assert_eq!(
            &waits[7..12],
            &[12_000.0, 24_000.0, 48_000.0, 60_000.0, 60_000.0]
        );
    }
}
