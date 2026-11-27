// SPDX-License-Identifier: Apache-2.0
//! Finding a model by the name a person typed.
//!
//! Ports `packages/models/src/model-selection.ts`'s `matchesModel` and
//! `packages/models/src/model-search.ts`: every query word must appear once (three or
//! more letters may be a prefix), versions must start in order, the maker's own route
//! ranks before a gateway's, and a tie that is not versions of one family through one
//! route is reported as ambiguous rather than guessed.

use std::sync::OnceLock;

use ace_protocol::generated::{CatalogModel, ProviderKind};

/// Whether an option id names "the default" (`default`, `default (recommended)`).
pub fn is_default_selection(id: Option<&str>) -> bool {
    static PATTERN: OnceLock<Option<regex::Regex>> = OnceLock::new();
    let pattern =
        PATTERN.get_or_init(|| regex::Regex::new(r"(?i)^default(?:\s*\(recommended\))?$").ok());
    id.map(str::trim)
        .is_some_and(|id| pattern.as_ref().is_some_and(|pattern| pattern.is_match(id)))
}

/// Whether `id` is one of the model's names (id, native id, resolved id, alias).
pub fn matches_model(row: &CatalogModel, id: &str) -> bool {
    let opencode_tail = || {
        row.provider == ProviderKind::Opencode
            && !id.contains('/')
            && row
                .id
                .0
                .split_once('/')
                .map(|(_, tail)| tail)
                .unwrap_or(&row.id.0)
                == id
    };
    row.id.0 == id
        || row.native_model_id.0 == id
        || row
            .resolved_model_id
            .as_ref()
            .is_some_and(|resolved| resolved.0.0 == id)
        || row
            .aliases
            .as_ref()
            .is_some_and(|aliases| aliases.iter().any(|alias| alias.0 == id))
        || opencode_tail()
}

/// A name's words, and its versions: runs of numbers with no word between them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parts {
    pub words: Vec<String>,
    pub versions: Vec<Vec<String>>,
}

/// "GPT-6.1 Sol" is words gpt, sol and version 6.1; "qwen3-coder:480b" has versions 3
/// and 480.
pub fn parts(text: &str) -> Parts {
    static PATTERN: OnceLock<Option<regex::Regex>> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| regex::Regex::new(r"[a-z]+|[0-9]+").ok());
    let lower = text.to_lowercase();
    let mut words = Vec::new();
    let mut versions: Vec<Vec<String>> = Vec::new();
    let mut version: Option<usize> = None;
    if let Some(pattern) = pattern {
        for token in pattern.find_iter(&lower) {
            let token = token.as_str();
            if token.starts_with(|c: char| c.is_ascii_alphabetic()) {
                words.push(token.to_owned());
                version = None;
            } else if let Some(at) = version {
                versions[at].push(token.to_owned());
            } else {
                versions.push(vec![token.to_owned()]);
                version = Some(versions.len() - 1);
            }
        }
    }
    Parts { words, versions }
}

fn starts_with_version(version: &[String], prefix: &[String]) -> bool {
    prefix.len() <= version.len()
        && prefix
            .iter()
            .zip(version)
            .all(|(number, other)| number == other)
}

/// How far one name is from the query, or `None` when the query asks for something it
/// lacks. Each extra word in the name costs one; extra numbers count only when the
/// query names a version.
fn distance(query: &Parts, name: &str) -> Option<f64> {
    let Parts { words, versions } = parts(name);
    let mut used = vec![false; words.len()];
    let mut cost = 0.0;
    for word in &query.words {
        let exact = words
            .iter()
            .enumerate()
            .position(|(at, candidate)| !used[at] && candidate == word);
        let index = match exact {
            Some(index) => index,
            None if word.chars().count() >= 3 => {
                let found = words
                    .iter()
                    .enumerate()
                    .position(|(at, candidate)| !used[at] && candidate.starts_with(word));
                match found {
                    Some(index) => {
                        cost += 0.25;
                        index
                    }
                    None => return None,
                }
            }
            None => return None,
        };
        used[index] = true;
    }
    cost += used.iter().filter(|taken| !**taken).count() as f64;
    let mut next = 0;
    let mut matched = 0;
    for wanted in &query.versions {
        let at = versions
            .iter()
            .enumerate()
            .position(|(index, version)| index >= next && starts_with_version(version, wanted))?;
        next = at + 1;
        matched += wanted.len();
    }
    if !query.versions.is_empty() {
        cost += (versions.iter().map(Vec::len).sum::<usize>() - matched) as f64;
    }
    Some(cost)
}

