// SPDX-License-Identifier: Apache-2.0
//! `models.ts`, `selection-notices.ts` and `provider-command-metadata.ts`: one selection boundary
//! for creation, resume, switches and legacy controls, the transcript lines a refused access or
//! option leaves, and the provider frames that carry a command list. The catalog itself is
//! `ace-models`; the engine asks it through [`ModelCatalog`] and never duplicates discovery.
//!
//! Moved cases: `model-selection.process.test.ts` (the selection, refusal and notice halves).

use ace_adapter_api::Frame;
use ace_json::Value;
use ace_models::search::is_default_selection;
use ace_protocol::generated::{
    AcpIdentity, Capabilities, CatalogModel, ExecutionSelection, NativePermissionMode, ProviderKind,
};

use crate::EngineError;

/// `ModelSelectionError`: a named model the provider's catalog does not offer.
pub const MODEL_UNAVAILABLE: &str = "model_unavailable";

/// The selection a role resolves to, or why none does. The row is boxed: a resolved model is a
/// whole catalogue row, many times a refusal.
#[derive(Debug, Clone)]
pub enum ModelResolution {
    Resolved {
        model: Box<CatalogModel>,
        effort: Option<String>,
    },
    Unavailable {
        reason: String,
    },
}

/// What the engine asks the catalog for: the thread boundary's role, the account's filter and the
/// model asked for, when one was.
#[derive(Debug, Clone, PartialEq)]
pub struct ModelSpec {
    pub role: String,
    pub model: Option<String>,
    pub filter: ModelFilter,
}

/// One account's slice of the catalog: the identity fields plus the provider and instance.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ModelFilter {
    pub provider: Option<ProviderKind>,
    pub instance: Option<String>,
    pub acp_agent_id: Option<String>,
    pub installation_id: Option<String>,
}

/// What the engine needs from `@ace/models`' catalogue (`ModelCatalogApi`).
pub trait ModelCatalog {
    fn resolve(&self, spec: &ModelSpec) -> ModelResolution;
    /// Resolve a retained choice without scheduling discovery.
    fn resolve_cached(&self, _spec: &ModelSpec) -> Option<ModelResolution> {
        None
    }
    /// Ask discovery for the account the filter names; resolves once it answered.
    fn refresh(
        &self,
        _filter: &ModelFilter,
    ) -> crate::futures::future::LocalBoxFuture<'static, ()> {
        Box::pin(async {})
    }
    /// The modes the account's catalogue knows, or `None` while it knows none: an agent that has
    /// not reported its session modes yet is unknown, not one that offers nothing.
    fn permission_modes(
        &self,
        _provider: &str,
        _instance: Option<&str>,
    ) -> Option<Vec<NativePermissionMode>> {
        None
    }
    fn update_permission_modes(&self, _instance: &str, _modes: &[NativePermissionMode]) {}
}

/// `selectionModelFilter`: execution without an account means the native CLI, never an arbitrary
/// account. ACP's catalogue IDs are opaque; its source-qualified identity selects the rows.
pub fn selection_model_filter(
    provider: &str,
    instance: Option<&str>,
    identity: Option<&AcpIdentity>,
) -> Option<ModelFilter> {
    if provider == "acp" {
        let identity = identity?;
        return Some(ModelFilter {
            provider: provider_kind(provider),
            instance: Some(identity.instance_id.0.clone()),
            acp_agent_id: Some(identity.acp_agent_id.0.clone()),
            installation_id: Some(identity.installation_id.0.clone()),
        });
    }
    Some(ModelFilter {
        provider: provider_kind(provider),
        instance: Some(
            instance
                .map(str::to_owned)
                .unwrap_or_else(|| format!("{provider}-cli-default")),
        ),
        acp_agent_id: None,
        installation_id: None,
    })
}

/// The protocol's provider kind for a name, when it is one.
fn provider_kind(provider: &str) -> Option<ProviderKind> {
    provider.parse().ok()
}

/// `executionModelId`: the model id a provider launches with. OpenCode rows already hold
/// `provider/model`; Pi and custom upstream rows hold the bare id beside their upstream provider,
/// which is prefixed exactly once.
pub fn execution_model_id(model: &CatalogModel) -> String {
    let native = model.native_model_id.as_str();
    match model.native_provider_id.as_deref() {
        Some(provider) if !provider.is_empty() => {
            let prefix = format!("{provider}/");
            if native.starts_with(&prefix) {
                native.to_owned()
            } else {
                format!("{prefix}{native}")
            }
        }
        _ => native.to_owned(),
    }
}

