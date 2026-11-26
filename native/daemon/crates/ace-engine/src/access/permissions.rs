// SPDX-License-Identifier: Apache-2.0
//! `Permissions` (`permissions.ts:80`): durable access ownership (ADR 0075), ace modes per
//! thread with native selectors at the edge. The row is `access/storage.rs`; the ancestry rules
//! are `access/modes.rs`. Every choice is an event on the thread, never a quiet row write.
//!
//! The TypeScript's `resolve` awaits `permissionSettings` first; the facade awaits it and then
//! calls this module, which reads the revision itself, so a choice accepted while the settings
//! loaded is still the one resolved (rule: port the awaits where they are).

use ace_json::Value;
use ace_store::{Value as Cell, stmt_cache};
use std::collections::HashMap;

use crate::access::ceiling::thread_facts;
use crate::access::modes::{
    AccessSelection, custom_native, custom_selection, native_for, nearest_offer, offers_of,
    supports_permission_mode,
};
use crate::access::storage::{self, PermissionRecord, PermissionState, permission_event};
use crate::access::{AccessDefaults, AccessError};
use crate::{EngineError, EngineStore, State, ThreadId};

const UPDATE_OVERRIDE: &str = "UPDATE engine_permissions SET override=? WHERE thread_id=?";
const UPDATE_EFFECTIVE: &str = "UPDATE engine_permissions SET effective=? WHERE thread_id=?";
const UPDATE_BOTH: &str = "UPDATE engine_permissions SET override=?, effective=? WHERE thread_id=?";

fn text_cell(value: Option<&str>) -> Cell {
    value.map_or(Cell::Null, |text| Cell::Text(text.to_owned()))
}

/// Each accepted choice's revision, so an acknowledgement can tell it is about an older one.
#[derive(Debug, Default)]
pub struct Permissions {
    revisions: HashMap<ThreadId, u64>,
}

impl Permissions {
    /// The revision of the thread's own choice; it changes whenever a new choice is accepted.
    pub fn revision(&self, id: &str) -> u64 {
        self.revisions.get(id).copied().unwrap_or(0)
    }

    fn bump(&mut self, id: &str) {
        let next = self.revision(id) + 1;
        self.revisions.insert(id.to_owned(), next);
    }
}

/// What a thread runs next (`ResolvedAccess`).
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedAccess {
    pub selection: Option<AccessSelection>,
    pub native: Option<String>,
    /// The ace mode asked for (the thread's own or the default), when one was resolved.
    pub wanted: Option<String>,
    pub revision: u64,
}

impl State {
    /// `Permissions.read` for the state functions that take the store directly.
    pub fn permission_record(
        &mut self,
        store: &EngineStore,
        id: &str,
    ) -> Result<PermissionRecord, EngineError> {
        storage::read(store, id)
    }

    /// `Permissions.state`: the row a client reads.
    pub fn permission_state(
        &mut self,
        store: &EngineStore,
        id: &str,
    ) -> Result<PermissionState, EngineError> {
        storage::state(store, id)
    }

    /// `Permissions.ensure`: the row exists, then the state it reads.
    pub fn permission_ensure(
        &mut self,
        store: &EngineStore,
        id: &str,
    ) -> Result<PermissionState, EngineError> {
        storage::ensure(store, id, None)
    }

    /// `Permissions.effective`: the stored selection, native ids and `custom:` included.
    pub fn permission_effective(
        &mut self,
        store: &EngineStore,
        id: &str,
    ) -> Result<Option<String>, EngineError> {
        Ok(storage::read(store, id)?.effective)
    }

    /// The revision of the thread's own choice.
    pub fn permission_revision(&self, id: &str) -> u64 {
        self.permissions.revision(id)
    }

