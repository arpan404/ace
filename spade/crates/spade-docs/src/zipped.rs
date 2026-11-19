//! The ZIP inside DOCX and XLSX files, read one bounded part at a time.

use std::io::Cursor;

use crate::bounded::{Budget, short};
use crate::{DocError, Limits};

pub struct Parts<'a> {
    archive: zip::ZipArchive<Cursor<&'a [u8]>>,
    budget: Budget,
}

impl<'a> Parts<'a> {
    pub fn open(bytes: &'a [u8], limits: &Limits) -> Result<Self, DocError> {
        let archive = zip::ZipArchive::new(Cursor::new(bytes))
            .map_err(|error| DocError::Damaged(short(&error.to_string())))?;
        if archive.len() > limits.zip_entries {
            return Err(DocError::TooManyEntries(limits.zip_entries));
        }
        Ok(Self {
            archive,
            budget: Budget::new(limits),
        })
    }

    /// The part named `name`, inflated within the caps; `None` when the file has no such part.
    pub fn read(&mut self, name: &str) -> Result<Option<Vec<u8>>, DocError> {
        let Some(index) = self.archive.index_for_name(name) else {
            return Ok(None);
        };
        let mut file = match self.archive.by_index(index) {
            Ok(file) => file,
            Err(zip::result::ZipError::UnsupportedArchive(why)) if why.contains("assword") => {
                return Err(DocError::Encrypted);
            }
            Err(error) => return Err(DocError::Damaged(short(&error.to_string()))),
        };
        if file.encrypted() {
            return Err(DocError::Encrypted);
        }
        let compressed = usize::try_from(file.compressed_size()).unwrap_or(usize::MAX);
        self.budget.read_all(&mut file, compressed).map(Some)
    }

    /// The part named `name` as text, or an error when it is missing.
    pub fn text(&mut self, name: &str) -> Result<String, DocError> {
        let bytes = self
            .read(name)?
            .ok_or_else(|| DocError::Damaged(format!("{name} is missing")))?;
        String::from_utf8(bytes).map_err(|_| DocError::Damaged(format!("{name} is not UTF-8")))
    }
}
