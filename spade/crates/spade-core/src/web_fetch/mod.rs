//! Pure decision logic for `web_fetch` handles: immutable content-addressed workspace snapshot
//! paths, verified fetch-artifact serialization/parsing, heading outlines with character offsets,
//! lexical passage search, and bounded compact tool-result rendering. No I/O.

mod outline;
mod search;
#[cfg(test)]
mod tests;

use sha2::{Digest, Sha256};

pub use outline::{Heading, outline, select_outline};
pub use search::{Passage, search_passages};

/// Workspace folder where `web_fetch` saves immutable full readable page snapshots.
pub const WEB_DIR: &str = "web";
/// Default window size returned in a `web_fetch` tool result, in characters.
pub const DEFAULT_WINDOW_CHARS: usize = 4_000;
/// Most headings shown in one `web_fetch` outline.
pub const MAX_OUTLINE_ENTRIES: usize = 30;
/// Maximum total characters spent on the outline block in one tool result.
pub const MAX_OUTLINE_CHARS: usize = 1_500;
/// Most passages returned for a `web_fetch` query.
pub const MAX_QUERY_PASSAGES: usize = 5;
/// Maximum total characters of passage text returned for a `web_fetch` query.
pub const MAX_QUERY_CHARS: usize = DEFAULT_WINDOW_CHARS;
/// Maximum characters kept for a title in frontmatter or rendered output.
pub const MAX_TITLE_CHARS: usize = 200;
/// Maximum characters kept for a URL in saved frontmatter.
pub const MAX_URL_CHARS: usize = 2_048;
/// Maximum characters shown for a URL in a rendered tool result header.
pub const MAX_DISPLAY_URL_CHARS: usize = 1_024;
/// Maximum characters kept for `content_type` in frontmatter.
pub const MAX_CONTENT_TYPE_CHARS: usize = 128;
/// Maximum characters shown for the echoed query in a query result header.
pub const MAX_DISPLAY_QUERY_CHARS: usize = 200;
/// Hard ceiling on the entire rendered `web_fetch` tool response, in characters.
pub const MAX_RESPONSE_CHARS: usize = 8_000;

const MAX_HOST_CHARS: usize = 40;
const FRONTMATTER_DELIM: &str = "---";
const ARTIFACT_MARKER_KEY: &str = "spade_web_fetch";
const ARTIFACT_MARKER_VALUE: &str = "1";
const RESPONSE_CAP_NOTE: &str = "\n[Response truncated to fit size limit.]";

/// Metadata and full readable text of a fetched page, as saved to an immutable snapshot under
/// `web/`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedPage {
    pub url: String,
    pub title: Option<String>,
    pub content_type: String,
    pub pages: Option<u32>,
    pub truncated: bool,
    pub text: String,
}

/// Normalizes a URL for snapshot path hashing and per-conversation index lookup: trims whitespace
/// and drops any `#fragment` (which HTTP never sends to the server).
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

/// Immutable, content-addressed workspace path for a fetched snapshot:
/// `web/<host>-<url-hash8>-<content-hash8>.md` (or `-<attempt>.md` for `attempt >= 2` when an
/// unrelated file occupies the first candidate). Safe on macOS, Linux and Windows.
#[must_use]
pub fn snapshot_path(raw_url: &str, snapshot_bytes: &[u8], attempt: usize) -> String {
    let prefix = snapshot_prefix(raw_url);
    let content_hash = short_hex(snapshot_bytes, 4);
    if attempt <= 1 {
        format!("{prefix}{content_hash}.md")
    } else {
        format!("{prefix}{content_hash}-{attempt}.md")
    }
}

/// Whether `path` names a snapshot `web_fetch` could have saved for `raw_url`:
/// `web/<host>-<url-hash8>-<content-hash8>[-<attempt>].md`. The content's digest is the
/// writer's, so a reader checks everything else: a path from another page, or made up, fails.
#[must_use]
pub fn is_snapshot_of(raw_url: &str, path: &str) -> bool {
    let Some(rest) = path.strip_prefix(&snapshot_prefix(raw_url)) else {
        return false;
    };
    let Some(rest) = rest.strip_suffix(".md") else {
        return false;
    };
    let (content, attempt) = match rest.split_once('-') {
        Some((content, attempt)) => (content, Some(attempt)),
        None => (rest, None),
    };
    let hex8 = |text: &str| text.len() == 8 && text.bytes().all(|b| b.is_ascii_hexdigit());
    hex8(content) && attempt.is_none_or(|attempt| attempt.parse::<usize>().is_ok_and(|n| n >= 2))
}

