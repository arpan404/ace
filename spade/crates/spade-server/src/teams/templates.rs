//! Bot templates (ADR 0132): shipped roles a person can start a bot from. Read from the binary,
//! so a shipped correction reaches every install.

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

const TEMPLATES: &str = include_str!("../../../../config/templates.json");

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TemplateRoutine {
    pub name: String,
    pub instruction: String,
    /// A phrase or cron expression routines read (`weekdays at 8:00`).
    pub schedule: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Template {
    pub id: String,
    pub name: String,
    pub blurb: String,
    pub task: String,
    /// One of the generated avatars' colours.
    pub color: String,
    /// `fast` (the person's fast model) or `capable` (their default).
    pub model_kind: String,
    pub routines: Vec<TemplateRoutine>,
}

#[derive(Deserialize)]
struct File {
    templates: Vec<Template>,
}

/// The shipped templates, in the order the app offers them.
pub fn templates() -> &'static [Template] {
    static PARSED: OnceLock<Vec<Template>> = OnceLock::new();
    PARSED.get_or_init(|| match serde_json::from_str::<File>(TEMPLATES) {
        Ok(file) => file.templates,
        Err(error) => {
            tracing::error!(%error, "the shipped bot templates do not parse");
            Vec::new()
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use spade_core::routine::Trigger;

    #[test]
    fn every_shipped_template_is_usable() {
        let all = templates();
        assert!(all.len() >= 8, "{} templates", all.len());
        for template in all {
            assert!(
                spade_store::AVATAR_COLORS.contains(&template.color.as_str()),
                "{}: colour {}",
                template.id,
                template.color
            );
            assert!(matches!(template.model_kind.as_str(), "fast" | "capable"));
            assert!(template.task.chars().count() <= crate::engine::TASK_CHARS);
            for routine in &template.routines {
                let trigger = Trigger::Schedule {
                    schedule: routine.schedule.clone(),
                };
                assert!(
                    trigger.schedule().is_ok_and(|s| s.is_some()),
                    "{}: {:?} doesn't read",
                    template.id,
                    routine.schedule
                );
            }
        }
    }
}
