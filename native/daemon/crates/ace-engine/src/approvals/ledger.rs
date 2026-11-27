// SPDX-License-Identifier: Apache-2.0
//! `InteractionLedger` (`interaction-ledger.ts`): durable native request ownership, independent
//! of transcript paging and translator lifetimes. Rows are `engine_interaction_requests`; the
//! table and its backfill stay the TypeScript opener's (decision 8).

use ace_core::state::ThreadState;
use ace_json::Value;
use ace_store::{Value as Cell, stmt_cache};

use super::closed_outcome;
use crate::access::storage::row_text;
use crate::{EngineError, EngineStore};

const OUTCOME: &str =
    "SELECT state FROM engine_interaction_requests WHERE thread_id=? AND interaction_id=?";
const LATEST: &str = "SELECT COALESCE(MAX(generation),0) AS generation FROM engine_interaction_requests WHERE thread_id=?";
const BINDING: &str = "SELECT s.native_session_id,t.provider FROM engine_sessions s JOIN threads t ON t.id=s.thread_id WHERE s.thread_id=?";
const BIND: &str =
    "UPDATE engine_interaction_requests SET binding=? WHERE thread_id=? AND binding=?";
const TERMINAL: &str = "SELECT 1 FROM engine_interaction_requests WHERE thread_id=? AND binding=? AND native_item=? AND state<>'pending' LIMIT 1";
const INSERT: &str = "INSERT OR IGNORE INTO engine_interaction_requests VALUES (?,?,?,?,?,?,?)";
const OBSERVE: &str =
    "UPDATE engine_interaction_requests SET state=? WHERE thread_id=? AND interaction_id=?";
const ROW: &str = "SELECT thread_id,native_key,native_item FROM engine_interaction_requests WHERE thread_id=? AND interaction_id=?";
const OWNER: &str = "SELECT generation FROM engine_interaction_requests WHERE thread_id=? AND interaction_id=? AND state='pending'";

const STATES: [&str; 4] = ["pending", "resolved", "cancelled", "expired"];

fn state(value: &str) -> Result<String, EngineError> {
    if STATES.contains(&value) {
        return Ok(value.to_owned());
    }
    Err(EngineError::Records(format!(
        "Invalid option: expected one of \"pending\"|\"resolved\"|\"cancelled\"|\"expired\", received {value:?}"
    )))
}

/// `InteractionLedger.outcome`: the settled state a client reads, or none.
pub fn outcome(
    store: &EngineStore,
    id: &str,
    interaction: &str,
) -> Result<Option<String>, EngineError> {
    let row = stmt_cache::get_row(
        store.conn(),
        OUTCOME,
        vec![
            Cell::Text(id.to_owned()),
            Cell::Text(interaction.to_owned()),
        ],
    )?;
    match row.and_then(|row| row_text(&row, "state")) {
        Some(value) => Ok(Some(state(&value)?)),
        None => Ok(None),
    }
}

/// `InteractionLedger.binding`: the provider and native session a thread runs.
fn binding(store: &EngineStore, id: &str) -> Result<String, EngineError> {
    let row = stmt_cache::get_row(store.conn(), BINDING, vec![Cell::Text(id.to_owned())])?;
    let provider = row
        .as_ref()
        .and_then(|row| row_text(row, "provider"))
        .ok_or_else(|| {
            EngineError::Records("Invalid input: expected string, received undefined".to_owned())
        })?;
    let native = row
        .as_ref()
        .and_then(|row| row_text(row, "native_session_id"))
        .unwrap_or_default();
    Ok(format!("{provider}:{native}"))
}

/// `InteractionLedger.bind`: rows written before a session was bound take its identity.
pub fn bind(store: &EngineStore, id: &str) -> Result<(), EngineError> {
    let binding = binding(store, id)?;
    let provider = binding.split(':').next().unwrap_or_default().to_owned();
    stmt_cache::run(
        store.conn(),
        BIND,
        vec![
            Cell::Text(binding),
            Cell::Text(id.to_owned()),
            Cell::Text(format!("{provider}:")),
        ],
    )?;
    Ok(())
}

/// `InteractionLedger.latestGeneration`.
pub fn latest_generation(store: &EngineStore, id: &str) -> Result<i64, EngineError> {
    let row = stmt_cache::get_row(store.conn(), LATEST, vec![Cell::Text(id.to_owned())])?;
    let value = row.and_then(|row| row.get("generation").and_then(cell_int));
    match value {
        Some(value) if value >= 0 => Ok(value),
        _ => Err(EngineError::Records(
            "Invalid input: expected number, received undefined".to_owned(),
        )),
    }
}