/// The engine's model boundary.
/// `onModelUnavailable(provider, model, instance)`: told when a named model was refused.
pub type RejectedModel<'a> = &'a dyn Fn(&str, &str, Option<&str>);

pub struct EngineModels<'a> {
    catalog: Option<&'a dyn ModelCatalog>,
    rejected: Option<RejectedModel<'a>>,
}

impl<'a> EngineModels<'a> {
    pub fn new(
        catalog: Option<&'a dyn ModelCatalog>,
        rejected: Option<RejectedModel<'a>>,
    ) -> EngineModels<'a> {
        EngineModels { catalog, rejected }
    }

    /// `select`: the model id the provider launches with, `None` for the default, or
    /// `MODEL_UNAVAILABLE` for a named model the catalog does not offer.
    pub fn select(
        &self,
        provider: &str,
        model: Option<&str>,
        instance: Option<&str>,
        identity: Option<&AcpIdentity>,
    ) -> Result<Option<String>, &'static str> {
        let Some(catalog) = self.catalog else {
            return Ok(model
                .filter(|model| !is_default_selection(Some(model)))
                .map(str::to_owned));
        };
        let filter = selection_model_filter(provider, instance, identity);
        let named = model.filter(|model| !is_default_selection(Some(model)));
        let Some(filter) = filter else {
            if let Some(model) = named {
                self.reject(provider, model, instance);
                return Err(MODEL_UNAVAILABLE);
            }
            return Ok(None);
        };
        let resolution = catalog.resolve(&ModelSpec {
            role: "thread".to_owned(),
            model: named.map(str::to_owned),
            filter,
        });
        match resolution {
            ModelResolution::Resolved { model, .. } => Ok(Some(execution_model_id(model.as_ref()))),
            ModelResolution::Unavailable { .. } => {
                if let Some(model) = named {
                    self.reject(provider, model, instance);
                    return Err(MODEL_UNAVAILABLE);
                }
                Ok(None)
            }
        }
    }

    fn reject(&self, provider: &str, model: &str, instance: Option<&str>) {
        if let Some(rejected) = self.rejected {
            rejected(provider, model, instance);
        }
    }

    /// `knownPermissionCapabilities`: the instance's modes as its catalog knows them, with the
    /// access modes it offers, folded into the provider's capabilities.
    pub fn known_permission_capabilities(
        &self,
        provider: &str,
        instance: Option<&str>,
        base: &Capabilities,
    ) -> Option<Capabilities> {
        let modes = self.catalog?.permission_modes(provider, instance)?;
        if modes.is_empty() || base.permissions.is_none() {
            return None;
        }
        let mut next = base.clone();
        next.permission_modes = modes.clone();
        let permissions = next.permissions.as_mut()?;
        permissions.permission_modes = modes.clone();
        permissions.modes = modes.iter().map(|mode| mode.id.clone()).collect();
        Some(next)
    }

    /// `permissionCapabilities`: the catalog's modes when it knows them, else the base.
    pub fn permission_capabilities(
        &self,
        provider: &str,
        instance: Option<&str>,
        base: &Capabilities,
    ) -> Capabilities {
        self.known_permission_capabilities(provider, instance, base)
            .unwrap_or_else(|| base.clone())
    }

    /// `permissions`: a session that reported its modes teaches the catalog them.
    pub fn permissions(&self, instance: Option<&str>, capabilities: &Capabilities) {
        if let (Some(instance), Some(catalog)) = (instance, self.catalog)
            && !capabilities.permission_modes.is_empty()
        {
            catalog.update_permission_modes(instance, &capabilities.permission_modes);
        }
    }

    /// `prepare`: the choice an admit resolves before the provider opens. Defaults are filled
    /// from the catalog's effort, and a Cursor selection carries the SDK's own parameters.
    pub async fn prepare(
        &self,
        selection: ExecutionSelection,
        identity: Option<&AcpIdentity>,
    ) -> Result<ExecutionSelection, &'static str> {
        let provider = provider_name(selection.provider);
        let default_requested = selection
            .model
            .as_deref()
            .is_none_or(|model| is_default_selection(Some(model)));
        let instance = selection.instance_id.as_deref().map(String::as_str);
        let filter = selection_model_filter(&provider, instance, identity);
        if default_requested
            && let (Some(catalog), Some(filter)) = (self.catalog, filter.as_ref())
            && self.select(&provider, None, instance, identity)?.is_none()
        {
            catalog.refresh(filter).await;
        }
        let model = self.select(
            &provider,
            selection.model.as_deref().map(String::as_str),
            instance,
            identity,
        )?;
        let resolved = match (self.catalog, filter.as_ref(), model.as_deref()) {
            (Some(catalog), Some(filter), Some(model)) => catalog.resolve(&ModelSpec {
                role: "thread".to_owned(),
                model: Some(model.to_owned()),
                filter: filter.clone(),
            }),
            _ => ModelResolution::Unavailable {
                reason: "no catalogue".to_owned(),
            },
        };
        let effort = match &resolved {
            ModelResolution::Resolved { effort, .. } => effort.clone(),
            ModelResolution::Unavailable { .. } => None,
        };
        let mut options = selection.options.0;
        if options.get("effort").is_none()
            && let Some(effort) = effort
        {
            options.insert("effort".to_owned(), serde_json::Value::String(effort));
        }
        if provider != "cursor" {
            options.remove("cursorModelParams");
        }
        Ok(ExecutionSelection {
            instance_id: selection.instance_id,
            model: model.map(Into::into),
            options: ace_protocol::generated::ExecutionOptions(options),
            provider: selection.provider,
        })
    }
}

