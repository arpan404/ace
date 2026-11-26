// SPDX-License-Identifier: Apache-2.0
//! A model's display name, family, version and snapshot detail.
//!
//! Ports `packages/models/src/display-name.ts`. A good native name survives; raw
//! ids and snapshot-bearing names go through the family formatter, whose result is
//! also the search key's sibling (see `search`).

use std::sync::OnceLock;

use regex::Regex;

fn compiled(pattern: &'static str) -> Option<&'static Regex> {
    struct Patterns {
        snapshot: Regex,
        glm_p: Regex,
        old_claude: Regex,
        claude: Regex,
        gpt: Regex,
        general: Regex,
        dash_digit: Regex,
        preview_free: Regex,
        snapshot_word: Regex,
        named_version: Regex,
        brand_split: Regex,
        gpt_space: Regex,
    }
    static PATTERNS: OnceLock<Option<Patterns>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        Some(Patterns {
            snapshot: Regex::new(
                r"(?i)[-_](20[0-9]{6}|20[0-9]{2}-[0-9]{2}-[0-9]{2}|latest|preview(?:[-_][a-z0-9]+)+|[a-f0-9]{8,})$",
            )
            .ok()?,
            glm_p: Regex::new(r"(?i)^(glm)-(\d+)p(\d+)(-|$)").ok()?,
            old_claude: Regex::new(r"(?i)^claude-(\d+(?:[.-]\d+)?)-(opus|sonnet|haiku|fable)$")
                .ok()?,
            claude: Regex::new(
                r"(?i)^(?:claude-)?(opus|sonnet|haiku|fable)(?:[- ](\d+(?:[.-]\d+)?))?$",
            )
            .ok()?,
            gpt: Regex::new(r"(?i)^gpt-(\d+(?:[.-]\d+)?)(?:-(.+))?$").ok()?,
            general: Regex::new(
                r"(?i)^(muse[-_ ]spark|composer|gemini|grok|llama|qwen|glm|mistral|codestral|kimi|deepseek|o)[-_ ]?(\d+(?:[.-]\d+)?)(.*)$",
            )
            .ok()?,
            dash_digit: Regex::new(r"\b([0-9])-([0-9])(-|$)").ok()?,
            preview_free: Regex::new(r"(?i)^preview[-_]free$").ok()?,
            snapshot_word: Regex::new(
                r"(?i)(?:20[0-9]{6}|20[0-9]{2}-[0-9]{2}-[0-9]{2}|\blatest\b|\bpreview\b|\b[a-f0-9]{8,}\b)",
            )
            .ok()?,
            named_version: Regex::new(r"(?i)(?:Opus|Sonnet|Haiku|Fable)\s+(\d+(?:\.\d+)?)")
                .ok()?,
            brand_split: Regex::new(r"[-_ ]+").ok()?,
            gpt_space: Regex::new(r"^GPT (\d)").ok()?,
        })
    });
    let patterns = patterns.as_ref()?;
    Some(match pattern {
        "snapshot" => &patterns.snapshot,
        "glm_p" => &patterns.glm_p,
        "old_claude" => &patterns.old_claude,
        "claude" => &patterns.claude,
        "gpt" => &patterns.gpt,
        "general" => &patterns.general,
        "dash_digit" => &patterns.dash_digit,
        "preview_free" => &patterns.preview_free,
        "snapshot_word" => &patterns.snapshot_word,
        "named_version" => &patterns.named_version,
        "brand_split" => &patterns.brand_split,
        "gpt_space" => &patterns.gpt_space,
        _ => return None,
    })
}

/// Internal free-preview tags are pricing metadata, never a visible snapshot label.
pub fn model_detail(detail: Option<&str>) -> Option<String> {
    let detail = detail?;
    let joined = detail
        .split(" · ")
        .filter(|part| {
            compiled("preview_free")
                .map(|pattern| !pattern.is_match(part))
                .unwrap_or(false)
        })
        .collect::<Vec<_>>()
        .join(" · ");
    (!joined.is_empty()).then_some(joined)
}

/// A model id's own name, family, version and snapshot detail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelIdentity {
    pub name: String,
    pub detail: Option<String>,
    pub family: Option<String>,
    pub version: Option<String>,
}