fn cell_int(cell: &Cell) -> Option<i64> {
    match cell {
        Cell::Integer(value) => Some(*value),
        Cell::Real(value) => Some(*value as i64),
        _ => None,
    }
}

/// `InteractionLedger.terminalItem`: whether a native item on the thread's binding already
/// reached a terminal state.
pub fn terminal_item(store: &EngineStore, id: &str, item: &str) -> Result<bool, EngineError> {
    Ok(stmt_cache::get_row(
        store.conn(),
        TERMINAL,
        vec![
            Cell::Text(id.to_owned()),
            Cell::Text(binding(store, id)?),
            Cell::Text(item.to_owned()),
        ],
    )?
    .is_some())
}

/// `InteractionLedger.obsolete`: whether a fact is for an interaction ace already settled.
pub fn obsolete(store: &EngineStore, id: &str, fact: &Value) -> Result<bool, EngineError> {
    let kind = fact.get("type").and_then(Value::as_str).unwrap_or_default();
    if kind == "interaction.opened" {
        return match fact.get("item").and_then(Value::as_str) {
            Some(item) => terminal_item(store, id, item),
            None => Ok(false),
        };
    }
    if kind != "item.upsert" && kind != "item.reconciled" {
        return Ok(false);
    }
    let draft = fact.get("draft");
    if draft
        .and_then(|draft| draft.get("type"))
        .and_then(Value::as_str)
        != Some("tool_call")
    {
        return Ok(false);
    }
    let awaiting = draft
        .and_then(|draft| draft.get("call"))
        .and_then(|call| call.get("status"))
        .and_then(Value::as_str)
        == Some("awaiting_approval");
    if !awaiting {
        return Ok(false);
    }
    match fact.get("item").and_then(Value::as_str) {
        Some(item) => terminal_item(store, id, item),
        None => Ok(false),
    }
}

/// `InteractionLedger.opened`: keep a pending interaction's native owner.
pub fn opened(
    store: &EngineStore,
    state: &ThreadState,
    fact: &Value,
    generation: Option<f64>,
) -> Result<(), EngineError> {
    if fact.get("type").and_then(Value::as_str) != Some("interaction.opened") {
        return Ok(());
    }
    let key = fact
        .get("interaction")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let Some(interaction) = state.interactions.get(key) else {
        return Ok(());
    };
    if interaction.state != "pending" {
        return Ok(());
    }
    let binding = binding(store, &state.thread_id)?;
    stmt_cache::run(
        store.conn(),
        INSERT,
        vec![
            Cell::Text(state.thread_id.clone()),
            Cell::Text(interaction.id.clone()),
            Cell::Text(key.to_owned()),
            fact.get("item")
                .and_then(Value::as_str)
                .map_or(Cell::Null, |item| Cell::Text(item.to_owned())),
            Cell::Text(binding),
            generation.map_or(Cell::Null, Cell::Real),
            Cell::Text(interaction.state.clone()),
        ],
    )?;
    Ok(())
}

/// `InteractionLedger.observe`: a settled event moves its row.
pub fn observe(store: &EngineStore, id: &str, events: &[Value]) -> Result<(), EngineError> {
    for event in events {
        if event.get("type").and_then(Value::as_str) != Some("interaction.closed") {
            continue;
        }
        let Some(interaction) = event.get("interactionId").and_then(Value::as_str) else {
            continue;
        };
        let Some(state) = event.get("state").and_then(Value::as_str) else {
            continue;
        };
        stmt_cache::run(
            store.conn(),
            OBSERVE,
            vec![
                Cell::Text(state.to_owned()),
                Cell::Text(id.to_owned()),
                Cell::Text(interaction.to_owned()),
            ],
        )?;
    }
    Ok(())
}

/// `InteractionLedger.closed`: the facts a settled interaction emits for its tool call.
pub fn closed(
    store: &EngineStore,
    state: &mut ThreadState,
    event: &mut Value,
) -> Result<Vec<Value>, EngineError> {
    let Some(interaction) = event
        .get("interactionId")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return Ok(Vec::new());
    };
    let Some(row) = stmt_cache::get_row(
        store.conn(),
        ROW,
        vec![
            Cell::Text(state.thread_id.clone()),
            Cell::Text(interaction.clone()),
        ],
    )?
    else {
        return Ok(Vec::new());
    };
    let Some(key) = row_text(&row, "native_key") else {
        return Ok(Vec::new());
    };
    if event.get("state").and_then(Value::as_str) == Some("expired") {
        if let Some(map) = event.as_object_mut() {
            map.insert("expirationReason", Value::from("provider_disconnected"));
        }
        if let Some(entry) = state.interactions.get_mut(&key)
            && entry.id == interaction
        {
            entry.expiration_reason = Some("provider_disconnected".to_owned());
        }
    }
    let Some(item) = row_text(&row, "native_item") else {
        return Ok(Vec::new());
    };
    Ok(closed_outcome(state, &key, &item, event)
        .into_iter()
        .collect())
}

