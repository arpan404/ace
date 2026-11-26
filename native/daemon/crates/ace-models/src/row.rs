// SPDX-License-Identifier: Apache-2.0
//! The one constructor every provider's catalog rows start from.
//!
//! Ports `packages/models/src/model.ts`: a row keeps the instance's source, the native
//! id, a derived display name and family, the hints [`catalog_metadata`] reads, and a
//! redacted [`raw_payload`]. `@ace/protocol`'s `CatalogModel` is the generated row
//! shape, so a field this module forgets is a compile error, not a silent gap.
//!
//! [`validate_row`] applies the bounds the TypeScript's `CatalogModel.parse` enforces:
//! labels count code points (zod), arrays count entries, and the row's compact JSON is
//! at most 8 KiB.

use ace_protocol::generated::{
    CatalogModel, CatalogRaw, ModelEffort, ModelSource, ModelSourceKind, ModelTier,
};
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::display_name::model_display_name;
use crate::instance::ModelInstance;
use crate::metadata::{catalog_metadata, legacy_metadata};
use crate::raw::raw_payload;

const LABEL_LIMIT: usize = 256;
const EFFORTS_LIMIT: usize = 32;
const TIERS_LIMIT: usize = 32;
const MODALITIES_LIMIT: usize = 16;
const ALIASES_LIMIT: usize = 32;
const ROW_LIMIT: usize = 8192;

/// The protocol's 256-code-point label newtype, built from a plain string.
pub(crate) fn text<T: From<String>>(value: &str) -> T {
    value.to_owned().into()
}

/// A list of labels as the protocol stores it.
pub(crate) fn texts<W, T>(values: impl IntoIterator<Item = String>) -> W
where
    T: From<String>,
    W: From<Vec<T>>,
{
    W::from(values.into_iter().map(T::from).collect())
}

/// An optional field whose generated newtype wraps another one; serde finds the path.
pub(crate) fn decoded_text<T: DeserializeOwned>(value: Option<&str>) -> Option<T> {
    value.and_then(|text| serde_json::from_value(Value::String(text.to_owned())).ok())
}

/// A positive number in the protocol's `NonZeroU64` newtype, when the value is one.
pub(crate) fn nonzero<T: From<std::num::NonZeroU64>>(value: u64) -> Option<T> {
    std::num::NonZeroU64::new(value).map(T::from)
}

/// The row a provider's native entry becomes before its own fields are applied.
pub fn base(instance: &ModelInstance, id: &str, display_name: &str, raw: &Value) -> CatalogModel {
    let metadata = catalog_metadata(raw);
    // A native label that only repeats the id is not a name; the family formatter derives one.
    let tail = id.rsplit_once('/').map(|(_, tail)| tail).unwrap_or(id);
    let supplied = if display_name.to_lowercase() == id.to_lowercase()
        || display_name.to_lowercase() == tail.to_lowercase()
    {
        None
    } else {
        Some(display_name)
    };
    let named = model_display_name(id, supplied);
    let label = instance.source_label();
    let source = ModelSource {
        id: text(&instance.id),
        kind: ModelSourceKind::Account,
        label: text(label),
        requires_auth: None,
        service: None,
    };
    let payload = raw_payload(raw);
    let resolved = metadata
        .resolved_model
        .as_deref()
        .or(metadata.resolved_model_id.as_deref());
    CatalogModel {
        id: text(id),
        display_name: text(&named.display_name),
        detail: decoded_text(named.detail.as_deref()),
        family: decoded_text(named.family.as_deref()),
        version: decoded_text(named.version.as_deref()),
        native_model_id: text(id),
        provider: instance.provider,
        instance: text(&instance.id),
        source: Some(source.into()),
        acp_agent_id: decoded_text(instance.acp_agent_id.as_deref()),
        installation_id: decoded_text(instance.installation_id.as_deref()),
        instance_id: decoded_text(instance.instance_id.as_deref()),
        resolved_model_id: decoded_text(resolved),
        aliases: metadata.aliases.map(texts),
        efforts: Vec::<ModelEffort>::new().into(),
        service_tiers: Vec::<ModelTier>::new().into(),
        input_modalities: texts(Vec::<String>::new()),
        is_default: false.into(),
        hidden: false.into(),
        deprecated: false.into(),
        legacy: Some(legacy_metadata(raw).into()),
        raw: CatalogRaw {
            json: payload.json,
            truncated: payload.truncated,
        },
        context_window: None,
        custom: None,
        default_effort: None,
        default_source: None,
        default_tier: None,
        favourite: None,
        free: None,
        group: None,
        is_new: None,
        model_config_id: None,
        native_provider_id: None,
        provider_enabled: None,
        selector_method: None,
        sort_key: None,
        thinking_toggle: None,
        tier: None,
        visibility_reason: None,
    }
}

