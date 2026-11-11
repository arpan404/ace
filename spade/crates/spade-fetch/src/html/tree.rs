//! Builds a small document tree from tokens, within fixed bounds: at most [`MOST_DEPTH`] open
//! elements and [`MOST_TAGS`] start tags. Elements whose content is never page text (scripts,
//! navigation, forms and so on) and hidden elements are left out with everything inside them.
//!
//! Each end tag is matched in constant time against a count of open elements by name, and each
//! implied close (a `<p>` ending the paragraph before it, say) looks up the element it closes
//! instead of searching for it, so building is linear in the size of the page.

use std::collections::HashMap;

use super::tokens::{Flow, Start, Token, tokenize};

/// The deepest nesting kept. Start tags past it are ignored and their text joins their parent.
pub const MOST_DEPTH: usize = 256;
/// The most start tags read. Past it the document is cut and marked truncated.
pub const MOST_TAGS: usize = 100_000;
/// The longest title or base address kept, in bytes.
const MOST_HEAD_BYTES: usize = 2048;

pub type Id = usize;

pub struct Element {
    pub name: Box<str>,
    pub href: Option<String>,
    pub class: Option<String>,
    pub role: Option<String>,
    pub alt: Option<String>,
    pub children: Vec<Id>,
}

pub enum Node {
    Element(Element),
    Text(String),
}

pub struct Tree {
    pub nodes: Vec<Node>,
    pub parents: Vec<Id>,
    /// The first `<title>`, raw.
    pub title: Option<String>,
    /// The first `<base href>`, raw, when short enough.
    pub base: Option<String>,
    /// Whether the document was cut short at [`MOST_TAGS`].
    pub truncated: bool,
}

impl Tree {
    pub const ROOT: Id = 0;

    pub fn element(&self, id: Id) -> Option<&Element> {
        match self.nodes.get(id) {
            Some(Node::Element(el)) => Some(el),
            _ => None,
        }
    }
}

/// Elements an earlier one closes on its own: `<p>` before a block, `<li>` before the next
/// item, and so on. Each open element remembers where the nearest one of each kind is.
#[derive(Clone, Copy)]
enum Group {
    P,
    Li,
    DtDd,
    Cell,
    Row,
    Option,
    Head,
}

const GROUPS: usize = 7;

impl Group {
    fn target(self, name: &str) -> bool {
        match self {
            Self::P => name == "p",
            Self::Li => name == "li",
            Self::DtDd => matches!(name, "dt" | "dd"),
            Self::Cell => matches!(name, "td" | "th"),
            Self::Row => name == "tr",
            Self::Option => name == "option",
            Self::Head => name == "head",
        }
    }

    /// Elements the search for an open one does not reach past.
    fn boundary(self, name: &str) -> bool {
        let scope = matches!(
            name,
            "table" | "td" | "th" | "caption" | "template" | "object" | "marquee" | "applet"
        );
        match self {
            Self::P => scope || name == "button",
            Self::Li => scope || matches!(name, "ul" | "ol" | "menu"),
            Self::DtDd => scope || name == "dl",
            Self::Cell => name == "table",
            Self::Row => matches!(name, "table" | "thead" | "tbody" | "tfoot"),
            Self::Option => matches!(name, "select" | "datalist" | "optgroup"),
            Self::Head => false,
        }
    }
}

const ALL: [Group; GROUPS] = [
    Group::P,
    Group::Li,
    Group::DtDd,
    Group::Cell,
    Group::Row,
    Group::Option,
    Group::Head,
];

struct Open {
    name: Box<str>,
    /// The node, unless this element is left out.
    node: Option<Id>,
    hidden: bool,
    nearest: [Option<usize>; GROUPS],
}

struct Builder {
    tree: Tree,
    stack: Vec<Open>,
    open_by_name: HashMap<Box<str>, usize>,
    tags: usize,
}

