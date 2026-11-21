// SPDX-License-Identifier: Apache-2.0

//! The native records of one source (`source-records.ts`), for the providers this build reads.

use std::path::Path;

use crate::cancel::Cancel;
use crate::error::{Error, Result};
use crate::fsread::{JsonLines, RECORD_LIMIT, stat::fingerprint};
use crate::options::Home;
use crate::session::{Kind, Source};
use crate::snapshot::database_fingerprint;

pub fn records(home: &Home, source: &Source, cancel: &Cancel) -> Result<JsonLines> {
    match source.kind {
        Kind::Jsonl => JsonLines::open(
            &home.home_dir,
            Path::new(&source.path),
            cancel,
            RECORD_LIMIT,
        ),
        Kind::Database | Kind::Storage => Err(Error::message(
            "This saved conversation is read by another reader",
        )),
    }
}

/// The source's fingerprint now, to compare with the one it was listed with.
pub fn current_fingerprint(source: &Source) -> Result<String> {
    let path = Path::new(&source.path);
    match source.kind {
        Kind::Database => database_fingerprint(path),
        Kind::Jsonl => Ok(fingerprint(
            &std::fs::symlink_metadata(path).map_err(|e| crate::error::io_at(e, path))?,
        )),
        Kind::Storage => Err(Error::message(
            "This saved conversation is read by another reader",
        )),
    }
}
