// SPDX-License-Identifier: Apache-2.0
//! One settings file: read, write, watch and reload (`file.ts`).
//!
//! Reads and writes cross an injected IO port, the watch an injected scheduler, so the
//! crate never opens a file itself. A write follows the validated document and keeps
//! comments; a read that a build migrates is written back; a malformed file keeps its
//! diagnostic and leaves the last good values in place.

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;

use serde_json::Value;

use crate::document::{DecodedDocument, empty_text};
use crate::layers::Provenance;
use crate::schema::is_key;
use crate::validation::{SettingsCode, SettingsError};

/// A file diagnostic, as `SettingsDiagnostic` carries it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileDiagnostic {
    pub layer: Provenance,
    pub code: SettingsCode,
    pub message: String,
    pub offset: Option<usize>,
}

/// What one commit changed: the keys, or the diagnostic explaining why nothing did.
#[derive(Debug, Clone, Default)]
pub struct FileChange {
    pub keys: Vec<String>,
    pub diagnostic: Option<FileDiagnostic>,
}

/// Stops a watch or a scheduled callback.
pub type Stop = Box<dyn FnOnce()>;

/// A containment check run before a read and again before a write commits.
pub type Validate = Rc<dyn Fn() -> Result<(), SettingsError>>;

/// The file port: bounded reads, atomic writes and a watch.
pub trait SettingsIo {
    fn read(&self, path: &std::path::Path) -> Result<Option<String>, SettingsError>;
    /// A write is atomic: `before_commit` runs after the temporary file is complete and
    /// immediately before the destination is replaced.
    fn write(
        &self,
        path: &std::path::Path,
        text: &str,
        before_commit: Option<&Validate>,
    ) -> Result<(), SettingsError>;
    fn watch(
        &self,
        path: &std::path::Path,
        changed: Rc<dyn Fn()>,
        failed: Rc<dyn Fn()>,
    ) -> Result<Stop, SettingsError>;
}

/// The timer port: one debounced reload after a watched change.
pub trait Scheduler {
    fn schedule(&self, delay_ms: u64, callback: Box<dyn Fn()>) -> Stop;
}

/// A settings file at one layer.
pub struct SettingsFile {
    pub path: PathBuf,
    pub layer: Provenance,
    prepared: DecodedDocument,
    document: std::collections::BTreeMap<String, Value>,
    diagnostic: Option<FileDiagnostic>,
    watcher_diagnostic: Rc<RefCell<Option<FileDiagnostic>>>,
    validate: Option<Validate>,
    io: std::sync::Arc<dyn SettingsIo>,
    stop_watch: Option<Stop>,
    schedule: Option<Rc<dyn Fn()>>,
    changed: Rc<dyn Fn(FileChange)>,
    closed: bool,
}

fn report(layer: Provenance, error: &SettingsError) -> FileDiagnostic {
    FileDiagnostic {
        layer,
        code: error.code,
        message: error.message.clone(),
        offset: error.offset,
    }
}

impl SettingsFile {
    pub fn new(
        path: PathBuf,
        layer: Provenance,
        io: std::sync::Arc<dyn SettingsIo>,
        changed: Rc<dyn Fn(FileChange)>,
    ) -> Self {
        let prepared = DecodedDocument::decode(empty_text())
            .unwrap_or_else(|_| panic!("the empty settings document always decodes"));
        let document = prepared.settings.clone().into_iter().collect();
        Self {
            path,
            layer,
            prepared,
            document,
            diagnostic: None,
            watcher_diagnostic: Rc::new(RefCell::new(None)),
            validate: None,
            io,
            stop_watch: None,
            schedule: None,
            changed,
            closed: false,
        }
    }

    /// The file's settings, after the last successful read or write.
    pub fn settings(&self) -> &std::collections::BTreeMap<String, Value> {
        &self.document
    }

    pub fn text(&self) -> &str {
        &self.prepared.text
    }

    pub fn diagnostic(&self) -> Option<FileDiagnostic> {
        self.diagnostic
            .clone()
            .or_else(|| self.watcher_diagnostic.borrow().clone())
    }

    fn publish(&mut self, prepared: DecodedDocument) {
        let mut keys = Vec::new();
        for key in self.document.keys().chain(prepared.settings.keys()) {
            if !is_key(key) || keys.contains(key) {
                continue;
            }
            if self.document.get(key) != prepared.settings.get(key) {
                keys.push(key.clone());
            }
        }
        keys.sort();
        self.document = prepared.settings.clone().into_iter().collect();
        self.prepared = prepared;
        self.diagnostic = None;
        if !keys.is_empty() {
            (self.changed)(FileChange {
                keys,
                diagnostic: None,
            });
        }
    }

