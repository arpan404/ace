// SPDX-License-Identifier: Apache-2.0

//! Sampling one transcript (`sample-file.ts`): its head and tail windows, then, when those hold
//! no request from the person, one bounded record at a time until one does.

use std::path::Path;
use std::sync::Mutex;

use history_text::session_title;

use super::summary::summary;
use super::user::{has_user_input, user_prompt};
use crate::cancel::Cancel;
use crate::error::{CHANGED_BEFORE, Error, Result};
use crate::fsread::{JsonLines, RECORD_LIMIT, RecordKind, read_head_tail};
use crate::options::Home;
use crate::session::{Session, Support};

/// Largest record decoded while looking for a first prompt; larger ones are only counted.
pub const PREVIEW_RECORD_LIMIT: usize = 128 * 1024;
pub const TOO_LARGE: &str = "The first request in this saved conversation is too large to preview. Open it in its original app.";

/// What one content read found, and what it adds to the scan's counts.
#[derive(Debug, Default)]
pub struct Read {
    pub reads: u64,
    pub bytes: u64,
    pub notices: Vec<String>,
}

pub struct Found {
    pub summary: Session,
    pub hidden: bool,
}

struct FirstPrompt {
    prompt: String,
    input: bool,
    oversized: bool,
}

fn first_prompt(
    home: &Home,
    path: &Path,
    cancel: &Cancel,
    limit: usize,
    read: &mut Read,
) -> Result<FirstPrompt> {
    let mut oversized = false;
    for record in JsonLines::open(&home.home_dir, path, cancel, limit)? {
        let record = record?;
        read.bytes += record.bytes;
        match &record.kind {
            RecordKind::Oversized => oversized = true,
            RecordKind::Value(value) if has_user_input(value) => {
                return Ok(FirstPrompt {
                    prompt: user_prompt(value),
                    input: true,
                    oversized,
                });
            }
            _ => {}
        }
    }
    Ok(FirstPrompt {
        prompt: String::new(),
        input: false,
        oversized,
    })
}

/// Read a transcript whose fingerprint was `fingerprint` when listed. `large` admits one decode
/// above the preview limit at a time across the scan.
pub fn read_content(
    home: &Home,
    path: &Path,
    fingerprint: &str,
    cancel: &Cancel,
    large: &Mutex<()>,
    read: &mut Read,
) -> Result<Found> {
    let sample = read_head_tail(&home.home_dir, path, cancel)?;
    read.reads += 1;
    read.bytes += sample.bytes;
    let mut s = summary(
        home,
        path,
        &sample.records,
        sample.exact,
        sample.mtime,
        None,
    );
    if fingerprint != sample.fingerprint {
        return Err(Error::message(CHANGED_BEFORE));
    }
    let mut input = sample.records.iter().any(has_user_input);
    let head_input = sample.records[..sample.head_count]
        .iter()
        .any(has_user_input);
    if !sample.exact && !head_input {
        let mut look = || -> Result<FirstPrompt> {
            read.reads += 1;
            let mut found = first_prompt(home, path, cancel, PREVIEW_RECORD_LIMIT, read)?;
            if !found.input && found.oversized {
                // A first prompt above the preview window is still shown, but only one such
                // record is decoded at a time across the whole scan.
                read.reads += 1;
                let _one = large
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                found = first_prompt(home, path, cancel, RECORD_LIMIT, read)?;
            }
            Ok(found)
        };
        let mut prompt = String::new();
        match look() {
            Ok(found) => {
                prompt = found.prompt;
                input = found.input;
                if !input && found.oversized {
                    s.support = Support::unsupported(TOO_LARGE);
                    input = true;
                    read.notices.push(TOO_LARGE.to_owned());
                }
            }
            Err(error) if matches!(error, Error::Aborted) || error.is_change() => {
                return Err(error);
            }
            Err(error) => {
                let reason = error.to_string();
                s.support = Support::unsupported(reason.clone());
                // Keep the source visible to diagnostics, but never offer a partial import.
                input = true;
                read.notices.push(reason);
            }
        }
        let support = s.support.clone();
        s = summary(
            home,
            path,
            &sample.records,
            sample.exact,
            sample.mtime,
            Some(&prompt),
        );
        s.support = support;
        let shown = if s.title.starts_with("Session from ") {
            String::new()
        } else {
            s.title.clone()
        };
        s.title = session_title(&shown, &prompt, s.last_activity);
    }
    Ok(Found {
        summary: s,
        hidden: !input,
    })
}
