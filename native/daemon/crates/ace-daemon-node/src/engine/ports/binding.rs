// SPDX-License-Identifier: Apache-2.0
//! `Ports` over the shell's function references: every engine port call, in one place.

use ace_engine::futures::future::LocalBoxFuture;
use ace_engine::ports::{OpenFrame, PortError, Ports, ResetAt, Timer};
use napi::bindgen_prelude::FnArgs;

use super::JsPorts;
use super::timers::ArmedTimer;

impl Ports for JsPorts {
    fn now(&self) -> f64 {
        self.call(&self.clock_now, ()).unwrap_or_default()
    }

    fn set_timer(&self, ms: f64) -> Timer {
        self.arm_with(&self.arm_timer, ms)
    }

    fn cancel_timer(&self, key: u64) {
        if let Some(entry) = self.timers.borrow_mut().remove(&key)
            && let Some(cancel) = entry.cancel
        {
            let _ = self.call(&cancel, ());
        }
    }

    fn cancel_all_timers(&self) {
        let timers: Vec<ArmedTimer> = self.timers.borrow_mut().drain().map(|(_, t)| t).collect();
        for mut entry in timers {
            if let Some(cancel) = entry.cancel.take() {
                let _ = self.call(&cancel, ());
            }
            entry.sender.take();
        }
    }

    fn set_batch_timer(&self, ms: f64) -> Timer {
        self.arm_with(&self.arm_batch_timer, ms)
    }

    fn thread_id(&self) -> String {
        let given = self.call(&self.thread_id, ()).unwrap_or_default();
        if given.is_empty() {
            return self.ids.borrow_mut().next();
        }
        given
    }

    fn command_id(&self) -> String {
        let given = self.call(&self.command_id, ()).unwrap_or_default();
        if given.is_empty() {
            return self.ids.borrow_mut().next();
        }
        given
    }

    fn next_id(&self, kind: &str) -> String {
        let given = self
            .call(&self.next_id, kind.to_string())
            .unwrap_or_default();
        if given.is_empty() {
            return self.ids.borrow_mut().next();
        }
        given
    }

    fn report(&self, error: String) {
        let _ = self.call(&self.report, error);
    }

