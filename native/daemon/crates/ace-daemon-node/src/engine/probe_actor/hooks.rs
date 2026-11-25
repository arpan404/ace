// SPDX-License-Identifier: Apache-2.0
//! The probe's switches: injected failures, labelled operations, a forced open transaction, the
//! native frame path and the dependency hooks.

use ace_engine::actor::deps::{ActorDeps, ActorLinks, ActorRepo, ActorTranslator};
use ace_engine::actor::{intake, mailbox};
use ace_engine::executor::Lane;
use napi::Env;
use napi_derive::napi;
use std::cell::RefCell;
use std::rc::Rc;

use super::log::ProbeLog;
use super::repo::ProbeRepo;
use super::script::{ProbeLinks, ProbeTranslator};
use crate::engine::NativeEngine;

#[napi]
impl NativeEngine {
    /// The next `apply` calls throw a busy store error before writing (the retry case).
    #[napi]
    pub fn probe_fail_apply(&self, thread_id: String, times: f64) {
        if let Some(log) = self.probe_threads.borrow().logs.get(&thread_id) {
            log.fail_apply.set(times as u32);
        }
    }

    /// The next `persist` calls throw a busy store error (the live retry case).
    #[napi]
    pub fn probe_fail_persist(&self, thread_id: String, times: f64) {
        if let Some(log) = self.probe_threads.borrow().logs.get(&thread_id) {
            log.fail_persist.set(times as u32);
        }
    }

    /// The next `persist` calls throw a fatal error, so the batch is quarantined.
    #[napi]
    pub fn probe_fail_persist_fatal(&self, thread_id: String, times: f64) {
        if let Some(log) = self.probe_threads.borrow().logs.get(&thread_id) {
            log.fail_persist_fatal.set(times as u32);
        }
    }

    /// The Rust tokens still held for live snapshots: a replaced or quarantined one is retired.
    #[napi]
    pub fn probe_live_tokens(&self) -> u32 {
        self.actor.snapshots.borrow().len() as u32
    }

    /// The probe repository reports a Cursor SDK thread, so the journal path runs.
    #[napi]
    pub fn probe_use_cursor_route(&self, thread_id: String) {
        if let Some(log) = self.probe_threads.borrow().logs.get(&thread_id) {
            log.cursor_route.set(true);
        }
    }

    /// The next `attachment` lookups throw a busy error (the retried enrichment case).
    #[napi]
    pub fn probe_fail_attachment(&self, thread_id: String, times: f64) {
        if let Some(log) = self.probe_threads.borrow().logs.get(&thread_id) {
            log.fail_attachment.set(times as u32);
        }
    }

    /// The next `apply` calls fail with a non-retryable error (the native gate's rejection).
    #[napi]
    pub fn probe_fail_apply_fatal(&self, thread_id: String, times: f64) {
        if let Some(log) = self.probe_threads.borrow().logs.get(&thread_id) {
            log.fail_apply_fatal.set(times as u32);
        }
    }

    /// Takes a provisional actor's held reservation away, as an invariant break would
    /// (seam test 17d): the commit checks the real reservation, never a probe flag.
    #[napi]
    pub fn probe_lose_reservation(&self, thread_id: String) {
        let core = self.engine.core();
        let _ = core.with_state(|state| state.actors.reserved.shift_remove(&thread_id));
    }

    /// Seals the pending frame batch now, as a flush would.
    #[napi]
    pub fn probe_seal(&self, env: Env, thread_id: String) {
        let _guard = self.ports.enter(env);
        intake::seal(self.engine.core(), &thread_id);
    }

    /// Schedules a deadline without running an operation on the replacement first.
    #[napi]
    pub fn probe_schedule(&self, env: Env, thread_id: String) {
        let _guard = self.ports.enter(env);
        ace_engine::actor::timer::schedule(self.engine.core(), &thread_id);
    }

