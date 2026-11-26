// SPDX-License-Identifier: Apache-2.0
//! The settings service port (`service.ts`): layers, effective reads, atomic writes,
//! change listeners and debounced reloads, over injected IO and timers.
//!
//! A service owns one file per layer it has touched. A write is checked for its layer
//! before anything opens, and one batch is one commit, so a subscriber never sees half
//! of it.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::rc::{Rc, Weak};

use serde_json::Value;

use crate::file::{FileDiagnostic, Scheduler, SettingsFile, SettingsIo, Stop};
use crate::layers::{
    Entry, Layer, LayerValues, Provenance, check_batch, placement, resolve, validate_overrides,
};
use crate::schema::{is_key, validate_value};
use crate::validation::{SettingsCode, SettingsError};
use crate::workspace::{RealWorkspaceFs, WorkspaceFs, WorkspaceGuards};

/// What a read names: the workspace and thread whose values should win.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Scope {
    pub workspace: Option<PathBuf>,
    pub thread: Option<String>,
}

/// How many settings files a service keeps open; the least recently used healthy one is
/// dropped to make room.
const MAX_OPEN_FILES: usize = 64;

fn closed_error() -> SettingsError {
    SettingsError::new(SettingsCode::Io, "Settings service is closed")
}

/// One change a listener sees: the layer that changed and its keys.
pub type ChangeListener = std::rc::Rc<dyn Fn(&Layer, &[String])>;

/// What a subscriber hears: the effective entries that changed, or a file's diagnostic.
#[derive(Debug, Clone, PartialEq)]
pub enum Notification {
    Changed { entries: Vec<Entry> },
    Diagnostic(FileDiagnostic),
}

/// A scoped subscription's listener.
pub type Subscriber = Rc<dyn Fn(&Notification)>;

/// One subscription: the keys it watches, the layers its scope has, and the effective
/// entries it last saw, so a change that doesn't move its value stays quiet.
struct Subscription {
    keys: Vec<String>,
    layers: Vec<Layer>,
    last: RefCell<BTreeMap<String, Entry>>,
    listener: Subscriber,
}

impl Subscription {
    fn last(&self, key: &str) -> Option<Entry> {
        self.last.borrow().get(key).cloned()
    }

    fn remember(&self, entry: Entry) {
        self.last.borrow_mut().insert(entry.key.clone(), entry);
    }
}

/// A change a file committed, waiting until no file borrow is held to be delivered.
#[derive(Debug, Clone)]
struct Pending {
    layer: Layer,
    change: crate::file::FileChange,
}

/// The settings service.
pub struct SettingsService {
    data_dir: PathBuf,
    io: std::sync::Arc<dyn SettingsIo>,
    scheduler: std::sync::Arc<dyn Scheduler>,
    delay_ms: u64,
    overrides: BTreeMap<String, Value>,
    workspaces: WorkspaceGuards,
    files: BTreeMap<PathBuf, Rc<RefCell<SettingsFile>>>,
    /// Open files, least recently used first.
    order: Vec<PathBuf>,
    /// Files a subscription holds: never evicted.
    pinned: BTreeSet<PathBuf>,
    listeners: Vec<ChangeListener>,
    subscriptions: Vec<Rc<Subscription>>,
    pending: Rc<RefCell<Vec<Pending>>>,
    closed: bool,
    /// One pending debounced reload per file: a new change cancels the one before it.
    timers: BTreeMap<PathBuf, Stop>,
}

impl SettingsService {
    /// Opens a service over a data directory, validating the host's overrides at once.
    pub fn new(
        data_dir: PathBuf,
        io: std::sync::Arc<dyn SettingsIo>,
        scheduler: std::sync::Arc<dyn Scheduler>,
        overrides: BTreeMap<String, Value>,
    ) -> Result<Rc<RefCell<Self>>, SettingsError> {
        Self::with_workspace_fs(
            data_dir,
            io,
            scheduler,
            overrides,
            std::sync::Arc::new(RealWorkspaceFs),
        )
    }

    /// Opens a service whose workspace facts come from `fs`.
    pub fn with_workspace_fs(
        data_dir: PathBuf,
        io: std::sync::Arc<dyn SettingsIo>,
        scheduler: std::sync::Arc<dyn Scheduler>,
        overrides: BTreeMap<String, Value>,
        fs: std::sync::Arc<dyn WorkspaceFs>,
    ) -> Result<Rc<RefCell<Self>>, SettingsError> {
        let overrides = validate_overrides(&overrides)?;
        let aliases = [data_dir.join("settings.json")];
        Ok(Rc::new(RefCell::new(Self {
            data_dir,
            io,
            scheduler,
            delay_ms: 75,
            overrides,
            workspaces: WorkspaceGuards::new(fs, &aliases),
            files: BTreeMap::new(),
            order: Vec::new(),
            pinned: BTreeSet::new(),
            listeners: Vec::new(),
            subscriptions: Vec::new(),
            pending: Rc::new(RefCell::new(Vec::new())),
            closed: false,
            timers: BTreeMap::new(),
        })))
    }

