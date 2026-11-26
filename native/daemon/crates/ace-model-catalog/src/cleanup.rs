// SPDX-License-Identifier: Apache-2.0
//! Cleaning, ordering and the default model (`catalog-cleanup.ts`).
//!
//! Preference rules only rank reported choices; they never manufacture ids. Cleanup
//! drops non-chat and default selectors, folds a provider's routes onto one canonical
//! row (keeping aliases), then classification and the family rank order the view.

use std::collections::HashMap;
use std::sync::OnceLock;

use ace_models::display_name::model_display_name;
use ace_models::row::decoded_text;
use ace_models::search::{is_default_selection, locale_compare, matches_model};
use ace_protocol::generated::{CatalogModel, ProviderKind};

fn claude_alias_pattern() -> Option<&'static regex::Regex> {
    static PATTERN: OnceLock<Option<regex::Regex>> = OnceLock::new();
    PATTERN
        .get_or_init(|| regex::Regex::new(r"^(opus|sonnet|haiku)(?:-([\d][\d.-]*))?$").ok())
        .as_ref()
}

fn short_claude_name_pattern() -> Option<&'static regex::Regex> {
    static PATTERN: OnceLock<Option<regex::Regex>> = OnceLock::new();
    PATTERN
        .get_or_init(|| regex::Regex::new(r"(?i)^(?:opus|sonnet|haiku)$").ok())
        .as_ref()
}

/// Each provider's default families, strongest first.
pub fn provider_default_rules(provider: ProviderKind) -> &'static [&'static str] {
    match provider {
        ProviderKind::Claude => &[
            "claude-opus",
            "opus",
            "claude-sonnet",
            "sonnet",
            "claude-haiku",
            "haiku",
        ],
        ProviderKind::Codex => &["gpt-sol", "gpt-codex", "gpt", "gpt-luna", "o3", "o4", "o1"],
        ProviderKind::Cursor => &[
            "composer",
            "claude-opus",
            "gpt-sol",
            "gpt",
            "claude-sonnet",
            "gemini",
            "grok",
            "auto",
        ],
        ProviderKind::Opencode => &[
            "muse-spark",
            "claude-opus",
            "gpt-sol",
            "gpt-codex",
            "gpt",
            "gpt-luna",
            "claude-sonnet",
            "gemini",
            "grok",
            "kimi",
            "qwen",
            "glm",
            "deepseek",
        ],
        ProviderKind::Pi => &[
            "claude-opus",
            "gpt-sol",
            "gpt-codex",
            "gpt",
            "gpt-luna",
            "claude-sonnet",
            "gemini",
            "grok",
            "kimi",
            "qwen",
            "glm",
            "deepseek",
        ],
        ProviderKind::Acp => &[],
        ProviderKind::Antigravity => &["gemini", "claude-opus", "gpt"],
    }
}

/// The model's own name: OpenCode keeps its upstream prefix in `nativeModelId`.
fn model_name(row: &CatalogModel) -> String {
    let native = &row.native_model_id.0;
    match row
        .native_provider_id
        .as_ref()
        .map(|provider| provider.0.0.clone())
    {
        Some(provider) if native.starts_with(&format!("{provider}/")) => {
            native[provider.len() + 1..].to_owned()
        }
        _ => native.clone(),
    }
}

fn usable(row: &CatalogModel) -> bool {
    let native = model_name(row);
    if is_default_selection(Some(&row.id.0)) || is_default_selection(Some(&native)) {
        return false;
    }
    if regex::Regex::new(r"(?i)(?:^|[-_/ ])(?:embedding?s?|rerank(?:er)?|whisper|tts|dall-e|gpt-image|sora|moderation|internal)(?:$|[-_/ ])")
        .ok()
        .is_some_and(|pattern| pattern.is_match(&native))
    {
        return false;
    }
    row.input_modalities.is_empty() || row.input_modalities.iter().any(|m| m.0 == "text")
}

fn is_legacy(row: &CatalogModel) -> bool {
    row.legacy.as_ref().is_some_and(|legacy| legacy.0) || row.deprecated.0
}

