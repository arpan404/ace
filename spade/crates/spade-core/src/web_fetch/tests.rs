use super::*;

#[test]
fn save_path_is_deterministic_portable_and_ignores_fragments() {
    let a = save_path("https://docs.rust-lang.org/book/ch04.html#ownership");
    let b = save_path("https://docs.rust-lang.org/book/ch04.html#scope");
    let c = save_path("https://docs.rust-lang.org/book/ch05.html");
    let d = save_path("https://docs.rust-lang.org/book/ch04.html?v=2");

    assert_eq!(a, b);
    assert_ne!(a, c);
    assert_ne!(a, d);
    assert!(a.starts_with("web/docs-rust-lang-org-"), "{a}");
    assert!(a.ends_with(".md"), "{a}");
    // Only safe ASCII path characters.
    assert!(
        a.chars().all(|ch| ch.is_ascii_lowercase()
            || ch.is_ascii_digit()
            || matches!(ch, '/' | '-' | '.')),
        "{a}"
    );
}

#[test]
fn saved_page_round_trips_including_body_with_horizontal_rules_and_unicode() {
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
    let parsed = parse_saved(&formatted).unwrap_or_else(|| panic!("should parse:\n{formatted}"));
    assert_eq!(parsed.url, page.url);
    assert_eq!(parsed.title.as_deref(), Some("Line 1 Line 2"));
    assert_eq!(parsed.content_type, "application/pdf");
    assert_eq!(parsed.pages, Some(14));
    assert!(!parsed.truncated);
    assert_eq!(parsed.text, page.text);
}

#[test]
fn format_saved_caps_body_on_utf8_boundary_and_marks_truncated() {
    let page = SavedPage {
        url: "https://example.com/big".to_owned(),
        title: Some("Big".to_owned()),
        content_type: "text/plain".to_owned(),
        pages: None,
        truncated: false,
        text: "é".repeat(500),
    };

    let (formatted, capped) = format_saved(&page, 200);
    assert!(capped);
    assert!(formatted.len() <= 200);
    let parsed = parse_saved(&formatted).unwrap_or_else(|| panic!("should parse:\n{formatted}"));
    assert!(parsed.truncated);
    assert!(parsed.text.len() < page.text.len());
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

    // Every reported character offset points directly at its heading line in `text`.
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

    // Offset points directly to the returned passage in the original text.
    let at_offset: String = text
        .chars()
        .skip(results[0].offset)
        .take(results[0].text.chars().count())
        .collect();
    assert_eq!(at_offset, results[0].text);
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
    let path = save_path(&page.url);
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

    // Jumping directly to Chapter 6's offset starts at `## Chapter 6` and omits the outline.
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
    let path = save_path(&page.url);

    let hit = render_query(&page, Some(&path), "warranty years");
    assert!(hit.contains("(8 pages, PDF)"));
    assert!(hit.contains("1 matching passage"));
    assert!(hit.contains("Valid for two years."));

    let miss = render_query(&page, Some(&path), "quantum_flux");
    assert!(miss.contains("No passages matched"));
    assert!(miss.contains("Outline (char offsets):"));
    assert!(miss.contains("# Warranty"));
}
