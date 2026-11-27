// SPDX-License-Identifier: Apache-2.0
//! `thread-liveness.ts`'s `retireThreadIntents` (E5.10): explicit deletion discards held inputs,
//! where an ordinary liveness check keeps the resumable ones.

use ace_json::Value;

use crate::{Core, EngineError, State};

/// Retire every intent the thread holds for a deletion: failed with `reason`, its uncertainty
/// and queue row pruned, and the guards it held released.
pub fn retire_thread_intents(
    core: &Core,
    state: &mut State,
    id: &str,
    at: f64,
    reason: &str,
) -> Result<(), EngineError> {
    for intent in crate::intents::header::headers(core.store.conn(), Some(id), None)? {
        crate::intents::lifecycle::mark(&core.store, &intent, "failed", Some(reason))?;
        crate::queue::messages::clear_uncertain(core.store.conn(), intent.id)?;
        // Its aim row is pruned only once the uncertainty is gone, as when a send fails.
        crate::queue::messages::prune(core.store.conn(), intent.id)?;
        state.transition_release_guards(&core.store, &intent.command_id)?;
    }
    // Its aim row is pruned only once the uncertainty is gone, as when a send fails.
    const UNCERTAIN: &str = "SELECT id FROM intents WHERE thread_id=? AND uncertain=1";
    let rows = ace_store::stmt_cache::all_rows(
        core.store.conn(),
        UNCERTAIN,
        vec![ace_store::Value::Text(id.to_owned())],
    )?;
    for intent in rows.iter().filter_map(|row| {
        row.get("id")
            .and_then(crate::repository::residency::cell_int)
    }) {
        crate::queue::messages::clear_uncertain(core.store.conn(), intent)?;
        crate::queue::messages::prune(core.store.conn(), intent)?;
    }
    let mut fact = ace_json::Map::new();
    fact.insert("type", Value::from("queue.changed"));
    fact.insert("source", Value::from("engine"));
    fact.insert("count", Value::from(0));
    state.apply(
        &core.store,
        id,
        &ace_json::to_string(&Value::Array(vec![Value::Object(fact)].into())),
        at,
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::executor::{Notified, Notifier};
    use crate::repository::testsupport::{Shell, header, home};

    struct Pump;

    impl Notifier for Pump {
        fn notify(&self) -> Notified {
            Notified::Posted
        }
    }

    fn engine_on(conn: &std::sync::Arc<ace_store::Connection>) -> crate::Engine {
        let (_, shell) = Shell::store_with_controls(conn);
        crate::Engine::new(
            shell.clone(),
            shell,
            crate::Inputs::default(),
            "[]",
            Box::new(Pump),
            conn,
            std::rc::Rc::new(crate::actor::ActorDeps::production(
                std::rc::Rc::new(crate::frames::live::UnportedLive),
                0.0,
            )),
        )
        .expect("engine")
    }

    #[test]
    fn a_deletion_fails_every_held_input_and_prunes_its_uncertainty() {
        let conn = home("t", &header("t"));
        conn.exec(
            "INSERT INTO intents (command_id,thread_id,kind,payload,status,delivery,position,uncertain) VALUES
             ('send','t','thread.send','{}','pending','queue',1,0),
             ('resume','t','thread.resume','{}','queued','queue',2,0),
             ('uncertain','t','thread.send','{}','running','queue',3,1)",
        )
        .unwrap();
        let engine = engine_on(&conn);
        let core = engine.core();
        core.with_state(|state| {
            state.repo.probe_passthrough = true;
            retire_thread_intents(core, state, "t", 1_000.0, "Retired for thread deletion")
        })
        .unwrap()
        .unwrap();
        let rows = ace_store::stmt_cache::all_rows(
            &conn,
            "SELECT command_id, status, error FROM intents ORDER BY id",
            Vec::new(),
        )
        .unwrap();
        let statuses: Vec<(String, String)> = rows
            .iter()
            .map(|row| {
                (
                    row.get("status")
                        .and_then(crate::repository::residency::cell_text)
                        .unwrap_or_default()
                        .to_owned(),
                    row.get("error")
                        .and_then(crate::repository::residency::cell_text)
                        .unwrap_or_default()
                        .to_owned(),
                )
            })
            .collect();
        assert_eq!(statuses.len(), 3);
        assert!(
            statuses.iter().all(|(status, _)| status == "failed"),
            "{statuses:?}"
        );
        assert!(
            statuses
                .iter()
                .all(|(_, error)| error == "Retired for thread deletion"),
            "{statuses:?}"
        );
        // The uncertainty is gone, so a later pass does not retire it again.
        let uncertain = ace_store::stmt_cache::all_rows(
            &conn,
            "SELECT id FROM intents WHERE uncertain=1",
            Vec::new(),
        )
        .unwrap();
        assert!(uncertain.is_empty());
    }
}