    /// The debounce a watched change waits, in milliseconds.
    pub fn with_delay(mut self, delay_ms: u64) -> Self {
        self.delay_ms = delay_ms;
        self
    }

    fn file(
        service: &Rc<RefCell<Self>>,
        layer: &Layer,
    ) -> Result<Rc<RefCell<SettingsFile>>, SettingsError> {
        if service.borrow().closed {
            return Err(closed_error());
        }
        let path = layer.path(&service.borrow().data_dir)?;
        let guard = match layer {
            Layer::Workspace { workspace } => Some(service.borrow().workspaces.get(workspace)?),
            _ => service.borrow().workspaces.for_file(&path),
        };
        let cached = service.borrow().files.get(&path).cloned();
        if let Some(file) = cached {
            if let Some(guard) = guard {
                let check = guard.clone();
                file.borrow_mut().protect(Rc::new(move || check.check()));
            }
            Self::touch(service, &path);
            return Ok(file);
        }
        Self::make_room(service)?;
        let provenance = layer.kind();
        // A change is queued, never delivered from inside the file's borrow: a listener may
        // read the value that was just committed.
        let pending = service.borrow().pending.clone();
        let changed_layer = layer.clone();
        let changed = std::rc::Rc::new(move |change: crate::file::FileChange| {
            pending.borrow_mut().push(Pending {
                layer: changed_layer.clone(),
                change,
            });
        });
        let file = Rc::new(RefCell::new(SettingsFile::new(
            path.clone(),
            provenance,
            service.borrow().io.clone(),
            changed,
        )));
        // The containment check is attached before the first read, so a cold file behind a
        // replaced workspace is never read or migrated.
        if let Some(guard) = guard {
            let check = guard.clone();
            file.borrow_mut().protect(Rc::new(move || check.check()));
        }
        let _ = file.borrow_mut().reload();
        // A watched change only schedules the reload; the debounce is this service's.
        let scheduled_service: Weak<RefCell<Self>> = Rc::downgrade(service);
        let scheduled_layer = layer.clone();
        let scheduled_path = path.clone();
        let schedule: std::rc::Rc<dyn Fn()> = std::rc::Rc::new(move || {
            let Some(service) = scheduled_service.upgrade() else {
                return;
            };
            let (scheduler, delay) = {
                let service = service.borrow();
                (service.scheduler.clone(), service.delay_ms)
            };
            if let Some(cancel) = service.borrow_mut().timers.remove(&scheduled_path) {
                cancel();
            }
            let timer_service = scheduled_service.clone();
            let timer_layer = scheduled_layer.clone();
            let timer_path = scheduled_path.clone();
            let cancel = scheduler.schedule(
                delay,
                Box::new(move || {
                    if let Some(service) = timer_service.upgrade() {
                        service.borrow_mut().timers.remove(&timer_path);
                        let _ = Self::refresh_shared(&service, &timer_layer);
                    }
                }),
            );
            service
                .borrow_mut()
                .timers
                .insert(scheduled_path.clone(), cancel);
        });
        let _ = file.borrow_mut().watch(schedule);
        {
            let mut borrowed = service.borrow_mut();
            borrowed.files.insert(path.clone(), file.clone());
            borrowed.order.push(path);
        }
        Ok(file)
    }

    /// Moves `path` to the most recently used end of the cache order.
    fn touch(service: &Rc<RefCell<Self>>, path: &std::path::Path) {
        let mut borrowed = service.borrow_mut();
        borrowed.order.retain(|seen| seen != path);
        borrowed.order.push(path.to_path_buf());
    }

    /// Evicts the least recently used healthy file when the cache is full. A file a
    /// subscription holds, or one with a diagnostic, is never evicted.
    fn make_room(service: &Rc<RefCell<Self>>) -> Result<(), SettingsError> {
        let full = service.borrow().files.len() >= MAX_OPEN_FILES;
        if !full {
            return Ok(());
        }
        let candidate = {
            let borrowed = service.borrow();
            borrowed.order.iter().find_map(|path| {
                if borrowed.pinned.contains(path) {
                    return None;
                }
                let file = borrowed.files.get(path)?;
                file.borrow().diagnostic().is_none().then(|| path.clone())
            })
        };
        let Some(path) = candidate else {
            return Err(SettingsError::new(
                SettingsCode::Limit,
                "Settings file limit reached; release active subscriptions or repair invalid scopes",
            ));
        };
        let file = service.borrow_mut().files.remove(&path);
        service.borrow_mut().order.retain(|seen| seen != &path);
        if let Some(file) = file {
            file.borrow_mut().close();
        }
        Ok(())
    }

    fn layers(service: &Rc<RefCell<Self>>, scope: &Scope) -> Result<Vec<Layer>, SettingsError> {
        let mut layers = Vec::new();
        if let Some(workspace) = &scope.workspace {
            layers.push(Layer::Workspace {
                workspace: workspace.clone(),
            });
        }
        layers.insert(0, Layer::Global);
        if let Some(thread) = &scope.thread {
            layers.push(Layer::Thread {
                thread: thread.clone(),
            });
        }
        for layer in &layers {
            let _ = Self::file(service, layer)?;
        }
        Ok(layers)
    }

