use super::*;

#[test]
fn snapshot_path_is_immutable_portable_and_distinguishes_content_versions() {
    let url_a = "https://docs.rust-lang.org/book/ch04.html#ownership";
    let url_b = "https://docs.rust-lang.org/book/ch04.html#scope";
    let v1 = snapshot_path(url_a, b"version one", 1);
    let v1_frag = snapshot_path(url_b, b"version one", 1);
    let v2 = snapshot_path(url_a, b"version two", 1);
    let alt = snapshot_path(url_a, b"version one", 2);

    assert_eq!(v1, v1_frag);
    assert_ne!(v1, v2);
    assert_ne!(v1, alt);
    assert!(v1.starts_with("web/docs-rust-lang-org-"), "{v1}");
    assert!(v1.ends_with(".md"), "{v1}");
    assert!(alt.ends_with("-2.md"), "{alt}");
    assert!(
        v1.chars().all(|ch| ch.is_ascii_lowercase()
            || ch.is_ascii_digit()
            || matches!(ch, '/' | '-' | '.')),
        "{v1}"
    );
}

#[test]
fn saved_page_round_trips_and_rejects_unmarked_markdown_files() {
    let page = SavedPage {
        url: "https://example.com/guide.pdf".to_owned(),
        title: Some("Line 1\nLine 2".to_owned()),
        content_type: "application/pdf".to_owned(),
        pages: Some(14),
        truncated: false,
        text: "Intro café\n\n---\n\nSection after rule".to_owned(),
    };

    let (formatted, capped) = format_saved(&page, 64 * 1024);
    assert!(!capped);
    assert!(is_matching_artifact(&formatted, &page.url, &formatted));
    let parsed = parse_saved(&formatted).unwrap_or_else(|| panic!("should parse:\n{formatted}"));
    assert_eq!(parsed.url, page.url);
    assert_eq!(parsed.title.as_deref(), Some("Line 1 Line 2"));
    assert_eq!(parsed.content_type, "application/pdf");
    assert_eq!(parsed.pages, Some(14));
    assert!(!parsed.truncated);
    assert_eq!(parsed.text, page.text);

    // A user-written Markdown file with YAML frontmatter lacking `spade_web_fetch: 1` is NOT
    // mistaken for a fetch artifact.
    let user_file = "---\nurl: https://example.com/guide.pdf\ntitle: Mine\n---\n\nPersonal notes.";
    assert_eq!(parse_saved(user_file), None);
    assert!(!is_matching_artifact(user_file, &page.url, &formatted));
}

#[test]
fn format_saved_caps_body_and_huge_metadata_within_max_bytes() {
    let page = SavedPage {
        url: format!("https://example.com/{}", "u".repeat(50_000)),
        title: Some("Title ".repeat(10_000)),
        content_type: format!("text/{}", "x".repeat(5_000)),
        pages: None,
        truncated: false,
        text: "é".repeat(500),
    };

    let (formatted, capped) = format_saved(&page, 200);
    assert!(capped);
    assert!(formatted.len() <= 200, "len was {}", formatted.len());

    let (larger, capped_larger) = format_saved(&page, 8_192);
    assert!(!capped_larger);
    assert!(larger.len() <= 8_192);
    let parsed = parse_saved(&larger).unwrap_or_else(|| panic!("should parse:\n{larger}"));
    assert!(parsed.url.chars().count() <= MAX_URL_CHARS);
    assert!(parsed.title.as_deref().unwrap_or_default().chars().count() <= MAX_TITLE_CHARS);
    assert!(parsed.content_type.chars().count() <= MAX_CONTENT_TYPE_CHARS);
}

