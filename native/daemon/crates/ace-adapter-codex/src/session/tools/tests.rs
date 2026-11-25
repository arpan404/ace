// SPDX-License-Identifier: Apache-2.0
//! The moved (b) cases of `tool-search.test.ts` and `tool-facts.test.ts`
//! (behaviour.md section 19).

use std::collections::VecDeque;

use ace_json::Value;

use super::cache::CodexCatalogCache;
use super::read::{ToolFactsOutcome, ToolFactsRead};
use super::*;
use crate::session::frames::{Calls, Effect};

/// Facts from a readable config with Codex's own catalog, unless the case says
/// otherwise (`tool-search.test.ts`'s helper, whose spread comes second).
fn listing(facts: CodexToolFacts) -> ToolListing {
    let catalog_source = facts.catalog_source.or(Some(CatalogSource::Codex));
    codex_tool_listing(&CodexToolFacts {
        catalog_source,
        ..facts
    })
}

/// Slugs as Codex 0.163.0's bundled catalog lists them.
fn catalog() -> Vec<String> {
    [
        "gpt-6.1-sol",
        "gpt-6-sol",
        "gpt-5.6-sol",
        "gpt-5.6-luna",
        "gpt-5.5",
    ]
    .iter()
    .map(|slug| (*slug).to_owned())
    .collect()
}

fn model(name: &str) -> Option<String> {
    Some(name.to_owned())
}

fn features(json: &str) -> Option<Value> {
    Some(ace_json::parse(json).expect("fixture parses"))
}

#[test]
fn a_catalog_model_keeps_every_ace_tool_listed_since_codex_defers_them_behind_its_search() {
    let cases = [
        (model("gpt-6.1-sol"), ToolListing::All),
        // Codex matches the longest slug a model name starts with, so dated
        // variants count too.
        (model("gpt-5.5-2026-09-01"), ToolListing::All),
        // And once more after a single provider namespace.
        (model("openrouter/gpt-5.6-sol"), ToolListing::All),
    ];
    for (name, expected) in cases {
        assert_eq!(
            listing(CodexToolFacts {
                model: name,
                catalog: Some(catalog()),
                ..CodexToolFacts::default()
            }),
            expected
        );
    }
}

#[test]
fn codexs_own_default_model_is_a_catalog_model() {
    assert_eq!(
        listing(CodexToolFacts {
            catalog: Some(catalog()),
            ..CodexToolFacts::default()
        }),
        ToolListing::All
    );
    assert_eq!(listing(CodexToolFacts::default()), ToolListing::All);
}

#[test]
fn a_model_outside_codexs_catalog_gets_the_fixed_list_since_codex_would_load_every_tool_upfront() {
    let cases = [
        ("gpt-oss:20b", "ollama"),
        ("qwen3-coder", "lmstudio"),
        // Only one simple namespace segment is stripped before matching.
        ("a/b/gpt-5.5", ""),
        ("my.gateway/gpt-5.5", ""),
    ];
    for (name, provider) in cases {
        assert_eq!(
            listing(CodexToolFacts {
                model: model(name),
                provider: (!provider.is_empty()).then(|| provider.to_owned()),
                catalog: Some(catalog()),
                ..CodexToolFacts::default()
            }),
            ToolListing::Static,
            "{name}"
        );
    }
}

#[test]
fn bedrock_runtime_turns_search_off_for_every_model_its_default_included() {
    assert_eq!(
        listing(CodexToolFacts {
            model: model("us.openai.gpt-6.1-sol"),
            provider: Some(BEDROCK_RUNTIME.to_owned()),
            catalog: Some(vec!["us.openai.gpt-6.1-sol".to_owned()]),
            ..CodexToolFacts::default()
        }),
        ToolListing::Static
    );
    assert_eq!(
        listing(CodexToolFacts {
            provider: Some(BEDROCK_RUNTIME.to_owned()),
            ..CodexToolFacts::default()
        }),
        ToolListing::Static
    );
    // Bedrock through Mantle uses Codex's own model metadata, which searches.
    assert_eq!(
        listing(CodexToolFacts {
            model: model("openai.gpt-6.1-sol"),
            provider: Some("amazon-bedrock".to_owned()),
            catalog: Some(vec!["openai.gpt-6.1-sol".to_owned()]),
            ..CodexToolFacts::default()
        }),
        ToolListing::All
    );
}

