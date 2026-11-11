//! Endpoints the person already had before ADR 0126, made theirs once: shipped presets that have
//! a key, and what they edited in a `models.json` an earlier Spade left in the data folder.
//!
//! Only the person's own choices are stored. Everything a preset says (its models and their
//! facts) is read from the binary each time, so shipped corrections reach existing installs.

use spade_models::{Catalog, Endpoint, Model};
use spade_store::{StoreError, StoredEndpoint, StoredModel};

use super::Engine;
use super::endpoints::is_credential_header;

const PRESETS_IMPORTED: &str = "presets_imported";
const FILE_ADOPTED: &str = "models_file_adopted";

impl Engine {
    /// An endpoint made from `preset`: its settings, none of its models (those are inherited).
    pub(super) fn stored_preset(
        &self,
        preset: &Endpoint,
        id: String,
        name: String,
    ) -> StoredEndpoint {
        StoredEndpoint {
            id,
            name,
            format: preset.format.name().to_owned(),
            base_url: preset.base_url.clone(),
            headers: preset.headers.clone(),
            session_header: preset.session_header.clone(),
            needs_key: preset.needs_key,
            key_env: preset.key_env.clone(),
            preset: Some(preset.id.clone()),
            created_ms: self.now_ms(),
            models: Vec::new(),
        }
    }

    /// Once: shipped presets that already have a key (keychain or environment) become the
    /// person's endpoints, so a setup from before ADR 0126 keeps working.
    pub(super) fn import_presets(&self) -> Result<(), StoreError> {
        if self.store.setting(PRESETS_IMPORTED)?.is_some() {
            return Ok(());
        }
        let have: Vec<String> = self.store.endpoints()?.into_iter().map(|e| e.id).collect();
        for preset in self.models.catalog().endpoints() {
            if have.contains(&preset.id) || !preset.needs_key || !self.models.has_key(preset) {
                continue;
            }
            let stored = self.stored_preset(preset, preset.id.clone(), preset.name.clone());
            match self.store.insert_endpoint(&stored) {
                Ok(()) | Err(StoreError::Exists(_)) => {}
                Err(error) => return Err(error),
            }
        }
        self.store.set_setting(PRESETS_IMPORTED, Some("1"))
    }

    /// Once, before presets are imported: what the person changed in an old `models.json`
    /// becomes theirs. A value equal to what some Spade shipped for that endpoint or model is a
    /// shipped default and is inherited from the current presets instead; any other value is the
    /// person's edit and wins. An endpoint no Spade shipped is the person's whole. A shipped
    /// endpoint nobody edited is taken only if it has a key, as with presets.
    pub(super) fn adopt_file(&self, file: &Catalog) -> Result<(), StoreError> {
        if self.store.setting(FILE_ADOPTED)?.is_some() {
            return Ok(());
        }
        let mut history = crate::presets::history();
        history.push(self.models.catalog().clone());
        let stored = self.store.endpoints()?;
        for endpoint in file.endpoints() {
            let shipped: Vec<&Endpoint> = history
                .iter()
                .flat_map(|c| c.endpoints())
                .filter(|e| e.id == endpoint.id)
                .collect();
            let current = self
                .models
                .catalog()
                .endpoints()
                .iter()
                .find(|e| e.id == endpoint.id);
            let (mut wanted, edited) = adopted(endpoint, &shipped, current, self.now_ms());
            match spade_models::base_url::check(&wanted.base_url) {
                Ok(url) => wanted.base_url = url,
                Err(why) => {
                    tracing::warn!(endpoint = %endpoint.id, why, "not adopting an endpoint from the old models.json");
                    continue;
                }
            }
            if !edited && endpoint.needs_key && !self.models.has_key(endpoint) {
                continue;
            }
            match stored.iter().find(|e| e.id == endpoint.id) {
                Some(_) => {
                    self.store.update_endpoint(&wanted)?;
                    for model in &wanted.models {
                        self.store.put_model(&wanted.id, model)?;
                    }
                }
                None => self.store.insert_endpoint(&wanted)?,
            }
        }
        self.store.set_setting(FILE_ADOPTED, Some("1"))
    }
}

