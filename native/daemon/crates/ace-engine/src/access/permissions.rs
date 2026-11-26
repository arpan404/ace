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
use std::collections::{HashMap, HashSet};

use crate::access::modes::{
    AccessSelection, Identity, Policy, allowed_child_modes, ceiling_mode, custom_native,
    custom_selection, inherited_permission_mode, native_for, nearest_offer, offers_of,
    permission_within_ceiling, supports_permission_mode,
};
use crate::access::storage::{self, PermissionRecord, PermissionState, permission_event};
use crate::access::{AccessDefaults, AccessError};
use crate::{EngineError, EngineStore, State, ThreadId};

const UPDATE_OVERRIDE: &str = "UPDATE engine_permissions SET override=? WHERE thread_id=?";
const UPDATE_EFFECTIVE: &str = "UPDATE engine_permissions SET effective=? WHERE thread_id=?";
const UPDATE_BOTH: &str = "UPDATE engine_permissions SET override=?, effective=? WHERE thread_id=?";
const UPDATE_PARENT: &str = "UPDATE engine_permissions SET parent=?,ceiling_provider=?,ceiling_mode=?,ceiling_identity=? WHERE thread_id=?";
const CHILDREN: &str = "SELECT thread_id FROM engine_permissions WHERE parent=?";

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

/// Why a child's access was refused, with the modes the target would accept (`CeilingRefusal`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CeilingRefusal {
    pub provider: String,
    pub mode: Option<AccessSelection>,
    pub allowed: Vec<String>,
    /// The request is broader than the parent, or the target doesn't offer it.
    pub reason: &'static str,
    pub offered: Vec<String>,
}

impl CeilingRefusal {
    pub fn to_json(&self) -> Value {
        let mut value = ace_json::Map::new();
        value.insert("provider", Value::from(self.provider.as_str()));
        value.insert(
            "mode",
            self.mode.as_deref().map_or(Value::Null, Value::from),
        );
        value.insert(
            "allowed",
            Value::Array(
                self.allowed
                    .iter()
                    .map(|mode| Value::from(mode.as_str()))
                    .collect::<Vec<_>>()
                    .into(),
            ),
        );
        value.insert("reason", Value::from(self.reason));
        value.insert(
            "offered",
            Value::Array(
                self.offered
                    .iter()
                    .map(|mode| Value::from(mode.as_str()))
                    .collect::<Vec<_>>()
                    .into(),
            ),
        );
        Value::Object(value)
    }
}

/// The thread columns access reads, direct from the row so a fold or a receipt that holds the
/// store never asks a port for its own data.
#[derive(Debug, Clone)]
pub(crate) struct ThreadFacts {
    pub provider: String,
    /// `effectiveCapabilities`, else `capabilities`, from `provider_metadata` or the column.
    pub capabilities: Option<Value>,
    /// The ACP install identity column, when the thread runs an ACP agent.
    pub acp: Option<Value>,
}

pub(crate) fn thread_facts(
    store: &EngineStore,
    id: &str,
) -> Result<Option<ThreadFacts>, EngineError> {
    const THREAD: &str = "SELECT * FROM threads WHERE id=?";
    let Some(row) = stmt_cache::get_row(store.conn(), THREAD, vec![Cell::Text(id.to_owned())])?
    else {
        return Ok(None);
    };
    let Some(provider) = storage::row_text(&row, "provider") else {
        return Ok(None);
    };
    let metadata =
        storage::row_text(&row, "provider_metadata").and_then(|text| ace_json::parse(&text).ok());
    let capabilities = metadata
        .as_ref()
        .and_then(|metadata| {
            metadata
                .get("effectiveCapabilities")
                .or_else(|| metadata.get("capabilities"))
        })
        .cloned()
        .or_else(|| {
            storage::row_text(&row, "capabilities").and_then(|text| ace_json::parse(&text).ok())
        });
    let acp = storage::row_text(&row, "acp").and_then(|text| ace_json::parse(&text).ok());
    Ok(Some(ThreadFacts {
        provider,
        capabilities,
        acp,
    }))
}