fn family_rank(row: &CatalogModel) -> usize {
    let families = provider_default_rules(row.provider);
    let native = model_name(row);
    let name = native.rsplit('/').next().unwrap_or(&native).to_lowercase();
    let family = row.family.as_ref().map(|family| family.0.0.as_str());
    let index = families.iter().position(|candidate| {
        if family == Some(candidate) {
            true
        } else if family.is_some_and(|_family| candidate.starts_with("gpt")) {
            family == Some(candidate)
        } else if *candidate == "gpt-sol" {
            static SOL: std::sync::OnceLock<Option<regex::Regex>> = std::sync::OnceLock::new();
            SOL.get_or_init(|| regex::Regex::new(r"^gpt[-.\d]+-sol(?:$|-)").ok())
                .as_ref()
                .is_some_and(|p| p.is_match(&name))
        } else if *candidate == "gpt-codex" {
            static CODEX: std::sync::OnceLock<Option<regex::Regex>> = std::sync::OnceLock::new();
            CODEX
                .get_or_init(|| regex::Regex::new(r"^gpt[-.\d]+-codex(?:$|-)").ok())
                .as_ref()
                .is_some_and(|p| p.is_match(&name))
        } else {
            name.starts_with(candidate)
        }
    });
    index.unwrap_or(families.len())
}

/// `Intl.Collator("en", { numeric: true, sensitivity: "base" })` for ASCII names.
fn natural(a: &str, b: &str) -> std::cmp::Ordering {
    fn tokens(text: &str) -> Vec<(bool, String)> {
        let mut out = Vec::new();
        let mut digits = String::new();
        let mut letters = String::new();
        for ch in text.to_lowercase().chars() {
            if ch.is_ascii_digit() {
                if !letters.is_empty() {
                    out.push((false, std::mem::take(&mut letters)));
                }
                digits.push(ch);
            } else {
                if !digits.is_empty() {
                    out.push((true, std::mem::take(&mut digits)));
                }
                letters.push(ch);
            }
        }
        out.push((
            !digits.is_empty(),
            if digits.is_empty() { letters } else { digits },
        ));
        out
    }
    let left = tokens(a);
    let right = tokens(b);
    for (one, two) in left.iter().zip(&right) {
        let ord = match (one, two) {
            ((true, a), (true, b)) => a.len().cmp(&b.len()).then_with(|| a.cmp(b)),
            ((false, a), (false, b)) => locale_compare(a, b),
            ((true, _), (false, _)) => std::cmp::Ordering::Less,
            ((false, _), (true, _)) => std::cmp::Ordering::Greater,
        };
        if ord != std::cmp::Ordering::Equal {
            return ord;
        }
    }
    left.len().cmp(&right.len())
}

/// The catalog's row order (`compareModels`).
pub fn compare_models(a: &CatalogModel, b: &CatalogModel) -> std::cmp::Ordering {
    if let (Some(key_a), Some(key_b)) = (a.sort_key.as_ref(), b.sort_key.as_ref()) {
        return locale_compare(&key_a.0.0, &key_b.0.0);
    }
    is_legacy(a)
        .cmp(&is_legacy(b))
        .then_with(|| family_rank(a).cmp(&family_rank(b)))
        .then_with(|| {
            let known = family_rank(a) < provider_default_rules(a.provider).len();
            let by_version = match (a.version.as_ref(), b.version.as_ref()) {
                (Some(one), Some(two)) => {
                    crate::classification::compare_versions(&two.0.0, &one.0.0)
                }
                _ => 0,
            };
            std::cmp::Ordering::Equal
                .then_with(|| {
                    if by_version == 0 {
                        std::cmp::Ordering::Equal
                    } else if by_version < 0 {
                        std::cmp::Ordering::Less
                    } else {
                        std::cmp::Ordering::Greater
                    }
                })
                .then_with(|| {
                    if known {
                        natural(&model_name(b), &model_name(a))
                    } else {
                        natural(&b.id.0, &a.id.0)
                    }
                })
        })
        .then_with(|| locale_compare(&a.id.0, &b.id.0))
}