/// The provider's name, as the catalog compares it.
pub fn provider_name(provider: ProviderKind) -> String {
    provider.to_string()
}

/// `selection-notices.ts`: the transcript line for an access choice the session couldn't run.
pub fn unhonoured_access_notice(
    agent: &str,
    at: f64,
    requested: &str,
    running: Option<&str>,
) -> Value {
    let label = access_label(requested);
    let runs = match running {
        None => "its own default".to_owned(),
        Some(mode) => mode.to_owned(),
    };
    notice(
        agent,
        &format!("access-unavailable:{at}"),
        "warning",
        "access_mode_unavailable",
        format!("This agent doesn't offer {label}, so it runs with {runs}."),
    )
}

fn access_label(mode: &str) -> String {
    match mode {
        "read-only" => "Read-only".to_owned(),
        "ask" => "Ask".to_owned(),
        "auto-review" => "Auto review".to_owned(),
        "full-access" => "Full access".to_owned(),
        other => other.to_owned(),
    }
}

/// The transcript line for launch options the provider didn't take; it runs its defaults.
pub fn refused_options_notice(agent: &str, at: f64, dropped: &[(String, Value)]) -> Value {
    let named: Vec<String> = dropped
        .iter()
        .map(|(key, value)| {
            if key == "effort" {
                format!("the {} thinking level", plain(value))
            } else {
                format!("{key} {}", plain(value))
            }
        })
        .collect();
    notice(
        agent,
        &format!("options-refused:{at}"),
        "info",
        "execution_option_refused",
        format!(
            "This agent didn't take {}, so it runs at its default.",
            named.join(" or ")
        ),
    )
}

/// The transcript line for a live session stopped because its parent's access tightened.
pub fn ceiling_stopped_notice(agent: &str, at: f64) -> Value {
    notice(
        agent,
        &format!("access-ceiling-stopped:{at}"),
        "warning",
        "access_ceiling_stopped",
        "Stopped: its parent's access changed, and this agent can't run with anything that strict."
            .to_owned(),
    )
}

fn notice(agent: &str, item: &str, level: &str, code: &str, text: String) -> Value {
    ace_json::json!({
        "type": "item.upsert",
        "agent": agent,
        "item": item,
        "draft": {"type": "notice", "level": level, "code": code, "text": text, "complete": true},
    })
}

/// `String(value)` for a notice's option value, as JavaScript prints it.
fn plain(value: &Value) -> String {
    match value {
        Value::String(text) => text.as_str().to_owned(),
        Value::Bool(true) => "true".to_owned(),
        Value::Bool(false) => "false".to_owned(),
        Value::Null => "null".to_owned(),
        Value::Number(number) => number.value().to_string(),
        other => ace_json::to_string(other),
    }
}

