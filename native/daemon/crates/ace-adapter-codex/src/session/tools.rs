// SPDX-License-Identifier: Apache-2.0
//! Whether Codex defers ace's tools, read before a thread starts
//! (`tool-search.ts` and `tool-facts.ts`). The search rules are pure; the read
//! is a small sans-IO machine whose two requests, its catalog pager and its
//! 2.5-second deadline are effects for the shell.

use ace_json::Value;

/// `amazon-bedrock-runtime`: its catalog turns search off for every model.
pub(crate) const BEDROCK_RUNTIME: &str = "amazon-bedrock-runtime";

/// `CodexCatalogSource`: which catalog Codex reads model metadata from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CatalogSource {
    /// Codex's own, bundled catalog.
    Codex,
    /// `model_catalog_json` from Codex's config.
    File,
    /// The active provider's `model_catalog_url`.
    Provider,
}

impl CatalogSource {
    pub fn as_str(self) -> &'static str {
        match self {
            CatalogSource::Codex => "codex",
            CatalogSource::File => "file",
            CatalogSource::Provider => "provider",
        }
    }
}

/// `CodexToolFacts`: what decides whether Codex defers ace's tools. A fact that
/// could not be read stays unknown, which keeps every tool listed.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CodexToolFacts {
    pub model: Option<String>,
    pub provider: Option<String>,
    pub catalog_source: Option<CatalogSource>,
    pub catalog: Option<Vec<String>>,
    pub features: Option<Value>,
}

/// `codexToolListing`: `All` where Codex defers (or ace could not tell),
/// `Static` where every tool would load upfront.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolListing {
    All,
    Static,
}

/// `inCodexCatalog`: the longest slug the name starts with, then after one
/// namespace segment.
pub fn in_codex_catalog(model: &str, catalog: &[String]) -> bool {
    if catalog
        .iter()
        .any(|slug| !slug.is_empty() && model.starts_with(slug.as_str()))
    {
        return true;
    }
    let Some(slash) = model.find('/').filter(|slash| *slash > 0) else {
        return false;
    };
    let namespace = &model[..slash];
    let rest = &model[slash + 1..];
    namespace
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
        && !rest.contains('/')
        && catalog
            .iter()
            .any(|slug| !slug.is_empty() && rest.starts_with(slug.as_str()))
}

/// `codexNeedsCatalog`: whether the config alone decides.
pub fn codex_needs_catalog(facts: &CodexToolFacts) -> bool {
    facts.catalog_source.is_some()
        && facts.provider.as_deref() != Some(BEDROCK_RUNTIME)
        && facts.model.is_some()
}

/// `modelSearches`: whether the turn's model has `supports_search_tool`;
/// unknown when ace cannot tell.
fn model_searches(facts: &CodexToolFacts) -> Option<bool> {
    let source = facts.catalog_source?;
    if facts.provider.as_deref() == Some(BEDROCK_RUNTIME) {
        return Some(false);
    }
    let Some(model) = facts.model.as_deref() else {
        // Codex's default model is one its catalog lists.
        return (source == CatalogSource::Codex).then_some(true);
    };
    let catalog = facts.catalog.as_ref()?;
    let found = if source == CatalogSource::Provider {
        catalog.iter().any(|slug| slug == model)
    } else {
        in_codex_catalog(model, catalog)
    };
    if !found {
        return Some(false);
    }
    (source == CatalogSource::Codex).then_some(true)
}

fn feature(facts: &CodexToolFacts, name: &str) -> bool {
    facts
        .features
        .as_ref()
        .and_then(|features| features.get(name))
        .and_then(Value::as_bool)
        == Some(true)
}

/// `codexDefersMcpTools`: true when Codex defers ace's tools for a turn on
/// this model; unknown when ace cannot tell.
pub fn codex_defers_mcp_tools(facts: &CodexToolFacts) -> Option<bool> {
    let searches = model_searches(facts);
    if searches != Some(false) {
        return searches;
    }
    let strict = feature(facts, "code_mode_only_strict_3p_tools");
    let code_mode_only =
        facts.provider.as_deref() == Some(BEDROCK_RUNTIME) || feature(facts, "code_mode_only");
    Some(strict && code_mode_only)
}

/// `codexToolListing`.
pub fn codex_tool_listing(facts: &CodexToolFacts) -> ToolListing {
    match codex_defers_mcp_tools(facts) {
        None | Some(true) => ToolListing::All,
        Some(false) => ToolListing::Static,
    }
}

pub mod cache;
pub mod catalog;
pub mod read;

pub use cache::{Cached, Catalog, CatalogSettled, CodexCatalogCache};
pub use read::{ToolFactsOutcome, ToolFactsRead};

#[cfg(test)]
mod tests;
