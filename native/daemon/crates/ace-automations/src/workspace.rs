// SPDX-License-Identifier: Apache-2.0
//! A3, file triggers (`apps/daemon/src/automation-workspace.ts`, ADR 0178): one checkout watch
//! from the files backend's `files-watch` crate, patterns matched like Node's
//! `path.matchesGlob`, gitignore applied through the files backend's listing, and a baseline of
//! path, version and content digest reconciled against live batches and rescans. No second
//! watcher: [`FilesWatch`] wraps `files_watch::Watcher`, and [`FilesCheckout`] wraps
//! `files-list`/`files-io`.
//!
//! The reconciler is sans-IO over [`Checkout`] and [`Watch`] ports, so the eight cases of
//! `automation-workspace.test.ts` run without a real filesystem or a live watcher, and the
//! adapters prove the real edge separately.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ace_json::Value;
use globset::{GlobBuilder, GlobSet, GlobSetBuilder};

use crate::error::{AutomationsError, Result};
use crate::scheduler::IdSource;

/// Matching paths one trigger remembers; a lost watcher past this cannot be reconciled.
pub const DEFAULT_SNAPSHOT_LIMIT: usize = 100_000;
/// Events one trigger holds while its baseline is read; past this it rescans after instead.
pub const DEFAULT_BUFFER_LIMIT: usize = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkspaceLimits {
    pub snapshot_limit: usize,
    pub buffer_limit: usize,
}

impl Default for WorkspaceLimits {
    fn default() -> WorkspaceLimits {
        WorkspaceLimits {
            snapshot_limit: DEFAULT_SNAPSHOT_LIMIT,
            buffer_limit: DEFAULT_BUFFER_LIMIT,
        }
    }
}

/// What one path looks like to a listing or stat.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckoutEntry {
    pub path: String,
    /// `type:size:mtime`, the version a listing reports; folders are `directory`.
    pub version: String,
    pub file: bool,
    pub directory: bool,
    pub ignored: bool,
}

/// The files backend's reads the reconciler needs. `digest` is the content fingerprint at the
/// current version; a vanished or conflicted file has none.
pub trait Checkout: Send + Sync {
    fn walk(&self) -> Result<Vec<CheckoutEntry>>;
    fn stat(&self, path: &str) -> Result<Option<CheckoutEntry>>;
    fn digest(&self, path: &str) -> Result<Option<String>>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchKind {
    Created,
    Modified,
    Deleted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchChange {
    pub path: String,
    pub kind: WatchKind,
    pub directory: bool,
}

/// What the watcher reports, as `files-watch::Batch` translates it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspacePayload {
    Changes(Vec<WatchChange>),
    Rescan,
    Warning(String),
}

/// The files backend's watcher, behind a port so tests send batches themselves.
pub trait Watch: Send + Sync {
    fn watch(
        &self,
        root: &str,
        sink: Box<dyn Fn(WorkspacePayload) + Send + Sync>,
    ) -> Result<Box<dyn Subscription>>;
}

pub trait Subscription: Send {
    fn stop(&mut self);
}

/// One delivered file trigger, in the service's terms (`AutomationEvent`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileEvent {
    pub key: String,
    pub variables: BTreeMap<String, String>,
}

#[derive(Debug, Clone)]
struct Known {
    version: String,
    digest: Option<String>,
    file: bool,
}

/// The baseline, live-batch and rescan reconciler, one per subscription.
pub struct Reconciler {
    checkout: Box<dyn Checkout>,
    patterns: GlobSet,
    limits: WorkspaceLimits,
    known: HashMap<String, Known>,
    /// Versions a rescan has already reported, against a live batch naming the same version.
    reported: HashMap<String, String>,
    /// Whether `known` came from a scan that saw every matching path.
    complete: bool,
    closed: bool,
    buffering: bool,
    buffered: Vec<WorkspacePayload>,
    overflowed: bool,
    ids: Box<dyn IdSource>,
    warnings: Vec<String>,
}

impl Reconciler {
    pub fn new(
        checkout: Box<dyn Checkout>,
        patterns: &[String],
        limits: WorkspaceLimits,
        ids: Box<dyn IdSource>,
    ) -> Result<Reconciler> {
        let mut builder = GlobSetBuilder::new();
        for pattern in patterns {
            builder.add(
                GlobBuilder::new(pattern)
                    .literal_separator(true)
                    .build()
                    .map_err(|error| AutomationsError::message(error.to_string()))?,
            );
        }
        Ok(Reconciler {
            checkout,
            patterns: builder
                .build()
                .map_err(|error| AutomationsError::message(error.to_string()))?,
            limits,
            known: HashMap::new(),
            reported: HashMap::new(),
            complete: false,
            closed: false,
            buffering: false,
            buffered: Vec::new(),
            overflowed: false,
            ids,
            warnings: Vec::new(),
        })
    }

