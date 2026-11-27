// SPDX-License-Identifier: Apache-2.0
//! The PDF value model and lexer of `pdf-objects.ts`: one token at a time, leniently. A
//! malformed token ends the read; nothing here panics.

/// One PDF value, as `PdfValue` models it. `Keyword` only ever appears as a token, never inside
/// an array or dictionary; [`PdfLexer::value`] reads a keyword where a value belongs as null.
#[derive(Debug, Clone, PartialEq)]
pub enum PdfValue {
    Number(f64),
    Boolean(bool),
    Null,
    Name(String),
    String,
    Reference(u32),
    Dict(PdfDict),
    Array(Vec<PdfValue>),
}

impl PdfValue {
    pub fn as_number(&self) -> Option<f64> {
        match self {
            Self::Number(value) => Some(*value),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct PdfDict {
    pub entries: Vec<(String, PdfValue)>,
    /// The stream that follows the dictionary, still encoded.
    pub stream: Option<Vec<u8>>,
}

impl PdfDict {
    pub fn get(&self, key: &str) -> Option<&PdfValue> {
        self.entries
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value)
    }
}

/// A dictionary's stream set after it was read, still encoded.
#[derive(Debug, Clone, PartialEq)]
pub enum Token {
    Value(PdfValue),
    Keyword(String),
}

fn is_space(character: char) -> bool {
    matches!(character, ' ' | '\n' | '\r' | '\t' | '\u{c}' | '\0')
}

/// JavaScript's `\s`, which the header, stream and reference patterns use: the ASCII set plus
/// U+00A0, the only non-ASCII space latin-1 text can hold. `\0` is PDF whitespace, not `\s`.
pub fn is_js_space(character: char) -> bool {
    matches!(
        character,
        ' ' | '\n' | '\r' | '\t' | '\u{c}' | '\u{b}' | '\u{a0}'
    )
}

fn is_delimiter(character: char) -> bool {
    matches!(
        character,
        '(' | ')' | '<' | '>' | '[' | ']' | '{' | '}' | '/' | '%'
    )
}

/// A name's terminator: space or delimiter.
fn ends_name(character: char) -> bool {
    is_space(character) || is_delimiter(character)
}

/// The deepest an array or dictionary may nest. Apple's drawings nest a handful of levels; a
/// file that nests thousands is refused rather than recursed, so it can't exhaust the stack.
pub const MAX_DEPTH: usize = 64;

/// Reads PDF syntax (values and bare keywords) from text, one token at a time.
pub struct PdfLexer<'a> {
    text: &'a [char],
    pub position: usize,
    depth: usize,
    /// Set when a value nested past [`MAX_DEPTH`]: the rest of the text is refused, as the
    /// TypeScript's recursion throws.
    refused: bool,
}

impl<'a> PdfLexer<'a> {
    pub fn new(text: &'a [char], position: usize) -> Self {
        Self {
            text,
            position,
            depth: 0,
            refused: false,
        }
    }

    fn at(&self, index: usize) -> Option<char> {
        self.text.get(index).copied()
    }

    /// Enters an array or dictionary; false (and the rest refused) past [`MAX_DEPTH`].
    fn nest(&mut self) -> bool {
        if self.depth >= MAX_DEPTH {
            self.refused = true;
            self.position = self.text.len();
            return false;
        }
        self.depth += 1;
        true
    }

    fn skip(&mut self) {
        while self.position < self.text.len() {
            let character = self.text[self.position];
            if is_space(character) {
                self.position += 1;
            } else if character == '%' {
                while self.position < self.text.len() && self.text[self.position] != '\n' {
                    self.position += 1;
                }
            } else {
                return;
            }
        }
    }

