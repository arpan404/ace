//! Readable text from HTML: the main content as light Markdown. Pure: a string in, text out.
//!
//! The main content is the first `main` (or `role="main"`), else the first `article`, else the
//! body. Scripts, styles, navigation, page headers and footers, asides, forms and hidden elements
//! are dropped with everything inside them, which also drops text a page hides to steer an agent.
//! Headings become `#` lines, list items `- ` lines, links `[text](absolute url)`, `pre` blocks
//! fenced code, and whitespace is collapsed.
//!
//! The work is bounded whatever the page holds: see [`crate::html::tree`] for the parse limits,
//! [`MOST_TEXT_BYTES`] for the output and [`MOST_URL_BYTES`] for each link.

use reqwest::Url;

use crate::html::out::{Break, Out};
use crate::html::tree::{self, Element, Id, Node, Tree};

pub use crate::html::tree::{MOST_DEPTH, MOST_TAGS};

/// The most readable text kept from one page, in bytes. Past it the text is cut and marked
/// truncated.
pub const MOST_TEXT_BYTES: usize = 1024 * 1024;
/// The longest link kept as a link, in bytes. A longer one is written as its text alone.
pub const MOST_URL_BYTES: usize = 2048;
/// The longest title kept, in characters.
pub const MOST_TITLE_CHARS: usize = 300;

/// What a page reads as.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Readable {
    pub title: Option<String>,
    pub text: String,
    /// Whether the page was too large or too deeply built to read whole, so the text stops early.
    pub truncated: bool,
}

/// The readable text of `source`, a page fetched from `page_url` (links are resolved against it,
/// or against the page's own `<base href>`).
#[must_use]
pub fn html(source: &str, page_url: &Url) -> Readable {
    let tree = tree::build(source);
    // Relative links resolve against a base of at most MOST_URL_BYTES, so no link costs more
    // than that to write out. With no such base they are written as their text.
    let short =
        |u: &Url| matches!(u.scheme(), "http" | "https") && u.as_str().len() <= MOST_URL_BYTES;
    let page_base = Some(page_url).filter(|u| short(u));
    let base = tree
        .base
        .as_deref()
        .filter(|href| href.len() <= MOST_URL_BYTES)
        .and_then(|href| match page_base {
            Some(page) => page.join(href.trim()).ok(),
            None => Url::parse(href.trim()).ok(),
        })
        .filter(short)
        .or_else(|| page_base.cloned());
    let main = find(&tree, Tree::ROOT, &|el| {
        el.name.as_ref() == "main" || el.role.as_deref() == Some("main")
    })
    .or_else(|| find(&tree, Tree::ROOT, &|el| el.name.as_ref() == "article"))
    .or_else(|| find(&tree, Tree::ROOT, &|el| el.name.as_ref() == "body"))
    .unwrap_or(Tree::ROOT);
    let in_article = is_or_inside(&tree, main, "article");

    let mut out = Out::new(MOST_TEXT_BYTES);
    let ctx = Ctx {
        tree: &tree,
        base: base.as_ref(),
        list_depth: 0,
        in_article,
    };
    walk(main, &ctx, &mut out);

    let title = tree
        .title
        .as_deref()
        .map(collapse)
        .filter(|t| !t.is_empty())
        .or_else(|| {
            find(&tree, main, &|el| el.name.as_ref() == "h1")
                .map(|h1| plain(&tree, h1, MOST_TITLE_CHARS * 4))
                .filter(|t| !t.is_empty())
        })
        .map(|t| t.chars().take(MOST_TITLE_CHARS).collect());
    Readable {
        title,
        truncated: tree.truncated || out.full(),
        text: out.finish(),
    }
}

#[derive(Clone, Copy)]
struct Ctx<'a> {
    tree: &'a Tree,
    /// What relative links resolve against, when there is a short enough base.
    base: Option<&'a Url>,
    list_depth: usize,
    in_article: bool,
}

fn walk(id: Id, ctx: &Ctx<'_>, out: &mut Out) {
    match ctx.tree.nodes.get(id) {
        Some(Node::Text(text)) => out.text(text),
        Some(Node::Element(el)) => element(el, ctx, out),
        None => {}
    }
}

fn children(el: &Element, ctx: &Ctx<'_>, out: &mut Out) {
    let mut after_cell = false;
    for &child in &el.children {
        if out.full() {
            return;
        }
        let cell = ctx
            .tree
            .element(child)
            .is_some_and(|c| matches!(c.name.as_ref(), "td" | "th"));
        if cell && after_cell && out.inline == 0 {
            out.text(" | ");
        }
        after_cell |= cell;
        walk(child, ctx, out);
    }
}