#[test]
fn render_window_and_query_bound_huge_titles_urls_and_total_response() {
    let page = SavedPage {
        url: format!("https://example.com/{}", "q".repeat(50_000)),
        title: Some("HugeTitle ".repeat(10_000)),
        content_type: "text/html".to_owned(),
        pages: None,
        truncated: false,
        text: format!("# Heading\n\n{}", "body content ".repeat(1_000)),
    };

    let win = render_window(
        &page,
        Some("web/example-com-12345678-87654321.md"),
        0,
        DEFAULT_WINDOW_CHARS,
    );
    assert!(
        win.chars().count() <= MAX_RESPONSE_CHARS,
        "window response was {} chars",
        win.chars().count()
    );

    let big_query = "body ".repeat(5_000);
    let q = render_query(
        &page,
        Some("web/example-com-12345678-87654321.md"),
        &big_query,
    );
    assert!(
        q.chars().count() <= MAX_RESPONSE_CHARS,
        "query response was {} chars",
        q.chars().count()
    );
}

#[test]
fn outline_records_exact_character_offsets_and_skips_code_fences() {
    let text = "\
# Café Guide

Intro text with ünïcode.

```python
# not a heading
print('hi')
```

## [Installation](https://example.com/install)

Run the installer.

### Post-install steps ###

All done.";

    let headings = outline(text);
    assert_eq!(headings.len(), 3, "{headings:?}");
    assert_eq!(headings[0].level, 1);
    assert_eq!(headings[0].text, "Café Guide");
    assert_eq!(headings[1].level, 2);
    assert_eq!(headings[1].text, "Installation");
    assert_eq!(headings[2].level, 3);
    assert_eq!(headings[2].text, "Post-install steps");

    for (heading, expected_prefix) in headings.iter().zip([
        "# Café Guide",
        "## [Installation]",
        "### Post-install steps",
    ]) {
        let slice: String = text.chars().skip(heading.offset).take(30).collect();
        assert!(
            slice.starts_with(expected_prefix),
            "offset {} gave {:?}, expected {:?}",
            heading.offset,
            slice,
            expected_prefix
        );
    }
}

#[test]
fn large_outlines_prefer_shallower_levels_to_stay_bounded() {
    let mut text = String::new();
    for section in 1..=5 {
        text.push_str(&format!("## Section {section}\n\n"));
        for sub in 1..=10 {
            text.push_str(&format!("#### Detail {section}.{sub}\n\nBody.\n\n"));
        }
    }
    let headings = outline(&text);
    assert_eq!(headings.len(), 55);

    let (selected, omitted) = select_outline(&headings, 20);
    assert_eq!(selected.len(), 5);
    assert_eq!(omitted, 50);
    assert!(selected.iter().all(|h| h.level == 2));
}

#[test]
fn search_passages_ranks_relevant_section_highest_with_exact_offset() {
    let text = "\
# Product Documentation

Welcome to the documentation. Everything you need is listed below.

## Overview

This service handles background queues and scheduled jobs across clusters.

## Rate Limits

API requests are capped at 120 requests per minute per workspace key. Exceeding the rate limit returns HTTP 429 with a Retry-After header.

## Billing

Invoices are issued monthly on the first business day.";

    let results = search_passages(text, "rate limit 429 retry", 3, 2_000);
    assert!(!results.is_empty());
    assert!(
        results[0].text.contains("HTTP 429") && results[0].text.contains("Retry-After"),
        "{:?}",
        results[0]
    );
    assert_eq!(results[0].section.as_deref(), Some("## Rate Limits"));

    let at_offset: String = text
        .chars()
        .skip(results[0].offset)
        .take(results[0].end_offset - results[0].offset)
        .collect();
    assert_eq!(at_offset, results[0].text);
}

#[test]
fn merged_heading_passage_preserves_exact_crlf_and_extra_blank_lines_range() {
    let text = "# Intro\r\n\r\nOverview.\r\n\r\n\r\n## Rate Limits\r\n\r\n\r\nExceeding the quota returns HTTP 429.\r\n";
    let results = search_passages(text, "rate limits quota 429", 3, 2_000);
    assert_eq!(results.len(), 1);
    let p = &results[0];
    let exact_slice: String = text
        .chars()
        .skip(p.offset)
        .take(p.end_offset - p.offset)
        .collect();
    assert_eq!(p.text, exact_slice);
    assert_eq!(p.text.chars().count(), p.end_offset - p.offset);
    assert!(p.text.contains("\r\n\r\n\r\n"), "{:?}", p.text);
}