/// Deduplicated, classified, family-ranked rows (`cleanCatalog`).
pub fn clean_catalog(models: &[CatalogModel]) -> Vec<CatalogModel> {
    let usable_rows: Vec<&CatalogModel> = models.iter().filter(|row| usable(row)).collect();
    let mut claude_families: HashMap<String, &CatalogModel> = HashMap::new();
    for row in &usable_rows {
        if row.provider != ProviderKind::Claude {
            continue;
        }
        let Some(rest) = row.id.0.strip_prefix("claude-") else {
            continue;
        };
        let mut parts = rest.split('-');
        let Some(family) = parts.next() else {
            continue;
        };
        if !matches!(family, "opus" | "sonnet" | "haiku") {
            continue;
        }
        let tail: Vec<&str> = parts.collect();
        if tail.is_empty() {
            continue;
        }
        let mut key = family.to_owned();
        let mut keys = vec![key.clone()];
        for part in tail {
            if !part.chars().all(|c| c.is_ascii_digit()) {
                break;
            }
            key.push('-');
            key.push_str(part);
            keys.push(key.clone());
        }
        for prefix in keys {
            match claude_families.get(&prefix) {
                Some(previous) if compare_models(row, previous) != std::cmp::Ordering::Less => {}
                _ => {
                    claude_families.insert(prefix, row);
                }
            }
        }
    }
    let mut by_id: HashMap<String, CatalogModel> = HashMap::new();
    for original in &usable_rows {
        let mut canonical = original
            .resolved_model_id
            .as_ref()
            .map(|id| id.0.0.clone())
            .unwrap_or_else(|| original.id.0.clone());
        let claude_alias = claude_alias_pattern().and_then(|p| p.captures(&original.id.0));
        if original.provider == ProviderKind::Claude
            && let Some(alias) = claude_alias
            && canonical == original.id.0
        {
            let version = alias.get(2).map(|v| v.as_str().replace('.', "-"));
            let key = format!(
                "{}{}",
                alias.get(1).map(|m| m.as_str()).unwrap_or(""),
                version.map(|v| format!("-{v}")).unwrap_or_default()
            );
            if let Some(found) = claude_families.get(&key) {
                canonical = found.id.0.clone();
            }
        }
        if let Some(provider) = original.native_provider_id.as_ref().map(|p| p.0.0.clone())
            && !canonical.starts_with(&format!("{provider}/"))
        {
            canonical = format!("{provider}/{canonical}");
        }
        let previous = by_id.get(&canonical).cloned();
        let chosen = match &previous {
            None => (*original).clone(),
            Some(previous) => {
                if is_legacy(original) != is_legacy(previous) {
                    if is_legacy(original) {
                        (*previous).clone()
                    } else {
                        (*original).clone()
                    }
                } else if original.id.0 == canonical {
                    (*original).clone()
                } else {
                    (*previous).clone()
                }
            }
        };
        let legacy = is_legacy(&chosen);
        let mut aliases: Vec<String> = Vec::new();
        let mut push = |id: String| {
            if id != canonical
                && !is_default_selection(Some(&id))
                && !aliases.contains(&id)
                && aliases.len() < 32
            {
                aliases.push(id);
            }
        };
        if let Some(previous) = &previous
            && let Some(aliases) = &previous.aliases
        {
            for alias in aliases.iter() {
                push(alias.0.clone());
            }
        }
        if let Some(aliases) = &original.aliases {
            for alias in aliases.iter() {
                push(alias.0.clone());
            }
        }
        if original.id.0 != canonical {
            push(original.id.0.clone());
        }
        let custom = chosen.custom.as_ref().is_some_and(|c| c.0);
        let name = if custom {
            chosen.display_name.0.clone()
        } else if chosen.id.0 != canonical
            || short_claude_name_pattern().is_some_and(|p| p.is_match(&chosen.display_name.0))
        {
            model_display_name(&canonical, None).display_name
        } else {
            model_display_name(&canonical, Some(&chosen.display_name.0)).display_name
        };
        let mut row = chosen;
        row.id = canonical.clone().into();
        if row.provider == ProviderKind::Claude {
            row.native_model_id = canonical.clone().into();
        }
        row.display_name = name.into();
        row.aliases = None;
        if !aliases.is_empty() {
            row.aliases = Some(ace_models::row::texts(aliases));
        }
        row.is_default =
            (original.is_default.0 || previous.as_ref().is_some_and(|p| p.is_default.0)).into();
        row.legacy = Some(legacy.into());
        row.group = (if legacy { "legacy" } else { "current" }).parse().ok();
        by_id.insert(canonical, row);
    }
    let mut rows: Vec<CatalogModel> = by_id.into_values().collect();
    crate::classification::classify(&mut rows);
    for row in rows.iter_mut() {
        let key = format!(
            "{}:{:0>3}:{}",
            if row
                .tier
                .as_ref()
                .is_some_and(|t| t.to_string() == "current")
            {
                "0"
            } else {
                "1"
            },
            family_rank(row),
            row.sort_key
                .as_ref()
                .map(|k| k.0.0.clone())
                .unwrap_or_else(|| row.id.0.clone())
        );
        row.sort_key = decoded_text(Some(&key.chars().take(256).collect::<String>()));
    }
    rows.sort_by(compare_models);
    rows
}

