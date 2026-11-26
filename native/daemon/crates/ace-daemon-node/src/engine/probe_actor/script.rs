// SPDX-License-Identifier: Apache-2.0
//! The probe's recorded dependencies and its one real row: the live snapshot, the links, the
//! stateless native translator, and the event row `apply` writes inside its transaction.

use ace_adapter_api::Translator;
use ace_engine::actor::deps::ActorLinks;
use ace_engine::frames::live::LiveSnapshot;
use ace_engine::ports::PortError;
use ace_engine::{Core, EngineError, ThreadId};
use ace_json::Value;
use ace_store::Connection;
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use super::log::ProbeLog;

/// The probe's one real event row, inside the engine's transaction.
pub(super) fn write_probe_event(
    connection: &Arc<Connection>,
    thread: &str,
    at: f64,
    facts: usize,
) -> Result<(), EngineError> {
    let next = connection
        .prepare("SELECT COALESCE(MAX(seq), 0) + 1 FROM events")?
        .step()?
        .and_then(|row| row.into_iter().next())
        .map(|value| match value {
            ace_store::Value::Integer(seq) => seq,
            _ => 1,
        })
        .unwrap_or(1);
    let payload = ace_json::to_string(&ace_json::json!({
        "type": "probe.batch",
        "facts": facts as u64,
    }));
    let insert = connection
        .prepare("INSERT INTO events (seq, id, thread_id, at, type, payload) VALUES (?1, ?2, ?3, ?4, 'probe.batch', ?5)")?;
    insert.bind(&[
        Some(ace_store::Value::Integer(next)),
        Some(ace_store::Value::Text(format!("probe-{next}"))),
        Some(ace_store::Value::Text(thread.to_string())),
        Some(ace_store::Value::Integer(at as i64)),
        Some(ace_store::Value::Text(payload)),
    ])?;
    insert.step()?;
    let bump = connection.prepare("UPDATE host_sequence SET seq = MAX(seq, ?1) WHERE id = 1")?;
    bump.bind(&[Some(ace_store::Value::Integer(next))])?;
    bump.step()?;
    Ok(())
}

/// One probe live write's snapshot: it records the order, nothing else.
pub(super) struct ProbeSnapshot {
    pub(super) log: Rc<ProbeLog>,
}

impl LiveSnapshot for ProbeSnapshot {
    fn persist(&self) -> Result<(), EngineError> {
        self.log.snapshots.borrow_mut().push("persist");
        if self.log.fail_persist_fatal.get() > 0 {
            self.log
                .fail_persist_fatal
                .set(self.log.fail_persist_fatal.get() - 1);
            return Err(EngineError::Port(PortError::Threw(
                "the probe's persist failed".to_string(),
            )));
        }
        if self.log.fail_persist.get() > 0 {
            self.log.fail_persist.set(self.log.fail_persist.get() - 1);
            return Err(EngineError::Port(PortError::Threw(
                "Store is busy".to_string(),
            )));
        }
        Ok(())
    }
    fn committed(&self) {
        self.log.snapshots.borrow_mut().push("committed");
    }
}

/// The probe's links: every call recorded, nothing caused.
pub(super) struct ProbeLinks {
    pub(super) sessions: Rc<RefCell<super::ProbeThreads>>,
    pub(super) log: Rc<ProbeLog>,
}

impl ActorLinks for ProbeLinks {
    fn wake(&self, _core: &Core, _thread: &ThreadId) {
        *self.log.wakes.borrow_mut() += 1;
    }
    fn abort_session(
        &self,
        _core: &Core,
        actor: &ace_engine::actor::ActorRef,
        _drop_session: bool,
    ) {
        let instance = actor.borrow().instance;
        let sessions = self.sessions.borrow();
        *sessions
            .sessions
            .get(&instance)
            .unwrap_or(&self.log)
            .aborted
            .borrow_mut() += 1;
    }
    fn expire(&self, _core: &Core, _thread: &ThreadId, generation: u64) {
        self.log.expired.borrow_mut().push(generation);
    }
    fn diagnostic(&self, _core: &Core, _thread: &ThreadId, raw: &[Value]) {
        self.log.diagnostics.borrow_mut().extend_from_slice(raw);
    }
    fn release_leases(&self, _core: &Core, _tokens: &[u64]) {
        *self.log.released.borrow_mut() += 1;
    }
}

/// A native translator with no state: one signal fact per frame.
pub(super) struct ProbeTranslator;

impl Translator for ProbeTranslator {
    fn take_diagnostics(&mut self) -> Vec<String> {
        Vec::new()
    }
    fn next_deadline(&self) -> Option<i64> {
        None
    }
    fn translate(
        &mut self,
        _frame: &ace_adapter_api::Frame,
        _now_ms: i64,
    ) -> Vec<ace_core::RawFact> {
        vec![ace_core::RawFact {
            fact_type: "signal".to_string(),
            data: ace_json::Raw::from_json("{}")
                .unwrap_or_else(|_| ace_json::Raw::from_json("null").unwrap_or_default()),
        }]
    }
    fn tick(&mut self, _now_ms: i64) -> Vec<ace_core::RawFact> {
        Vec::new()
    }
}