fn policy_json(identity: &Identity, mode: Option<&str>) -> Value {
    let mut value = ace_json::Map::new();
    value.insert("provider", Value::from(identity.provider.as_str()));
    if let Some(backend) = &identity.backend {
        value.insert("backend", Value::from(backend.as_str()));
    }
    if let Some(acp) = &identity.acp_agent_id {
        value.insert("acpAgentId", Value::from(acp.as_str()));
    }
    if let Some(installation) = &identity.installation_id {
        value.insert("installationId", Value::from(installation.as_str()));
    }
    if let Some(instance) = &identity.instance_id {
        value.insert("instanceId", Value::from(instance.as_str()));
    }
    if let Some(mode) = mode {
        value.insert("mode", Value::from(mode));
    }
    Value::Object(value)
}

fn policy_from_json(value: &Value) -> Result<Policy, EngineError> {
    let provider = value
        .get("provider")
        .and_then(Value::as_str)
        .ok_or_else(|| EngineError::Records("Invalid permission policy identity".to_owned()))?;
    let identity = Identity {
        provider: provider.to_owned(),
        backend: value
            .get("backend")
            .and_then(Value::as_str)
            .map(str::to_owned),
        acp_agent_id: value
            .get("acpAgentId")
            .and_then(Value::as_str)
            .map(str::to_owned),
        installation_id: value
            .get("installationId")
            .and_then(Value::as_str)
            .map(str::to_owned),
        instance_id: value
            .get("instanceId")
            .and_then(Value::as_str)
            .map(str::to_owned),
    };
    Ok(Policy::new(
        identity,
        value.get("mode").and_then(Value::as_str),
    ))
}

fn text_cell(value: Option<&str>) -> Cell {
    value.map_or(Cell::Null, |text| Cell::Text(text.to_owned()))
}

impl State {
    fn permission_provider(
        &mut self,
        store: &EngineStore,
        id: &str,
    ) -> Result<String, EngineError> {
        let snapshot = self.repo.require_state(store, id)?;
        Ok(snapshot.borrow().state.config.provider.clone())
    }

    fn permission_offers(
        &mut self,
        store: &EngineStore,
        id: &str,
        provider: &str,
    ) -> Result<Vec<crate::access::Offer>, EngineError> {
        let capabilities = thread_facts(store, id)?.and_then(|facts| facts.capabilities);
        Ok(offers_of(provider, capabilities.as_ref()))
    }

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

    /// `Permissions.identity`: the policy identity a thread's session runs under.
    fn permission_identity(
        &mut self,
        store: &EngineStore,
        id: &str,
        provider: &str,
    ) -> Result<Identity, EngineError> {
        let facts = thread_facts(store, id)?
            .ok_or_else(|| EngineError::Records("permission_thread_not_found".to_owned()))?;
        let session = crate::sessions::metadata::session(store, id)?;
        let backend = self.backend(store, id)?;
        if provider == "acp" {
            let text = |key: &str| {
                facts
                    .acp
                    .as_ref()
                    .and_then(|acp| acp.get(key))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            };
            let instance = session.instance_id.or_else(|| text("instanceId"));
            Ok(Identity {
                provider: "acp".to_owned(),
                backend,
                acp_agent_id: text("acpAgentId"),
                installation_id: text("installationId"),
                instance_id: instance,
            })
        } else {
            Ok(Identity {
                provider: provider.to_owned(),
                backend,
                acp_agent_id: None,
                installation_id: None,
                instance_id: Some(
                    session
                        .instance_id
                        .unwrap_or_else(|| format!("{provider}-cli-default")),
                ),
            })
        }
    }

    /// `Permissions.ceilingSelection`: a thread's own mode for its children, the stricter side of
    /// a pending change.
    fn permission_ceiling_selection(
        &mut self,
        store: &EngineStore,
        id: &str,
    ) -> Result<Option<String>, EngineError> {
        let record = storage::read(store, id)?;
        Ok(ceiling_mode(
            record.effective.as_deref(),
            record.override_mode.as_deref(),
        ))
    }

