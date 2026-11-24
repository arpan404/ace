//! Pure decision logic for `web_fetch` handles: deterministic workspace save paths, saved file
//! formatting/parsing, heading outlines with character offsets, lexical passage search, and
//! compact tool-result rendering. No I/O.

mod outline;
mod search;
#[cfg(test)]
mod tests;

use sha2::{Digest, Sha256};

pub use outline::{Heading, outline, select_outline};
pub use search::{Passage, search_passages};

/// Workspace folder where `web_fetch` saves full readable page text.
pub const WEB_DIR: &str = "web";
/// Default window size returned in a `web_fetch` tool result, in characters.
pub const DEFAULT_WINDOW_CHARS: usize = 4_000;
/// Most headings shown in one `web_fetch` outline.
pub const MAX_OUTLINE_ENTRIES: usize = 30;
/// Most passages returned for a `web_fetch` query.
pub const MAX_QUERY_PASSAGES: usize = 5;
/// Maximum total characters of passage text returned for a `web_fetch` query.
pub const MAX_QUERY_CHARS: usize = DEFAULT_WINDOW_CHARS;

const MAX_HOST_CHARS: usize = 48;
const FRONTMATTER_DELIM: &str = "---";

/// Metadata and full readable text of a fetched page, as saved to `web/<host>-<hash>.md`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedPage {
    pub url: String,
    pub title: Option<String>,
    pub content_type: String,
    pub pages: Option<u32>,
    pub truncated: bool,
    pub text: String,
}

/// Normalizes a URL for predictable save-path hashing and conversation cache lookup: trims
/// whitespace and drops any `#fragment` (which HTTP never sends to the server).
#[must_use]
pub fn canonical_url(raw: &str) -> String {
    let trimmed = raw.trim();
    match url::Url::parse(trimmed) {
        Ok(mut parsed) => {
            parsed.set_fragment(None);
            parsed.to_string()
        }
        Err(_) => trimmed.to_owned(),
    }
}

/// Deterministic workspace path for a fetched URL: `web/<host>-<12-hex-sha256>.md`.
/// Safe on macOS, Linux and Windows (lowercase ASCII, digits and hyphens only).
#[must_use]
pub fn save_path(raw_url: &str) -> String {
    let canonical = canonical_url(raw_url);
    let host = url::Url::parse(&canonical)
        .ok()
        .and_then(|u| u.host_str().map(sanitize_host))
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "page".to_owned());
    let digest = Sha256::digest(canonical.as_bytes());
    let short_hash: String = digest.iter().take(6).map(|b| format!("{b:02x}")).collect();
    format!("{WEB_DIR}/{host}-{short_hash}.md")
}

fn sanitize_host(host: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for c in host.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            last_dash = false;
        } else if !out.is_empty() && !last_dash {
            out.push('-');
            last_dash = true;
        }
        if out.len() >= MAX_HOST_CHARS {
            break;
        }
    }
    out.trim_end_matches('-').to_owned()
}

/// Serializes `page` as Markdown with a short frontmatter header for saving into the workspace,
/// capping total UTF-8 size at `max_bytes` so `workspace_read` can always open it.
/// Returns `(content, body_was_capped)`.
#[must_use]
pub fn format_saved(page: &SavedPage, max_bytes: usize) -> (String, bool) {
    let mut header = String::new();
    header.push_str(FRONTMATTER_DELIM);
    header.push('\n');
    header.push_str("url: ");
    header.push_str(&single_line(&page.url));
    header.push('\n');
    if let Some(title) = &page.title {
        let clean = single_line(title);
        if !clean.is_empty() {
            header.push_str("title: ");
            header.push_str(&clean);
            header.push('\n');
        }
    }
    header.push_str("content_type: ");
    header.push_str(&single_line(&page.content_type));
    header.push('\n');
    if let Some(pages) = page.pages {
        header.push_str(&format!("pages: {pages}\n"));
    }
    let body_budget = max_bytes.saturating_sub(header.len() + 32);
    let capped = page.text.len() > body_budget;
    if page.truncated || capped {
        header.push_str("truncated: true\n");
    }
    header.push_str(FRONTMATTER_DELIM);
    header.push_str("\n\n");

    let body = if capped {
        truncate_utf8(&page.text, max_bytes.saturating_sub(header.len()))
    } else {
        page.text.as_str()
    };
    let mut out = String::with_capacity(header.len() + body.len());
    out.push_str(&header);
    out.push_str(body);
    (out, capped)
}

/// Parses a file written by [`format_saved`] back into a [`SavedPage`].
#[must_use]
pub fn parse_saved(raw: &str) -> Option<SavedPage> {
    let rest = raw.strip_prefix("---\n")?;
    let (front, after) = rest.split_once("\n---\n")?;
    let body = after.strip_prefix('\n').unwrap_or(after);

    let mut url = None;
    let mut title = None;
    let mut content_type = None;
    let mut pages = None;
    let mut truncated = false;

    for line in front.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        match key.trim() {
            "url" if !value.is_empty() => url = Some(value.to_owned()),
            "title" if !value.is_empty() => title = Some(value.to_owned()),
            "content_type" if !value.is_empty() => content_type = Some(value.to_owned()),
            "pages" => pages = value.parse::<u32>().ok(),
            "truncated" => truncated = value == "true",
            _ => {}
        }
    }

    Some(SavedPage {
        url: url?,
        title,
        content_type: content_type.unwrap_or_else(|| "text/plain".to_owned()),
        pages,
        truncated,
        text: body.to_owned(),
    })
}

