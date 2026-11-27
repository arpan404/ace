// SPDX-License-Identifier: Apache-2.0
//! Source statuses and the refresh merge (`availability.ts`, `catalog-sources.ts`).
//!
//! A status names one source the provider reported, whether its reply is fresh or stale,
//! when it last answered, and the fixed error it carried. A refresh keeps a failed
//! source's previous rows and drops the rows of a source that authoritatively has none,
//! so one failing connection never empties another's choices.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use ace_protocol::generated::{CatalogModel, ModelSource};
use serde::{Deserialize, Serialize};

use crate::cache::CacheEntry;
use crate::failures::{
    DiscoveryError, DiscoveryFailure, ErrorContext, FailureCode, discovery_error,
};
use ace_models::source::provider_source;

/// The most rows one instance may serve (`normalize.ts`'s 512).
pub const MAX_MODELS: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceState {
    Fresh,
    Refreshing,
    Stale,
}

/// One source's reply (`ModelSourceStatus`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceStatus {
    pub source: ModelSource,
    pub status: SourceState,
    #[serde(
        rename = "lastRefreshedAt",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub last_refreshed_at: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<DiscoveryError>,
}

/// A failed source, as opposed to one that authoritatively has no models.
pub fn source_failed(status: &SourceStatus) -> bool {
    status.error.as_ref().is_some_and(|error| {
        !matches!(
            error.code,
            crate::failures::FailureCode::NoModels | crate::failures::FailureCode::NotConfigured
        )
    })
}

fn empty_source_ids(sources: Option<&[SourceStatus]>) -> Vec<&str> {
    sources
        .into_iter()
        .flatten()
        .filter(|status| {
            status.error.as_ref().is_some_and(|error| {
                matches!(
                    error.code,
                    crate::failures::FailureCode::NoModels
                        | crate::failures::FailureCode::NotConfigured
                )
            })
        })
        .map(|status| status.source.id.0.as_str())
        .collect()
}

/// Drops rows a source authoritatively reported as having no chat models.
pub fn without_empty_source_models(
    models: Vec<Arc<CatalogModel>>,
    sources: Option<&[SourceStatus]>,
) -> Vec<Arc<CatalogModel>> {
    let empty = empty_source_ids(sources);
    models
        .into_iter()
        .filter(|model| {
            let source = model.source.as_ref().map(|source| source.id.0.as_str());
            let native = model
                .native_provider_id
                .as_ref()
                .map(|provider| provider.0.0.as_str());
            !source.is_some_and(|id| empty.contains(&id))
                && !native.is_some_and(|id| empty.contains(&id))
        })
        .collect()
}

/// The rows and statuses a refresh commits (`refreshedSources`).
pub struct Refreshed {
    pub models: Vec<Arc<CatalogModel>>,
    pub sources: Vec<SourceStatus>,
}

