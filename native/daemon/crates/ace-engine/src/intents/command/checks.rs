// SPDX-License-Identifier: Apache-2.0
//! Zod's checks over JSON values. JavaScript regexes run over the original UTF-16 units.

use ace_json::Value;
use regress::Regex;
use serde::{Deserialize, Deserializer, de};

use super::refinements::Refinement;

#[derive(Deserialize)]
#[serde(tag = "check", rename_all = "snake_case")]
pub(super) enum Check {
    MinLength {
        minimum: usize,
    },
    MaxLength {
        maximum: usize,
    },
    GreaterThan {
        value: f64,
        inclusive: bool,
    },
    LessThan {
        value: f64,
        inclusive: bool,
    },
    NumberFormat {
        format: NumberFormat,
    },
    Regex {
        #[serde(deserialize_with = "regex")]
        source: Regex,
    },
    Refinement {
        name: Refinement,
    },
}

#[derive(Deserialize)]
pub(super) enum NumberFormat {
    #[serde(rename = "safeint")]
    SafeInteger,
}

fn regex<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Regex, D::Error> {
    Regex::new(&String::deserialize(deserializer)?).map_err(de::Error::custom)
}

fn length(value: &Value) -> Option<usize> {
    match value {
        // Zod 4 string length counts code points. as_str maps a lone surrogate to one
        // replacement character, which preserves the count.
        Value::String(text) => Some(text.as_str().chars().count()),
        Value::Array(items) => Some(items.len()),
        _ => None,
    }
}

impl Check {
    pub(super) fn accepts(&self, input: &Value) -> bool {
        match self {
            Self::MinLength { minimum } => length(input).is_some_and(|n| n >= *minimum),
            Self::MaxLength { maximum } => length(input).is_some_and(|n| n <= *maximum),
            Self::GreaterThan { value, inclusive } => input
                .as_f64()
                .is_some_and(|n| n > *value || (*inclusive && n == *value)),
            Self::LessThan { value, inclusive } => input
                .as_f64()
                .is_some_and(|n| n < *value || (*inclusive && n == *value)),
            Self::NumberFormat {
                format: NumberFormat::SafeInteger,
            } => input
                .as_f64()
                .is_some_and(|n| n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0),
            Self::Regex { source } => {
                let Value::String(text) = input else {
                    return false;
                };
                let units: Vec<u16> = text.units().collect();
                source.find_from_ucs2(&units, 0).next().is_some()
            }
            Self::Refinement { name } => name.accepts(input),
        }
    }
}
