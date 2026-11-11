//! Readable text from HTML: the main content as light Markdown. Pure: a string in, text out.
//!
//! The main content is the first `main` (or `role="main"`), else the first `article`, else the
//! body. Scripts, styles, navigation, page headers and footers, asides, forms and hidden elements
//! are dropped, which also drops text a page hides to steer an agent. Headings become `#` lines,
//! list items `- ` lines, links `[text](absolute url)`, `pre` blocks fenced code, and whitespace
//! is collapsed.

use ego_tree::NodeRef;
use reqwest::Url;
use scraper::{Html, Node};

/// What a page reads as.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Readable {
    pub title: Option<String>,
    pub text: String,
}

/// Deeper nesting than this is skipped, so a hostile page cannot exhaust the stack.
const MOST_DEPTH: usize = 200;

/// The readable text of `source`, a page fetched from `page_url` (links are resolved against it,
/// or against the page's own `<base href>`).
#[must_use]
pub fn html(source: &str, page_url: &Url) -> Readable {
    let doc = Html::parse_document(source);
    let root = doc.tree.root();
    let base = find(root, &|el| el.name() == "base" && el.attr("href").is_some())
        .and_then(|n| element(n)?.attr("href").map(str::to_owned))
        .and_then(|href| page_url.join(&href).ok())
        .filter(|u| matches!(u.scheme(), "http" | "https"))
        .unwrap_or_else(|| page_url.clone());
    let main = find(root, &|el| {
        el.name() == "main" || el.attr("role") == Some("main")
    })
    .or_else(|| find(root, &|el| el.name() == "article"))
    .or_else(|| find(root, &|el| el.name() == "body"))
    .unwrap_or(root);

    let mut out = Out::default();
    let in_article = main
        .ancestors()
        .chain(std::iter::once(main))
        .any(|n| element(n).is_some_and(|el| el.name() == "article"));
    walk(
        main,
        &Ctx {
            base: &base,
            list_depth: 0,
            in_article,
            depth: 0,
        },
        &mut out,
    );

    let title = find(root, &|el| el.name() == "title")
        .map(plain)
        .filter(|t| !t.is_empty())
        .or_else(|| {
            find(main, &|el| el.name() == "h1")
                .map(plain)
                .filter(|t| !t.is_empty())
        });
    Readable {
        title,
        text: out.finish(),
    }
}

struct Ctx<'a> {
    base: &'a Url,
    list_depth: usize,
    in_article: bool,
    depth: usize,
}

impl Ctx<'_> {
    fn child(&self) -> Self {
        Ctx {
            base: self.base,
            list_depth: self.list_depth,
            in_article: self.in_article,
            depth: self.depth + 1,
        }
    }
}

fn walk(node: NodeRef<'_, Node>, ctx: &Ctx<'_>, out: &mut Out) {
    if ctx.depth > MOST_DEPTH {
        return;
    }
    match node.value() {
        Node::Text(text) => out.text(text),
        Node::Element(el) => element_into(node, el, ctx, out),
        Node::Document | Node::Fragment => children(node, ctx, out),
        _ => {}
    }
}

fn children(node: NodeRef<'_, Node>, ctx: &Ctx<'_>, out: &mut Out) {
    let ctx = ctx.child();
    for child in node.children() {
        walk(child, &ctx, out);
    }
}