/// `InteractionLedger.owner`: the generation whose pending request this is.
pub fn owner(store: &EngineStore, id: &str, interaction: &str) -> Result<Option<i64>, EngineError> {
    let row = stmt_cache::get_row(
        store.conn(),
        OWNER,
        vec![
            Cell::Text(id.to_owned()),
            Cell::Text(interaction.to_owned()),
        ],
    )?;
    match row.and_then(|row| row.get("generation").and_then(cell_int)) {
        Some(value) if value >= 0 => Ok(Some(value)),
        Some(_) => Err(EngineError::Records(
            "Invalid input: expected number to be >=0".to_owned(),
        )),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    //! `execution-approval.process.test.ts` and `interaction-replay.process.test.ts` exercise the
    //! ledger through the engine; these pin its own reads and writes on a real SQLite home.

    use super::*;
    use crate::repository::testsupport::{Shell, header, home};

    fn seeded(name: &str) -> (std::sync::Arc<ace_store::Connection>, EngineStore) {
        let conn = home(name, &header(name));
        let store = Shell::store(&conn);
        conn.exec(&format!(
            "INSERT OR REPLACE INTO engine_sessions (thread_id,cwd,native_session_id,backend) VALUES ('{name}','/tmp','native-1','acp')"
        ))
        .unwrap();
        (conn, store)
    }

    #[test]
    fn an_old_binding_moves_to_the_live_sessions_identity_and_latest_generation_reads_zero() {
        let (conn, store) = seeded("ledger");
        conn.exec("INSERT INTO engine_interaction_requests VALUES ('ledger','i1','key','item','claude:',1,'resolved')")
            .unwrap();
        bind(&store, "ledger").expect("bind");
        let row = stmt_cache::get_row(
            store.conn(),
            "SELECT binding FROM engine_interaction_requests WHERE thread_id='ledger'",
            Vec::new(),
        )
        .unwrap()
        .and_then(|row| row_text(&row, "binding"));
        assert_eq!(row.as_deref(), Some("claude:native-1"));
        assert_eq!(latest_generation(&store, "ledger").expect("latest"), 1);
        assert_eq!(
            outcome(&store, "ledger", "i1").expect("outcome"),
            Some("resolved".to_owned())
        );
        assert_eq!(owner(&store, "ledger", "i1").expect("owner"), None);
    }

    fn thread(thread_id: &str) -> ThreadState {
        use ace_core::reduce::apply;
        use ace_core::state::{ApplyContext, CoreConfig, IdSource, create_thread_state};
        struct Ids(u64);
        impl IdSource for Ids {
            fn next(&mut self, kind: &str) -> Option<String> {
                self.0 += 1;
                Some(format!("{kind}-{}", self.0))
            }
        }
        let mut state = create_thread_state(
            thread_id.to_owned(),
            None,
            CoreConfig {
                provider: "claude".to_owned(),
                silence_ms: 90_000.0,
                liveness: None,
            },
        )
        .expect("state");
        let mut ids = Ids(0);
        for fact in [
            r#"{"type":"agent.seen","agent":"root","origin":"root","fidelity":"full","native":{"provider":"claude","nativeId":"root"},"cwd":"/tmp"}"#,
            r#"{"type":"item.upsert","agent":"root","item":"execution","draft":{"type":"tool_call","complete":false,"call":{"kind":"shell","title":"Offline","status":"awaiting_approval","detail":{"kind":"shell","command":"offline"}}}}"#,
            r#"{"type":"interaction.opened","agent":"root","interaction":"approval","item":"execution","blocking":true,"request":{"kind":"approval","title":"Run?","options":[{"id":"decision","label":"Decide","kind":"allow_once"}]}}"#,
        ] {
            let fact = ace_json::parse(fact).expect("fact");
            let mut events = Vec::new();
            apply(
                &mut state,
                &fact,
                &mut ApplyContext {
                    now: 100,
                    ids: &mut ids,
                    resolving_interactions: None,
                },
                &mut events,
            );
        }
        state
    }

    #[test]
    fn an_opened_interaction_keeps_its_generation_and_a_settled_event_moves_its_row() {
        let (_conn, store) = seeded("ledger2");
        let state = thread("ledger2");
        let opened_fact = ace_json::parse(
            r#"{"type":"interaction.opened","agent":"root","interaction":"approval","item":"execution"}"#,
        )
        .unwrap();
        opened(&store, &state, &opened_fact, Some(3.0)).expect("opened");
        let interaction = state
            .interactions
            .get("approval")
            .expect("interaction")
            .id
            .clone();
        assert_eq!(
            owner(&store, "ledger2", &interaction).expect("owner"),
            Some(3)
        );
        let event = ace_json::parse(
            r#"{"type":"interaction.closed","interactionId":"ignored","state":"resolved"}"#,
        )
        .unwrap();
        let mut event = event;
        if let Some(map) = event.as_object_mut() {
            map.insert("interactionId", Value::from(interaction.as_str()));
        }
        observe(&store, "ledger2", &[event]).expect("observe");
        assert_eq!(
            outcome(&store, "ledger2", &interaction)
                .expect("outcome")
                .as_deref(),
            Some("resolved")
        );
        assert_eq!(owner(&store, "ledger2", &interaction).expect("owner"), None);
    }

    #[test]
    fn a_closed_approval_settles_its_tool_call_and_an_expiry_marks_the_event_and_interaction() {
        let (conn, store) = seeded("ledger3");
        let mut state = thread("ledger3");
        let interaction = state
            .interactions
            .get("approval")
            .expect("interaction")
            .id
            .clone();
        conn.exec(&format!(
            "INSERT INTO engine_interaction_requests VALUES ('ledger3','{interaction}','approval','execution','claude:n',1,'pending')"
        ))
        .unwrap();
        let mut allowed = ace_json::parse(&format!(
            r#"{{"type":"interaction.closed","interactionId":"{interaction}","state":"resolved","closedAt":200,"resolution":{{"kind":"approval","optionId":"decision"}}}}"#
        ))
        .unwrap();
        let facts = closed(&store, &mut state, &mut allowed).expect("closed");
        assert_eq!(facts.len(), 1);
        assert_eq!(
            facts[0]
                .get("draft")
                .and_then(|draft| draft.get("call"))
                .and_then(|call| call.get("status"))
                .and_then(Value::as_str),
            Some("running")
        );

        let mut expired = ace_json::parse(&format!(
            r#"{{"type":"interaction.closed","interactionId":"{interaction}","state":"expired","closedAt":300}}"#
        ))
        .unwrap();
        let facts = closed(&store, &mut state, &mut expired).expect("expired");
        assert_eq!(
            expired.get("expirationReason").and_then(Value::as_str),
            Some("provider_disconnected")
        );
        assert_eq!(
            state
                .interactions
                .get("approval")
                .and_then(|interaction| interaction.expiration_reason.as_deref()),
            Some("provider_disconnected")
        );
        assert_eq!(
            facts[0]
                .get("draft")
                .and_then(|draft| draft.get("call"))
                .and_then(|call| call.get("status"))
                .and_then(Value::as_str),
            Some("cancelled")
        );
        assert_eq!(
            facts[0]
                .get("draft")
                .and_then(|draft| draft.get("complete"))
                .and_then(Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn a_terminal_native_item_makes_every_later_fact_for_it_obsolete() {
        let (conn, store) = seeded("obsolete");
        conn.exec("INSERT INTO engine_interaction_requests VALUES ('obsolete','i1','key','item','claude:native-1',1,'resolved')")
            .unwrap();
        let opened = ace_json::parse(r#"{"type":"interaction.opened","item":"item"}"#).unwrap();
        assert!(obsolete(&store, "obsolete", &opened).expect("obsolete"));
        let upsert = ace_json::parse(
            r#"{"type":"item.upsert","item":"item","draft":{"type":"tool_call","call":{"status":"awaiting_approval"}}}"#,
        )
        .unwrap();
        assert!(obsolete(&store, "obsolete", &upsert).expect("obsolete"));
        // A different item, or a running call, stays.
        let other = ace_json::parse(r#"{"type":"interaction.opened","item":"other"}"#).unwrap();
        assert!(!obsolete(&store, "obsolete", &other).expect("live"));
        let running = ace_json::parse(
            r#"{"type":"item.upsert","item":"item","draft":{"type":"tool_call","call":{"status":"running"}}}"#,
        )
        .unwrap();
        assert!(!obsolete(&store, "obsolete", &running).expect("live"));
    }
}