    fn resolve_one(
        service: &Rc<RefCell<Self>>,
        key: &str,
        scope: &Scope,
    ) -> Result<Entry, SettingsError> {
        if !is_key(key) {
            return Err(SettingsError::new(
                SettingsCode::Validation,
                "Unknown settings key",
            ));
        }
        let layers = Self::layers(service, scope)?;
        let borrowed = service.borrow();
        let values: Vec<(Provenance, BTreeMap<String, Value>)> = layers
            .iter()
            .filter_map(|layer| {
                let path = layer.path(&borrowed.data_dir).ok()?;
                let file = borrowed.files.get(&path)?;
                Some((layer.kind(), file.borrow().settings().clone()))
            })
            .collect();
        let layer_values: Vec<LayerValues<'_>> = values
            .iter()
            .map(|(layer, settings)| LayerValues {
                layer: *layer,
                settings,
            })
            .collect();
        Ok(resolve(key, &layer_values, &borrowed.overrides, None))
    }

    /// Delivers queued changes once no file borrow is held, so a listener can read the
    /// value that was just committed. A listener's own reads queue more and are delivered
    /// in turn.
    fn drain(service: &Rc<RefCell<Self>>) {
        loop {
            let pending = {
                let queue = service.borrow().pending.clone();
                let mut queue = queue.borrow_mut();
                if queue.is_empty() {
                    break;
                }
                std::mem::take(&mut *queue)
            };
            for event in pending {
                let listeners: Vec<ChangeListener> = service.borrow().listeners.clone();
                for listener in listeners {
                    listener(&event.layer, &event.change.keys);
                }
                Self::deliver_subscriptions(service, &event);
            }
        }
    }

    /// Delivers one file's change to the subscriptions whose scope has that layer. A
    /// subscription hears only entries whose effective value moved, so a global change a
    /// workspace overrides is silent.
    fn deliver_subscriptions(service: &Rc<RefCell<Self>>, event: &Pending) {
        let subscriptions: Vec<Rc<Subscription>> = service.borrow().subscriptions.clone();
        for subscription in subscriptions {
            if !subscription.layers.contains(&event.layer) {
                continue;
            }
            let mut notifications = Vec::new();
            let keys: Vec<String> = event
                .change
                .keys
                .iter()
                .filter(|key| subscription.keys.contains(key))
                .cloned()
                .collect();
            if !keys.is_empty() {
                let mut changed = Vec::new();
                for key in keys {
                    let entry = Self::resolve_in(service, &key, &subscription.layers);
                    if subscription.last(&key).as_ref() != Some(&entry) {
                        subscription.remember(entry.clone());
                        changed.push(entry);
                    }
                }
                if !changed.is_empty() {
                    notifications.push(Notification::Changed { entries: changed });
                }
            }
            if let Some(diagnostic) = &event.change.diagnostic {
                let mut diagnostic = diagnostic.clone();
                diagnostic.layer = event.layer.kind();
                notifications.push(Notification::Diagnostic(diagnostic));
            }
            for notification in notifications {
                (subscription.listener)(&notification);
            }
        }
    }

    /// `resolve` over a subscription's own layers.
    fn resolve_in(service: &Rc<RefCell<Self>>, key: &str, layers: &[Layer]) -> Entry {
        let borrowed = service.borrow();
        let values: Vec<(Provenance, BTreeMap<String, Value>)> = layers
            .iter()
            .filter_map(|layer| {
                let path = layer.path(&borrowed.data_dir).ok()?;
                let file = borrowed.files.get(&path)?;
                let settings = file.borrow().settings().clone();
                Some((layer.kind(), settings))
            })
            .collect();
        let layer_values: Vec<LayerValues<'_>> = values
            .iter()
            .map(|(layer, settings)| LayerValues {
                layer: *layer,
                settings,
            })
            .collect();
        resolve(key, &layer_values, &borrowed.overrides, None)
    }

    /// One effective value.
    pub fn get(
        service: &Rc<RefCell<Self>>,
        key: &str,
        scope: &Scope,
    ) -> Result<Entry, SettingsError> {
        let result = Self::resolve_one(service, key, scope);
        Self::drain(service);
        result
    }

    /// Several effective values and every layer's diagnostic.
    pub fn read(
        service: &Rc<RefCell<Self>>,
        keys: &[String],
        scope: &Scope,
    ) -> Result<(Vec<Entry>, Vec<FileDiagnostic>), SettingsError> {
        let keys = Self::key_list(keys)?;
        let layers = Self::layers(service, scope)?;
        let mut entries = Vec::new();
        for key in &keys {
            entries.push(Self::resolve_one(service, key, scope)?);
        }
        let borrowed = service.borrow();
        let mut diagnostics = Vec::new();
        for layer in &layers {
            if let Ok(path) = layer.path(&borrowed.data_dir)
                && let Some(file) = borrowed.files.get(&path)
                && let Some(diagnostic) = file.borrow().diagnostic()
            {
                diagnostics.push(diagnostic);
            }
        }
        Self::drain(service);
        Ok((entries, diagnostics))
    }

