// SPDX-License-Identifier: Apache-2.0
//! ace's effort scale and the provider spellings that name it.
//!
//! Ports `packages/models/src/efforts.ts`. The scale and a row's effort are
//! `ace-protocol`'s generated `EffortLevel` and `ModelEffort`, so the Rust row is
//! the wire shape itself. The protocol's 32-entry cap counts entries, never
//! characters: an emoji label is still one effort (rule 17).

use ace_protocol::generated::{EffortLevel, ModelEffort};

/// The label every provider's picker shows for this level.
pub fn effort_label(level: EffortLevel) -> &'static str {
    match level {
        EffortLevel::Off => "Off",
        EffortLevel::Minimal => "Minimal",
        EffortLevel::Low => "Low",
        EffortLevel::Medium => "Medium",
        EffortLevel::High => "High",
        EffortLevel::Xhigh => "XHigh",
        EffortLevel::Max => "Max",
        EffortLevel::Ultra => "Ultra",
    }
}

/// A provider-native effort value: a bare id, or an id with the provider's label.
#[derive(Debug, Clone, Copy)]
pub struct EffortValue<'a> {
    pub id: &'a str,
    pub label: Option<&'a str>,
}

impl<'a> EffortValue<'a> {
    /// A bare native id, as Codex and OpenCode send it.
    pub fn id(id: &'a str) -> Self {
        Self { id, label: None }
    }

    /// An id with the provider's own label, as Cursor and ACP send it.
    pub fn named(id: &'a str, label: &'a str) -> Self {
        Self {
            id,
            label: Some(label),
        }
    }
}

impl<'a> From<&'a str> for EffortValue<'a> {
    fn from(id: &'a str) -> Self {
        Self::id(id)
    }
}

/// The canonical level a native effort id names, or `None` when ace doesn't know it.
///
/// The lookup is case-insensitive (`id.toLowerCase()` in the TypeScript); the id
/// itself is kept as the provider wrote it.
pub fn effort_level(id: &str) -> Option<EffortLevel> {
    match id.to_lowercase().as_str() {
        "none" | "off" => Some(EffortLevel::Off),
        "minimal" => Some(EffortLevel::Minimal),
        "low" => Some(EffortLevel::Low),
        "medium" => Some(EffortLevel::Medium),
        "high" => Some(EffortLevel::High),
        "xhigh" | "extra-high" | "extra_high" => Some(EffortLevel::Xhigh),
        "max" => Some(EffortLevel::Max),
        "ultra" => Some(EffortLevel::Ultra),
        _ => None,
    }
}

/// Boolean parameter values switch extended thinking on or off; they are not effort levels.
fn is_toggle(id: &str) -> bool {
    id == "true" || id == "false"
}

/// Catalog efforts from a provider's native values, in the provider's order
/// (weakest first): the exact native id, its canonical level and a label.
///
/// Thinking on/off values are dropped, as are empty and repeated ids. The result
/// keeps at most 32 entries (the protocol's `efforts` bound); entry count is not a
/// character count, so a label carrying an emoji still fits in one slot.
pub fn model_efforts<'a>(values: impl IntoIterator<Item = EffortValue<'a>>) -> Vec<ModelEffort> {
    let mut seen: Vec<&'a str> = Vec::new();
    let mut efforts = Vec::new();
    for value in values {
        let id = value.id;
        if id.is_empty() || is_toggle(id) || seen.contains(&id) {
            continue;
        }
        seen.push(id);
        let level = effort_level(id);
        // XHigh reads the same for every provider, whatever the provider calls it.
        let named = if level == Some(EffortLevel::Xhigh) {
            Some(effort_label(EffortLevel::Xhigh))
        } else {
            value.label
        };
        let label = named
            .map(str::to_owned)
            .or_else(|| level.map(|level| effort_label(level).to_owned()))
            .unwrap_or_else(|| id.to_owned());
        efforts.push(ModelEffort {
            id: id.to_owned().into(),
            label: label.into(),
            level,
        });
        if efforts.len() == 32 {
            break;
        }
    }
    efforts
}

/// Whether a parameter's values are a thinking on/off switch rather than effort levels.
pub fn is_thinking_toggle<'a>(values: impl IntoIterator<Item = &'a str>) -> bool {
    let mut any = false;
    for value in values {
        if !is_toggle(value) {
            return false;
        }
        any = true;
    }
    any
}

/// Pi's `--thinking` levels (`pi --help`, 1.2.0), offered for its reasoning models.
pub const PI_THINKING_LEVELS: [&str; 7] =
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/// A reasoning model's Pi efforts, and the native default when the model lists it.
#[derive(Debug, Clone)]
pub struct PiEfforts {
    pub efforts: Vec<ModelEffort>,
    pub default_effort: Option<String>,
}

/// Pi's efforts for a model: none unless the model reasons.
pub fn pi_efforts(reasoning: bool, current: Option<&str>) -> PiEfforts {
    if !reasoning {
        return PiEfforts {
            efforts: Vec::new(),
            default_effort: None,
        };
    }
    let efforts = model_efforts(PI_THINKING_LEVELS.map(EffortValue::id));
    let default_effort = listed_effort(&efforts, current).map(str::to_owned);
    PiEfforts {
        efforts,
        default_effort,
    }
}

/// A native default, kept only when the model lists it.
pub fn listed_effort<'b>(efforts: &[ModelEffort], id: Option<&'b str>) -> Option<&'b str> {
    let id = id?;
    efforts.iter().any(|effort| effort.id.0 == id).then_some(id)
}