/// -1 for an exact id or alias, else the nearest of the model's names.
fn score_row(model: &CatalogModel, raw: &str, query: &Parts) -> Option<f64> {
    if matches_model(model, raw) {
        return Some(-1.0);
    }
    let mut best: Option<f64> = None;
    let mut names = vec![
        model.id.0.clone(),
        model.display_name.0.clone(),
        model.native_model_id.0.clone(),
    ];
    if let Some(resolved) = &model.resolved_model_id {
        names.push(resolved.0.0.clone());
    }
    if let Some(aliases) = &model.aliases {
        names.extend(aliases.iter().map(|alias| alias.0.clone()));
    }
    for name in names {
        let routed = name.rfind('/');
        let candidates: [&str; 2] = match routed {
            Some(at) => [name.as_str(), &name[at + 1..]],
            None => [name.as_str(), ""],
        };
        let count = if routed.is_some() { 2 } else { 1 };
        for candidate in &candidates[..count] {
            if let Some(found) = distance(query, candidate)
                && best.is_none_or(|best| found < best)
            {
                best = Some(found);
            }
        }
    }
    // A model served through a gateway ("openai-codex/gpt-6.1-sol") ranks after the
    // same model from the provider that makes it.
    best.map(|best| best + if model.id.0.contains('/') { 0.5 } else { 0.0 })
}

fn legacy(model: &CatalogModel) -> bool {
    model
        .tier
        .as_ref()
        .is_some_and(|tier| tier.to_string() == "legacy")
        || model.legacy.as_ref().is_some_and(|legacy| legacy.0)
        || model
            .group
            .as_ref()
            .is_some_and(|group| group.to_string() == "legacy")
}

/// Catalog rows whose names fit `query`, nearest first. Ties keep current models
/// before legacy ones, then the catalog's own order.
pub fn search_models<'a>(models: &'a [CatalogModel], query: &str) -> Vec<&'a CatalogModel> {
    let tokens = parts(query);
    if tokens.words.is_empty() && tokens.versions.is_empty() {
        return Vec::new();
    }
    let raw = query.trim();
    let mut scored: Vec<(usize, f64, &CatalogModel)> = models
        .iter()
        .enumerate()
        .filter_map(|(order, model)| {
            score_row(model, raw, &tokens).map(|score| (order, score, model))
        })
        .collect();
    scored.sort_by(|(order_a, score_a, model_a), (order_b, score_b, model_b)| {
        score_a
            .partial_cmp(score_b)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| legacy(model_a).cmp(&legacy(model_b)))
            .then_with(
                || match (model_a.sort_key.as_ref(), model_b.sort_key.as_ref()) {
                    (Some(key_a), Some(key_b)) => locale_compare(&key_a.0, &key_b.0),
                    _ => std::cmp::Ordering::Equal,
                },
            )
            .then_with(|| order_a.cmp(order_b))
    });
    scored.into_iter().map(|(_, _, model)| model).collect()
}

fn collator() -> Option<&'static icu_collator::CollatorBorrowed<'static>> {
    static COLLATOR: OnceLock<Option<icu_collator::CollatorBorrowed<'static>>> = OnceLock::new();
    COLLATOR
        .get_or_init(|| {
            let preferences: icu_collator::CollatorPreferences =
                icu_locale_core::locale!("en").into();
            icu_collator::CollatorBorrowed::try_new(
                preferences,
                icu_collator::options::CollatorOptions::default(),
            )
            .ok()
        })
        .as_ref()
}

/// `String.prototype.localeCompare(other, "en")`, as the catalog uses it.
///
/// The catalog orders rows and search ties with ICU's `en` collation; this is that
/// collation (ICU4X's compiled `en` data), not a table of punctuation ranks. When the
/// compiled data cannot load, byte order keeps the catalog deterministic.
pub fn locale_compare(a: &str, b: &str) -> std::cmp::Ordering {
    match collator() {
        Some(collator) => collator.compare(a, b),
        None => a.cmp(b),
    }
}

