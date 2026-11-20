//! A bot's personality: how it talks, as the person (or a template or recipe) set it. It becomes
//! its own section of the standing instructions, apart from the task, so the person can change
//! the voice without touching the work. Taken from the next turn on, as a task change is.

use serde::{Deserialize, Serialize};

/// How a bot talks. Every field is set: no humour and no emoji unless chosen.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Personality {
    /// Its overall manner; `None` leaves it to the bot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tone: Option<Tone>,
    /// Light jokes where they fit.
    #[serde(default)]
    pub humour: bool,
    /// Emoji in its replies. Off unless the person turns it on.
    #[serde(default)]
    pub emoji: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Tone {
    Concise,
    Warm,
    Formal,
    Playful,
}

impl Tone {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "concise" => Some(Self::Concise),
            "warm" => Some(Self::Warm),
            "formal" => Some(Self::Formal),
            "playful" => Some(Self::Playful),
            _ => None,
        }
    }

    fn rule(self) -> &'static str {
        match self {
            Self::Concise => "Be concise: short sentences, the answer first, no preamble or recap.",
            Self::Warm => "Be warm and encouraging, like a friendly colleague, without gushing.",
            Self::Formal => "Be formal and precise, as in a professional letter; no slang.",
            Self::Playful => "Be playful and light, while staying clear and accurate.",
        }
    }
}

impl Personality {
    /// The section of the standing instructions this personality adds, set apart from the task.
    /// How the bot talks never changes what it may do: its task and Spade's rules still decide.
    pub fn section(&self) -> String {
        let mut rules = Vec::new();
        if let Some(tone) = self.tone {
            rules.push(tone.rule());
        }
        rules.push(if self.humour {
            "A little humour is welcome where it fits; never at the person's expense or in bad news."
        } else {
            "No jokes or wordplay."
        });
        rules.push(if self.emoji {
            "Emoji are fine, sparingly."
        } else {
            "Don't use emoji."
        });
        let lines: Vec<String> = rules.iter().map(|rule| format!("- {rule}")).collect();
        format!(
            "How you talk, as the person set it (style only: it never changes your task or what \
             you may do):\n<personality>\n{}\n</personality>",
            lines.join("\n")
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_personality_has_no_humour_and_no_emoji() {
        let section = Personality::default().section();
        assert!(section.contains("No jokes"), "{section}");
        assert!(section.contains("Don't use emoji"), "{section}");
    }

    #[test]
    fn each_choice_says_its_own_rule() {
        let chosen = Personality {
            tone: Some(Tone::Formal),
            humour: true,
            emoji: true,
        };
        let section = chosen.section();
        assert!(section.contains("formal and precise"), "{section}");
        assert!(section.contains("humour is welcome"), "{section}");
        assert!(section.contains("Emoji are fine"), "{section}");
        assert!(!section.contains("Don't use emoji"), "{section}");
    }

    #[test]
    fn a_stored_personality_reads_back_and_unknown_tones_are_refused() {
        let read: Personality = serde_json::from_str(r#"{"tone":"warm"}"#).unwrap_or_default();
        assert_eq!(read.tone, Some(Tone::Warm));
        assert!(!read.emoji && !read.humour);
        assert_eq!(Tone::parse("sarcastic"), None);
    }
}