    /// `Permissions.contained`: `selected` within the thread's ancestry.
    fn permission_contained(
        &mut self,
        store: &EngineStore,
        id: &str,
        provider: &str,
        selected: Option<AccessSelection>,
        offers: &[crate::access::Offer],
        depth: u32,
    ) -> Result<Option<AccessSelection>, EngineError> {
        let record = storage::read(store, id)?;
        let Some(parent) = record.parent.as_deref() else {
            return Ok(selected);
        };
        if depth >= 64 {
            return Err(EngineError::Records(
                "Permission ancestry exceeds capacity".to_owned(),
            ));
        }
        let identity = self.permission_identity(store, id, provider)?;
        let ceiling = self.permission_ceiling(store, parent, depth + 1)?;
        let mut mode = selected.clone();
        if !permission_within_ceiling(&ceiling, &Policy::new(identity.clone(), mode.as_deref())) {
            let inherited = inherited_permission_mode(&ceiling, &identity, offers);
            match inherited {
                None => {
                    return Err(EngineError::Records(
                        "permission_ceiling_unverifiable".to_owned(),
                    ));
                }
                Some(mode_inherited) => mode = mode_inherited,
            }
        }
        let ceiling_ok = match record.ceiling_identity.as_deref() {
            None => false,
            Some(text) => {
                let parsed = ace_json::parse(text)
                    .map_err(|error| EngineError::Records(error.to_string()))?;
                let policy = policy_from_json(&parsed)?;
                permission_within_ceiling(
                    &Policy::new(policy.identity, record.ceiling_mode.as_deref()),
                    &Policy::new(identity, mode.as_deref()),
                )
            }
        };
        if !ceiling_ok {
            return Err(EngineError::Records(
                "permission_ceiling_unverifiable".to_owned(),
            ));
        }
        Ok(mode)
    }

    /// `Permissions.ceiling`: the policy `parent`'s children are contained by, its ancestors
    /// included.
    fn permission_ceiling(
        &mut self,
        store: &EngineStore,
        parent: &str,
        depth: u32,
    ) -> Result<Policy, EngineError> {
        let provider = thread_facts(store, parent)?
            .map(|facts| facts.provider)
            .ok_or_else(|| EngineError::Records("permission_parent_not_found".to_owned()))?;
        let identity = self.permission_identity(store, parent, &provider)?;
        let selected = self.permission_ceiling_selection(store, parent)?;
        let offers = self.permission_offers(store, parent, &provider)?;
        let mode = self.permission_contained(store, parent, &provider, selected, &offers, depth)?;
        Ok(Policy::new(identity, mode.as_deref()))
    }

    /// `Permissions.within`: whether `selection` is no broader than the ancestry allows now.
    pub fn permission_within(
        &mut self,
        store: &EngineStore,
        id: &str,
        selection: Option<&str>,
    ) -> Result<bool, EngineError> {
        let provider = self.permission_provider(store, id)?;
        let offers = self.permission_offers(store, id, &provider)?;
        // `within` answers false for a ceiling it cannot verify, so a caller stops the session
        // rather than taking the error out of its frame check.
        match self.permission_contained(
            store,
            id,
            &provider,
            selection.map(str::to_owned),
            &offers,
            0,
        ) {
            Ok(mode) => Ok(mode.as_deref() == selection),
            Err(_) => Ok(false),
        }
    }

    /// `Permissions.descendants`: every thread whose access is contained by `id`'s, nearest first.
    pub fn permission_descendants(
        &mut self,
        store: &EngineStore,
        id: &str,
    ) -> Result<Vec<ThreadId>, EngineError> {
        let mut found = Vec::new();
        let mut seen: HashSet<String> = HashSet::from([id.to_owned()]);
        let mut level = vec![id.to_owned()];
        for _ in 0..64 {
            if level.is_empty() {
                break;
            }
            let mut next = Vec::new();
            for parent in level {
                let rows = stmt_cache::all_rows(store.conn(), CHILDREN, vec![Cell::Text(parent)])?;
                for row in rows {
                    let Some(child) = storage::row_text(&row, "thread_id") else {
                        continue;
                    };
                    if !seen.insert(child.clone()) {
                        continue;
                    }
                    found.push(child.clone());
                    next.push(child);
                }
            }
            level = next;
        }
        Ok(found)
    }