/// Renders a compact window view of `page` starting at character `offset` (at most `window_chars`).
/// Includes title, URL, total length, saved workspace path (when available), heading outline on
/// the initial `offset == 0` call, and continuation instructions when more text remains.
#[must_use]
pub fn render_window(
    page: &SavedPage,
    saved_path: Option<&str>,
    offset: usize,
    window_chars: usize,
) -> String {
    let total_chars = page.text.chars().count();
    let max_chars = window_chars.max(1);
    let piece: String = page.text.chars().skip(offset).take(max_chars).collect();
    let piece_chars = piece.chars().count();
    let end = offset.saturating_add(piece_chars);
    let next_offset = (end < total_chars).then_some(end);

    let mut out = render_header(page, total_chars, saved_path);

    if offset == 0 {
        let headings = outline(&page.text);
        if !headings.is_empty() {
            out.push('\n');
            append_outline(&mut out, &headings);
        }
    }

    if offset >= total_chars && total_chars > 0 {
        out.push_str(&format!(
            "\n[Offset {offset} is past the end ({total_chars} chars total).]"
        ));
    } else if !piece.is_empty() {
        out.push('\n');
        out.push_str(&piece);
    }

    if let Some(next) = next_offset {
        out.push_str(&format!(
            "\n\n[Shown chars {offset}..{next} of {total_chars}. Read more with web_fetch \
             (offset={next} or query=\"...\"){}]",
            workspace_hint(saved_path)
        ));
    } else if offset > 0 && piece_chars > 0 {
        out.push_str(&format!(
            "\n\n[Shown chars {offset}..{end} of {total_chars} (end of page).]"
        ));
    }

    if page.truncated {
        out.push_str("\n\n[The page was too large to read whole; this is its start.]");
    }

    out
}

/// Renders the top lexical-search passages of `page` matching `query`.
#[must_use]
pub fn render_query(page: &SavedPage, saved_path: Option<&str>, query: &str) -> String {
    let total_chars = page.text.chars().count();
    let trimmed = query.trim();
    let passages = search_passages(&page.text, trimmed, MAX_QUERY_PASSAGES, MAX_QUERY_CHARS);

    let mut out = render_header(page, total_chars, saved_path);
    out.push_str(&format!(
        "Query: {:?} ({} matching {})\n",
        trimmed,
        passages.len(),
        if passages.len() == 1 {
            "passage"
        } else {
            "passages"
        }
    ));

    if passages.is_empty() {
        out.push_str(&format!(
            "\nNo passages matched {:?}. Try different keywords, pass an offset{}",
            trimmed,
            workspace_hint(saved_path)
        ));
        out.push('.');
        let headings = outline(&page.text);
        if !headings.is_empty() {
            out.push_str("\n\n");
            append_outline(&mut out, &headings);
        }
    } else {
        for (i, passage) in passages.iter().enumerate() {
            out.push('\n');
            match &passage.section {
                Some(section) => out.push_str(&format!(
                    "--- Passage {} [offset {}, under {section}] ---\n",
                    i + 1,
                    passage.offset
                )),
                None => out.push_str(&format!(
                    "--- Passage {} [offset {}] ---\n",
                    i + 1,
                    passage.offset
                )),
            }
            out.push_str(&passage.text);
            out.push('\n');
        }
        out.push_str(&format!(
            "\n[Use web_fetch with offset=<offset> to read around a passage{}.]",
            workspace_hint(saved_path)
        ));
    }

    if page.truncated {
        out.push_str("\n\n[The page was too large to read whole; this is its start.]");
    }

    out
}

fn render_header(page: &SavedPage, total_chars: usize, saved_path: Option<&str>) -> String {
    let mut out = String::new();
    if let Some(title) = &page.title
        && !title.trim().is_empty()
    {
        out.push_str(&format!("# {}\n", single_line(title)));
    }
    out.push_str(&format!("URL: {}\n", page.url));
    let mut meta = format!("Length: {total_chars} chars");
    if let Some(pages) = page.pages {
        let unit = if pages == 1 { "page" } else { "pages" };
        meta.push_str(&format!(" ({pages} {unit}, PDF)"));
    } else if page.content_type == "application/pdf" {
        meta.push_str(" (PDF)");
    }
    if let Some(path) = saved_path {
        meta.push_str(&format!(" | Saved: {path}"));
    }
    out.push_str(&meta);
    out.push('\n');
    out
}

fn append_outline(out: &mut String, headings: &[Heading]) {
    let (selected, omitted) = select_outline(headings, MAX_OUTLINE_ENTRIES);
    out.push_str("Outline (char offsets):\n");
    for heading in selected {
        out.push_str(&format!(
            "- [{}] {} {}\n",
            heading.offset,
            "#".repeat(usize::from(heading.level)),
            heading.text
        ));
    }
    if omitted > 0 {
        out.push_str(&format!(
            "({omitted} more headings omitted; use query or workspace_search)\n"
        ));
    }
}

fn workspace_hint(saved_path: Option<&str>) -> String {
    match saved_path {
        Some(path) => format!(", or workspace_read/workspace_search on {path}"),
        None => String::new(),
    }
}

fn single_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_utf8(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}