/// `provider-command-metadata.ts`: the provider frames that carry a command list. Deltas and
/// retained transcript bodies never enter command discovery.
pub fn provider_command_metadata(
    frame: &Frame,
    harness: impl Fn(&str, &Value, Option<&str>) -> Option<Value>,
) -> Option<Value> {
    if frame.dir != ace_adapter_api::FrameDirection::Recv
        && frame.dir != ace_adapter_api::FrameDirection::Note
    {
        return None;
    }
    let data = frame.data.view().to_value();
    if frame.channel == "catalog.runtime"
        && data.get("type").and_then(Value::as_str) == Some("catalog.runtime")
    {
        let method = data.get("method").and_then(Value::as_str)?;
        let result = data.get("result")?;
        let cwd = data.get("cwd").and_then(Value::as_str);
        return harness(method, result, cwd).map(|catalog| {
            ace_json::json!({
                "group": method.replace(|c: char| !c.is_alphanumeric() && c != '_' && c != '-', "-"),
                "catalog": catalog,
            })
        });
    }
    if frame.channel == "commands.runtime" {
        return Some(data);
    }
    if frame.channel != "sdk" && frame.channel != "stdio" {
        return None;
    }
    if frame.channel == "stdio"
        && data.get("type").and_then(Value::as_str) == Some("response")
        && data.get("command").and_then(Value::as_str) == Some("get_commands")
        && data.get("success") == Some(&Value::Bool(true))
        && let Some(commands) = data
            .get("data")
            .and_then(|data| data.get("commands"))
            .and_then(Value::as_array)
    {
        let control = ["ace-context", "ace-rollback", "ace-permissions"];
        let available: Vec<Value> = commands
            .iter()
            .filter(|command| {
                command
                    .get("name")
                    .and_then(Value::as_str)
                    .is_none_or(|name| !control.contains(&name))
            })
            .cloned()
            .collect();
        return Some(ace_json::json!({
            "sessionUpdate": "available_commands_update",
            "availableCommands": available,
        }));
    }
    let subtype = data.get("subtype").and_then(Value::as_str);
    if data.get("type").and_then(Value::as_str) == Some("system")
        && subtype == Some("commands_changed")
        && data
            .get("commands")
            .is_some_and(|list| list.as_array().is_some())
    {
        return Some(ace_json::json!({
            "type": "system",
            "subtype": "init",
            "slash_commands": data.get("commands").cloned().unwrap_or(Value::Null),
        }));
    }
    if data.get("type").and_then(Value::as_str) == Some("system")
        && subtype == Some("init")
        && data
            .get("slash_commands")
            .is_some_and(|list| list.as_array().is_some())
    {
        return Some(data);
    }
    if data.get("method").and_then(Value::as_str) == Some("session/update")
        && data
            .get("params")
            .and_then(|params| params.get("update"))
            .and_then(|update| update.get("sessionUpdate"))
            .and_then(Value::as_str)
            == Some("available_commands_update")
    {
        return data
            .get("params")
            .and_then(|params| params.get("update"))
            .cloned();
    }
    None
}

