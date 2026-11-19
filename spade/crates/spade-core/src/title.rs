//! Conversation titles: asked of the fast model as typed output, with a fallback from the first
//! message when that fails.

use schemars::JsonSchema;
use serde::Deserialize;
use spade_models::Prompt;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct Suggestion {
    /// A short title, three to six words.
    pub title: String,
}

const LONGEST: usize = 60;

pub fn prompt(first_message: &str) -> Prompt {
    let excerpt: String = first_message.chars().take(2_000).collect();
    Prompt::default()
        .system(
            "Write a short title (three to six words) for a conversation that starts with the \
             message below. Plain words: no quotes, no trailing period, no emoji.",
        )
        .person(excerpt)
        .max_tokens(60)
}

/// The suggestion tidied, or `None` when nothing usable is left.
pub fn clean(raw: &str) -> Option<String> {
    let trimmed = raw
        .trim()
        .trim_matches(|c: char| c == '"' || c == '\'' || c == '`')
        .trim_end_matches('.')
        .trim();
    let line = trimmed.lines().next().unwrap_or("").trim();
    if line.is_empty() {
        None
    } else {
        Some(shorten(line))
    }
}

/// A title from the first message's opening words, used when no model title is available.
pub fn fallback(first_message: &str) -> String {
    let line = first_message
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("New conversation");
    shorten(line)
}

/// At most `LONGEST` characters, cut at a word boundary with an ellipsis.
fn shorten(text: &str) -> String {
    if text.chars().count() <= LONGEST {
        return text.to_owned();
    }
    let cut: String = text.chars().take(LONGEST).collect();
    let at_word = cut
        .rfind(' ')
        .filter(|i| *i > LONGEST / 2)
        .unwrap_or(cut.len());
    format!("{}…", cut[..at_word].trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_suggestion_loses_quotes_and_a_trailing_period() {
        assert_eq!(
            clean("  \"Planning the launch.\" "),
            Some("Planning the launch".into())
        );
        assert_eq!(clean("   "), None);
    }

    #[test]
    fn the_fallback_is_the_first_line_cut_at_a_word() {
        assert_eq!(fallback("\n  Fix the build\nmore"), "Fix the build");
        let long =
            "Please look into why the daemon keeps restarting every few minutes on my Linux box";
        let title = fallback(long);
        assert!(title.ends_with('…'));
        assert!(title.chars().count() <= LONGEST + 1);
        assert!(long.starts_with(title.trim_end_matches('…')));
    }

    #[test]
    fn an_empty_first_message_gets_a_generic_title() {
        assert_eq!(fallback("  \n "), "New conversation");
    }
}
