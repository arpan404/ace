// SPDX-License-Identifier: Apache-2.0

//! Fixtures shared by the search behaviour tests.

use std::fs;
use std::io;
use std::path::Path;
use std::sync::Mutex;

use files_safe::Root;
use files_search::{Case, FileMatches, Query, Summary, search};

pub(crate) type TestResult = Result<(), Box<dyn std::error::Error>>;

pub(crate) fn write(root: &Path, path: &str, contents: impl AsRef<[u8]>) -> io::Result<()> {
    let full = root.join(path);
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(full, contents)
}

pub(crate) fn query(pattern: &str) -> Query {
    Query {
        pattern: pattern.to_owned(),
        regex: false,
        case: Case::Sensitive,
        whole_word: false,
        include: Vec::new(),
        exclude: Vec::new(),
        include_ignored: false,
        max_matches: 1000,
        max_file_bytes: 0,
    }
}

pub(crate) fn run(
    root: &Root,
    query: &Query,
) -> Result<(Vec<FileMatches>, Summary), files_search::Error> {
    let files = Mutex::new(Vec::new());
    let cancel = std::sync::atomic::AtomicBool::new(false);
    let summary = search(root, query, &cancel, &|file| {
        match files.lock() {
            Ok(mut files) => files.push(file),
            Err(poisoned) => poisoned.into_inner().push(file),
        }
        true
    })?;
    let files = match files.into_inner() {
        Ok(files) => files,
        Err(poisoned) => poisoned.into_inner(),
    };
    Ok((files, summary))
}

pub(crate) fn paths(files: &[FileMatches]) -> Vec<&str> {
    let mut paths: Vec<&str> = files.iter().map(|file| file.path.as_str()).collect();
    paths.sort_unstable();
    paths
}