    /// The next value, or the next bare keyword, or none at the end.
    pub fn next_token(&mut self) -> Option<Token> {
        if self.refused {
            return None;
        }
        self.skip();
        let character = self.at(self.position)?;
        if character == '/' {
            let mut end = self.position + 1;
            while let Some(next) = self.at(end) {
                if ends_name(next) {
                    break;
                }
                end += 1;
            }
            let name: String = self.text[self.position + 1..end].iter().collect();
            self.position = end;
            return Some(Token::Value(PdfValue::Name(name)));
        }
        if character == '(' {
            let mut depth = 0i32;
            while self.position < self.text.len() {
                let current = self.text[self.position];
                self.position += 1;
                if current == '\\' {
                    self.position += 1;
                } else if current == '(' {
                    depth += 1;
                } else if current == ')' {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
            }
            return Some(Token::Value(PdfValue::String));
        }
        if character == '<' && self.at(self.position + 1) == Some('<') {
            self.position += 2;
            if !self.nest() {
                return None;
            }
            let mut entries = Vec::new();
            loop {
                self.skip();
                if self.position >= self.text.len() {
                    break;
                }
                if self.text[self.position] == '>' && self.at(self.position + 1) == Some('>') {
                    self.position += 2;
                    break;
                }
                let key = self.value();
                let value = self.value();
                match key {
                    Some(PdfValue::Name(name)) => {
                        let value = value.unwrap_or(PdfValue::Null);
                        match entries.iter_mut().find(|(existing, _)| *existing == name) {
                            Some((_, existing)) => *existing = value,
                            None => entries.push((name, value)),
                        }
                    }
                    Some(_) => {}
                    None => break,
                }
            }
            self.depth -= 1;
            if self.refused {
                return None;
            }
            return Some(Token::Value(PdfValue::Dict(PdfDict {
                entries,
                stream: None,
            })));
        }
        if character == '<' {
            match self.text[self.position..].iter().position(|c| *c == '>') {
                Some(offset) => self.position += offset + 1,
                None => self.position = self.text.len(),
            }
            return Some(Token::Value(PdfValue::String));
        }
        if character == '[' {
            self.position += 1;
            if !self.nest() {
                return None;
            }
            let mut items = Vec::new();
            loop {
                self.skip();
                if self.position >= self.text.len() {
                    break;
                }
                if self.text[self.position] == ']' {
                    self.position += 1;
                    break;
                }
                match self.value() {
                    Some(item) => items.push(item),
                    None => break,
                }
            }
            self.depth -= 1;
            if self.refused {
                return None;
            }
            return Some(Token::Value(PdfValue::Array(items)));
        }
        if matches!(character, ']' | '>' | ')' | '{' | '}') {
            self.position += 1;
            return Some(Token::Keyword(character.to_string()));
        }
        let mut end = self.position;
        while let Some(next) = self.at(end) {
            if ends_name(next) {
                break;
            }
            end += 1;
        }
        let word: String = self.text[self.position..end].iter().collect();
        self.position = end;
        if is_pdf_number(&word) {
            let number = word.parse::<f64>().unwrap_or(0.0);
            // "12 0 R" is a reference; look ahead without consuming anything else.
            let save = self.position;
            if let Some(length) = reference_length(self.text, save)
                && number.fract() == 0.0
                && number >= 0.0
                && number <= u32::MAX as f64
            {
                self.position = save + length;
                return Some(Token::Value(PdfValue::Reference(number as u32)));
            }
            return Some(Token::Value(PdfValue::Number(number)));
        }
        match word.as_str() {
            "true" => Some(Token::Value(PdfValue::Boolean(true))),
            "false" => Some(Token::Value(PdfValue::Boolean(false))),
            "null" => Some(Token::Value(PdfValue::Null)),
            _ => Some(Token::Keyword(word)),
        }
    }

    /// The next value; a keyword where a value belongs reads as null.
    pub fn value(&mut self) -> Option<PdfValue> {
        match self.next_token()? {
            Token::Value(value) => Some(value),
            Token::Keyword(_) => Some(PdfValue::Null),
        }
    }
}

fn is_pdf_number(word: &str) -> bool {
    let rest = word
        .strip_prefix('+')
        .or_else(|| word.strip_prefix('-'))
        .unwrap_or(word);
    let (whole, fraction) = match rest.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (rest, None),
    };
    let digits = |part: &str| part.bytes().all(|byte| byte.is_ascii_digit());
    if !digits(whole) {
        return false;
    }
    let fraction_ok = match fraction {
        Some(fraction) => digits(fraction),
        None => true,
    };
    if !fraction_ok {
        return false;
    }
    !whole.is_empty() || fraction.is_some_and(|fraction| !fraction.is_empty())
}

/// `^\s+(\d+)\s+R(?![^\s/[\]<>()%])` at `start`, returning the match's length. The look-ahead
/// accepts the end of the text, a space or one of `/ [ ] < > ( ) %`.
fn reference_length(text: &[char], start: usize) -> Option<usize> {
    let mut index = start;
    let mut spaces = 0;
    while index < text.len() && index - start < 24 && is_js_space(text[index]) {
        index += 1;
        spaces += 1;
    }
    if spaces == 0 {
        return None;
    }
    let generation_start = index;
    while index < text.len() && index - start < 24 && text[index].is_ascii_digit() {
        index += 1;
    }
    if index == generation_start || index - start >= 24 {
        return None;
    }
    while index < text.len() && index - start < 24 && is_js_space(text[index]) {
        index += 1;
    }
    if index - start >= 24 || text.get(index) != Some(&'R') {
        return None;
    }
    index += 1;
    let allowed = match text.get(index) {
        None => true,
        Some(next) => {
            is_js_space(*next) || matches!(next, '/' | '[' | ']' | '<' | '>' | '(' | ')' | '%')
        }
    };
    if !allowed {
        return None;
    }
    Some(index - start)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lex(text: &str) -> Vec<char> {
        text.chars().collect()
    }

    #[test]
    fn javascripts_whitespace_is_not_pdfs_nul() {
        assert!(is_js_space('\u{b}'));
        assert!(is_js_space('\u{a0}'));
        assert!(!is_js_space('\0'));
        // PDF syntax does treat a NUL as a separator, as `isSpace` does.
        assert!(is_space('\0'));
    }

    #[test]
    fn a_thousand_nested_arrays_are_refused_rather_than_recursed() {
        let text = lex(&"[".repeat(100_000));
        let mut lexer = PdfLexer::new(&text, 0);
        assert_eq!(lexer.value(), None);
        // The refusal is final: the rest of the text is never lexed again.
        assert_eq!(lexer.next_token(), None);
    }

    #[test]
    fn a_dictionary_nested_past_the_limit_is_refused_too() {
        let text = lex(&"<< /a ".repeat(100_000));
        let mut lexer = PdfLexer::new(&text, 0);
        assert_eq!(lexer.value(), None);
    }

    #[test]
    fn nesting_within_the_limit_reads_as_a_value() {
        let text = lex("[[1 2] [3 4]]");
        let mut lexer = PdfLexer::new(&text, 0);
        assert_eq!(
            lexer.value(),
            Some(PdfValue::Array(vec![
                PdfValue::Array(vec![PdfValue::Number(1.0), PdfValue::Number(2.0)]),
                PdfValue::Array(vec![PdfValue::Number(3.0), PdfValue::Number(4.0)]),
            ]))
        );
    }
}
