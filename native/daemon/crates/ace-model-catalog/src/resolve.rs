// SPDX-License-Identifier: Apache-2.0
//! Choosing the model a role spec names (`resolve.ts`).
//!
//! Only advertised values are used: an explicit model must match, an effort or tier must
//! be offered, and an automatic policy skips hidden/deprecated/legacy rows unless the
//! person pinned one. `strongest` walks the caller's preference order; `default` takes
//! the provider default. A spec that cannot be satisfied fails; it never falls back.

use ace_models::search::{is_default_selection, matches_model};
use ace_protocol::generated::{CatalogModel, ModelTier, ProviderKind};

/// A role's model policy, as `ModelRoleSpec` carries it.
#[derive(Debug, Clone, Default)]
pub struct RoleSpec {
    pub role: String,
    pub provider: Option<ProviderKind>,
    pub instance: Option<String>,
    pub model: Option<String>,
    pub strongest: bool,
    pub preference_order: Vec<String>,
    pub tier: Option<String>,
    pub effort: Option<String>,
    pub image_input: bool,
}

/// The chosen model, its tier and effort, whether its rows are stale, and the reason.
#[derive(Debug, Clone)]
pub struct Resolution {
    pub model: CatalogModel,
    pub tier: Option<ModelTier>,
    pub effort: Option<String>,
    pub stale: bool,
    pub reason: String,
}

/// The model's native effort id for a native id or canonical level, if it offers one.
pub fn effort_id(model: &CatalogModel, effort: &str) -> Option<String> {
    model
        .efforts
        .iter()
        .find(|entry| {
            entry.id.0 == effort || entry.level.is_some_and(|level| level.to_string() == effort)
        })
        .map(|entry| entry.id.0.clone())
}

/// Only advertised levels: explicit choice, catalog default, Medium, then the lower middle.
pub fn resolve_effort(
    supported: &[String],
    configured: Option<&str>,
    advertised_default: Option<&str>,
) -> Option<String> {
    if let Some(configured) = configured
        && supported.iter().any(|level| level == configured)
    {
        return Some(configured.to_owned());
    }
    if let Some(advertised) = advertised_default
        && supported.iter().any(|level| level == advertised)
    {
        return Some(advertised.to_owned());
    }
    supported
        .iter()
        .find(|level| level.to_lowercase() == "medium")
        .or_else(|| supported.get(supported.len().saturating_sub(1) / 2))
        .cloned()
}

