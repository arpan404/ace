// SPDX-License-Identifier: Apache-2.0
//! Lifecycle classes, grouping and sort keys for catalog rows
//! (`packages/models/src/catalog-classification.ts`).
//!
//! A row is current unless it is deprecated, legacy, a dated snapshot beside an
//! undated route, a provider exception, or older than its family's newest version in
//! the same scope (provider, instance, native provider, family). The sort key orders
//! current before legacy, family, newest version first, then id, with digit runs
//! padded so numeric selectors compare naturally.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use ace_models::display_name::model_display_name;
use ace_models::row::decoded_text;
use ace_protocol::generated::{CatalogModel, ModelSource, ModelSourceKind, ProviderKind};

/// A row's lifecycle class, as the protocol's `tier`/`group` spelling.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    Current,
    Legacy,
}

impl Class {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Current => "current",
            Self::Legacy => "legacy",
        }
    }
}

/// The provider-specific routing aliases with lifecycle semantics.
fn override_class(provider: ProviderKind, id: &str) -> Option<Class> {
    match (provider, id) {
        (ProviderKind::Cursor, "auto") => Some(Class::Current),
        (ProviderKind::Codex, "gpt-5-codex-mini") => Some(Class::Legacy),
        _ => None,
    }
}

/// Version parts compared as JavaScript numbers; an unreadable part makes the
/// difference zero, as `NaN` does.
pub fn compare_versions(a: &str, b: &str) -> i32 {
    let left: Vec<f64> = a
        .split('.')
        .map(|part| part.parse().unwrap_or(f64::NAN))
        .collect();
    let right: Vec<f64> = b
        .split('.')
        .map(|part| part.parse().unwrap_or(f64::NAN))
        .collect();
    for index in 0..left.len().max(right.len()) {
        let difference =
            left.get(index).copied().unwrap_or(0.0) - right.get(index).copied().unwrap_or(0.0);
        if difference.is_nan() {
            return 0;
        }
        if difference != 0.0 {
            return if difference < 0.0 { -1 } else { 1 };
        }
    }
    0
}

fn scope_key(row: &CatalogModel) -> String {
    let family = row.family.as_ref().map(|family| family.0.0.as_str());
    let native_provider = row
        .native_provider_id
        .as_ref()
        .map(|provider| provider.0.0.as_str());
    format!(
        "{}\u{0}{}\u{0}{}\u{0}{}",
        row.provider,
        row.instance.0,
        native_provider.unwrap_or(""),
        family.unwrap_or("")
    )
}

fn identity_sort_key(id: &str) -> String {
    static DIGITS: OnceLock<Option<regex::Regex>> = OnceLock::new();
    let digits = DIGITS.get_or_init(|| regex::Regex::new(r"\d+").ok());
    match digits {
        Some(digits) => digits
            .replace_all(id, |captures: &regex::Captures<'_>| {
                format!("{:0>12}", captures.get(0).map(|m| m.as_str()).unwrap_or(""))
            })
            .into_owned(),
        None => id.to_owned(),
    }
}

fn dated(detail: Option<&str>) -> bool {
    static DATED: OnceLock<Option<regex::Regex>> = OnceLock::new();
    let pattern =
        DATED.get_or_init(|| regex::Regex::new(r"20[0-9]{6}|20[0-9]{2}-[0-9]{2}-[0-9]{2}").ok());
    detail.is_some_and(|detail| pattern.as_ref().is_some_and(|p| p.is_match(detail)))
}

/// The class one row takes, given its family's newest version and whether an
/// undated route exists beside its date.
fn class_of(
    row: &CatalogModel,
    newest: &HashMap<String, String>,
    undated: &HashSet<String>,
) -> Class {
    let family = row.family.as_ref().map(|family| family.0.0.clone());
    let version = row.version.as_ref().map(|version| version.0.0.clone());
    let override_class = override_class(row.provider, &row.id.0);
    let older = family.is_some()
        && version.as_ref().is_some_and(|version| {
            compare_versions(version, newest.get(&scope_key(row)).unwrap_or(version)) < 0
        });
    let snapshot = dated(row.detail.as_ref().map(|detail| detail.0.0.as_str()))
        && undated.contains(&format!(
            "{}:{}",
            scope_key(row),
            version.as_deref().unwrap_or("")
        ));
    let legacy = row.deprecated.0
        || row.legacy.as_ref().is_some_and(|legacy| legacy.0)
        || snapshot
        || override_class == Some(Class::Legacy)
        || (override_class != Some(Class::Current) && older);
    if legacy {
        Class::Legacy
    } else {
        Class::Current
    }
}

fn version_key(version: Option<&str>) -> String {
    (0..4)
        .map(|index| {
            let part = version
                .and_then(|version| version.split('.').nth(index))
                .unwrap_or("0")
                .parse::<f64>()
                .ok()
                .filter(|value| value.is_finite())
                .unwrap_or(0.0);
            let value = (999_999.0 - part).max(0.0) as u64;
            format!("{value:0>6}")
        })
        .collect::<Vec<_>>()
        .join(".")
}