/// Merges a discovery reply with the entry it replaces.
///
/// A source that failed keeps its previous rows; every other source's rows come from
/// this reply alone. A status that did not answer keeps its last refresh time, and one
/// that did is stamped `now`.
pub fn refreshed_sources(
    models: Vec<Arc<CatalogModel>>,
    sources: Option<&[SourceStatus]>,
    previous: Option<&CacheEntry>,
    now: f64,
) -> Refreshed {
    let failed: Vec<&str> = sources
        .into_iter()
        .flatten()
        .filter(|status| source_failed(status))
        .map(|status| status.source.id.0.as_str())
        .collect();
    let retained: Vec<Arc<CatalogModel>> = previous
        .into_iter()
        .flat_map(|entry| entry.models.iter())
        .filter(|model| {
            let id = model
                .source
                .as_ref()
                .map(|source| source.id.0.as_str())
                .or_else(|| {
                    model
                        .native_provider_id
                        .as_ref()
                        .map(|provider| provider.0.0.as_str())
                })
                .unwrap_or(&model.instance.0);
            failed.contains(&id)
        })
        .cloned()
        .collect();
    let statuses: Vec<SourceStatus> = match sources {
        Some(sources) => sources.to_vec(),
        None => {
            let mut seen = Vec::new();
            let mut statuses = Vec::new();
            for model in &models {
                let Some(source) = model.source.as_ref() else {
                    continue;
                };
                if seen.contains(&source.id.0) {
                    continue;
                }
                seen.push(source.id.0.clone());
                statuses.push(SourceStatus {
                    source: (**source).clone(),
                    status: SourceState::Fresh,
                    last_refreshed_at: None,
                    error: None,
                });
            }
            statuses
        }
    };
    // The final merge applies one eligibility rule, one dedup and one cap over the
    // HTTP catalog, the CLI supplement and the rows retained from a failed source: a
    // fresh reply wins over a retained row, and the cap drops retained rows first so a
    // healthy source is never cut for a stale one.
    let mut statuses = statuses;
    let mut seen = BTreeSet::new();
    let mut combined: Vec<Arc<CatalogModel>> = Vec::with_capacity(models.len() + retained.len());
    for model in models.into_iter().chain(retained) {
        if seen.insert(model.id.0.clone()) {
            combined.push(model);
        }
    }
    let mut cut: BTreeMap<String, ModelSource> = BTreeMap::new();
    if combined.len() > MAX_MODELS {
        for model in &combined[MAX_MODELS..] {
            let id = model
                .source
                .as_ref()
                .map(|source| source.id.0.clone())
                .or_else(|| {
                    model
                        .native_provider_id
                        .as_ref()
                        .map(|provider| provider.0.0.clone())
                })
                .unwrap_or_else(|| model.instance.0.clone());
            let source = model
                .source
                .as_ref()
                .map(|source| (**source).clone())
                .unwrap_or_else(|| provider_source(&id));
            cut.entry(id).or_insert(source);
        }
        combined.truncate(MAX_MODELS);
    }
    // Every source whose rows did not fit is reported stale, including one the reply
    // never named: its first row was cut before it could appear in a status.
    for (id, source) in cut {
        let failure = DiscoveryFailure {
            code: Some(FailureCode::ParseFailure.as_str().to_owned()),
            ..DiscoveryFailure::default()
        };
        let provider = combined
            .first()
            .map(|model| model.provider.to_string())
            .unwrap_or_default();
        let error = discovery_error(
            Some(&failure),
            FailureCode::ParseFailure,
            &ErrorContext {
                provider: (!provider.is_empty()).then_some(provider.as_str()),
                source: Some(&id),
                backend: None,
            },
        );
        match statuses.iter_mut().find(|status| status.source.id.0 == id) {
            Some(status) => {
                status.status = SourceState::Stale;
                status.error = Some(error);
            }
            None => statuses.push(SourceStatus {
                source,
                status: SourceState::Stale,
                last_refreshed_at: None,
                error: Some(error),
            }),
        }
    }
    let merged = without_empty_source_models(combined, Some(&statuses));
    let sources = statuses
        .into_iter()
        .map(|mut status| {
            status.last_refreshed_at = if source_failed(&status) {
                status
                    .last_refreshed_at
                    .or_else(|| {
                        previous
                            .and_then(|entry| entry.sources.as_ref())
                            .and_then(|sources| {
                                sources
                                    .iter()
                                    .find(|old| old.source.id.0 == status.source.id.0)
                            })
                            .and_then(|old| old.last_refreshed_at)
                    })
                    .or_else(|| previous.map(|entry| entry.refreshed_at))
            } else {
                Some(now)
            };
            status
        })
        .collect();
    Refreshed {
        models: merged,
        sources,
    }
}

#[cfg(test)]
mod tests {
    //! Ports `packages/models/src/catalog-ux.process.test.ts`'s "a failing OpenCode
    //! connection keeps its models beside healthy replacements and a source error", the
    //! authoritative-empty rule behind "a connected OpenCode source with no enabled chat
    //! models reports fresh information" (`catalog-source.process.test.ts`), and the
    //! retained-rows half of "failed refresh retains stale rows and cooldown prevents
    //! repeated probes" (`catalog.process.test.ts`).