/// The upstream a model is served through: its native provider, or its id's route prefix.
fn route(model: &CatalogModel) -> &str {
    if let Some(provider) = model.native_provider_id.as_ref() {
        return &provider.0;
    }
    model
        .id
        .0
        .rfind('/')
        .map(|at| &model.id.0[..at])
        .unwrap_or("")
}

/// What a name means: one model, several equally near options, or nothing.
#[derive(Debug, Clone)]
pub enum ModelNameMatch<'a> {
    Match(&'a CatalogModel),
    Ambiguous(Vec<&'a CatalogModel>),
    None,
}

/// The one model a name means. Several equally near models resolve only when they are
/// versions of one family from one provider; otherwise the caller gets the options.
pub fn resolve_model_name<'a>(models: &'a [CatalogModel], query: &str) -> ModelNameMatch<'a> {
    let found = search_models(models, query);
    let Some(first) = found.first().copied() else {
        return ModelNameMatch::None;
    };
    let tokens = parts(query);
    let raw = query.trim();
    let Some(nearest) = score_row(first, raw, &tokens) else {
        return ModelNameMatch::None;
    };
    let mut options: Vec<&CatalogModel> = Vec::new();
    let mut keys: Vec<String> = Vec::new();
    for model in &found {
        if score_row(model, raw, &tokens) != Some(nearest) {
            break;
        }
        let key = format!("{}\u{0}{}", model.provider, model.id.0);
        if !keys.contains(&key) {
            keys.push(key);
            options.push(*model);
        }
    }
    let one_family = first.family.is_some()
        && options.iter().all(|model| {
            model.provider == first.provider
                && model.family.as_ref().map(|family| family.0.0.as_str())
                    == first.family.as_ref().map(|family| family.0.0.as_str())
                && route(model) == route(first)
        });
    if options.len() == 1 || one_family {
        ModelNameMatch::Match(first)
    } else {
        ModelNameMatch::Ambiguous(options)
    }
}

/// The model's sort key, for callers that order a page themselves.
pub fn sort_key(model: &CatalogModel) -> Option<&str> {
    model.sort_key.as_ref().map(|key| key.0.as_str())
}

#[cfg(test)]
mod tests {
    //! Ports `packages/models/src/model-search.test.ts` in full.

    use super::*;
    use serde_json::json;