    pub fn permission_hold(
        &mut self,
        store: &EngineStore,
        id: &str,
        access: &str,
        at: f64,
    ) -> Result<bool, EngineError> {
        storage::ensure(store, id, None)?;
        let before = storage::read(store, id)?;
        if before.override_mode.as_deref() == Some(access)
            && before.effective.as_deref() == Some(access)
        {
            return Ok(false);
        }
        store.atomic(|_| {
            stmt_cache::run(
                store.conn(),
                UPDATE_BOTH,
                vec![
                    Cell::Text(access.to_owned()),
                    Cell::Text(access.to_owned()),
                    Cell::Text(id.to_owned()),
                ],
            )?;
            let state = storage::state(store, id)?;
            let events = permission_event(&state);
            store.write_events(id, &events, at)
        })?;
        Ok(true)
    }

    /// `Permissions.refusal`: why a child's access was refused.
    pub fn permission_set(
        &mut self,
        store: &EngineStore,
        id: &str,
        access: Option<&str>,
        capabilities: Option<&Value>,
        at: f64,
    ) -> Result<Option<String>, EngineError> {
        let provider = self.permission_provider(store, id)?;
        if let Some(access) = access
            && !offers_of(&provider, capabilities)
                .iter()
                .any(|offer| offer.mode == access)
        {
            return Ok(Some("permission_mode_unsupported".to_owned()));
        }
        if storage::read(store, id)?.parent.is_some()
            && let Some(access) = access
        {
            let offers = offers_of(&provider, capabilities);
            let contained = self.permission_contained(
                store,
                id,
                &provider,
                Some(access.to_owned()),
                &offers,
                0,
            );
            match contained {
                Ok(mode) if mode.as_deref() == Some(access) => {}
                _ => return Ok(Some("permission_ceiling_unverifiable".to_owned())),
            }
        }
        storage::ensure(store, id, None)?;
        store.atomic(|_| {
            stmt_cache::run(
                store.conn(),
                UPDATE_OVERRIDE,
                vec![text_cell(access), Cell::Text(id.to_owned())],
            )?;
            let mut state = storage::state(store, id)?;
            state.pending = true;
            let events = permission_event(&state);
            store.write_events(id, &events, at)
        })?;
        self.permissions.bump(id);
        Ok(None)
    }

    /// `Permissions.resolve`: what the thread runs next.
    pub fn permission_resolve(
        &mut self,
        store: &EngineStore,
        id: &str,
        defaults: &AccessDefaults,
        native_capabilities: Option<&Value>,
    ) -> Result<ResolvedAccess, EngineError> {
        let provider = self.permission_provider(store, id)?;
        let revision = self.permission_revision(id);
        let capabilities = native_capabilities.cloned().or_else(|| {
            thread_facts(store, id)
                .ok()
                .flatten()
                .and_then(|facts| facts.capabilities)
        });
        let offers = offers_of(&provider, capabilities.as_ref());
        let mut wanted = None;
        let mut selection = if let Some(custom) = defaults.custom.as_deref()
            && supports_permission_mode(capabilities.as_ref(), Some(custom))
        {
            Some(custom_selection(custom))
        } else if offers.is_empty() {
            None
        } else {
            let override_value = storage::read(store, id)?.override_mode;
            let requested = override_value
                .as_deref()
                .filter(|value| crate::access::modes::is_access_mode(value))
                .unwrap_or(defaults.access.as_str());
            wanted = Some(requested.to_owned());
            let offer = nearest_offer(requested, &offers).ok_or_else(|| {
                AccessError::new(
                    "access_mode_unavailable",
                    format!("{provider} offers no access mode"),
                )
            })?;
            Some(offer.mode.clone())
        };
        selection = self.permission_contained(store, id, &provider, selection, &offers, 0)?;
        let native = native_for(selection.as_deref(), &offers);
        Ok(ResolvedAccess {
            selection,
            native,
            wanted,
            revision,
        })
    }

    /// `Permissions.applied`: record the mode a live session runs.
    pub fn permission_applied(
        &mut self,
        store: &EngineStore,
        id: &str,
        selection: Option<&str>,
        at: f64,
    ) -> Result<(), EngineError> {
        let provider = self.permission_provider(store, id)?;
        let offers = self.permission_offers(store, id, &provider)?;
        let mode = self.permission_contained(
            store,
            id,
            &provider,
            selection.map(str::to_owned),
            &offers,
            0,
        )?;
        storage::ensure(store, id, None)?;
        self.permission_write_effective(store, id, mode.as_deref(), at)
    }

