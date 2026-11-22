//! How a bot's text splits into chat messages and documents (ADR 0212 §2): `<msg>` is one bubble,
//! `<msg reply="m7">` quotes message m7, `<doc title="…">` is long content shown as a card.
//! Pure, and run against the table of cases the TypeScript parser shares,
//! `spade/docs/chat-markup.cases.json`.

mod quote;
mod scan;
#[cfg(test)]
mod tests;

pub use quote::{QUOTE_CHARS, quote_of, quoted};
use scan::Piece;

/// The most messages one model step makes; later ones join the last.
pub const MOST_MESSAGES: usize = 12;
/// The most documents one model step makes; later ones join the last under their title.
pub const MOST_DOCUMENTS: usize = 3;
/// How long a document's title may be, in characters.
pub const TITLE_CHARS: usize = 120;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Msg,
    Doc,
}

/// One chat message or document of a bot's text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Segment {
    pub kind: Kind,
    pub text: String,
    /// The id of the message this one quotes.
    pub reply: Option<String>,
    pub title: Option<String>,
    /// Still arriving: the last segment of streaming text whose tag hasn't closed.
    pub open: bool,
}

/// The segments of finished text.
pub fn parse(text: &str) -> Vec<Segment> {
    segments(text, false)
}

/// The segments of text still streaming: a tag cut short at the end is held back, and the last
/// segment, when it has not closed, is `open`.
pub fn parse_live(text: &str) -> Vec<Segment> {
    segments(text, true)
}

/// A message's id: `m<seq>` for the first message of the event with `seq`, `m<seq>.<n>` for its
/// n-th from the second on (ADR 0212 §3).
pub fn id(seq: u64, index: usize) -> String {
    match index {
        0 => format!("m{seq}"),
        _ => format!("m{seq}.{}", index + 1),
    }
}

/// Whether `value` reads as a message id.
pub fn is_id(value: &str) -> bool {
    split_id(value).is_some()
}

/// The seq of the event a message id names.
pub fn seq_of(id: &str) -> Option<u64> {
    split_id(id).map(|(seq, _)| seq)
}

/// A message id's event seq and segment index.
pub(crate) fn split_id(value: &str) -> Option<(u64, usize)> {
    let rest = value.strip_prefix('m')?;
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit());
    let (seq, n) = match rest.split_once('.') {
        Some((seq, n)) if digits(seq) && digits(n) => (seq, Some(n)),
        None if digits(rest) => (rest, None),
        _ => return None,
    };
    let seq: u64 = seq.parse().ok()?;
    let index = match n {
        None => 0,
        Some(n) => n.parse::<usize>().ok().filter(|&n| n >= 2)? - 1,
    };
    (seq >= 1).then_some((seq, index))
}

/// The words of `text` with the markup removed, messages apart by a blank line and a document as
/// its title line then its text: for wherever the words leave the chat as plain text.
pub fn plain(text: &str) -> String {
    parse(text)
        .iter()
        .map(segment_plain)
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub(crate) fn segment_plain(segment: &Segment) -> String {
    match &segment.title {
        Some(title) if segment.kind == Kind::Doc => format!("{title}\n\n{}", segment.text),
        _ => segment.text.clone(),
    }
}

/// The bot's own past words as the model reads them again: each message and document with its
/// id, one per line. Text with no words stays empty.
pub fn for_model(text: &str, seq: u64) -> String {
    parse(text)
        .iter()
        .enumerate()
        .map(|(index, segment)| {
            let id = id(seq, index);
            let reply = segment
                .reply
                .as_ref()
                .map(|r| format!(" reply=\"{r}\""))
                .unwrap_or_default();
            match segment.kind {
                Kind::Msg => format!("<msg id=\"{id}\"{reply}>{}</msg>", segment.text),
                Kind::Doc => {
                    let title = segment
                        .title
                        .as_ref()
                        .map(|t| format!(" title=\"{}\"", t.replace('"', "'")))
                        .unwrap_or_default();
                    format!("<doc id=\"{id}\"{title}>{}</doc>", segment.text)
                }
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn segments(text: &str, live: bool) -> Vec<Segment> {
    let pieces = scan::pieces(text, live);
    match structured(text, &pieces, live) {
        Some(found) => capped(found),
        None => fallback(text, &pieces, live),
    }
}

/// The segments in order, or `None` when tags nest or a closing tag has no partner.
fn structured(text: &str, pieces: &[Piece], live: bool) -> Option<Vec<Segment>> {
    let mut out = Vec::new();
    // The tag open now, and the words inside it so far.
    let mut current: Option<(Kind, Option<String>, Option<String>)> = None;
    let mut words = String::new();
    for piece in pieces {
        match piece {
            Piece::Words(from, to) => words.push_str(&text[*from..*to]),
            Piece::Open { kind, reply, title } => {
                if current.is_some() {
                    return None;
                }
                push(&mut out, Kind::Msg, &words, None, None, false);
                words.clear();
                current = Some((*kind, reply.clone(), title.clone()));
            }
            Piece::Close(kind) => match current.take() {
                Some((open, reply, title)) if open == *kind => {
                    push(&mut out, open, &words, reply, title, false);
                    words.clear();
                }
                _ => return None,
            },
        }
    }
    match current {
        Some((kind, reply, title)) => push(&mut out, kind, &words, reply, title, live),
        None => push(&mut out, Kind::Msg, &words, None, None, live),
    }
    Some(out)
}

fn push(
    out: &mut Vec<Segment>,
    kind: Kind,
    words: &str,
    reply: Option<String>,
    title: Option<String>,
    open: bool,
) {
    let text = words.trim();
    if text.is_empty() {
        return;
    }
    out.push(Segment {
        kind,
        text: text.to_owned(),
        reply,
        title,
        open,
    });
}

/// Plain words: every tag removed and the pieces between them joined by blank lines, as one
/// message.
fn fallback(text: &str, pieces: &[Piece], live: bool) -> Vec<Segment> {
    let joined = pieces
        .iter()
        .filter_map(|piece| match piece {
            Piece::Words(from, to) => Some(text[*from..*to].trim()),
            _ => None,
        })
        .filter(|words| !words.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    let mut out = Vec::new();
    push(&mut out, Kind::Msg, &joined, None, None, live);
    out
}

/// Messages past [`MOST_MESSAGES`] join the last allowed one; documents past [`MOST_DOCUMENTS`]
/// join the last allowed one under their title as a heading.
fn capped(found: Vec<Segment>) -> Vec<Segment> {
    let mut out: Vec<Segment> = Vec::with_capacity(found.len());
    let (mut messages, mut documents) = (0, 0);
    for segment in found {
        let (count, most) = match segment.kind {
            Kind::Msg => (&mut messages, MOST_MESSAGES),
            Kind::Doc => (&mut documents, MOST_DOCUMENTS),
        };
        if *count < most {
            *count += 1;
            out.push(segment);
            continue;
        }
        let Some(last) = out.iter_mut().rev().find(|s| s.kind == segment.kind) else {
            continue;
        };
        last.text.push_str("\n\n");
        if let (Kind::Doc, Some(title)) = (segment.kind, &segment.title) {
            last.text.push_str(&format!("## {title}\n\n"));
        }
        last.text.push_str(&segment.text);
        last.open |= segment.open;
    }
    out
}