/// The tree of `source`.
pub fn build(source: &str) -> Tree {
    let root = Element {
        name: "#root".into(),
        href: None,
        class: None,
        role: None,
        alt: None,
        children: Vec::new(),
    };
    let mut b = Builder {
        tree: Tree {
            nodes: vec![Node::Element(root)],
            parents: vec![Tree::ROOT],
            title: None,
            base: None,
            truncated: false,
        },
        stack: vec![Open {
            name: "#root".into(),
            node: Some(Tree::ROOT),
            hidden: false,
            nearest: [None; GROUPS],
        }],
        open_by_name: HashMap::new(),
        tags: 0,
    };
    tokenize(source, &mut |token| b.take(token));
    b.tree
}

impl Builder {
    fn top(&self) -> &Open {
        // The root is never popped.
        &self.stack[self.stack.len() - 1]
    }

    fn take(&mut self, token: Token<'_>) -> Flow {
        match token {
            Token::Text(text) => self.text(&text),
            Token::End(name) => self.end(&name),
            Token::Start(start) => {
                self.tags += 1;
                if self.tags > MOST_TAGS {
                    self.tree.truncated = true;
                    return Flow::Stop;
                }
                self.start(start);
            }
        }
        Flow::Go
    }

    fn text(&mut self, text: &str) {
        let top = self.top();
        if top.name.as_ref() == "title" && !top.hidden && self.tree.title.is_none() {
            self.tree.title = Some(cut(text, MOST_HEAD_BYTES).to_owned());
            return;
        }
        let Some(parent) = top.node else { return };
        let last = self
            .tree
            .element(parent)
            .and_then(|el| el.children.last().copied());
        if let Some(Node::Text(existing)) = last.and_then(|id| self.tree.nodes.get_mut(id)) {
            existing.push_str(text);
            return;
        }
        self.add(parent, Node::Text(text.to_owned()));
    }

    fn add(&mut self, parent: Id, node: Node) -> Id {
        let id = self.tree.nodes.len();
        self.tree.nodes.push(node);
        self.tree.parents.push(parent);
        if let Some(Node::Element(el)) = self.tree.nodes.get_mut(parent) {
            el.children.push(id);
        }
        id
    }

    fn start(&mut self, start: Start) {
        let name = start.name.as_str();
        if matches!(name, "html" | "body") && self.open_by_name.get(name).is_some_and(|n| *n > 0) {
            return;
        }
        if !head_content(name) {
            self.close(Group::Head);
        }
        self.close_implied(name);

        let attrs = &start.attrs;
        let (parent_node, parent_hidden) = (self.top().node, self.top().hidden);
        let hidden = parent_hidden || is_hidden(attrs);
        let left_out = parent_node.is_none() || hidden || left_out(name);
        if name == "base" && !hidden && self.tree.base.is_none() {
            self.tree.base = attr(attrs, "href")
                .filter(|h| h.len() <= MOST_HEAD_BYTES)
                .map(str::to_owned);
        }
        let void = is_void(name) || (start.self_closing && parent_node.is_none());
        if !void && self.stack.len() > MOST_DEPTH {
            return;
        }
        let node = match parent_node {
            Some(parent_id) if !left_out => {
                let element = Element {
                    name: name.into(),
                    href: attr(attrs, "href").map(str::to_owned),
                    class: attr(attrs, "class").map(str::to_owned),
                    role: attr(attrs, "role").map(str::to_owned),
                    alt: attr(attrs, "alt").map(str::to_owned),
                    children: Vec::new(),
                };
                Some(self.add(parent_id, Node::Element(element)))
            }
            _ => None,
        };
        if void {
            return;
        }
        let depth = self.stack.len();
        let mut nearest = self.top().nearest;
        for (slot, group) in nearest.iter_mut().zip(ALL) {
            if group.target(name) {
                *slot = Some(depth);
            } else if group.boundary(name) {
                *slot = None;
            }
        }
        *self.open_by_name.entry(name.into()).or_insert(0) += 1;
        self.stack.push(Open {
            name: name.into(),
            node,
            hidden,
            nearest,
        });
    }