#[test]
fn heading_heavy_page_searches_in_linear_time() {
    let mut text = String::new();
    for i in 0..2_000 {
        text.push_str(&format!("## Heading {i}\n\nShort body {i}.\n\n"));
    }
    text.push_str("## Target Section\n\nNeedle value aurora_991 lives here.\n");

    let results = search_passages(&text, "aurora_991 target", 3, 2_000);
    assert!(!results.is_empty());
    assert!(results[0].text.contains("aurora_991"));
    assert_eq!(results[0].section.as_deref(), Some("## Target Section"));
}

#[test]
fn search_passages_splits_very_long_single_paragraph_and_stays_under_budget() {
    let filler = "lorem ipsum dolor sit amet ".repeat(200);
    let text = format!("{filler}unique_needle_token_42 appears right here {filler}");
    let results = search_passages(&text, "unique_needle_token_42", 5, 2_000);
    assert_eq!(results.len(), 1);
    assert!(results[0].text.contains("unique_needle_token_42"));
    assert!(results[0].text.chars().count() <= 900);
}

#[test]
fn render_window_keeps_large_pages_compact_with_outline_and_saved_path() {
    let mut body = String::from("# Handbook\n\n");
    for i in 1..=6 {
        body.push_str(&format!("## Chapter {i}\n\n"));
        body.push_str(&format!("Details for chapter {i}. ").repeat(120));
        body.push_str("\n\n");
    }
    let page = SavedPage {
        url: "https://example.com/handbook".to_owned(),
        title: Some("Handbook".to_owned()),
        content_type: "text/html".to_owned(),
        pages: None,
        truncated: false,
        text: body.clone(),
    };
    let (formatted, _) = format_saved(&page, 1024 * 1024);
    let path = snapshot_path(&page.url, formatted.as_bytes(), 1);
    let first = render_window(&page, Some(&path), 0, DEFAULT_WINDOW_CHARS);

    assert!(page.text.chars().count() > 15_000);
    assert!(
        first.chars().count() < 5_000,
        "result was {} chars",
        first.chars().count()
    );
    assert!(first.contains("# Handbook"));
    assert!(first.contains("URL: https://example.com/handbook"));
    assert!(first.contains(&format!("Saved: {path}")));
    assert!(first.contains("Outline (char offsets):"));
    assert!(first.contains("## Chapter 6"));
    assert!(first.contains("offset=4000"));

    let headings = outline(&page.text);
    let ch6 = headings
        .iter()
        .find(|h| h.text == "Chapter 6")
        .unwrap_or_else(|| panic!("Chapter 6 missing from outline"));
    let jumped = render_window(&page, Some(&path), ch6.offset, DEFAULT_WINDOW_CHARS);
    assert!(!jumped.contains("Outline (char offsets):"));
    assert!(jumped.contains("## Chapter 6\n\nDetails for chapter 6."));
}

#[test]
fn render_query_returns_passages_or_outline_when_nothing_matches() {
    let page = SavedPage {
        url: "https://example.com/manual.pdf".to_owned(),
        title: Some("manual.pdf".to_owned()),
        content_type: "application/pdf".to_owned(),
        pages: Some(8),
        truncated: false,
        text: "# Safety\n\nKeep away from water.\n\n# Warranty\n\nValid for two years.".to_owned(),
    };
    let (formatted, _) = format_saved(&page, 1024 * 1024);
    let path = snapshot_path(&page.url, formatted.as_bytes(), 1);

    let hit = render_query(&page, Some(&path), "warranty years");
    assert!(hit.contains("(8 pages, PDF)"));
    assert!(hit.contains("1 matching passage"));
    assert!(hit.contains("Valid for two years."));

    let miss = render_query(&page, Some(&path), "quantum_flux");
    assert!(miss.contains("No passages matched"));
    assert!(miss.contains("Outline (char offsets):"));
    assert!(miss.contains("# Warranty"));
}
