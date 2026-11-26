//! Splits a bot's text into words and the markup tags of ADR 0212 §2, leaving code literal.

use super::Kind;

/// A piece of the text: words (a byte range), or a recognised tag.
#[derive(Debug)]
pub(super) enum Piece {
    Words(usize, usize),
    Open {
        kind: Kind,
        reply: Option<String>,
        title: Option<String>,
    },
    Close(Kind),
    /// A whole `<react to="…">emoji</react>`: the id when it reads as one, and the inner text.
    React {
        to: Option<String>,
        emoji: String,
    },
}

/// The tag a reaction opens with and the one it closes with, on the same line.
const REACT: &str = "<react";
const REACT_CLOSE: &str = "</react>";

/// What sits at a `<`.
enum At {
    Tag(Piece, usize),
    /// A tag that may still be arriving: the text ends inside it.
    Cut,
    Words,
}

/// The pieces of `text`, in order. With `live`, a tag cut short at the end is held back.
pub(super) fn pieces(text: &str, live: bool) -> Vec<Piece> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let (mut i, mut from, mut end) = (0, 0, b.len());
    // Only spaces, tabs and tags so far on this line: a fence may open here.
    let mut line_start = true;
    while i < b.len() {
        if line_start && let Some(after) = fence(b, i) {
            i = after;
            line_start = false;
            continue;
        }
        match b[i] {
            b'\n' => {
                line_start = true;
                i += 1;
            }
            b' ' | b'\t' => i += 1,
            b'`' => {
                i = code_span(b, i);
                line_start = false;
            }
            b'<' => match tag_at(text, i) {
                At::Tag(piece, len) => {
                    out.push(Piece::Words(from, i));
                    out.push(piece);
                    i += len;
                    from = i;
                }
                At::Cut if live => {
                    end = i;
                    break;
                }
                At::Cut | At::Words => {
                    i += 1;
                    line_start = false;
                }
            },
            _ => {
                i += 1;
                line_start = false;
            }
        }
    }
    out.push(Piece::Words(from, end));
    out
}

/// A fenced block opening at `i` (after any spaces or tabs): where it ends, after its closing
/// fence's run, or at the end of the text when it never closes.
fn fence(b: &[u8], i: usize) -> Option<usize> {
    let at = skip_blank(b, i);
    let mark = *b.get(at)?;
    if mark != b'`' && mark != b'~' {
        return None;
    }
    let long = run(b, at, mark);
    if long < 3 {
        return None;
    }
    let mut line = next_line(b, at)?;
    loop {
        let start = skip_blank(b, line);
        let closing = run(b, start, mark);
        if closing >= long {
            return Some(start + closing);
        }
        match next_line(b, start) {
            Some(next) => line = next,
            None => return Some(b.len()),
        }
    }
}

/// An inline code span starting at the backtick run at `i`: past its partner, a run of exactly as
/// many backticks later on the same line, or just past the run when it has none.
fn code_span(b: &[u8], i: usize) -> usize {
    let long = run(b, i, b'`');
    let mut j = i + long;
    while j < b.len() && b[j] != b'\n' {
        if b[j] == b'`' {
            let other = run(b, j, b'`');
            if other == long {
                return j + other;
            }
            j += other;
        } else {
            j += 1;
        }
    }
    i + long
}

fn run(b: &[u8], i: usize, mark: u8) -> usize {
    b[i.min(b.len())..]
        .iter()
        .take_while(|&&c| c == mark)
        .count()
}

fn skip_blank(b: &[u8], mut i: usize) -> usize {
    while i < b.len() && matches!(b[i], b' ' | b'\t') {
        i += 1;
    }
    i
}

/// The start of the line after the one holding `i`, if there is one.
fn next_line(b: &[u8], i: usize) -> Option<usize> {
    b[i..].iter().position(|&c| c == b'\n').map(|at| i + at + 1)
}

