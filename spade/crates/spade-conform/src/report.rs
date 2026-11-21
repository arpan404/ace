//! What a run found: each case passed or failed, per level, as text for a person and as JSON.

use serde::Serialize;

/// One case's result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Outcome {
    pub id: String,
    pub passed: bool,
    /// Why it failed, in a sentence.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
}

impl Outcome {
    pub fn of(id: String, failed: Result<(), String>) -> Self {
        match failed {
            Ok(()) => Self {
                id,
                passed: true,
                why: None,
            },
            Err(why) => Self {
                id,
                passed: false,
                why: Some(why),
            },
        }
    }
}

/// One level's cases.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Level {
    pub level: &'static str,
    pub cases: Vec<Outcome>,
}

impl Level {
    /// Whether every case passed; a level with no case run never passes.
    pub fn passed(&self) -> bool {
        !self.cases.is_empty() && self.cases.iter().all(|c| c.passed)
    }

    /// The case of `id`.
    pub fn case(&self, id: &str) -> Option<&Outcome> {
        self.cases.iter().find(|c| c.id == id)
    }

    /// The cases that failed.
    pub fn failed(&self) -> impl Iterator<Item = &Outcome> {
        self.cases.iter().filter(|c| !c.passed)
    }
}

/// Every level run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Report {
    /// The Spade Agent Format version the suite is.
    pub spec: &'static str,
    pub levels: Vec<Level>,
}

impl Report {
    pub fn passed(&self) -> bool {
        !self.levels.is_empty() && self.levels.iter().all(Level::passed)
    }

    /// The report for a person: each level's count, then each failure with why.
    pub fn text(&self) -> String {
        let mut out = String::new();
        for level in &self.levels {
            let passed = level.cases.iter().filter(|c| c.passed).count();
            out.push_str(&format!(
                "{}: {passed} of {} cases passed\n",
                level.level,
                level.cases.len()
            ));
            for case in level.failed() {
                let why = case.why.as_deref().unwrap_or("it failed");
                out.push_str(&format!("  FAILED {}: {why}\n", case.id));
            }
        }
        let verdict = if self.passed() {
            format!(
                "Conforms to Spade Agent Format {} at every level run.",
                self.spec
            )
        } else {
            format!("Doesn't conform to Spade Agent Format {}.", self.spec)
        };
        out.push_str(&verdict);
        out.push('\n');
        out
    }
}
