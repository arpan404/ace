// SPDX-License-Identifier: Apache-2.0
//! The facts `validateCreation` reads from the engine and its edges (`creation-validation.ts`):
//! the stored thread and workspace rows, the registry, the model catalog and the filesystem.
//!
//! Every read that can fail before validation (a thread row, a workspace path) happens in
//! [`Facts::read`], so a port error rolls the receipt back instead of becoming a refusal code.
//! The two reads validation makes itself (the catalog's capabilities, `selectInstance`) are
//! recorded in `failure` and surfaced after the decision.

use std::cell::RefCell;

use ace_json::Value;

use super::text;
use crate::commands::validation::CreationFacts;
use crate::models::select::{Catalog, PortCatalog, permission_capabilities};
use crate::{Core, EngineError, State};

/// The validation's facts, read once for one `thread.create` or `thread.prepare`.
pub struct Facts<'a> {
    core: &'a Core,
    state: &'a State,
    /// `workspaceId` and the path `repo.workspace` gave it, read before validation.
    workspace: Option<(String, String)>,
    /// Ids that name a stored thread (`repo.store.getThread`), read before validation.
    known: Vec<String>,
    /// A port that threw inside validation, so the receipt rolls back after the decision.
    failure: RefCell<Option<EngineError>>,
}

impl<'a> Facts<'a> {
    /// Reads what validation needs: the payload's own thread rows and its workspace's path.
    pub fn read(
        core: &'a Core,
        state: &'a State,
        payload: &Value,
        workspace: Option<String>,
    ) -> Result<Facts<'a>, EngineError> {
        let mut known = Vec::new();
        for key in ["threadId", "handoffFrom"] {
            if let Some(id) = text(payload, key)
                && crate::commands::prelude::thread_row(core, id)?.is_some()
            {
                known.push(id.to_owned());
            }
        }
        let workspace = text(payload, "workspaceId")
            .zip(workspace)
            .map(|(id, path)| (id.to_owned(), path));
        Ok(Facts {
            core,
            state,
            workspace,
            known,
            failure: RefCell::new(None),
        })
    }

    /// The port error validation ran into, if any.
    pub fn failure(&self) -> Result<(), EngineError> {
        match self.failure.borrow_mut().take() {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    fn record(&self, error: EngineError) {
        let mut failure = self.failure.borrow_mut();
        if failure.is_none() {
            *failure = Some(error);
        }
    }

    fn entry(&self, provider: &str) -> Option<&crate::registry::Entry> {
        self.state.registry.get(provider, None).ok()
    }
}

impl CreationFacts for Facts<'_> {
    fn thread_exists(&self, id: &str) -> bool {
        self.known.iter().any(|known| known == id)
    }

    fn workspace(&self, id: &str) -> Option<String> {
        self.workspace
            .as_ref()
            .filter(|(known, _)| known == id)
            .map(|(_, path)| path.clone())
    }

    /// `workspaceDirectory` (`workspace-directory.ts:3`-`:6`): `realpathSync`, then a directory
    /// check. The path keeps `realpathSync`'s spelling: on Windows the verbatim `\\?\` prefix is
    /// stripped, the same rule as `ace-git`'s `core::paths::display_path` (the engine does not
    /// depend on the Git crate, so the eight lines live here too).
    fn directory(&self, path: &str) -> Option<String> {
        let resolved = std::fs::canonicalize(path).ok()?;
        if !resolved.is_dir() {
            return None;
        }
        Some(display_path(&resolved))
    }

    fn reserved(&self, root: &str) -> bool {
        const RESERVED: &str = "SELECT 1 FROM workspace_root_reservations WHERE root=? LIMIT 1";
        ace_store::stmt_cache::get_row(
            self.core.store.conn(),
            RESERVED,
            vec![ace_store::Value::Text(root.to_owned())],
        )
        .ok()
        .flatten()
        .is_some()
    }

    fn has_provider(&self, provider: &str, _acp_identity: Option<&Value>) -> bool {
        // `registry.has(provider, identity)` asks the adapter (`acceptsIdentity`); E5.6's session
        // opening binds that answer, and the view answers presence until then.
        self.state.registry.has_identity(provider, None)
    }

    fn backend(&self, provider: &str) -> Option<String> {
        self.entry(provider).and_then(|entry| entry.backend.clone())
    }

    fn permission_capabilities(
        &self,
        provider: &str,
        instance_id: Option<&str>,
        base: &Value,
    ) -> Value {
        let catalog = PortCatalog(&*self.core.ports);
        let catalog = self
            .core
            .ports
            .has_models()
            .then_some(&catalog as &dyn Catalog);
        match permission_capabilities(catalog, provider, instance_id, base) {
            Ok(capabilities) => capabilities,
            Err(error) => {
                self.record(error);
                base.clone()
            }
        }
    }

    fn access_offers(&self, provider: &str, capabilities: &Value) -> Option<Vec<String>> {
        // `reportedOrTable` (`access-modes.ts:127`): what the instance reports, else ace's table.
        // ACP reports its modes only once a session opens, so it offers none until then; every
        // first-party table offers at least one mode, so an absent report never refuses.
        match capabilities.get("accessModes").and_then(Value::as_array) {
            Some(offers) => Some(
                offers
                    .iter()
                    .filter_map(|offer| offer.get("mode").and_then(Value::as_str))
                    .map(str::to_owned)
                    .collect(),
            ),
            None if provider == "acp" => Some(Vec::new()),
            None => None,
        }
    }

    fn select_instance(&self, provider: &str, backend: Option<&str>) -> Option<String> {
        match self.core.ports.select_instance(provider, backend) {
            Ok(instance) => instance,
            Err(error) => {
                self.record(EngineError::Port(error));
                None
            }
        }
    }

    fn portable_handoff(&self, _source: &str) -> Option<Value> {
        // The create refuses a `handoffFrom` before validation: the port is not bound (E5.4e).
        None
    }

    fn supports_launch_option(&self, provider: &str, option: &str) -> bool {
        self.entry(provider)
            .and_then(|entry| entry.capabilities.get("launchOptions"))
            .and_then(Value::as_array)
            .is_some_and(|options| options.iter().any(|known| known.as_str() == Some(option)))
    }

    fn max_input_bytes(&self) -> usize {
        self.state.limits.max_input_bytes as usize
    }
}

/// A canonical path as a JavaScript string: UTF-8 bytes, verbatim prefixes removed on Windows.
fn display_path(path: &std::path::Path) -> String {
    let text = path.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return rest.to_owned();
        }
    }
    text
}