/// Names a row the way the catalog keeps it: derived from its id, with the provider's
/// own name when it is a real name, and a custom row keeps its typed name.
fn name_row(row: &mut CatalogModel) {
    let named = model_display_name(&row.id.0, Some(&row.display_name.0));
    if row.custom.as_ref().is_some_and(|custom| custom.0) {
        return;
    }
    row.display_name = named.display_name.into();
    row.detail = named
        .detail
        .as_deref()
        .and_then(|detail| decoded_text(Some(detail)));
    row.family = named
        .family
        .as_deref()
        .and_then(|family| decoded_text(Some(family)));
    row.version = named
        .version
        .as_deref()
        .and_then(|version| decoded_text(Some(version)));
}

/// A row's source when discovery reported none: the account, or the upstream route.
fn source_for(row: &CatalogModel) -> ModelSource {
    let native = row
        .native_provider_id
        .as_ref()
        .map(|provider| provider.0.0.clone());
    ModelSource {
        id: (native.clone().unwrap_or_else(|| row.instance.0.clone())).into(),
        kind: if native.is_some() {
            ModelSourceKind::Other
        } else {
            ModelSourceKind::Account
        },
        label: native.unwrap_or_else(|| row.instance.0.clone()).into(),
        requires_auth: None,
        service: None,
    }
}

fn set_class(row: &mut CatalogModel, class: Class) {
    row.tier = class.as_str().parse().ok();
    row.group = class.as_str().parse().ok();
    row.legacy = Some((class == Class::Legacy).into());
}

/// The rows with their lifecycle class, group, sort key and source filled in.
///
/// Ports `classifyCatalog`: names are derived first, the newest version per scope is
/// found, dated snapshots lose to the undated route of the same version, then each
/// row gets `tier`, `legacy`, `group`, `sortKey` and a source.
pub fn classify(rows: &mut [CatalogModel]) {
    for row in rows.iter_mut() {
        name_row(row);
    }
    let mut newest: HashMap<String, String> = HashMap::new();
    for row in rows.iter() {
        let (Some(family), Some(version)) = (
            row.family.as_ref().map(|family| family.0.0.clone()),
            row.version.as_ref().map(|version| version.0.0.clone()),
        ) else {
            continue;
        };
        let _ = family;
        let key = scope_key(row);
        match newest.get(&key) {
            Some(previous) if compare_versions(&version, previous) <= 0 => {}
            _ => {
                newest.insert(key, version);
            }
        }
    }
    let undated: HashSet<String> = rows
        .iter()
        .filter(|row| !dated(row.detail.as_ref().map(|detail| detail.0.0.as_str())))
        .map(|row| {
            format!(
                "{}:{}",
                scope_key(row),
                row.version
                    .as_ref()
                    .map(|version| version.0.0.as_str())
                    .unwrap_or("")
            )
        })
        .collect();
    for row in rows.iter_mut() {
        let class = class_of(row, &newest, &undated);
        set_class(row, class);
        let family = row
            .family
            .as_ref()
            .map(|family| family.0.0.as_str())
            .unwrap_or(&row.id.0);
        let version = row.version.as_ref().map(|version| version.0.0.as_str());
        let key = format!(
            "{}:{}:{}:{}",
            if class == Class::Current { "0" } else { "1" },
            identity_sort_key(family),
            version_key(version),
            identity_sort_key(&row.id.0)
        );
        row.sort_key = decoded_text(Some(key.get(..256).unwrap_or(&key)));
        if row.source.is_none() {
            row.source = Some(source_for(row).into());
        }
    }
}

#[cfg(test)]
mod tests {
    //! Ports the classification half of `packages/models/src/catalog-policy.test.ts`:
    //! "each family keeps its newest version current while older routes remain
    //! selectable", "Muse Spark qualifiers keep independent current versions", "a dated
    //! route is legacy only when its undated model also exists" and the provider
    //! exception "provider deprecation beats lifecycle exceptions and known exceptions
    //! can retire a unique tier".

    use super::*;
    use ace_models::instance::ModelInstance;
    use serde_json::json;

    fn row(
        provider: ProviderKind,
        id: &str,
        family: Option<&str>,
        version: Option<&str>,
    ) -> CatalogModel {
        let instance = ModelInstance::cli("account", provider, "", "/repo");
        let mut row = ace_models::row::base(&instance, id, id, &json!({}));
        row.family = family.and_then(|family| decoded_text(Some(family)));
        row.version = version.and_then(|version| decoded_text(Some(version)));
        row
    }

    fn classes(rows: &[CatalogModel]) -> Vec<(String, String)> {
        rows.iter()
            .map(|row| {
                (
                    row.id.0.clone(),
                    row.tier
                        .as_ref()
                        .map(|tier| tier.to_string())
                        .unwrap_or_default(),
                )
            })
            .collect()
    }

