// SPDX-License-Identifier: Apache-2.0
//! The service's file watchers (`service.ts`'s `AutomationRuntime`): a subscription is prepared
//! beside any current one, installed only after its definition commits, and readiness or failure
//! arrives later on the one the host holds. Split from the service's lifecycle and scheduling.

use std::collections::BTreeMap;

use super::{PreparedWatch, Service, Watch};
use crate::error::{AutomationsError, Result};
use crate::store::{Definition, Trigger};
use ace_json::{Map, Value};

impl<'a> Service<'a> {
    /// Prepare a watcher beside any current one; the caller installs it after the save commits
    /// and discards it on a failed save, so a replacement failure never drops a working watch.
    pub(super) fn prepare_watch(
        &mut self,
        automation: &Definition,
    ) -> Result<Option<PreparedWatch>> {
        if !self.lives.live() || !automation.enabled || automation.trigger.kind() != "file" {
            return Ok(None);
        }
        let Some(workspace_port) = self.ports.workspace else {
            return Ok(None);
        };
        let Trigger::File { paths } = &automation.trigger else {
            return Ok(None);
        };
        self.revision += 1;
        let revision = self.revision;
        let subscription = workspace_port
            .subscribe(&automation.workspace, paths)
            .map_err(AutomationsError::message)?;
        Ok(Some(PreparedWatch {
            subscription,
            revision,
        }))
    }

    pub(super) fn install_watch(&mut self, id: &str, prepared: PreparedWatch) {
        let previous = self.watches.insert(
            id.to_owned(),
            Watch {
                subscription: prepared.subscription,
                revision: prepared.revision,
            },
        );
        if let Some(previous) = previous
            && let Some(workspace) = self.ports.workspace
        {
            workspace.unsubscribe(previous.subscription);
        }
    }

    pub(super) fn discard_watch(&mut self, prepared: Option<PreparedWatch>) {
        if let Some(prepared) = prepared
            && let Some(workspace) = self.ports.workspace
        {
            workspace.unsubscribe(prepared.subscription);
        }
    }

    pub(super) fn drop_watch(&mut self, id: &str) {
        if let Some(watch) = self.watches.remove(id)
            && let Some(workspace) = self.ports.workspace
        {
            workspace.unsubscribe(watch.subscription);
        }
    }

    pub(super) fn watch_current(&self, id: &str) -> Option<u64> {
        self.watches.get(id).map(|watch| watch.revision)
    }

    /// The revision a watcher's hooks carry, for the host to hand back on readiness or failure.
    pub fn watch_revision(&self, id: &str) -> Option<u64> {
        self.watch_current(id)
    }

    /// The watcher reported readiness: clear the trigger's stored error if it is still current.
    pub fn watch_ready(&mut self, id: &str, revision: u64) -> Result<()> {
        if !self.lives.live() || self.watch_current(id) != Some(revision) {
            return Ok(());
        }
        self.store.clear_trigger_error(id)
    }

    /// The watcher failed: persist health and drop the failed watch.
    pub fn watch_error(&mut self, id: &str, revision: u64, message: &str) -> Result<()> {
        if !self.lives.live() || self.watch_current(id) != Some(revision) {
            return Ok(());
        }
        self.save_watch_error(id, &AutomationsError::message(message.to_owned()))?;
        self.drop_watch(id);
        Ok(())
    }

    pub(super) fn save_watch_error(&mut self, id: &str, error: &AutomationsError) -> Result<()> {
        let mut body = Map::new();
        body.insert("message", Value::String(error.to_string().as_str().into()));
        body.insert("at", Value::Number(self.now().into()));
        self.store.save_trigger_error(id, &Value::Object(body))
    }

    /// A file change from the workspace, after the watcher's own debounce and dedupe.
    pub fn receive_file_event(
        &mut self,
        id: &str,
        revision: u64,
        key: &str,
        variables: BTreeMap<String, String>,
    ) -> Result<()> {
        if !self.lives.live() || self.watch_current(id) != Some(revision) {
            return Ok(());
        }
        self.trigger(id, key, variables, "file", None)?;
        Ok(())
    }
}
