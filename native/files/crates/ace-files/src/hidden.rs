// SPDX-License-Identifier: Apache-2.0

//! The names this binary never shows: the daemon's own transfer temporaries.
//!
//! An upload stages its bytes as `.ace-upload-<id>` beside the file it will become, and a deleted
//! entry waits in `.ace-upload-trash-<id>` until it is restored or expires. Neither is a path a
//! person browses, and both change constantly, so listings, the quick-open index and its updates
//! all leave them out. The rule lives here rather than in the caller's options, so no request can
//! widen it.

use files_index::IndexOptions;

/// Gitignore-style pattern for a transfer temporary; one without a slash matches at every depth.
pub(crate) const TRANSFER_TEMPORARY: &str = ".ace-upload-*";

/// The caller's hide list with the transfer temporaries added, whatever the caller asked for.
pub(crate) fn listing_hide(mut hide: Vec<String>) -> Vec<String> {
    if !hide.iter().any(|pattern| pattern == TRANSFER_TEMPORARY) {
        hide.push(TRANSFER_TEMPORARY.to_owned());
    }
    hide
}

/// Whether `path` names, or sits inside, one of the daemon's transfer temporaries.
pub(crate) fn temporary(path: &str) -> bool {
    path.split('/').any(|part| part.starts_with(".ace-upload-"))
}

/// The index options every build and rebuild of this binary uses.
pub(crate) fn index_options() -> IndexOptions {
    let mut options = IndexOptions::default();
    options.hide = listing_hide(options.hide);
    options
}