/// The model a role spec names, or the role's reason for having none.
pub fn resolve_model(
    spec: &RoleSpec,
    models: &[CatalogModel],
    stale: impl Fn(&str) -> bool,
) -> Result<Resolution, String> {
    let model = spec
        .model
        .as_deref()
        .filter(|model| !is_default_selection(Some(model)));
    let mut matched_route: Option<String> = None;
    let mut first: Option<&CatalogModel> = None;
    let mut default_model: Option<&CatalogModel> = None;
    let mut preferred: Option<&CatalogModel> = None;
    let mut best_rank = usize::MAX;
    let bare_opencode = spec.provider == Some(ProviderKind::Opencode)
        && model.is_some_and(|model| !model.contains('/'));
    for row in models {
        if row
            .provider_enabled
            .as_ref()
            .is_some_and(|enabled| !enabled.0)
        {
            continue;
        }
        if spec
            .provider
            .is_some_and(|provider| row.provider != provider)
            || spec
                .instance
                .as_deref()
                .is_some_and(|instance| row.instance.0 != instance)
        {
            continue;
        }
        if let Some(model) = model {
            if !matches_model(row, model) {
                continue;
            }
        } else if (row.deprecated.0
            || row.legacy.as_ref().is_some_and(|legacy| legacy.0)
            || row.hidden.0)
            && !(row.is_default.0
                && row
                    .default_source
                    .as_ref()
                    .is_some_and(|source| source.to_string() == "user"))
        {
            continue;
        }
        if spec.image_input
            && !row
                .input_modalities
                .iter()
                .any(|modality| modality.0 == "image")
        {
            continue;
        }
        if spec
            .effort
            .as_deref()
            .is_some_and(|effort| effort_id(row, effort).is_none())
        {
            continue;
        }
        if let Some(tier) = spec.tier.as_deref()
            && !row.service_tiers.iter().any(|option| {
                option.id.0 == tier || (tier == "fast" && option.speed.as_deref() == Some("fast"))
            })
        {
            continue;
        }
        if bare_opencode {
            if matched_route
                .as_ref()
                .is_some_and(|route| route != &row.id.0)
            {
                return Err(format!(
                    "{}: the saved model names more than one provider route; select a provider-qualified model",
                    spec.role
                ));
            }
            matched_route = Some(row.id.0.clone());
        }
        first.get_or_insert(row);
        if row.is_default.0 {
            default_model.get_or_insert(row);
        }
        let rank = spec
            .preference_order
            .iter()
            .position(|id| id == &row.id.0)
            .unwrap_or(usize::MAX);
        if spec.strongest && rank < best_rank {
            preferred = Some(row);
            best_rank = rank;
        }
        if !bare_opencode
            && ((spec.strongest && best_rank == 0) || (!spec.strongest && default_model.is_some()))
        {
            break;
        }
    }
    let Some(chosen) = preferred.or(default_model).or(first) else {
        return Err(format!(
            "{}: no available model satisfies the policy",
            spec.role
        ));
    };
    let tier = chosen
        .service_tiers
        .iter()
        .find(|option| match spec.tier.as_deref() {
            Some(tier) => {
                option.id.0 == tier || (tier == "fast" && option.speed.as_deref() == Some("fast"))
            }
            None => chosen
                .default_tier
                .as_ref()
                .is_some_and(|default| default.0.0 == option.id.0),
        });
    let default_effort = chosen
        .default_effort
        .as_ref()
        .map(|effort| effort.0.0.clone());
    let levels: Vec<String> = chosen
        .efforts
        .iter()
        .map(|entry| entry.id.0.clone())
        .collect();
    let configured = spec
        .effort
        .as_deref()
        .and_then(|effort| effort_id(chosen, effort));
    let effort = resolve_effort(&levels, configured.as_deref(), default_effort.as_deref());
    let basis = if model.is_some() {
        "explicit model"
    } else if preferred.is_some() {
        "highest available policy preference"
    } else if spec.strongest {
        if spec.preference_order.is_empty() {
            "strength order unavailable; using provider default or first compatible model"
        } else {
            "preferred models unavailable; using provider default or first compatible model"
        }
    } else {
        "provider default or first compatible model"
    };
    let reason = format!(
        "{}: {basis}; {}{}{}",
        spec.role,
        chosen.id.0,
        tier.map(|tier| format!(", tier {}", tier.id.0))
            .unwrap_or_default(),
        effort
            .as_ref()
            .map(|effort| format!(", effort {effort}"))
            .unwrap_or_default()
    );
    Ok(Resolution {
        model: chosen.clone(),
        tier: tier.cloned(),
        effort,
        stale: stale(&chosen.instance.0),
        reason: reason.chars().take(1024).collect(),
    })
}

#[cfg(test)]
mod tests {
    //! Ports `packages/models/src/resolve.test.ts`: "effort presets preserve explicit
    //! and catalog choices and otherwise use only supported levels", "strongest role
    //! picks its highest available preference and native fast tier", "default role
    //! preserves the provider default", "unavailable explicit model and unsupported
    //! parameters never silently fall back", and the hidden/deprecated automatic skip.

    use super::*;
    use ace_models::effort::model_efforts;
    use ace_models::instance::ModelInstance;
    use serde_json::json;

    fn row(id: &str, is_default: bool, rank: Option<&str>) -> CatalogModel {
        let instance = ModelInstance::cli("codex", ProviderKind::Codex, "", "/repo");
        let mut row = ace_models::row::base(&instance, id, id, &json!({}));
        row.is_default = is_default.into();
        row.efforts = model_efforts([
            ace_models::effort::EffortValue::id("low"),
            ace_models::effort::EffortValue::id("high"),
        ])
        .into();
        row.default_effort = ace_models::row::decoded_text(Some("high"));
        let mut parameters = serde_json::Map::new();
        parameters.insert("serviceTier".into(), json!("priority"));
        row.service_tiers = vec![ModelTier {
            id: "priority".to_owned().into(),
            name: "Fast".to_owned().into(),
            parameters,
            speed: Some("fast".into()),
        }]
        .into();
        row.default_tier = ace_models::row::decoded_text(Some("priority"));
        if let Some(rank) = rank {
            row.favourite = None;
            let _ = rank;
        }
        row
    }

