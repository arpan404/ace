//! Builds a small document tree from html5ever's tokenizer (its tokenizer only: the tree
//! builder is this module), within fixed bounds: at most [`MOST_DEPTH`] open elements and
//! [`MOST_TAGS`] start tags; past either, the document is cut and marked truncated. Elements whose content is never page text (scripts,
//! navigation, forms and so on) and hidden elements are left out with everything inside them.
//!
//! Each end tag is matched in constant time against a count of open elements by name, and each
//! implied close (a `<p>` ending the paragraph before it, say) looks up the element it closes
//! instead of searching for it, so building is linear in the size of the page.

use std::cell::RefCell;
use std::collections::HashMap;

use html5ever::TokenizerResult;

use super::names::{
    breaks_out_of_foreign, closes_p, head_content, html_inside, is_heading, is_void, left_out,
};
use html5ever::tendril::StrTendril;
use html5ever::tokenizer::states::RawKind;
use html5ever::tokenizer::{
    BufferQueue, Tag, TagKind, Token, TokenSink, TokenSinkResult, Tokenizer, TokenizerOpts,
};

/// The deepest nesting read. Past it the document is cut and marked truncated.
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
    /// Whether the document was cut short at [`MOST_DEPTH`] or [`MOST_TAGS`].
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
    Section,
}

const GROUPS: usize = 8;

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
            Self::Section => matches!(name, "thead" | "tbody" | "tfoot"),
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
            Self::Section => name == "table",
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
    Group::Section,
];

struct Open {
    name: Box<str>,
    /// The node, unless this element is left out.
    node: Option<Id>,
    hidden: bool,
    /// An SVG or MathML element, so CDATA sections exist directly inside it.
    foreign: bool,
    /// Whether this element's children are HTML: an HTML element, or an SVG or MathML
    /// integration point. When not, a start tag is SVG or MathML too, and `/>` closes it.
    children_html: bool,
    nearest: [Option<usize>; GROUPS],
}

/// Where the first `<title>`'s text is.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Title {
    NotYet,
    Reading,
    Read,
}

struct Builder {
    tree: Tree,
    stack: Vec<Open>,
    open_by_name: HashMap<Box<str>, usize>,
    tags: usize,
    title: Title,
    stopped: bool,
}

/// What the tokenizer is told after a token.
type Next = TokenSinkResult<()>;

/// Tells the tokenizer to stop: html5ever pauses a feed when a script needs running, and this
/// builder never resumes it.
const STOP: Next = TokenSinkResult::Script(());

struct Sink(RefCell<Builder>);

impl TokenSink for Sink {
    type Handle = ();

    fn process_token(&self, token: Token, _line: u64) -> Next {
        match self.0.try_borrow_mut() {
            Ok(mut builder) => builder.take(token),
            Err(_) => STOP,
        }
    }

    fn adjusted_current_node_present_but_not_in_html_namespace(&self) -> bool {
        self.0.try_borrow().is_ok_and(|b| b.top().foreign)
    }
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
    let builder = Builder {
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
            foreign: false,
            children_html: true,
            nearest: [None; GROUPS],
        }],
        open_by_name: HashMap::new(),
        tags: 0,
        title: Title::NotYet,
        stopped: false,
    };
    let source = super::attrs::within_limit(source);
    let tokenizer = Tokenizer::new(Sink(RefCell::new(builder)), TokenizerOpts::default());
    let input = BufferQueue::default();
    input.push_back(StrTendril::from_slice(&source));
    if matches!(tokenizer.feed(&input), TokenizerResult::Done) {
        tokenizer.end();
    }
    tokenizer.sink.0.into_inner().tree
}

impl Builder {
    fn top(&self) -> &Open {
        // The root is never popped.
        &self.stack[self.stack.len() - 1]
    }

    fn take(&mut self, token: Token) -> Next {
        if self.stopped {
            return STOP;
        }
        match token {
            Token::CharacterTokens(text) => self.text(&text),
            Token::TagToken(tag) if tag.kind == TagKind::EndTag => self.end(&tag.name),
            Token::TagToken(tag) => {
                self.tags += 1;
                if self.tags > MOST_TAGS {
                    return self.stop();
                }
                return self.start(tag);
            }
            _ => {}
        }
        TokenSinkResult::Continue
    }

