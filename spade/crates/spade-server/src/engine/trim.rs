//! A tool or job result too long for the context keeps its start and its end (ADR 0158): the end
//! is where errors, summaries and failing tests usually are, so it is never the part dropped.

/// `text` in at most about `longest` characters: as it is when it fits, else its first half and
/// its last half with a note of how much was left out between them.
pub(super) fn trim(text: &str, longest: usize) -> String {
    let count = text.chars().count();
    if count <= longest {
        return text.to_owned();
    }
    let tail = longest / 2;
    let head = longest - tail;
    let start: String = text.chars().take(head).collect();
    let end: String = text.chars().skip(count - tail).collect();
    format!(
        "{start}\n[… {} characters left out here …]\n{end}",
        count - longest
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_long_result_keeps_its_start_and_its_end_and_says_how_much_is_left_out() {
        let text = format!("BEGIN {} error: test x failed END", "x".repeat(50_000));
        let kept = trim(&text, 20_000);
        assert!(kept.starts_with("BEGIN "), "{:.40}", kept);
        assert!(kept.ends_with("error: test x failed END"));
        assert!(
            kept.contains("[… 30031 characters left out here …]"),
            "the count"
        );
        assert!(kept.chars().count() < 20_100);
    }

    #[test]
    fn a_result_that_fits_is_kept_whole_and_characters_are_never_split() {
        assert_eq!(trim("short", 20_000), "short");
        let wide = "é".repeat(30);
        let kept = trim(&wide, 10);
        assert!(
            kept.starts_with("ééééé\n") && kept.ends_with("\nééééé"),
            "{kept}"
        );
    }
}
