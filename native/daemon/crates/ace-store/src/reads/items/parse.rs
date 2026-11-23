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
                    self.pos -= 1;
                    let rest = self
                        .bytes
                        .get(self.pos..)
                        .and_then(|rest| std::str::from_utf8(rest).ok())
                        .ok_or_else(parse_error)?;
                    let c = rest.chars().next().ok_or_else(parse_error)?;
                    let mut pair = [0u16; 2];
                    units.extend_from_slice(c.encode_utf16(&mut pair));
                    self.pos += c.len_utf8();
                }
            }
        }
    }

    fn array(&mut self) -> Result<J> {
        // The opening bracket is already consumed by `value`.
        let mut items = Vec::new();
        self.skip_ws();
        if self.peek()? == b']' {
            self.pos += 1;
            return Ok(J::Arr(items));
        }
        loop {
            items.push(self.value()?);
            self.skip_ws();
            match self.next()? {
                b',' => continue,
                b']' => return Ok(J::Arr(items)),
                _ => return Err(parse_error()),
            }
        }
    }

    fn object(&mut self) -> Result<J> {
        // The opening brace is already consumed by `value`.
        let mut entries = Vec::new();
        self.skip_ws();
        if self.peek()? == b'}' {
            self.pos += 1;
            return Ok(J::Obj(entries));
        }
        loop {
            self.skip_ws();
            if self.next()? != b'"' {
                return Err(parse_error());
            }
            let key = self.string()?;
            self.skip_ws();
            if self.next()? != b':' {
                return Err(parse_error());
            }
            entries.push((key, self.value()?));
            self.skip_ws();
            match self.next()? {
                b',' => continue,
                b'}' => return Ok(J::Obj(entries)),
                _ => return Err(parse_error()),
            }
        }
    }

    fn value(&mut self) -> Result<J> {
        self.skip_ws();
        match self.next()? {
            b'n' => {
                self.pos -= 1;
                self.literal("null", J::Null)
            }
            b't' => {
                self.pos -= 1;
                self.literal("true", J::Bool(true))
            }
            b'f' => {
                self.pos -= 1;
                self.literal("false", J::Bool(false))
            }
            b'"' => Ok(J::Str(self.string()?)),
            b'[' => self.array(),
            b'{' => self.object(),
            _ => {
                self.pos -= 1;
                self.number()
            }
        }
    }
}

pub(crate) fn parse_json(text: &str) -> Result<J> {
    let mut parser = Parser::new(text);
    let value = parser.value()?;
    parser.skip_ws();
    if parser.pos == parser.bytes.len() {
        Ok(value)
    } else {
        Err(parse_error())
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