impl crate::State {
    /// `EngineModels.remember` (`models.ts:139`): the choice a confirmed selection keeps. The
    /// session row, the per-model option, the transition metadata, the agent's model fact and the
    /// `thread.updated` event all land in the caller's transaction.
    pub fn remember_selection(
        &mut self,
        store: &crate::EngineStore,
        id: &str,
        selection: &ExecutionSelection,
        at: f64,
    ) -> Result<(), EngineError> {
        let json = ace_json::ser::to_string(selection)
            .map_err(|error| EngineError::Records(error.to_string()))?;
        let selection_json: Value =
            ace_json::parse(&json).map_err(|error| EngineError::Records(error.to_string()))?;
        let provider = provider_name(selection.provider);
        let previous = self.transition_get(store, id)?;
        let session = crate::sessions::metadata::session(store, id)?;
        let mut old_models: Vec<Option<String>> = vec![session.model.clone()];
        if let Some(previous) = previous
            .selection
            .as_ref()
            .and_then(|selection| selection.get("model"))
            .and_then(Value::as_str)
        {
            old_models.push(Some(previous.to_owned()));
        }
        old_models.dedup();
        store.atomic(|tx| {
            for model in old_models {
                if is_default_selection(model.as_deref()) {
                    ace_store::stmt_cache::run(
                        tx.conn(),
                        "DELETE FROM engine_model_options WHERE thread_id=? AND provider=? AND model=?",
                        vec![
                            ace_store::Value::Text(id.to_owned()),
                            ace_store::Value::Text(provider.clone()),
                            ace_store::Value::Text(model.unwrap_or_default()),
                        ],
                    )?;
                }
            }
            ace_store::stmt_cache::run(
                tx.conn(),
                "UPDATE engine_sessions SET model=? WHERE thread_id=?",
                vec![
                    selection
                        .model
                        .as_deref()
                        .map_or(ace_store::Value::Null, |model| {
                            ace_store::Value::Text(model.to_owned())
                        }),
                    ace_store::Value::Text(id.to_owned()),
                ],
            )?;
            Ok(())
        })?;
        // The metadata keeps the other fields the transition wrote, with the new selection.
        let mut metadata = ace_json::Map::new();
        metadata.insert("selection", selection_json.clone());
        for (key, value) in [
            ("fork", previous.fork),
            ("handoff", previous.handoff),
            ("fallback", previous.fallback),
        ] {
            if let Some(value) = value {
                metadata.insert(key, value);
            }
        }
        if let Some(marker) = previous.marker {
            metadata.insert("marker", Value::from(marker.as_str()));
        }
        if !previous.context.is_empty() {
            metadata.insert(
                "context",
                Value::Array(
                    previous
                        .context
                        .iter()
                        .map(|entry| Value::from(entry.as_str()))
                        .collect::<Vec<Value>>()
                        .into(),
                ),
            );
        }
        self.transition_set(store, id, &Value::Object(metadata))?;
        self.transition_remember(store, id, &selection_json)?;
        if selection.model.is_some() {
            let root = self
                .repo
                .require_state(store, id)?
                .borrow()
                .state
                .root_key
                .clone()
                .unwrap_or_else(|| "root".to_owned());
            let facts = ace_json::json!([{
                "type": "agent.linked",
                "agent": root,
                "model": selection.model.as_ref().map(|model| model.0.clone()).unwrap_or_default(),
            }]);
            let facts = ace_json::to_string(&facts);
            self.apply(store, id, &facts, at, None)?;
        }
        store.write_events(
            id,
            &ace_json::to_string(&ace_json::json!([{
                "type": "thread.updated",
                "execution": selection_json.clone(),
            }])),
            at,
        )
    }
}

/// The threads whose stored choice predates the catalogue: a literal default, or an OpenCode
/// model without its `provider/` prefix. One pass, bounded by the sessions table.
const MIGRATE_SCAN: &str = "SELECT s.thread_id FROM engine_sessions s
      JOIN threads t ON t.id=s.thread_id
      JOIN thread_state st ON st.thread_id=s.thread_id
      LEFT JOIN engine_transitions x ON x.thread_id=s.thread_id
      WHERE lower(trim(s.model)) LIKE 'default%'
        OR lower(trim(json_extract(x.value,'$.selection.model'))) LIKE 'default%'
        OR (t.provider='opencode' AND (
          (s.model IS NOT NULL AND instr(s.model,'/')=0)
          OR (json_extract(x.value,'$.selection.model') IS NOT NULL AND instr(json_extract(x.value,'$.selection.model'),'/')=0)))";