/// The endpoint to store for `file`'s version of it, and whether the person edited anything.
/// `shipped` holds every shipped version of that endpoint; `current` is this build's preset.
fn adopted(
    file: &Endpoint,
    shipped: &[&Endpoint],
    current: Option<&Endpoint>,
    now_ms: i64,
) -> (StoredEndpoint, bool) {
    let mut edited = false;
    // The file's value if no shipped version had it, else the current preset's.
    let mut pick = |same: &dyn Fn(&Endpoint) -> bool| {
        let shipped_value = shipped.iter().any(|e| same(e));
        if !shipped_value {
            edited = true;
        }
        shipped_value && current.is_some()
    };
    let base = current.unwrap_or(file);
    let name = if pick(&|e| e.name == file.name) {
        &base.name
    } else {
        &file.name
    };
    let format = if pick(&|e| e.format == file.format) {
        base.format
    } else {
        file.format
    };
    let base_url = if pick(&|e| e.base_url == file.base_url) {
        &base.base_url
    } else {
        &file.base_url
    };
    let headers = if pick(&|e| e.headers == file.headers) {
        &base.headers
    } else {
        &file.headers
    };
    let session_header = if pick(&|e| e.session_header == file.session_header) {
        &base.session_header
    } else {
        &file.session_header
    };
    let needs_key = if pick(&|e| e.needs_key == file.needs_key) {
        base.needs_key
    } else {
        file.needs_key
    };
    let key_env = if pick(&|e| e.key_env == file.key_env) {
        &base.key_env
    } else {
        &file.key_env
    };
    let models: Vec<StoredModel> = file
        .models
        .iter()
        .filter_map(|model| {
            let versions: Vec<&Model> = shipped
                .iter()
                .flat_map(|e| e.models.iter())
                .filter(|m| m.id == model.id)
                .collect();
            override_of(model, &versions, current)
        })
        .collect();
    if !models.is_empty() {
        edited = true;
    }
    let mut stored = StoredEndpoint {
        id: file.id.clone(),
        name: name.clone(),
        format: format.name().to_owned(),
        base_url: base_url.clone(),
        // Credentials never go to the database; keys belong in the keychain.
        headers: headers
            .iter()
            .filter(|(k, _)| !is_credential_header(k))
            .cloned()
            .collect(),
        session_header: session_header.clone().filter(|h| !is_credential_header(h)),
        needs_key,
        key_env: key_env.clone(),
        preset: current.map(|c| c.id.clone()),
        created_ms: now_ms,
        models,
    };
    // A preset's key binding and headers never follow an edited URL to another host.
    if let Some(current) = current {
        super::endpoints::bind_to_origin(&mut stored, current);
    }
    (stored, edited)
}

/// What the person changed about `model`: `None` when every fact is one some Spade shipped.
fn override_of(
    model: &Model,
    shipped: &[&Model],
    current: Option<&Endpoint>,
) -> Option<StoredModel> {
    let in_preset = current.is_some_and(|c| c.models.iter().any(|m| m.id == model.id));
    if shipped.is_empty() {
        return Some(StoredModel {
            id: model.id.clone(),
            name: Some(model.name.clone()),
            context: model.context,
            capabilities: Some(
                model
                    .capabilities
                    .iter()
                    .map(|c| c.name().to_owned())
                    .collect(),
            ),
            source: "typed".to_owned(),
        });
    }
    let name = (!shipped.iter().any(|m| m.name == model.name)).then(|| model.name.clone());
    let context = (!shipped.iter().any(|m| m.context == model.context))
        .then_some(model.context)
        .flatten();
    let capabilities = (!shipped.iter().any(|m| m.capabilities == model.capabilities)).then(|| {
        model
            .capabilities
            .iter()
            .map(|c| c.name().to_owned())
            .collect()
    });
    if name.is_none() && context.is_none() && capabilities.is_none() {
        return None;
    }
    Some(StoredModel {
        id: model.id.clone(),
        name,
        context,
        capabilities,
        source: if in_preset { "preset" } else { "typed" }.to_owned(),
    })
}