    fn key_list(keys: &[String]) -> Result<Vec<String>, SettingsError> {
        if keys.is_empty() || keys.len() > 32 {
            return Err(SettingsError::new(
                SettingsCode::Limit,
                "Select between 1 and 32 settings keys",
            ));
        }
        let mut kept = Vec::new();
        for key in keys {
            if !is_key(key) {
                return Err(SettingsError::new(
                    SettingsCode::Validation,
                    "Unknown settings key",
                ));
            }
            if !kept.contains(key) {
                kept.push(key.clone());
            }
        }
        Ok(kept)
    }

    /// Writes one value on one layer, after its placement and schema.
    pub fn set(
        service: &Rc<RefCell<Self>>,
        key: &str,
        value: &Value,
        layer: &Layer,
    ) -> Result<(), SettingsError> {
        if !is_key(key) {
            return Err(SettingsError::new(
                SettingsCode::Validation,
                "Unknown settings key",
            ));
        }
        placement(key, layer)?;
        let value = validate_value(key, value)?;
        let file = Self::file(service, layer)?;
        let result = file.borrow_mut().set(key, &value);
        Self::drain(service);
        result
    }

    /// Writes one value only when its layer does not hold it.
    pub fn set_if_absent(
        service: &Rc<RefCell<Self>>,
        key: &str,
        value: &Value,
        layer: &Layer,
    ) -> Result<bool, SettingsError> {
        placement(key, layer)?;
        let value = validate_value(key, value)?;
        let file = Self::file(service, layer)?;
        let result = file.borrow_mut().set_if_absent(key, &value);
        Self::drain(service);
        result
    }

    /// Writes several values on one layer as one commit.
    pub fn set_many(
        service: &Rc<RefCell<Self>>,
        entries: &[(String, Value)],
        layer: &Layer,
    ) -> Result<(), SettingsError> {
        let keys: Vec<&str> = entries.iter().map(|(key, _)| key.as_str()).collect();
        check_batch(keys, layer)?;
        let mut checked = Vec::with_capacity(entries.len());
        for (key, value) in entries {
            checked.push((key.clone(), validate_value(key, value)?));
        }
        let file = Self::file(service, layer)?;
        let result = file.borrow_mut().set_many(&checked);
        Self::drain(service);
        result
    }

    /// Removes global preferences in one commit.
    pub fn reset(service: &Rc<RefCell<Self>>, keys: &[String]) -> Result<(), SettingsError> {
        let keys = Self::key_list(keys)?;
        let file = Self::file(service, &Layer::Global)?;
        let result = file.borrow_mut().reset(&keys);
        Self::drain(service);
        result
    }

    /// Reloads one layer's file, as an observed external change does.
    pub fn refresh(service: &Rc<RefCell<Self>>, layer: &Layer) -> Result<(), SettingsError> {
        Self::refresh_shared(service, layer)
    }

    fn refresh_shared(service: &Rc<RefCell<Self>>, layer: &Layer) -> Result<(), SettingsError> {
        let file = Self::file(service, layer)?;
        let result = file.borrow_mut().reload();
        Self::drain(service);
        result
    }

    /// Watches effective values in one scope. The listener hears an entry only when its
    /// effective value changes, and a file diagnostic for a layer in the scope.
    pub fn subscribe(
        service: &Rc<RefCell<Self>>,
        keys: &[String],
        scope: &Scope,
        listener: Subscriber,
    ) -> Result<Stop, SettingsError> {
        if service.borrow().closed {
            return Err(closed_error());
        }
        if service.borrow().subscriptions.len() >= 1024 {
            return Err(SettingsError::new(
                SettingsCode::Limit,
                "Settings subscription limit reached",
            ));
        }
        let keys = Self::key_list(keys)?;
        let layers = Self::layers(service, scope)?;
        let mut last = BTreeMap::new();
        for key in &keys {
            last.insert(key.clone(), Self::resolve_in(service, key, &layers));
        }
        let paths = Self::paths(service, &layers);
        let subscription = Rc::new(Subscription {
            keys,
            layers,
            last: RefCell::new(last),
            listener,
        });
        {
            let mut borrowed = service.borrow_mut();
            borrowed.subscriptions.push(subscription.clone());
            for path in &paths {
                borrowed.pinned.insert(path.clone());
            }
        }
        let weak: Weak<RefCell<Self>> = Rc::downgrade(service);
        Ok(Box::new(move || {
            let Some(service) = weak.upgrade() else {
                return;
            };
            let remaining = {
                let mut borrowed = service.borrow_mut();
                borrowed
                    .subscriptions
                    .retain(|current| !Rc::ptr_eq(current, &subscription));
                borrowed.subscriptions.clone()
            };
            let held: Vec<PathBuf> = remaining
                .iter()
                .flat_map(|subscription| Self::paths(&service, &subscription.layers))
                .collect();
            let mut borrowed = service.borrow_mut();
            for path in paths {
                if !held.contains(&path) {
                    borrowed.pinned.remove(&path);
                }
            }
        }))
    }

