use crate::{Result, WorkspaceError};
use ropey::Rope;
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenBuffer {
    pub relative_path: String,
    pub version: i32,
    text: Rope,
}

impl OpenBuffer {
    #[must_use]
    pub fn new(relative_path: impl Into<String>, contents: impl AsRef<str>, version: i32) -> Self {
        Self {
            relative_path: relative_path.into(),
            version,
            text: Rope::from_str(contents.as_ref()),
        }
    }

    #[must_use]
    pub fn text(&self) -> String {
        self.text.to_string()
    }

    pub fn set_text(&mut self, contents: impl AsRef<str>, version: i32) {
        self.text = Rope::from_str(contents.as_ref());
        self.version = version;
    }

    pub fn char_to_utf16_position(&self, char_idx: usize) -> Result<(u32, u32)> {
        if char_idx > self.text.len_chars() {
            return Err(WorkspaceError::InvalidPosition);
        }
        let line_idx = self.text.char_to_line(char_idx);
        let line_char = self.text.line_to_char(line_idx);
        let prefix = self.text.slice(line_char..char_idx).to_string();
        let utf16_col = prefix.encode_utf16().count();
        Ok((line_idx as u32, utf16_col as u32))
    }

    pub fn utf16_position_to_char(&self, line: u32, character: u32) -> Result<usize> {
        let line_idx = line as usize;
        if line_idx >= self.text.len_lines() {
            return Err(WorkspaceError::InvalidPosition);
        }
        let line_start = self.text.line_to_char(line_idx);
        let line_end = if line_idx + 1 < self.text.len_lines() {
            self.text.line_to_char(line_idx + 1)
        } else {
            self.text.len_chars()
        };
        let mut utf16_seen = 0usize;
        for char_idx in line_start..line_end {
            if utf16_seen == character as usize {
                return Ok(char_idx);
            }
            let ch = self.text.char(char_idx);
            if ch == '\n' || ch == '\r' {
                break;
            }
            utf16_seen += ch.len_utf16();
            if utf16_seen > character as usize {
                return Err(WorkspaceError::InvalidPosition);
            }
        }
        if utf16_seen == character as usize {
            Ok(line_end)
        } else {
            Err(WorkspaceError::InvalidPosition)
        }
    }
}

#[derive(Debug, Default)]
pub struct BufferStore {
    buffers: HashMap<String, OpenBuffer>,
}

impl BufferStore {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn sync(
        &mut self,
        relative_path: impl Into<String>,
        contents: impl AsRef<str>,
        version: i32,
    ) -> OpenBuffer {
        let relative_path = relative_path.into();
        let buffer = self
            .buffers
            .entry(relative_path.clone())
            .or_insert_with(|| OpenBuffer::new(relative_path.clone(), "", version));
        buffer.set_text(contents, version);
        buffer.clone()
    }

    pub fn get(&self, relative_path: &str) -> Result<&OpenBuffer> {
        self.buffers
            .get(relative_path)
            .ok_or_else(|| WorkspaceError::BufferNotOpen(relative_path.to_string()))
    }

    pub fn close(&mut self, relative_path: &str) -> Option<OpenBuffer> {
        self.buffers.remove(relative_path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_utf16_positions_across_multibyte_text() {
        let buffer = OpenBuffer::new("x.rs", "a😀b\nz", 1);
        assert_eq!(buffer.utf16_position_to_char(0, 3).expect("pos"), 2);
        assert!(buffer.utf16_position_to_char(0, 2).is_err());
        assert_eq!(buffer.char_to_utf16_position(3).expect("pos"), (0, 4));
    }

    #[test]
    fn tracks_buffer_versions() {
        let mut store = BufferStore::new();
        let first = store.sync("src/lib.rs", "one", 1);
        let second = store.sync("src/lib.rs", "two", 2);
        assert_eq!(first.version, 1);
        assert_eq!(second.version, 2);
        assert_eq!(store.get("src/lib.rs").expect("buffer").text(), "two");
    }
}