    fn providers_activated(&self) -> LocalBoxFuture<'static, Result<(), PortError>> {
        let (id, receiver) = self.arm_promise(None);
        if let Err(error) = self.call(&self.providers_activated, id as f64) {
            return Box::pin(async move { Err(error) });
        }
        Box::pin(async move { receiver.await.map_err(|_| PortError::NoEnv)? })
    }

    fn wait_for_provider(&self, provider: &str) -> LocalBoxFuture<'static, Result<(), PortError>> {
        JsPorts::wait_for_provider_message(self, provider, None)
    }

    fn resolve_ready(&self, error: Option<String>) {
        let _ = self.call(&self.resolve_ready, error);
    }

    fn resolve_close(&self, error: Option<String>) {
        let _ = self.call(&self.resolve_close, error);
    }

    fn is_transaction_open(&self) -> bool {
        self.call(&self.is_transaction_open, ()).unwrap_or(false)
    }

    fn open_transaction(&self) -> Result<OpenFrame, PortError> {
        let frame = self.call(&self.open_transaction, ())?;
        Ok(OpenFrame {
            token: frame.token as u64,
            outermost: frame.outermost,
        })
    }

    fn close_transaction(&self, frame: u64, error: Option<String>) -> Result<(), PortError> {
        self.call(
            &self.close_transaction,
            FnArgs {
                data: (frame as f64, error),
            },
        )
    }

    fn append_events(&self, json: &str) -> Result<(), PortError> {
        self.call(&self.append_events, json.to_string())
    }

    fn write_events(&self, thread: &str, payloads_json: &str, at: f64) -> Result<(), PortError> {
        // Inside a receipt the write waits for the state borrow to be released: the hook the
        // store runs on it may read the engine back.
        if let Some(deferred) = self.deferred_events.borrow_mut().as_mut() {
            deferred.push((thread.to_owned(), payloads_json.to_owned(), at));
            return Ok(());
        }
        self.call(
            &self.write_events,
            FnArgs {
                data: (thread.to_owned(), payloads_json.to_owned(), at),
            },
        )
    }

    /// A create's `thread.created` projects the parent `threads` row the engine's own
    /// `thread_state` and session inserts reference. The engine flushes that one batch before
    /// them (`repository/save.rs`); the write still runs here, and every later batch keeps
    /// waiting for the receipt to end.
    fn flush_deferred_events(&self) -> Result<(), PortError> {
        for (thread, payloads, at) in self.drain_deferred_events() {
            self.call(
                &self.write_events,
                FnArgs {
                    data: (thread, payloads, at),
                },
            )?;
        }
        Ok(())
    }

    fn head_seq(&self) -> Result<f64, PortError> {
        self.call(&self.head_seq, ())
    }

    fn has_live_write(&self, thread: &str) -> Result<bool, PortError> {
        self.call(&self.has_live_write, thread.to_owned())
    }

    fn rollback_generation(&self) -> Result<f64, PortError> {
        self.call(&self.rollback_generation, ())
    }

    fn get_thread(&self, thread: &str) -> Result<Option<String>, PortError> {
        self.call(&self.get_thread, thread.to_owned())
    }

    fn on_naming_prompt(&self, thread: &str, json: &str) {
        // The port runs after the commit, outside any caller's `try`: a throw is reported, never
        // swallowed.
        if let Err(error) = self.call(
            &self.on_naming_prompt,
            FnArgs {
                data: (thread.to_owned(), json.to_owned()),
            },
        ) {
            self.report_now(&error.to_string());
        }
    }

    fn cap_raw(&self, thread: &str, raw: &str) -> Result<String, PortError> {
        self.call(
            &self.cap_raw,
            FnArgs {
                data: (raw.to_owned(), thread.to_owned()),
            },
        )
    }

    fn prepare_live_write(&self, bytes: f64) -> Result<(), PortError> {
        self.call(&self.prepare_live_write, bytes)
    }

    fn buffer_live_write(
        &self,
        thread: &str,
        events_json: &str,
        at: f64,
        token: u64,
    ) -> Result<(), PortError> {
        self.call(
            &self.buffer_live_write,
            FnArgs {
                data: (thread.to_owned(), events_json.to_owned(), at, token as f64),
            },
        )
    }

    fn frame_call(&self) -> Option<u64> {
        self.call(&self.frame_call, ()).ok().map(|call| call as u64)
    }

    fn release_frames(&self, handles: &str) {
        let _ = self.call(&self.release_frames, handles.to_string());
    }

    fn settle_call(&self, call: u64, error: Option<String>) {
        let _ = self.call(
            &self.settle_call,
            FnArgs {
                data: (call as f64, error),
            },
        );
    }

    fn reject_pending(&self) {
        self.abandon_promises();
        let _ = self.call(&self.reject_pending, ());
    }

    fn finish_close(&self) {
        let _ = self.call(&self.finish_close, ());
    }

    fn has_move_target(&self) -> bool {
        self.has_move_target
    }

    fn has_models(&self) -> bool {
        self.models_resolve.is_some() && self.models_list.is_some()
    }

    fn models_resolve(&self, json: &str) -> Result<String, PortError> {
        let Some(function) = self.models_resolve.as_ref() else {
            return Err(PortError::Unbound("models.resolve"));
        };
        self.call(function, json.to_owned())
    }

    fn models_list(&self, json: &str) -> Result<String, PortError> {
        let Some(function) = self.models_list.as_ref() else {
            return Err(PortError::Unbound("models.list"));
        };
        self.call(function, json.to_owned())
    }

    fn models_update_permission_modes(&self, instance: &str, json: &str) -> Result<(), PortError> {
        let Some(function) = self.models_update_permission_modes.as_ref() else {
            return Err(PortError::Unbound("models.updatePermissionModes"));
        };
        self.call(
            function,
            FnArgs {
                data: (instance.to_owned(), json.to_owned()),
            },
        )
    }

    fn admits(&self) -> Result<bool, PortError> {
        self.call(&self.admits, ())
    }

    fn has_reset_at(&self) -> bool {
        self.has_reset_at
    }

    fn reset_at(&self, thread: &str) -> Result<Option<ResetAt>, PortError> {
        let Some(function) = self.reset_at.as_ref() else {
            return Ok(None);
        };
        let answer = self.call(function, thread.to_owned())?;
        Ok(Some(match answer.tag.as_str() {
            "null" => ResetAt::Null,
            "at" => ResetAt::At(answer.at.unwrap_or_default() as i64),
            _ => ResetAt::Undefined,
        }))
    }

    fn select_instance(
        &self,
        provider: &str,
        backend: Option<&str>,
    ) -> Result<Option<String>, PortError> {
        let Some(function) = self.select_instance.as_ref() else {
            return Ok(None);
        };
        self.call(
            function,
            FnArgs {
                data: (provider.to_owned(), backend.map(str::to_owned)),
            },
        )
    }

    fn provider_enabled(&self, provider: &str, instance: Option<&str>) -> Result<bool, PortError> {
        self.call(
            &self.provider_enabled,
            FnArgs {
                data: (provider.to_owned(), instance.map(str::to_owned)),
            },
        )
    }
}