fn tag_at(text: &str, i: usize) -> At {
    let rest = &text[i..];
    if rest.starts_with(REACT) {
        return reaction(text, i);
    }
    if REACT.starts_with(rest) {
        return At::Cut;
    }
    for (close, kind) in [("</msg>", Kind::Msg), ("</doc>", Kind::Doc)] {
        if rest.starts_with(close) {
            return At::Tag(Piece::Close(kind), close.len());
        }
        if close.starts_with(rest) {
            return At::Cut;
        }
    }
    for (open, kind) in [("<msg", Kind::Msg), ("<doc", Kind::Doc)] {
        if open.starts_with(rest) {
            return At::Cut;
        }
        if !rest.starts_with(open) {
            continue;
        }
        let b = text.as_bytes();
        return match b.get(i + open.len()) {
            Some(b'>') => At::Tag(
                Piece::Open {
                    kind,
                    reply: None,
                    title: None,
                },
                open.len() + 1,
            ),
            Some(b' ' | b'\t') => match attributes(text, i + open.len()) {
                Read::Done(attrs, after) => At::Tag(open_piece(kind, attrs), after - i),
                Read::Cut => At::Cut,
                Read::Words => At::Words,
            },
            None => At::Cut,
            Some(_) => At::Words,
        };
    }
    At::Words
}

/// A reaction at `i`: its attributes, then its emoji up to `</react>` on the same line. One whose
/// line ends first is words; one the text ends inside may still be arriving.
fn reaction(text: &str, i: usize) -> At {
    let b = text.as_bytes();
    let after = match b.get(i + REACT.len()) {
        Some(b'>') => Read::Done(Vec::new(), i + REACT.len() + 1),
        Some(b' ' | b'\t') => attributes(text, i + REACT.len()),
        None => Read::Cut,
        Some(_) => Read::Words,
    };
    let (attrs, inner) = match after {
        Read::Done(attrs, inner) => (attrs, inner),
        Read::Cut => return At::Cut,
        Read::Words => return At::Words,
    };
    let line = &text[inner..];
    let line = &line[..line.find('\n').unwrap_or(line.len())];
    let Some(close) = line.find(REACT_CLOSE) else {
        // A closing tag cut short, or none yet, at the very end: still arriving.
        return if inner + line.len() == text.len() {
            At::Cut
        } else {
            At::Words
        };
    };
    let to = attrs
        .iter()
        .find(|(name, _)| *name == "to")
        .map(|(_, v)| *v)
        .filter(|v| super::is_id(v))
        .map(str::to_owned);
    let piece = Piece::React {
        to,
        emoji: line[..close].to_owned(),
    };
    At::Tag(piece, inner + close + REACT_CLOSE.len() - i)
}

fn open_piece(kind: Kind, attrs: Vec<(&str, &str)>) -> Piece {
    let value = |name: &str| attrs.iter().find(|(n, _)| *n == name).map(|(_, v)| *v);
    let reply = value("reply")
        .filter(|v| super::is_id(v))
        .map(str::to_owned);
    let title = value("title")
        .map(|t| {
            t.trim()
                .chars()
                .take(super::TITLE_CHARS)
                .collect::<String>()
        })
        .filter(|t| !t.is_empty());
    Piece::Open { kind, reply, title }
}

enum Read<'a> {
    /// The attributes, and the index just past the tag's `>`.
    Done(Vec<(&'a str, &'a str)>, usize),
    Cut,
    Words,
}

/// An open tag's attributes from `i` up to its `>`, which must come on the same line, outside
/// quotes. Anything that is not `name=value` (or a bare name) is skipped.
fn attributes(text: &str, mut i: usize) -> Read<'_> {
    let b = text.as_bytes();
    let mut attrs = Vec::new();
    loop {
        i = skip_blank(b, i);
        match b.get(i) {
            None => return Read::Cut,
            Some(b'\n') => return Read::Words,
            Some(b'>') => return Read::Done(attrs, i + 1),
            Some(c) if is_name(*c) => {
                let start = i;
                while i < b.len() && is_name(b[i]) {
                    i += 1;
                }
                let name = &text[start..i];
                i = skip_blank(b, i);
                if b.get(i) != Some(&b'=') {
                    continue;
                }
                i = skip_blank(b, i + 1);
                match b.get(i) {
                    None => return Read::Cut,
                    Some(&quote @ (b'"' | b'\'')) => {
                        let inner = i + 1;
                        let Some(len) = b[inner..].iter().position(|&c| c == quote || c == b'\n')
                        else {
                            return Read::Cut;
                        };
                        if b[inner + len] == b'\n' {
                            return Read::Words;
                        }
                        attrs.push((name, &text[inner..inner + len]));
                        i = inner + len + 1;
                    }
                    Some(_) => {
                        let start = i;
                        while i < b.len() && !matches!(b[i], b' ' | b'\t' | b'\n' | b'>') {
                            i += 1;
                        }
                        attrs.push((name, &text[start..i]));
                    }
                }
            }
            Some(_) => i += 1,
        }
    }
}

fn is_name(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'-' || c == b'_'
}