    use super::*;
    use ace_models::instance::ModelInstance;
    use ace_models::row::base;
    use ace_models::source::model_source;
    use ace_protocol::generated::ProviderKind;
    use serde_json::json;

    fn model(route: &str, id: &str) -> Arc<CatalogModel> {
        let instance = ModelInstance::cli("opencode", ProviderKind::Opencode, "", "/repo");
        let mut row = base(&instance, &format!("{route}/{id}"), id, &json!({}));
        row.source = Some(model_source(route, id).into());
        Arc::new(row)
    }

    fn status(route: &str, error: Option<crate::failures::FailureCode>) -> SourceStatus {
        SourceStatus {
            source: model_source(route, ""),
            status: SourceState::Fresh,
            last_refreshed_at: Some(50.0),
            error: error.map(|code| DiscoveryError {
                code,
                message: "Provider could not be reached.".into(),
                hint: "Check the provider endpoint and network, then refresh models.".into(),
                action_id: None,
                severity: None,
            }),
        }
    }

    #[test]
    fn a_failing_source_keeps_its_rows_and_every_other_source_is_replaced() {
        let previous = CacheEntry {
            provider: ProviderKind::Opencode,
            instance: "opencode".into(),
            login_revision: Some("1".into()),
            revision: "r1".into(),
            refreshed_at: 10.0,
            models: vec![model("github-copilot", "gpt-6"), model("ollama", "llama3")],
            sources: Some(vec![status("github-copilot", None), status("ollama", None)]),
            permission_modes: None,
            identity_revision: None,
            connection_revision: None,
        };
        let refreshed = refreshed_sources(
            vec![model("github-copilot", "gpt-6.1")],
            Some(&[
                status("github-copilot", None),
                status("ollama", Some(crate::failures::FailureCode::Unreachable)),
            ]),
            Some(&previous),
            100.0,
        );
        let ids: Vec<&str> = refreshed
            .models
            .iter()
            .map(|model| model.id.0.as_str())
            .collect();
        assert!(ids.contains(&"github-copilot/gpt-6.1"));
        assert!(!ids.contains(&"github-copilot/gpt-6"));
        assert!(
            ids.contains(&"ollama/llama3"),
            "a failed route keeps its rows"
        );
        let ollama = refreshed
            .sources
            .iter()
            .find(|status| status.source.id.0 == "ollama")
            .unwrap_or_else(|| panic!("status"));
        assert_eq!(ollama.last_refreshed_at, Some(50.0));
        let copilot = refreshed
            .sources
            .iter()
            .find(|status| status.source.id.0 == "github-copilot")
            .unwrap_or_else(|| panic!("status"));
        assert_eq!(copilot.last_refreshed_at, Some(100.0));
    }

    #[test]
    fn a_source_with_no_models_drops_its_rows_and_older_statuses() {
        let refreshed = refreshed_sources(
            vec![model("github-copilot", "gpt-6"), model("ollama", "llama3")],
            Some(&[
                status(
                    "github-copilot",
                    Some(crate::failures::FailureCode::NoModels),
                ),
                status("ollama", None),
            ]),
            None,
            100.0,
        );
        let ids: Vec<&str> = refreshed
            .models
            .iter()
            .map(|model| model.id.0.as_str())
            .collect();
        assert_eq!(ids, vec!["ollama/llama3"]);
    }

    #[test]
    fn a_reply_without_statuses_derives_one_per_reported_source() {
        let refreshed = refreshed_sources(
            vec![model("ollama", "llama3"), model("ollama", "qwen3")],
            None,
            None,
            100.0,
        );
        assert_eq!(refreshed.sources.len(), 1);
        assert_eq!(refreshed.sources[0].source.id.0, "ollama");
        assert_eq!(refreshed.sources[0].status, SourceState::Fresh);
        assert_eq!(refreshed.sources[0].last_refreshed_at, Some(100.0));
    }
}

#[cfg(test)]
mod final_merge_tests {
    //! The one merge over the HTTP catalog, the CLI supplement and retained rows.