    /// `Permissions.parent`: record a child's ancestry and the ceiling its parent grants.
    pub fn permission_parent(
        &mut self,
        store: &EngineStore,
        child: &str,
        parent: &str,
        _at: f64,
    ) -> Result<(), EngineError> {
        if child == parent {
            return Err(EngineError::Records("Permission ancestry cycle".to_owned()));
        }
        storage::ensure(store, child, None)?;
        let provider = thread_facts(store, parent)?
            .map(|facts| facts.provider)
            .ok_or_else(|| EngineError::Records("permission_parent_not_found".to_owned()))?;
        let identity = self.permission_identity(store, parent, &provider)?;
        let mode = self.permission_ceiling_selection(store, parent)?;
        let encoded = ace_json::to_string(&policy_json(&identity, None));
        store.atomic(|_| {
            let existing = storage::read(store, child)?;
            if let Some(existing_parent) = existing.parent.as_deref()
                && existing_parent != parent
            {
                return Err(EngineError::Records("Permission owner conflict".to_owned()));
            }
            if existing.parent.is_none() {
                stmt_cache::run(
                    store.conn(),
                    UPDATE_PARENT,
                    vec![
                        Cell::Text(parent.to_owned()),
                        Cell::Text(provider.to_owned()),
                        text_cell(mode.as_deref()),
                        Cell::Text(encoded.clone()),
                        Cell::Text(child.to_owned()),
                    ],
                )?;
            }
            Ok(())
        })
    }

    /// `Permissions.hold`: a host thread's mode, its own effective mode at once.
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
    pub fn permission_refusal(
        &mut self,
        store: &EngineStore,
        parent: &str,
        identity: &Identity,
        offers: &[crate::access::Offer],
        requested: Option<&str>,
    ) -> Option<CeilingRefusal> {
        let _ = identity;
        let ceiling = self.permission_ceiling(store, parent, 0).ok()?;
        let allowed = allowed_child_modes(&ceiling, offers);
        let offered: Vec<String> = offers.iter().map(|offer| offer.mode.clone()).collect();
        let reason = match requested {
            Some(requested)
                if requested != "inherit" && !offered.iter().any(|o| o == requested) =>
            {
                "access_unavailable"
            }
            Some(requested) if requested != "inherit" => "access_escalation_denied",
            _ => "permission_ceiling_unverifiable",
        };
        Some(CeilingRefusal {
            provider: ceiling.identity.provider,
            mode: ceiling.mode,
            allowed,
            reason,
            offered,
        })
    }

    /// `Permissions.narrow`: a child's access under `parent`.
    pub fn permission_narrow(
        &mut self,
        store: &EngineStore,
        parent: &str,
        identity: &Identity,
        requested: Option<&str>,
        offers: &[crate::access::Offer],
    ) -> Result<Option<AccessSelection>, EngineError> {
        let ceiling = self.permission_ceiling(store, parent, 0)?;
        let requested = match requested {
            None | Some("inherit") => {
                let inherited = inherited_permission_mode(&ceiling, identity, offers);
                match inherited {
                    None => {
                        return Err(AccessError::new(
                            "permission_ceiling_unverifiable",
                            "no offered mode fits",
                        )
                        .into());
                    }
                    Some(mode) => return Ok(mode),
                }
            }
            Some(requested) => requested,
        };
        if !offers.iter().any(|offer| offer.mode == requested) {
            return Err(AccessError::new(
                "access_unavailable",
                format!("{} doesn't offer {requested}", identity.provider),
            )
            .into());
        }
        if !permission_within_ceiling(&ceiling, &Policy::new(identity.clone(), Some(requested))) {
            return Err(AccessError::new(
                "access_escalation_denied",
                format!("{requested} exceeds the parent"),
            )
            .into());
        }
        Ok(Some(requested.to_owned()))
    }

    /// `Permissions.set`: accept a choice, or say why it can't run.
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

