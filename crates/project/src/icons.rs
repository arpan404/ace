use std::path::{Path, PathBuf};

pub(crate) fn is_file_within_root(root: &Path, path: &Path) -> bool {
    path.strip_prefix(root).is_ok() && path.is_file()
}

pub(crate) fn icon_href_candidates(root: &Path, href: &str) -> Vec<PathBuf> {
    let clean = href
        .split(['?', '#'])
        .next()
        .unwrap_or_default()
        .trim_start_matches('/');
    vec![root.join("public").join(clean), root.join(clean)]
}

pub(crate) fn extract_icon_href(source: &str) -> Option<String> {
    extract_html_icon_href(source).or_else(|| extract_object_icon_href(source))
}

fn extract_html_icon_href(source: &str) -> Option<String> {
    for tag in source.match_indices("<link").filter_map(|(start, _)| {
        let end = source[start..].find('>')?;
        Some(&source[start..start + end + 1])
    }) {
        let lower = tag.to_lowercase();
        if !(lower.contains("rel=\"icon\"")
            || lower.contains("rel='icon'")
            || lower.contains("rel=\"shortcut icon\"")
            || lower.contains("rel='shortcut icon'"))
        {
            continue;
        }
        if let Some(href) = extract_quoted_attr(tag, "href=") {
            return Some(href);
        }
    }
    None
}

fn extract_object_icon_href(source: &str) -> Option<String> {
    for segment in source.split(['{', '}']) {
        let lower = segment.to_lowercase();
        if !(lower.contains("rel: \"icon\"")
            || lower.contains("rel:'icon'")
            || lower.contains("rel: 'icon'")
            || lower.contains("rel:\"icon\"")
            || lower.contains("rel: \"shortcut icon\"")
            || lower.contains("rel: 'shortcut icon'"))
        {
            continue;
        }
        if let Some(href) = extract_quoted_attr(segment, "href") {
            return Some(href);
        }
    }
    None
}

fn extract_quoted_attr(source: &str, name: &str) -> Option<String> {
    let lower = source.to_lowercase();
    let start = lower.find(name)?;
    let after_name = &source[start + name.len()..];
    let after_separator = after_name
        .trim_start()
        .strip_prefix(':')
        .unwrap_or(after_name)
        .trim_start()
        .strip_prefix('=')
        .unwrap_or(after_name.trim_start())
        .trim_start();
    let quote = after_separator.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let rest = &after_separator[quote.len_utf8()..];
    let end = rest.find(quote)?;
    Some(rest[..end].to_string())
}
