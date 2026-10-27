//! Finding text the model names: a span inside an element's text, and a menu item by title.
//! Pure. Spans are character offsets; Win32 edit controls count UTF-16 units instead.

/// The first occurrence of `wanted` with `prefix` right before and `suffix` right after it.
/// Without anchors, or when anchors match nothing but the text occurs once, the first one.
pub fn find_text(
    wanted: &str,
    text: &str,
    prefix: Option<&str>,
    suffix: Option<&str>,
) -> Option<(usize, usize)> {
    if wanted.is_empty() {
        return None;
    }
    let chars: Vec<char> = text.chars().collect();
    let needle: Vec<char> = wanted.chars().collect();
    if needle.len() > chars.len() {
        return None;
    }
    let occurrences: Vec<usize> = (0..=chars.len() - needle.len())
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

/// How many times `wanted` occurs before character `start`, counting non-overlapping matches
/// from the beginning the way a forward text search finds them.
pub fn occurrence_index(text: &str, wanted: &str, start: usize) -> usize {
    let chars: Vec<char> = text.chars().collect();
    let needle: Vec<char> = wanted.chars().collect();
    if needle.is_empty() {
        return 0;
    }
    let mut index = 0;
    let mut at = 0;
    while at + needle.len() <= chars.len() && at < start {
        if chars[at..].starts_with(&needle) {
            index += 1;
            at += needle.len();
        } else {
            at += 1;
        }
    }
    index
}

/// A character offset as UTF-16 units, for EM_SETSEL.
pub fn utf16_offset(text: &str, chars: usize) -> usize {
    text.chars().take(chars).map(char::len_utf16).sum()
}

/// A Win32 menu item's text split into its title (mnemonic ampersands removed) and the
/// accelerator shown after a tab, such as ("Save", Some("Ctrl+S")) for "&Save\tCtrl+S".
pub fn split_menu_label(raw: &str) -> (String, Option<String>) {
    let (title, accelerator) = match raw.split_once('\t') {
        Some((title, accelerator)) => (title, Some(accelerator.trim().to_owned())),
        None => (raw, None),
    };
    let mut clean = String::with_capacity(title.len());
    let mut chars = title.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '&' {
            if chars.peek() == Some(&'&') {
                clean.push('&');
                chars.next();
            }
            continue;
        }
        clean.push(c);
    }
    (
        clean.trim().to_owned(),
        accelerator.filter(|a| !a.is_empty()),
    )
}

/// A menu title reduced for comparison: case, ellipses and mnemonics ignored.
pub fn menu_key(title: &str) -> String {
    split_menu_label(title)
        .0
        .to_lowercase()
        .replace('…', "")
        .replace("...", "")
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
        _ => MenuChoice::Ambiguous(
            prefixed
                .iter()
                .map(|&i| split_menu_label(&titles[i]).0)
                .collect(),
        ),
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
        assert_eq!(occurrence_index(text, "cat", 13), 1);
        assert_eq!(occurrence_index(text, "cat", 4), 0);
    }

    #[test]
    fn offsets_count_characters_and_convert_to_utf16_units() {
        assert_eq!(find_text("b", "😀éb", None, None), Some((2, 3)));
        assert_eq!(utf16_offset("😀éb", 2), 3);
    }

    #[test]
    fn menu_labels_lose_mnemonics_and_keep_their_accelerator() {
        assert_eq!(
            split_menu_label("&Save\tCtrl+S"),
            ("Save".into(), Some("Ctrl+S".into()))
        );
        assert_eq!(
            split_menu_label("Tom && &Jerry"),
            ("Tom & Jerry".into(), None)
        );
    }

    #[test]
    fn menu_items_match_exactly_before_by_a_unique_prefix() {
        let titles: Vec<String> = [
            "Close &Tab",
            "Close &Window\tCtrl+W",
            "&Open...\tCtrl+O",
            "&Close",
        ]
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