fn element_into(
    node: NodeRef<'_, Node>,
    el: &scraper::node::Element,
    ctx: &Ctx<'_>,
    out: &mut Out,
) {
    let name = el.name();
    if dropped(el) || (matches!(name, "header" | "footer") && !ctx.in_article) {
        return;
    }
    match name {
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
            let level = usize::from(name.as_bytes()[1] - b'0');
            out.start(Break::Para);
            out.prefix(&format!("{} ", "#".repeat(level)));
            children(node, ctx, out);
            out.end(Break::Para);
        }
        "ul" | "ol" | "menu" => {
            let around = if ctx.list_depth > 0 {
                Break::Line
            } else {
                Break::Para
            };
            out.start(around);
            let inner = Ctx {
                list_depth: ctx.list_depth + 1,
                ..ctx.child()
            };
            for child in node.children() {
                walk(child, &inner, out);
            }
            out.end(around);
        }
        "li" => {
            out.start(Break::Line);
            let indent = "  ".repeat(ctx.list_depth.saturating_sub(1));
            out.prefix(&format!("{indent}- "));
            children(node, ctx, out);
            out.end_item();
        }
        "a" => link(node, el, ctx, out),
        "pre" => {
            out.start(Break::Para);
            out.raw(&fence(node, el));
            out.end(Break::Para);
        }
        "code" | "kbd" | "samp" => {
            let code = plain(node);
            if !code.is_empty() {
                out.text(&format!("`{code}`"));
            }
        }
        "br" => out.start(Break::Line),
        "hr" => out.end(Break::Para),
        "tr" | "dt" | "dd" => {
            out.start(Break::Line);
            children(node, ctx, out);
            out.end(Break::Line);
        }
        "td" | "th" => {
            let after_cell = node
                .prev_siblings()
                .any(|s| element(s).is_some_and(|e| matches!(e.name(), "td" | "th")));
            if after_cell {
                out.text(" | ");
            }
            children(node, ctx, out);
        }
        "article" => {
            let inner = Ctx {
                in_article: true,
                ..ctx.child()
            };
            out.start(Break::Para);
            for child in node.children() {
                walk(child, &inner, out);
            }
            out.end(Break::Para);
        }
        _ if block(name) => {
            out.start(Break::Para);
            children(node, ctx, out);
            out.end(Break::Para);
        }
        _ => children(node, ctx, out),
    }
}

fn link(node: NodeRef<'_, Node>, el: &scraper::node::Element, ctx: &Ctx<'_>, out: &mut Out) {
    let text = {
        let t = plain(node);
        if t.is_empty() {
            find(node, &|e| e.name() == "img")
                .and_then(|n| element(n)?.attr("alt").map(collapse))
                .unwrap_or_default()
        } else {
            t
        }
    };
    if text.is_empty() {
        return;
    }
    let target = el
        .attr("href")
        .map(str::trim)
        .filter(|href| !href.starts_with('#'))
        .and_then(|href| ctx.base.join(href).ok())
        .filter(|u| matches!(u.scheme(), "http" | "https" | "mailto"));
    match target {
        Some(url) => out.text(&format!("[{}]({url})", text.replace(']', "\\]"))),
        None => out.text(&text),
    }
}

fn fence(node: NodeRef<'_, Node>, el: &scraper::node::Element) -> String {
    let lang = std::iter::once(el)
        .chain(
            node.children()
                .filter_map(element)
                .filter(|e| e.name() == "code"),
        )
        .flat_map(|e| e.classes())
        .find_map(|c| {
            c.strip_prefix("language-")
                .or_else(|| c.strip_prefix("lang-"))
        })
        .unwrap_or("")
        .to_owned();
    let mut code = String::new();
    raw_text(node, &mut code, 0);
    let code = code.strip_prefix('\n').unwrap_or(&code).trim_end();
    let ticks = if code.contains("```") { "````" } else { "```" };
    format!("{ticks}{lang}\n{code}\n{ticks}")
}

fn raw_text(node: NodeRef<'_, Node>, into: &mut String, depth: usize) {
    if depth > MOST_DEPTH {
        return;
    }
    for child in node.children() {
        match child.value() {
            Node::Text(t) => into.push_str(t),
            Node::Element(el) if el.name() == "br" => into.push('\n'),
            Node::Element(el) if !dropped(el) => raw_text(child, into, depth + 1),
            _ => {}
        }
    }
}

/// The collapsed visible text under `node`.
fn plain(node: NodeRef<'_, Node>) -> String {
    let mut raw = String::new();
    raw_text(node, &mut raw, 0);
    collapse(&raw)
}

fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn element(node: NodeRef<'_, Node>) -> Option<&scraper::node::Element> {
    match node.value() {
        Node::Element(el) => Some(el),
        _ => None,
    }
}

