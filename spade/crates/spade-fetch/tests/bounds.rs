//! Hostile HTML cannot make reading a page slow or its text huge: the parse, the output, each
//! link and the title are bounded, and a cut is marked.

use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use reqwest::Url;
use spade_fetch::extract::{
    MOST_DEPTH, MOST_TAGS, MOST_TEXT_BYTES, MOST_TITLE_CHARS, MOST_URL_BYTES, Readable, html,
};

const FIVE_MIB: usize = 5 * 1024 * 1024;

/// Reads `source` on its own thread and fails if that takes longer than two seconds.
fn read_within_two_seconds(source: String) -> Readable {
    read_from_within_two_seconds("https://example.com/docs/page.html".to_owned(), source)
}

fn read_from_within_two_seconds(page_url: String, source: String) -> Readable {
    let (done, finished) = mpsc::channel();
    thread::spawn(move || {
        let base = Url::parse(&page_url).ok();
        let _ = done.send(base.map(|b| html(&source, &b)));
    });
    match finished.recv_timeout(Duration::from_secs(2)) {
        Ok(Some(readable)) => readable,
        Ok(None) => panic!("the base address did not parse"),
        Err(_) => panic!("reading took longer than two seconds"),
    }
}

fn repeat_to(unit: &str, bytes: usize) -> String {
    unit.repeat(bytes / unit.len())
}

#[test]
fn self_closing_divs_are_bounded_and_marked_truncated() {
    for source in ["<div/>".repeat(600_000), repeat_to("<div/>", FIVE_MIB)] {
        let read = read_within_two_seconds(source);
        assert!(read.truncated);
        assert_eq!(read.text, "");
    }
}

#[test]
fn unmatched_end_tags_do_not_unwind_the_bound() {
    for source in [
        "<div></x>".repeat(600_000),
        repeat_to("<div></x>", FIVE_MIB),
    ] {
        let read = read_within_two_seconds(source);
        assert!(read.truncated);
    }
}

#[test]
fn deep_nesting_with_text_everywhere_is_bounded() {
    let read = read_within_two_seconds(repeat_to("<div>x", FIVE_MIB));
    assert!(read.truncated);
    assert!(read.text.len() <= MOST_TEXT_BYTES);
}

#[test]
fn nesting_past_the_depth_limit_is_cut_and_marked() {
    let depth = MOST_DEPTH + 50;
    let source = format!(
        "<main>top{}bottom{}</main>",
        "<div>".repeat(depth),
        "</div>".repeat(depth)
    );
    let read = read_within_two_seconds(source);
    assert_eq!(read.text, "top");
    assert!(read.truncated);
}

#[test]
fn hidden_and_left_out_elements_just_past_the_depth_limit_stay_hidden() {
    // `<main>` and 255 divs fill the limit; the next element is one too deep.
    let divs = MOST_DEPTH - 1;
    for hidden in [
        "<span hidden>SECRET</span>",
        "<script>SECRET</script>",
        "<nav>SECRET</nav>",
        "<span style=\"display:none\">SECRET</span>",
    ] {
        let source = format!("<main>{}{hidden}</main>", "<div>".repeat(divs));
        let read = read_within_two_seconds(source);
        assert!(!read.text.contains("SECRET"), "{hidden}");
        assert!(read.truncated, "{hidden}");
    }
}

#[test]
fn hidden_elements_at_the_depth_limit_are_hidden_and_not_truncated() {
    let divs = MOST_DEPTH - 2;
    let source = format!(
        "<main>{}<span hidden>SECRET</span>shown</main>",
        "<div>".repeat(divs)
    );
    let read = read_within_two_seconds(source);
    assert_eq!(read.text, "shown");
    assert!(!read.truncated);
}

#[test]
fn the_tag_limit_is_exact() {
    // `<main>` is one tag; the rest are spans.
    let at_limit = format!("<main>{}end</main>", "<span>a</span>".repeat(MOST_TAGS - 1));
    let read = read_within_two_seconds(at_limit);
    assert!(!read.truncated);
    assert!(read.text.ends_with("aend"));

    let past_limit = format!("<main>{}end</main>", "<span>a</span>".repeat(MOST_TAGS));
    let read = read_within_two_seconds(past_limit);
    assert!(read.truncated);
    assert!(!read.text.ends_with("end"));
}

#[test]
fn a_huge_base_and_many_links_stay_bounded() {
    let base = format!("https://example.com/{}/", "p".repeat(1_200_000));
    let links = "<a href=x>t</a> ".repeat(100_000);
    let read = read_within_two_seconds(format!(
        "<head><base href=\"{base}\"></head><main>{links}</main>"
    ));
    assert!(read.text.len() <= MOST_TEXT_BYTES);
    assert!(read.truncated);
    // The oversized base is ignored, so links resolve against the page.
    assert!(read.text.starts_with("[t](https://example.com/docs/x) [t]"));
}

#[test]
fn a_link_too_long_to_keep_is_written_as_its_text() {
    let long = format!("/{}", "q".repeat(MOST_URL_BYTES));
    let read = read_within_two_seconds(format!(
        "<main><a href=\"{long}\">long</a> and <a href=\"/ok\">ok</a></main>"
    ));
    assert_eq!(read.text, "long and [ok](https://example.com/ok)");
}

#[test]
fn a_huge_title_is_cut() {
    let read = read_within_two_seconds(format!(
        "<title>{}</title><p>body</p>",
        "word ".repeat(400_000)
    ));
    let title = read.title.unwrap_or_default();
    assert!(!title.is_empty());
    assert!(title.chars().count() <= MOST_TITLE_CHARS);
}

#[test]
fn text_past_the_output_cap_is_cut_and_marked() {
    let read = read_within_two_seconds(format!("<main><p>{}</p></main>", "words ".repeat(400_000)));
    assert!(read.truncated);
    assert!(read.text.len() <= MOST_TEXT_BYTES);
    assert!(read.text.len() > MOST_TEXT_BYTES - 16);
}

#[test]
fn a_huge_page_address_cannot_be_copied_into_every_link() {
    let page_url = format!("https://example.com/{}/page", "p".repeat(300 * 1024));
    let links = "<a href=x>t</a> ".repeat(99_999);
    let read = read_from_within_two_seconds(
        page_url,
        format!("<main><a href=\"https://other.example/\">abs</a> {links}</main>"),
    );
    // Relative links have nothing short enough to resolve against, so they are text.
    assert!(read.text.starts_with("[abs](https://other.example/) t t t"));
    assert!(read.text.len() < 300_000);
}