#[cfg(test)]
mod tests {
    //! Ports `packages/models/src/efforts.test.ts` in full, plus the cases the
    //! provider catalog tests pin for this mapping:
    //!
    //! - "the level above High reads XHigh for every provider, whatever it calls it"
    //!   (`efforts.test.ts`);
    //! - the effort rows in "OpenCode 2.4.2 variants become efforts in the order the
    //!   server lists them" (`open-code.test.ts`) — provider order, `none` → Off,
    //!   no efforts when none are listed;
    //! - the effort rows in "exposes account-reported %s and fast parameters without
    //!   guessing SDK keys" (`cursor-sdk.test.ts`) — an unknown level keeps its id as
    //!   the label and a null level.

    use super::*;

    fn ids(efforts: &[ModelEffort]) -> Vec<&str> {
        efforts.iter().map(|effort| effort.id.0.as_str()).collect()
    }

    fn rows_json(efforts: &[ModelEffort]) -> serde_json::Value {
        serde_json::to_value(efforts).unwrap_or_else(|_| serde_json::Value::Null)
    }

    #[test]
    fn the_level_above_high_reads_xhigh_for_every_provider_whatever_it_calls_it() {
        let efforts = model_efforts([
            EffortValue::id("high"),
            EffortValue::named("extra-high", "Extra high"),
            EffortValue::named("max", "Maximum"),
        ]);
        let labels: Vec<&str> = efforts
            .iter()
            .map(|effort| effort.label.0.as_str())
            .collect();
        assert_eq!(labels, ["High", "XHigh", "Maximum"]);
        assert_eq!(
            efforts
                .iter()
                .map(|effort| effort.level)
                .collect::<Vec<_>>(),
            [
                Some(EffortLevel::High),
                Some(EffortLevel::Xhigh),
                Some(EffortLevel::Max)
            ]
        );
    }

    #[test]
    fn opencode_variants_keep_the_servers_order_and_map_none_to_off() {
        let efforts = model_efforts([
            EffortValue::id("none"),
            EffortValue::id("high"),
            EffortValue::id("max"),
        ]);
        assert_eq!(
            rows_json(&efforts),
            serde_json::json!([
                { "id": "none", "level": "off", "label": "Off" },
                { "id": "high", "level": "high", "label": "High" },
                { "id": "max", "level": "max", "label": "Max" }
            ])
        );
        assert_eq!(model_efforts(Vec::<EffortValue>::new()).len(), 0);
    }

    #[test]
    fn an_unknown_native_level_keeps_its_id_as_the_label_and_no_level() {
        let efforts = model_efforts([EffortValue::id("turbo")]);
        assert_eq!(
            rows_json(&efforts),
            serde_json::json!([{ "id": "turbo", "level": null, "label": "turbo" }])
        );
        assert_eq!(effort_level("Extra_High"), Some(EffortLevel::Xhigh));
        assert_eq!(effort_level("NONE"), Some(EffortLevel::Off));
        assert_eq!(effort_level("turbo"), None);
    }

    #[test]
    fn thinking_toggles_and_repeated_values_are_not_efforts() {
        assert!(is_thinking_toggle(["true", "false"]));
        assert!(!is_thinking_toggle(["true", "high"]));
        assert!(!is_thinking_toggle([]));
        let efforts = model_efforts([
            EffortValue::id("true"),
            EffortValue::id("false"),
            EffortValue::id(""),
            EffortValue::id("high"),
            EffortValue::id("high"),
        ]);
        assert_eq!(ids(&efforts), ["high"]);
    }

    #[test]
    fn pi_offers_its_thinking_levels_only_to_reasoning_models() {
        let plain = pi_efforts(false, Some("high"));
        assert!(plain.efforts.is_empty());
        assert_eq!(plain.default_effort, None);

        let reasoning = pi_efforts(true, Some("xhigh"));
        assert_eq!(
            ids(&reasoning.efforts),
            ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
        );
        assert_eq!(reasoning.default_effort.as_deref(), Some("xhigh"));

        let unlisted = pi_efforts(true, Some("ultra"));
        assert_eq!(unlisted.efforts.len(), 7);
        assert_eq!(unlisted.default_effort, None);
    }

    #[test]
    fn a_default_is_kept_only_when_the_model_lists_it() {
        let efforts = model_efforts([EffortValue::id("low"), EffortValue::id("high")]);
        assert_eq!(listed_effort(&efforts, Some("high")), Some("high"));
        assert_eq!(listed_effort(&efforts, Some("max")), None);
        assert_eq!(listed_effort(&efforts, None), None);
    }

    #[test]
    fn the_32_effort_cap_counts_entries_never_characters() {
        // An emoji is one effort and one label character here: rule 17's schema
        // bound (256 code points) is not this cap, and 32 astral-labelled entries
        // fit exactly.
        let labels: Vec<String> = (0..33).map(|n| format!("Level {n} 🚀")).collect();
        let ids: Vec<String> = (0..33).map(|n| format!("level-{n}")).collect();
        let values: Vec<EffortValue<'_>> = ids
            .iter()
            .zip(&labels)
            .map(|(id, label)| EffortValue::named(id, label))
            .collect();
        let efforts = model_efforts(values);
        assert_eq!(efforts.len(), 32);
        assert_eq!(efforts[0].label.0, "Level 0 🚀");
        assert_eq!(efforts[31].label.0, "Level 31 🚀");
    }
}
