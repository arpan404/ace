//! Turns raw search results into short plain text the model can read. Pure: no I/O.

use crate::SearchResult;

/// The longest snippet kept, in characters.
const SNIPPET: usize = 400;
const TITLE: usize = 200;

/// Removes tags, decodes the common entities and collapses whitespace.
pub(crate) fn text(raw: &str, longest: usize) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut in_tag = false;
    for c in raw.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    let decoded = out
        .replace("&nbsp;", " ")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&");
    let collapsed = decoded.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= longest {
        collapsed
    } else {
        let cut: String = collapsed.chars().take(longest).collect();
        format!("{}…", cut.trim_end())
    }
}

/// Cleans, drops results without a web address, removes repeated addresses, keeps `count`.
pub(crate) fn results(raw: Vec<(String, String, String)>, count: usize) -> Vec<SearchResult> {
    let mut seen = std::collections::HashSet::new();
    raw.into_iter()
        .filter(|(_, url, _)| url.starts_with("https://") || url.starts_with("http://"))
        .filter(|(_, url, _)| seen.insert(url.trim_end_matches('/').to_owned()))
        .map(|(title, url, snippet)| SearchResult {
            title: text(&title, TITLE),
            url,
            snippet: text(&snippet, SNIPPET),
        })
        .take(count)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markup_and_entities_become_plain_text() {
        assert_eq!(
            text(
                "<strong>Rust</strong> &amp; <em>Tokio</em>:\n  fast&nbsp;&quot;async&quot;",
                100
            ),
            "Rust & Tokio: fast \"async\""
        );
    }

    #[test]
    fn long_text_is_cut_with_an_ellipsis() {
        let cut = text(&"word ".repeat(200), 20);
        assert!(cut.ends_with('…'));
        assert!(cut.chars().count() <= 21);
    }

    #[test]
    fn non_web_and_repeated_addresses_are_dropped_and_the_count_holds() {
        let raw = vec![
            ("A".into(), "https://a.example/".into(), "a".into()),
            ("A again".into(), "https://a.example".into(), "a".into()),
            ("Mail".into(), "mailto:x@example.com".into(), "".into()),
            ("B".into(), "http://b.example/page".into(), "b".into()),
            ("C".into(), "https://c.example/".into(), "c".into()),
        ];
        let kept: Vec<_> = results(raw, 2).into_iter().map(|r| r.title).collect();
        assert_eq!(kept, vec!["A", "B"]);
    }
}