    /// The file paths a set of layers reads.
    fn paths(service: &Rc<RefCell<Self>>, layers: &[Layer]) -> Vec<PathBuf> {
        let borrowed = service.borrow();
        layers
            .iter()
            .filter_map(|layer| layer.path(&borrowed.data_dir).ok())
            .collect()
    }

    /// Observes committed writes at the daemon boundary. At most 64 listeners.
    pub fn on_change(
        service: &Rc<RefCell<Self>>,
        listener: ChangeListener,
    ) -> Result<Stop, SettingsError> {
        let mut borrowed = service.borrow_mut();
        if borrowed.closed || borrowed.listeners.len() >= 64 {
            return Err(SettingsError::new(
                SettingsCode::Limit,
                "Settings change listener limit reached",
            ));
        }
        borrowed.listeners.push(listener.clone());
        let weak: Weak<RefCell<Self>> = Rc::downgrade(service);
        Ok(Box::new(move || {
            if let Some(service) = weak.upgrade() {
                service
                    .borrow_mut()
                    .listeners
                    .retain(|current| !std::rc::Rc::ptr_eq(current, &listener));
            }
        }))
    }

    pub fn close(service: &Rc<RefCell<Self>>) {
        let mut borrowed = service.borrow_mut();
        borrowed.closed = true;
        for (_, cancel) in std::mem::take(&mut borrowed.timers) {
            cancel();
        }
        for file in borrowed.files.values() {
            file.borrow_mut().close();
        }
        borrowed.files.clear();
        borrowed.order.clear();
        borrowed.pinned.clear();
        borrowed.listeners.clear();
        borrowed.subscriptions.clear();
    }
}

#[cfg(test)]
mod tests {
    //! Ports `packages/settings/src/service.test.ts`'s read/write cases and
    //! `set-many.test.ts`: a layer's value wins in its scope, a global-only key does not
    //! take on a workspace, a batch commits once, and a value an older file held is
    //! migrated when the service opens it.

    // The service is single-threaded: its IO and timers are inert objects the test drives.
    #![allow(clippy::arc_with_non_send_sync)]

    use super::*;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct MemoryIo {
        files: Mutex<BTreeMap<PathBuf, String>>,
        writes: Mutex<usize>,
        reads: Mutex<usize>,
        watches: Mutex<usize>,
        changed: Mutex<Option<Rc<dyn Fn()>>>,
        failed: Mutex<Option<Rc<dyn Fn()>>>,
        stopped: Arc<Mutex<usize>>,
    }

    impl MemoryIo {
        fn fire_changed(&self) {
            if let Some(changed) = self
                .changed
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clone()
            {
                changed();
            }
        }

        fn fire_failed(&self) {
            if let Some(failed) = self
                .failed
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clone()
            {
                failed();
            }
        }

        fn count(counter: &Mutex<usize>) -> usize {
            *counter.lock().unwrap_or_else(|error| error.into_inner())
        }
    }

    impl SettingsIo for MemoryIo {
        fn read(&self, path: &std::path::Path) -> Result<Option<String>, SettingsError> {
            *self.reads.lock().unwrap_or_else(|error| error.into_inner()) += 1;
            Ok(self
                .files
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .get(path)
                .cloned())
        }

        fn write(
            &self,
            path: &std::path::Path,
            text: &str,
            before_commit: Option<&crate::file::Validate>,
        ) -> Result<(), SettingsError> {
            if let Some(before_commit) = before_commit {
                before_commit()?;
            }
            *self
                .writes
                .lock()
                .unwrap_or_else(|error| error.into_inner()) += 1;
            self.files
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .insert(path.to_owned(), text.to_owned());
            Ok(())
        }

        fn watch(
            &self,
            _path: &std::path::Path,
            changed: std::rc::Rc<dyn Fn()>,
            failed: std::rc::Rc<dyn Fn()>,
        ) -> Result<Stop, SettingsError> {
            *self
                .watches
                .lock()
                .unwrap_or_else(|error| error.into_inner()) += 1;
            *self
                .changed
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = Some(changed);
            *self
                .failed
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = Some(failed);
            let stopped = self.stopped.clone();
            Ok(Box::new(move || {
                *stopped.lock().unwrap_or_else(|error| error.into_inner()) += 1;
            }))
        }
    }

    /// A scheduler whose pending timers the test fires by hand.
    #[derive(Default, Clone)]
    struct FakeScheduler {
        state: Arc<FakeState>,
    }

    #[derive(Default)]
    struct FakeState {
        pending: Mutex<BTreeMap<usize, Box<dyn Fn()>>>,
        next: Mutex<usize>,
    }

    impl FakeScheduler {
        fn pending(&self) -> usize {
            self.state
                .pending
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .len()
        }