    fn stop(&mut self) -> Next {
        self.tree.truncated = true;
        self.stopped = true;
        STOP
    }

    fn text(&mut self, text: &str) {
        let top = self.top();
        if self.title == Title::Reading && top.name.as_ref() == "title" {
            let title = self.tree.title.get_or_insert_with(String::new);
            let room = MOST_HEAD_BYTES.saturating_sub(title.len());
            title.push_str(cut(text, room));
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

    fn start(&mut self, tag: Tag) -> Next {
        let name: &str = &tag.name;
        let attrs: Vec<(&str, &str)> = tag
            .attrs
            .iter()
            .map(|a| (&*a.name.local, &*a.value))
            .collect();
        // Some HTML start tags end SVG or MathML content, back to the nearest element whose
        // children are HTML, which may be an integration point inside it (and so keeps its
        // hidden ancestors).
        if !self.top().children_html && breaks_out_of_foreign(name, &attrs) {
            while self.stack.len() > 1 && !self.top().children_html {
                self.pop();
            }
        }
        let foreign = matches!(name, "svg" | "math") || !self.top().children_html;
        let children_html = !foreign || html_inside(name, &attrs);
        if !foreign {
            if matches!(name, "html" | "body")
                && self.open_by_name.get(name).is_some_and(|n| *n > 0)
            {
                return TokenSinkResult::Continue;
            }
            if !head_content(name) {
                self.close(Group::Head);
            }
            self.close_implied(name);
        }

        let (parent_node, parent_hidden) = (self.top().node, self.top().hidden);
        let hidden = parent_hidden || is_hidden(&attrs);
        let left_out = parent_node.is_none() || hidden || left_out(name);
        if name == "base" && !hidden && self.tree.base.is_none() {
            self.tree.base = attr(&attrs, "href")
                .filter(|h| h.len() <= MOST_HEAD_BYTES)
                .map(str::to_owned);
        }
        // `/>` closes an element only in SVG and MathML; in HTML only void elements are empty.
        let void = if foreign {
            tag.self_closing
        } else {
            is_void(name)
        };
        if !void && self.stack.len() > MOST_DEPTH {
            return self.stop();
        }
        let node = match parent_node {
            Some(parent_id) if !left_out => {
                let element = Element {
                    name: name.into(),
                    href: attr(&attrs, "href").map(str::to_owned),
                    class: attr(&attrs, "class").map(str::to_owned),
                    role: attr(&attrs, "role").map(str::to_owned),
                    alt: attr(&attrs, "alt").map(str::to_owned),
                    children: Vec::new(),
                };
                Some(self.add(parent_id, Node::Element(element)))
            }
            _ => None,
        };
        if void {
            return TokenSinkResult::Continue;
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
        if name == "title" && !foreign && !hidden && self.title == Title::NotYet {
            self.title = Title::Reading;
        }
        *self.open_by_name.entry(name.into()).or_insert(0) += 1;
        self.stack.push(Open {
            name: name.into(),
            node,
            hidden,
            foreign,
            children_html,
            nearest,
        });
        if foreign {
            return TokenSinkResult::Continue;
        }
        match name {
            "title" | "textarea" => TokenSinkResult::RawData(RawKind::Rcdata),
            "style" | "xmp" | "iframe" | "noembed" | "noframes" | "noscript" => {
                TokenSinkResult::RawData(RawKind::Rawtext)
            }
            "script" => TokenSinkResult::RawData(RawKind::ScriptData),
            "plaintext" => TokenSinkResult::Plaintext,
            _ => TokenSinkResult::Continue,
        }
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
            "tr" => {
                self.close(Group::Cell);
                self.close(Group::Row);
            }
            "thead" | "tbody" | "tfoot" => {
                self.close(Group::Cell);
                self.close(Group::Row);
                self.close(Group::Section);
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
        if open.name.as_ref() == "title" && self.title == Title::Reading {
            self.title = Title::Read;
        }
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

fn attr<'a>(attrs: &[(&str, &'a str)], key: &str) -> Option<&'a str> {
    attrs.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

fn is_hidden(attrs: &[(&str, &str)]) -> bool {
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
