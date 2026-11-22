//! Turns raw search results into short plain text the model can read. Pure: no I/O.

use crate::SearchResult;
use crate::wire::Raw;

/// The longest snippet kept, in characters.
const SNIPPET: usize = 400;
const TITLE: usize = 200;
const SITE: usize = 100;

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
pub(crate) fn results(raw: Vec<Raw>, count: usize) -> Vec<SearchResult> {
    let mut seen = std::collections::HashSet::new();
    raw.into_iter()
        .filter(|r| r.url.starts_with("https://") || r.url.starts_with("http://"))
        .filter(|r| seen.insert(r.url.trim_end_matches('/').to_owned()))
        .map(|r| SearchResult {
            title: text(&r.title, TITLE),
            url: r.url,
            snippet: text(&r.snippet, SNIPPET),
            site: text(&r.site, SITE),
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
        let raw = |title: &str, url: &str| Raw {
            title: title.into(),
            url: url.into(),
            snippet: String::new(),
            site: String::new(),
        };
        let raw = vec![
            raw("A", "https://a.example/"),
            raw("A again", "https://a.example"),
            raw("Mail", "mailto:x@example.com"),
            raw("B", "http://b.example/page"),
            raw("C", "https://c.example/"),
        ];
        let kept: Vec<_> = results(raw, 2).into_iter().map(|r| r.title).collect();
        assert_eq!(kept, vec!["A", "B"]);
    }
}