    /// `Permissions.observed`: record what the live session reports, exactly.
    pub fn permission_observed(
        &mut self,
        store: &EngineStore,
        id: &str,
        selection: Option<&str>,
        at: f64,
    ) -> Result<(), EngineError> {
        storage::ensure(store, id, None)?;
        self.permission_write_effective(store, id, selection, at)
    }

    /// `Permissions.adopted`: the agent switched its own mode.
    pub fn permission_adopted(
        &mut self,
        store: &EngineStore,
        id: &str,
        selection: Option<&str>,
        at: f64,
    ) -> Result<(), EngineError> {
        let kept = selection.filter(|value| crate::access::modes::is_access_mode(value));
        storage::ensure(store, id, None)?;
        store.atomic(|_| {
            stmt_cache::run(
                store.conn(),
                UPDATE_BOTH,
                vec![
                    text_cell(kept),
                    text_cell(selection),
                    Cell::Text(id.to_owned()),
                ],
            )?;
            let state = storage::state(store, id)?;
            store.write_events(id, &permission_event(&state), at)
        })?;
        self.permissions.bump(id);
        Ok(())
    }

    /// `Permissions.unhonoured`: the choice a session couldn't run, when it is still current.
    pub fn permission_unhonoured(
        &mut self,
        store: &EngineStore,
        id: &str,
        running: Option<&str>,
        at: f64,
        revision: u64,
    ) -> Result<Option<String>, EngineError> {
        if revision != self.permission_revision(id) {
            return Ok(None);
        }
        let requested = storage::read(store, id)?.override_mode;
        let Some(requested) = requested
            .filter(|value| crate::access::modes::is_access_mode(value))
            .filter(|value| Some(value.as_str()) != running)
            .filter(|_| custom_native(running).is_none())
        else {
            return Ok(None);
        };
        let kept = running.filter(|value| crate::access::modes::is_access_mode(value));
        store.atomic(|_| {
            stmt_cache::run(
                store.conn(),
                UPDATE_OVERRIDE,
                vec![text_cell(kept), Cell::Text(id.to_owned())],
            )?;
            let state = storage::state(store, id)?;
            store.write_events(id, &permission_event(&state), at)
        })?;
        Ok(Some(requested))
    }

    /// `Permissions.appliedNative`: a provider acknowledged a native selector.
    pub fn permission_applied_native(
        &mut self,
        store: &EngineStore,
        id: &str,
        native: Option<&str>,
        capabilities: Option<&Value>,
        at: f64,
    ) -> Result<(), EngineError> {
        let provider = self.permission_provider(store, id)?;
        let offer = offers_of(&provider, capabilities)
            .into_iter()
            .find(|offer| Some(offer.native.as_str()) == native);
        let selection = match (offer, native) {
            (Some(offer), _) => Some(offer.mode),
            (None, None) => None,
            (None, Some(native)) => Some(custom_selection(native)),
        };
        self.permission_applied(store, id, selection.as_deref(), at)
    }

    /// `Permissions.validateIdentity`: a selection must be contained as stored.
    pub fn permission_validate_identity(
        &mut self,
        store: &EngineStore,
        id: &str,
        selection: Option<&str>,
    ) -> Result<(), EngineError> {
        if !self.permission_within(store, id, selection)? {
            return Err(EngineError::Records(
                "permission_ceiling_unverifiable".to_owned(),
            ));
        }
        Ok(())
    }

    fn permission_write_effective(
        &mut self,
        store: &EngineStore,
        id: &str,
        selection: Option<&str>,
        at: f64,
    ) -> Result<(), EngineError> {
        store.atomic(|_| {
            stmt_cache::run(
                store.conn(),
                UPDATE_EFFECTIVE,
                vec![text_cell(selection), Cell::Text(id.to_owned())],
            )?;
            let state = storage::state(store, id)?;
            store.write_events(id, &permission_event(&state), at)
        })
    }