    #[test]
    fn effort_presets_preserve_explicit_and_catalog_choices_and_use_only_supported_levels() {
        let levels = ["low", "medium", "high"].map(str::to_owned);
        assert_eq!(
            resolve_effort(&levels, Some("low"), Some("high")),
            Some("low".into())
        );
        assert_eq!(
            resolve_effort(&levels, None, Some("high")),
            Some("high".into())
        );
        assert_eq!(
            resolve_effort(&levels, None, Some("missing")),
            Some("medium".into())
        );
        let custom = ["brief", "balanced", "deep", "extreme"].map(str::to_owned);
        assert_eq!(resolve_effort(&custom, None, None), Some("balanced".into()));
        assert_eq!(
            resolve_effort(&["high".to_owned()], None, None),
            Some("high".into())
        );
        assert_eq!(resolve_effort(&[], None, None), None);
    }

    #[test]
    fn strongest_picks_the_highest_preference_and_the_default_keeps_the_native_tier() {
        let rows = [row("normal", true, None), row("stronger", false, None)];
        let spec = RoleSpec {
            role: "coder".into(),
            provider: Some(ProviderKind::Codex),
            strongest: true,
            preference_order: vec!["not-available".into(), "stronger".into(), "normal".into()],
            tier: Some("fast".into()),
            effort: Some("high".into()),
            image_input: false,
            ..RoleSpec::default()
        };
        let picked =
            resolve_model(&spec, &rows, |_| false).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(picked.model.id.0, "stronger");
        assert_eq!(picked.tier.map(|tier| tier.id.0), Some("priority".into()));
        assert_eq!(picked.effort.as_deref(), Some("high"));
        assert!(
            picked
                .reason
                .contains("highest available policy preference")
        );

        let default = resolve_model(
            &RoleSpec {
                role: "planner".into(),
                ..RoleSpec::default()
            },
            &rows,
            |_| true,
        )
        .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(default.model.id.0, "normal");
        assert_eq!(default.effort.as_deref(), Some("high"));
        assert!(default.stale);
    }

    #[test]
    fn unavailable_explicit_models_and_unsupported_parameters_never_fall_back() {
        let rows = [row("normal", true, None), row("stronger", false, None)];
        for spec in [
            RoleSpec {
                role: "c".into(),
                model: Some("missing".into()),
                ..RoleSpec::default()
            },
            RoleSpec {
                role: "c".into(),
                effort: Some("max".into()),
                ..RoleSpec::default()
            },
            RoleSpec {
                role: "c".into(),
                tier: Some("flex".into()),
                ..RoleSpec::default()
            },
            RoleSpec {
                role: "c".into(),
                provider: Some(ProviderKind::Claude),
                ..RoleSpec::default()
            },
            RoleSpec {
                role: "c".into(),
                instance: Some("other".into()),
                ..RoleSpec::default()
            },
        ] {
            assert!(resolve_model(&spec, &rows, |_| false).is_err());
        }
    }

    #[test]
    fn automatic_policies_skip_hidden_rows_but_an_explicit_model_still_takes_one() {
        let mut hidden = row("stronger", false, None);
        hidden.hidden = true.into();
        let rows = [row("normal", true, None), hidden];
        let automatic = RoleSpec {
            role: "c".into(),
            strongest: true,
            preference_order: vec!["stronger".into(), "normal".into()],
            ..RoleSpec::default()
        };
        assert_eq!(
            resolve_model(&automatic, &rows, |_| false)
                .map(|picked| picked.model.id.0)
                .unwrap_or_default(),
            "normal"
        );
        let explicit = RoleSpec {
            role: "c".into(),
            model: Some("stronger".into()),
            ..RoleSpec::default()
        };
        assert_eq!(
            resolve_model(&explicit, &rows, |_| false)
                .map(|picked| picked.model.id.0)
                .unwrap_or_default(),
            "stronger"
        );
    }
}
