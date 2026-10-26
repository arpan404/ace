//! Finding text the model names: a span inside an element's text, and a menu item by title.
//! Pure. Offsets are in characters, as AT-SPI Text counts them.

/// The first occurrence of `wanted` with `prefix` right before and `suffix` right after it.
/// Without anchors, or when anchors match nothing but the text occurs once, the first one.
pub fn find_text(wanted: &str, text: &str, prefix: Option<&str>, suffix: Option<&str>) -> Option<(usize, usize)> {
    if wanted.is_empty() {
        return None;
    }
    let chars: Vec<char> = text.chars().collect();
    let needle: Vec<char> = wanted.chars().collect();
    let occurrences: Vec<usize> = (0..chars.len().saturating_sub(needle.len() - 1))
        .filter(|&start| chars[start..].starts_with(&needle))
        .collect();
    let before = |start: usize| chars[..start].iter().collect::<String>();
    let after = |end: usize| chars[end..].iter().collect::<String>();
    let anchored = occurrences.iter().copied().find(|&start| {
        prefix.is_none_or(|p| p.is_empty() || before(start).ends_with(p))
            && suffix.is_none_or(|s| s.is_empty() || after(start + needle.len()).starts_with(s))
    });
    let start = anchored.or(if occurrences.len() == 1 {
        Some(occurrences[0])
    } else {
        None
    })?;
    Some((start, start + needle.len()))
}

/// A menu title reduced for comparison: case, ellipses, trailing accelerator padding ignored.
pub fn menu_key(title: &str) -> String {
    title
        .to_lowercase()
        .replace('…', "")
        .replace("...", "")
        .replace('_', "")
        .trim()
        .to_owned()
}

#[derive(Debug, PartialEq, Eq)]
pub enum MenuChoice {
    Found(usize),
    Ambiguous(Vec<String>),
    Missing,
}

/// The item a path step names: an exact title first; a prefix only when exactly one item
/// starts with it, so "Close" never lands on "Close All" by accident.
pub fn choose_menu_item(titles: &[String], wanted: &str) -> MenuChoice {
    let key = menu_key(wanted);
    if key.is_empty() {
        return MenuChoice::Missing;
    }
    if let Some(exact) = titles.iter().position(|t| menu_key(t) == key) {
        return MenuChoice::Found(exact);
    }
    let prefixed: Vec<usize> = (0..titles.len())
        .filter(|&i| menu_key(&titles[i]).starts_with(&key))
        .collect();
    match prefixed.len() {
        0 => MenuChoice::Missing,
        1 => MenuChoice::Found(prefixed[0]),
        _ => MenuChoice::Ambiguous(prefixed.iter().map(|&i| titles[i].trim().to_owned()).collect()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_text_is_told_apart_by_prefix_or_suffix() {
        let text = "one cat, two cat";
        assert_eq!(find_text("cat", text, Some("two "), None), Some((13, 16)));
        assert_eq!(find_text("cat", text, None, Some(",")), Some((4, 7)));
        assert_eq!(find_text("cat", text, None, None), Some((4, 7)));
        assert_eq!(find_text("cat", text, Some("three "), None), None);
        assert_eq!(find_text("dog", text, None, None), None);
    }

    #[test]
    fn offsets_count_characters_not_bytes() {
        assert_eq!(find_text("b", "ééb", None, None), Some((2, 3)));
    }

    #[test]
    fn menu_items_match_exactly_before_by_a_unique_prefix() {
        let titles: Vec<String> = ["Close Tab      ", "Close Window      ", "Open...      ", "Close"]
            .map(String::from)
            .to_vec();
        assert_eq!(choose_menu_item(&titles, "close"), MenuChoice::Found(3));
        assert_eq!(choose_menu_item(&titles, "Open…"), MenuChoice::Found(2));
        assert_eq!(
            choose_menu_item(&titles[..2], "Clo"),
            MenuChoice::Ambiguous(vec!["Close Tab".into(), "Close Window".into()])
        );
        assert_eq!(choose_menu_item(&titles, "Quit"), MenuChoice::Missing);
    }
}