#[test]
fn strict_third_party_code_mode_keeps_ace_deferred_without_search_only_on_a_code_mode_only_turn() {
    let strict = features("{\"code_mode_only\":true,\"code_mode_only_strict_3p_tools\":true}");
    assert_eq!(
        listing(CodexToolFacts {
            model: model("gpt-oss:20b"),
            catalog: Some(catalog()),
            features: strict.clone(),
            ..CodexToolFacts::default()
        }),
        ToolListing::All
    );
    assert_eq!(
        listing(CodexToolFacts {
            model: model("gpt-oss:20b"),
            catalog: Some(catalog()),
            features: features("{\"code_mode_only_strict_3p_tools\":true}"),
            ..CodexToolFacts::default()
        }),
        ToolListing::Static
    );
    // Bedrock Runtime's models are code-mode-only by their own metadata.
    assert_eq!(
        listing(CodexToolFacts {
            provider: Some(BEDROCK_RUNTIME.to_owned()),
            features: features("{\"code_mode_only_strict_3p_tools\":true}"),
            ..CodexToolFacts::default()
        }),
        ToolListing::All
    );
}

#[test]
fn an_unread_catalog_keeps_every_tool_listed_rather_than_guessing() {
    assert_eq!(
        listing(CodexToolFacts {
            model: model("gpt-oss:20b"),
            provider: Some("ollama".to_owned()),
            ..CodexToolFacts::default()
        }),
        ToolListing::All
    );
}

#[test]
fn a_providers_own_catalog_url_matches_only_the_exact_slug_so_a_dated_variant_loads_every_tool() {
    let facts = |name: &str| CodexToolFacts {
        model: model(name),
        provider: Some("custom".to_owned()),
        catalog_source: Some(CatalogSource::Provider),
        catalog: Some(vec!["custom-model".to_owned()]),
        ..CodexToolFacts::default()
    };
    assert_eq!(
        listing(facts("custom-model-2026-10-27")),
        ToolListing::Static
    );
    assert_eq!(
        listing(facts("openrouter/custom-model")),
        ToolListing::Static
    );
}

#[test]
fn a_model_a_custom_catalog_lists_keeps_every_tool_listed_since_its_search_support_is_not_visible()
{
    assert_eq!(
        listing(CodexToolFacts {
            model: model("custom-model"),
            provider: Some("custom".to_owned()),
            catalog_source: Some(CatalogSource::Provider),
            catalog: Some(vec!["custom-model".to_owned()]),
            ..CodexToolFacts::default()
        }),
        ToolListing::All
    );
    // A catalog file matches by prefix, as Codex's own does, but its metadata
    // is custom.
    let file = |name: &str| CodexToolFacts {
        model: model(name),
        catalog_source: Some(CatalogSource::File),
        catalog: Some(vec!["local-coder".to_owned()]),
        ..CodexToolFacts::default()
    };
    assert_eq!(listing(file("local-coder-7b")), ToolListing::All);
    assert_eq!(listing(file("other-model")), ToolListing::Static);
    // The default model of a custom catalog is one of its own entries.
    assert_eq!(
        listing(CodexToolFacts {
            catalog_source: Some(CatalogSource::Provider),
            provider: Some("custom".to_owned()),
            ..CodexToolFacts::default()
        }),
        ToolListing::All
    );
}

#[test]
fn an_unread_config_keeps_every_tool_listed_whatever_the_catalog() {
    assert_eq!(
        codex_tool_listing(&CodexToolFacts {
            model: model("gpt-oss:20b"),
            catalog: Some(catalog()),
            ..CodexToolFacts::default()
        }),
        ToolListing::All
    );
}