    struct Spec<'a> {
        provider: ProviderKind,
        id: &'a str,
        display: &'a str,
        family: Option<&'a str>,
        tier: Option<&'a str>,
        instance: &'a str,
        native_provider: Option<&'a str>,
    }

    fn row(spec: Spec<'_>) -> CatalogModel {
        let instance =
            crate::instance::ModelInstance::cli(spec.instance, spec.provider, "", "/repo");
        let raw = json!({ "future": true });
        let mut model = crate::row::base(&instance, spec.id, spec.display, &raw);
        model.display_name = spec.display.to_owned().into();
        model.family = spec
            .family
            .and_then(|family| crate::row::decoded_text(Some(family)));
        model.tier = spec.tier.and_then(|tier| tier.parse().ok());
        model.native_provider_id = spec
            .native_provider
            .and_then(|provider| crate::row::decoded_text(Some(provider)));
        model
    }

    fn simple(provider: ProviderKind, id: &str, display: &str) -> CatalogModel {
        row(Spec {
            provider,
            id,
            display,
            family: None,
            tier: None,
            instance: &format!("{provider}-cli-default"),
            native_provider: None,
        })
    }

    fn catalog() -> Vec<CatalogModel> {
        vec![
            row(Spec {
                provider: ProviderKind::Claude,
                id: "claude-opus-5-5",
                display: "Opus 5.5",
                family: Some("claude-opus"),
                tier: Some("current"),
                instance: "claude-cli-default",
                native_provider: None,
            }),
            row(Spec {
                provider: ProviderKind::Claude,
                id: "claude-sonnet-5-5",
                display: "Sonnet 5.5",
                family: Some("claude-sonnet"),
                tier: Some("current"),
                instance: "claude-cli-default",
                native_provider: None,
            }),
            row(Spec {
                provider: ProviderKind::Claude,
                id: "claude-opus-5",
                display: "Opus 5",
                family: Some("claude-opus"),
                tier: Some("legacy"),
                instance: "claude-cli-default",
                native_provider: None,
            }),
            row(Spec {
                provider: ProviderKind::Claude,
                id: "claude-opus-4-8",
                display: "Opus 4.8",
                family: Some("claude-opus"),
                tier: Some("legacy"),
                instance: "claude-cli-default",
                native_provider: None,
            }),
            row(Spec {
                provider: ProviderKind::Claude,
                id: "claude-opus-4-7",
                display: "Opus 4.7",
                family: Some("claude-opus"),
                tier: Some("legacy"),
                instance: "claude-cli-default",
                native_provider: None,
            }),
            simple(ProviderKind::Codex, "gpt-6.1-sol", "GPT-6.1 Sol"),
            simple(ProviderKind::Codex, "gpt-6-luna", "GPT-6 Luna"),
            simple(ProviderKind::Codex, "gpt-6-astra", "GPT-6 Astra"),
            simple(ProviderKind::Pi, "openai-codex/gpt-6.1-sol", "GPT-6.1 Sol"),
            simple(
                ProviderKind::Opencode,
                "opencode-go/muse-spark-1.3-contributor",
                "Muse Spark 1.3 Contributor",
            ),
            simple(
                ProviderKind::Opencode,
                "opencode/muse-spark-1.3",
                "Muse Spark 1.3",
            ),
        ]
    }

    fn chosen(models: &[CatalogModel], name: &str) -> String {
        match resolve_model_name(models, name) {
            ModelNameMatch::Match(model) => model.id.0.clone(),
            ModelNameMatch::Ambiguous(_) => "ambiguous".into(),
            ModelNameMatch::None => "none".into(),
        }
    }

    #[test]
    fn sort_keys_order_the_way_the_typescripts_locale_compare_does() {
        use std::cmp::Ordering::{Equal, Greater, Less};
        // Measured with Node's String.prototype.localeCompare (default locale).
        let cases = [
            ("a-b", "ab", Less),
            ("ab", "a-b", Greater),
            ("Opus", "opus", Greater),
            ("opus", "Opus", Less),
            ("gpt-6-1-sol", "gpt-6.1-sol", Less),
            ("a b", "ab", Less),
            ("a_b", "ab", Less),
            ("a", "a-", Less),
            ("10", "9", Less),
            ("a", "1", Greater),
            ("0:Opus", "0:opus", Greater),
            ("0:opus", "0:Opus", Less),
            ("same", "same", Equal),
        ];
        for (a, b, expected) in cases {
            assert_eq!(locale_compare(a, b), expected, "{a} vs {b}");
        }
    }

    #[test]
    fn every_printable_ascii_pair_and_the_accents_order_as_icue_en_does() {
        // Generated with Node 26: `[...all].sort((a, b) => a.localeCompare(b, "en"))`
        // over every printable ASCII character, `-a _a .a :a /a  a +a`, suffix
        // variants, numeric runs, prefixes and accents. ICU's order is the fixture;
        // the Rust collation must reproduce it, not a hand-written rank table.
        const EXPECTED: &str = r#" \0 a\0_\0_a\0-\0-a\0,\0;\0:\0:a\0!\0?\0.\0.a\0'\0"\0(\0)\0[\0]\0{\0}\0@\0*\0/\0/a\0\\0&\0#\0%\0`\0^\0+\0+a\0<\0=\0>\0|\0~\0$\00\01\02\03\04\05\06\07\08\09\0a\0A\0å\0Å\0ä\0Ä\0a \0a_\0a_1\0a-\0a-1\0a:\0a:1\0a.\0a.1\0a+\0a01\0a02\0a1\0A1\0a10\0a2\0aa\0aA\0Aa\0AA\0æ\0Æ\0b\0B\0c\0C\0ç\0Ç\0d\0D\0dis_count\0dis-count\0discount\0e\0E\0é\0É\0f\0F\0g\0G\0h\0H\0i\0I\0í\0Í\0j\0J\0k\0K\0l\0L\0m\0M\0n\0N\0ñ\0Ñ\0o\0O\0ó\0Ó\0ø\0Ø\0œ\0Œ\0p\0P\0q\0Q\0r\0R\0s\0S\0ß\0t\0T\0u\0U\0ú\0Ú\0ü\0Ü\0v\0V\0w\0W\0x\0X\0y\0Y\0z\0Z\0ω\0Ω\0中\0日"#;
        let expected: Vec<&str> = EXPECTED.split("\\0").collect();
        for pair in expected.windows(2) {
            assert_eq!(
                locale_compare(pair[0], pair[1]),
                std::cmp::Ordering::Less,
                "{:?} before {:?}",
                pair[0],
                pair[1]
            );
        }
        let mut shuffled: Vec<&str> = expected.iter().rev().copied().collect();
        shuffled.sort_by(|a, b| locale_compare(a, b));
        assert_eq!(shuffled, expected);
        assert_eq!(
            locale_compare("qwen3-coder:480b", "qwen3-coder.480b"),
            std::cmp::Ordering::Less
        );
        assert_eq!(locale_compare("_", "-"), std::cmp::Ordering::Less);
        assert_eq!(locale_compare(" ", "+"), std::cmp::Ordering::Less);
        // The structural case the recheck named: once its letters match, the shorter
        // string sorts first, whatever its case.
        assert_eq!(locale_compare("A", "a-"), std::cmp::Ordering::Less);
        assert_eq!(locale_compare("a", "a-"), std::cmp::Ordering::Less);
        assert_eq!(locale_compare("a_b", "a-b"), std::cmp::Ordering::Less);
        assert_eq!(locale_compare("a.", "a:"), std::cmp::Ordering::Greater);
        assert_eq!(locale_compare("a+b", "a b"), std::cmp::Ordering::Greater);
        assert_eq!(locale_compare("café", "caff"), std::cmp::Ordering::Less);
    }

    #[test]
    fn equal_scores_order_by_the_sort_key_with_locale_rules() {
        let mut lower = simple(ProviderKind::Codex, "gpt-6-sol", "GPT-6 Sol");
        lower.sort_key = crate::row::decoded_text(Some("0:opus"));
        let mut upper = simple(ProviderKind::Codex, "gpt-6-sol", "GPT-6 Sol");
        upper.sort_key = crate::row::decoded_text(Some("0:Opus"));
        let models = [upper, lower];
        let rows = search_models(&models, "sol");
        let keys: Vec<&str> = rows
            .iter()
            .filter_map(|model| model.sort_key.as_ref().map(|key| key.0.as_str()))
            .collect();
        assert_eq!(keys, ["0:opus", "0:Opus"]);
    }

    #[test]
    fn a_family_name_without_a_version_means_the_newest_current_model_of_that_family() {
        let models = catalog();
        assert_eq!(chosen(&models, "opus"), "claude-opus-5-5");
        assert_eq!(chosen(&models, "Sonnet"), "claude-sonnet-5-5");
    }

    #[test]
    fn a_written_version_picks_that_version_not_a_longer_one_that_contains_it() {
        let models = catalog();
        assert_eq!(chosen(&models, "opus 5.5"), "claude-opus-5-5");
        assert_eq!(chosen(&models, "Opus 5"), "claude-opus-5");
        assert_eq!(chosen(&models, "opus 4"), "claude-opus-4-8");
    }

    #[test]
    fn a_version_is_read_in_order_and_from_its_start_never_as_loose_numbers() {
        let older = [simple(ProviderKind::Claude, "claude-opus-4-5", "Opus 4.5")];
        assert!(matches!(
            resolve_model_name(&older, "opus 5.4"),
            ModelNameMatch::None
        ));
        assert!(matches!(
            resolve_model_name(&older, "opus 5"),
            ModelNameMatch::None
        ));
        let models = catalog();
        assert_eq!(chosen(&models, "opus 8"), "none");
        assert_eq!(chosen(&models, "opus 4.8"), "claude-opus-4-8");
    }

    #[test]
    fn spacing_case_and_punctuation_do_not_matter() {
        let models = catalog();
        assert_eq!(chosen(&models, "gpt 6.1 sol"), "gpt-6.1-sol");
        assert_eq!(chosen(&models, "GPT6.1-Sol"), "gpt-6.1-sol");
    }

    #[test]
    fn the_makers_own_model_ranks_before_the_same_model_through_a_gateway() {
        let models = catalog();
        match resolve_model_name(&models, "gpt 6.1 sol") {
            ModelNameMatch::Match(model) => assert_eq!(model.provider, ProviderKind::Codex),
            other => panic!("expected a match, got {other:?}"),
        }
    }

    #[test]
    fn the_plainest_name_wins_over_variants_with_extra_words() {
        let models = catalog();
        assert_eq!(chosen(&models, "muse spark"), "opencode/muse-spark-1.3");
        assert_eq!(
            chosen(&models, "muse spark contributor"),
            "opencode-go/muse-spark-1.3-contributor"
        );
    }

    #[test]
    fn a_word_may_be_the_start_of_a_longer_one() {
        let models = catalog();
        assert_eq!(chosen(&models, "sonn 5.5"), "claude-sonnet-5-5");
    }

    #[test]
    fn a_name_that_fits_different_models_equally_is_ambiguous_with_every_option_named() {
        let models = catalog();
        let found = resolve_model_name(&models, "gpt 6");
        let mut ids: Vec<&str> = match &found {
            ModelNameMatch::Ambiguous(options) => {
                options.iter().map(|model| model.id.0.as_str()).collect()
            }
            other => panic!("expected ambiguous, got {other:?}"),
        };
        ids.sort_unstable();
        assert_eq!(ids, ["gpt-6-astra", "gpt-6-luna"]);
    }

    #[test]
    fn a_name_no_model_fits_finds_nothing() {
        let models = catalog();
        assert_eq!(chosen(&models, "gemini"), "none");
        assert_eq!(chosen(&models, "opus 9"), "none");
        assert!(search_models(&models, "  ---  ").is_empty());
    }

    #[test]
    fn search_lists_the_nearest_models_first_one_row_per_account() {
        let mut models = catalog();
        let mut second = simple(ProviderKind::Codex, "gpt-6.1-sol", "GPT-6.1 Sol");
        second.instance = "account-346".to_owned().into();
        models.push(second);
        let found: Vec<&str> = search_models(&models, "sol")
            .iter()
            .map(|model| model.instance.0.as_str())
            .collect();
        let mut first_two = found[..2].to_vec();
        first_two.sort_unstable();
        assert_eq!(first_two, ["account-346", "codex-cli-default"]);
        assert_eq!(found.last(), Some(&"pi-cli-default"));
    }

    #[test]
    fn the_same_model_through_two_upstream_routes_is_ambiguous_never_a_silent_pick() {
        let routes = [
            row(Spec {
                provider: ProviderKind::Opencode,
                id: "openai/gpt-6.1-sol",
                display: "GPT-6.1 Sol",
                family: Some("gpt-6.1"),
                tier: None,
                instance: "opencode",
                native_provider: Some("openai"),
            }),
            row(Spec {
                provider: ProviderKind::Opencode,
                id: "azure/gpt-6.1-sol",
                display: "GPT-6.1 Sol",
                family: Some("gpt-6.1"),
                tier: None,
                instance: "opencode",
                native_provider: Some("azure"),
            }),
        ];
        let found = resolve_model_name(&routes, "gpt 6.1 sol");
        let mut ids: Vec<&str> = match &found {
            ModelNameMatch::Ambiguous(options) => {
                options.iter().map(|model| model.id.0.as_str()).collect()
            }
            other => panic!("expected ambiguous, got {other:?}"),
        };
        ids.sort_unstable();
        assert_eq!(ids, ["azure/gpt-6.1-sol", "openai/gpt-6.1-sol"]);
    }

    #[test]
    fn versions_of_one_family_through_one_route_still_resolve_to_the_newest() {
        let versions = [
            row(Spec {
                provider: ProviderKind::Opencode,
                id: "anthropic/claude-opus-5-5",
                display: "Opus 5.5",
                family: Some("claude-opus"),
                tier: None,
                instance: "opencode",
                native_provider: Some("anthropic"),
            }),
            row(Spec {
                provider: ProviderKind::Opencode,
                id: "anthropic/claude-opus-4-8",
                display: "Opus 4.8",
                family: Some("claude-opus"),
                tier: Some("legacy"),
                instance: "opencode",
                native_provider: Some("anthropic"),
            }),
        ];
        match resolve_model_name(&versions, "opus") {
            ModelNameMatch::Match(model) => {
                assert_eq!(model.id.0, "anthropic/claude-opus-5-5")
            }
            other => panic!("expected a match, got {other:?}"),
        }
        let another = row(Spec {
            provider: ProviderKind::Opencode,
            id: "vertex/claude-opus-5-5",
            display: "Opus 5.5",
            family: Some("claude-opus"),
            tier: None,
            instance: "opencode",
            native_provider: Some("vertex"),
        });
        assert!(matches!(
            resolve_model_name(&[versions[0].clone(), versions[1].clone(), another], "opus"),
            ModelNameMatch::Ambiguous(_)
        ));
    }
}
