//! One bot's code (ADR 0203 §3, §4): its components in its worker's folder, its worker started
//! when a call needs one and started again, with every component loaded, after one died; at most
//! four calls at once; Stop ending every open call; Pause ending the worker. This is what Spade's
//! `code` tools call through (work package 3).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use sha2::{Digest, Sha256};
use spade_core::package::code::Bounds;
use tokio::process::Command;
use tokio::sync::{Mutex, Semaphore};

use crate::client::{Running, Worker};
use crate::protocol::Target;
use crate::serve::MOST_CALLS;

/// Makes the command that starts this bot's worker (inside its sandbox, see [`crate::launch`]).
pub type Launcher = Box<dyn Fn() -> Result<Command, String> + Send + Sync>;

pub struct BotCode {
    folder: PathBuf,
    launch: Launcher,
    worker: Mutex<Option<Worker>>,
    components: std::sync::Mutex<BTreeSet<String>>,
    slots: Arc<Semaphore>,
}

impl BotCode {
    /// The bot's code, kept in `folder` (the worker's only folder), started with `launch`.
    pub fn new(folder: &Path, launch: Launcher) -> Self {
        Self {
            // As the sandbox names it, links resolved, so the worker opens what its rules allow.
            folder: spade_sandbox::policy::real(folder),
            launch,
            worker: Mutex::new(None),
            components: std::sync::Mutex::default(),
            slots: Arc::new(Semaphore::new(MOST_CALLS)),
        }
    }

    fn path(&self, component: &str) -> PathBuf {
        self.folder.join(format!("{component}.wasm"))
    }

    /// Adds a component from its signed bytes; its sha256 names it. A running worker loads it
    /// now; a worker started later loads it at start.
    pub async fn add(&self, bytes: &[u8]) -> Result<String, String> {
        let component: String = Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let path = self.path(&component);
        tokio::fs::write(&path, bytes)
            .await
            .map_err(|e| format!("the component couldn't be kept: {e}"))?;
        let worker = self.worker.lock().await.clone();
        if let Some(worker) = worker.filter(Worker::alive) {
            worker.load(&component, &path).await?;
        }
        if let Ok(mut components) = self.components.lock() {
            components.insert(component.clone());
        }
        Ok(component)
    }

    /// The live worker, or a fresh one with every component loaded.
    pub async fn worker(&self) -> Result<Worker, String> {
        let mut held = self.worker.lock().await;
        if let Some(worker) = held.as_ref().filter(|w| w.alive()) {
            return Ok(worker.clone());
        }
        let worker = Worker::start((self.launch)()?).await?;
        let components: Vec<String> = self
            .components
            .lock()
            .map(|c| c.iter().cloned().collect())
            .unwrap_or_default();
        for component in components {
            worker.load(&component, &self.path(&component)).await?;
        }
        *held = Some(worker.clone());
        Ok(worker)
    }

    /// Starts a call once one of the bot's four slots is free.
    pub async fn call(
        &self,
        component: &str,
        target: Target,
        input: &str,
        bounds: Bounds,
    ) -> Result<Running, String> {
        let slot = Arc::clone(&self.slots)
            .acquire_owned()
            .await
            .map_err(|_| "the bot's code is closed".to_owned())?;
        let worker = self.worker().await?;
        Ok(worker
            .call(component, target, input, bounds)
            .await?
            .holding(slot))
    }

    /// Stop on the bot: every open call ends now, or with its worker a second later.
    pub async fn stop(&self) {
        let worker = self.worker.lock().await.clone();
        if let Some(worker) = worker {
            worker.stop(None).await;
        }
    }

    /// Pause: the worker ends, and every open call with it.
    pub async fn pause(&self) {
        if let Some(worker) = self.worker.lock().await.take() {
            worker.stop(None).await;
            worker.kill();
        }
    }
}
