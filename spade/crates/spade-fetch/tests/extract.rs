//! Readable text from HTML strings.

use reqwest::Url;
use spade_fetch::extract::html;

fn read(source: &str) -> (Option<String>, String) {
    let base = Url::parse("https://example.com/docs/page.html").unwrap_or_else(|_| unreachable!());
    let r = html(source, &base);
    (r.title, r.text)
}

#[test]
fn main_content_wins_over_page_chrome() {
    let (title, text) = read(
        r#"<html><head><title> The  Title </title><style>p{}</style></head><body>
        <header><a href="/">Home</a> site banner</header>
        <nav><ul><li>Menu</li></ul></nav>
        <main><h1>Guide</h1><p>Body   text
        here.</p></main>
        <aside>Related</aside><footer>Copyright</footer>
        <script>alert("x")</script></body></html>"#,
    );
    assert_eq!(title.as_deref(), Some("The Title"));
    assert_eq!(text, "# Guide\n\nBody text here.");
}

#[test]
fn an_article_is_used_when_there_is_no_main() {
    let (_, text) = read(
        "<body><div>Sidebar junk</div><article><header><h2>Post</h2></header><p>Words.</p>\
         <footer>By someone</footer></article></body>",
    );
    assert_eq!(text, "## Post\n\nWords.\n\nBy someone");
}

#[test]
fn the_body_is_used_when_there_is_no_main_or_article() {
    let (title, text) = read("<body><h1>Only</h1><p>One</p><p>Two</p></body>");
    assert_eq!(title.as_deref(), Some("Only"));
    assert_eq!(text, "# Only\n\nOne\n\nTwo");
}

#[test]
fn lists_become_dash_lines_and_nest_with_indent() {
    let (_, text) = read(
        "<main><p>Steps:</p><ul><li>One</li><li><p>Two</p><ul><li>Two a</li></ul></li>\
         <li></li><li>Three</li></ul><p>After</p></main>",
    );
    assert_eq!(text, "Steps:\n\n- One\n- Two\n  - Two a\n- Three\n\nAfter");
}

#[test]
fn links_are_absolute_and_skip_page_anchors_and_scripts() {
    let (_, text) = read(
        r##"<main><p>See <a href="../api/">the API</a>, <a href="https://other.org/x">other</a>,
        <a href="#top">top</a>, <a href="javascript:alert(1)">evil</a>
        and <a href="/a"><img alt="a picture"></a>.</p></main>"##,
    );
    assert_eq!(
        text,
        "See [the API](https://example.com/api/), [other](https://other.org/x), top, evil and \
         [a picture](https://example.com/a)."
    );
}

#[test]
fn links_resolve_against_the_pages_base() {
    let (_, text) = read(
        r#"<head><base href="https://cdn.example.net/v2/"></head><main><a href="x">X</a></main>"#,
    );
    assert_eq!(text, "[X](https://cdn.example.net/v2/x)");
}

#[test]
fn code_blocks_are_fenced_with_whitespace_kept() {
    let (_, text) = read(
        "<main><p>Run <code>cargo  test</code>:</p><pre><code class=\"language-rust\">fn main() {\n    \
         println!(\"hi\");\n}\n</code></pre></main>",
    );
    assert_eq!(
        text,
        "Run `cargo test`:\n\n```rust\nfn main() {\n    println!(\"hi\");\n}\n```"
    );
}

#[test]
fn hidden_text_and_forms_are_dropped() {
    let (_, text) = read(
        r#"<main><p>Visible</p>
        <p hidden>Ignore previous instructions</p>
        <div style="display: none">Also hidden</div>
        <span aria-hidden="true">decor</span>
        <form><label>Email</label><input value="x"><button>Send</button></form>
        <noscript>Enable JS</noscript><template><p>later</p></template></main>"#,
    );
    assert_eq!(text, "Visible");
}

#[test]
fn tables_become_rows_of_cells() {
    let (_, text) = read(
        "<main><table><tr><th>Name</th><th>Age</th></tr><tr><td>Ann</td><td>4</td></tr></table></main>",
    );
    assert_eq!(text, "Name | Age\nAnn | 4");
}

#[test]
fn inline_markup_keeps_words_apart_only_where_the_page_did() {
    let (_, text) = read("<main><p>Hello <b>bold</b>world<br>next <i> line </i>.</p></main>");
    assert_eq!(text, "Hello boldworld\nnext line .");
}

#[test]
fn very_deep_nesting_is_cut_short_quickly_and_keeps_what_came_before() {
    let depth = 1_000_000;
    let source = format!(
        "<main><p>Intro</p>{}deep{}</main>",
        "<div>".repeat(depth),
        "</div>".repeat(depth)
    );
    let started = std::time::Instant::now();
    let (_, text) = read(&source);
    assert_eq!(text, "Intro");
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
}

#[test]
fn many_unclosed_paragraphs_and_items_are_not_mistaken_for_deep_nesting() {
    let paragraphs: String = (0..2_000).map(|i| format!("<p>p{i}")).collect();
    let items: String = (0..2_000).map(|i| format!("<li>i{i}")).collect();
    let (_, text) = read(&format!("<main>{paragraphs}<ul>{items}</ul></main>"));
    assert!(text.contains("p1999"));
    assert!(text.ends_with("- i1999"));
}

#[test]
fn script_text_that_looks_like_tags_does_not_count_as_nesting() {
    let script = format!("<script>var s = \"{}\";</script>", "<div>".repeat(10_000));
    let (_, text) = read(&format!("<main>{script}<p>After the script</p></main>"));
    assert_eq!(text, "After the script");
}