    use super::*;
    use ace_models::instance::ModelInstance;
    use ace_models::row::base;
    use ace_models::source::model_source;
    use ace_protocol::generated::ProviderKind;
    use serde_json::json;

    fn row(route: &str, id: &str) -> Arc<CatalogModel> {
        let instance = ModelInstance::cli("opencode", ProviderKind::Opencode, "", "/repo");
        let mut row = base(&instance, &format!("{route}/{id}"), id, &json!({}));
        row.source = Some(model_source(route, id).into());
        Arc::new(row)
    }

    fn failed(route: &str) -> SourceStatus {
        SourceStatus {
            source: model_source(route, ""),
            status: SourceState::Stale,
            last_refreshed_at: Some(10.0),
            error: Some(crate::failures::DiscoveryError {
                code: crate::failures::FailureCode::Unreachable,
                message: "Provider could not be reached.".into(),
                hint: "Check the provider endpoint and network, then refresh models.".into(),
                action_id: None,
                severity: None,
            }),
        }
    }

    fn healthy(route: &str) -> SourceStatus {
        SourceStatus {
            source: model_source(route, ""),
            status: SourceState::Fresh,
            last_refreshed_at: Some(10.0),
            error: None,
        }
    }

    #[test]
    fn a_duplicate_is_kept_once_and_the_cap_drops_retained_rows_before_fresh_ones() {
        let mut fresh: Vec<Arc<CatalogModel>> = (0..512)
            .map(|index| row("healthy", &format!("m{index}")))
            .collect();
        // The HTTP catalog and the supplement overlap on one id.
        fresh.push(fresh[0].clone());
        let previous = CacheEntry {
            provider: ProviderKind::Opencode,
            instance: "opencode".into(),
            login_revision: Some("1".into()),
            revision: "r1".into(),
            refreshed_at: 10.0,
            models: vec![row("failed", "old")],
            sources: Some(vec![healthy("healthy"), failed("failed")]),
            permission_modes: None,
            identity_revision: None,
            connection_revision: None,
        };
        let refreshed = refreshed_sources(
            fresh,
            Some(&[healthy("healthy"), failed("failed")]),
            Some(&previous),
            100.0,
        );
        assert_eq!(refreshed.models.len(), MAX_MODELS);
        let ids: Vec<&str> = refreshed
            .models
            .iter()
            .map(|model| model.id.0.as_str())
            .collect();
        assert_eq!(
            ids.iter().filter(|id| **id == "healthy/m0").count(),
            1,
            "the overlap is served once"
        );
        assert!(
            !ids.contains(&"failed/old"),
            "the cap dropped the retained row, never a fresh one"
        );
        let cut = refreshed
            .sources
            .iter()
            .find(|status| status.source.id.0 == "failed")
            .unwrap_or_else(|| panic!("failed status"));
        assert_eq!(cut.status, SourceState::Stale);
        assert!(cut.error.is_some(), "the cut source reports why");
        let kept = refreshed
            .sources
            .iter()
            .find(|status| status.source.id.0 == "healthy")
            .unwrap_or_else(|| panic!("healthy status"));
        assert_eq!(kept.status, SourceState::Fresh);
    }

    #[test]
    fn an_unseen_source_whose_first_row_was_cut_still_reports_stale() {
        let mut fresh: Vec<Arc<CatalogModel>> = (0..MAX_MODELS)
            .map(|index| row("healthy", &format!("m{index}")))
            .collect();
        fresh.push(row("unseen", "first"));
        let refreshed = refreshed_sources(fresh, Some(&[healthy("healthy")]), None, 100.0);
        assert_eq!(refreshed.models.len(), MAX_MODELS);
        assert!(
            !refreshed
                .models
                .iter()
                .any(|model| model.id.0 == "unseen/first"),
            "the unseen source's only row did not fit"
        );
        let unseen = refreshed
            .sources
            .iter()
            .find(|status| status.source.id.0 == "unseen")
            .unwrap_or_else(|| panic!("the cut source is still reported"));
        assert_eq!(unseen.status, SourceState::Stale);
        assert!(unseen.error.is_some());
    }
}
