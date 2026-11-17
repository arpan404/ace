// SPDX-License-Identifier: Apache-2.0

//! Building an index from a checkout.

use std::sync::atomic::AtomicBool;

use files_safe::Root;

use crate::arena::PathArena;
use crate::error::Error;
use crate::membership::Membership;
use crate::walk::{self, Filters};
use crate::{IndexOptions, PathIndex};

pub(crate) fn build(
    root: &Root,
    options: &IndexOptions,
    cancel: &AtomicBool,
) -> Result<PathIndex, Error> {
    if options.max_files == 0 {
        return Err(Error::InvalidArgument(
            "max_files must be at least 1".to_owned(),
        ));
    }
    let filters = Filters::new(root, &options.hide, options.include_ignored)?;
    let collected = walk::collect(root, &filters, options.max_files, cancel, root.path())?;
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