    fn report(&mut self, error: SettingsError) {
        let diagnostic = report(self.layer, &error);
        if self.diagnostic.as_ref() == Some(&diagnostic) {
            return;
        }
        self.diagnostic = Some(diagnostic.clone());
        (self.changed)(FileChange {
            keys: Vec::new(),
            diagnostic: Some(diagnostic),
        });
    }

    /// Attaches the workspace's permanent containment check, running it once now.
    pub fn protect(&mut self, validate: Validate) {
        if self.validate.is_none() {
            self.validate = Some(validate);
        }
        if let Err(error) = self.check() {
            self.report(error);
        }
    }

    fn check(&self) -> Result<(), SettingsError> {
        match &self.validate {
            Some(validate) => validate(),
            None => Ok(()),
        }
    }

    /// Starts watching the file: a change schedules `schedule` (the service's debounced
    /// reload), and a broken watch reports its own diagnostic, then schedules a retry so a
    /// repaired watch recovers.
    pub fn watch(&mut self, schedule: Rc<dyn Fn()>) -> Result<(), SettingsError> {
        if self.closed {
            return Ok(());
        }
        self.schedule = Some(schedule.clone());
        let layer = self.layer;
        let notify = self.changed.clone();
        let watcher = self.watcher_diagnostic.clone();
        let retry = schedule.clone();
        let failed = Rc::new(move || {
            let diagnostic = FileDiagnostic {
                layer,
                code: SettingsCode::Io,
                message: "Settings watcher failed".to_owned(),
                offset: None,
            };
            let report = {
                let mut current = watcher.borrow_mut();
                if current.as_ref() == Some(&diagnostic) {
                    false
                } else {
                    *current = Some(diagnostic.clone());
                    true
                }
            };
            if report {
                notify(FileChange {
                    keys: Vec::new(),
                    diagnostic: Some(diagnostic),
                });
            }
            retry();
        });
        let on_failure = failed.clone();
        match self.io.watch(&self.path, schedule, failed) {
            Ok(stop) => {
                if let Some(previous) = self.stop_watch.take() {
                    previous();
                }
                self.stop_watch = Some(stop);
                *self.watcher_diagnostic.borrow_mut() = None;
                Ok(())
            }
            Err(error) => {
                // A watch that cannot be installed reports and schedules another attempt,
                // as a watch that later failed does.
                on_failure();
                Err(error)
            }
        }
    }

    /// Reads the file again; a migrated document is written back. A malformed file, a failed
    /// containment check or an unreadable file reports its diagnostic and keeps the last good
    /// values: the read stays effective and the watch stays installed for a repair.
    pub fn reload(&mut self) -> Result<(), SettingsError> {
        if self.closed {
            return Ok(());
        }
        let schedule = self.schedule.clone();
        if let Some(schedule) = schedule {
            let _ = self.watch(schedule);
        }
        if let Err(error) = self.reload_inner() {
            self.report(error);
        }
        Ok(())
    }

    fn reload_inner(&mut self) -> Result<(), SettingsError> {
        self.check()?;
        let source = self
            .io
            .read(&self.path)?
            .unwrap_or_else(|| empty_text().to_owned());
        let prepared = if source == self.prepared.text {
            self.prepared.clone()
        } else {
            DecodedDocument::decode(&source)?
        };
        if prepared.migrated {
            self.io
                .write(&self.path, &prepared.text, self.validate.as_ref())?;
        }
        self.publish(prepared);
        Ok(())
    }

    /// Sets one key in this file.
    pub fn set(&mut self, key: &str, value: &Value) -> Result<(), SettingsError> {
        self.update(|source| source.assign(key, value))
    }

    /// Sets `key` only when the file does not hold it.
    pub fn set_if_absent(&mut self, key: &str, value: &Value) -> Result<bool, SettingsError> {
        let mut wrote = false;
        self.update(|source| {
            if source.get(key).is_some() {
                return Ok(source.clone());
            }
            wrote = true;
            source.assign(key, value)
        })?;
        Ok(wrote)
    }

    /// Sets several keys in one commit.
    pub fn set_many(&mut self, entries: &[(String, Value)]) -> Result<(), SettingsError> {
        self.update(|source| {
            let mut next = source.clone();
            for (key, value) in entries {
                next = next.assign(key, value)?;
            }
            Ok(next)
        })
    }