#[test]
fn a_catalog_slug_is_bounded_in_utf16_code_units_as_zod_counts_them() {
    // 400 CJK characters: 400 UTF-16 code units, 1,200 UTF-8 bytes.
    let slug = "\u{6f22}".repeat(400);
    let mut calls = Calls::new();
    let (mut pager, _) = super::catalog::Pager::start(&mut calls, None);
    let page = ace_json::parse(&format!(
        "{{\"data\":[{{\"id\":\"{slug}\",\"model\":\"{slug}\"}}]}}"
    ))
    .expect("fixture parses");
    assert!(pager.page(&mut calls, Some(&page)).is_empty());
    assert_eq!(pager.done, Some(Some(vec![slug.clone(), slug.clone()])));
    let mut calls = Calls::new();
    let (mut pager, _) = super::catalog::Pager::start(&mut calls, None);
    let too_long = "\u{6f22}".repeat(513);
    let page = ace_json::parse(&format!(
        "{{\"data\":[{{\"id\":\"{too_long}\",\"model\":\"{too_long}\"}}]}}"
    ))
    .expect("fixture parses");
    assert!(pager.page(&mut calls, Some(&page)).is_empty());
    assert_eq!(pager.done, Some(None));
}

/// An app-server that answers from `config` and a one-page catalog, or never
/// when stalled (`tool-facts.test.ts`'s fake).
#[derive(Default)]
struct Server {
    config: String,
    models: Vec<String>,
    stalled: bool,
    sent: Vec<String>,
}

impl Server {
    fn new(config: &str, models: &[&str]) -> Server {
        Server {
            config: config.to_owned(),
            models: models.iter().map(|model| (*model).to_owned()).collect(),
            stalled: false,
            sent: Vec::new(),
        }
    }

    fn reply(&self, method: &str) -> Option<Value> {
        if self.stalled {
            return None;
        }
        if method == "config/read" {
            let config = ace_json::parse(&self.config).expect("fixture parses");
            return Some(
                ace_json::parse(&format!("{{\"config\":{}}}", config.to_json()))
                    .expect("fixture parses"),
            );
        }
        let data: Vec<String> = self
            .models
            .iter()
            .map(|model| format!("{{\"id\":{model:?},\"model\":{model:?}}}"))
            .collect();
        Some(
            ace_json::parse(&format!("{{\"data\":[{}]}}", data.join(","))).expect("fixture parses"),
        )
    }
}

/// Runs the machine to its outcome, answering each request from the server and
/// firing the deadline when a request is left unanswered.
fn read_with(
    server: &mut Server,
    model: Option<&str>,
    cache: &mut CodexCatalogCache,
) -> (ToolListing, ManualClock) {
    let mut time = ManualClock::default();
    let mut calls = Calls::new();
    let (mut read, effects) = ToolFactsRead::start("/work", model, cache, &mut calls, 1);
    let mut queue: VecDeque<Effect> = effects.into();
    loop {
        while let Some(effect) = queue.pop_front() {
            match effect {
                Effect::ArmTimer { key, ms } => time.arm(key, ms),
                Effect::CancelTimer { key } => time.cancel(&key),
                Effect::Request { call, method, .. } => {
                    server.sent.push(method.clone());
                    if let Some(reply) = server.reply(&method) {
                        queue.extend(read.settled(&mut calls, cache, call, Some(&reply)));
                    }
                }
                other => panic!("the facts read emitted {other:?}"),
            }
        }
        if let Some(ToolFactsOutcome::Facts(facts)) = read.outcome() {
            return (codex_tool_listing(facts), time);
        }
        if read.outcome().is_some() {
            panic!("the read was aborted");
        }
        let armed = time.advance_to_deadline();
        assert!(armed, "a settled read cancels its deadline");
        queue.extend(read.deadline(&mut calls, cache));
    }
}

/// A clock the test moves: the deadline fires when nothing else settled.
#[derive(Default)]
struct ManualClock {
    timers: Vec<(String, f64)>,
    fired: Vec<String>,
}

