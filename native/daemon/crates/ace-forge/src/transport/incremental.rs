// SPDX-License-Identifier: Apache-2.0
//! Collection deltas (`incremental.ts`): a retained collection's changes, reused while the
//! same previous and next values are asked about, and computed by identity otherwise.

/// The changes a collection moved through.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Changes<T> {
    pub upsert: Vec<T>,
    pub removed: Vec<T>,
}

impl<T> Default for Changes<T> {
    fn default() -> Self {
        Changes {
            upsert: Vec::new(),
            removed: Vec::new(),
        }
    }
}

/// The retained deltas of one collection. The TypeScript keys them by array identity; Rust
/// keys them by the values themselves, which is what a caller observes.
#[derive(Debug)]
pub struct CollectionVersions<T> {
    previous: Option<Vec<T>>,
    next: Option<Vec<T>>,
    changes: Changes<T>,
}

impl<T: Clone + PartialEq> Default for CollectionVersions<T> {
    fn default() -> Self {
        CollectionVersions {
            previous: None,
            next: None,
            changes: Changes::default(),
        }
    }
}

impl<T: Clone + PartialEq> CollectionVersions<T> {
    /// A fresh collection.
    pub fn new() -> CollectionVersions<T> {
        CollectionVersions::default()
    }

    /// Records `changes` for the move from `previous` to `next` and answers `next`.
    pub fn retain(&mut self, previous: &[T], next: Vec<T>, changes: Changes<T>) -> Vec<T> {
        self.previous = Some(previous.to_vec());
        self.next = Some(next.clone());
        self.changes = changes;
        next
    }

    /// The delta from `previous` to `next`, or the retained one for the same pair.
    pub fn changes(
        &mut self,
        previous: &[T],
        next: Vec<T>,
        identity: impl Fn(&T) -> String,
    ) -> Changes<T> {
        if previous == next.as_slice() {
            return Changes::default();
        }
        if self.previous.as_deref() == Some(previous)
            && self.next.as_deref() == Some(next.as_slice())
        {
            return self.changes.clone();
        }
        let mut before: Vec<(String, T)> = previous
            .iter()
            .map(|item| (identity(item), item.clone()))
            .collect();
        let mut upsert = Vec::new();
        for item in &next {
            let key = identity(item);
            match before.iter().position(|(held, _)| *held == key) {
                Some(index) => {
                    let (_, held) = before.remove(index);
                    if held != *item {
                        upsert.push(item.clone());
                    }
                }
                None => upsert.push(item.clone()),
            }
        }
        Changes {
            upsert,
            removed: before.into_iter().map(|(_, item)| item).collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Changes, CollectionVersions};

    fn identity(value: &i64) -> String {
        value.to_string()
    }

    #[test]
    fn a_changed_entry_is_an_upsert_and_a_gone_one_is_removed() {
        let mut versions = CollectionVersions::new();
        let changes = versions.changes(&[1, 2, 3], vec![1, 4, 3], identity);
        assert_eq!(changes.upsert, vec![4]);
        assert_eq!(changes.removed, vec![2]);
    }

    #[test]
    fn a_retained_delta_is_reused_for_the_same_pair() {
        let mut versions = CollectionVersions::new();
        let ours = Changes {
            upsert: vec![9],
            removed: vec![],
        };
        versions.retain(&[1], vec![1, 9], ours.clone());
        assert_eq!(versions.changes(&[1], vec![1, 9], identity), ours);
        assert_eq!(
            versions.changes(&[1], vec![2], identity),
            Changes {
                upsert: vec![2],
                removed: vec![1]
            }
        );
    }

    #[test]
    fn the_same_values_have_no_changes() {
        let mut versions = CollectionVersions::new();
        assert_eq!(
            versions.changes(&[1, 2], vec![1, 2], identity),
            Changes::default()
        );
    }
}