    /// Removes preferences, keeping unknown keys and comments.
    pub fn reset(&mut self, keys: &[String]) -> Result<(), SettingsError> {
        self.update(|source| {
            let refs: Vec<&str> = keys.iter().map(String::as_str).collect();
            source.reset(&refs)
        })
    }

    fn update(
        &mut self,
        change: impl FnOnce(&DecodedDocument) -> Result<DecodedDocument, SettingsError>,
    ) -> Result<(), SettingsError> {
        match self.update_inner(change) {
            Ok(()) => Ok(()),
            Err(error) => {
                self.report(error.clone());
                Err(error)
            }
        }
    }

    fn update_inner(
        &mut self,
        change: impl FnOnce(&DecodedDocument) -> Result<DecodedDocument, SettingsError>,
    ) -> Result<(), SettingsError> {
        self.check()?;
        let raw = self
            .io
            .read(&self.path)?
            .unwrap_or_else(|| empty_text().to_owned());
        let source = if raw == self.prepared.text {
            self.prepared.clone()
        } else {
            DecodedDocument::decode(&raw)?
        };
        let result = change(&source)?;
        if source.migrated || result.text != source.text {
            self.io
                .write(&self.path, &result.text, self.validate.as_ref())?;
        }
        self.publish(result);
        Ok(())
    }

    pub fn close(&mut self) {
        self.closed = true;
        if let Some(stop) = self.stop_watch.take() {
            stop();
        }
    }
}

#[cfg(test)]
mod tests {
    //! Ports `packages/settings/src/durability.test.ts` and the scalar cases of
    //! `files.test.ts`: a write keeps unknown keys and comments, a malformed file keeps
    //! its diagnostic and the last good values, and a migrated read is written back.

    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemoryIo {
        files: Mutex<BTreeMap<PathBuf, String>>,
        writes: Mutex<usize>,
    }

    impl SettingsIo for MemoryIo {
        fn read(&self, path: &std::path::Path) -> Result<Option<String>, SettingsError> {
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
            before_commit: Option<&Validate>,
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
            _changed: Rc<dyn Fn()>,
            _failed: Rc<dyn Fn()>,
        ) -> Result<Stop, SettingsError> {
            Ok(Box::new(|| {}))
        }
    }

    fn file(io: std::sync::Arc<MemoryIo>) -> SettingsFile {
        SettingsFile::new(
            PathBuf::from("/settings.json"),
            Provenance::Global,
            io,
            Rc::new(|_| {}),
        )
    }

    #[test]
    fn a_write_keeps_comments_and_unknown_keys_and_a_migrated_read_writes_back() {
        let io = std::sync::Arc::new(MemoryIo::default());
        io.files
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(
                PathBuf::from("/settings.json"),
                "{\n  // note\n  \"version\": 2,\n  \"settings\": {\n    \"future.note\": 1,\n    \"remote.transport\": \"lan\"\n  }\n}\n".to_owned(),
            );
        let mut file = file(io.clone());
        file.reload().unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            *io.writes.lock().unwrap_or_else(|error| error.into_inner()),
            1
        );
        file.set("threads.settleOnClose", &json!(true))
            .unwrap_or_else(|error| panic!("{error}"));
        let text = io
            .files
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(&PathBuf::from("/settings.json"))
            .cloned()
            .unwrap_or_default();
        assert!(text.contains("// note"));
        assert!(text.contains("\"future.note\": 1"));
        assert!(text.contains("\"threads.settleOnClose\": true"));
        assert!(!text.contains("remote.transport"));
    }

    #[test]
    fn a_malformed_file_keeps_its_diagnostic_and_the_last_good_values() {
        let io = std::sync::Arc::new(MemoryIo::default());
        io.files
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(
                PathBuf::from("/settings.json"),
                "{\"version\":2,\"settings\":{\"threads.settleOnClose\":true}}".to_owned(),
            );
        let mut file = file(io.clone());
        file.reload().unwrap_or_else(|error| panic!("{error}"));
        io.files
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(PathBuf::from("/settings.json"), "{".to_owned());
        file.reload().unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            file.diagnostic().map(|diagnostic| diagnostic.code),
            Some(SettingsCode::Parse)
        );
        assert_eq!(
            file.settings().get("threads.settleOnClose"),
            Some(&json!(true))
        );
    }
}
