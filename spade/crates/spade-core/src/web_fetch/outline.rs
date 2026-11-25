//! Heading outlines extracted from readable Markdown text, with exact character offsets. Pure.

/// Maximum length of a single heading label in the outline, in characters.
const MAX_HEADING_CHARS: usize = 100;

/// One heading in a page's outline.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Heading {
    /// Heading level (`1..=6`).
    pub level: u8,
    /// Cleaned heading text (links simplified to their labels, trimmed, length-capped).
    pub text: String,
    /// 0-based character offset of the heading line in the page's readable text.
    pub offset: usize,
}

/// Extracts Markdown ATX headings (`#`..`######`) with their 0-based character offsets,
/// ignoring fenced code blocks (` ``` ` / `~~~`).
#[must_use]
pub fn outline(text: &str) -> Vec<Heading> {
    let mut headings = Vec::new();
    let mut fence: Option<(char, usize)> = None;
    let mut char_offset = 0usize;

    for raw_line in text.split_inclusive('\n') {
        let line = raw_line.trim_end_matches(['\r', '\n']);
        let trimmed = strip_indent(line);

        if let Some((ch, min_len)) = fence {
            if is_closing_fence(trimmed, ch, min_len) {
                fence = None;
            }
        } else if let Some(opened) = opening_fence(trimmed) {
            fence = Some(opened);
        } else if let Some((level, label)) = parse_atx_heading(trimmed) {
            headings.push(Heading {
                level,
                text: label,
                offset: char_offset,
            });
        }

        char_offset += raw_line.chars().count();
    }

    headings
}

/// Picks at most `max_entries` headings to keep the outline compact. When there are more than
/// `max_entries`, prefers shallower heading levels first (e.g. `h1..=h3`, then `h1..=h2`, then
/// `h1`) before truncating. Returns `(selected, omitted_count)`.
#[must_use]
pub fn select_outline(headings: &[Heading], max_entries: usize) -> (Vec<&Heading>, usize) {
    if headings.len() <= max_entries || max_entries == 0 {
        let kept: Vec<&Heading> = headings.iter().take(max_entries).collect();
        let omitted = headings.len().saturating_sub(kept.len());
        return (kept, omitted);
    }

    for max_level in [3u8, 2, 1] {
        let filtered: Vec<&Heading> = headings.iter().filter(|h| h.level <= max_level).collect();
        if !filtered.is_empty() && filtered.len() <= max_entries {
            let omitted = headings.len() - filtered.len();
            return (filtered, omitted);
        }
    }

    let kept: Vec<&Heading> = headings.iter().take(max_entries).collect();
    let omitted = headings.len() - kept.len();
    (kept, omitted)
}

/// Strips up to 3 leading spaces (standard Markdown indentation before block markers).
fn strip_indent(line: &str) -> &str {
    let mut rest = line;
    for _ in 0..3 {
        if let Some(after) = rest.strip_prefix(' ') {
            rest = after;
        } else {
            break;
        }
    }
    rest
}

fn opening_fence(trimmed: &str) -> Option<(char, usize)> {
    let first = trimmed.chars().next()?;
    if first != '`' && first != '~' {
        return None;
    }
    let count = trimmed.chars().take_while(|&c| c == first).count();
    if count < 3 {
        return None;
    }
    let info = &trimmed[count..];
    if first == '`' && info.contains('`') {
        return None;
    }
    Some((first, count))
}

fn is_closing_fence(trimmed: &str, ch: char, min_len: usize) -> bool {
    let count = trimmed.chars().take_while(|&c| c == ch).count();
    count >= min_len && trimmed[count..].trim().is_empty()
}

fn parse_atx_heading(trimmed: &str) -> Option<(u8, String)> {
    let hashes = trimmed.bytes().take_while(|&b| b == b'#').count();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    let rest = &trimmed[hashes..];
    if !rest.starts_with(' ') && !rest.starts_with('\t') {
        return None;
    }
    let mut content = rest.trim();
    // Strip optional closing ATX `#` sequence preceded by whitespace.
    let without_trailing = content.trim_end_matches('#');
    if without_trailing.len() < content.len()
        && (without_trailing.is_empty()
            || without_trailing.ends_with(' ')
            || without_trailing.ends_with('\t'))
    {
        content = without_trailing.trim();
    }
    let cleaned = collapse_whitespace(&strip_markdown_links(content));
    if cleaned.is_empty() {
        return None;
    }
    let label = cap_chars(&cleaned, MAX_HEADING_CHARS);
    u8::try_from(hashes).ok().map(|level| (level, label))
}

/// Replaces inline Markdown links `[label](url)` with `label` so outlines stay readable.
fn strip_markdown_links(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(open) = rest.find('[') {
        out.push_str(&rest[..open]);
        let after_open = &rest[open + 1..];
        let Some(mid) = after_open.find("](") else {
            out.push('[');
            rest = after_open;
            continue;
        };
        let label = &after_open[..mid];
        let after_mid = &after_open[mid + 2..];
        let Some(close) = after_mid.find(')') else {
            out.push('[');
            rest = after_open;
            continue;
        };
        out.push_str(label);
        rest = &after_mid[close + 1..];
    }
    out.push_str(rest);
    out
}

fn collapse_whitespace(input: &str) -> String {
    input.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn cap_chars(input: &str, max_chars: usize) -> String {
    let count = input.chars().count();
    if count <= max_chars {
        return input.to_owned();
    }
    let mut out: String = input.chars().take(max_chars.saturating_sub(1)).collect();
    out.push('…');
    out
}