impl ManualClock {
    fn arm(&mut self, key: String, ms: f64) {
        self.timers.push((key, ms));
    }

    fn cancel(&mut self, key: &str) {
        self.timers.retain(|(armed, _)| armed != key);
    }

    /// Fires every armed timer, the way `advance(toolFactsDeadlineMs)` does
    /// once the deadline is due.
    fn advance_to_deadline(&mut self) -> bool {
        if self.timers.is_empty() {
            return false;
        }
        let armed: Vec<String> = self.timers.drain(..).map(|(key, _)| key).collect();
        self.fired.extend(armed);
        true
    }
}

#[test]
fn a_dated_name_under_a_providers_catalog_url_gets_the_fixed_list_as_codex_matches_it_exactly() {
    let config = "{\"model_provider\":\"custom\",\"model_providers\":{\"custom\":{\"model_catalog_url\":\"https://models.example/catalog\"}}}";
    let mut cache = CodexCatalogCache::new();
    let (listing, time) = read_with(
        &mut Server::new(config, &["custom-model"]),
        Some("custom-model-2026-10-27"),
        &mut cache,
    );
    assert_eq!(listing, ToolListing::Static);
    assert!(time.fired.is_empty());
    // The exact slug's metadata is the catalog author's, which ace cannot see.
    let mut cache = CodexCatalogCache::new();
    let (listing, _) = read_with(
        &mut Server::new(config, &["custom-model"]),
        Some("custom-model"),
        &mut cache,
    );
    assert_eq!(listing, ToolListing::All);
    // Without the URL, Codex's own catalog matches the same dated name by
    // prefix.
    let mut cache = CodexCatalogCache::new();
    let (listing, _) = read_with(
        &mut Server::new("{}", &["gpt-5.5"]),
        Some("gpt-5.5-2026-09-01"),
        &mut cache,
    );
    assert_eq!(listing, ToolListing::All);
}

#[test]
fn bedrock_runtime_decides_from_config_alone_without_reading_the_catalog() {
    let mut cache = CodexCatalogCache::new();
    let mut server = Server::new("{\"model_provider\":\"amazon-bedrock-runtime\"}", &[]);
    let (listing, _) = read_with(&mut server, None, &mut cache);
    assert_eq!(listing, ToolListing::Static);
    assert_eq!(server.sent, ["config/read"]);
}

#[test]
fn a_stalled_app_server_leaves_every_tool_listed_once_the_discovery_deadline_passes() {
    let mut cache = CodexCatalogCache::new();
    let mut server = Server::new("{}", &[]);
    server.stalled = true;
    let (listing, time) = read_with(&mut server, Some("gpt-oss:20b"), &mut cache);
    assert_eq!(listing, ToolListing::All);
    assert_eq!(time.fired, ["tool-facts:1"]);
}

#[test]
fn threads_on_one_app_server_read_its_catalog_once_and_again_when_the_config_names_another_catalog()
{
    let mut cache = CodexCatalogCache::new();
    let mut server = Server::new(
        "{\"model\":\"gpt-oss:20b\",\"model_provider\":\"ollama\"}",
        &["gpt-5.5"],
    );
    let (first, _) = read_with(&mut server, None, &mut cache);
    assert_eq!(first, ToolListing::Static);
    let (second, _) = read_with(&mut server, Some("gpt-5.5"), &mut cache);
    assert_eq!(second, ToolListing::All);
    assert_eq!(
        server
            .sent
            .iter()
            .filter(|method| *method == "model/list")
            .count(),
        1
    );
    let mut custom = Server::new(
        "{\"model_provider\":\"custom\",\"model_providers\":{\"custom\":{\"model_catalog_url\":\"https://models.example/catalog\"}}}",
        &["custom-model"],
    );
    let (third, _) = read_with(&mut custom, Some("gpt-5.5"), &mut cache);
    assert_eq!(third, ToolListing::Static);
    assert!(custom.sent.iter().any(|method| method == "model/list"));
}