/// Snapshot identifiers describe an execution route, never the model's version.
pub fn model_identity(id: &str) -> ModelIdentity {
    let native = id.rsplit_once('/').map(|(_, rest)| rest).unwrap_or(id);
    let mut snapshots: Vec<String> = Vec::new();
    let mut name = native.to_owned();
    if let Some(pattern) = compiled("snapshot") {
        for _ in 0..4 {
            let Some(found) = pattern.captures(&name) else {
                break;
            };
            let (Some(whole), Some(suffix)) = (found.get(0), found.get(1)) else {
                break;
            };
            snapshots.insert(0, suffix.as_str().to_owned());
            name.truncate(whole.start());
        }
    }
    if let Some(pattern) = compiled("glm_p") {
        name = pattern.replace(&name, "$1-$2.$3$4").into_owned();
    }
    let detail = model_detail(Some(&snapshots.join(" · ")));

    let old_claude = compiled("old_claude").and_then(|pattern| pattern.captures(&name));
    let claude = compiled("claude").and_then(|pattern| pattern.captures(&name));
    let claude_parts = match (&old_claude, &claude) {
        (_, Some(found)) => Some((
            found.get(1).map(|part| part.as_str().to_owned()),
            found.get(2).map(|part| part.as_str().to_owned()),
        )),
        (Some(found), None) => Some((
            found.get(2).map(|part| part.as_str().to_owned()),
            found.get(1).map(|part| part.as_str().to_owned()),
        )),
        (None, None) => None,
    };
    if let Some((family, version)) = claude_parts
        && let Some(family) = family
    {
        let display_family = capitalize(&family);
        let family = format!("claude-{}", family.to_lowercase());
        let version = version.map(|version| version.replace('-', "."));
        let mut display = display_family;
        if let Some(version) = &version {
            display.push(' ');
            display.push_str(version);
        }
        return ModelIdentity {
            name: display,
            detail,
            family: Some(family),
            version,
        };
    }

    if let Some(found) = compiled("gpt").and_then(|pattern| pattern.captures(&name))
        && let Some(digits) = found.get(1)
    {
        let version = digits.as_str().replace('-', ".");
        let tier = found.get(2).map(|tier| tier.as_str().to_lowercase());
        let family = match tier {
            Some(tier) => format!("gpt-{tier}"),
            None => "gpt".to_owned(),
        };
        return ModelIdentity {
            name,
            detail,
            family: Some(family),
            version: Some(version),
        };
    }

    // Only recognized families get versions; numeric custom selectors stay opaque.
    // Qualifiers after the version distinguish variants, including a plain "preview".
    let general = compiled("general").and_then(|pattern| pattern.captures(&name));
    let (family, version) = match general {
        Some(found) => match (found.get(1), found.get(2), found.get(3)) {
            (Some(family), Some(version), suffix) => {
                let qualifier = suffix.map(|part| part.as_str()).unwrap_or("");
                let family = compiled("brand_split")
                    .map(|pattern| {
                        pattern
                            .replace_all(&format!("{}{}", family.as_str(), qualifier), "-")
                            .to_lowercase()
                    })
                    .unwrap_or_else(|| format!("{}{}", family.as_str(), qualifier).to_lowercase());
                (Some(family), Some(version.as_str().replace('-', ".")))
            }
            _ => (None, None),
        },
        None => (None, None),
    };
    ModelIdentity {
        name,
        detail,
        family,
        version,
    }
}

fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

fn brand(token: &str) -> Option<&'static str> {
    Some(match token.to_lowercase().as_str() {
        "gpt" => "GPT",
        "claude" => "Claude",
        "llama" => "Llama",
        "deepseek" => "DeepSeek",
        "qwen" => "Qwen",
        "glm" => "GLM",
        "grok" => "Grok",
        "gemini" => "Gemini",
        "mistral" => "Mistral",
        "codestral" => "Codestral",
        "kimi" => "Kimi",
        "mini" => "Mini",
        "nano" => "Nano",
        "api" => "API",
        "o1" => "o1",
        "o3" => "o3",
        "o4" => "o4",
        "oss" => "OSS",
        "vl" => "VL",
        "it" => "IT",
        _ => return None,
    })
}

fn upper_token(token: &str) -> bool {
    let bytes = token.as_bytes();
    match (bytes.first(), bytes.get(1)) {
        (Some(first), Some(second)) => {
            (first.is_ascii_digit() && (token[1..].contains('b') || token[1..].contains('B')))
                || (matches!(first, b'a' | b'A' | b'v' | b'V' | b'k' | b'K')
                    && second.is_ascii_digit())
        }
        _ => false,
    }
}

/// A clean display name plus the parts a picker and search read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelDisplayName {
    pub display_name: String,
    pub upstream_provider: Option<String>,
    pub detail: Option<String>,
    pub family: Option<String>,
    pub version: Option<String>,
}