/// `web/<host>-<url-hash8>-`, the part of a snapshot's path that names the page and not its text.
fn snapshot_prefix(raw_url: &str) -> String {
    let canonical = canonical_url(raw_url);
    let host = url::Url::parse(&canonical)
        .ok()
        .and_then(|u| u.host_str().map(sanitize_host))
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "page".to_owned());
    let url_hash = short_hex(canonical.as_bytes(), 4);
    format!("{WEB_DIR}/{host}-{url_hash}-")
}

fn short_hex(bytes: &[u8], num_bytes: usize) -> String {
    let digest = Sha256::digest(bytes);
    digest
        .iter()
        .take(num_bytes)
        .map(|b| format!("{b:02x}"))
        .collect()
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

/// Serializes `page` as Markdown with a verified `spade_web_fetch` frontmatter header for saving
/// into the workspace. Bounds metadata fields and caps total UTF-8 bytes at `max_bytes` so
/// `workspace_read` can always open it and oversized metadata can never fail the save.
/// Returns `(content, body_was_capped)`.
#[must_use]
pub fn format_saved(page: &SavedPage, max_bytes: usize) -> (String, bool) {
    let url = bound_single_line(&page.url, MAX_URL_CHARS);
    let title = page
        .title
        .as_deref()
        .map(|t| bound_single_line(t, MAX_TITLE_CHARS))
        .filter(|t| !t.is_empty());
    let content_type = bound_single_line(&page.content_type, MAX_CONTENT_TYPE_CHARS);

    let build_header = |truncated: bool| -> String {
        let mut h = String::new();
        h.push_str(FRONTMATTER_DELIM);
        h.push('\n');
        h.push_str(ARTIFACT_MARKER_KEY);
        h.push_str(": ");
        h.push_str(ARTIFACT_MARKER_VALUE);
        h.push('\n');
        h.push_str("url: ");
        h.push_str(&url);
        h.push('\n');
        if let Some(title) = &title {
            h.push_str("title: ");
            h.push_str(title);
            h.push('\n');
        }
        h.push_str("content_type: ");
        h.push_str(&content_type);
        h.push('\n');
        if let Some(pages) = page.pages {
            h.push_str(&format!("pages: {pages}\n"));
        }
        if truncated {
            h.push_str("truncated: true\n");
        }
        h.push_str(FRONTMATTER_DELIM);
        h.push_str("\n\n");
        h
    };

    let base_header = build_header(page.truncated);
    let capped = base_header.len().saturating_add(page.text.len()) > max_bytes;
    let mut header = if capped && !page.truncated {
        build_header(true)
    } else {
        base_header
    };

    // Even if `max_bytes` is tiny (e.g. unit test), never exceed `max_bytes`.
    if header.len() > max_bytes {
        // Shrink URL/title proportionally to guarantee the artifact header still fits if possible.
        let minimal = format!(
            "{FRONTMATTER_DELIM}\n{ARTIFACT_MARKER_KEY}: {ARTIFACT_MARKER_VALUE}\nurl: {}\ntruncated: true\n{FRONTMATTER_DELIM}\n\n",
            bound_single_line(&url, max_bytes.saturating_sub(64).min(MAX_URL_CHARS))
        );
        header = if minimal.len() <= max_bytes {
            minimal
        } else {
            truncate_utf8(&minimal, max_bytes).to_owned()
        };
    }

    let body_budget = max_bytes.saturating_sub(header.len());
    let body = if page.text.len() > body_budget {
        truncate_utf8(&page.text, body_budget)
    } else {
        page.text.as_str()
    };
    let mut out = String::with_capacity(header.len() + body.len());
    out.push_str(&header);
    out.push_str(body);
    (out, capped)
}

/// Parses a verified `web_fetch` snapshot written by [`format_saved`] back into a [`SavedPage`].
/// Refuses files that do not carry the `spade_web_fetch: 1` frontmatter marker.
#[must_use]
pub fn parse_saved(raw: &str) -> Option<SavedPage> {
    let rest = raw.strip_prefix("---\n")?;
    let (front, after) = rest.split_once("\n---\n")?;
    let body = after.strip_prefix('\n').unwrap_or(after);

    let mut is_artifact = false;
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
            ARTIFACT_MARKER_KEY => is_artifact = value == ARTIFACT_MARKER_VALUE,
            "url" if !value.is_empty() => url = Some(value.to_owned()),
            "title" if !value.is_empty() => title = Some(value.to_owned()),
            "content_type" if !value.is_empty() => content_type = Some(value.to_owned()),
            "pages" => pages = value.parse::<u32>().ok(),
            "truncated" => truncated = value == "true",
            _ => {}
        }
    }

    if !is_artifact {
        return None;
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

/// Whether `existing` is an exact verified `web_fetch` artifact for `expected_url` matching
/// `expected_formatted`.
#[must_use]
pub fn is_matching_artifact(existing: &str, expected_url: &str, expected_formatted: &str) -> bool {
    if existing != expected_formatted {
        return false;
    }
    let Some(parsed) = parse_saved(existing) else {
        return false;
    };
    let expected_bounded = bound_single_line(expected_url, MAX_URL_CHARS);
    canonical_url(&parsed.url) == canonical_url(&expected_bounded)
}

/// Renders a compact, size-bounded window view of `page` starting at character `offset`
/// (at most `window_chars`). Includes title, URL, total length, saved workspace path (when
/// available), heading outline on `offset == 0`, and continuation instructions when more text
/// remains.
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

    cap_response(out, MAX_RESPONSE_CHARS)
}

