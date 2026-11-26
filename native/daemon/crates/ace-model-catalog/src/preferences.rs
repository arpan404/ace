// SPDX-License-Identifier: Apache-2.0
//! The preference view over a provider's rows (`preferences.ts`).
//!
//! Account fields replace provider fields only when supplied; visibility marks rows
//! hidden with a reason, favourites, and the provider's enabled state; the view adds
//! the person's custom models and marks the configured default.

use ace_models::instance::ModelInstance;
use ace_models::row::base;
use ace_protocol::generated::{CatalogModel, ProviderKind};
use serde_json::Value;

use crate::cleanup::{clean_catalog, default_model};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomModel {
    pub id: String,
    pub display_name: String,
}

/// One provider's (or account's) preferences.
#[derive(Debug, Clone)]
pub struct ProviderConfig {
    pub provider: ProviderKind,
    pub instance: Option<String>,
    pub enabled: Option<bool>,
    pub default_model: Option<String>,
    pub custom_models: Vec<CustomModel>,
    pub hidden_models: Vec<String>,
    pub shown_models: Vec<String>,
    pub hidden_groups: Vec<String>,
    pub shown_groups: Vec<String>,
    pub favourites: Vec<String>,
    pub show_only_favourites: bool,
    pub hide_deprecated: bool,
}

impl ProviderConfig {
    /// An empty configuration for one provider.
    pub fn new(provider: ProviderKind) -> Self {
        Self {
            provider,
            instance: None,
            enabled: None,
            default_model: None,
            custom_models: Vec::new(),
            hidden_models: Vec::new(),
            shown_models: Vec::new(),
            hidden_groups: Vec::new(),
            shown_groups: Vec::new(),
            favourites: Vec::new(),
            show_only_favourites: false,
            hide_deprecated: false,
        }
    }
}

/// Account fields replace provider fields only when explicitly supplied.
pub fn provider_configuration(
    rows: &[ProviderConfig],
    provider: ProviderKind,
    instance: Option<&str>,
) -> ProviderConfig {
    let global = rows
        .iter()
        .find(|row| row.provider == provider && row.instance.is_none());
    let account = instance.and_then(|instance| {
        rows.iter()
            .find(|row| row.provider == provider && row.instance.as_deref() == Some(instance))
    });
    let mut merged = global
        .cloned()
        .unwrap_or_else(|| ProviderConfig::new(provider));
    if let Some(account) = account {
        if account.enabled.is_some() {
            merged.enabled = account.enabled;
        }
        if account.default_model.is_some() {
            merged.default_model = account.default_model.clone();
        }
        if !account.custom_models.is_empty() {
            merged.custom_models = account.custom_models.clone();
        }
        if !account.hidden_models.is_empty() {
            merged.hidden_models = account.hidden_models.clone();
        }
        if !account.shown_models.is_empty() {
            merged.shown_models = account.shown_models.clone();
        }
        if !account.hidden_groups.is_empty() {
            merged.hidden_groups = account.hidden_groups.clone();
        }
        if !account.shown_groups.is_empty() {
            merged.shown_groups = account.shown_groups.clone();
        }
        if !account.favourites.is_empty() {
            merged.favourites = account.favourites.clone();
        }
        if account.show_only_favourites {
            merged.show_only_favourites = true;
        }
        if account.hide_deprecated {
            merged.hide_deprecated = true;
        }
    }
    if global.is_some_and(|row| row.enabled == Some(false)) {
        merged.enabled = Some(false);
    }
    merged.provider = provider;
    merged.instance = instance.map(str::to_owned);
    merged
}

fn listed(values: &[String], id: &str) -> bool {
    values.iter().any(|value| value == id)
}

/// A row with `hidden`, `favourite` and `providerEnabled` set from the preferences.
pub fn model_visibility(mut row: CatalogModel, config: &ProviderConfig) -> CatalogModel {
    let enabled = config.enabled != Some(false);
    let ids: Vec<&str> = std::iter::once(row.id.0.as_str())
        .chain(
            row.aliases
                .as_ref()
                .map(|aliases| aliases.iter().map(|alias| alias.0.as_str()))
                .into_iter()
                .flatten(),
        )
        .collect();
    let favourite = ids.iter().any(|id| listed(&config.favourites, id));
    let explicit_show = ids.iter().any(|id| listed(&config.shown_models, id));
    let group = row
        .native_provider_id
        .as_ref()
        .map(|provider| provider.0.0.as_str());
    let group_hidden = group.is_some_and(|group| {
        listed(&config.hidden_groups, group) && !listed(&config.shown_groups, group)
    });
    let reason = if !enabled {
        Some("provider_disabled")
    } else if group_hidden {
        Some("group_hidden")
    } else if ids.iter().any(|id| listed(&config.hidden_models, id)) {
        Some("model_hidden")
    } else if explicit_show {
        None
    } else if config.hide_deprecated
        && (row.deprecated.0 || row.legacy.as_ref().is_some_and(|legacy| legacy.0))
        && !favourite
    {
        Some("deprecated")
    } else if row.hidden.0 {
        Some("provider_hidden")
    } else {
        None
    };
    let visibility =
        reason.or_else(|| (config.show_only_favourites && !favourite).then_some("not_favourite"));
    row.hidden = visibility.is_some().into();
    row.favourite = Some(favourite.into());
    row.provider_enabled = Some(enabled.into());
    row.visibility_reason = visibility.and_then(|reason| reason.parse().ok());
    row
}

