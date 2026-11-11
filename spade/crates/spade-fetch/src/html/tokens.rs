//! A small HTML tokenizer: start tags with attributes, end tags and text, with comments, doctypes
//! and processing instructions skipped and character references decoded. It looks at each byte a
//! fixed number of times, keeps no state beyond its position, and never logs.

use std::borrow::Cow;

pub struct Start {
    /// Lowercased.
    pub name: String,
    /// Names lowercased, values decoded.
    pub attrs: Vec<(String, String)>,
    pub self_closing: bool,
}

pub enum Token<'a> {
    Start(Start),
    /// Lowercased.
    End(String),
    Text(Cow<'a, str>),
}

/// Whether the tokenizer should keep going.
#[derive(PartialEq, Eq)]
pub enum Flow {
    Go,
    Stop,
}

/// How the text inside an element is read.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Content {
    /// Ends at the matching end tag; no character references.
    Raw,
    /// Ends at the matching end tag; character references decoded.
    Escapable,
    /// Runs to the end of the document.
    Plaintext,
}

fn content(name: &str) -> Option<Content> {
    match name {
        "script" | "style" | "xmp" | "iframe" | "noembed" | "noframes" | "noscript" => {
            Some(Content::Raw)
        }
        "textarea" | "title" => Some(Content::Escapable),
        "plaintext" => Some(Content::Plaintext),
        _ => None,
    }
}

/// Feeds the tokens of `source` to `sink` in order until it says stop.
pub fn tokenize<'a>(source: &'a str, sink: &mut dyn FnMut(Token<'a>) -> Flow) {
    let mut lexer = Lexer { source, at: 0 };
    let _ = lexer.run(sink);
}

struct Lexer<'a> {
    source: &'a str,
    at: usize,
}

