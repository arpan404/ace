//! Local privacy checks for proposed shareable text. Findings never echo the private value.

use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

static PERSONAL: LazyLock<Result<Regex, regex::Error>> = LazyLock::new(|| {
    Regex::new(
        r"(?ix)
        [\w.%+-]+@[\w.-]+\.[a-z]{2,}
        | (?:/Users/|/home/|~/|[a-z]:[\\/]Users[\\/])[^\s]+
        | \b(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-|AKIA|eyJ)[a-z0-9_./+-]{8,}
        | \b(?:bearer|password|api[_ -]?key|token|secret)\s*[:= ]\s*[a-z0-9_./+-]{12,}",
    )
});

static PHONE: LazyLock<Result<Regex, regex::Error>> =
    LazyLock::new(|| Regex::new(r"\+?\(?[0-9][0-9(). -]{7,}[0-9]"));

// Compare normalized phrases as well as literal strings. Matching most of a short window
// catches excerpts and light rewrites without treating a shared technical word as private.
fn phrase_words(text: &str) -> Vec<&str> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|word| {
            word.chars().count() > 2
                && !matches!(
                    *word,
                    "the"
                        | "and"
                        | "that"
                        | "this"
                        | "with"
                        | "from"
                        | "for"
                        | "have"
                        | "your"
                        | "they"
                        | "were"
                        | "when"
                )
        })
        .collect()
}

fn overlaps(text: &str, private: &[&str]) -> bool {
    let candidate = phrase_words(text);
    if candidate.len() < 4 || private.len() < 4 {
        return false;
    }
    let vocabulary: std::collections::HashSet<_> = candidate.iter().copied().collect();
    private.windows(5.min(private.len())).any(|phrase| {
        // Match four distinct terms, allowing a replacement and a few inserted or reordered words.
        if phrase
            .iter()
            .enumerate()
            .any(|(i, word)| phrase[..i].contains(word))
        {
            return false;
        }
        if phrase
            .iter()
            .filter(|word| vocabulary.contains(**word))
            .count()
            < 4
        {
            return false;
        }
        candidate
            .windows(7.min(candidate.len()))
            .any(|window| phrase.iter().filter(|word| window.contains(word)).count() >= 4)
    })
}

fn distinctive(text: &str) -> impl Iterator<Item = &str> {
    text.split(|c: char| !(c.is_alphanumeric() || matches!(c, '/' | '@' | '_' | '-')))
        .filter(|token| {
            token.chars().count() >= 3
                && (token.chars().any(|c| c.is_ascii_digit())
                    || token.contains(['/', '@'])
                    || token.chars().skip(1).any(char::is_uppercase)
                    || (text.find(token).is_some_and(|start| start > 0)
                        && token.starts_with(char::is_uppercase)))
        })
}

fn contains_token(text: &str, token: &str) -> bool {
    text.match_indices(token).any(|(start, _)| {
        !text[..start]
            .chars()
            .next_back()
            .is_some_and(char::is_alphanumeric)
            && !text[start + token.len()..]
                .chars()
                .next()
                .is_some_and(char::is_alphanumeric)
    })
}

/// Refuse recognizable personal data or credentials, including the caller's known private
/// names, paths and verbatim notes. The package's own secret rules apply to all fields.
pub fn contains_private_text(value: &Value, private: &[String]) -> bool {
    fn text_is_private(text: &str, private: &[String]) -> bool {
        let lower = text.to_lowercase();
        let (Ok(personal), Ok(phone)) = (&*PERSONAL, &*PHONE) else {
            return true;
        };
        personal.is_match(text)
            || phone.find_iter(text).any(|hit| {
                let digits = hit.as_str().bytes().filter(u8::is_ascii_digit).count();
                (10..=15).contains(&digits)
            })
            || private.iter().any(|word| {
                let normalized = word.trim().to_lowercase();
                normalized.chars().count() >= 2
                    && (contains_token(&lower, &normalized)
                        || distinctive(word)
                            .any(|token| contains_token(&lower, &token.to_lowercase()))
                        || overlaps(&lower, &phrase_words(&normalized)))
            })
    }

    fn strings(value: &Value, private: &[String]) -> bool {
        match value {
            Value::String(text) => text_is_private(text, private),
            Value::Array(items) => items.iter().any(|item| strings(item, private)),
            Value::Object(fields) => fields
                .iter()
                .any(|(key, item)| text_is_private(key, private) || strings(item, private)),
            _ => false,
        }
    }

    let mut secrets = Vec::new();
    crate::package::manifest::secret_problems(value, "template", &mut secrets);
    !secrets.is_empty() || strings(value, private)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn template_privacy_refuses_personal_text_in_nested_fields() {
        let private = vec![
            "Jane Doe".to_owned(),
            "Always use the private repository.".to_owned(),
        ];
        for text in [
            "Ask jane@example.test",
            "/Users/jane/work",
            "~/work",
            "Call +1 (415) 555-0123",
            "a sk-abcdefghijklmnopqrstuvwxyz",
            "Ask JANE DOE first",
            "Always use the private repository.",
        ] {
            assert!(
                contains_private_text(&json!({"notes": [text]}), &private),
                "{text}"
            );
        }
        assert!(!contains_private_text(
            &json!({"task": "Measure a baseline and compare it with the next run."}),
            &private
        ));
        let private_title = ["Discuss Zephyr 5219".to_owned()];
        for text in ["Use zephyr for the report", "Use reference 5219"] {
            assert!(contains_private_text(
                &json!({"task": text}),
                &private_title
            ));
        }
        let memory = vec!["Send the monthly rendering metrics from the cedar repository to our staging dashboard after release.".to_owned()];
        for text in [
            "Use the cedar repository for monthly rendering metrics.",
            "Report the monthly renderer metrics from the cedar repository.",
            "Monthly rendering metrics, cedar.",
        ] {
            assert!(contains_private_text(
                &json!({"knowledge": [{"body":text}]}),
                &memory
            ));
        }
    }
}