    pub fn take_warnings(&mut self) -> Vec<String> {
        std::mem::take(&mut self.warnings)
    }

    pub fn close(&mut self) {
        self.closed = true;
    }

    fn matches(&self, path: &str) -> bool {
        self.patterns.is_match(path)
    }

    /// The email/listing version of one entry, shared by seed, rescan and live batches.
    fn version(entry: &CheckoutEntry) -> String {
        if entry.directory {
            "directory".to_owned()
        } else {
            entry.version.clone()
        }
    }

    /// Hold payloads until [`Reconciler::ready`], as the subscription does while seeding.
    pub fn begin_buffering(&mut self) {
        self.buffering = true;
    }

    /// Read the matching tree into a baseline before anything is reported ready.
    pub fn seed(&mut self) -> Result<()> {
        let entries = self.checkout.walk()?;
        let mut seeded = HashMap::new();
        let mut files = Vec::new();
        let mut full = false;
        for entry in entries {
            if entry.ignored || !self.matches(&entry.path) {
                continue;
            }
            if seeded.len() >= self.limits.snapshot_limit {
                full = true;
                break;
            }
            if entry.file {
                files.push(entry.path.clone());
            }
            seeded.insert(entry.path.clone(), Self::version(&entry));
        }
        if self.closed {
            return Ok(());
        }
        if full {
            self.known.clear();
            self.complete = false;
            self.warnings
                .push("Automation baseline exceeded its snapshot; changes may be lost".to_owned());
            return Ok(());
        }
        let mut known: HashMap<String, Known> = seeded
            .into_iter()
            .map(|(path, version)| {
                (
                    path,
                    Known {
                        version,
                        digest: None,
                        file: false,
                    },
                )
            })
            .collect();
        for path in files {
            if let Some(digest) = self.checkout.digest(&path)?
                && let Some(entry) = known.get_mut(&path)
            {
                entry.digest = Some(digest);
                entry.file = true;
            } else if let Some(entry) = known.get_mut(&path) {
                entry.file = true;
            }
        }
        if self.closed {
            return Ok(());
        }
        self.known = known;
        self.complete = true;
        Ok(())
    }

    /// Report what arrived while the baseline was read, after readiness.
    pub fn ready(&mut self) -> Result<Vec<FileEvent>> {
        self.buffering = false;
        let buffered = std::mem::take(&mut self.buffered);
        let overflowed = std::mem::replace(&mut self.overflowed, false);
        if overflowed {
            return self.rescan();
        }
        let mut events = Vec::new();
        for payload in buffered {
            events.extend(self.receive(payload, true)?);
        }
        Ok(events)
    }

    /// One payload from the watcher; before readiness it is held (or turns into a rescan).
    pub fn receive(&mut self, payload: WorkspacePayload, announce: bool) -> Result<Vec<FileEvent>> {
        if self.closed {
            return Ok(Vec::new());
        }
        if self.buffering {
            if self.buffered.len() >= self.limits.buffer_limit {
                self.buffered.clear();
                self.overflowed = true;
            } else {
                self.buffered.push(payload);
            }
            return Ok(Vec::new());
        }
        match payload {
            WorkspacePayload::Changes(changes) => self.batch(&changes, announce),
            WorkspacePayload::Rescan => self.rescan(),
            WorkspacePayload::Warning(message) => {
                self.warnings.push(message);
                Ok(Vec::new())
            }
        }
    }