/// Why a row cannot be listed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RowError(pub &'static str);

impl std::fmt::Display for RowError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for RowError {}

fn label_fits(value: &str) -> bool {
    (1..=LABEL_LIMIT).contains(&value.chars().count())
}

fn optional_label_fits(value: Option<&str>) -> bool {
    value.is_none_or(label_fits)
}

/// A generated label newtype (possibly nested) through its `Display`.
fn optional_text_fits<T: std::fmt::Display>(value: Option<&T>) -> bool {
    value.is_none_or(|value| label_fits(&value.to_string()))
}

/// The bounds `CatalogModel.parse` enforces, checked on the row ace is about to store.
pub fn validate_row(model: &CatalogModel) -> Result<(), RowError> {
    let labels = [
        Some(model.id.0.as_str()),
        Some(model.display_name.0.as_str()),
        model.detail.as_ref().map(|value| value.0.as_str()),
        model.family.as_ref().map(|value| value.0.as_str()),
        model.version.as_ref().map(|value| value.0.as_str()),
        model.sort_key.as_ref().map(|value| value.0.as_str()),
        Some(model.instance.0.as_str()),
        model
            .native_provider_id
            .as_ref()
            .map(|value| value.0.as_str()),
        Some(model.native_model_id.0.as_str()),
        model
            .resolved_model_id
            .as_ref()
            .map(|value| value.0.as_str()),
        model.model_config_id.as_ref().map(|value| value.0.as_str()),
        model.default_effort.as_ref().map(|value| value.0.as_str()),
        model.default_tier.as_ref().map(|value| value.0.as_str()),
    ];
    if !labels.into_iter().all(optional_label_fits)
        || !optional_text_fits(model.acp_agent_id.as_ref())
        || !optional_text_fits(model.installation_id.as_ref())
        || !optional_text_fits(model.instance_id.as_ref())
        || !model
            .source
            .as_ref()
            .is_none_or(|source| label_fits(&source.id.0) && label_fits(&source.label.0))
        || !model
            .aliases
            .as_ref()
            .is_none_or(|aliases| aliases.iter().all(|alias| label_fits(&alias.0)))
    {
        return Err(RowError("Model row has an oversized label"));
    }
    if model.efforts.len() > EFFORTS_LIMIT {
        return Err(RowError("Model row has too many efforts"));
    }
    if model.service_tiers.len() > TIERS_LIMIT {
        return Err(RowError("Model row has too many service tiers"));
    }
    if model.input_modalities.len() > MODALITIES_LIMIT {
        return Err(RowError("Model row has too many input modalities"));
    }
    if model
        .aliases
        .as_ref()
        .is_some_and(|aliases| aliases.len() > ALIASES_LIMIT)
    {
        return Err(RowError("Model row has too many aliases"));
    }
    if !model
        .efforts
        .iter()
        .all(|effort| label_fits(&effort.id.0) && label_fits(&effort.label.0))
    {
        return Err(RowError("Model row has an oversized effort"));
    }
    for tier in model.service_tiers.iter() {
        if !label_fits(&tier.id.0) || !label_fits(&tier.name.0) {
            return Err(RowError("Model row has an oversized service tier"));
        }
        if tier
            .speed
            .as_deref()
            .is_some_and(|speed| !label_fits(speed))
        {
            return Err(RowError("Model row has an oversized label"));
        }
        if tier.parameters.len() > 16 {
            return Err(RowError("Model row has too many tier parameters"));
        }
        for (key, value) in &tier.parameters {
            // Keys are labels; string values are `max(256)` with no minimum.
            let fits = label_fits(key)
                && match value {
                    Value::String(value) => value.chars().count() <= LABEL_LIMIT,
                    Value::Bool(_) => true,
                    _ => false,
                };
            if !fits {
                return Err(RowError("Model row has an oversized tier parameter"));
            }
        }
    }
    if !model
        .input_modalities
        .iter()
        .all(|modality| label_fits(&modality.0))
    {
        return Err(RowError("Model row has an oversized input modality"));
    }
    if model.raw.json.chars().count() > 2048 || model.raw.json.len() > 2048 {
        return Err(RowError("Model row has an oversized raw payload"));
    }
    let bytes =
        serde_json::to_string(model).map_err(|_| RowError("Model row is not serializable"))?;
    if bytes.len() > ROW_LIMIT {
        return Err(RowError("Model row exceeds 8 KiB"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    //! Ports the `base()` behaviour the catalog cases rely on
    //! (`packages/models/src/model.ts`, exercised through `open-code.test.ts` and
    //! `catalog-policy.test.ts`'s rows): the native id and instance source, a derived
    //! display name when the provider's only repeats the id, the metadata hints, and
    //! the bounded raw copy.
    //!
    //! Rule 17: `validate_row`'s label bound is zod's, so it counts code points; the
    //! row bound is UTF-8 bytes.

    use super::*;
    use ace_protocol::generated::ProviderKind;
    use serde_json::json;

    fn instance() -> ModelInstance {
        ModelInstance {
            label: Some("Work account".into()),
            acp_agent_id: Some("official:qwen-code".into()),
            ..ModelInstance::cli("opencode-account", ProviderKind::Opencode, "", "/repo")
        }
    }

    fn value(model: &CatalogModel) -> Value {
        serde_json::to_value(model).unwrap_or(Value::Null)
    }

    #[test]
    fn a_row_keeps_the_native_id_the_instance_source_and_the_derived_name() {
        let model = base(
            &instance(),
            "opencode-go/muse-spark-1.3-contributor",
            "Muse Spark 1.3 Contributor",
            &json!({}),
        );
        let row = value(&model);
        assert_eq!(row["id"], "opencode-go/muse-spark-1.3-contributor");
        assert_eq!(
            row["nativeModelId"],
            "opencode-go/muse-spark-1.3-contributor"
        );
        assert_eq!(row["displayName"], "Muse Spark 1.3 Contributor");
        assert_eq!(row["family"], "muse-spark-contributor");
        assert_eq!(row["version"], "1.3");
        assert_eq!(row["instance"], "opencode-account");
        assert_eq!(row["source"]["id"], "opencode-account");
        assert_eq!(row["source"]["label"], "Work account");
        assert_eq!(row["source"]["kind"], "account");
        assert_eq!(row["acpAgentId"], "official:qwen-code");
        assert_eq!(row["isDefault"], false);
        assert_eq!(row["hidden"], false);
        assert_eq!(row["deprecated"], false);
        assert_eq!(row["efforts"], json!([]));
        assert_eq!(row["serviceTiers"], json!([]));
        assert_eq!(row["inputModalities"], json!([]));
    }

    #[test]
    fn a_label_that_only_repeats_the_id_is_not_a_display_name() {
        let model = base(
            &instance(),
            "claude-opus-5-5",
            "claude-opus-5-5",
            &json!({}),
        );
        assert_eq!(value(&model)["displayName"], "Opus 5.5");
    }

    #[test]
    fn metadata_contributes_the_resolved_model_aliases_and_legacy_state() {
        let model = base(
            &instance(),
            "alias-model",
            "Alias Model",
            &json!({
                "resolvedModel": "claude-opus-5-5",
                "resolvedModelId": "ignored",
                "aliases": ["alias"],
                "status": "deprecated",
                "metadata": { "apiKey": "private-value" },
            }),
        );
        let row = value(&model);
        assert_eq!(row["resolvedModelId"], "claude-opus-5-5");
        assert_eq!(row["aliases"], json!(["alias"]));
        assert_eq!(row["legacy"], true);
        assert!(
            !row["raw"]["json"]
                .as_str()
                .unwrap_or("")
                .contains("private-value")
        );
        assert_eq!(row["raw"]["truncated"], false);
    }

    fn tier(parameters: Value) -> ModelTier {
        ModelTier {
            id: "tier".to_owned().into(),
            name: "Tier".to_owned().into(),
            parameters: parameters.as_object().cloned().unwrap_or_default(),
            speed: None,
        }
    }

    #[test]
    fn tier_parameters_are_at_most_sixteen_with_label_keys_and_bounded_values() {
        let mut model = base(&instance(), "m", "M", &json!({}));
        let sixteen = (0..16)
            .map(|n| (format!("p{n}"), Value::String("v".into())))
            .collect::<serde_json::Map<_, _>>();
        model.service_tiers = vec![tier(Value::Object(sixteen))].into();
        assert!(validate_row(&model).is_ok());
        let seventeen = (0..17)
            .map(|n| (format!("p{n}"), Value::String("v".into())))
            .collect::<serde_json::Map<_, _>>();
        model.service_tiers = vec![tier(Value::Object(seventeen))].into();
        assert_eq!(
            validate_row(&model),
            Err(RowError("Model row has too many tier parameters"))
        );
        // Keys are labels and string values are at most 256 code points; booleans pass.
        let long_key = format!("{}x", "🚀".repeat(LABEL_LIMIT));
        model.service_tiers = vec![tier(json!({ long_key: true }))].into();
        assert_eq!(
            validate_row(&model),
            Err(RowError("Model row has an oversized tier parameter"))
        );
        model.service_tiers = vec![tier(json!({ "p": "🚀".repeat(LABEL_LIMIT + 1) }))].into();
        assert_eq!(
            validate_row(&model),
            Err(RowError("Model row has an oversized tier parameter"))
        );
        model.service_tiers =
            vec![tier(json!({ "p": true, "q": "🚀".repeat(LABEL_LIMIT) }))].into();
        assert!(validate_row(&model).is_ok());
    }

    #[test]
    fn source_identity_aliases_and_a_tier_speed_are_labels_too() {
        let mut model = base(&instance(), "m", "M", &json!({}));
        let long = "🚀".repeat(LABEL_LIMIT + 1);
        if let Some(source) = model.source.take() {
            let mut source = (*source).clone();
            source.id = long.clone().into();
            model.source = Some(source.into());
        }
        assert_eq!(
            validate_row(&model),
            Err(RowError("Model row has an oversized label"))
        );
        let mut model = base(&instance(), "m", "M", &json!({}));
        if let Some(source) = model.source.take() {
            let mut source = (*source).clone();
            source.label = long.clone().into();
            model.source = Some(source.into());
        }
        assert_eq!(
            validate_row(&model),
            Err(RowError("Model row has an oversized label"))
        );
        let mut model = base(&instance(), "m", "M", &json!({}));
        model.acp_agent_id = decoded_text(Some(&long));
        model.installation_id = decoded_text(Some("i"));
        model.instance_id = decoded_text(Some("n"));
        assert_eq!(
            validate_row(&model),
            Err(RowError("Model row has an oversized label"))
        );
        let mut model = base(&instance(), "m", "M", &json!({}));
        model.aliases = Some(vec![long.clone().into()].into());
        assert_eq!(
            validate_row(&model),
            Err(RowError("Model row has an oversized label"))
        );
        let mut model = base(&instance(), "m", "M", &json!({}));
        let mut tier = tier(json!({}));
        tier.speed = Some(long);
        model.service_tiers = vec![tier].into();
        assert_eq!(
            validate_row(&model),
            Err(RowError("Model row has an oversized label"))
        );
    }

    #[test]
    fn the_raw_copy_is_at_most_two_kibibytes_of_utf8() {
        let mut model = base(&instance(), "m", "M", &json!({}));
        model.raw = CatalogRaw {
            json: "a".repeat(2048),
            truncated: false,
        };
        assert_eq!(validate_row(&model), Ok(()));
        model.raw = CatalogRaw {
            json: "a".repeat(2049),
            truncated: true,
        };
        assert_eq!(
            validate_row(&model),
            Err(RowError("Model row has an oversized raw payload"))
        );
        // The bound is UTF-8 bytes: 200 emoji are 800 bytes and fit; 600 are over.
        model.raw = CatalogRaw {
            json: "🚀".repeat(200),
            truncated: false,
        };
        assert_eq!(validate_row(&model), Ok(()));
        model.raw = CatalogRaw {
            json: "🚀".repeat(600),
            truncated: true,
        };
        assert_eq!(
            validate_row(&model),
            Err(RowError("Model row has an oversized raw payload"))
        );
    }

    #[test]
    fn the_rows_label_bound_counts_code_points_and_the_row_bound_counts_bytes() {
        // 256 emoji are 256 code points but 1,024 UTF-8 bytes: accepted.
        let mut model = base(&instance(), "m", &"🚀".repeat(LABEL_LIMIT), &json!({}));
        assert!(validate_row(&model).is_ok());
        model.display_name = "🚀".repeat(LABEL_LIMIT + 1).into();
        assert_eq!(
            validate_row(&model),
            Err(RowError("Model row has an oversized label"))
        );
        // A row whose compact JSON passes 8 KiB is refused even when every field is
        // inside its own bound: 32 aliases of 256 emoji each are 32 KiB.
        let mut large = base(&instance(), "m", "M", &json!({}));
        large.aliases =
            Some(vec!["🚀".repeat(LABEL_LIMIT).to_owned().into(); ALIASES_LIMIT].into());
        assert_eq!(
            validate_row(&large),
            Err(RowError("Model row exceeds 8 KiB"))
        );
    }
}