    /// Closes what `name` closes by starting.
    fn close_implied(&mut self, name: &str) {
        if closes_p(name) {
            self.close(Group::P);
        }
        match name {
            "li" => self.close(Group::Li),
            "dt" | "dd" => self.close(Group::DtDd),
            "td" | "th" => self.close(Group::Cell),
            "tr" | "thead" | "tbody" | "tfoot" => {
                self.close(Group::Cell);
                self.close(Group::Row);
            }
            "option" | "optgroup" => self.close(Group::Option),
            _ if is_heading(name) && is_heading(&self.top().name) => {
                self.pop_to(self.stack.len() - 1);
            }
            _ => {}
        }
    }

    fn close(&mut self, group: Group) {
        if let Some(at) = self.top().nearest[group as usize] {
            self.pop_to(at);
        }
    }

    fn end(&mut self, name: &str) {
        if self.open_by_name.get(name).is_none_or(|n| *n == 0) {
            return;
        }
        while self.stack.len() > 1 {
            let closed = self.pop();
            if closed.as_ref() == name {
                break;
            }
        }
    }

    /// Pops until the stack is `len` long.
    fn pop_to(&mut self, len: usize) {
        while self.stack.len() > len.max(1) {
            self.pop();
        }
    }

    fn pop(&mut self) -> Box<str> {
        let Some(open) = self.stack.pop() else {
            return "".into();
        };
        if let Some(n) = self.open_by_name.get_mut(&open.name) {
            *n = n.saturating_sub(1);
        }
        open.name
    }
}

fn cut(text: &str, most: usize) -> &str {
    let mut end = most.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn attr<'a>(attrs: &'a [(String, String)], key: &str) -> Option<&'a str> {
    attrs
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
}

fn is_hidden(attrs: &[(String, String)]) -> bool {
    attr(attrs, "hidden").is_some()
        || attr(attrs, "aria-hidden").is_some_and(|v| v.eq_ignore_ascii_case("true"))
        || attr(attrs, "style").is_some_and(|s| {
            let s: String = s
                .chars()
                .filter(|c| !c.is_whitespace())
                .collect::<String>()
                .to_ascii_lowercase();
            s.contains("display:none") || s.contains("visibility:hidden")
        })
}

/// Elements whose content is never page text.
fn left_out(name: &str) -> bool {
    matches!(
        name,
        "head"
            | "title"
            | "script"
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
            | "math"
            | "canvas"
            | "iframe"
            | "object"
            | "embed"
            | "noembed"
            | "noframes"
            | "xmp"
            | "plaintext"
    )
}

fn is_void(name: &str) -> bool {
    matches!(
        name,
        "area"
            | "base"
            | "br"
            | "col"
            | "embed"
            | "hr"
            | "img"
            | "input"
            | "link"
            | "meta"
            | "source"
            | "track"
            | "wbr"
            | "param"
            | "keygen"
    )
}

fn is_heading(name: &str) -> bool {
    matches!(name, "h1" | "h2" | "h3" | "h4" | "h5" | "h6")
}

/// Elements that may sit in `<head>`; anything else ends it.
fn head_content(name: &str) -> bool {
    matches!(
        name,
        "head" | "title" | "meta" | "link" | "base" | "style" | "script" | "noscript" | "template"
    )
}

fn closes_p(name: &str) -> bool {
    is_heading(name)
        || matches!(
            name,
            "address"
                | "article"
                | "aside"
                | "blockquote"
                | "details"
                | "dialog"
                | "div"
                | "dl"
                | "dd"
                | "dt"
                | "fieldset"
                | "figcaption"
                | "figure"
                | "footer"
                | "form"
                | "header"
                | "hgroup"
                | "hr"
                | "li"
                | "main"
                | "menu"
                | "nav"
                | "ol"
                | "p"
                | "pre"
                | "section"
                | "summary"
                | "table"
                | "ul"
        )
}
