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

/// The most attributes kept on one tag. Past it the page is cut where the next one starts.
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

/// `source` up to where some tag could pass [`MOST_ATTRIBUTES`], and whether it was cut there.
pub fn within_limit(source: &str) -> (&str, bool) {
    let bytes = source.as_bytes();
    let most = u32::try_from(MOST_ATTRIBUTES).unwrap_or(u32::MAX);
    let mut most_in: [Option<u32>; STATES] = [None; STATES];
    for (i, &c) in bytes.iter().enumerate() {
        let starts_tag = c.is_ascii_alphabetic()
            && (i >= 1 && bytes[i - 1] == b'<'
                || i >= 2 && bytes[i - 1] == b'/' && bytes[i - 2] == b'<');
        if starts_tag {
            let slot = &mut most_in[State::TagName as usize];
            *slot = Some(slot.unwrap_or(0));
        }
        let mut next: [Option<u32>; STATES] = [None; STATES];
        for state in ALL {
            let Some(count) = most_in[state as usize] else {
                continue;
            };
            let Some((to, added)) = step(state, c) else {
                continue;
            };
            let count = count + u32::from(added);
            if count > most {
                return (cut(source, i), true);
            }
            let slot = &mut next[to as usize];
            *slot = Some(slot.map_or(count, |c| c.max(count)));
        }
        most_in = next;
    }
    (source, false)
}

fn cut(source: &str, at: usize) -> &str {
    let mut end = at;
    while !source.is_char_boundary(end) {
        end -= 1;
    }
    &source[..end]
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
