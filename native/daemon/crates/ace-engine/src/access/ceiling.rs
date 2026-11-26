// SPDX-License-Identifier: Apache-2.0
//! The ancestry ceiling (`permissions.ts:180`-`:260`): the policy a parent grants its children,
//! the containment walk up to 64 levels, and the stored ceiling a child re-checks. The mode rank
//! and provider tables are `access/modes.rs`; the row is `access/storage.rs`.

use ace_json::Value;
use ace_store::{Value as Cell, stmt_cache};
use std::collections::HashSet;

use crate::access::modes::{
    AccessSelection, Identity, Policy, ceiling_mode, inherited_permission_mode, offers_of,
    permission_within_ceiling,
};
use crate::access::storage;
use crate::{EngineError, EngineStore, State, ThreadId};

const UPDATE_PARENT: &str = "UPDATE engine_permissions SET parent=?,ceiling_provider=?,ceiling_mode=?,ceiling_identity=? WHERE thread_id=?";
const CHILDREN: &str = "SELECT thread_id FROM engine_permissions WHERE parent=?";

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
    let acp = storage::row_text(&row, "acp").and_then(|text| ace_json::parse(&text).ok());
    // `thread-columns.ts:67`: effective capabilities live in the `acp` column; the older
    // `provider_metadata` layout and the cold `capabilities` column stay readable.
    let capabilities = acp
        .as_ref()
        .and_then(|acp| acp.get("effectiveCapabilities"))
        .cloned()
        .or_else(|| {
            metadata
                .as_ref()
                .and_then(|metadata| {
                    metadata
                        .get("effectiveCapabilities")
                        .or_else(|| metadata.get("capabilities"))
                })
                .cloned()
        })
        .or_else(|| {
            storage::row_text(&row, "capabilities").and_then(|text| ace_json::parse(&text).ok())
        });
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
    if !identity.valid() {
        return Err(EngineError::Records(
            "permission_ceiling_unverifiable".to_owned(),
        ));
    }
    Ok(Policy::new(
        identity,
        value.get("mode").and_then(Value::as_str),
    ))
}

fn text_cell(value: Option<&str>) -> Cell {
    value.map_or(Cell::Null, |text| Cell::Text(text.to_owned()))
}

impl State {
    pub(crate) fn permission_provider(
        &mut self,
        store: &EngineStore,
        id: &str,
    ) -> Result<String, EngineError> {
        let snapshot = self.repo.require_state(store, id)?;
        Ok(snapshot.borrow().state.config.provider.clone())
    }

    pub(crate) fn permission_offers(
        &mut self,
        store: &EngineStore,
        id: &str,
        provider: &str,
    ) -> Result<Vec<crate::access::Offer>, EngineError> {
        let capabilities = thread_facts(store, id)?.and_then(|facts| facts.capabilities);
        Ok(offers_of(provider, capabilities.as_ref()))
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
        .and_then(|identity| {
            // An ACP identity without its install fields cannot be ranked or compared.
            if identity.valid() {
                Ok(identity)
            } else {
                Err(EngineError::Records(
                    "permission_ceiling_unverifiable".to_owned(),
                ))
            }
        })
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
    pub(crate) fn permission_contained(
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
    pub(crate) fn permission_ceiling(
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
}

#[cfg(test)]
mod tests {
    //! `permissions.process.test.ts` and `acp-access.process.test.ts`'s ceiling cases: a child
    //! is contained by its parent, an explicit request cannot exceed it, a stored ceiling is
    //! rechecked independently, and the walk covers every ancestor.

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
    fn an_acp_identity_without_its_install_fields_fails_the_ceiling() {
        let (conn, store, mut state) = store_with_provider("acp-child", "acp");
        conn.exec(
            "INSERT INTO engine_sessions (thread_id,cwd,instance_id) VALUES ('acp-child','/tmp','one:default');
             UPDATE threads SET provider='acp', acp='{}' WHERE id='acp-child';
             INSERT INTO engine_permissions VALUES ('acp-child',NULL,NULL,'missing', 'acp',NULL,'{\"provider\":\"acp\"}');",
        )
        .expect("an unverifiable ACP row");
        // The live identity and the stored ceiling both fail validation, so within is false and
        // a refusal never takes the unranked comparison as containment.
        assert!(
            !state
                .permission_within(&store, "acp-child", None)
                .expect("within")
        );
        assert!(matches!(
            state.permission_validate_identity(&store, "acp-child", None),
            Err(EngineError::Records(_))
        ));
    }

    #[test]
    fn a_profile_reported_access_mode_is_read_from_the_acp_column() {
        let (conn, store, mut state) = store_with_provider("acp-profile", "acp");
        conn.exec(
            "INSERT INTO engine_sessions (thread_id,cwd,instance_id) VALUES ('acp-profile','/tmp','one:default');
             UPDATE threads SET provider='acp', acp='{\"effectiveCapabilities\":{\"accessModes\":[{\"mode\":\"read-only\",\"native\":\"plan\"}],\"permissions\":{\"modes\":[\"plan\"],\"nativeAutoReview\":false,\"toolGate\":true}}}' WHERE id='acp-profile';",
        )
        .expect("reported capabilities");
        let offers = state
            .permission_offers(&store, "acp-profile", "acp")
            .expect("offers");
        assert_eq!(
            offers
                .iter()
                .map(|offer| offer.mode.as_str())
                .collect::<Vec<_>>(),
            vec!["read-only"]
        );
    }
}