    fn fire(&mut self, changes: &[(String, &'static str)]) -> Vec<FileEvent> {
        if self.closed || changes.is_empty() {
            return Vec::new();
        }
        let matched: Vec<String> = changes
            .iter()
            .take(8)
            .map(|(path, _)| path.chars().take(512).collect())
            .collect();
        let kind = changes[0].1;
        let mut variables = BTreeMap::new();
        variables.insert("path".to_owned(), matched[0].clone());
        variables.insert("paths".to_owned(), matched.join("\n"));
        variables.insert("kind".to_owned(), kind.to_owned());
        variables.insert("count".to_owned(), changes.len().to_string());
        vec![FileEvent {
            key: format!("file:{}", self.ids.next_id()),
            variables,
        }]
    }

    fn batch(&mut self, changes: &[WatchChange], announce: bool) -> Result<Vec<FileEvent>> {
        let mut matched: Vec<(String, &'static str)> = Vec::new();
        let mut hashed: Vec<String> = Vec::new();
        for change in changes {
            if !self.matches(&change.path) {
                continue;
            }
            let before = self.known.get(&change.path).cloned();
            if change.kind == WatchKind::Deleted {
                if before.is_none() && !announce {
                    continue;
                }
                self.known.remove(&change.path);
                self.reported.remove(&change.path);
                matched.push((change.path.clone(), "deleted"));
                continue;
            }
            let Some(now) = self.checkout.stat(&change.path)? else {
                if before.is_some() {
                    self.known.remove(&change.path);
                    self.reported.remove(&change.path);
                    matched.push((change.path.clone(), "deleted"));
                }
                continue;
            };
            if now.ignored {
                continue;
            }
            let version = Self::version(&now);
            if announce {
                matched.push((
                    change.path.clone(),
                    if change.kind == WatchKind::Modified {
                        "changed"
                    } else if change.kind == WatchKind::Created {
                        "created"
                    } else {
                        "deleted"
                    },
                ));
            } else if before.is_none() {
                matched.push((
                    change.path.clone(),
                    if change.kind == WatchKind::Modified {
                        "changed"
                    } else {
                        "created"
                    },
                ));
            } else if before
                .as_ref()
                .is_some_and(|before| before.version != version)
            {
                matched.push((change.path.clone(), "changed"));
            } else if self
                .reported
                .get(&change.path)
                .is_some_and(|reported| *reported == version)
            {
                let digest = if now.file {
                    self.checkout.digest(&change.path)?
                } else {
                    None
                };
                self.reported.remove(&change.path);
                let before_digest = before.as_ref().and_then(|before| before.digest.as_deref());
                if digest.is_none() || before_digest.is_none() || digest.as_deref() == before_digest
                {
                    continue;
                }
                matched.push((change.path.clone(), "changed"));
            } else if change.kind == WatchKind::Modified {
                matched.push((change.path.clone(), "changed"));
            }
            if !self.known.contains_key(&change.path)
                && self.known.len() >= self.limits.snapshot_limit
            {
                continue;
            }
            if now.file {
                hashed.push(change.path.clone());
            }
            self.known.insert(
                change.path.clone(),
                Known {
                    version,
                    digest: None,
                    file: now.file,
                },
            );
        }
        for path in hashed {
            if let Some(digest) = self.checkout.digest(&path)?
                && let Some(entry) = self.known.get_mut(&path)
            {
                entry.digest = Some(digest);
            }
        }
        Ok(self.fire(&matched))
    }

    fn rescan(&mut self) -> Result<Vec<FileEvent>> {
        let entries = self.checkout.walk()?;
        let mut current: HashMap<String, Known> = HashMap::new();
        let mut files = Vec::new();
        let mut full = false;
        for entry in entries {
            if entry.ignored || !self.matches(&entry.path) {
                continue;
            }
            if current.len() >= self.limits.snapshot_limit {
                full = true;
                break;
            }
            if entry.file {
                files.push(entry.path.clone());
            }
            current.insert(
                entry.path.clone(),
                Known {
                    version: Self::version(&entry),
                    digest: None,
                    file: entry.file,
                },
            );
        }
        if self.closed {
            return Ok(Vec::new());
        }
        if full {
            self.complete = false;
            self.warnings
                .push("Automation rescan exceeded its snapshot; the baseline was kept".to_owned());
            return Ok(Vec::new());
        }
        for path in files {
            if let Some(digest) = self.checkout.digest(&path)?
                && let Some(entry) = current.get_mut(&path)
            {
                entry.digest = Some(digest);
            }
        }
        if self.closed {
            return Ok(Vec::new());
        }
        if !self.complete {
            self.known = current;
            self.complete = true;
            return Ok(Vec::new());
        }
        let mut changes: Vec<(String, &'static str)> = Vec::new();
        for (path, now) in &current {
            match self.known.get(path) {
                None => changes.push((path.clone(), "created")),
                Some(before) if before.version != now.version => {
                    changes.push((path.clone(), "changed"));
                }
                Some(before)
                    if before.digest.is_some()
                        && now.digest.is_some()
                        && before.digest != now.digest =>
                {
                    changes.push((path.clone(), "changed"));
                }
                Some(_) => {}
            }
        }
        for path in self.known.keys() {
            if !current.contains_key(path) {
                changes.push((path.clone(), "deleted"));
            }
        }
        self.known = current;
        self.reported = self
            .known
            .iter()
            .map(|(path, entry)| (path.clone(), entry.version.clone()))
            .collect();
        Ok(self.fire(&changes))
    }
}

/// The real files backend reads: `files-list` for entries and `files-io` for digests.
pub struct FilesCheckout {
    root: files_safe::Root,
    lister: files_list::Lister,
}

impl FilesCheckout {
    pub fn open(path: &std::path::Path) -> std::result::Result<FilesCheckout, AutomationsError> {
        let root = files_safe::Root::open(path)
            .map_err(|error| AutomationsError::message(error.to_string()))?;
        let lister = files_list::Lister::new(root.clone());
        Ok(FilesCheckout { root, lister })
    }

    fn list_options(cursor: Option<String>) -> files_list::ListOptions {
        files_list::ListOptions {
            limit: 5000,
            cursor,
            hide: vec![".git".to_owned(), ".DS_Store".to_owned()],
        }
    }

    fn walk_dir(&self, dir: &str, out: &mut Vec<CheckoutEntry>) -> Result<()> {
        let mut cursor = None;
        loop {
            let page = self
                .lister
                .list_pinned(dir, &Self::list_options(cursor))
                .map_err(|error| AutomationsError::message(error.to_string()))?;
            for entry in &page.entries {
                out.push(entry_of(entry));
                if matches!(entry.kind, files_list::Kind::Directory) {
                    self.walk_dir(&entry.path, out)?;
                }
            }
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        Ok(())
    }
}

fn entry_of(entry: &files_list::Entry) -> CheckoutEntry {
    let kind = match &entry.kind {
        files_list::Kind::File => "file",
        files_list::Kind::Directory => "directory",
        files_list::Kind::Symlink { .. } => "symlink",
        files_list::Kind::Other => "other",
    };
    CheckoutEntry {
        path: entry.path.clone(),
        version: if entry.kind.is_directory() {
            "directory".to_owned()
        } else {
            format!("{kind}:{}:{}", entry.size, entry.mtime_ms)
        },
        file: matches!(entry.kind, files_list::Kind::File),
        directory: matches!(entry.kind, files_list::Kind::Directory),
        ignored: entry.ignored,
    }
}

impl Checkout for FilesCheckout {
    fn walk(&self) -> Result<Vec<CheckoutEntry>> {
        let mut out = Vec::new();
        self.walk_dir("", &mut out)?;
        Ok(out)
    }

    fn stat(&self, path: &str) -> Result<Option<CheckoutEntry>> {
        match self.lister.stat(path) {
            Ok(entry) => Ok(Some(entry_of(&entry))),
            Err(error) if error.code() == "NOT_FOUND" => Ok(None),
            Err(error) => Err(AutomationsError::message(error.to_string())),
        }
    }

    fn digest(&self, path: &str) -> Result<Option<String>> {
        // A file written while it is hashed is a conflict, and one that vanished is a delete the
        // version already shows. Neither may fail the whole reconciliation.
        Ok(files_io::fingerprint(&self.root, path)
            .ok()
            .map(|fingerprint| fingerprint.digest))
    }
}

/// The files backend's own watcher.
pub struct FilesWatch;

impl FilesWatch {
    pub fn new() -> FilesWatch {
        FilesWatch
    }
}

impl Default for FilesWatch {
    fn default() -> Self {
        FilesWatch
    }
}

struct WatchHandle {
    watcher: Option<files_watch::Watcher>,
}

impl Subscription for WatchHandle {
    fn stop(&mut self) {
        self.watcher.take();
    }
}

impl Watch for FilesWatch {
    fn watch(
        &self,
        root: &str,
        sink: Box<dyn Fn(WorkspacePayload) + Send + Sync>,
    ) -> Result<Box<dyn Subscription>> {
        let root = files_safe::Root::open(std::path::Path::new(root))
            .map_err(|error| AutomationsError::message(error.to_string()))?;
        let watcher = files_watch::Watcher::start(
            root,
            files_watch::WatchOptions {
                debounce: Duration::from_millis(75),
                ..files_watch::WatchOptions::default()
            },
            Box::new(move |batch| sink(payload_of(batch))),
        )
        .map_err(|error| AutomationsError::message(error.to_string()))?;
        Ok(Box::new(WatchHandle {
            watcher: Some(watcher),
        }))
    }
}

fn payload_of(batch: files_watch::Batch) -> WorkspacePayload {
    match batch {
        files_watch::Batch::Changes(changes) => WorkspacePayload::Changes(
            changes
                .into_iter()
                .map(|change| WatchChange {
                    path: change.path,
                    kind: match change.kind {
                        files_watch::ChangeKind::Created => WatchKind::Created,
                        files_watch::ChangeKind::Modified => WatchKind::Modified,
                        files_watch::ChangeKind::Deleted => WatchKind::Deleted,
                    },
                    directory: change.directory,
                })
                .collect(),
        ),
        files_watch::Batch::Rescan { .. } => WorkspacePayload::Rescan,
        files_watch::Batch::Warning(message) => WorkspacePayload::Warning(message),
    }
}

/// The hooks one subscription reports.
type ReadyHook = Box<dyn Fn() + Send + Sync>;
type ErrorHook = Box<dyn Fn(&str) + Send + Sync>;

#[derive(Default)]
pub struct WorkspaceHooks {
    pub on_ready: Option<ReadyHook>,
    pub on_error: Option<ErrorHook>,
}

/// One open trigger's watcher and baseline.
pub struct WorkspaceSubscription {
    state: Arc<Mutex<Reconciler>>,
    watch: Option<Box<dyn Subscription>>,
}

impl WorkspaceSubscription {
    pub fn stop(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            state.close();
        }
        if let Some(watch) = &mut self.watch {
            watch.stop();
        }
        self.watch = None;
    }
}

impl Drop for WorkspaceSubscription {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Open one automation's file trigger: watch, seed the baseline, then report ready and replay
/// what arrived meanwhile.
pub struct WorkspaceOpen<'a> {
    pub checkout: Box<dyn Checkout>,
    pub watch: &'a dyn Watch,
    pub root: &'a str,
    pub patterns: &'a [String],
    pub limits: WorkspaceLimits,
    pub ids: Box<dyn IdSource>,
    pub receive: Box<dyn Fn(FileEvent) + Send + Sync>,
    pub hooks: WorkspaceHooks,
}

pub fn subscribe(open: WorkspaceOpen<'_>) -> Result<WorkspaceSubscription> {
    let WorkspaceOpen {
        checkout,
        watch,
        root,
        patterns,
        limits,
        ids,
        receive,
        hooks,
    } = open;
    let mut reconciler = Reconciler::new(checkout, patterns, limits, ids)?;
    reconciler.begin_buffering();
    let state = Arc::new(Mutex::new(reconciler));
    let receive = Arc::new(receive);
    let sink_state = Arc::clone(&state);
    let sink_receive = Arc::clone(&receive);
    let sink = Box::new(move |payload: WorkspacePayload| {
        let events = match sink_state.lock() {
            Ok(mut state) => state.receive(payload, false),
            Err(_) => return,
        };
        if let Ok(events) = events {
            for event in events {
                sink_receive(event);
            }
        }
    });
    let mut watch = watch.watch(root, sink)?;
    let seeded = match state.lock() {
        Ok(mut state) => state.seed(),
        Err(_) => Err(AutomationsError::message(
            "workspace baseline lock poisoned",
        )),
    };
    if let Err(error) = seeded {
        watch.stop();
        if let Some(on_error) = hooks.on_error {
            on_error(&error.to_string());
        }
        return Err(error);
    }
    let ready = match state.lock() {
        Ok(mut state) => state.ready(),
        Err(_) => Err(AutomationsError::message(
            "workspace baseline lock poisoned",
        )),
    };
    let events = match ready {
        Ok(events) => events,
        Err(error) => {
            watch.stop();
            if let Some(on_error) = hooks.on_error {
                on_error(&error.to_string());
            }
            return Err(error);
        }
    };
    if let Some(on_ready) = hooks.on_ready {
        on_ready();
    }
    for event in events {
        receive(event);
    }
    Ok(WorkspaceSubscription {
        state,
        watch: Some(watch),
    })
}

/// JSON shape of one file event's variables, for callers that store a debug copy.
pub fn variables_value(variables: &BTreeMap<String, String>) -> Value {
    let mut map = ace_json::Map::new();
    for (key, value) in variables {
        map.insert(key.as_str(), Value::String(value.as_str().into()));
    }
    Value::Object(map)
}
