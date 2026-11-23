// SPDX-License-Identifier: Apache-2.0
//! The process inventory behind a handle the shell holds. A recovery's
//! verified group kills come back as `groups` for the shell to send through
//! its guarded `killGroup`; nothing here signals.

use super::{bind_error, guarded};
use ace_supervisor::entries::EntryPlatform;
use ace_supervisor::inventory::Inventory;
use ace_supervisor::system::SystemInventoryRuntime;
use napi_derive::napi;
use std::sync::{Arc, Mutex};

#[napi]
pub struct NativeInventory {
    inner: Mutex<InventoryHandle>,
}

struct InventoryHandle {
    inventory: Inventory<SystemInventoryRuntime>,
    reports: Arc<Mutex<Vec<String>>>,
}

fn retry_plan_json(inventory: &Inventory<SystemInventoryRuntime>) -> String {
    match inventory.retry_at_ms() {
        Some(at) => format!("{{\"retryInMs\":{at}}}"),
        None => "{\"retryInMs\":null}".to_owned(),
    }
}

#[napi]
impl NativeInventory {
    /// Opens (creating) the journal at `path`.
    #[napi(constructor, catch_unwind)]
    pub fn new(path: String) -> napi::Result<Self> {
        guarded("supervisor inventory open", || {
            let reports = Arc::new(Mutex::new(Vec::new()));
            let sink = Arc::clone(&reports);
            let inventory = Inventory::open(
                &path,
                SystemInventoryRuntime::new(std::process::id()),
                Arc::new(move |message: String| {
                    if let Ok(mut reports) = sink.lock() {
                        reports.push(message);
                    }
                }),
            )
            .map_err(bind_error)?;
            Ok(Self {
                inner: Mutex::new(InventoryHandle { inventory, reports }),
            })
        })
    }

    fn with<T>(
        &self,
        run: impl FnOnce(&mut InventoryHandle) -> napi::Result<T>,
    ) -> napi::Result<T> {
        guarded("supervisor inventory", || {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| napi::Error::from_reason("supervisor inventory lock failed"))?;
            run(&mut inner)
        })
    }

    /// Records one owned leader.
    #[napi(catch_unwind)]
    pub fn add(&self, pid: u32, name: String, cwd: Option<String>) -> napi::Result<()> {
        self.with(|handle| {
            handle
                .inventory
                .add(pid, &name, cwd.as_deref())
                .map_err(bind_error)
        })
    }

    /// Forgets an exited process; returns the retry plan as JSON.
    #[napi(catch_unwind)]
    pub fn remove(&self, pid: u32) -> napi::Result<String> {
        self.with(|handle| {
            handle.inventory.remove(pid);
            Ok(retry_plan_json(&handle.inventory))
        })
    }

    /// Retries failed deletes; returns the retry plan as JSON.
    #[napi(catch_unwind)]
    pub fn retry_removals(&self, now_ms: f64) -> napi::Result<String> {
        self.with(|handle| {
            handle.inventory.retry_removals(now_ms.max(0.0) as u64);
            Ok(retry_plan_json(&handle.inventory))
        })
    }

    /// When the next retry is due, if one is scheduled.
    #[napi(catch_unwind)]
    pub fn retry_at_ms(&self) -> napi::Result<Option<f64>> {
        self.with(|handle| Ok(handle.inventory.retry_at_ms().map(|at| at as f64)))
    }

    /// Windows only: one descendant-recorder tick; whether the interval stays.
    #[napi(catch_unwind)]
    pub fn windows_tick(&self, now_ms: f64) -> napi::Result<bool> {
        self.with(|handle| {
            #[cfg(windows)]
            {
                Ok(handle.inventory.windows_tick(
                    now_ms.max(0.0) as u64,
                    &ace_supervisor::wintree::SystemWindowsTree::new(),
                ))
            }
            #[cfg(not(windows))]
            {
                let _ = (handle, now_ms);
                Ok(false)
            }
        })
    }

    /// Recovers what the previous run left recorded. `groups` are the
    /// verified orphan groups the shell must end through its guard.
    #[napi(catch_unwind)]
    pub fn recover(&self) -> napi::Result<String> {
        self.with(|handle| {
            let recovered = handle.inventory.recover().map_err(bind_error)?;
            let groups = super::members_json(
                handle
                    .inventory
                    .runtime()
                    .take_kills()
                    .iter()
                    .map(|(group, start)| (*group, start.as_str())),
            );
            Ok(format!(
                "{{\"removed\":{},\"killed\":{},\"unresolved\":{},\"groups\":{groups}}}",
                recovered.removed, recovered.killed, recovered.unresolved
            ))
        })
    }

    /// Every recorded process, as JSON.
    #[napi(catch_unwind)]
    pub fn list(&self) -> napi::Result<String> {
        self.with(|handle| {
            let entries = handle.inventory.list().map_err(bind_error)?;
            let rows: Vec<String> = entries
                .iter()
                .map(|entry| ace_supervisor::entries::entry_json(entry, EntryPlatform::current()))
                .collect();
            Ok(format!("[{}]", rows.join(",")))
        })
    }

    /// Drains report messages since the last call.
    #[napi(catch_unwind)]
    pub fn take_reports(&self) -> napi::Result<Vec<String>> {
        self.with(|handle| {
            handle
                .reports
                .lock()
                .map(|mut reports| std::mem::take(&mut *reports))
                .map_err(|_| napi::Error::from_reason("supervisor reports lock failed"))
        })
    }

    /// Closes the journal.
    #[napi(catch_unwind)]
    pub fn close(&self) -> napi::Result<()> {
        self.with(|handle| {
            handle.inventory.close();
            Ok(())
        })
    }
}