    /// Queues one labelled operation, so its ordering against frame batches is visible.
    #[napi]
    pub fn probe_enqueue(&self, env: Env, thread_id: String, label: String) {
        let _guard = self.ports.enter(env);
        let core = self.engine.core();
        let log = self.probe_threads.borrow().logs.get(&thread_id).cloned();
        mailbox::enqueue(
            core,
            &thread_id,
            Box::new(move |core, _actor| {
                if let Some(log) = &log {
                    log.enqueued.borrow_mut().push(label.clone());
                    log.order.borrow_mut().push(format!("op:{label}"));
                    log.ops_outermost
                        .borrow_mut()
                        .push(core.store.is_outermost());
                }
                Ok(())
            }),
        );
    }

    /// Queues the operation `onExit` runs: it retires the generation behind the batch.
    #[napi]
    pub fn probe_enqueue_retire(&self, env: Env, thread_id: String) {
        let _guard = self.ports.enter(env);
        let core = self.engine.core();
        let thread = thread_id.clone();
        mailbox::enqueue(
            core,
            &thread_id,
            Box::new(move |core, actor| {
                let retired = actor.borrow_mut().retire_generation();
                let deps = ace_engine::actor::state::instance_deps(core, actor);
                deps.links.expire(core, &thread, retired);
                Ok(())
            }),
        );
    }

    /// Runs the front mailbox op inside an open transaction: the outermost rule must fail it.
    #[napi]
    pub fn probe_run_in_transaction(&self, env: Env, thread_id: String) {
        let _guard = self.ports.enter(env);
        let core = self.engine.core();
        intake::seal(core, &thread_id);
        let result = core.store.atomic(|_tx| {
            if let mailbox::Next::Run(op) = mailbox::take_next(core, &thread_id) {
                ace_engine::actor::run_op_opened(core, &thread_id, op);
            }
            Ok(())
        });
        if let Err(error) = result {
            core.ports.report(error.to_string());
        }
    }

    /// The actor's generation now, for the acknowledgement-continuation order.
    #[napi]
    pub fn probe_generation(&self, thread_id: String) -> f64 {
        self.engine
            .core()
            .with_state(|state| state.actors.get(&thread_id).map(|actor| actor.generation))
            .ok()
            .flatten()
            .unwrap_or(0) as f64
    }

    /// Wakers the engine has registered: an actor created in a rolled-back transaction has none.
    #[napi]
    pub fn probe_registered_wakers(&self) -> u32 {
        self.engine.core().registered() as u32
    }

    /// One frame through the native path's intake, with the binding's own batch promise.
    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub fn probe_native_frame(
        &self,
        env: Env,
        thread_id: String,
        generation: f64,
        seq: f64,
        channel: String,
        data: String,
    ) -> napi::Result<String> {
        let _guard = self.ports.enter(env);
        let core = self.engine.core();
        let raw = ace_json::Raw::from_string(data.clone())
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        let frame = ace_adapter_api::Frame {
            seq: seq as u64,
            t: seq as i64,
            dir: ace_adapter_api::FrameDirection::Recv,
            channel: channel.clone(),
            data: raw,
            payload: None,
            usage_account: None,
        };
        let mut envelope = ace_engine::frames::envelope::Envelope::from(&frame);
        envelope.seq = ace_engine::frames::envelope::Field::Number(seq);
        envelope.t = ace_engine::frames::envelope::Field::Number(seq);
        let sdk = channel == "sdk";
        let ack = intake::frame(
            core,
            &thread_id,
            generation as u64,
            intake::FrameInput {
                frame: ace_engine::actor::state::FrameRef::Native(Box::new(frame)),
                envelope,
                channel_sdk: sdk,
                measure: intake::Measure::Certified { bytes: data.len() },
                native_ack: None,
            },
        );
        Ok(match ack {
            intake::Ack::Done => "done".to_string(),
            intake::Ack::Rejected(message) => format!("rejected:{message}"),
            intake::Ack::Batch(call) => match call {
                Some(call) => format!("batch:{call}"),
                None => "batch".to_string(),
            },
            intake::Ack::AfterFlush(_) => "flush".to_string(),
        })
    }

