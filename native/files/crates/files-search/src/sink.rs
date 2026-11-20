// SPDX-License-Identifier: Apache-2.0

//! Searches one file and streams what it found to the caller's sink.

use std::io::{self, Read};
use std::sync::atomic::{AtomicBool, Ordering};

use grep_matcher::Matcher;
use grep_searcher::{Searcher, Sink, SinkMatch};
use ignore::DirEntry;

use crate::folders::Folders;
use crate::open::{self, Opened};
use crate::preview;
use crate::result::{FileMatches, LineMatch};
use crate::walk::{Shared, emit};

/// Searches one file the walker handed over.
///
/// The file is opened through the folder that holds it, which this walker thread has already had
/// authorized and keeps open while it works through that folder, and only if it is still the
/// entry the walk saw: a name rewritten after the walk cannot redirect the read. A file that
/// cannot be opened, looks binary, or fails while being read is skipped: one bad file in a
/// checkout must not fail the whole search, and its reserved match slots go back to the other
/// walker threads.
pub(crate) fn search_file(
    searcher: &mut Searcher,
    shared: &Shared<'_>,
    folders: &mut Folders,
    entry: &DirEntry,
    relative: &str,
) {
    if shared.halted() {
        return;
    }
    let folder = match relative.rsplit_once('/') {
        Some((folder, _)) => folder,
        None => "",
    };
    let Some((file, metadata)) = open_entry(shared.root, folders, folder, entry) else {
        return;
    };
    if !metadata.is_file() {
        return;
    }
    let size = metadata.len();
    if shared.max_file_bytes > 0 && size > shared.max_file_bytes {
        return;
    }
    let reader = CancelReader {
        inner: file,
        cancel: shared.cancel,
    };
    let mut sink = FileSink::new(shared);
    if searcher
        .search_reader(&shared.matcher, reader, &mut sink)
        .is_err()
    {
        shared.release(sink.reserved);
        return;
    }
    if shared.cancel.load(Ordering::SeqCst) {
        shared.release(sink.reserved);
        return;
    }
    shared.bytes.fetch_add(size, Ordering::Relaxed);
    if sink.binary {
        shared.release(sink.reserved);
        return;
    }
    let FileSink {
        lines,
        reserved,
        refused,
        ..
    } = sink;
    if lines.is_empty() {
        shared.refused.fetch_add(refused, Ordering::Relaxed);
        shared.release(reserved);
        return;
    }
    if emit(
        shared,
        FileMatches {
            path: relative.to_owned(),
            lines,
        },
    ) {
        shared.refused.fetch_add(refused, Ordering::Relaxed);
    } else {
        shared.release(reserved);
    }
}

/// Opens the walked file through its folder's handle. A handle held from an earlier file that
/// fails to open this one, or whose checkout path leads elsewhere, may be stale, as when the folder
/// was replaced between two of its files: it is dropped, the folder opened again from the root,
/// and the file tried once more.
fn open_entry(
    root: &files_safe::Root,
    folders: &mut Folders,
    folder: &str,
    entry: &DirEntry,
) -> Option<(cap_std::fs::File, cap_std::fs::Metadata)> {
    let name = entry.file_name();
    let held = folders.holds(folder);
    match open::open(root, folders.get(root, folder)?, name) {
        Opened::File(file, metadata) => return Some((file, metadata)),
        Opened::Failed | Opened::Refused if !held => return None,
        Opened::Failed | Opened::Refused => folders.forget(folder),
    }
    match open::open(root, folders.get(root, folder)?, name) {
        Opened::File(file, metadata) => Some((file, metadata)),
        Opened::Failed | Opened::Refused => None,
    }
}

/// A file reader that fails as soon as the caller cancels, so a search of a large file stops
/// between two reads instead of after reading the whole thing.
struct CancelReader<'a, R> {
    inner: R,
    cancel: &'a AtomicBool,
}

impl<R: Read> Read for CancelReader<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.cancel.load(Ordering::SeqCst) {
            return Err(io::Error::other("search cancelled"));
        }
        self.inner.read(buffer)
    }
}

/// Collects the matching lines of the file being searched.
struct FileSink<'a> {
    shared: &'a Shared<'a>,
    lines: Vec<LineMatch>,
    /// Slots this file holds under the match cap.
    reserved: u64,
    /// Matches this file found but the cap refused.
    refused: u64,
    binary: bool,
}

impl<'a> FileSink<'a> {
    fn new(shared: &'a Shared<'a>) -> FileSink<'a> {
        FileSink {
            shared,
            lines: Vec::new(),
            reserved: 0,
            refused: 0,
            binary: false,
        }
    }
}

impl Sink for FileSink<'_> {
    type Error = io::Error;

    fn matched(
        &mut self,
        _searcher: &Searcher,
        matched: &SinkMatch<'_>,
    ) -> Result<bool, io::Error> {
        if self.binary || self.shared.halted() {
            return Ok(false);
        }
        let Some(line) = matched.line_number() else {
            return Ok(true);
        };
        let bytes = matched.bytes();
        let shared = self.shared;
        let mut spans = Vec::new();
        let mut reserved = 0;
        let mut refused = 0;
        let scanned = shared.matcher.find_iter(bytes, |found| {
            if shared.reserve() {
                reserved += 1;
                spans.push(found.start()..found.end());
                true
            } else {
                refused += 1;
                false
            }
        });
        self.reserved += reserved;
        self.refused += refused;
        if scanned.is_err() || spans.is_empty() {
            return Ok(refused == 0);
        }
        let (text, column, ranges) = preview::preview(bytes, &spans);
        self.lines.push(LineMatch {
            line,
            column,
            preview: text,
            ranges,
        });
        Ok(refused == 0)
    }

    fn binary_data(&mut self, _searcher: &Searcher, _offset: u64) -> Result<bool, io::Error> {
        self.binary = true;
        Ok(false)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::open_entry;
    use crate::folders::Folders;
    use files_safe::Root;
    use ignore::WalkBuilder;

    #[test]
    fn a_held_folder_replaced_before_its_next_file_searches_the_replacement() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let aside = tempfile::tempdir().expect("another temp dir");
        std::fs::create_dir_all(dir.path().join("d")).expect("a folder");
        std::fs::write(dir.path().join("d/one.txt"), "first").expect("a file");
        let root = Root::open(dir.path()).expect("the root opens");
        let mut folders = Folders::default();
        assert!(
            folders.get(&root, "d").is_some(),
            "the first file's folder is held"
        );

        // The folder is replaced by another one that holds the next walked name, which the old
        // folder never had.
        std::fs::rename(dir.path().join("d"), aside.path().join("d")).expect("the move");
        std::fs::create_dir_all(dir.path().join("d")).expect("the replacement");
        std::fs::write(dir.path().join("d/two.txt"), "second").expect("its file");
        let entry = WalkBuilder::new(root.path())
            .build()
            .filter_map(Result::ok)
            .find(|entry| entry.file_name() == "two.txt")
            .expect("the walk lists the replacement's file");

        let (_, metadata) =
            open_entry(&root, &mut folders, "d", &entry).expect("the replacement is searched");
        assert_eq!(metadata.len(), 6);
    }
}