        fn fire(&self) {
            let callbacks: Vec<Box<dyn Fn()>> = std::mem::take(
                &mut *self
                    .state
                    .pending
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()),
            )
            .into_values()
            .collect();
            for callback in callbacks {
                callback();
            }
        }
    }

    impl Scheduler for FakeScheduler {
        fn schedule(&self, _delay_ms: u64, callback: Box<dyn Fn()>) -> Stop {
            let id = {
                let mut next = self
                    .state
                    .next
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                let id = *next;
                *next += 1;
                id
            };
            self.state
                .pending
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .insert(id, callback);
            let pending = self.state.clone();
            Box::new(move || {
                pending
                    .pending
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .remove(&id);
            })
        }
    }

    struct NoScheduler;

    impl Scheduler for NoScheduler {
        fn schedule(&self, _delay_ms: u64, _callback: Box<dyn Fn()>) -> Stop {
            Box::new(|| {})
        }
    }

    fn service(io: Arc<MemoryIo>) -> Rc<RefCell<SettingsService>> {
        SettingsService::new(
            PathBuf::from("/data"),
            io,
            Arc::new(NoScheduler),
            BTreeMap::new(),
        )
        .unwrap_or_else(|error| panic!("{error}"))
    }

    /// A scratch workspace that exists on disk, since a workspace root is pinned to its
    /// identity when the service first reads it.
    fn workspace(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "ace-settings-service-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap_or_else(|error| panic!("{error}"));
        path
    }

    #[test]
    fn a_workspaces_value_wins_in_its_scope_and_resets_to_global_outside_it() {
        let io = Arc::new(MemoryIo::default());
        let service = service(io.clone());
        let repo = workspace("scope");
        SettingsService::set(
            &service,
            "threads.settleOnClose",
            &json!(true),
            &Layer::Global,
        )
        .unwrap_or_else(|error| panic!("{error}"));
        SettingsService::set(
            &service,
            "threads.settleOnClose",
            &json!(false),
            &Layer::Workspace {
                workspace: repo.clone(),
            },
        )
        .unwrap_or_else(|error| panic!("{error}"));
        let scoped = SettingsService::get(
            &service,
            "threads.settleOnClose",
            &Scope {
                workspace: Some(repo.clone()),
                thread: None,
            },
        )
        .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(scoped.value, json!(false));
        assert_eq!(scoped.provenance, Provenance::Workspace);
        let global = SettingsService::get(&service, "threads.settleOnClose", &Scope::default())
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(global.value, json!(true));
        assert_eq!(global.provenance, Provenance::Global);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn a_global_only_key_is_refused_on_a_workspace_layer() {
        let io = Arc::new(MemoryIo::default());
        let service = service(io);
        assert_eq!(
            SettingsService::set(
                &service,
                "spade.enabled",
                &json!(true),
                &Layer::Workspace {
                    workspace: PathBuf::from("/repo")
                },
            )
            .map_err(|error| error.message),
            Err("Running Spade is a global setting".into())
        );
    }

    #[test]
    fn a_batch_is_one_commit_and_one_bad_value_writes_none_of_it() {
        let io = Arc::new(MemoryIo::default());
        let service = service(io.clone());
        let entries = vec![
            ("threads.sortBy".to_owned(), json!("manual")),
            ("threads.followUpBehavior".to_owned(), json!("steer")),
        ];
        SettingsService::set_many(&service, &entries, &Layer::Global)
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            *io.writes.lock().unwrap_or_else(|error| error.into_inner()),
            1
        );
        let bad = vec![
            ("threads.sortBy".to_owned(), json!("manual")),
            ("threads.followUpBehavior".to_owned(), json!("soon")),
        ];
        assert!(SettingsService::set_many(&service, &bad, &Layer::Global).is_err());
        assert_eq!(
            *io.writes.lock().unwrap_or_else(|error| error.into_inner()),
            1
        );
    }

    #[test]
    fn a_malformed_file_reads_defaults_with_a_diagnostic_and_keeps_its_watch() {
        let io = Arc::new(MemoryIo::default());
        io.files
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(PathBuf::from("/data/settings.json"), "{".to_owned());
        let service = service(io.clone());
        let (entries, diagnostics) = SettingsService::read(
            &service,
            &["threads.settleOnClose".to_owned()],
            &Scope::default(),
        )
        .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(entries[0].value, json!(false), "the shipped default");
        assert_eq!(entries[0].provenance, Provenance::Defaults);
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].code, SettingsCode::Parse);
        assert_eq!(diagnostics[0].layer, Provenance::Global);
        assert_eq!(
            *io.watches.lock().unwrap_or_else(|error| error.into_inner()),
            1,
            "the file is still watched for a repair"
        );

        io.files
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(
                PathBuf::from("/data/settings.json"),
                "{\"version\":2,\"settings\":{\"threads.settleOnClose\":true}}".to_owned(),
            );
        SettingsService::refresh(&service, &Layer::Global)
            .unwrap_or_else(|error| panic!("{error}"));
        let (entries, diagnostics) = SettingsService::read(
            &service,
            &["threads.settleOnClose".to_owned()],
            &Scope::default(),
        )
        .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(entries[0].value, json!(true), "the repair is read");
        assert!(diagnostics.is_empty());
    }

    #[test]
    fn a_malformed_edit_after_a_good_load_keeps_the_last_good_values() {
        let io = Arc::new(MemoryIo::default());
        io.files
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(
                PathBuf::from("/data/settings.json"),
                "{\"version\":2,\"settings\":{\"threads.settleOnClose\":true}}".to_owned(),
            );
        let service = service(io.clone());
        let entry = SettingsService::get(&service, "threads.settleOnClose", &Scope::default())
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(entry.value, json!(true));

        io.files
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(PathBuf::from("/data/settings.json"), "{".to_owned());
        SettingsService::refresh(&service, &Layer::Global)
            .unwrap_or_else(|error| panic!("a malformed edit only reports: {error}"));
        let (entries, diagnostics) = SettingsService::read(
            &service,
            &["threads.settleOnClose".to_owned()],
            &Scope::default(),
        )
        .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(entries[0].value, json!(true), "the last good value stays");
        assert_eq!(diagnostics[0].code, SettingsCode::Parse);
        assert_eq!(
            *io.writes.lock().unwrap_or_else(|error| error.into_inner()),
            0,
            "nothing is written over the malformed text"
        );
    }

    #[test]
    fn a_closed_service_refuses_reads_and_writes() {
        let io = Arc::new(MemoryIo::default());
        let service = service(io.clone());
        SettingsService::get(&service, "threads.settleOnClose", &Scope::default())
            .unwrap_or_else(|error| panic!("{error}"));
        let writes = MemoryIo::count(&io.writes);
        SettingsService::close(&service);
        for refusal in [
            SettingsService::get(&service, "threads.settleOnClose", &Scope::default()).map(|_| ()),
            SettingsService::set(
                &service,
                "threads.settleOnClose",
                &json!(true),
                &Layer::Global,
            ),
            SettingsService::refresh(&service, &Layer::Global),
        ] {
            assert_eq!(
                refusal.map_err(|error| error.message),
                Err("Settings service is closed".into())
            );
        }
        assert_eq!(MemoryIo::count(&io.writes), writes, "nothing was written");
    }

    #[test]
    fn the_open_file_cache_evicts_the_least_recently_used_healthy_file() {
        let io = Arc::new(MemoryIo::default());
        let service = service(io.clone());
        for index in 0..65 {
            let scope = Scope {
                workspace: None,
                thread: Some(format!("t{index}")),
            };
            SettingsService::get(&service, "threads.settleOnClose", &scope)
                .unwrap_or_else(|error| panic!("{error}"));
        }
        assert_eq!(service.borrow().files.len(), 64, "the cache is bounded");
        assert!(
            MemoryIo::count(&io.stopped) >= 1,
            "an evicted file's watch is stopped"
        );
    }

    #[test]
    fn watch_events_before_the_boundary_collapse_into_one_reload() {
        let io = Arc::new(MemoryIo::default());
        let scheduler = FakeScheduler::default();
        let service = SettingsService::new(
            PathBuf::from("/data"),
            io.clone(),
            Arc::new(scheduler.clone()),
            BTreeMap::new(),
        )
        .unwrap_or_else(|error| panic!("{error}"));
        SettingsService::get(&service, "threads.sortBy", &Scope::default())
            .unwrap_or_else(|error| panic!("{error}"));
        let reads = MemoryIo::count(&io.reads);
        for _ in 0..20 {
            io.fire_changed();
        }
        assert_eq!(
            scheduler.pending(),
            1,
            "one reload is scheduled, not twenty"
        );
        scheduler.fire();
        assert_eq!(scheduler.pending(), 0);
        assert_eq!(MemoryIo::count(&io.reads), reads + 1, "one reload happened");
    }

    #[test]
    fn a_failed_watch_reports_a_diagnostic_and_retries() {
        let io = Arc::new(MemoryIo::default());
        let scheduler = FakeScheduler::default();
        let service = SettingsService::new(
            PathBuf::from("/data"),
            io.clone(),
            Arc::new(scheduler.clone()),
            BTreeMap::new(),
        )
        .unwrap_or_else(|error| panic!("{error}"));
        SettingsService::get(&service, "threads.settleOnClose", &Scope::default())
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(MemoryIo::count(&io.watches), 1);

        io.fire_failed();
        let (_, diagnostics) = SettingsService::read(
            &service,
            &["threads.settleOnClose".to_owned()],
            &Scope::default(),
        )
        .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(diagnostics[0].code, SettingsCode::Io);
        assert_eq!(diagnostics[0].message, "Settings watcher failed");
        assert_eq!(scheduler.pending(), 1, "a retry is scheduled");

        scheduler.fire();
        assert_eq!(MemoryIo::count(&io.watches), 2, "the watch is reinstalled");
        let (_, diagnostics) = SettingsService::read(
            &service,
            &["threads.settleOnClose".to_owned()],
            &Scope::default(),
        )
        .unwrap_or_else(|error| panic!("{error}"));
        assert!(diagnostics.is_empty(), "the recovered watch is quiet");
    }

    #[test]
    fn a_subscription_hears_only_a_change_that_moves_its_effective_value() {
        let io = Arc::new(MemoryIo::default());
        let service = service(io);
        let repo = workspace("subscribe");
        let scope = Scope {
            workspace: Some(repo.clone()),
            thread: None,
        };
        let layer = Layer::Workspace {
            workspace: repo.clone(),
        };
        SettingsService::set(&service, "threads.sortBy", &json!("manual"), &layer)
            .unwrap_or_else(|error| panic!("{error}"));

        let notices: Rc<RefCell<Vec<Notification>>> = Rc::new(RefCell::new(Vec::new()));
        let captured = notices.clone();
        let listener: Subscriber = Rc::new(move |notification| {
            captured.borrow_mut().push(notification.clone());
        });
        let stop =
            SettingsService::subscribe(&service, &["threads.sortBy".to_owned()], &scope, listener)
                .unwrap_or_else(|error| panic!("{error}"));

        // The workspace value shadows a global change: the effective entry did not move.
        SettingsService::set(
            &service,
            "threads.sortBy",
            &json!("created"),
            &Layer::Global,
        )
        .unwrap_or_else(|error| panic!("{error}"));
        assert!(notices.borrow().is_empty(), "{:?}", notices.borrow());

        SettingsService::set(&service, "threads.sortBy", &json!("created"), &layer)
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            *notices.borrow(),
            vec![Notification::Changed {
                entries: vec![Entry {
                    key: "threads.sortBy".to_owned(),
                    value: json!("created"),
                    provenance: Provenance::Workspace,
                    local_value: None,
                }]
            }]
        );
        stop();
        assert!(
            !service
                .borrow()
                .pinned
                .contains(&repo.join(".ace").join("settings.json")),
            "a stopped subscription releases the file it held"
        );
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn a_subscription_hears_a_diagnostic_from_a_file_in_its_scope() {
        let io = Arc::new(MemoryIo::default());
        let service = service(io.clone());
        let notices: Rc<RefCell<Vec<Notification>>> = Rc::new(RefCell::new(Vec::new()));
        let captured = notices.clone();
        let listener: Subscriber = Rc::new(move |notification| {
            captured.borrow_mut().push(notification.clone());
        });
        let _stop = SettingsService::subscribe(
            &service,
            &["threads.settleOnClose".to_owned()],
            &Scope::default(),
            listener,
        )
        .unwrap_or_else(|error| panic!("{error}"));

        io.files
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(PathBuf::from("/data/settings.json"), "{".to_owned());
        SettingsService::refresh(&service, &Layer::Global)
            .unwrap_or_else(|error| panic!("{error}"));
        match &notices.borrow()[0] {
            Notification::Diagnostic(diagnostic) => {
                assert_eq!(diagnostic.code, SettingsCode::Parse);
                assert_eq!(diagnostic.layer, Provenance::Global);
            }
            other => panic!("{:?}", other),
        }
    }

    #[test]
    fn a_change_listener_sees_exactly_the_layer_and_keys_that_changed() {
        let io = Arc::new(MemoryIo::default());
        let service = service(io);
        type Seen = Rc<RefCell<Vec<(Layer, Vec<String>)>>>;
        let seen: Seen = Rc::new(RefCell::new(Vec::new()));
        let captured = seen.clone();
        let listener: ChangeListener = Rc::new(move |layer, keys| {
            captured.borrow_mut().push((layer.clone(), keys.to_vec()));
        });
        let _stop = SettingsService::on_change(&service, listener)
            .unwrap_or_else(|error| panic!("{error}"));
        SettingsService::set(
            &service,
            "threads.sortBy",
            &json!("created"),
            &Layer::Global,
        )
        .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            *seen.borrow(),
            vec![(Layer::Global, vec!["threads.sortBy".to_owned()])]
        );
    }

    #[test]
    fn a_change_listener_can_read_the_value_it_just_saw_committed() {
        let io = Arc::new(MemoryIo::default());
        let service = service(io);
        type Seen = Rc<RefCell<Vec<(Layer, Vec<String>, Value)>>>;
        let seen: Seen = Rc::new(RefCell::new(Vec::new()));
        let captured = seen.clone();
        let weak = Rc::downgrade(&service);
        let listener: ChangeListener = Rc::new(move |layer, keys| {
            if let Some(service) = weak.upgrade() {
                let entry = SettingsService::get(&service, "threads.sortBy", &Scope::default())
                    .unwrap_or_else(|error| panic!("{error}"));
                captured
                    .borrow_mut()
                    .push((layer.clone(), keys.to_vec(), entry.value));
            }
        });
        let _stop = SettingsService::on_change(&service, listener)
            .unwrap_or_else(|error| panic!("{error}"));
        SettingsService::set(&service, "threads.sortBy", &json!("manual"), &Layer::Global)
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            *seen.borrow(),
            vec![(
                Layer::Global,
                vec!["threads.sortBy".to_owned()],
                json!("manual")
            )]
        );
    }
}