    /// One frame through the bridge's own path, so the payload limits and their warning are real.
    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub fn probe_bridge_frame(
        &self,
        env: Env,
        thread_id: String,
        generation: f64,
        seq: f64,
        channel: String,
        data: String,
        now: f64,
        started: f64,
    ) -> napi::Result<()> {
        let _guard = self.ports.enter(env);
        let core = self.engine.core();
        let raw = ace_json::Raw::from_string(data)
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        let frame = ace_adapter_api::Frame {
            seq: seq as u64,
            t: seq as i64,
            dir: ace_adapter_api::FrameDirection::Recv,
            channel,
            data: raw,
            payload: None,
            usage_account: None,
        };
        let mut flow = self
            .actor
            .flows
            .borrow_mut()
            .remove(&thread_id)
            .unwrap_or_default();
        let log = self.probe_threads.borrow().logs.get(&thread_id).cloned();
        let set: Rc<dyn Fn(bool)> = Rc::new(move |paused| {
            if let Some(log) = &log {
                log.flowed.borrow_mut().push(paused);
            }
        });
        let (_, completion) = ace_engine::actor::native::native_frame(
            core,
            &thread_id,
            generation as u64,
            frame,
            now,
            started,
            &mut flow,
            set,
        );
        self.actor
            .flows
            .borrow_mut()
            .insert(thread_id.clone(), flow);
        // The real path's acknowledgement: a rejected batch fails the session's read gate.
        let log = self.probe_threads.borrow().logs.get(&thread_id).cloned();
        let task = core.executor.spawn(Lane::Work, async move {
            let entry = match completion.await {
                Ok(Ok(())) => "ok".to_string(),
                Ok(Err(message)) => format!("rejected:{message}"),
                // A dropped sender is observable: a dropped frame must resolve, not cancel.
                Err(_) => "canceled".to_string(),
            };
            if let Some(log) = log {
                log.native_acks.borrow_mut().push(entry);
            }
        });
        task.detach();
        Ok(())
    }

    /// Mirrors the actor's flow into a session gate once, recording each `set_paused`.
    #[napi]
    pub fn probe_native_flow(&self, env: Env, thread_id: String) {
        let _guard = self.ports.enter(env);
        let core = self.engine.core();
        let log = self.probe_threads.borrow().logs.get(&thread_id).cloned();
        let mut flow = self
            .actor
            .flows
            .borrow_mut()
            .remove(&thread_id)
            .unwrap_or_default();
        let set: Rc<dyn Fn(bool)> = Rc::new(move |paused| {
            if let Some(log) = &log {
                log.flowed.borrow_mut().push(paused);
            }
        });
        flow.mirror(core, &thread_id, set);
        self.actor.flows.borrow_mut().insert(thread_id, flow);
    }

    /// Installs the probe repository and links without creating an actor, so a case that only
    /// creates actors through `rootAgent` never reaches an unported production method.
    #[napi]
    pub fn probe_use_deps(&self, thread_id: String) {
        let core = self.engine.core();
        let log = Rc::new(ProbeLog::default());
        let live = Rc::clone(&self.actor.live) as Rc<dyn ace_engine::frames::live::LiveStore>;
        let repo = Rc::new(ProbeRepo {
            log: Rc::clone(&log),
            deps: RefCell::new(Rc::clone(&self.actor.deps)),
            connection: self.probe.borrow().connection(),
        }) as Rc<dyn ActorRepo>;
        let links = Rc::new(ProbeLinks {
            log: Rc::clone(&log),
        }) as Rc<dyn ActorLinks>;
        let deps = Rc::new(ActorDeps::new(
            repo,
            links,
            live,
            Rc::clone(&self.actor.acks) as Rc<dyn ace_engine::actor::deps::FrameAcks>,
            self.actor.deps.idle_ms,
        ));
        self.actor.install_deps(core, Rc::clone(&deps));
        self.probe_threads
            .borrow_mut()
            .logs
            .insert(thread_id, Rc::clone(&log));
    }

    /// Replaces the thread's JavaScript translator with the probe's native one, so native frames
    /// translate through the same actor.
    #[napi]
    pub fn probe_attach_native_translator(&self, thread_id: String) {
        let core = self.engine.core();
        core.with_state(|state| {
            if let Some(mut actor) = state.actors.get_mut(&thread_id) {
                actor.translator = Some((
                    actor.generation,
                    ActorTranslator::Native(Box::new(ProbeTranslator)),
                ));
            }
        })
        .ok();
    }
}