/// Good native names survive; raw IDs and snapshot-bearing names use the family formatter.
pub fn model_display_name(id: &str, supplied_name: Option<&str>) -> ModelDisplayName {
    let slash = id.find('/');
    let upstream_provider = slash.map(|at| id[..at].to_owned());
    let identity = model_identity(id);
    let clean = compiled("dash_digit")
        .map(|pattern| pattern.replace_all(&identity.name, "$1.$2$3").into_owned())
        .unwrap_or_else(|| identity.name.clone());
    let derived_tokens = clean
        .split(['-', '_', ' '])
        .filter(|token| !token.is_empty())
        .map(|token| {
            brand(token).map(str::to_owned).unwrap_or_else(|| {
                if upper_token(token) {
                    token.to_uppercase()
                } else {
                    capitalize(token)
                }
            })
        })
        .collect::<Vec<_>>()
        .join(" ");
    let derived = compiled("gpt_space")
        .map(|pattern| pattern.replace(&derived_tokens, "GPT-$1").into_owned())
        .unwrap_or(derived_tokens);

    let supplied = supplied_name.map(str::trim).filter(|name| !name.is_empty());
    let tail = slash.map(|at| &id[at + 1..]).unwrap_or(id);
    let raw = supplied
        .map(|name| {
            name.to_lowercase() == id.to_lowercase() || name.to_lowercase() == tail.to_lowercase()
        })
        .unwrap_or(false);
    let snapshot = supplied
        .map(|name| {
            compiled("snapshot_word")
                .map(|pattern| pattern.is_match(name))
                .unwrap_or(false)
        })
        .unwrap_or(false);
    let named_version = supplied.and_then(|name| {
        compiled("named_version")
            .and_then(|pattern| pattern.captures(name))
            .and_then(|found| found.get(1).map(|part| part.as_str().to_owned()))
    });
    let wrong_version = identity
        .family
        .as_deref()
        .map(|family| family.starts_with("claude-"))
        .unwrap_or(false)
        && named_version.is_some()
        && named_version != identity.version;
    let lowercase = supplied
        .map(|name| name == name.to_lowercase())
        .unwrap_or(false);
    let display_name = match supplied {
        Some(name) if !raw && !snapshot && !wrong_version && !lowercase => name.to_owned(),
        _ => derived,
    };
    ModelDisplayName {
        display_name,
        upstream_provider,
        detail: identity.detail,
        family: identity.family,
        version: identity.version,
    }
}

#[cfg(test)]
mod tests {
    //! Ports `packages/models/src/display-name.test.ts` in full:
    //! - the `test.each` of clean names and upstream providers;
    //! - "the provider's display name takes precedence";
    //! - the `test.each` of qualifiers kept in the family with the version extracted;
    //! - "arbitrary numeric selectors are not treated as model versions";
    //! - the `test.each` of snapshot ids that put the snapshot in `detail`;
    //! - "a snapshot cannot turn Haiku's version into 25";
    //! - "lowercase native labels and snapshot names read as human model names".

    use super::*;

    fn display(id: &str) -> ModelDisplayName {
        model_display_name(id, None)
    }

    #[test]
    fn names_have_a_clean_display_name_and_a_separate_upstream_provider() {
        let cases = [
            (
                "opencode-go/muse-spark-1.3-contributor",
                "Muse Spark 1.3 Contributor",
                Some("opencode-go"),
            ),
            ("claude-opus-5-5", "Opus 5.5", None),
            ("gpt-6.1-sol", "GPT-6.1 Sol", None),
            ("anthropic/claude-opus-4-8", "Opus 4.8", Some("anthropic")),
            (
                "anthropic/claude-3-5-sonnet",
                "Sonnet 3.5",
                Some("anthropic"),
            ),
            ("openai/gpt-4o-mini", "GPT-4o Mini", Some("openai")),
            ("openai/gpt-oss-120b", "GPT OSS 120B", Some("openai")),
            ("openai/o3-mini", "o3 Mini", Some("openai")),
            ("google/gemini-2.5-pro", "Gemini 2.5 Pro", Some("google")),
            ("deepseek/deepseek-v3", "DeepSeek V3", Some("deepseek")),
            ("moonshotai/kimi-k2", "Kimi K2", Some("moonshotai")),
            ("zai/glm-4.7", "GLM 4.7", Some("zai")),
            ("qwen/qwen3-235b-a22b", "Qwen3 235B A22B", Some("qwen")),
            ("mistral/codestral-latest", "Codestral", Some("mistral")),
            ("meta/llama-3-3-70b", "Llama 3.3 70B", Some("meta")),
            ("router/custom_model", "Custom Model", Some("router")),
        ];
        for (id, display_name, upstream) in cases {
            let named = display(id);
            assert_eq!(named.display_name, display_name, "{id}");
            assert_eq!(named.upstream_provider.as_deref(), upstream, "{id}");
        }
    }

    #[test]
    fn the_providers_display_name_takes_precedence() {
        let named = model_display_name("anthropic/claude-opus-4-8", Some("Opus from my router"));
        assert_eq!(named.display_name, "Opus from my router");
        assert_eq!(named.upstream_provider.as_deref(), Some("anthropic"));
    }