fn element(el: &Element, ctx: &Ctx<'_>, out: &mut Out) {
    let name = el.name.as_ref();
    if out.inline > 0 {
        // Inside a link or code span everything is inline text.
        match name {
            "img" if out.in_link => out.text(el.alt.as_deref().unwrap_or("")),
            "br" => out.start(Break::Line),
            _ => children(el, ctx, out),
        }
        return;
    }
    if matches!(name, "header" | "footer") && !ctx.in_article {
        return;
    }
    match name {
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
            let level = usize::from(name.as_bytes()[1] - b'0');
            out.start(Break::Para);
            out.prefix(&format!("{} ", "#".repeat(level)));
            children(el, ctx, out);
            out.end(Break::Para);
        }
        "ul" | "ol" | "menu" => {
            let nested = ctx.list_depth > 0;
            let around = if nested { Break::Line } else { Break::Para };
            if nested {
                out.tighten();
            }
            out.start(around);
            let inner = Ctx {
                list_depth: ctx.list_depth + 1,
                ..*ctx
            };
            children(el, &inner, out);
            out.end(around);
        }
        "li" => {
            out.start(Break::Line);
            let indent = "  ".repeat(ctx.list_depth.saturating_sub(1));
            out.prefix(&format!("{indent}- "));
            children(el, ctx, out);
            out.end_item();
        }
        "a" => link(el, ctx, out),
        "pre" => {
            out.start(Break::Para);
            out.raw(&fence(el, ctx.tree));
            out.end(Break::Para);
        }
        "code" | "kbd" | "samp" => span("`", "`", el, ctx, out),
        "br" => out.start(Break::Line),
        "hr" => out.end(Break::Para),
        "tr" | "dt" | "dd" => {
            out.start(Break::Line);
            children(el, ctx, out);
            out.end(Break::Line);
        }
        "article" => {
            let inner = Ctx {
                in_article: true,
                ..*ctx
            };
            out.start(Break::Para);
            children(el, &inner, out);
            out.end(Break::Para);
        }
        "img" => {}
        _ if block(name) => {
            out.start(Break::Para);
            children(el, ctx, out);
            out.end(Break::Para);
        }
        _ => children(el, ctx, out),
    }
}

fn link(el: &Element, ctx: &Ctx<'_>, out: &mut Out) {
    let target = el
        .href
        .as_deref()
        .map(str::trim)
        .filter(|href| !href.starts_with('#') && href.len() <= MOST_URL_BYTES)
        .and_then(|href| match ctx.base {
            Some(base) => base.join(href).ok(),
            None => Url::parse(href).ok(),
        })
        .filter(|u| matches!(u.scheme(), "http" | "https" | "mailto"))
        .filter(|u| u.as_str().len() <= MOST_URL_BYTES);
    match target {
        Some(url) => {
            out.in_link = true;
            span("[", &format!("]({url})"), el, ctx, out);
            out.in_link = false;
        }
        None => children(el, ctx, out),
    }
}

/// Inline content between `opener` and `closer`, or nothing when it writes no text.
fn span(opener: &str, closer: &str, el: &Element, ctx: &Ctx<'_>, out: &mut Out) {
    let mark = out.mark();
    let after = out.open(opener);
    out.inline += 1;
    children(el, ctx, out);
    out.inline -= 1;
    if out.len() == after {
        out.back_to(mark);
    } else {
        out.close(closer);
    }
}

/// A fenced code block, with a fence longer than any run of backticks inside it.
fn fence(el: &Element, tree: &Tree) -> String {
    let lang = std::iter::once(el)
        .chain(
            el.children
                .iter()
                .filter_map(|&c| tree.element(c))
                .filter(|c| c.name.as_ref() == "code"),
        )
        .filter_map(|e| e.class.as_deref())
        .flat_map(str::split_ascii_whitespace)
        .find_map(|c| {
            c.strip_prefix("language-")
                .or_else(|| c.strip_prefix("lang-"))
        })
        .unwrap_or("");
    let mut code = String::new();
    raw_text(tree, el, &mut code, MOST_TEXT_BYTES);
    let code = code.strip_prefix('\n').unwrap_or(&code).trim_end();
    let longest_run = code.split(|c| c != '`').map(str::len).max().unwrap_or(0);
    let ticks = "`".repeat((longest_run + 1).max(3));
    format!("{ticks}{lang}\n{code}\n{ticks}")
}

/// The text under `el` as written, `<br>` as a line break, up to `most` bytes.
fn raw_text(tree: &Tree, el: &Element, into: &mut String, most: usize) {
    for &child in &el.children {
        if into.len() >= most {
            return;
        }
        match tree.nodes.get(child) {
            Some(Node::Text(t)) => into.push_str(t),
            Some(Node::Element(c)) if c.name.as_ref() == "br" => into.push('\n'),
            Some(Node::Element(c)) => raw_text(tree, c, into, most),
            None => {}
        }
    }
}

/// The collapsed text under `id`, from at most `most` bytes of it.
fn plain(tree: &Tree, id: Id, most: usize) -> String {
    let mut raw = String::new();
    if let Some(el) = tree.element(id) {
        raw_text(tree, el, &mut raw, most);
    }
    collapse(&raw)
}

fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_or_inside(tree: &Tree, mut id: Id, name: &str) -> bool {
    loop {
        if tree.element(id).is_some_and(|el| el.name.as_ref() == name) {
            return true;
        }
        if id == Tree::ROOT {
            return false;
        }
        id = tree.parents[id];
    }
}

/// The first element under `from`, in document order, that `matches`. Page headers and footers
/// outside an article are not searched, as they are not read.
fn find(tree: &Tree, from: Id, matches: &dyn Fn(&Element) -> bool) -> Option<Id> {
    let mut stack = vec![(from, is_or_inside(tree, from, "article"))];
    while let Some((id, in_article)) = stack.pop() {
        let Some(el) = tree.element(id) else { continue };
        if id != from {
            if matches!(el.name.as_ref(), "header" | "footer") && !in_article {
                continue;
            }
            if matches(el) {
                return Some(id);
            }
        }
        let in_article = in_article || el.name.as_ref() == "article";
        stack.extend(el.children.iter().rev().map(|&c| (c, in_article)));
    }
    None
}

fn block(name: &str) -> bool {
    matches!(
        name,
        "p" | "div"
            | "section"
            | "main"
            | "body"
            | "html"
            | "blockquote"
            | "figure"
            | "figcaption"
            | "dl"
            | "address"
            | "details"
            | "summary"
            | "table"
            | "thead"
            | "tbody"
            | "tfoot"
            | "caption"
            | "center"
            | "header"
            | "footer"
    )
}
