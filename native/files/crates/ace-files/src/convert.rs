// SPDX-License-Identifier: Apache-2.0

//! The public values of the `files-*` crates, in the shape `files-wire` carries.
//!
//! Every conversion here is mechanical: the crates already agree on what a path is and what a
//! number means, so only the tag names and the field names change.

use files_list::{Entry, Kind, Page};
use files_wire::{Case, Hit, ReadMeta, SearchQuery};

/// One listed entry.
pub fn entry(entry: Entry) -> files_wire::Entry {
    files_wire::Entry {
        path: entry.path,
        name: entry.name,
        kind: kind(&entry.kind),
        size: entry.size,
        mtime_ms: entry.mtime_ms,
        ignored: entry.ignored,
    }
}

/// One page of a folder.
pub fn page(page: Page) -> files_wire::Page {
    files_wire::Page {
        entries: page.entries.into_iter().map(entry).collect(),
        next_cursor: page.next_cursor,
        total: u64::try_from(page.total).unwrap_or(u64::MAX),
    }
}

/// What an entry is, tagged by `type`; a symlink carries its target's kind when it has one.
fn kind(entry_kind: &Kind) -> files_wire::Kind {
    match entry_kind {
        Kind::File => files_wire::Kind::File,
        Kind::Directory => files_wire::Kind::Directory,
        Kind::Symlink { target } => files_wire::Kind::Symlink {
            target: target.as_deref().map(|target| Box::new(kind(target))),
        },
        Kind::Other => files_wire::Kind::Other,
    }
}

/// One path's details.
pub fn description(description: files_io::Description) -> files_wire::Description {
    files_wire::Description {
        version: description.version,
        own_version: description.own_version,
        shallow: description.shallow,
        size: description.size,
        kind: io_kind(description.kind),
        mode: description.mode,
    }
}

/// What an I/O entry is, tagged by `type`; `describe` never follows a final link, so a symlink's
/// target is left unknown here.
fn io_kind(kind: files_io::Kind) -> files_wire::Kind {
    match kind {
        files_io::Kind::File => files_wire::Kind::File,
        files_io::Kind::Directory => files_wire::Kind::Directory,
        files_io::Kind::Symlink => files_wire::Kind::Symlink { target: None },
        files_io::Kind::Other => files_wire::Kind::Other,
    }
}

/// One quick-open hit.
pub fn hit(hit: files_index::Hit) -> Hit {
    Hit {
        path: hit.path,
        score: hit.score,
        positions: hit.positions,
    }
}

/// One file's matching lines.
pub fn file_matches(file: files_search::FileMatches) -> files_wire::FileMatches {
    files_wire::FileMatches {
        path: file.path,
        lines: file.lines.into_iter().map(line_match).collect(),
    }
}

/// One matching line.
fn line_match(line: files_search::LineMatch) -> files_wire::LineMatch {
    files_wire::LineMatch {
        line: line.line,
        column: line.column,
        preview: line.preview,
        ranges: line.ranges,
    }
}

/// What a finished search found.
pub fn summary(summary: files_search::Summary) -> files_wire::Summary {
    files_wire::Summary {
        files: summary.files,
        bytes: summary.bytes,
        matches: summary.matches,
        limit_hit: summary.limit_hit,
    }
}

/// The metadata of a read; the bytes follow in a body frame.
pub fn read_meta(read: &files_io::Read) -> ReadMeta {
    ReadMeta {
        size: read.size,
        version: read.version.clone(),
        binary: read.binary,
        encoding: read.encoding.to_owned(),
        bom: read.bom,
        eof: read.eof,
        body: true,
    }
}

/// One path the watcher saw change.
pub fn change(change: files_watch::Change) -> files_wire::Change {
    files_wire::Change {
        path: change.path,
        kind: match change.kind {
            files_watch::ChangeKind::Created => files_wire::ChangeKind::Created,
            files_watch::ChangeKind::Modified => files_wire::ChangeKind::Modified,
            files_watch::ChangeKind::Deleted => files_wire::ChangeKind::Deleted,
        },
        directory: change.directory,
    }
}

/// A wire search request in the searcher's terms.
pub fn search_query(query: SearchQuery) -> files_search::Query {
    files_search::Query {
        pattern: query.pattern,
        regex: query.regex,
        case: match query.case {
            Case::Sensitive => files_search::Case::Sensitive,
            Case::Insensitive => files_search::Case::Insensitive,
            Case::Smart => files_search::Case::Smart,
        },
        whole_word: query.whole_word,
        include: query.include,
        exclude: query.exclude,
        include_ignored: query.include_ignored,
        max_matches: usize::try_from(query.max_matches).unwrap_or(usize::MAX),
        max_file_bytes: query.max_file_bytes,
    }
}
