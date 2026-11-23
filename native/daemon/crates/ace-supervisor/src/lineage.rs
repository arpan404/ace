// SPDX-License-Identifier: Apache-2.0
//! macOS lineage by unique id: a process started by one of this run's
//! processes is found even after its parent exited. Ports
//! `process-lineage.ts`. Linux has no unique ids; the subreaper covers it.

/// The most unique ids one run keeps; past it, lineage can't prove complete.
pub const LINEAGE_LIMIT: usize = 65_536;

/// The journal side the book records into.
pub trait LineageJournal {
    /// Records unique ids of this run's processes.
    fn record_lineage(&self, uniques: &[String]);
}

impl<T: LineageJournal> LineageJournal for &T {
    fn record_lineage(&self, uniques: &[String]) {
        (*self).record_lineage(uniques);
    }
}

/// A process's kernel lineage: its unique id and its starting parent's.
pub trait LineageListing {
    /// Every process this user can see.
    fn all(&self) -> Vec<u32>;
    /// One kernel read: start and zombie state.
    fn info(&self, pid: u32) -> Option<LineageInfo>;
    /// The kernel's unique id and its starting parent's, where kept.
    fn ancestry(&self, pid: u32) -> Option<LineageIds>;
}

/// One kernel read of a process, for the lineage pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineageInfo {
    pub start: String,
    pub zombie: bool,
}

/// The kernel's unique ids for a process and its starting parent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineageIds {
    pub unique: String,
    pub parent_unique: String,
}

/// A captured member, pinned by pid and kernel start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeMember {
    pub pid: u32,
    pub start: String,
}

/// The unique ids of this run's processes.
pub struct LineageBook<J> {
    ids: std::collections::HashSet<String>,
    limit: usize,
    journal: Option<J>,
    overflowed: bool,
}

impl<J> LineageBook<J> {
    /// An empty book, recording into `journal` when one is given.
    pub fn new(limit: usize, journal: Option<J>) -> Self {
        Self {
            ids: std::collections::HashSet::new(),
            limit,
            journal,
            overflowed: false,
        }
    }
}

impl<J: LineageJournal> LineageBook<J> {
    /// Records a process's unique id; one beyond the limit marks incomplete.
    pub fn note(&mut self, unique: Option<&str>) {
        let Some(unique) = unique else {
            return;
        };
        if self.ids.contains(unique) {
            return;
        }
        if self.ids.len() >= self.limit {
            self.overflowed = true;
            return;
        }
        self.ids.insert(unique.to_owned());
        if let Some(journal) = &self.journal {
            journal.record_lineage(std::slice::from_ref(&unique.to_owned()));
        }
    }

    /// The unique ids recorded.
    pub fn roots(&self) -> &std::collections::HashSet<String> {
        &self.ids
    }

    /// Whether every id given is kept.
    pub fn complete(&self) -> bool {
        !self.overflowed
    }
}

/// Every live process whose chain of starting parents, by unique id, reaches
/// `roots`. One pass over every visible process; each is read as identity,
/// ancestry, identity, so a pid reused during the read is left out. `None`
/// where the platform keeps no lineage (not macOS).
pub fn lineage_descendants<L: LineageListing>(
    roots: &[String],
    listing: &L,
) -> Option<Vec<TreeMember>> {
    let mut by_parent: std::collections::HashMap<String, Vec<(TreeMember, String)>> =
        std::collections::HashMap::new();
    for pid in listing.all() {
        let Some(before) = listing.info(pid) else {
            continue;
        };
        if before.zombie {
            continue;
        }
        let ids = listing.ancestry(pid);
        let after = listing.info(pid);
        let (Some(ids), Some(after)) = (ids, after) else {
            continue;
        };
        if after.zombie || after.start != before.start {
            continue;
        }
        by_parent
            .entry(ids.parent_unique.clone())
            .or_default()
            .push((
                TreeMember {
                    pid,
                    start: before.start,
                },
                ids.unique.clone(),
            ));
    }
    let mut found = Vec::new();
    let mut seen: std::collections::HashSet<String> = roots.iter().cloned().collect();
    let mut queue: std::collections::VecDeque<String> = roots.to_vec().into();
    while let Some(next) = queue.pop_front() {
        if let Some(children) = by_parent.remove(&next) {
            for (member, unique) in children {
                if seen.insert(unique.clone()) {
                    found.push(member);
                    queue.push_back(unique);
                }
            }
        }
    }
    Some(found)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct Fake {
        table: HashMap<u32, (String, Option<(String, String)>)>,
        macos: bool,
    }

    impl LineageListing for Fake {
        fn all(&self) -> Vec<u32> {
            self.table.keys().copied().collect()
        }

        fn info(&self, pid: u32) -> Option<LineageInfo> {
            self.table.get(&pid).map(|(start, _)| LineageInfo {
                start: start.clone(),
                zombie: false,
            })
        }

        fn ancestry(&self, pid: u32) -> Option<LineageIds> {
            if !self.macos {
                return None;
            }
            self.table.get(&pid).and_then(|(_, ids)| {
                ids.clone().map(|(unique, parent_unique)| LineageIds {
                    unique,
                    parent_unique,
                })
            })
        }
    }

    struct Recorder {
        recorded: RefCell<Vec<String>>,
    }

    use std::cell::RefCell;

    impl LineageJournal for Recorder {
        fn record_lineage(&self, uniques: &[String]) {
            self.recorded.borrow_mut().extend(uniques.iter().cloned());
        }
    }

    #[test]
    fn book_notes_unique_ids_into_its_journal_until_full() {
        let recorder = Recorder {
            recorded: RefCell::new(Vec::new()),
        };
        let mut book = LineageBook::new(2, Some(&recorder));
        book.note(Some("a"));
        book.note(Some("a"));
        book.note(Some("b"));
        book.note(Some("c"));
        assert!(!book.complete());
        assert_eq!(book.roots().len(), 2);
        assert_eq!(recorder.recorded.borrow().clone(), vec!["a", "b"]);
        book.note(None);
        assert_eq!(book.roots().len(), 2);
    }

    #[test]
    fn descendants_follow_starting_parents_by_unique_id() {
        let listing = Fake {
            table: [
                (1, ("init".to_owned(), None)),
                (
                    100,
                    (
                        "daemon".to_owned(),
                        Some(("u100".to_owned(), "u1".to_owned())),
                    ),
                ),
                (
                    200,
                    (
                        "child".to_owned(),
                        Some(("u200".to_owned(), "u100".to_owned())),
                    ),
                ),
                (
                    300,
                    (
                        "stranger".to_owned(),
                        Some(("u300".to_owned(), "u9".to_owned())),
                    ),
                ),
            ]
            .into_iter()
            .collect(),
            macos: true,
        };
        assert_eq!(
            lineage_descendants(&["u1".to_owned()], &listing),
            Some(vec![
                TreeMember {
                    pid: 100,
                    start: "daemon".to_owned(),
                },
                TreeMember {
                    pid: 200,
                    start: "child".to_owned(),
                },
            ])
        );
    }
}