impl<'a> Lexer<'a> {
    fn bytes(&self) -> &'a [u8] {
        self.source.as_bytes()
    }

    fn byte(&self, at: usize) -> Option<u8> {
        self.bytes().get(at).copied()
    }

    /// The next index of `needle` at or after `from`.
    fn find(&self, from: usize, needle: &str) -> Option<usize> {
        self.source.get(from..)?.find(needle).map(|i| i + from)
    }

    fn run(&mut self, sink: &mut dyn FnMut(Token<'a>) -> Flow) -> Option<()> {
        let len = self.source.len();
        let mut text_from = 0;
        while let Some(lt) = self.find(self.at, "<") {
            let next = self.byte(lt + 1);
            let after = self.byte(lt + 2);
            let markup = if self.source[lt..].starts_with("<!--") {
                let end = self.find(lt + 4, "-->").map_or(len, |e| e + 3);
                Some((end, None))
            } else if matches!(next, Some(b'!' | b'?'))
                || (next == Some(b'/') && !after.is_some_and(|b| b.is_ascii_alphabetic()))
            {
                let end = self.find(lt + 1, ">").map_or(len, |e| e + 1);
                Some((end, None))
            } else if next == Some(b'/') {
                let (name, end) = self.end_tag(lt + 2);
                Some((end, Some(Token::End(name))))
            } else if next.is_some_and(|b| b.is_ascii_alphabetic()) {
                // A start tag cut off by the end of the document is dropped, as browsers do.
                let (start, end) = self.start_tag(lt + 1).unwrap_or_else(|| {
                    let empty = Start {
                        name: String::new(),
                        attrs: Vec::new(),
                        self_closing: false,
                    };
                    (empty, len)
                });
                Some((end, (!start.name.is_empty()).then_some(Token::Start(start))))
            } else {
                None
            };
            let Some((end, token)) = markup else {
                self.at = lt + 1;
                continue;
            };
            emit_text(&self.source[text_from..lt], sink)?;
            self.at = end;
            text_from = end;
            let Some(token) = token else { continue };
            let raw = match &token {
                Token::Start(start) if !start.self_closing => {
                    content(&start.name).map(|c| (c, start.name.clone()))
                }
                _ => None,
            };
            go(sink(token))?;
            if let Some((kind, name)) = raw {
                let close = match kind {
                    Content::Plaintext => len,
                    _ => self.close_of(end, &name).unwrap_or(len),
                };
                let inner = &self.source[end..close];
                let text = if kind == Content::Escapable {
                    htmlize::unescape(inner)
                } else {
                    Cow::Borrowed(inner)
                };
                if !text.is_empty() {
                    go(sink(Token::Text(text)))?;
                }
                if close < len {
                    let (closing, after_close) = self.end_tag(close + 2);
                    go(sink(Token::End(closing)))?;
                    self.at = after_close;
                } else {
                    self.at = len;
                }
                text_from = self.at;
            }
        }
        emit_text(&self.source[text_from..], sink)
    }

    /// An end tag's lowercased name, and where the tag ends. `from` is just past `</`.
    fn end_tag(&self, from: usize) -> (String, usize) {
        let name_end = self.name_end(from);
        let name = self.source[from..name_end].to_ascii_lowercase();
        let end = self
            .find(name_end, ">")
            .map_or(self.source.len(), |e| e + 1);
        (name, end)
    }

    fn name_end(&self, from: usize) -> usize {
        self.bytes()[from..]
            .iter()
            .position(|b| b.is_ascii_whitespace() || matches!(b, b'/' | b'>'))
            .map_or(self.source.len(), |i| i + from)
    }

    /// A start tag and where it ends, or `None` when the document ends inside it. `from` is
    /// just past `<`.
    fn start_tag(&self, from: usize) -> Option<(Start, usize)> {
        let bytes = self.bytes();
        let name_end = self.name_end(from);
        let name = self.source[from..name_end].to_ascii_lowercase();
        let mut attrs = Vec::new();
        let mut at = name_end;
        loop {
            while bytes.get(at).is_some_and(u8::is_ascii_whitespace) {
                at += 1;
            }
            match *bytes.get(at)? {
                b'>' => {
                    return Some((
                        Start {
                            name,
                            attrs,
                            self_closing: false,
                        },
                        at + 1,
                    ));
                }
                b'/' if bytes.get(at + 1) == Some(&b'>') => {
                    return Some((
                        Start {
                            name,
                            attrs,
                            self_closing: true,
                        },
                        at + 2,
                    ));
                }
                b'/' => at += 1,
                _ => {
                    let name_start = at;
                    at += 1; // an attribute name may start with `=`
                    while bytes.get(at).is_some_and(|b| {
                        !b.is_ascii_whitespace() && !matches!(b, b'/' | b'>' | b'=')
                    }) {
                        at += 1;
                    }
                    let attr = self.source[name_start..at].to_ascii_lowercase();
                    while bytes.get(at).is_some_and(u8::is_ascii_whitespace) {
                        at += 1;
                    }
                    let mut value = Cow::Borrowed("");
                    if bytes.get(at) == Some(&b'=') {
                        at += 1;
                        while bytes.get(at).is_some_and(u8::is_ascii_whitespace) {
                            at += 1;
                        }
                        let (raw, next) = match *bytes.get(at)? {
                            quote @ (b'"' | b'\'') => {
                                let close = bytes[at + 1..].iter().position(|b| *b == quote)?;
                                (&self.source[at + 1..at + 1 + close], at + close + 2)
                            }
                            _ => {
                                let len = bytes[at..]
                                    .iter()
                                    .position(|b| b.is_ascii_whitespace() || *b == b'>')
                                    .unwrap_or(bytes.len() - at);
                                (&self.source[at..at + len], at + len)
                            }
                        };
                        value = htmlize::unescape_attribute(raw);
                        at = next;
                    }
                    attrs.push((attr, value.into_owned()));
                }
            }
        }
    }

    /// Where the `</name` that ends a raw text element starts.
    fn close_of(&self, from: usize, name: &str) -> Option<usize> {
        let bytes = self.bytes();
        let mut at = from;
        while let Some(lt) = self.find(at, "</") {
            let tail = lt + 2 + name.len();
            let matches = bytes
                .get(lt + 2..tail)
                .is_some_and(|t| t.eq_ignore_ascii_case(name.as_bytes()));
            let ends = bytes
                .get(tail)
                .is_none_or(|b| b.is_ascii_whitespace() || matches!(b, b'/' | b'>'));
            if matches && ends {
                return Some(lt);
            }
            at = lt + 2;
        }
        None
    }
}

fn emit_text<'a>(text: &'a str, sink: &mut dyn FnMut(Token<'a>) -> Flow) -> Option<()> {
    if text.is_empty() {
        return Some(());
    }
    go(sink(Token::Text(htmlize::unescape(text))))
}

fn go(flow: Flow) -> Option<()> {
    (flow == Flow::Go).then_some(())
}
