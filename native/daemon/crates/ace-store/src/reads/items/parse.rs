// SPDX-License-Identifier: Apache-2.0
use super::json::J;
use super::{ReadError, Result};

pub(crate) struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

pub(crate) fn parse_error() -> ReadError {
    ReadError::Row("Invalid stored item")
}

impl<'a> Parser<'a> {
    fn new(text: &'a str) -> Parser<'a> {
        Parser {
            bytes: text.as_bytes(),
            pos: 0,
        }
    }

    fn peek(&self) -> Result<u8> {
        self.bytes.get(self.pos).copied().ok_or_else(parse_error)
    }

    fn next(&mut self) -> Result<u8> {
        let byte = self.peek()?;
        self.pos += 1;
        Ok(byte)
    }

    fn skip_ws(&mut self) {
        while let Some(byte) = self.bytes.get(self.pos)
            && matches!(byte, b' ' | b'\t' | b'\n' | b'\r')
        {
            self.pos += 1;
        }
    }

    fn literal(&mut self, word: &str, value: J) -> Result<J> {
        if self.bytes.get(self.pos..self.pos + word.len()) == Some(word.as_bytes()) {
            self.pos += word.len();
            Ok(value)
        } else {
            Err(parse_error())
        }
    }

    fn number(&mut self) -> Result<J> {
        let start = self.pos;
        if self.peek()? == b'-' {
            self.pos += 1;
        }
        match self.peek()? {
            b'0' => self.pos += 1,
            b'1'..=b'9' => {
                while let Some(b'0'..=b'9') = self.bytes.get(self.pos) {
                    self.pos += 1;
                }
            }
            _ => return Err(parse_error()),
        }
        if self.bytes.get(self.pos) == Some(&b'.') {
            self.pos += 1;
            if !matches!(self.bytes.get(self.pos), Some(b'0'..=b'9')) {
                return Err(parse_error());
            }
            while let Some(b'0'..=b'9') = self.bytes.get(self.pos) {
                self.pos += 1;
            }
        }
        if matches!(self.bytes.get(self.pos), Some(b'e' | b'E')) {
            self.pos += 1;
            if matches!(self.bytes.get(self.pos), Some(b'+' | b'-')) {
                self.pos += 1;
            }
            if !matches!(self.bytes.get(self.pos), Some(b'0'..=b'9')) {
                return Err(parse_error());
            }
            while let Some(b'0'..=b'9') = self.bytes.get(self.pos) {
                self.pos += 1;
            }
        }
        self.bytes
            .get(start..self.pos)
            .and_then(|raw| std::str::from_utf8(raw).ok())
            .map(|raw| J::Num(raw.to_owned()))
            .ok_or_else(parse_error)
    }

    fn hex(&mut self) -> Result<u16> {
        let mut unit = 0u16;
        for _ in 0..4 {
            let digit = self.next()?;
            let nibble = match digit {
                b'0'..=b'9' => u16::from(digit - b'0'),
                b'a'..=b'f' => u16::from(digit - b'a') + 10,
                b'A'..=b'F' => u16::from(digit - b'A') + 10,
                _ => return Err(parse_error()),
            };
            unit = unit * 16 + nibble;
        }
        Ok(unit)
    }

    fn string(&mut self) -> Result<Vec<u16>> {
        // The opening quote is already consumed by `value`.
        let mut units = Vec::new();
        loop {
            let byte = self.next()?;
            match byte {
                b'"' => return Ok(units),
                b'\\' => match self.next()? {
                    b'"' => units.push(u16::from(b'"')),
                    b'\\' => units.push(u16::from(b'\\')),
                    b'/' => units.push(u16::from(b'/')),
                    b'b' => units.push(0x08),
                    b'f' => units.push(0x0c),
                    b'n' => units.push(u16::from(b'\n')),
                    b'r' => units.push(u16::from(b'\r')),
                    b't' => units.push(u16::from(b'\t')),
                    b'u' => units.push(self.hex()?),
                    _ => return Err(parse_error()),
                },
                0x00..=0x1f => return Err(parse_error()),
                _ => {
                    // The input is valid UTF-8 and `pos` always rests on a character boundary,
                    // so the lead byte alone sets the character's length: decode only those
                    // bytes, never re-validate the whole remaining input.
                    self.pos -= 1;
                    let lead = *self.bytes.get(self.pos).ok_or_else(parse_error)?;
                    let len = if lead < 0x80 {
                        1
                    } else if lead < 0xe0 {
                        2
                    } else if lead < 0xf0 {
                        3
                    } else if lead < 0xf8 {
                        4
                    } else {
                        return Err(parse_error());
                    };
                    let head = self
                        .bytes
                        .get(self.pos..self.pos.saturating_add(len))
                        .filter(|head| head.len() == len)
                        .and_then(|head| std::str::from_utf8(head).ok())
                        .ok_or_else(parse_error)?;
                    let c = head.chars().next().ok_or_else(parse_error)?;
                    let mut pair = [0u16; 2];
                    units.extend_from_slice(c.encode_utf16(&mut pair));
                    self.pos += c.len_utf8();
                }
            }
        }
    }
}

/// An open container waiting for its contents. The stack lives on the heap, so however
/// deep the input nests, parsing never touches the call stack past `catch_unwind`.
enum Frame {
    Arr(Vec<J>),
    Obj(Vec<(Vec<u16>, J)>, Option<Vec<u16>>),
}

/// One value where a value is expected: a finished value, or an opened container whose
/// contents the driver reads next. No recursion: containers open onto the stack.
enum ValueOrOpen {
    Closed(J),
    OpenArr,
    OpenObj,
}

fn read_open(parser: &mut Parser) -> Result<ValueOrOpen> {
    parser.skip_ws();
    match parser.next()? {
        b'n' => {
            parser.pos -= 1;
            Ok(ValueOrOpen::Closed(parser.literal("null", J::Null)?))
        }
        b't' => {
            parser.pos -= 1;
            Ok(ValueOrOpen::Closed(parser.literal("true", J::Bool(true))?))
        }
        b'f' => {
            parser.pos -= 1;
            Ok(ValueOrOpen::Closed(
                parser.literal("false", J::Bool(false))?,
            ))
        }
        b'"' => Ok(ValueOrOpen::Closed(J::Str(parser.string()?))),
        b'[' => Ok(ValueOrOpen::OpenArr),
        b'{' => Ok(ValueOrOpen::OpenObj),
        _ => {
            parser.pos -= 1;
            Ok(ValueOrOpen::Closed(parser.number()?))
        }
    }
}

/// Place a finished value into its parent frame, or return it as the document root.
fn place(stack: &mut [Frame], value: J) -> Result<Option<J>> {
    match stack.last_mut() {
        None => Ok(Some(value)),
        Some(Frame::Arr(items)) => {
            items.push(value);
            Ok(None)
        }
        Some(Frame::Obj(entries, key)) => {
            let Some(name) = key.take() else {
                return Err(parse_error());
            };
            entries.push((name, value));
            Ok(None)
        }
    }
}

/// Finish the document if the whole input was read.
fn finish(parser: &mut Parser, root: J) -> Result<J> {
    parser.skip_ws();
    if parser.pos == parser.bytes.len() {
        Ok(root)
    } else {
        Err(parse_error())
    }
}

pub(crate) fn parse_json(text: &str) -> Result<J> {
    let mut parser = Parser::new(text);
    let mut stack: Vec<Frame> = Vec::new();
    match read_open(&mut parser)? {
        ValueOrOpen::Closed(root) => return finish(&mut parser, root),
        ValueOrOpen::OpenArr => stack.push(Frame::Arr(Vec::new())),
        ValueOrOpen::OpenObj => stack.push(Frame::Obj(Vec::new(), None)),
    }
    loop {
        let Some(top) = stack.last() else {
            return Err(parse_error());
        };
        let in_array = matches!(top, Frame::Arr(_));
        // Only inspection borrows here; every mutation below re-borrows afresh.
        if in_array {
            let empty = match stack.last() {
                Some(Frame::Arr(items)) => items.is_empty(),
                _ => return Err(parse_error()),
            };
            parser.skip_ws();
            if parser.peek()? == b']' {
                parser.pos += 1;
                let items = match stack.pop() {
                    Some(Frame::Arr(items)) => items,
                    _ => return Err(parse_error()),
                };
                if let Some(root) = place(&mut stack, J::Arr(items))? {
                    return finish(&mut parser, root);
                }
                continue;
            }
            if !empty && parser.next()? != b',' {
                return Err(parse_error());
            }
            match read_open(&mut parser)? {
                ValueOrOpen::Closed(value) => {
                    if place(&mut stack, value)?.is_some() {
                        return Err(parse_error());
                    }
                }
                ValueOrOpen::OpenArr => stack.push(Frame::Arr(Vec::new())),
                ValueOrOpen::OpenObj => stack.push(Frame::Obj(Vec::new(), None)),
            }
            continue;
        }
        let has_key = match stack.last() {
            Some(Frame::Obj(_, key)) => key.is_some(),
            _ => return Err(parse_error()),
        };
        if !has_key {
            let empty = match stack.last() {
                Some(Frame::Obj(entries, _)) => entries.is_empty(),
                _ => return Err(parse_error()),
            };
            parser.skip_ws();
            if parser.peek()? == b'}' {
                parser.pos += 1;
                let entries = match stack.pop() {
                    Some(Frame::Obj(entries, _)) => entries,
                    _ => return Err(parse_error()),
                };
                if let Some(root) = place(&mut stack, J::Obj(entries))? {
                    return finish(&mut parser, root);
                }
                continue;
            }
            if !empty && parser.next()? != b',' {
                return Err(parse_error());
            }
            parser.skip_ws();
            if parser.next()? != b'"' {
                return Err(parse_error());
            }
            let name = parser.string()?;
            parser.skip_ws();
            if parser.next()? != b':' {
                return Err(parse_error());
            }
            match stack.last_mut() {
                Some(Frame::Obj(_, key)) => *key = Some(name),
                _ => return Err(parse_error()),
            }
            continue;
        }
        match read_open(&mut parser)? {
            ValueOrOpen::Closed(value) => {
                if place(&mut stack, value)?.is_some() {
                    return Err(parse_error());
                }
            }
            ValueOrOpen::OpenArr => stack.push(Frame::Arr(Vec::new())),
            ValueOrOpen::OpenObj => stack.push(Frame::Obj(Vec::new(), None)),
        }
    }
}

/// A JSON string literal's units: what a stored chunk append decodes to.
pub(crate) fn parse_string(text: &str) -> Result<Vec<u16>> {
    let mut parser = Parser::new(text);
    if parser.next()? != b'"' {
        return Err(parse_error());
    }
    let units = parser.string()?;
    parser.skip_ws();
    if parser.pos == parser.bytes.len() {
        Ok(units)
    } else {
        Err(parse_error())
    }
}
