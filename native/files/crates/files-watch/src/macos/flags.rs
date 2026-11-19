// SPDX-License-Identifier: Apache-2.0

//! What one FSEvents record means, as the events the rest of the crate translates.
//!
//! A record is a path plus a set of flags. Item flags (created, removed, renamed, modified and the
//! metadata ones) become one event each, in a fixed order, and `observed.rs` decides the kind by
//! asking the disk at the end of the window. Every flag that says the stream could not describe
//! a change file by file becomes a rescan, because the one thing this decoder must never do is
//! drop a record quietly:
//!
//! - `UserDropped`, `KernelDropped` and `EventIdsWrapped` say events were lost somewhere in the
//!   stream, and Apple asks for a scan of everything it watches: the root.
//! - `RootChanged` says the root itself, or a folder above it, was moved or removed.
//! - `MustScanSubDirs`, `Mount` and `Unmount` name the folder whose subtree must be read again.
//! - A record with no item flag at all is a folder-level record ("something changed in this
//!   folder"), which FSEvents sends when it coalesces a burst. It names the folder to list.

use std::path::Path;

use notify::Event;
use notify::event::{
    CreateKind, DataChange, EventKind, Flag, MetadataKind, ModifyKind, RemoveKind, RenameMode,
};
use objc2_core_services::{
    kFSEventStreamEventFlagEventIdsWrapped as IDS_WRAPPED,
    kFSEventStreamEventFlagHistoryDone as HISTORY_DONE,
    kFSEventStreamEventFlagItemChangeOwner as CHANGE_OWNER,
    kFSEventStreamEventFlagItemCreated as CREATED,
    kFSEventStreamEventFlagItemFinderInfoMod as FINDER_INFO,
    kFSEventStreamEventFlagItemInodeMetaMod as INODE_META,
    kFSEventStreamEventFlagItemIsDir as IS_DIR, kFSEventStreamEventFlagItemIsFile as IS_FILE,
    kFSEventStreamEventFlagItemIsHardlink as IS_HARDLINK,
    kFSEventStreamEventFlagItemIsSymlink as IS_SYMLINK,
    kFSEventStreamEventFlagItemModified as MODIFIED, kFSEventStreamEventFlagItemRemoved as REMOVED,
    kFSEventStreamEventFlagItemRenamed as RENAMED, kFSEventStreamEventFlagItemXattrMod as XATTR,
    kFSEventStreamEventFlagKernelDropped as KERNEL_DROPPED, kFSEventStreamEventFlagMount as MOUNT,
    kFSEventStreamEventFlagMustScanSubDirs as MUST_SCAN_SUBDIRS,
    kFSEventStreamEventFlagRootChanged as ROOT_CHANGED, kFSEventStreamEventFlagUnmount as UNMOUNT,
    kFSEventStreamEventFlagUserDropped as USER_DROPPED,
};

/// Flags that say events were lost anywhere in the stream, or that the root itself moved.
const LOST: u32 = USER_DROPPED | KERNEL_DROPPED | IDS_WRAPPED | ROOT_CHANGED;

/// Flags that name one folder whose subtree must be read again.
const SCAN_HERE: u32 = MUST_SCAN_SUBDIRS | MOUNT | UNMOUNT;

/// Flags that describe a change to the item at the path.
const METADATA: u32 = INODE_META | FINDER_INFO | CHANGE_OWNER | XATTR;
const ITEM: u32 = CREATED | REMOVED | RENAMED | MODIFIED | METADATA;

/// The events one FSEvents record stands for.
pub(crate) fn events(path: &Path, flags: u32) -> Vec<Event> {
    if flags & HISTORY_DONE != 0 {
        // The marker after replayed history; its path means nothing.
        return Vec::new();
    }
    if flags & LOST != 0 {
        return vec![rescan()];
    }
    if flags & SCAN_HERE != 0 || flags & ITEM == 0 {
        // A record about a file names the folder that holds it; FSEvents only does that for an
        // item flag it could not keep, but a folder is what a rescan lists.
        let folder = if flags & (IS_FILE | IS_SYMLINK | IS_HARDLINK) != 0 {
            path.parent().unwrap_or(path)
        } else {
            path
        };
        return vec![rescan().add_path(folder.to_path_buf())];
    }
    let mut kinds = Vec::with_capacity(4);
    if flags & CREATED != 0 {
        kinds.push(EventKind::Create(if flags & IS_DIR != 0 {
            CreateKind::Folder
        } else if flags & IS_FILE != 0 {
            CreateKind::File
        } else {
            CreateKind::Any
        }));
    }
    if flags & REMOVED != 0 {
        kinds.push(EventKind::Remove(if flags & IS_DIR != 0 {
            RemoveKind::Folder
        } else if flags & IS_FILE != 0 {
            RemoveKind::File
        } else {
            RemoveKind::Any
        }));
    }
    if flags & RENAMED != 0 {
        kinds.push(EventKind::Modify(ModifyKind::Name(RenameMode::Any)));
    }
    if flags & METADATA != 0 {
        kinds.push(EventKind::Modify(ModifyKind::Metadata(MetadataKind::Any)));
    }
    if flags & MODIFIED != 0 {
        kinds.push(EventKind::Modify(ModifyKind::Data(DataChange::Content)));
    }
    kinds
        .into_iter()
        .map(|kind| Event::new(kind).add_path(path.to_path_buf()))
        .collect()
}

