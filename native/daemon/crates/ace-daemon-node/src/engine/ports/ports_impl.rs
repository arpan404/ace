// SPDX-License-Identifier: Apache-2.0
//! `Ports` for the JavaScript shell: every call is one synchronous call on the JS thread.

use super::*;
use ace_engine::ports::PortError;

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
}
