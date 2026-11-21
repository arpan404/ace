//! Local model families ace has run its first-party packages' cases on (ADR 0205 §3), from the
//! catalogue's `local` list: on ace's own machines, never on anyone's quota, with the share of
//! cases that passed. The picker marks a model of one of them "Works well with Spade's
//! packages". Only measured families are listed; the list is empty until they are.

use serde::{Deserialize, Serialize};

/// A family as the catalogue lists it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KnownGood {
    /// The family's id as local servers name its models: `qwen3` covers `qwen3:8b`,
    /// `qwen3-8b` and `qwen/qwen3-14b`, not `qwen3.5` or `qwen3-coder`.
    pub family: String,
    pub name: String,
    /// The share of the cases that passed, from 0 to 1.
    pub passed: f64,
    /// How many cases were run.
    pub cases: u32,
    /// When they were run, `YYYY-MM-DD`.
    pub checked: String,
}

impl KnownGood {
    /// Whether model `id` (as a local server names it) is of this family: its last path part,
    /// before any `:tag`, is the family, or the family and a size (`-8b`).
    pub fn covers(&self, id: &str) -> bool {
        let family = self.family.to_ascii_lowercase();
        let id = id.trim().to_ascii_lowercase();
        let last = id.rsplit('/').next().unwrap_or_default();
        let base = last.split(':').next().unwrap_or_default();
        if base == family {
            return true;
        }
        base.strip_prefix(&family)
            .and_then(|rest| rest.strip_prefix('-'))
            .is_some_and(|size| size.starts_with(|c: char| c.is_ascii_digit()))
    }

    /// What is wrong with this entry, if anything.
    pub(crate) fn problems(&self) -> Vec<String> {
        let mut problems = Vec::new();
        let family = self.family.trim();
        let valid = !family.is_empty()
            && family
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '.'));
        if !valid {
            problems.push(format!(
                "local family {:?} must be lowercase letters, digits, '-' or '.'",
                self.family
            ));
        }
        if self.name.trim().is_empty() {
            problems.push(format!("local family {family} has an empty name"));
        }
        if !(self.passed.is_finite() && (0.0..=1.0).contains(&self.passed)) || self.cases == 0 {
            problems.push(format!(
                "local family {family}: passed is a share from 0 to 1 of at least one case"
            ));
        }
        if self.checked.len() != 10 {
            problems.push(format!(
                "local family {family}: checked is the date the cases ran, YYYY-MM-DD"
            ));
        }
        problems
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn qwen3() -> KnownGood {
        KnownGood {
            family: "qwen3".to_owned(),
            name: "Qwen3".to_owned(),
            passed: 0.9,
            cases: 40,
            checked: "2026-11-20".to_owned(),
        }
    }

    #[test]
    fn a_family_covers_its_tags_and_sizes_and_nothing_else() {
        let family = qwen3();
        for id in [
            "qwen3",
            "qwen3:8b",
            "Qwen3-14B",
            "qwen/qwen3-8b",
            "qwen3:latest",
        ] {
            assert!(family.covers(id), "{id}");
        }
        for id in ["qwen3.5:8b", "qwen3-coder:30b", "qwen2.5", "myqwen3", ""] {
            assert!(!family.covers(id), "{id}");
        }
    }

    #[test]
    fn an_entry_needs_its_share_cases_and_date() {
        assert!(qwen3().problems().is_empty());
        let mut wrong = qwen3();
        wrong.passed = 1.5;
        wrong.checked = "soon".to_owned();
        assert_eq!(wrong.problems().len(), 2);
    }
}
