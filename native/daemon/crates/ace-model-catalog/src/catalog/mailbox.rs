// SPDX-License-Identifier: Apache-2.0
//! Admission and environment snapshots at the caller boundary.

use std::cell::Cell;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{SyncSender, TrySendError};

use crate::catalog::commands::{Command, Envelope, Reply};
use crate::catalog::{Catalog, CatalogError, CatalogOptions};
use crate::preferences::ProviderConfig;

thread_local! {
    static SAMPLING: Cell<bool> = const { Cell::new(false) };
}

#[derive(Default)]
pub(crate) struct Inputs {
    pub(crate) sequence: u64,
    pub(crate) now: f64,
    pub(crate) preferences: Vec<ProviderConfig>,
    pub(crate) random: f64,
}

pub(crate) struct Ingress {
    sender: SyncSender<Envelope>,
    closing: AtomicBool,
    next_sample: AtomicU64,
}

impl Ingress {
    pub(crate) fn new(sender: SyncSender<Envelope>) -> Self {
        Self {
            sender,
            closing: AtomicBool::new(false),
            next_sample: AtomicU64::new(0),
        }
    }

    pub(crate) fn close(&self) {
        self.closing.store(true, Ordering::Release);
    }

    pub(crate) fn wake(&self) {
        let _ = self.sender.try_send(Envelope::report(Command::Wake));
    }

    fn send(&self, mut envelope: Envelope, options: &CatalogOptions) -> Result<(), CatalogError> {
        if self.closing.load(Ordering::Acquire) && !envelope.command.allowed_during_close() {
            return Err(CatalogError::Closed);
        }
        if envelope.command.needs_inputs() {
            envelope.inputs = self.capture(options);
        }
        if envelope.command.is_release() {
            // A release belongs to a previously admitted operation and cannot be lost.
            return self.sender.send(envelope).map_err(|_| CatalogError::Closed);
        }
        self.sender.try_send(envelope).map_err(|error| match error {
            TrySendError::Full(_) => CatalogError::Busy,
            TrySendError::Disconnected(_) => CatalogError::Closed,
        })
    }

    fn capture(&self, options: &CatalogOptions) -> Option<Inputs> {
        // Ports may themselves use a read API. That nested command uses the last sample.
        if SAMPLING.replace(true) {
            return None;
        }
        let sequence = self.next_sample.fetch_add(1, Ordering::Relaxed) + 1;
        let inputs = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| Inputs {
            sequence,
            now: options.clock.now(),
            preferences: options
                .preferences
                .as_ref()
                .map(|read| read())
                .unwrap_or_default(),
            random: (options.random)(),
        }));
        SAMPLING.set(false);
        inputs.ok()
    }
}

impl Catalog {
    pub(crate) fn ask<T>(&self, make: impl FnOnce(Reply<T>) -> Command) -> Option<T> {
        self.ask_checked(make).ok()
    }

    pub(crate) fn ask_checked<T>(
        &self,
        make: impl FnOnce(Reply<T>) -> Command,
    ) -> Result<T, CatalogError> {
        wait_sync(self.submit(make)?)
    }

    pub(crate) async fn request<T>(&self, make: impl FnOnce(Reply<T>) -> Command) -> Option<T> {
        self.request_checked(make).await.ok()
    }

    pub(crate) async fn request_checked<T>(
        &self,
        make: impl FnOnce(Reply<T>) -> Command,
    ) -> Result<T, CatalogError> {
        self.submit(make)?.await.map_err(|_| CatalogError::Closed)
    }

    fn submit<T>(
        &self,
        make: impl FnOnce(Reply<T>) -> Command,
    ) -> Result<futures::channel::oneshot::Receiver<T>, CatalogError> {
        let (reply, receiver) = futures::channel::oneshot::channel();
        let (ack, acknowledged) = futures::channel::oneshot::channel();
        let mut envelope = Envelope::report(make(reply));
        envelope.ack = Some(ack);
        self.sender.send(envelope, &self.options)?;
        // The first poll admits the operation in actor order. Its work can finish later.
        wait_sync(acknowledged)?;
        Ok(receiver)
    }

    pub(crate) fn tell(&self, make: impl FnOnce(Reply<()>) -> Command) {
        let _ = self.submit(make);
    }

    pub(crate) fn unlisten(&self, token: u64) {
        let _ = self
            .sender
            .send(Envelope::report(Command::Unlisten { token }), &self.options);
    }
}

fn wait_sync<T>(mut receiver: futures::channel::oneshot::Receiver<T>) -> Result<T, CatalogError> {
    loop {
        match receiver.try_recv() {
            Ok(Some(value)) => return Ok(value),
            Ok(None) => std::thread::yield_now(),
            Err(_) => return Err(CatalogError::Closed),
        }
    }
}