impl crate::State {
    /// `EngineModels.migrateCachedDefaults` (`models.ts:196`): a startup pass that replaces a
    /// stored default or a legacy unprefixed OpenCode id with what the catalogue already knows.
    /// A thread this pass cannot read is handed to `unreadable` and the rest still migrate.
    pub fn migrate_cached_defaults(
        &mut self,
        store: &crate::EngineStore,
        catalog: &dyn ModelCatalog,
        mut unreadable: impl FnMut(&str, EngineError),
    ) -> Result<(), EngineError> {
        let rows = ace_store::stmt_cache::all_rows(store.conn(), MIGRATE_SCAN, vec![])?;
        let threads: Vec<String> = rows
            .iter()
            .filter_map(|row| {
                row.get("thread_id")
                    .and_then(crate::repository::residency::cell_text)
                    .map(str::to_owned)
            })
            .collect();
        for thread in threads {
            match self.migrate_cached_default(store, catalog, &thread) {
                Ok(()) => {}
                Err(error)
                    if crate::sessions::open::skippable_at_startup(
                        matches!(error, EngineError::Store(_)),
                        false,
                    ) =>
                {
                    unreadable(&thread, error);
                }
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    fn migrate_cached_default(
        &mut self,
        store: &crate::EngineStore,
        catalog: &dyn ModelCatalog,
        id: &str,
    ) -> Result<(), EngineError> {
        // A purged thread keeps its session row but has no state: nothing is left to migrate.
        let Some(snapshot) = self.repo.state(store, id)? else {
            return Ok(());
        };
        let provider = {
            let borrowed = snapshot.borrow();
            borrowed.state.config.provider.clone()
        };
        let metadata = crate::sessions::metadata::session(store, id)?;
        let previous = self.transition_get(store, id)?.selection;
        let legacy_opencode = provider == "opencode"
            && [metadata.model.clone(), previous_model(&previous)]
                .into_iter()
                .flatten()
                .any(|model| !is_default_selection(Some(&model)) && !model.contains('/'));
        if !is_default_selection(metadata.model.as_deref())
            && !is_default_selection(previous_model(&previous).as_deref())
            && !legacy_opencode
        {
            return Ok(());
        }
        let identity = self.thread_identity(store, id);
        let mut previous_selection = previous.unwrap_or_else(|| {
            let mut selection = ace_json::Map::new();
            selection.insert("provider", Value::from(provider.as_str()));
            selection.insert("options", Value::Object(ace_json::Map::new()));
            if let Some(model) = &metadata.model {
                selection.insert("model", Value::from(model.as_str()));
            }
            if let Some(instance) = &metadata.instance_id {
                selection.insert("instanceId", Value::from(instance.as_str()));
            }
            Value::Object(selection)
        });
        let Some(filter) = selection_model_filter(
            &provider,
            metadata.instance_id.as_deref(),
            identity.as_ref(),
        ) else {
            return Ok(());
        };
        let model = model_of(&previous_selection);
        let resolution = catalog.resolve_cached(&ModelSpec {
            role: "thread".to_owned(),
            model: model
                .clone()
                .filter(|model| !is_default_selection(Some(model))),
            filter,
        });
        if legacy_opencode && resolution.is_none() {
            return Ok(());
        }
        let resolved = match resolution {
            Some(ModelResolution::Resolved { model, .. }) => {
                Some(execution_model_id(model.as_ref()))
            }
            _ => None,
        };
        let mut changed = false;
        if let Value::Object(map) = &mut previous_selection
            && resolved != model
        {
            match &resolved {
                Some(model) => {
                    map.insert("model", Value::from(model.as_str()));
                }
                None => {
                    if map.remove("model").is_some() {
                        changed = true;
                    }
                }
            }
            if resolved.is_some() {
                changed = true;
            }
        }
        if !changed && resolved == model && metadata.model == resolved {
            return Ok(());
        }
        let Some(selection) = selection_from_value(&previous_selection) else {
            return Err(EngineError::Records(
                "Invalid selection metadata".to_owned(),
            ));
        };
        self.remember_selection(store, id, &selection, store.now())
    }

    /// The ACP identity a thread's row carries, when its provider is ACP.
    fn thread_identity(&self, store: &crate::EngineStore, id: &str) -> Option<AcpIdentity> {
        let thread = store.get_thread(id).ok().flatten()?;
        let value = ace_json::parse(&thread).ok()?;
        if value.get("provider").and_then(Value::as_str) != Some("acp") {
            return None;
        }
        ace_json::from_value(&value).ok()
    }
}

fn previous_model(selection: &Option<Value>) -> Option<String> {
    selection
        .as_ref()
        .and_then(|selection| selection.get("model"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

/// A stored selection as the typed one the engine's calls take. The options are plain JSON, so
/// serde_json reads them while the enum and the bounded strings are built by hand.
fn selection_from_value(value: &Value) -> Option<ExecutionSelection> {
    let provider = provider_kind(value.get("provider")?.as_str()?)?;
    let options = match value.get("options") {
        Some(Value::Object(map)) => {
            let json = ace_json::to_string(&Value::Object(map.clone()));
            serde_json::from_str(&json).ok()?
        }
        _ => serde_json::Map::new(),
    };
    Some(ExecutionSelection {
        provider,
        model: value
            .get("model")
            .and_then(Value::as_str)
            .map(|model| model.to_owned().into()),
        instance_id: value
            .get("instanceId")
            .and_then(Value::as_str)
            .map(|instance| instance.to_owned().into()),
        options: ace_protocol::generated::ExecutionOptions(options),
    })
}

fn model_of(selection: &Value) -> Option<String> {
    selection
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

#[cfg(test)]
mod tests;

pub mod select;
pub mod selection;