fn custom_row(config: &ProviderConfig, instance: &str, model: &CustomModel) -> CatalogModel {
    let instance = ModelInstance::cli(instance, config.provider, "", "/repo");
    let mut row = base(&instance, &model.id, &model.display_name, &Value::Null);
    row.custom = Some(true.into());
    row.efforts = Vec::new().into();
    row
}

/// The provider's view: cleaned rows, custom additions, and the configured default.
pub fn configured_models(
    models: &[CatalogModel],
    provider: ProviderKind,
    instance: &str,
    config: &ProviderConfig,
) -> Vec<CatalogModel> {
    let mut rows = clean_catalog(models);
    let found: Vec<String> = rows
        .iter()
        .flat_map(|row| {
            std::iter::once(row.id.0.clone()).chain(
                row.aliases
                    .as_ref()
                    .map(|aliases| aliases.iter().map(|alias| alias.0.clone()))
                    .into_iter()
                    .flatten(),
            )
        })
        .collect();
    for model in &config.custom_models {
        if !found.iter().any(|id| id == &model.id) {
            rows.push(custom_row(config, instance, model));
        }
    }
    for row in rows.iter_mut() {
        *row = model_visibility(row.clone(), config);
    }
    let selection = default_model(&rows, provider, config.default_model.as_deref());
    for row in rows.iter_mut() {
        row.is_default = selection
            .as_ref()
            .is_some_and(|(chosen, _)| chosen.id.0 == row.id.0)
            .into();
        if selection
            .as_ref()
            .is_some_and(|(chosen, _)| chosen.id.0 == row.id.0)
        {
            let source = if selection.as_ref().is_some_and(|(_, user)| *user) {
                "user"
            } else {
                "built-in"
            };
            row.default_source = source.parse().ok();
        } else {
            row.default_source = None;
        }
    }
    rows
}

#[cfg(test)]
mod tests {
    //! Ports `catalog-policy.test.ts`'s "settings may make a pinned legacy model the
    //! concrete default", "Muse Spark 1.3 Contributor becomes current and default..." and
    //! the visibility rule that hidden groups/favourites decorate the view.

    use super::*;
    use ace_models::row::decoded_text;
    use serde_json::json;

    fn row(provider: ProviderKind, id: &str, family: &str, version: &str) -> CatalogModel {
        let instance = ModelInstance::cli("account", provider, "", "/repo");
        let mut row = base(&instance, id, id, &json!({}));
        row.family = decoded_text(Some(family));
        row.version = decoded_text(Some(version));
        row
    }

    #[test]
    fn settings_may_make_a_pinned_legacy_model_the_concrete_default() {
        let rows = vec![
            row(ProviderKind::Codex, "gpt-6.1-sol", "gpt-sol", "6.1"),
            row(ProviderKind::Codex, "gpt-5.6-sol", "gpt-sol", "5.6"),
        ];
        let config = ProviderConfig {
            provider: ProviderKind::Codex,
            default_model: Some("gpt-5.6-sol".into()),
            ..ProviderConfig::new(ProviderKind::Codex)
        };
        let view = configured_models(&rows, ProviderKind::Codex, "account", &config);
        let chosen = view
            .iter()
            .find(|row| row.is_default.0)
            .unwrap_or_else(|| panic!("default"));
        assert_eq!(chosen.id.0, "gpt-5.6-sol");
        assert_eq!(
            chosen
                .default_source
                .as_ref()
                .map(|s| s.to_string())
                .as_deref(),
            Some("user")
        );
        let other = view
            .iter()
            .find(|row| row.id.0 == "gpt-6.1-sol")
            .unwrap_or_else(|| panic!("row"));
        assert!(!other.is_default.0);
    }

    #[test]
    fn custom_models_join_the_view_and_hidden_groups_decorate_rows() {
        let rows = vec![row(ProviderKind::Codex, "gpt-6-sol", "gpt-sol", "6")];
        let config = ProviderConfig {
            provider: ProviderKind::Codex,
            hidden_groups: vec!["codex".into()],
            favourites: vec!["gpt-6-sol".into()],
            custom_models: vec![CustomModel {
                id: "local-model".into(),
                display_name: "Local Model".into(),
            }],
            ..ProviderConfig::new(ProviderKind::Codex)
        };
        let view = configured_models(&rows, ProviderKind::Codex, "account", &config);
        assert!(view.iter().any(|row| row.id.0 == "local-model"));
        let favourite = view
            .iter()
            .find(|row| row.id.0 == "gpt-6-sol")
            .unwrap_or_else(|| panic!("row"));
        assert!(
            favourite
                .favourite
                .as_ref()
                .is_some_and(|favourite| favourite.0)
        );
        assert!(!favourite.hidden.0);
    }
}