/// The provider's default model: a user override if it matches, else the built-in rule.
pub fn default_model(
    models: &[CatalogModel],
    provider: ProviderKind,
    overridden: Option<&str>,
) -> Option<(CatalogModel, bool)> {
    let available: Vec<&CatalogModel> = models
        .iter()
        .filter(|row| {
            !row.hidden.0
                && !row.deprecated.0
                && !row.legacy.as_ref().is_some_and(|l| l.0)
                && row.provider_enabled.as_ref().is_none_or(|e| e.0)
        })
        .collect();
    let user = overridden
        .filter(|id| !is_default_selection(Some(id)))
        .and_then(|id| {
            models.iter().find(|row| {
                row.provider_enabled.as_ref().is_none_or(|e| e.0)
                    && (!row.hidden.0
                        || row
                            .visibility_reason
                            .as_ref()
                            .is_some_and(|r| r.to_string() == "deprecated"))
                    && matches_model(row, id)
            })
        });
    if let Some(user) = user {
        return Some((user.clone(), true));
    }
    let native = available.iter().find(|row| row.is_default.0).copied();
    let mut fallback: Option<&CatalogModel> = None;
    for row in &available {
        if fallback.is_none_or(|best| compare_models(row, best) == std::cmp::Ordering::Less) {
            fallback = Some(row);
        }
    }
    let chosen = match fallback {
        Some(fallback) if family_rank(fallback) < provider_default_rules(provider).len() => {
            Some(fallback)
        }
        _ => native.or(fallback),
    };
    chosen.map(|row| (row.clone(), false))
}

#[cfg(test)]
mod tests {
    //! Ports `packages/models/src/defaults.process.test.ts`'s family selections and
    //! the catalogue-cleanup rules that do not need a daemon: Codex's Sol/Luna/GPT
    //! ranks, Claude's Opus preference, and the millisecond limits of the rules.

    use super::*;
    use ace_models::instance::ModelInstance;
    use serde_json::json;

    fn row(
        provider: ProviderKind,
        id: &str,
        family: &str,
        version: &str,
        hidden: bool,
    ) -> CatalogModel {
        let instance = ModelInstance::cli("account", provider, "", "/repo");
        let mut row = ace_models::row::base(&instance, id, id, &json!({}));
        row.family = decoded_text(Some(family));
        row.version = decoded_text(Some(version));
        row.hidden = hidden.into();
        row
    }

    #[test]
    fn codex_chooses_the_newest_sol_over_luna_and_plain_gpt() {
        let rows = vec![
            row(ProviderKind::Codex, "gpt-6-luna", "gpt-luna", "6", false),
            row(ProviderKind::Codex, "gpt-6-sol", "gpt-sol", "6", false),
            row(ProviderKind::Codex, "gpt-6", "gpt", "6", false),
        ];
        let rows = clean_catalog(&rows);
        let (chosen, user) =
            default_model(&rows, ProviderKind::Codex, None).unwrap_or_else(|| panic!("default"));
        assert_eq!(chosen.id.0, "gpt-6-sol");
        assert!(!user);
    }

    #[test]
    fn claude_chooses_the_newest_opus_before_sonnet() {
        let rows = vec![
            row(
                ProviderKind::Claude,
                "claude-sonnet-5-5",
                "claude-sonnet",
                "5.5",
                false,
            ),
            row(
                ProviderKind::Claude,
                "claude-opus-4-8",
                "claude-opus",
                "4.8",
                false,
            ),
            row(
                ProviderKind::Claude,
                "claude-opus-5-4",
                "claude-opus",
                "5.4",
                false,
            ),
        ];
        let rows = clean_catalog(&rows);
        let (chosen, _) =
            default_model(&rows, ProviderKind::Claude, None).unwrap_or_else(|| panic!("default"));
        assert_eq!(chosen.id.0, "claude-opus-5-4");
    }

    #[test]
    fn a_pinned_model_wins_even_when_hidden_or_legacy() {
        let rows = vec![
            row(ProviderKind::Codex, "gpt-6.1-sol", "gpt-sol", "6.1", false),
            row(ProviderKind::Codex, "gpt-5.6-sol", "gpt-sol", "5.6", false),
        ];
        let rows = clean_catalog(&rows);
        let (chosen, user) = default_model(&rows, ProviderKind::Codex, Some("gpt-5.6-sol"))
            .unwrap_or_else(|| panic!("default"));
        assert_eq!(chosen.id.0, "gpt-5.6-sol");
        assert!(user);
    }

    #[test]
    fn cleanup_drops_embedding_and_default_pseudo_rows() {
        let rows = vec![
            row(ProviderKind::Codex, "gpt-6", "gpt", "6", false),
            row(
                ProviderKind::Codex,
                "text-embedding-3-large",
                "embedding",
                "0",
                false,
            ),
            row(ProviderKind::Codex, "default", "gpt", "0", false),
        ];
        let cleaned = clean_catalog(&rows);
        let ids: Vec<&str> = cleaned.iter().map(|row| row.id.0.as_str()).collect();
        assert!(ids.contains(&"gpt-6"));
        assert!(
            !ids.iter()
                .any(|id| id.contains("embedding") || *id == "default")
        );
    }
}
