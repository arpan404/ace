//! A bound on attributes per tag, enforced before the tokenizer sees the page. html5ever checks
//! each new attribute against every earlier one in its tag, so one tag with a huge number of
//! them costs time growing with the square of that number.
//!
//! Which `<` starts a real tag depends on state the tokenizer keeps (comments, scripts, quoted
//! values), and a scanner that guessed that state could be led astray by a quote in a comment.
//! So this one follows every possible tag at once: each `<` or `</` before a letter starts one.
//! Lexing a tag from its start depends on nothing but the bytes, and two candidates in the same
//! state at the same byte go on identically, so it keeps, for each lexer state, the most
//! attributes any candidate in that state has. That bounds every tag the tokenizer can build,
//! in time linear in the page.
//!
//! When a candidate would pass the limit, a `>` is written just before the attribute that would
//! pass it. A candidate gains an attribute only outside quotes, so that `>` ends it: a real tag
//! ends there and the rest of its attributes read as text, while in a script or a comment, where
//! the "tag" was only a string, one more `>` changes nothing anyone reads. The page is never cut.

use std::borrow::Cow;

/// The most attributes kept on one tag. A tag with more is ended before the next one.
pub const MOST_ATTRIBUTES: usize = 128;

#[derive(Clone, Copy)]
enum State {
    TagName,
    BeforeName,
    Name,
    AfterName,
    BeforeValue,
    Double,
    Single,
    Unquoted,
    AfterQuoted,
    SelfClosing,
}

const STATES: usize = 10;

const ALL: [State; STATES] = [
    State::TagName,
    State::BeforeName,
    State::Name,
    State::AfterName,
    State::BeforeValue,
    State::Double,
    State::Single,
    State::Unquoted,
    State::AfterQuoted,
    State::SelfClosing,
];

type Counts = [Option<u32>; STATES];

/// `source` with a `>` before any attribute that would take a tag past [`MOST_ATTRIBUTES`].
pub fn within_limit(source: &str) -> Cow<'_, str> {
    let bytes = source.as_bytes();
    let most = u32::try_from(MOST_ATTRIBUTES).unwrap_or(u32::MAX);
    let mut out: Option<String> = None;
    let mut copied_to = 0;
    let mut most_in: Counts = [None; STATES];
    for (i, &c) in bytes.iter().enumerate() {
        let starts_tag = c.is_ascii_alphabetic()
            && (i >= 1 && bytes[i - 1] == b'<'
                || i >= 2 && bytes[i - 1] == b'/' && bytes[i - 2] == b'<');
        if starts_tag {
            let slot = &mut most_in[State::TagName as usize];
            *slot = Some(slot.unwrap_or(0));
        }
        let next = match advance(&most_in, c, most) {
            Some(next) => next,
            None => {
                // Byte `i` starts an attribute outside quotes, so it is a character boundary.
                let text = out.get_or_insert_with(|| String::with_capacity(source.len() + 16));
                text.push_str(&source[copied_to..i]);
                text.push('>');
                copied_to = i;
                // The `>` ends every candidate outside quotes; those inside quotes go on, and
                // this byte cannot add an attribute to them.
                let after = advance(&most_in, b'>', most).unwrap_or([None; STATES]);
                advance(&after, c, most).unwrap_or([None; STATES])
            }
        };
        most_in = next;
    }
    match out {
        Some(mut text) => {
            text.push_str(&source[copied_to..]);
            Cow::Owned(text)
        }
        None => Cow::Borrowed(source),
    }
}

/// Every candidate's state after byte `c`, or `None` when one would pass `most` attributes.
fn advance(counts: &Counts, c: u8, most: u32) -> Option<Counts> {
    let mut next: Counts = [None; STATES];
    for state in ALL {
        let Some(count) = counts[state as usize] else {
            continue;
        };
        let Some((to, added)) = step(state, c) else {
            continue;
        };
        let count = count + u32::from(added);
        if count > most {
            return None;
        }
        let slot = &mut next[to as usize];
        *slot = Some(slot.map_or(count, |c| c.max(count)));
    }
    Some(next)
}

/// The tag lexer's next state on byte `c`, and whether `c` starts an attribute; `None` when the
/// tag ends.
fn step(state: State, c: u8) -> Option<(State, bool)> {
    let space = matches!(c, b'\t' | b'\n' | b'\x0c' | b'\r' | b' ');
    Some(match state {
        State::TagName => match c {
            _ if space => (State::BeforeName, false),
            b'/' => (State::SelfClosing, false),
            b'>' => return None,
            _ => (State::TagName, false),
        },
        State::BeforeName | State::SelfClosing => match c {
            _ if space => (State::BeforeName, false),
            b'/' => (State::SelfClosing, false),
            b'>' => return None,
            _ => (State::Name, true),
        },
        State::Name => match c {
            _ if space => (State::AfterName, false),
            b'/' => (State::SelfClosing, false),
            b'=' => (State::BeforeValue, false),
            b'>' => return None,
            _ => (State::Name, false),
        },
        State::AfterName => match c {
            _ if space => (State::AfterName, false),
            b'/' => (State::SelfClosing, false),
            b'=' => (State::BeforeValue, false),
            b'>' => return None,
            _ => (State::Name, true),
        },
        State::BeforeValue => match c {
            _ if space => (State::BeforeValue, false),
            b'"' => (State::Double, false),
            b'\'' => (State::Single, false),
            b'>' => return None,
            _ => (State::Unquoted, false),
        },
        State::Double => match c {
            b'"' => (State::AfterQuoted, false),
            _ => (State::Double, false),
        },
        State::Single => match c {
            b'\'' => (State::AfterQuoted, false),
            _ => (State::Single, false),
        },
        State::Unquoted => match c {
            _ if space => (State::BeforeName, false),
            b'>' => return None,
            _ => (State::Unquoted, false),
        },
        State::AfterQuoted => match c {
            _ if space => (State::BeforeName, false),
            b'/' => (State::SelfClosing, false),
            b'>' => return None,
            _ => (State::Name, true),
        },
    })
}
