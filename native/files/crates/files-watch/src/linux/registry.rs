// SPDX-License-Identifier: Apache-2.0

//! Which folder each inotify watch descriptor stands for, and the other way round.
//!
//! The kernel names events by descriptor, and a descriptor belongs to a folder's inode, not to its
//! name: a folder renamed inside the checkout keeps its descriptor, and watching it again under the
//! new name hands the same descriptor back. Paths are relative to the root, `""` being the root.

use std::collections::{BTreeMap, HashMap};

/// Descriptors and the checkout paths they stand for, kept consistent in both directions.
#[derive(Debug, Default)]
pub(crate) struct Registry {
    by_descriptor: HashMap<i32, String>,
    by_path: BTreeMap<String, i32>,
}

impl Registry {
    /// Records that `descriptor` watches `path` now.
    ///
    /// A descriptor that stood for another path (the folder was renamed) stops standing for it.
    /// A path that had another descriptor (the folder there was replaced) loses it, and that
    /// descriptor is returned: nothing can name it any more, so the caller removes its watch.
    pub(crate) fn bind(&mut self, descriptor: i32, path: &str) -> Option<i32> {
        if let Some(previous) = self.by_descriptor.insert(descriptor, path.to_owned())
            && previous != path
            && self.by_path.get(&previous) == Some(&descriptor)
        {
            self.by_path.remove(&previous);
        }
        let displaced = self
            .by_path
            .insert(path.to_owned(), descriptor)
            .filter(|old| *old != descriptor)?;
        if self.by_descriptor.get(&displaced).map(String::as_str) == Some(path) {
            self.by_descriptor.remove(&displaced);
            return Some(displaced);
        }
        None
    }

    /// The path a descriptor stands for.
    pub(crate) fn path_of(&self, descriptor: i32) -> Option<&str> {
        self.by_descriptor.get(&descriptor).map(String::as_str)
    }

    /// Whether a live descriptor watches `path`.
    pub(crate) fn watches(&self, path: &str) -> bool {
        self.by_path.contains_key(path)
    }

    /// Forgets `path` and every folder below it, returning their descriptors so the caller can
    /// remove the watches. The range scan keeps this proportional to the folders that go.
    pub(crate) fn remove_subtree(&mut self, path: &str) -> Vec<i32> {
        let prefix = format!("{path}/");
        let below: Vec<String> = if path.is_empty() {
            self.by_path.keys().cloned().collect()
        } else {
            std::iter::once(path.to_owned())
                .filter(|path| self.by_path.contains_key(path))
                .chain(
                    self.by_path
                        .range(prefix.clone()..)
                        .take_while(|(held, _)| held.starts_with(&prefix))
                        .map(|(held, _)| held.clone()),
                )
                .collect()
        };
        let mut descriptors = Vec::with_capacity(below.len());
        for held in below {
            if let Some(descriptor) = self.by_path.remove(&held) {
                if self.by_descriptor.get(&descriptor) == Some(&held) {
                    self.by_descriptor.remove(&descriptor);
                }
                descriptors.push(descriptor);
            }
        }
        descriptors
    }

    /// The kernel dropped a watch (`IN_IGNORED`): its folder was deleted, or its watch removed.
    pub(crate) fn dropped(&mut self, descriptor: i32) {
        self.by_descriptor.remove(&descriptor);
    }
}

#[cfg(test)]
mod tests {
    use super::Registry;

    #[test]
    fn a_renamed_folder_keeps_its_descriptor_under_the_new_name_only() {
        let mut registry = Registry::default();
        assert_eq!(registry.bind(3, "old"), None);
        assert_eq!(registry.bind(3, "new"), None);
        assert_eq!(registry.path_of(3), Some("new"));
        assert!(!registry.watches("old"));
        assert!(registry.watches("new"));
    }

    #[test]
    fn a_replaced_folder_hands_back_the_descriptor_nothing_names_any_more() {
        let mut registry = Registry::default();
        registry.bind(3, "cache");
        assert_eq!(registry.bind(9, "cache"), Some(3));
        assert_eq!(registry.path_of(3), None);
        assert_eq!(registry.path_of(9), Some("cache"));
    }

    #[test]
    fn a_subtree_goes_with_its_folder_and_nothing_beside_it() {
        let mut registry = Registry::default();
        for (descriptor, path) in [(1, "a"), (2, "a/b"), (3, "a/b/c"), (4, "ab"), (5, "z")] {
            registry.bind(descriptor, path);
        }
        let mut gone = registry.remove_subtree("a");
        gone.sort_unstable();
        assert_eq!(gone, [1, 2, 3]);
        assert!(registry.watches("ab") && registry.watches("z"));
        assert_eq!(registry.path_of(2), None);
    }
}