/// A rescan request; with no path it covers the root.
fn rescan() -> Event {
    Event::new(EventKind::Other).set_flag(Flag::Rescan)
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use notify::event::{CreateKind, EventKind, ModifyKind, RemoveKind, RenameMode};

    use super::*;

    /// What a record decodes to: `Err(folder)` for a rescan, `Ok(kinds)` otherwise.
    fn decoded(path: &str, flags: u32) -> Result<Vec<EventKind>, Option<PathBuf>> {
        let events = events(Path::new(path), flags);
        if let Some(rescan) = events.iter().find(|event| event.need_rescan()) {
            assert_eq!(events.len(), 1, "a rescan stands alone");
            return Err(rescan.paths.first().cloned());
        }
        Ok(events.into_iter().map(|event| event.kind).collect())
    }

    #[test]
    fn lost_events_rescan_the_root() {
        for flags in [
            MUST_SCAN_SUBDIRS | USER_DROPPED,
            MUST_SCAN_SUBDIRS | KERNEL_DROPPED,
            IDS_WRAPPED,
            ROOT_CHANGED,
            // A lost-events flag wins over the item flags riding on the same record.
            KERNEL_DROPPED | CREATED | IS_FILE,
        ] {
            assert_eq!(decoded("/r/src", flags), Err(None), "flags {flags:#x}");
        }
    }

    #[test]
    fn a_folder_the_stream_could_not_follow_is_rescanned_by_name() {
        assert_eq!(
            decoded("/r/src", MUST_SCAN_SUBDIRS),
            Err(Some(PathBuf::from("/r/src")))
        );
        assert_eq!(
            decoded("/r/vol", MOUNT | IS_DIR),
            Err(Some(PathBuf::from("/r/vol")))
        );
        assert_eq!(
            decoded("/r/vol", UNMOUNT),
            Err(Some(PathBuf::from("/r/vol")))
        );
    }

    #[test]
    fn a_record_without_item_flags_rescans_its_folder() {
        // FSEvents folds a burst into "something changed in this folder"; dropping it is how a
        // twenty-thousand-file burst lost most of its creates without a word.
        assert_eq!(decoded("/r/many", 0), Err(Some(PathBuf::from("/r/many"))));
        assert_eq!(
            decoded("/r/many", IS_DIR),
            Err(Some(PathBuf::from("/r/many")))
        );
        assert_eq!(
            decoded("/r/many/a.txt", IS_FILE),
            Err(Some(PathBuf::from("/r/many"))),
            "a file names the folder that holds it"
        );
    }

    #[test]
    fn the_end_of_history_marker_is_nothing() {
        assert_eq!(decoded("/r", HISTORY_DONE), Ok(Vec::new()));
    }

    #[test]
    fn item_flags_become_one_event_each_in_a_fixed_order() {
        assert_eq!(
            decoded("/r/a.txt", MODIFIED | RENAMED | REMOVED | CREATED | IS_FILE),
            Ok(vec![
                EventKind::Create(CreateKind::File),
                EventKind::Remove(RemoveKind::File),
                EventKind::Modify(ModifyKind::Name(RenameMode::Any)),
                EventKind::Modify(ModifyKind::Data(notify::event::DataChange::Content)),
            ])
        );
        assert_eq!(
            decoded("/r/dir", REMOVED | IS_DIR),
            Ok(vec![EventKind::Remove(RemoveKind::Folder)])
        );
        assert_eq!(
            decoded("/r/link", CREATED | IS_SYMLINK),
            Ok(vec![EventKind::Create(CreateKind::Any)])
        );
        assert_eq!(
            decoded("/r/a.txt", XATTR | IS_FILE),
            Ok(vec![EventKind::Modify(ModifyKind::Metadata(
                notify::event::MetadataKind::Any
            ))])
        );
    }
}
