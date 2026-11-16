//! Text as the model reads it: look-alike letters folded to the ASCII letter they imitate,
//! invisible characters dropped and odd spaces made plain, so `сurl` (a Cyrillic `с`) and
//! `cu\u{200b}rl` land on the same features as `curl`. What was folded is kept as a fact of its
//! own: hiding a word is itself a signal.

/// What folding found.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct Folded {
    /// The text with look-alikes folded, case kept (a command's flags are case-sensitive).
    pub text: String,
    /// A letter from another script that imitates an ASCII one, or a full-width form.
    pub lookalike: bool,
    /// A zero-width character or soft hyphen.
    pub invisible: bool,
    /// A space that isn't the ASCII space or tab.
    pub odd_space: bool,
    /// Other non-ASCII text.
    pub non_ascii: bool,
    /// The text was cut at `limit` characters.
    pub cut: bool,
}

/// Letters of other scripts that look like an ASCII letter, and that letter.
const LOOKALIKES: &[(char, char)] = &[
    // Cyrillic.
    ('а', 'a'),
    ('в', 'b'),
    ('е', 'e'),
    ('ё', 'e'),
    ('к', 'k'),
    ('м', 'm'),
    ('н', 'h'),
    ('о', 'o'),
    ('р', 'p'),
    ('с', 'c'),
    ('т', 't'),
    ('у', 'y'),
    ('х', 'x'),
    ('і', 'i'),
    ('ї', 'i'),
    ('ј', 'j'),
    ('ѕ', 's'),
    ('ԁ', 'd'),
    ('ӏ', 'l'),
    ('ԛ', 'q'),
    ('ԝ', 'w'),
    ('А', 'A'),
    ('В', 'B'),
    ('Е', 'E'),
    ('К', 'K'),
    ('М', 'M'),
    ('Н', 'H'),
    ('О', 'O'),
    ('Р', 'P'),
    ('С', 'C'),
    ('Т', 'T'),
    ('Х', 'X'),
    ('І', 'I'),
    ('Ѕ', 'S'),
    // Greek.
    ('α', 'a'),
    ('ε', 'e'),
    ('ι', 'i'),
    ('κ', 'k'),
    ('ν', 'v'),
    ('ο', 'o'),
    ('ρ', 'p'),
    ('τ', 't'),
    ('υ', 'u'),
    ('χ', 'x'),
    ('Α', 'A'),
    ('Β', 'B'),
    ('Ε', 'E'),
    ('Η', 'H'),
    ('Ι', 'I'),
    ('Κ', 'K'),
    ('Μ', 'M'),
    ('Ν', 'N'),
    ('Ο', 'O'),
    ('Ρ', 'P'),
    ('Τ', 'T'),
    ('Χ', 'X'),
    ('Υ', 'Y'),
    ('Ζ', 'Z'),
    // Latin letters that pass for plain ones.
    ('ı', 'i'),
    ('ȷ', 'j'),
    ('ɑ', 'a'),
    ('ɡ', 'g'),
    ('ℓ', 'l'),
];

fn invisible(c: char) -> bool {
    matches!(c, '\u{200B}'..='\u{200F}' | '\u{2060}'..='\u{2064}' | '\u{FEFF}' | '\u{00AD}' | '\u{180E}')
}

fn odd_space(c: char) -> bool {
    matches!(
        c,
        '\u{00A0}' | '\u{2000}'..='\u{200A}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{1680}'
    )
}

/// Folds at most `limit` characters of `text`.
pub(crate) fn fold(text: &str, limit: usize) -> Folded {
    let mut folded = Folded {
        text: String::with_capacity(text.len().min(limit)),
        ..Folded::default()
    };
    for (taken, c) in text.chars().enumerate() {
        if taken >= limit {
            folded.cut = true;
            break;
        }
        if c.is_ascii() {
            folded.text.push(c);
        } else if invisible(c) {
            folded.invisible = true;
        } else if odd_space(c) {
            folded.odd_space = true;
            folded.text.push(' ');
        } else if ('\u{FF01}'..='\u{FF5E}').contains(&c) {
            // Full-width ASCII.
            folded.lookalike = true;
            folded
                .text
                .push(char::from_u32(c as u32 - 0xFEE0).unwrap_or(c));
        } else if let Some((_, plain)) = LOOKALIKES.iter().find(|(odd, _)| *odd == c) {
            folded.lookalike = true;
            folded.text.push(*plain);
        } else {
            folded.non_ascii = true;
            folded.text.push(c);
        }
    }
    folded
}

/// The lower-case alphanumeric runs of `text` of 2 to 24 characters, at most `most` of them.
pub(crate) fn tokens(text: &str, most: usize, mut each: impl FnMut(&str)) {
    let mut seen = 0;
    for run in text.split(|c: char| !c.is_alphanumeric()) {
        if seen >= most {
            return;
        }
        let length = run.chars().count();
        if (2..=24).contains(&length) {
            seen += 1;
            if run.chars().any(char::is_uppercase) {
                each(&run.to_lowercase());
            } else {
                each(run);
            }
        }
    }
}

/// The words of a name: split at `_ - . / : space` and at a lower-to-upper case change
/// (`sendMail` is `send mail`), lower-cased.
pub(crate) fn name_words(name: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut previous_lower = false;
    for c in name.chars() {
        if !c.is_alphanumeric() {
            if !word.is_empty() {
                words.push(std::mem::take(&mut word));
            }
            previous_lower = false;
            continue;
        }
        if c.is_uppercase() && previous_lower && !word.is_empty() {
            words.push(std::mem::take(&mut word));
        }
        previous_lower = c.is_lowercase() || c.is_ascii_digit();
        word.extend(c.to_lowercase());
    }
    if !word.is_empty() {
        words.push(word);
    }
    words
}

/// `text` lower-cased with runs of whitespace made one space, at most `limit` bytes, for
/// character n-grams: spacing tricks land on the same grams.
pub(crate) fn squeezed(text: &str, limit: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len().min(limit));
    let mut space = false;
    for b in text.bytes() {
        if out.len() >= limit {
            break;
        }
        if b.is_ascii_whitespace() {
            if !space && !out.is_empty() {
                out.push(b' ');
            }
            space = true;
        } else {
            space = false;
            out.push(b.to_ascii_lowercase());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn look_alike_letters_and_invisible_characters_fold_to_the_plain_word() {
        for odd in ["сurl", "cu\u{200b}rl", "ｃｕｒｌ", "curl"] {
            assert_eq!(fold(odd, 100).text, "curl", "{odd}");
        }
        let folded = fold("ѕеnd\u{00a0}now", 100);
        assert_eq!(folded.text, "send now");
        assert!(folded.lookalike && folded.odd_space && !folded.invisible);
    }

    #[test]
    fn names_split_into_words_at_separators_and_case_changes() {
        assert_eq!(name_words("sendMail"), ["send", "mail"]);
        assert_eq!(
            name_words("mcp__gmail__send_email"),
            ["mcp", "gmail", "send", "email"]
        );
        assert_eq!(name_words("chat.postMessage"), ["chat", "post", "message"]);
        assert_eq!(name_words("HTTPRequest"), ["httprequest"]);
    }
}