    #[test]
    fn qualifiers_stay_in_the_family_and_the_numeric_version_is_extracted() {
        let cases = [
            (
                "opencode-go/muse-spark-1.3-contributor",
                "Muse Spark 1.3 Contributor",
                "muse-spark-contributor",
                "1.3",
            ),
            (
                "muse-spark-1.2-contributor",
                "Muse Spark 1.2 Contributor",
                "muse-spark-contributor",
                "1.2",
            ),
            (
                "Muse Spark 1.3 Contributor",
                "Muse Spark 1.3 Contributor",
                "muse-spark-contributor",
                "1.3",
            ),
            (
                "muse_spark_1.3_contributor",
                "Muse Spark 1.3 Contributor",
                "muse-spark-contributor",
                "1.3",
            ),
            (
                "muse-spark-1.3-preview",
                "Muse Spark 1.3 Preview",
                "muse-spark-preview",
                "1.3",
            ),
            (
                "muse-spark-1.3-beta",
                "Muse Spark 1.3 Beta",
                "muse-spark-beta",
                "1.3",
            ),
            (
                "muse-spark-1.3-experimental",
                "Muse Spark 1.3 Experimental",
                "muse-spark-experimental",
                "1.3",
            ),
            (
                "muse-spark-1.3-instruct",
                "Muse Spark 1.3 Instruct",
                "muse-spark-instruct",
                "1.3",
            ),
            (
                "muse-spark-1.3-fast",
                "Muse Spark 1.3 Fast",
                "muse-spark-fast",
                "1.3",
            ),
            (
                "muse-spark-1.3-mini",
                "Muse Spark 1.3 Mini",
                "muse-spark-mini",
                "1.3",
            ),
            ("muse-spark-1.3", "Muse Spark 1.3", "muse-spark", "1.3"),
            (
                "composer-2.5-fast",
                "Composer 2.5 Fast",
                "composer-fast",
                "2.5",
            ),
            ("gpt-5.4-mini", "GPT-5.4 Mini", "gpt-mini", "5.4"),
            (
                "google/gemini-3.8-flash",
                "Gemini 3.8 Flash",
                "gemini-flash",
                "3.8",
            ),
        ];
        for (id, display_name, family, version) in cases {
            let named = display(id);
            assert_eq!(named.display_name, display_name, "{id}");
            assert_eq!(named.family.as_deref(), Some(family), "{id}");
            assert_eq!(named.version.as_deref(), Some(version), "{id}");
        }
    }

    #[test]
    fn arbitrary_numeric_selectors_are_not_treated_as_model_versions() {
        let named = display("custom-127");
        assert_eq!(named.display_name, "Custom 127");
        assert_eq!(named.family, None);
        assert_eq!(named.version, None);
    }

    #[test]
    fn snapshot_ids_put_the_snapshot_in_detail() {
        let cases = [
            ("claude-haiku-4-5-20251001", "Haiku 4.5", Some("20251001")),
            ("claude-sonnet-4-20250514", "Sonnet 4", Some("20250514")),
            ("gpt-6-latest", "GPT-6", Some("latest")),
            (
                "gpt-6.1-sol-preview-abc123",
                "GPT-6.1 Sol",
                Some("preview-abc123"),
            ),
            ("gpt-6-2026-10-01", "GPT-6", Some("2026-10-01")),
            (
                "claude-haiku-4-5-20251001-latest",
                "Haiku 4.5",
                Some("20251001 · latest"),
            ),
            (
                "muse-spark-1.3-contributor-20261001",
                "Muse Spark 1.3 Contributor",
                Some("20261001"),
            ),
            ("openrouter/anthropic/claude-opus-5-5", "Opus 5.5", None),
        ];
        for (id, display_name, detail) in cases {
            let named = display(id);
            assert_eq!(named.display_name, display_name, "{id}");
            assert_eq!(named.detail.as_deref(), detail, "{id}");
        }
    }

    #[test]
    fn a_snapshot_cannot_turn_haikus_version_into_25() {
        let named = model_display_name("claude-haiku-4-5-20251001", Some("Haiku 25.1001"));
        assert_eq!(named.display_name, "Haiku 4.5");
        assert_eq!(named.version.as_deref(), Some("4.5"));
        assert_eq!(named.family.as_deref(), Some("claude-haiku"));
        assert_eq!(named.detail.as_deref(), Some("20251001"));
    }

    #[test]
    fn lowercase_native_labels_and_snapshot_names_read_as_human_model_names() {
        assert_eq!(
            model_display_name(
                "opencode-go/muse-spark-1.3-contributor",
                Some("muse spark 1.3 contributor")
            )
            .display_name,
            "Muse Spark 1.3 Contributor"
        );
        assert_eq!(
            model_display_name("claude-haiku-4-5-20251001", Some("Haiku 4.5 20251001"))
                .display_name,
            "Haiku 4.5"
        );
    }
}