    #[test]
    fn each_family_keeps_its_newest_version_current_while_older_routes_stay_selectable() {
        let mut rows = vec![
            row(ProviderKind::Codex, "gpt-6", Some("gpt"), Some("6")),
            row(ProviderKind::Codex, "gpt-5.5", Some("gpt"), Some("5.5")),
            row(
                ProviderKind::Codex,
                "gpt-6.1-sol",
                Some("gpt-sol"),
                Some("6.1"),
            ),
            row(ProviderKind::Codex, "gpt-6-sol", Some("gpt-sol"), Some("6")),
            row(
                ProviderKind::Codex,
                "gpt-5.6-sol",
                Some("gpt-sol"),
                Some("5.6"),
            ),
            row(
                ProviderKind::Codex,
                "gpt-6-luna",
                Some("gpt-luna"),
                Some("6"),
            ),
        ];
        classify(&mut rows);
        let current: Vec<&str> = rows
            .iter()
            .filter(|row| {
                row.tier
                    .as_ref()
                    .is_some_and(|tier| tier.to_string() == "current")
            })
            .map(|row| row.id.0.as_str())
            .collect();
        assert_eq!(current, ["gpt-6", "gpt-6.1-sol", "gpt-6-luna"]);
        let legacy: Vec<&str> = rows
            .iter()
            .filter(|row| {
                row.tier
                    .as_ref()
                    .is_some_and(|tier| tier.to_string() == "legacy")
            })
            .map(|row| row.id.0.as_str())
            .collect();
        assert_eq!(legacy, ["gpt-5.5", "gpt-6-sol", "gpt-5.6-sol"]);
        // Sort keys start with the class, then the family, then the newest version.
        for row in &rows {
            let key = row
                .sort_key
                .as_ref()
                .map(|key| key.0.0.clone())
                .unwrap_or_default();
            let current = row
                .tier
                .as_ref()
                .is_some_and(|tier| tier.to_string() == "current");
            assert!(key.starts_with(if current { "0:" } else { "1:" }));
        }
    }

    #[test]
    fn muse_spark_qualifiers_keep_independent_current_versions() {
        let mut rows = vec![
            row(
                ProviderKind::Opencode,
                "muse-spark-1.3-contributor",
                Some("muse-spark-contributor"),
                Some("1.3"),
            ),
            row(
                ProviderKind::Opencode,
                "muse-spark-1.2-mini",
                Some("muse-spark-mini"),
                Some("1.2"),
            ),
            row(
                ProviderKind::Opencode,
                "muse-spark-1.1-mini",
                Some("muse-spark-mini"),
                Some("1.1"),
            ),
            row(
                ProviderKind::Opencode,
                "muse-spark-1.2-preview",
                Some("muse-spark-preview"),
                Some("1.2"),
            ),
        ];
        classify(&mut rows);
        let current: Vec<&str> = rows
            .iter()
            .filter(|row| {
                row.tier
                    .as_ref()
                    .is_some_and(|tier| tier.to_string() == "current")
            })
            .map(|row| row.id.0.as_str())
            .collect();
        assert_eq!(
            current,
            [
                "muse-spark-1.3-contributor",
                "muse-spark-1.2-mini",
                "muse-spark-1.2-preview"
            ]
        );
        assert_eq!(classes(&rows)[2].1, "legacy");
    }

    #[test]
    fn a_dated_route_is_legacy_only_when_its_undated_model_also_exists() {
        let mut dated_only = vec![row(
            ProviderKind::Claude,
            "claude-haiku-4-5-20251001",
            Some("claude-haiku"),
            Some("4.5"),
        )];
        dated_only[0].detail = decoded_text(Some("20251001"));
        classify(&mut dated_only);
        assert_eq!(classes(&dated_only)[0].1, "current");

        let mut together = vec![
            row(
                ProviderKind::Claude,
                "claude-haiku-4-5-20251001",
                Some("claude-haiku"),
                Some("4.5"),
            ),
            row(
                ProviderKind::Claude,
                "claude-haiku-4-5",
                Some("claude-haiku"),
                Some("4.5"),
            ),
        ];
        together[0].detail = decoded_text(Some("20251001"));
        classify(&mut together);
        assert_eq!(classes(&together)[0].1, "legacy");
        assert_eq!(classes(&together)[1].1, "current");
    }

    #[test]
    fn provider_deprecation_and_known_exceptions_retire_their_rows() {
        let mut rows = vec![
            row(
                ProviderKind::Codex,
                "gpt-5-codex-mini",
                Some("gpt-codex"),
                Some("5"),
            ),
            row(ProviderKind::Cursor, "auto", Some("auto"), Some("0")),
            row(
                ProviderKind::Cursor,
                "composer-2",
                Some("composer"),
                Some("2"),
            ),
        ];
        rows[2].deprecated = true.into();
        classify(&mut rows);
        let seen = classes(&rows);
        assert_eq!(seen[0].1, "legacy");
        assert_eq!(seen[1].1, "current");
        assert_eq!(seen[2].1, "legacy");
    }
}