    /// `Permissions.acceptNative`: `thread.mode.set`.
    pub fn permission_accept_native(
        &mut self,
        store: &EngineStore,
        command: &Value,
        capabilities: Option<&Value>,
        at: f64,
    ) -> Result<Option<Value>, EngineError> {
        let payload = command.get("payload").unwrap_or(&Value::Null);
        if payload.get("type").and_then(Value::as_str) != Some("thread.mode.set") {
            return Ok(None);
        }
        let id = payload
            .get("threadId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let command_id = command
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if self.repo.state(store, id)?.is_none() {
            return Ok(Some(command_result(
                command_id,
                false,
                Some("thread_not_found"),
                id,
            )));
        }
        let provider = self.permission_provider(store, id)?;
        let mode = payload.get("mode").and_then(Value::as_str);
        let offer = offers_of(&provider, capabilities)
            .into_iter()
            .find(|offer| Some(offer.native.as_str()) == mode);
        let error = match offer {
            Some(offer) => self.permission_set(store, id, Some(&offer.mode), capabilities, at)?,
            None => Some("permission_mode_unsupported".to_owned()),
        };
        Ok(Some(command_result(
            command_id,
            error.is_none(),
            error.as_deref(),
            id,
        )))
    }

    /// `Permissions.accept`: `thread.permission.set`.
    pub fn permission_accept(
        &mut self,
        store: &EngineStore,
        command: &Value,
        capabilities: Option<&Value>,
        at: f64,
    ) -> Result<Option<Value>, EngineError> {
        let payload = command.get("payload").unwrap_or(&Value::Null);
        if payload.get("type").and_then(Value::as_str) != Some("thread.permission.set") {
            return Ok(None);
        }
        let id = payload
            .get("threadId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let command_id = command
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if self.repo.state(store, id)?.is_none() {
            return Ok(Some(command_result(
                command_id,
                false,
                Some("thread_not_found"),
                id,
            )));
        }
        let access = payload.get("access").and_then(Value::as_str);
        let error = self.permission_set(store, id, access, capabilities, at)?;
        Ok(Some(command_result(
            command_id,
            error.is_none(),
            error.as_deref(),
            id,
        )))
    }
}

fn command_result(command_id: &str, ok: bool, error: Option<&str>, thread_id: &str) -> Value {
    let mut value = ace_json::Map::new();
    value.insert("commandId", Value::from(command_id));
    value.insert("ok", Value::Bool(ok));
    if let Some(error) = error {
        value.insert("error", Value::from(error));
    }
    value.insert("threadId", Value::from(thread_id));
    Value::Object(value)
}

#[cfg(test)]
mod tests {
    //! `permissions.process.test.ts`: a thread stores its ace mode; stored native Claude modes
    //! map once to ace modes; an unprofiled ACP agent offers no ace mode so choosing one is
    //! refused; a default the provider lacks runs as the nearest stricter mode; an Advanced
    //! native override reads as Custom. `acp-access.process.test.ts`: a native mode asked for by
    //! name can't take a child past its parent; an access choice the agent no longer offers says
    //! so; a session that couldn't take its access mode records the mode it runs instead.

    use super::*;
    use crate::repository::testsupport::{Shell, header, home};

    fn store_with(thread: &str) -> (std::sync::Arc<ace_store::Connection>, EngineStore, State) {
        let conn = home(thread, &header(thread));
        let store = Shell::store(&conn);
        (conn, store, State::default())
    }

    fn store_with_provider(
        thread: &str,
        provider: &str,
    ) -> (std::sync::Arc<ace_store::Connection>, EngineStore, State) {
        let header = header(thread).replace(
            "\"provider\":\"codex\"",
            &format!("\"provider\":\"{provider}\""),
        );
        let conn = home(thread, &header);
        let store = Shell::store(&conn);
        (conn, store, State::default())
    }

    fn defaults(access: &str) -> AccessDefaults {
        AccessDefaults {
            access: access.to_owned(),
            custom: None,
        }
    }

    #[test]
    fn a_thread_stores_its_ace_mode_and_an_accepted_choice_reads_pending() {
        let (_conn, store, mut state) = store_with("perm");
        let first = state.permission_ensure(&store, "perm").expect("ensure");
        assert_eq!(first.override_mode, None);
        assert!(!first.pending);
        let capabilities = ace_json::parse("{}").unwrap();
        assert_eq!(
            state
                .permission_set(
                    &store,
                    "perm",
                    Some("full-access"),
                    Some(&capabilities),
                    1.0
                )
                .expect("set"),
            None
        );
        let stored = state.permission_state(&store, "perm").expect("state");
        assert_eq!(stored.override_mode.as_deref(), Some("full-access"));
        assert_eq!(stored.effective, None);
        assert!(stored.pending);
        assert_eq!(state.permission_revision("perm"), 1);
    }

    #[test]
    fn an_unprofiled_acp_thread_offers_no_ace_mode_so_choosing_one_is_refused() {
        let (_conn, store, mut state) = store_with("acp");
        let capabilities = ace_json::parse(r#"{"accessModes":[]}"#).unwrap();
        assert_eq!(
            state
                .permission_set(&store, "acp", Some("read-only"), Some(&capabilities), 1.0)
                .expect("set"),
            Some("permission_mode_unsupported".to_owned())
        );
        assert_eq!(
            state
                .permission_state(&store, "acp")
                .expect("state")
                .override_mode,
            None
        );
    }

    #[test]
    fn a_default_the_provider_lacks_runs_as_the_nearest_stricter_mode_it_supports() {
        let (_conn, store, mut state) = store_with_provider("opencode", "opencode");
        let offers = crate::access::offers_of("opencode", None);
        assert_eq!(
            nearest_offer("auto-review", &offers).map(|offer| offer.mode.as_str()),
            Some("ask")
        );
        let resolved = state
            .permission_resolve(&store, "opencode", &defaults("auto-review"), None)
            .expect("resolve");
        // OpenCode has no native reviewer: the person's Auto review runs as Ask, never looser.
        assert_eq!(resolved.selection.as_deref(), Some("ask"));
        assert_eq!(resolved.wanted.as_deref(), Some("auto-review"));
        assert_eq!(resolved.native.as_deref(), Some("build+ask"));
    }

    #[test]
    fn an_advanced_native_override_runs_instead_of_the_ace_mode_and_reads_as_custom() {
        let (_conn, store, mut state) = store_with("custom");
        let capabilities = ace_json::parse("{}").unwrap();
        let resolved = state
            .permission_resolve(
                &store,
                "custom",
                &AccessDefaults {
                    access: "full-access".to_owned(),
                    custom: Some("dontAsk".to_owned()),
                },
                Some(&capabilities),
            )
            .expect("resolve");
        assert_eq!(resolved.selection.as_deref(), Some("custom:dontAsk"));
        assert_eq!(resolved.native.as_deref(), Some("dontAsk"));
        // Reads as Custom, never as one of the four modes.
        let record = PermissionRecord {
            effective: Some("custom:dontAsk".to_owned()),
            ..PermissionRecord::default()
        };
        let shown = storage::permission_state(&record);
        assert_eq!(shown.effective, None);
        assert_eq!(shown.custom.as_deref(), Some("dontAsk"));
    }

    #[test]
    fn the_receipts_accept_types_apply_native_acknowledgements_and_report_unknown_threads() {
        let (_conn, store, mut state) = store_with_provider("receipts", "claude");
        let capabilities = ace_json::parse("{}").unwrap();
        let set = ace_json::parse(
            r#"{"id":"c1","payload":{"type":"thread.permission.set","threadId":"receipts","access":"full-access"}}"#,
        )
        .unwrap();
        let result = state
            .permission_accept(&store, &set, Some(&capabilities), 1.0)
            .expect("accept")
            .expect("result");
        assert_eq!(result.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            state
                .permission_state(&store, "receipts")
                .expect("state")
                .override_mode
                .as_deref(),
            Some("full-access")
        );
        // A native selector maps through the provider's offers.
        let native = ace_json::parse(
            r#"{"id":"c2","payload":{"type":"thread.mode.set","threadId":"receipts","mode":"plan"}}"#,
        )
        .unwrap();
        let result = state
            .permission_accept_native(&store, &native, Some(&capabilities), 2.0)
            .expect("native")
            .expect("result");
        assert_eq!(result.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            state
                .permission_state(&store, "receipts")
                .expect("state")
                .override_mode
                .as_deref(),
            Some("read-only")
        );
        state
            .permission_applied_native(
                &store,
                "receipts",
                Some("default"),
                Some(&capabilities),
                3.0,
            )
            .expect("applied");
        assert_eq!(
            state
                .permission_state(&store, "receipts")
                .expect("state")
                .effective
                .as_deref(),
            Some("ask")
        );
        let missing = ace_json::parse(
            r#"{"id":"c3","payload":{"type":"thread.permission.set","threadId":"absent","access":"ask"}}"#,
        )
        .unwrap();
        let result = state
            .permission_accept(&store, &missing, Some(&capabilities), 4.0)
            .expect("missing")
            .expect("result");
        assert_eq!(
            result.get("error").and_then(Value::as_str),
            Some("thread_not_found")
        );
    }

    #[test]
    fn a_held_host_mode_is_its_own_effective_mode_and_says_when_it_changed() {
        let (_conn, store, mut state) = store_with("host");
        assert!(
            state
                .permission_hold(&store, "host", "read-only", 1.0)
                .expect("hold")
        );
        assert!(
            !state
                .permission_hold(&store, "host", "read-only", 2.0)
                .expect("again")
        );
        let stored = state.permission_state(&store, "host").expect("state");
        assert_eq!(stored.override_mode.as_deref(), Some("read-only"));
        assert_eq!(stored.effective.as_deref(), Some("read-only"));
    }

    #[test]
    fn an_unhonoured_choice_is_replaced_by_what_runs_unless_a_newer_choice_won() {
        let (_conn, store, mut state) = store_with("unhonoured");
        let capabilities = ace_json::parse("{}").unwrap();
        state
            .permission_set(
                &store,
                "unhonoured",
                Some("auto-review"),
                Some(&capabilities),
                1.0,
            )
            .expect("set");
        // A newer choice exists: the acknowledgement is about an older one.
        assert_eq!(
            state
                .permission_unhonoured(&store, "unhonoured", Some("ask"), 2.0, 0)
                .expect("stale"),
            None
        );
        assert_eq!(
            state
                .permission_unhonoured(&store, "unhonoured", Some("ask"), 2.0, 1)
                .expect("current")
                .as_deref(),
            Some("auto-review")
        );
        let stored = state.permission_state(&store, "unhonoured").expect("state");
        assert_eq!(stored.override_mode.as_deref(), Some("ask"));
        // A Custom native that runs as asked is not rewritten.
        state
            .permission_observed(&store, "unhonoured", Some("custom:plan"), 3.0)
            .expect("observed");
        assert_eq!(
            state
                .permission_unhonoured(&store, "unhonoured", Some("custom:plan"), 4.0, 1)
                .expect("custom"),
            None
        );
    }

    #[test]
    fn an_adopted_mode_is_the_threads_choice_and_a_new_revision() {
        let (_conn, store, mut state) = store_with("adopted");
        let before = state.permission_revision("adopted");
        state
            .permission_adopted(&store, "adopted", Some("ask"), 1.0)
            .expect("adopt");
        let stored = state.permission_state(&store, "adopted").expect("state");
        assert_eq!(stored.override_mode.as_deref(), Some("ask"));
        assert_eq!(stored.effective.as_deref(), Some("ask"));
        assert!(!stored.pending);
        assert_eq!(state.permission_revision("adopted"), before + 1);
    }
}
