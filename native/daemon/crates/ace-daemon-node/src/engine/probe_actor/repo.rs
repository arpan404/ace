// SPDX-License-Identifier: Apache-2.0
//! The probe's scripted repository: fixed answers, and one real event row per `apply`.

use ace_engine::actor::deps::{ActorDeps, ActorRepo, Route, ScheduleView};
use ace_engine::ports::PortError;
use ace_engine::{Core, EngineError, ThreadId};
use ace_json::Value;
use ace_store::Connection;
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use super::log::{Applied, ProbeLog};
use super::script::{ProbeSnapshot, write_probe_event};

/// The probe's repository: fixed answers, one recorded event per `apply`.
pub(super) struct ProbeRepo {
    pub(super) log: Rc<ProbeLog>,
    pub(super) deps: RefCell<Rc<ActorDeps>>,
    /// The shell's connection: `apply` writes a real event row, not only a publication.
    pub(super) connection: Arc<Connection>,
}

impl ActorRepo for ProbeRepo {
    fn status(&self, _core: &Core, _thread: &ThreadId) -> Result<Value, EngineError> {
        Ok(self.log.status.borrow().clone())
    }
    fn route(&self, _core: &Core, _thread: &ThreadId) -> Result<Route, EngineError> {
        if self.log.cursor_route.get() {
            return Ok(Route {
                provider: "cursor".to_string(),
                backend: Some("cursor-sdk".to_string()),
            });
        }
        Ok(Route {
            provider: "probe".to_string(),
            backend: None,
        })
    }
    fn quiescent(&self, _core: &Core, _thread: &ThreadId) -> Result<bool, EngineError> {
        Ok(true)
    }
    fn running_foreground_command(
        &self,
        _core: &Core,
        _thread: &ThreadId,
    ) -> Result<bool, EngineError> {
        Ok(false)
    }
    fn stream(
        &self,
        core: &Core,
        thread: &ThreadId,
        facts: &[Value],
        _now: f64,
    ) -> Result<bool, EngineError> {
        if !self.log.delta_stream {
            return Ok(false);
        }
        let deltas = facts
            .iter()
            .all(|fact| matches!(ProbeLog::text(fact, "type"), Some("item.delta" | "signal")));
        if !deltas {
            return Ok(false);
        }
        let deps = self.deps.borrow().clone();
        deps.live.prepare_live_write(1.0)?;
        let snapshot = Rc::new(ProbeSnapshot {
            log: Rc::clone(&self.log),
        });
        // A delta keeps the batch buffered, so the acknowledgement is not waiting on a flush.
        let event = ace_json::json!({
            "type": "item.delta",
            "itemId": "probe",
            "agentId": "root",
            "field": "text",
            "append": "x",
        });
        self.log.live.borrow_mut().push(event.clone());
        deps.live
            .buffer_live_write(thread, &[event], 0.0, snapshot)?;
        let _ = core;
        Ok(true)
    }
    fn apply(
        &self,
        core: &Core,
        thread: &ThreadId,
        facts: &[Value],
        now: f64,
        generation: u64,
    ) -> Result<(), EngineError> {
        if self.log.fail_apply_fatal.get() > 0 {
            self.log
                .fail_apply_fatal
                .set(self.log.fail_apply_fatal.get() - 1);
            return Err(EngineError::Port(PortError::Threw(
                "the probe's apply failed".to_string(),
            )));
        }
        if self.log.fail_apply.get() > 0 {
            self.log.fail_apply.set(self.log.fail_apply.get() - 1);
            return Err(EngineError::Port(PortError::Threw(
                "Store is busy".to_string(),
            )));
        }
        let mut entry = Applied {
            facts: facts.len(),
            generation,
            ..Applied::default()
        };
        // The brief's probe writes one real event per call, so the seam sees a stored row.
        let seq = self.log.next_seq.get() + 1;
        self.log.next_seq.set(seq);
        let event = ace_json::json!({
            "seq": seq,
            "id": format!("probe-{seq}"),
            "threadId": thread.clone(),
            "at": now,
            "payload": {"type": "probe.batch", "facts": facts.len() as u64},
        });
        let json = ace_json::to_string(&Value::Array(vec![event].into()));
        core.store.atomic(|tx| {
            entry.outermost = core.store.is_outermost();
            // A real row, so a publication-only implementation cannot pass the commit test.
            write_probe_event(&self.connection, thread, now, facts.len())?;
            tx.append_events(&json)?;
            entry.committed = true;
            Ok(())
        })?;
        self.log.facts.borrow_mut().extend_from_slice(facts);
        self.log.order.borrow_mut().push("apply".to_string());
        if facts
            .iter()
            .any(|fact| matches!(ProbeLog::text(fact, "type"), Some("tick")))
        {
            self.log.rooted.borrow_mut().insert(thread.clone());
        }
        self.log.applied.borrow_mut().push(entry);
        Ok(())
    }
    fn deadline(
        &self,
        _core: &Core,
        _thread: &ThreadId,
        _translator: Option<i64>,
    ) -> Result<Option<f64>, EngineError> {
        // The stored deadline plus the translator's own, as the repository combines them.
        Ok(_translator.map(|deadline| deadline as f64))
    }
    fn schedule_view(
        &self,
        _core: &Core,
        _thread: &ThreadId,
    ) -> Result<Option<ScheduleView>, EngineError> {
        Ok(Some(ScheduleView {
            done: false,
            left_running: false,
        }))
    }
    fn evict(&self, _core: &Core, _thread: &ThreadId) {}
    fn clear_incomplete_blobs(&self, _core: &Core, _thread: &ThreadId) {}
    fn root_agent_id(
        &self,
        _core: &Core,
        thread: &ThreadId,
    ) -> Result<Option<String>, EngineError> {
        // A tick materializes the root agent, as the repository's apply does.
        Ok(self
            .log
            .rooted
            .borrow()
            .contains(thread)
            .then(|| "root".to_string()))
    }
    fn engine_queue_fact(
        &self,
        _core: &Core,
        _thread: &ThreadId,
    ) -> Result<Option<Value>, EngineError> {
        Ok(None)
    }
    fn queue_paused(&self, _core: &Core, _thread: &ThreadId) -> Result<bool, EngineError> {
        Ok(false)
    }
    fn queued_count(&self, _core: &Core, _thread: &ThreadId) -> Result<u64, EngineError> {
        Ok(0)
    }
    fn latest_generation(&self, _core: &Core, _thread: &ThreadId) -> Result<u64, EngineError> {
        Ok(0)
    }
    fn mark_yielded_end(
        &self,
        _core: &Core,
        _thread: &ThreadId,
        facts: Vec<Value>,
    ) -> Result<Vec<Value>, EngineError> {
        Ok(facts)
    }
    fn session_instance(
        &self,
        _core: &Core,
        _thread: &ThreadId,
    ) -> Result<Option<String>, EngineError> {
        Ok(Some("probe".to_string()))
    }
    fn reserved_slot(&self, _core: &Core, _thread: &ThreadId) -> Result<bool, EngineError> {
        Ok(false)
    }
    fn retiring_count(&self, _core: &Core) -> Result<usize, EngineError> {
        Ok(0)
    }
    fn released_thread(&self, _core: &Core, _thread: &ThreadId) -> Result<bool, EngineError> {
        Ok(false)
    }
    fn attachment(
        &self,
        _core: &Core,
        _thread: &ThreadId,
        _hash: &str,
    ) -> Result<Option<Value>, EngineError> {
        self.log
            .attachment_lookups
            .set(self.log.attachment_lookups.get() + 1);
        if self.log.fail_attachment.get() > 0 {
            self.log
                .fail_attachment
                .set(self.log.fail_attachment.get() - 1);
            return Err(EngineError::Port(PortError::Threw(
                "Store is busy".to_string(),
            )));
        }
        Ok(None)
    }
    fn cursor_record(
        &self,
        core: &Core,
        _thread: &ThreadId,
        entries: &[Value],
    ) -> Result<(), EngineError> {
        self.log.journal.borrow_mut().extend_from_slice(entries);
        self.log
            .journal_in_transaction
            .borrow_mut()
            .push(core.store.is_open());
        Ok(())
    }
}
