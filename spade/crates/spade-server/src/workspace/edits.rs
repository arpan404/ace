//! Changes to a file's text, as `workspace_edit` makes them: each replaces text that must be
//! there, once or everywhere, in order, and either every change applies or none does. Pure.

/// One change: `old` replaced by `new`, at its one place or, with `all`, everywhere.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Change {
    pub old: String,
    pub new: String,
    pub all: bool,
}

/// `text` with every change applied in order, each to the text the ones before it left. Answers
/// the new text and how many places changed, or why a change could not apply (naming it when
/// there are several), in which case nothing is applied.
pub fn apply(path: &str, text: &str, changes: &[Change]) -> Result<(String, usize), String> {
    if changes.is_empty() {
        return Err("give a change: old and new, or edits".to_owned());
    }
    let several = changes.len() > 1;
    let mut now = text.to_owned();
    let mut places = 0;
    for (index, change) in changes.iter().enumerate() {
        let which = if several {
            format!(
                "Edit {} of {} ({}): ",
                index + 1,
                changes.len(),
                preview(&change.old)
            )
        } else {
            String::new()
        };
        let after = if several && index > 0 {
            " after the edits before it"
        } else {
            ""
        };
        let refused = |why: String| {
            let none = if several { " Nothing was changed." } else { "" };
            Err(format!("{which}{why}{none}"))
        };
        if change.old.is_empty() {
            return refused("give the text to replace.".to_owned());
        }
        let count = now.matches(change.old.as_str()).count();
        match count {
            0 => {
                return refused(format!(
                    "that text is not in {path}{after}; read it again and copy it exactly."
                ));
            }
            1 => {}
            many if !change.all => {
                return refused(format!(
                    "that text appears {many} times in {path}{after}; include more around it so \
                     it appears once, or set replace_all."
                ));
            }
            _ => {}
        }
        now = now.replace(change.old.as_str(), &change.new);
        places += count;
    }
    Ok((now, places))
}

/// The start of a change's text, on one line, for naming it.
fn preview(old: &str) -> String {
    let line: String = old.split_whitespace().collect::<Vec<_>>().join(" ");
    let short: String = line.chars().take(40).collect();
    if short.len() < line.len() {
        format!("{short:?}…")
    } else {
        format!("{short:?}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(old: &str, new: &str, all: bool) -> Change {
        Change {
            old: old.to_owned(),
            new: new.to_owned(),
            all,
        }
    }

    #[test]
    fn one_change_replaces_its_one_place_and_refuses_when_there_are_several() {
        let one = apply(
            "a.txt",
            "x = 1\ny = 2\n",
            &[change("y = 2", "y = 3", false)],
        );
        assert_eq!(one, Ok(("x = 1\ny = 3\n".to_owned(), 1)));
        let twice = apply("a.txt", "a a", &[change("a", "b", false)]).err();
        assert!(
            twice
                .as_deref()
                .is_some_and(|e| e.contains("appears 2 times") && e.contains("replace_all")),
            "{twice:?}"
        );
        let missing = apply("a.txt", "a", &[change("z", "b", false)]).err();
        assert!(
            missing
                .as_deref()
                .is_some_and(|e| e.contains("not in a.txt")),
            "{missing:?}"
        );
    }

    #[test]
    fn replace_all_changes_every_place() {
        let all = apply("a.txt", "red, red, blue", &[change("red", "green", true)]);
        assert_eq!(all, Ok(("green, green, blue".to_owned(), 2)));
    }

    #[test]
    fn several_changes_apply_in_order_each_to_what_the_last_left() {
        let edits = [
            change("alpha", "beta", false),
            change("beta gamma", "delta", false),
        ];
        assert_eq!(
            apply("a.txt", "alpha gamma", &edits),
            Ok(("delta".to_owned(), 2))
        );
    }

    #[test]
    fn a_change_that_cannot_apply_names_itself_and_none_apply() {
        let edits = [
            change("one", "1", false),
            change("missing", "x", false),
            change("three", "3", false),
        ];
        let refused = apply("a.txt", "one two three", &edits).err();
        assert!(
            refused
                .as_deref()
                .is_some_and(|e| e.starts_with("Edit 2 of 3 (\"missing\")")
                    && e.contains("after the edits before it")
                    && e.ends_with("Nothing was changed.")),
            "{refused:?}"
        );
        assert!(apply("a.txt", "x", &[]).is_err());
        assert!(apply("a.txt", "x", &[change("", "y", false)]).is_err());
    }
}