/// The first element under `node`, in document order, that `matches`, skipping dropped ones.
fn find<'a>(
    node: NodeRef<'a, Node>,
    matches: &dyn Fn(&scraper::node::Element) -> bool,
) -> Option<NodeRef<'a, Node>> {
    node.descendants()
        .find(|n| element(*n).is_some_and(matches))
}

/// Elements whose content is never page text, or is hidden from the reader.
fn dropped(el: &scraper::node::Element) -> bool {
    let never = matches!(
        el.name(),
        "script"
            | "style"
            | "noscript"
            | "template"
            | "nav"
            | "aside"
            | "form"
            | "button"
            | "input"
            | "select"
            | "textarea"
            | "svg"
            | "canvas"
            | "iframe"
            | "object"
            | "embed"
            | "head"
            | "title"
    );
    let hidden = el.attr("hidden").is_some()
        || el.attr("aria-hidden") == Some("true")
        || el.attr("style").is_some_and(|s| {
            let s: String = s
                .chars()
                .filter(|c| !c.is_whitespace())
                .collect::<String>()
                .to_ascii_lowercase();
            s.contains("display:none") || s.contains("visibility:hidden")
        });
    never || hidden
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default)]
enum Break {
    #[default]
    None,
    Line,
    Para,
}

/// The text being written, with whitespace collapsed as it goes.
#[derive(Default)]
struct Out {
    text: String,
    /// The break owed before the next text.
    pending: Break,
    /// A space is owed before the next text.
    space: bool,
    /// Where an item or heading prefix starts while nothing has followed it yet.
    prefix_at: Option<usize>,
}

impl Out {
    /// An element opens. Ignored right after a prefix, so `<li><p>x` stays on one line.
    fn start(&mut self, at_least: Break) {
        if self.prefix_at.is_none() {
            self.pending = self.pending.max(at_least);
        }
    }

    /// An element closes. A prefix nothing followed is taken back.
    fn end(&mut self, at_least: Break) {
        self.drop_bare_prefix();
        self.pending = self.pending.max(at_least);
    }

    /// A list item closes: the next item follows on the next line.
    fn end_item(&mut self) {
        self.drop_bare_prefix();
        self.pending = Break::Line;
    }

    fn drop_bare_prefix(&mut self) {
        if let Some(at) = self.prefix_at.take() {
            self.text.truncate(at);
        }
    }

    fn prefix(&mut self, prefix: &str) {
        self.drop_bare_prefix();
        self.flush_break();
        let at = self.text.len();
        self.text.push_str(prefix);
        self.prefix_at = Some(at);
        self.space = false;
    }

    fn raw(&mut self, raw: &str) {
        self.flush_break();
        if self.space {
            self.text.push(' ');
        }
        self.text.push_str(raw);
        self.prefix_at = None;
        self.space = false;
    }

    fn text(&mut self, text: &str) {
        for word in text.split_inclusive(char::is_whitespace) {
            let trimmed = word.trim_end_matches(char::is_whitespace);
            if !trimmed.is_empty() {
                if self.pending != Break::None {
                    self.flush_break();
                } else if self.space && !self.text.is_empty() && !self.text.ends_with([' ', '\n']) {
                    self.text.push(' ');
                }
                self.text.push_str(trimmed);
                self.prefix_at = None;
                self.space = false;
            }
            if trimmed.len() < word.len() {
                self.space = true;
            }
        }
    }

    fn flush_break(&mut self) {
        let owed = std::mem::take(&mut self.pending);
        if owed == Break::None {
            return;
        }
        self.space = false;
        let kept = self.text.trim_end_matches(' ').len();
        self.text.truncate(kept);
        if self.text.is_empty() {
            return;
        }
        self.text
            .push_str(if owed == Break::Para { "\n\n" } else { "\n" });
    }

    fn finish(mut self) -> String {
        self.drop_bare_prefix();
        self.text.trim().to_owned()
    }
}
