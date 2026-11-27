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

    /// The scope's layers, most specific last, opening each file in the order
    /// `service.ts:131` uses: the workspace first, so a cold global file that is a
    /// workspace's own `.ace/settings.json` is acquired under that workspace's containment
    /// check, then global, then the thread.
    fn layers(service: &Rc<RefCell<Self>>, scope: &Scope) -> Result<Vec<Layer>, SettingsError> {
        let mut workspace = None;
        if let Some(path) = &scope.workspace {
            let layer = Layer::Workspace {
                workspace: path.clone(),
            };
            let _ = Self::file(service, &layer)?;
            workspace = Some(layer);
        }
        let global = Layer::Global;
        let _ = Self::file(service, &global)?;
        let mut thread = None;
        if let Some(id) = &scope.thread {
            let layer = Layer::Thread { thread: id.clone() };
            let _ = Self::file(service, &layer)?;
            thread = Some(layer);
        }
        let mut layers = vec![global];
        if let Some(layer) = workspace {
            layers.push(layer);
        }
        if let Some(layer) = thread {
            layers.push(layer);
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
        // A setting the daemon handles on its own (host identity, remote access, canonical
        // folders) is never part of a batch, as `apps/daemon/src/settings.ts:179` refuses.
        if let Some(key) = entries
            .iter()
            .map(|(key, _)| key.as_str())
            .find(|key| crate::batch::set_on_its_own(key))
        {
            return Err(crate::batch::on_its_own(key));
        }
        let file = Self::file(service, layer)?;
        let result = file.borrow_mut().set_many(&checked);
        Self::drain(service);
        result
    }

    /// Removes global preferences in one commit. The daemon resets every key it may
    /// write at once (about ninety), so there is no 1–32 cap here; an empty list is a
    /// no-op, as `service.ts:271` has it.
    pub fn reset(service: &Rc<RefCell<Self>>, keys: &[String]) -> Result<(), SettingsError> {
        for key in keys {
            if !is_key(key) {
                return Err(SettingsError::new(
                    SettingsCode::Validation,
                    "Unknown settings key",
                ));
            }
        }
        let file = Self::file(service, &Layer::Global)?;
        let result = file.borrow_mut().reset(keys);
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
#[path = "service/tests.rs"]
mod tests;
