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
                let word = word.trim().to_lowercase();
                word.chars().count() >= 2
                    && lower.match_indices(&word).any(|(start, _)| {
                        !lower[..start]
                            .chars()
                            .next_back()
                            .is_some_and(char::is_alphanumeric)
                            && !lower[start + word.len()..]
                                .chars()
                                .next()
                                .is_some_and(char::is_alphanumeric)
                    })
            })
    }

    fn strings(value: &Value, private: &[String]) -> bool {
        match value {
            Value::String(text) => text_is_private(text, private),
            Value::Array(items) => items.iter().any(|item| strings(item, private)),
            Value::Object(fields) => fields.values().any(|item| strings(item, private)),
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
    }
}
