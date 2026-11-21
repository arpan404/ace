// SPDX-License-Identifier: Apache-2.0

//! Sampling an OpenCode legacy session file (the storage half of `sample-file.ts`): its own record
//! names the session, and its messages are read in storage order until the first request.

use std::path::Path;
use std::sync::Mutex;

use history_text::session_title;

use super::sample::{Found, PREVIEW_RECORD_LIMIT, Read, TOO_LARGE};
use super::summary::summary;
use super::user::{has_user_input, user_prompt};
use crate::cancel::Cancel;
use crate::error::{Error, Result};
use crate::fsread::{RECORD_LIMIT, RecordKind, read_head_tail};
use crate::json::{field, object, string, timestamp};
use crate::opencode::storage;
use crate::options::Home;
use crate::paths::{basename, text};
use crate::session::{Accuracy, Support, source_id};
use crate::snapshot::SnapshotScratch;

struct FirstPrompt {
    prompt: String,
    input: bool,
    oversized: bool,
}

fn first_prompt(
    home: &Home,
    native_id: &str,
    scratch: &SnapshotScratch,
    cancel: &Cancel,
    limit: usize,
) -> Result<FirstPrompt> {
    let mut oversized = false;
    for record in storage::records(home, native_id, scratch, cancel, limit)? {
        let record = record?;
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

/// Read the session file at `path` and the messages it names.
pub fn read_storage(
    home: &Home,
    path: &Path,
    scratch: &SnapshotScratch,
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
    let head = sample.records.first().cloned().unwrap_or_default();
    let r = object(&head);
    let updated = timestamp(field(object(field(r, "time")), "updated"));
    let native_id = string(r, "id").map_or_else(|| basename(path, ".json"), str::to_owned);
    s.id = source_id(&home.id, &text(path), &native_id);
    s.native_id = native_id;
    let title = string(r, "title").unwrap_or("");
    s.title = session_title(title, "", updated.unwrap_or(sample.mtime));
    s.cwd = string(r, "directory").unwrap_or("").to_owned();
    s.last_activity = updated.unwrap_or(sample.mtime);
    s.parent_native_id = string(r, "parentID").map(str::to_owned);
    s.count_accuracy = Accuracy::Sampled;
    let mut prompt = sample
        .records
        .iter()
        .map(user_prompt)
        .find(|p| !p.is_empty())
        .unwrap_or_default();
    // Storage sessions always read their messages: the session file holds no request itself.
    let input;
    let look = || -> Result<FirstPrompt> {
        let found = first_prompt(home, &s.native_id, scratch, cancel, PREVIEW_RECORD_LIMIT)?;
        if found.input || !found.oversized {
            return Ok(found);
        }
        // A first prompt above the preview window is still shown, one such decode at a time.
        let _one = large
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        first_prompt(home, &s.native_id, scratch, cancel, RECORD_LIMIT)
    };
    match look() {
        Ok(found) => {
            prompt = found.prompt;
            input = found.input || found.oversized;
            if !found.input && found.oversized {
                s.support = Support::unsupported(TOO_LARGE);
                read.notices.push(TOO_LARGE.to_owned());
            }
        }
        Err(error) if matches!(error, Error::Aborted) || error.is_change() => return Err(error),
        Err(error) => {
            let reason = error.to_string();
            s.support = Support::unsupported(reason.clone());
            // Keep the source visible to diagnostics, but never offer a partial import.
            input = true;
            read.notices.push(reason);
        }
    }
    s.title = session_title(title, &prompt, s.last_activity);
    Ok(Found {
        summary: s,
        hidden: !input,
    })
}