/// Renders the top lexical-search passages of `page` matching `query`, size-bounded to
/// [`MAX_RESPONSE_CHARS`].
#[must_use]
pub fn render_query(page: &SavedPage, saved_path: Option<&str>, query: &str) -> String {
    let total_chars = page.text.chars().count();
    let trimmed = query.trim();
    let shown_query = bound_single_line(trimmed, MAX_DISPLAY_QUERY_CHARS);
    let passages = search_passages(&page.text, trimmed, MAX_QUERY_PASSAGES, MAX_QUERY_CHARS);

    let mut out = render_header(page, total_chars, saved_path);
    out.push_str(&format!(
        "Query: {:?} ({} matching {})\n",
        shown_query,
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
            shown_query,
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

    cap_response(out, MAX_RESPONSE_CHARS)
}

fn render_header(page: &SavedPage, total_chars: usize, saved_path: Option<&str>) -> String {
    let mut out = String::new();
    if let Some(title) = &page.title {
        let clean = bound_single_line(title, MAX_TITLE_CHARS);
        if !clean.is_empty() {
            out.push_str(&format!("# {clean}\n"));
        }
    }
    let display_url = bound_single_line(&page.url, MAX_DISPLAY_URL_CHARS);
    out.push_str(&format!("URL: {display_url}\n"));
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
    let (selected, mut omitted) = select_outline(headings, MAX_OUTLINE_ENTRIES);
    let mut block = String::from("Outline (char offsets):\n");
    for (shown, heading) in selected.iter().enumerate() {
        let line = format!(
            "- [{}] {} {}\n",
            heading.offset,
            "#".repeat(usize::from(heading.level)),
            heading.text
        );
        if shown > 0 && block.chars().count() + line.chars().count() > MAX_OUTLINE_CHARS {
            omitted += selected.len() - shown;
            break;
        }
        block.push_str(&line);
    }
    if omitted > 0 {
        block.push_str(&format!(
            "({omitted} more headings omitted; use query or workspace_search)\n"
        ));
    }
    out.push_str(&block);
}

fn workspace_hint(saved_path: Option<&str>) -> String {
    match saved_path {
        Some(path) => format!(", or workspace_read/workspace_search on {path}"),
        None => String::new(),
    }
}

fn bound_single_line(text: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return String::new();
    }
    let mut out = String::new();
    let mut count = 0usize;
    let mut truncated = false;
    for word in text.split_whitespace() {
        let sep = usize::from(!out.is_empty());
        let word_len = word.chars().count();
        if count + sep + word_len <= max_chars {
            if sep == 1 {
                out.push(' ');
            }
            out.push_str(word);
            count += sep + word_len;
        } else {
            let room = max_chars.saturating_sub(count + sep + 1);
            if room > 0 {
                if sep == 1 {
                    out.push(' ');
                }
                out.extend(word.chars().take(room));
            }
            truncated = true;
            break;
        }
    }
    if truncated {
        if out.chars().count() >= max_chars {
            out = out.chars().take(max_chars.saturating_sub(1)).collect();
        }
        out.push('…');
    }
    out
}

fn cap_response(out: String, max_chars: usize) -> String {
    if out.chars().count() <= max_chars {
        return out;
    }
    let note_len = RESPONSE_CAP_NOTE.chars().count();
    let keep = max_chars.saturating_sub(note_len);
    let mut capped: String = out.chars().take(keep).collect();
    capped.push_str(RESPONSE_CAP_NOTE);
    capped
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