    fn add_thread(conn: &std::sync::Arc<ace_store::Connection>, id: &str, provider: &str) {
        conn.exec(&format!(
            "INSERT INTO threads (id,workspace_id,title,provider,status,created_at,updated_at) \
             VALUES ('{id}','workspace','{id}','{provider}','{{\"state\":\"new\"}}',0,0);
             INSERT INTO thread_state VALUES ('{id}', {}, 0);
             INSERT INTO engine_sessions (thread_id,cwd,instance_id) VALUES ('{id}','/tmp','{provider}-cli-default');",
            crate::repository::testsupport::sql_text(&header(id))
        ))
        .expect("a thread");
    }

    fn mode_of(state: &mut State, store: &EngineStore, id: &str) -> Option<String> {
        state.permission_state(store, id).expect("state").effective
    }

    #[test]
    fn a_child_ceiling_is_its_parents_running_mode_and_its_stored_identity_is_rechecked() {
        let (conn, store, mut state) = store_with("root");
        conn.exec("INSERT INTO engine_sessions (thread_id,cwd,instance_id) VALUES ('root','/tmp','claude-cli-default')")
            .unwrap();
        add_thread(&conn, "child", "claude");
        add_thread(&conn, "grandchild", "claude");
        state.permission_ensure(&store, "root").expect("root row");
        conn.exec(
            "UPDATE engine_permissions SET override='ask',effective='ask' WHERE thread_id='root'",
        )
        .unwrap();
        state
            .permission_parent(&store, "child", "root", 1.0)
            .expect("parent");
        assert_eq!(mode_of(&mut state, &store, "child"), None);
        assert!(
            state
                .permission_within(&store, "child", Some("read-only"))
                .expect("within")
        );
        assert!(
            state
                .permission_within(&store, "child", Some("ask"))
                .expect("within")
        );
        assert!(
            !state
                .permission_within(&store, "child", Some("auto-review"))
                .expect("within")
        );
        assert!(
            !state
                .permission_within(&store, "child", Some("full-access"))
                .expect("within")
        );

        let identity = crate::access::permission_target("claude", None, None, "claude-cli-default")
            .expect("identity");
        let offers = crate::access::offers_of("claude", None);
        assert_eq!(
            state
                .permission_narrow(&store, "root", &identity, Some("inherit"), &offers)
                .expect("inherit")
                .as_deref(),
            Some("ask")
        );
        assert!(matches!(
            state.permission_narrow(&store, "root", &identity, Some("full-access"), &offers),
            Err(EngineError::Access(error)) if error.code == "access_escalation_denied"
        ));
        let refusal = state
            .permission_refusal(&store, "root", &identity, &offers, Some("auto-review"))
            .expect("refusal");
        assert_eq!(refusal.reason, "access_escalation_denied");
        assert_eq!(refusal.allowed, vec!["read-only", "ask"]);
        assert_eq!(
            state
                .permission_descendants(&store, "root")
                .expect("descendants"),
            vec!["child".to_owned()]
        );
        // A deeper level walks its whole ancestry: the child runs Ask, so its own child is
        // contained by Ask through both levels.
        conn.exec(
            "UPDATE engine_permissions SET override='ask',effective='ask' WHERE thread_id='child'",
        )
        .unwrap();
        state
            .permission_parent(&store, "grandchild", "child", 2.0)
            .expect("grandchild");
        assert!(
            state
                .permission_within(&store, "grandchild", Some("read-only"))
                .expect("within")
        );
        assert!(
            !state
                .permission_within(&store, "grandchild", Some("auto-review"))
                .expect("within")
        );

        // The stored ceiling is the second, independent check: a row naming another account is
        // refused even while the parent's own mode would contain the child.
        conn.exec(
            "UPDATE engine_permissions SET ceiling_identity='{\"provider\":\"claude\",\"instanceId\":\"other\"}', ceiling_mode=NULL WHERE thread_id='child'",
        )
        .unwrap();
        assert!(
            !state
                .permission_within(&store, "child", Some("ask"))
                .expect("within")
        );
        assert!(matches!(
            state.permission_validate_identity(&store, "child", Some("ask")),
            Err(EngineError::Records(_))
        ));
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
