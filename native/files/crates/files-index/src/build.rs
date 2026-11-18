// SPDX-License-Identifier: Apache-2.0

//! Building an index from a checkout.

use std::sync::atomic::{AtomicBool, Ordering};

use files_safe::Root;

use crate::arena::PathArena;
use crate::error::Error;
use crate::membership::Membership;
use crate::walk::{self, Collected, Filters, Walk};
use crate::{IndexOptions, PathIndex};

pub(crate) fn build(
    root: &Root,
    options: &IndexOptions,
    cancel: &AtomicBool,
    progress: Option<&(dyn Fn(u64) + Sync)>,
) -> Result<PathIndex, Error> {
    if options.max_files == 0 {
        return Err(Error::InvalidArgument(
            "max_files must be at least 1".to_owned(),
        ));
    }
    let filters = Filters::new(root, &options.hide, options.include_ignored)?;
    let collected = walk::run(Walk {
        root,
        filters: &filters,
        max_files: options.max_files,
        cancel,
        start: root.path(),
        recheck: filters.has_ancestors(),
        progress,
    })?;
    finish(options, cancel, filters, collected)
}

/// Walk one folder of the checkout with the rules that apply to it, keeping paths relative to
/// the root. An ignore-rule edit can both hide paths that were indexed and reveal paths that were
/// not, and only a walk of the folder reconciles both.
pub(crate) fn build_folder(
    root: &Root,
    folder: &str,
    options: &IndexOptions,
    cancel: &AtomicBool,
) -> Result<PathIndex, Error> {
    if options.max_files == 0 {
        return Err(Error::InvalidArgument(
            "max_files must be at least 1".to_owned(),
        ));
    }
    let filters = Filters::new(root, &options.hide, options.include_ignored)?;
    if folder.is_empty() {
        return build(root, options, cancel, None);
    }
    if Root::check(folder).is_err() {
        return Err(Error::InvalidArgument(format!(
            "not a checkout-relative folder: {folder}"
        )));
    }
    // A folder that vanished while the rules changed has nothing left to index; the watch batch
    // itself drops its paths, and an empty walk keeps the rebuild harmless.
    let Ok(start) = root.resolve(folder) else {
        return finish(options, cancel, filters, Collected::empty());
    };
    let mut collected = walk::run(Walk {
        root,
        filters: &filters,
        max_files: options.max_files,
        cancel,
        start: &start,
        recheck: true,
        progress: None,
    })?;
    // A rebuild of one folder replaces its subtree, and the walk starts at its inside: the folder
    // itself is still a quick-open candidate, so it joins the replacement.
    if !collected.cancelled {
        collected.paths.push(format!("{folder}/"));
    }
    finish(options, cancel, filters, collected)
}

fn finish(
    options: &IndexOptions,
    cancel: &AtomicBool,
    filters: Filters,
    collected: Collected,
) -> Result<PathIndex, Error> {
    if collected.cancelled || cancel.load(Ordering::Relaxed) {
        return Err(Error::Aborted);
    }
    let bytes = collected.paths.iter().map(String::len).sum();
    let mut arena = PathArena::with_capacity(collected.paths.len(), bytes);
    let mut members = Membership::with_capacity(collected.paths.len());
    let mut truncated = collected.truncated;
    for path in &collected.paths {
        if !crate::insert(&mut arena, &mut members, path) {
            truncated = true;
            break;
        }
    }
    Ok(PathIndex {
        arena,
        members,
        filters,
        max_files: options.max_files,
        truncated,
    })
}
